import { Secp256k1, ripemd160, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { base64 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import {
  createCosmosSwapReader,
  createCosmosSwapReaderQuorum,
  cosmosSwapIntentSha256,
  verifyCosmosSwapBoundary,
  type CosmosSwapIntent,
  type CosmosSwapReader,
  type CosmosVenueDescriptor,
  type DecodedCosmosSwapMessage
} from "./cosmos-swap-boundary";

const now = 1_788_200_000_000;
const walletPrivateKey = new Uint8Array(32).fill(9);
const publicKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(walletPrivateKey).pubkey);
const authority = toBech32("osmo", ripemd160(sha256(publicKey)));
const recipient = toBech32("osmo", Uint8Array.from({ length: 20 }, (_, index) => 30 - index));
const venue: CosmosVenueDescriptor = {
  schema: "realdex.cosmos-venue.v1", venueId: "reviewed-osmosis-venue", revision: 1,
  chainId: "cosmos:osmo-test-5", bech32Prefix: "osmo",
  messageTypeUrl: "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn", executionTarget: "poolmanager:pool-42",
  publicKeyTypeUrl: "/cosmos.crypto.secp256k1.PubKey",
  evidenceUrls: ["https://evidence-a.example.org/venue", "https://evidence-b.example.org/venue"]
};
const decoded: DecodedCosmosSwapMessage = {
  authority, recipient, executionTarget: venue.executionTarget,
  sourceDenom: "uosmo", destinationDenom: "ibc/ABCDEF",
  amountInBaseUnits: "1000000", minimumOutBaseUnits: "900000"
};

function fixture(options: { signature?: Uint8Array; extraMessage?: boolean; outOfOrder?: boolean; mode?: bigint; timeoutHeight?: bigint; feeAmount?: string; sequence?: bigint; publicKey?: Uint8Array } = {}): CosmosSwapIntent {
  const message = any(venue.messageTypeUrl, new TextEncoder().encode(JSON.stringify(decoded)));
  const body = options.outOfOrder
    ? concat(fieldVarint(3, options.timeoutHeight ?? 1200n), fieldBytes(1, message))
    : concat(fieldBytes(1, message), ...(options.extraMessage ? [fieldBytes(1, message)] : []), fieldVarint(3, options.timeoutHeight ?? 1200n));
  const pubkeyAny = any(venue.publicKeyTypeUrl, fieldBytes(1, options.publicKey ?? publicKey));
  const modeInfo = fieldBytes(1, fieldVarint(1, options.mode ?? 1n));
  const sequence = options.sequence ?? 7n;
  const signerInfo = concat(fieldBytes(1, pubkeyAny), fieldBytes(2, modeInfo), ...(sequence === 0n ? [] : [fieldVarint(3, sequence)]));
  const feeCoin = concat(fieldBytes(1, text("uosmo")), fieldBytes(2, text(options.feeAmount ?? "2500")));
  const fee = concat(fieldBytes(1, feeCoin), fieldVarint(2, 250000n));
  const authInfo = concat(fieldBytes(1, signerInfo), fieldBytes(2, fee));
  const txRaw = concat(fieldBytes(1, body), fieldBytes(2, authInfo), fieldBytes(3, options.signature ?? new Uint8Array()));
  return {
    schema: "realdex.cosmos-swap-intent.v1", venueId: venue.venueId, venueRevision: venue.revision, chainId: venue.chainId,
    authority, recipient, sourceDenom: decoded.sourceDenom, destinationDenom: decoded.destinationDenom,
    amountInBaseUnits: decoded.amountInBaseUnits, expectedOutBaseUnits: "950000", minimumOutBaseUnits: decoded.minimumOutBaseUnits,
    accountNumber: "11", sequence: sequence.toString(), feeDenom: "uosmo", feeAmountBaseUnits: "2500", gasLimit: "250000",
    timeoutHeight: "1200", quoteExpiresAt: now + 120_000, transactionBase64: base64.encode(txRaw)
  };
}

function reader(id: string, changes: Partial<CosmosSwapReader> & { spent?: Array<{ denom: string; amount: string }>; received?: Array<{ denom: string; amount: string }>; gasUsed?: string } = {}): CosmosSwapReader {
  return {
    id,
    chainId: changes.chainId ?? (async () => "osmo-test-5"),
    blockHeight: changes.blockHeight ?? (async () => "1000"),
    account: changes.account ?? (async () => ({ accountNumber: "11", sequence: "7", publicKeyTypeUrl: venue.publicKeyTypeUrl, publicKeyBase64: base64.encode(publicKey) })),
    simulate: changes.simulate ?? (async () => ({
      gasWanted: "180000", gasUsed: changes.gasUsed ?? "170000",
      authoritySpent: changes.spent ?? [{ denom: "ibc/ABCDEF", amount: "0" }, { denom: "uosmo", amount: "1002500" }].filter((coin) => coin.amount !== "0"),
      recipientReceived: changes.received ?? [{ denom: "ibc/ABCDEF", amount: "950000" }]
    }))
  };
}

const decode = (bytes: Uint8Array): DecodedCosmosSwapMessage => JSON.parse(new TextDecoder().decode(bytes)) as DecodedCosmosSwapMessage;

describe("Cosmos swap safety boundary", () => {
  it("binds one direct-sign transaction, current account state, exact fee, and two simulations", async () => {
    const result = await verifyCosmosSwapBoundary({ venue, intent: fixture(), readers: [reader("a.example.org"), reader("b.example.org")], decodeSwapMessage: decode, now });
    expect(result).toMatchObject({ schema: "realdex.verified-cosmos-swap.v1", execution: "design-gate", sourceDebitBaseUnits: "1000000", destinationCreditBaseUnits: "950000", feeAmountBaseUnits: "2500", gasUsed: "170000" });
    expect(result.transactionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signDocSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.observations).toHaveLength(2);
    const zeroAccount = { account: async () => ({ accountNumber: "11", sequence: "0", publicKeyTypeUrl: venue.publicKeyTypeUrl, publicKeyBase64: base64.encode(publicKey) }) };
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture({ sequence: 0n }), readers: [reader("a.example.org", zeroAccount), reader("b.example.org", zeroAccount)], decodeSwapMessage: decode, now })).resolves.toMatchObject({ execution: "design-gate" });
  });

  it("requires the transaction public key to derive the exact authority address", async () => {
    const otherKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(new Uint8Array(32).fill(10)).pubkey);
    const account = { account: async () => ({ accountNumber: "11", sequence: "7", publicKeyTypeUrl: venue.publicKeyTypeUrl, publicKeyBase64: base64.encode(otherKey) }) };
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture({ publicKey: otherKey }), readers: [reader("a.example.org", account), reader("b.example.org", account)], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_PUBLIC_KEY_AUTHORITY_MISMATCH");
    const invalidKey = Uint8Array.from([2, ...new Uint8Array(32).fill(255)]);
    const invalidAccount = { account: async () => ({ accountNumber: "11", sequence: "7", publicKeyTypeUrl: venue.publicKeyTypeUrl, publicKeyBase64: base64.encode(invalidKey) }) };
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture({ publicKey: invalidKey }), readers: [reader("a.example.org", invalidAccount), reader("b.example.org", invalidAccount)], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_PUBLIC_KEY_INVALID");
  });

  it("snapshots the intent before asynchronous readers can mutate caller-owned input", async () => {
    const intent = fixture();
    const original = { ...intent };
    const changing = reader("a.example.org", { chainId: async () => { intent.minimumOutBaseUnits = "1"; return "osmo-test-5"; } });
    const verified = await verifyCosmosSwapBoundary({ venue, intent, readers: [changing, reader("b.example.org")], decodeSwapMessage: decode, now });
    expect(verified.intentSha256).toBe(await cosmosSwapIntentSha256(original));
    expect(verified.intentSha256).not.toBe(await cosmosSwapIntentSha256(intent));
  });

  it("rejects pre-signing, hidden messages, Amino mode, and decoded message mutation", async () => {
    const readers = [reader("a.example.org"), reader("b.example.org")];
    await expect(verifyCosmosSwapBoundary({ venue, intent: { ...fixture(), unexpectedAuthority: "broadcast" } as CosmosSwapIntent, readers, decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_INTENT_INVALID");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture({ signature: Uint8Array.of(1) }), readers, decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_PRE_SIGNED_TRANSACTION_BLOCKED");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture({ extraMessage: true }), readers, decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_BODY_INVALID");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture({ outOfOrder: true }), readers, decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_BODY_INVALID");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture({ mode: 127n }), readers, decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_SIGN_MODE_INVALID");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture(), readers, decodeSwapMessage: () => ({ ...decoded, amountInBaseUnits: "999" }), now })).rejects.toThrow("COSMOS_SWAP_MESSAGE_BINDING_INVALID");
  });

  it("rejects stale timeout height, account changes, wrong chain, and one-reader claims", async () => {
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture({ timeoutHeight: 999n }), readers: [reader("a.example.org"), reader("b.example.org")], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_TIMEOUT_HEIGHT_INVALID");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture(), readers: [reader("a.example.org"), reader("b.example.org", { account: async () => ({ accountNumber: "11", sequence: "8", publicKeyTypeUrl: venue.publicKeyTypeUrl, publicKeyBase64: base64.encode(publicKey) }) })], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_ACCOUNT_STATE_MISMATCH");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture(), readers: [reader("a.example.org"), reader("b.example.org", { chainId: async () => "osmosis-1" })], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_CHAIN_MISMATCH");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture(), readers: [reader("a.example.org")], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_READER_QUORUM_REQUIRED");
  });

  it("rejects exact debit/credit failures, excess gas, and simulation disagreement", async () => {
    const base = reader("a.example.org");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture(), readers: [base, reader("b.example.org", { spent: [{ denom: "uosmo", amount: "1002499" }] })], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_SIMULATION_DEBIT_MISMATCH");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture(), readers: [base, reader("b.example.org", { received: [{ denom: "ibc/ABCDEF", amount: "899999" }] })], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_SIMULATION_CREDIT_MISMATCH");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture(), readers: [base, reader("b.example.org", { gasUsed: "250001" })], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_SIMULATION_FAILED");
    await expect(verifyCosmosSwapBoundary({ venue, intent: fixture(), readers: [base, reader("b.example.org", { gasUsed: "169999" })], decodeSwapMessage: decode, now })).rejects.toThrow("COSMOS_SWAP_SIMULATION_QUORUM_MISMATCH");
  });

  it("uses two distinct public REST hosts and sends only a bounded read-only simulation", async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith("node_info")) return json({ default_node_info: { network: "osmo-test-5" } });
      if (url.endsWith("blocks/latest")) return json({ block: { header: { height: "1000" } } });
      if (url.includes("/accounts/")) return json({ account: { "@type": "/cosmos.auth.v1beta1.BaseAccount", account_number: "11", sequence: "7", pub_key: { "@type": venue.publicKeyTypeUrl, key: base64.encode(publicKey) } } });
      if (url.endsWith("/simulate")) return json({ gas_info: { gas_wanted: "180000", gas_used: "170000" }, result: { events: [
        { type: "coin_spent", attributes: [{ key: "spender", value: authority }, { key: "amount", value: "1002500uosmo" }] },
        { type: "coin_received", attributes: [{ key: "receiver", value: recipient }, { key: "amount", value: "950000ibc/ABCDEF" }] }
      ] } });
      throw new Error(`unexpected ${url} ${init?.method}`);
    });
    const readers = createCosmosSwapReaderQuorum(["https://a.example.org/api/", "https://b.example.org/api/"], fetchMock as typeof fetch);
    const result = await verifyCosmosSwapBoundary({ venue, intent: fixture(), readers, decodeSwapMessage: decode, now });
    expect(result.execution).toBe("design-gate");
    const simulationCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/simulate"))!;
    expect(simulationCall[1]).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(JSON.parse(String(simulationCall[1]?.body))).toEqual({ tx_bytes: fixture().transactionBase64 });
    expect(() => createCosmosSwapReader("http://localhost:1317")).toThrow("COSMOS_SWAP_ENDPOINT_NOT_PUBLIC");
    expect(() => createCosmosSwapReaderQuorum(["https://same.example.org/a", "https://same.example.org/b"])).toThrow("COSMOS_SWAP_READER_QUORUM_NOT_INDEPENDENT");
  });
});

function any(typeUrl: string, value: Uint8Array): Uint8Array { return concat(fieldBytes(1, text(typeUrl)), fieldBytes(2, value)); }
function fieldBytes(number: number, value: Uint8Array): Uint8Array { return concat(varint(BigInt(number << 3 | 2)), varint(BigInt(value.length)), value); }
function fieldVarint(number: number, value: bigint): Uint8Array { return concat(varint(BigInt(number << 3)), varint(value)); }
function text(value: string): Uint8Array { return new TextEncoder().encode(value); }
function concat(...parts: Uint8Array[]): Uint8Array { const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }
function varint(value: bigint): Uint8Array { const bytes: number[] = []; let current = value; do { let byte = Number(current & 0x7fn); current >>= 7n; if (current) byte |= 0x80; bytes.push(byte); } while (current); return Uint8Array.from(bytes); }
function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
