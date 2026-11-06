import { ripemd160, Secp256k1, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { makeSignBytes, makeSignDoc } from "@cosmjs/proto-signing";
import { base64 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import type { CosmosSwapIntent, CosmosVenueDescriptor, VerifiedCosmosSwap } from "./cosmos-swap-boundary";
import {
  createCosmosSwapRecoveryReader,
  createCosmosSwapRecoveryReaderQuorum,
  createCosmosSwapRecoveryRecord,
  createCosmosSignedSwapRecoveryRecord,
  readCosmosSwapRecoveryJournal,
  refreshCosmosSwapRecovery,
  writeCosmosSwapRecoveryRecord,
  type CosmosSwapRecoveryReader,
  type CosmosSwapRecoveryStatus
} from "./cosmos-swap-recovery";

const now = 1_788_200_000_000;
const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 7 : 0);
const publicKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(privateKey).pubkey);
const authority = toBech32("osmo", ripemd160(sha256(publicKey)));
const recipient = toBech32("osmo", Uint8Array.from({ length: 20 }, (_, index) => index + 30));
const venue: CosmosVenueDescriptor = {
  schema: "realdex.cosmos-venue.v1", venueId: "reviewed-osmosis-venue", revision: 1,
  chainId: "cosmos:osmo-test-5", bech32Prefix: "osmo",
  messageTypeUrl: "/osmosis.gamm.v1beta1.MsgSwapExactAmountIn", executionTarget: "gamm:pool-42",
  publicKeyTypeUrl: "/cosmos.crypto.secp256k1.PubKey",
  evidenceUrls: ["https://evidence-a.example.org/venue", "https://evidence-b.example.org/venue"]
};

describe("Cosmos swap signed recovery journal", () => {
  it("cryptographically binds one signed TxRaw to the verified intent without retaining resend bytes", async () => {
    const fixture = await signedFixture();
    const record = await createCosmosSwapRecoveryRecord({ venue, intent: fixture.intent, verified: fixture.verified, signedTransactionBase64: fixture.signedTransactionBase64, transactionHash: fixture.transactionHash, now });
    expect(record).toMatchObject({ schema: "realdex.cosmos-swap-recovery.v1", stage: "submitted", resendBlocked: true, authority, transactionHash: fixture.transactionHash, refreshCount: 0 });
    expect(record.signedTransactionSha256.toUpperCase()).toBe(record.transactionHash);
    expect(record.publicKeyBase64).toBe(base64.encode(publicKey));
    expect(record).not.toHaveProperty("signedTransactionBase64");
  });

  it("rejects signed content, signature, authority, tx hash, verified evidence, and high-S substitution", async () => {
    const fixture = await signedFixture();
    const badSigned = base64.encode(concat(fieldBytes(1, concat(fixture.bodyBytes, Uint8Array.of(0))), fieldBytes(2, fixture.authInfoBytes), fieldBytes(3, fixture.signature)));
    await expect(createCosmosSwapRecoveryRecord({ venue, intent: fixture.intent, verified: fixture.verified, signedTransactionBase64: badSigned, transactionHash: fixture.transactionHash, now })).rejects.toThrow();
    const alteredSignature = fixture.signature.slice(); alteredSignature[0] ^= 1;
    await expect(createCosmosSwapRecoveryRecord({ venue, intent: fixture.intent, verified: fixture.verified, signedTransactionBase64: signedRaw(fixture.bodyBytes, fixture.authInfoBytes, alteredSignature), transactionHash: fixture.transactionHash, now })).rejects.toThrow("COSMOS_SWAP_RECOVERY_SIGNATURE_INVALID");
    await expect(createCosmosSwapRecoveryRecord({ venue, intent: { ...fixture.intent, authority: recipient }, verified: fixture.verified, signedTransactionBase64: fixture.signedTransactionBase64, transactionHash: fixture.transactionHash, now })).rejects.toThrow("COSMOS_SWAP_RECOVERY_AUTHORITY_MISMATCH");
    await expect(createCosmosSwapRecoveryRecord({ venue, intent: fixture.intent, verified: fixture.verified, signedTransactionBase64: fixture.signedTransactionBase64, transactionHash: "A".repeat(64), now })).rejects.toThrow("COSMOS_SWAP_RECOVERY_VERIFIED_EVIDENCE_MISMATCH");
    await expect(createCosmosSwapRecoveryRecord({ venue, intent: fixture.intent, verified: { ...fixture.verified, signDocSha256: "0".repeat(64) }, signedTransactionBase64: fixture.signedTransactionBase64, transactionHash: fixture.transactionHash, now })).rejects.toThrow("COSMOS_SWAP_RECOVERY_VERIFIED_EVIDENCE_MISMATCH");
    const order = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const s = bytesToBigInt(fixture.signature.slice(32));
    const highS = concat(fixture.signature.slice(0, 32), bigintBytes(order - s));
    const highSigned = signedRaw(fixture.bodyBytes, fixture.authInfoBytes, highS);
    await expect(createCosmosSwapRecoveryRecord({ venue, intent: fixture.intent, verified: fixture.verified, signedTransactionBase64: highSigned, transactionHash: (await hash(base64.decode(highSigned))).toUpperCase(), now })).rejects.toThrow("COSMOS_SWAP_RECOVERY_SIGNATURE_INVALID");
  });

  it("moves submitted to committed success monotonically and rejects evidence regression", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture);
    const missing = await refreshCosmosSwapRecovery(record, [reader("a.example.org", "1050", null), reader("b.example.org", "1051", null)], now + 1);
    expect(missing.stage).toBe("submitted");
    const status = txStatus(fixture.transactionHash, { height: "1100" });
    const committed = await refreshCosmosSwapRecovery(missing, [reader("a.example.org", "1102", status), reader("b.example.org", "1103", status)], now + 2);
    expect(committed).toMatchObject({ stage: "committed-success", refreshCount: 2, resendBlocked: true });
    await expect(refreshCosmosSwapRecovery(committed, [reader("a.example.org", "1104", null), reader("b.example.org", "1105", null)], now + 3)).rejects.toThrow("COSMOS_SWAP_RECOVERY_STAGE_REGRESSION");
  });

  it("keeps missing history after timeout unresolved, while allowing later committed history", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture);
    const expired = await refreshCosmosSwapRecovery(record, [reader("a.example.org", "1201", null), reader("b.example.org", "1202", null)], now + 1);
    expect(expired.stage).toBe("expired-unresolved");
    await expect(refreshCosmosSwapRecovery(expired, [reader("a.example.org", "1202", null), reader("b.example.org", "1203", null)], now + 2)).resolves.toMatchObject({ stage: "expired-unresolved" });
    const historical = txStatus(fixture.transactionHash, { height: "1199" });
    await expect(refreshCosmosSwapRecovery(expired, [reader("a.example.org", "1204", historical), reader("b.example.org", "1205", historical)], now + 3)).resolves.toMatchObject({ stage: "committed-success" });
  });

  it("keeps a signed-not-submitted record through restoration, timeout, and later committed recovery", async () => {
    const fixture = await signedFixture(), record = await createSignedRecord(fixture), storage = memoryStorage();
    expect(record.stage).toBe("signed-not-submitted");
    writeCosmosSwapRecoveryRecord(record, storage);
    const restored = readCosmosSwapRecoveryJournal(storage)[0];
    expect(restored).toEqual(record);

    const beforeTimeout = await refreshCosmosSwapRecovery(restored, [reader("a.example.org", "1200", null), reader("b.example.org", "1200", null)], now + 1);
    expect(beforeTimeout.stage).toBe("signed-not-submitted");
    writeCosmosSwapRecoveryRecord(beforeTimeout, storage);
    const expired = await refreshCosmosSwapRecovery(readCosmosSwapRecoveryJournal(storage)[0], [reader("a.example.org", "1201", null), reader("b.example.org", "1202", null)], now + 2);
    expect(expired.stage).toBe("expired-unresolved");
    writeCosmosSwapRecoveryRecord(expired, storage);

    const committed = await refreshCosmosSwapRecovery(readCosmosSwapRecoveryJournal(storage)[0], [reader("a.example.org", "1203", txStatus(fixture.transactionHash, { height: "1199" })), reader("b.example.org", "1204", txStatus(fixture.transactionHash, { height: "1199" }))], now + 3);
    expect(committed).toMatchObject({ stage: "committed-success", resendBlocked: true });
    expect(committed).not.toHaveProperty("signedTransactionBase64");
  });

  it("uses strict timeout boundaries for missing and committed receipts", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture);
    const atTimeout = txStatus(fixture.transactionHash, { height: "1200" });
    await expect(refreshCosmosSwapRecovery(record, [reader("a.example.org", "1200", atTimeout), reader("b.example.org", "1200", atTimeout)], now + 1)).resolves.toMatchObject({ stage: "committed-success" });

    const stillSubmitted = await refreshCosmosSwapRecovery(record, [reader("a.example.org", "1200", null), reader("b.example.org", "1201", null)], now + 1);
    expect(stillSubmitted.stage).toBe("submitted");
    await expect(refreshCosmosSwapRecovery(stillSubmitted, [reader("a.example.org", "1201", null), reader("b.example.org", "1202", null)], now + 2)).resolves.toMatchObject({ stage: "expired-unresolved" });

    await expect(refreshCosmosSwapRecovery(record, [reader("a.example.org", "1201", txStatus(fixture.transactionHash, { height: "1201" })), reader("b.example.org", "1201", txStatus(fixture.transactionHash, { height: "1201" }))], now + 1)).rejects.toThrow("COSMOS_SWAP_RECOVERY_STATUS_INVALID");
    const timeoutFailure = txStatus(fixture.transactionHash, { height: "1201", code: 11, codespace: "sdk" });
    await expect(refreshCosmosSwapRecovery(record, [reader("a.example.org", "1201", timeoutFailure), reader("b.example.org", "1201", timeoutFailure)], now + 1)).resolves.toMatchObject({ stage: "committed-failed" });
  });

  it("tracks committed failure and rejects split readers, wrong chain, divergence, and head regression", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture);
    const failed = txStatus(fixture.transactionHash, { height: "1100", code: 11, codespace: "sdk" });
    await expect(refreshCosmosSwapRecovery(record, [reader("a.example.org", "1101", failed), reader("b.example.org", "1102", failed)], now + 1)).resolves.toMatchObject({ stage: "committed-failed" });
    await expect(refreshCosmosSwapRecovery(record, [reader("a.example.org", "1101", failed), reader("b.example.org", "1102", null)], now + 1)).rejects.toThrow("COSMOS_SWAP_RECOVERY_QUORUM_MISMATCH");
    await expect(refreshCosmosSwapRecovery(record, [reader("a.example.org", "1000", null, "osmosis-1"), reader("b.example.org", "1000", null)], now + 1)).rejects.toThrow("COSMOS_SWAP_RECOVERY_CHAIN_MISMATCH");
    await expect(refreshCosmosSwapRecovery(record, [reader("a.example.org", "800", null), reader("b.example.org", "1101", null)], now + 1)).rejects.toThrow("COSMOS_SWAP_RECOVERY_HEIGHT_DIVERGENCE");
    const observed = await refreshCosmosSwapRecovery(record, [reader("a.example.org", "1050", null), reader("b.example.org", "1051", null)], now + 1);
    await expect(refreshCosmosSwapRecovery(observed, [reader("a.example.org", "1049", null), reader("b.example.org", "1052", null)], now + 2)).rejects.toThrow("COSMOS_SWAP_RECOVERY_HEIGHT_REGRESSION");
    await expect(refreshCosmosSwapRecovery(record, [reader("a.example.org", "1000", null)], now + 1)).rejects.toThrow("COSMOS_SWAP_RECOVERY_READER_QUORUM_REQUIRED");
  });

  it("persists a strict bounded journal and refuses to overwrite tampered state", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture), storage = memoryStorage();
    writeCosmosSwapRecoveryRecord(record, storage);
    expect(readCosmosSwapRecoveryJournal(storage)).toEqual([record]);
    const raw = JSON.parse(storage.value!); raw.records[0].resendBlocked = false; storage.value = JSON.stringify(raw);
    expect(() => readCosmosSwapRecoveryJournal(storage)).toThrow("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
    expect(() => writeCosmosSwapRecoveryRecord(record, storage)).toThrow("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
  });

  it("rejects changed observations for a terminal record, including every receipt field", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture);
    const failed = txStatus(fixture.transactionHash, { height: "1100", code: 11, codespace: "sdk" });
    const terminal = await refreshCosmosSwapRecovery(record, [reader("a.example.org", "1101", failed), reader("b.example.org", "1102", failed)], now + 1);
    const changes: Array<[keyof CosmosSwapRecoveryStatus, CosmosSwapRecoveryStatus[keyof CosmosSwapRecoveryStatus]]> = [
      ["height", "1101"], ["code", 12], ["codespace", "other-sdk"], ["gasWanted", "180001"], ["gasUsed", "170001"]
    ];
    for (const [field, value] of changes) {
      // Undeclared fields from an injected reader must not override comparison.
      const changed = { ...failed, [field]: value, transactionHeight: failed.height } as CosmosSwapRecoveryStatus;
      await expect(refreshCosmosSwapRecovery(terminal, [reader("a.example.org", "1101", changed), reader("b.example.org", "1102", changed)], now + 2)).rejects.toThrow("COSMOS_SWAP_RECOVERY_TERMINAL_CONFLICT");
    }
  });

  it("rejects altered terminal and expired-unresolved observations when restoring the journal", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture), storage = memoryStorage();
    const failed = txStatus(fixture.transactionHash, { height: "1100", code: 11, codespace: "sdk" });
    const terminal = await refreshCosmosSwapRecovery(record, [reader("a.example.org", "1101", failed), reader("b.example.org", "1102", failed)], now + 1);
    writeCosmosSwapRecoveryRecord(terminal, storage);
    const alteredTerminal = JSON.parse(storage.value!);
    alteredTerminal.records[0].observations[0].gasUsed = "170001";
    storage.value = JSON.stringify(alteredTerminal);
    expect(() => readCosmosSwapRecoveryJournal(storage)).toThrow("COSMOS_SWAP_RECOVERY_RECORD_INVALID");

    const expired = await refreshCosmosSwapRecovery(record, [reader("a.example.org", "1201", null), reader("b.example.org", "1202", null)], now + 2);
    storage.value = null;
    writeCosmosSwapRecoveryRecord(expired, storage);
    const alteredExpired = JSON.parse(storage.value!);
    Object.assign(alteredExpired.records[0].observations[0], { transactionHeight: "1199", code: 0, codespace: "", gasWanted: "180000", gasUsed: "170000" });
    storage.value = JSON.stringify(alteredExpired);
    expect(() => readCosmosSwapRecoveryJournal(storage)).toThrow("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
  });

  it("snapshots the input record and reader list before asynchronous IO", async () => {
    const fixture = await signedFixture(), source = await createRecord(fixture), record = { ...source, observations: [...source.observations] }, gate = deferred<void>();
    const status = txStatus(fixture.transactionHash);
    const readers: CosmosSwapRecoveryReader[] = [delayedReader("a.example.org", "1101", status, gate.promise), delayedReader("b.example.org", "1102", status, gate.promise)];
    const pending = refreshCosmosSwapRecovery(record, readers, now + 1);
    record.stage = "committed-failed";
    record.transactionHash = "A".repeat(64);
    record.observations.push({ readerId: "mutated", blockHeight: "9999", transactionHeight: null, code: null, codespace: null, gasWanted: null, gasUsed: null });
    for (const item of readers) {
      Object.assign(item, { id: "changed.example.org", chainId: async () => "wrong-chain", transaction: async () => null });
    }
    readers.splice(0, readers.length, reader("mutated.example.org", "1", null, "wrong-chain"));
    gate.resolve(undefined);
    const captured = await pending;
    expect(captured).toMatchObject({ stage: "committed-success", refreshCount: 1, transactionHash: fixture.transactionHash });
    expect(captured.observations.map((item) => item.readerId)).toEqual(["a.example.org", "b.example.org"]);
  });

  it("rejects updatedAt regression before invoking readers", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture), calls = vi.fn();
    const readers = [
      { id: "a.example.org", chainId: async () => { calls(); return "osmo-test-5"; }, blockHeight: async () => "1101", transaction: async () => null },
      { id: "b.example.org", chainId: async () => { calls(); return "osmo-test-5"; }, blockHeight: async () => "1102", transaction: async () => null }
    ];
    await expect(refreshCosmosSwapRecovery(record, readers, now - 1)).rejects.toThrow("COSMOS_SWAP_RECOVERY_TIME_INVALID");
    expect(calls).not.toHaveBeenCalled();
  });

  it("snapshots resolved receipt fields while other reader methods are pending", async () => {
    const fixture = await signedFixture(), record = await createRecord(fixture), gate = deferred<void>();
    const status = txStatus(fixture.transactionHash);
    const pending = refreshCosmosSwapRecovery(record, ["a.example.org", "b.example.org"].map(id => ({
      id, chainId: async () => { await gate.promise; return "osmo-test-5"; }, blockHeight: async () => "1102", transaction: async () => status
    })), now + 1);
    await Promise.resolve();
    status.code = 11; status.height = "1101";
    gate.resolve(undefined);
    const result = await pending;
    expect(result.stage).toBe("committed-success");
    expect(result.observations.every(item => item.transactionHeight === "1100" && item.code === 0)).toBe(true);
  });

  it("bounds an abort-ignoring fetch and a stalled response body without leaking errors", async () => {
    const fetchGate = deferred<Response>();
    const ignoredAbort = createCosmosSwapRecoveryReader("https://stalled-fetch.example.org", vi.fn(() => fetchGate.promise) as typeof fetch, 10);
    await expect(ignoredAbort.chainId()).rejects.toThrow("COSMOS_SWAP_RECOVERY_REST_TIMEOUT");
    fetchGate.resolve(json({ default_node_info: { network: "wrong-late-result" } }));

    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); }, cancel });
    const stalledBody = createCosmosSwapRecoveryReader("https://stalled-body.example.org", vi.fn(async () => new Response(stream)) as typeof fetch, 10);
    await expect(stalledBody.chainId()).rejects.toThrow("COSMOS_SWAP_RECOVERY_REST_TIMEOUT");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(() => createCosmosSwapRecoveryReader("https://a.example.org", fetch, 0)).toThrow("COSMOS_SWAP_RECOVERY_TIMEOUT_INVALID");
  });

  it("uses two public REST hosts and only bounded credential-free GET status requests", async () => {
    const fixture = await signedFixture();
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith("node_info")) return json({ default_node_info: { network: "osmo-test-5" } });
      if (url.endsWith("blocks/latest")) return json({ block: { header: { height: "1101" } } });
      if (url.includes("/txs/")) return json({ tx_response: { txhash: fixture.transactionHash, height: "1100", code: 0, codespace: "", gas_wanted: "180000", gas_used: "170000" } });
      throw new Error(`unexpected ${url} ${init?.method}`);
    });
    const readers = createCosmosSwapRecoveryReaderQuorum(["https://a.example.org/api/", "https://b.example.org/api/"], fetchMock as typeof fetch);
    const refreshed = await refreshCosmosSwapRecovery(await createRecord(fixture), readers, now + 1);
    expect(refreshed.stage).toBe("committed-success");
    const txCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/txs/"))!;
    expect(txCall[1]).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    expect(() => createCosmosSwapRecoveryReader("http://localhost:1317")).toThrow("COSMOS_SWAP_RECOVERY_ENDPOINT_NOT_PUBLIC");
    expect(() => createCosmosSwapRecoveryReaderQuorum(["https://same.example.org/a", "https://same.example.org/b"])).toThrow("COSMOS_SWAP_RECOVERY_READER_QUORUM_NOT_INDEPENDENT");
    const missingReader = createCosmosSwapRecoveryReader("https://missing.example.org", vi.fn(async () => new Response("", { status: 404 })) as typeof fetch);
    await expect(missingReader.transaction(fixture.transactionHash)).resolves.toBeNull();

    const invalidJsonReader = createCosmosSwapRecoveryReader("https://invalid-json.example.org", vi.fn(async () => new Response("{", { status: 200 })) as typeof fetch);
    await expect(invalidJsonReader.chainId()).rejects.toThrow("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID");
    const rawFailureReader = createCosmosSwapRecoveryReader("https://raw-failure.example.org", vi.fn(async () => { throw new Error("socket details"); }) as typeof fetch);
    await expect(rawFailureReader.chainId()).rejects.toThrow("COSMOS_SWAP_RECOVERY_REST_FAILED");
  });

  it("cancels a response body already being consumed and refuses pre-cancelled HTTP", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(target) { target.enqueue(new TextEncoder().encode('{"partial":')); }, cancel });
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(stream));
    const reader = createCosmosSwapRecoveryReader("https://cancel-body.example.org", fetchMock, 8_000, controller.signal);
    const operation = reader.chainId();
    const rejected = expect(operation).rejects.toThrow("COSMOS_SWAP_RECOVERY_CANCELLED");
    await vi.waitFor(() => expect(stream.locked).toBe(true));
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(reader.chainId()).rejects.toThrow("COSMOS_SWAP_RECOVERY_CANCELLED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

async function signedFixture() {
  const message = any(venue.messageTypeUrl, text("strict-osmosis-message"));
  const bodyBytes = concat(fieldBytes(1, message), fieldVarint(3, 1200n));
  const publicKeyAny = any(venue.publicKeyTypeUrl, fieldBytes(1, publicKey));
  const modeInfo = fieldBytes(1, fieldVarint(1, 1n));
  const signerInfo = concat(fieldBytes(1, publicKeyAny), fieldBytes(2, modeInfo), fieldVarint(3, 7n));
  const feeCoin = concat(fieldBytes(1, text("uosmo")), fieldBytes(2, text("2500")));
  const authInfoBytes = concat(fieldBytes(1, signerInfo), fieldBytes(2, concat(fieldBytes(1, feeCoin), fieldVarint(2, 250000n))));
  const unsignedBytes = concat(fieldBytes(1, bodyBytes), fieldBytes(2, authInfoBytes), fieldBytes(3, new Uint8Array()));
  const intent: CosmosSwapIntent = {
    schema: "realdex.cosmos-swap-intent.v1", venueId: venue.venueId, venueRevision: venue.revision,
    chainId: venue.chainId, authority, recipient, sourceDenom: "uosmo", destinationDenom: "ibc/ABCDEF",
    amountInBaseUnits: "1000000", expectedOutBaseUnits: "950000", minimumOutBaseUnits: "900000",
    accountNumber: "11", sequence: "7", feeDenom: "uosmo", feeAmountBaseUnits: "2500", gasLimit: "250000",
    timeoutHeight: "1200", quoteExpiresAt: now + 120_000, transactionBase64: base64.encode(unsignedBytes)
  };
  const signBytes = makeSignBytes(makeSignDoc(bodyBytes, authInfoBytes, "osmo-test-5", 11n));
  const signature = Secp256k1.trimRecoveryByte(Secp256k1.createSignature(sha256(signBytes), privateKey).toFixedLength());
  const signedTransactionBase64 = signedRaw(bodyBytes, authInfoBytes, signature);
  const transactionHash = (await hash(base64.decode(signedTransactionBase64))).toUpperCase();
  const verified: VerifiedCosmosSwap = {
    schema: "realdex.verified-cosmos-swap.v1", venueId: venue.venueId, chainId: venue.chainId,
    executionTarget: venue.executionTarget, publicKeyHex: hex(publicKey),
    transactionSha256: await hash(unsignedBytes), signDocSha256: await hash(signBytes),
    intentSha256: await hash(new TextEncoder().encode(canonicalIntent(intent))), sourceDebitBaseUnits: "1000000",
    destinationCreditBaseUnits: "950000", feeAmountBaseUnits: "2500", gasUsed: "170000",
    observations: [{ readerId: "a.example.org", blockHeight: "1000" }, { readerId: "b.example.org", blockHeight: "1001" }], execution: "design-gate"
  };
  return { intent, verified, bodyBytes, authInfoBytes, signature, signedTransactionBase64, transactionHash };
}

async function createRecord(fixture: Awaited<ReturnType<typeof signedFixture>>) { return createCosmosSwapRecoveryRecord({ venue, intent: fixture.intent, verified: fixture.verified, signedTransactionBase64: fixture.signedTransactionBase64, transactionHash: fixture.transactionHash, now }); }
async function createSignedRecord(fixture: Awaited<ReturnType<typeof signedFixture>>) { return createCosmosSignedSwapRecoveryRecord({ venue, intent: fixture.intent, verified: fixture.verified, signedTransactionBase64: fixture.signedTransactionBase64, transactionHash: fixture.transactionHash, now }); }
function signedRaw(body: Uint8Array, auth: Uint8Array, signature: Uint8Array): string { return base64.encode(concat(fieldBytes(1, body), fieldBytes(2, auth), fieldBytes(3, signature))); }
function txStatus(transactionHash: string, changes: Partial<CosmosSwapRecoveryStatus> = {}): CosmosSwapRecoveryStatus { return { transactionHash, height: "1100", code: 0, codespace: "", gasWanted: "180000", gasUsed: "170000", ...changes }; }
function reader(id: string, height: string, status: CosmosSwapRecoveryStatus | null, chainId = "osmo-test-5"): CosmosSwapRecoveryReader { return { id, chainId: async () => chainId, blockHeight: async () => height, transaction: async () => status }; }
function delayedReader(id: string, height: string, status: CosmosSwapRecoveryStatus | null, wait: Promise<void>): CosmosSwapRecoveryReader { return { id, chainId: async () => { await wait; return "osmo-test-5"; }, blockHeight: async () => { await wait; return height; }, transaction: async () => { await wait; return status; } }; }
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((next) => { resolve = next; }); return { promise, resolve }; }
function memoryStorage() { return { value: null as string | null, getItem() { return this.value; }, setItem(_key: string, value: string) { this.value = value; } }; }
function canonicalIntent(value: CosmosSwapIntent): string { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key as keyof CosmosSwapIntent]]))); }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function any(typeUrl: string, value: Uint8Array): Uint8Array { return concat(fieldBytes(1, text(typeUrl)), fieldBytes(2, value)); }
function fieldBytes(number: number, value: Uint8Array): Uint8Array { return concat(varint(BigInt(number << 3 | 2)), varint(BigInt(value.length)), value); }
function fieldVarint(number: number, value: bigint): Uint8Array { return concat(varint(BigInt(number << 3)), varint(value)); }
function text(value: string): Uint8Array { return new TextEncoder().encode(value); }
function concat(...values: Uint8Array[]): Uint8Array { const output = new Uint8Array(values.reduce((sum, item) => sum + item.length, 0)); let offset = 0; for (const value of values) { output.set(value, offset); offset += value.length; } return output; }
function varint(value: bigint): Uint8Array { const bytes: number[] = []; let remaining = value; while (remaining >= 128n) { bytes.push(Number(remaining & 127n) | 128); remaining >>= 7n; } bytes.push(Number(remaining)); return Uint8Array.from(bytes); }
function bytesToBigInt(value: Uint8Array): bigint { return BigInt(`0x${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`); }
function bigintBytes(value: bigint): Uint8Array { return Uint8Array.from(value.toString(16).padStart(64, "0").match(/../g)!.map((part) => Number.parseInt(part, 16))); }
async function hash(bytes: Uint8Array): Promise<string> { return [...sha256(bytes)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
