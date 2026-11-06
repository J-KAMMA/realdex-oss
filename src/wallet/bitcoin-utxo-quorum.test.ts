import { encodeBase64, getBytes, hexlify } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { decodeBitcoinAddress } from "./bitcoin-address";
import { inspectBitcoinPsbtIntent, type BitcoinPsbtIntent } from "./bitcoin-psbt";
import {
  assertDistinctPublicEsploraEndpoints, createBitcoinEsploraReader, verifyBitcoinPsbtUtxoQuorum,
  type BitcoinEsploraReader, type BitcoinUtxoObservation
} from "./bitcoin-utxo-quorum";

const now = Date.parse("2026-09-01T10:00:00.000Z");
const chainId = "bip122:000000000019d6689c085ae165831e93";
const genesisHash = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const inputAddress = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const recipientAddress = "bc1qwz2lhc40s8ty3l5jg3plpve3y3l82x9l42q7fk";
const txid = "11".repeat(32);

describe("Bitcoin Esplora UTXO quorum", () => {
  it("verifies exact unspent UTXO evidence from two independent readers without enabling signing", async () => {
    const intent = fixture();
    const report = await verifyBitcoinPsbtUtxoQuorum(intent, inspectBitcoinPsbtIntent(intent, now), [reader("a.example"), reader("b.example", { tipHeight: 105 })], { minConfirmations: 3, maxTipDivergence: 6 }, now);
    expect(report).toMatchObject({ status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false, inputCount: 1, minConfirmations: 3, weakestConfirmations: 5 });
    expect(JSON.stringify(report)).not.toContain(txid);
    expect(JSON.stringify(report)).not.toContain(inputAddress);
  });

  it("rejects spent, wrong-chain, and insufficient-confirmation evidence", async () => {
    const intent = fixture(); const inspection = inspectBitcoinPsbtIntent(intent, now);
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("a.example", { spent: true }), reader("b.example", { spent: true })], undefined, now)).rejects.toThrow("BITCOIN_UTXO_SPENT");
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("a.example", { genesisHash: "22".repeat(32) }), reader("b.example")], undefined, now)).rejects.toThrow("BITCOIN_UTXO_CHAIN_MISMATCH");
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("a.example", { tipHeight: 101 }), reader("b.example", { tipHeight: 101 })], { minConfirmations: 2, maxTipDivergence: 0 }, now)).rejects.toThrow("BITCOIN_UTXO_CONFIRMATIONS_INSUFFICIENT");
  });

  it("rejects amount/script substitutions and reader disagreement", async () => {
    const intent = fixture(); const inspection = inspectBitcoinPsbtIntent(intent, now);
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("a.example", { valueSats: "99999" }), reader("b.example", { valueSats: "99999" })], undefined, now)).rejects.toThrow("BITCOIN_UTXO_WITNESS_MISMATCH");
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("a.example"), reader("b.example", { blockHash: "33".repeat(32) })], undefined, now)).rejects.toThrow("BITCOIN_UTXO_READER_DISAGREEMENT");
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("a.example", { tipHeight: 110, blockHeight: 90 }), reader("b.example", { tipHeight: 100, blockHeight: 90 })], { minConfirmations: 1, maxTipDivergence: 6 }, now)).rejects.toThrow("BITCOIN_UTXO_TIP_DIVERGENCE");
  });

  it("rejects a stale inspection, invalid policy, or non-independent reader IDs", async () => {
    const intent = fixture(); const inspection = inspectBitcoinPsbtIntent(intent, now);
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, { ...inspection, psbtFingerprint: `0x${"00".repeat(32)}` }, [reader("a.example"), reader("b.example")], undefined, now)).rejects.toThrow("BITCOIN_UTXO_INSPECTION_STALE");
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("same.example"), reader("same.example")], undefined, now)).rejects.toThrow("BITCOIN_UTXO_READER_QUORUM_INVALID");
    await expect(verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("a.example"), reader("b.example")], { minConfirmations: 0, maxTipDivergence: 6 }, now)).rejects.toThrow("BITCOIN_UTXO_POLICY_INVALID");
  });

  it("uses only bounded GET requests and parses documented Esplora responses", async () => {
    const intent = fixture(); const calls: Array<{ url: string; method?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, method: init?.method });
      if (url.endsWith("block-height/0")) return response(genesisHash);
      if (url.endsWith("blocks/tip/height")) return response("105");
      if (url.endsWith("fee-estimates")) return response(JSON.stringify({ "6": 8.125 }));
      if (url.endsWith(`/tx/${txid}`)) return response(JSON.stringify({ txid, vout: [{ value: 1, scriptpubkey: "0014" + "00".repeat(20) }, { value: 100000, scriptpubkey: inputScript() }], status: { confirmed: true, block_height: 101, block_hash: "44".repeat(32) } }));
      if (url.endsWith(`/tx/${txid}/outspend/1`)) return response(JSON.stringify({ spent: false }));
      return response("", 404);
    });
    const observation = await createBitcoinEsploraReader("https://a.example/api", fetchMock as typeof fetch).observe(chainId, intent.inputs);
    expect(observation.inputs[0]).toMatchObject({ valueSats: "100000", spent: false, blockHeight: 101 });
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.method === "GET" && call.url.startsWith("https://a.example/api/"))).toBe(true);
    const fee = await createBitcoinEsploraReader("https://a.example/api", fetchMock as typeof fetch).feeEstimate(6);
    expect(fee).toEqual({ readerId: "a.example", targetBlocks: 6, feeRateMilliSatsPerVbyte: "8125" });
    expect(calls).toHaveLength(5);
  });

  it("rejects private, credentialed, duplicate-host, malformed, and oversized endpoints/responses", async () => {
    expect(() => assertDistinctPublicEsploraEndpoints(["http://a.example/api", "https://b.example/api"])).toThrow("BITCOIN_ESPLORA_URL_NOT_PUBLIC");
    expect(() => assertDistinctPublicEsploraEndpoints(["https://user:pass@a.example/api", "https://b.example/api"])).toThrow("BITCOIN_ESPLORA_URL_NOT_PUBLIC");
    expect(() => assertDistinctPublicEsploraEndpoints(["https://a.example/api", "https://a.example/other"])).toThrow("BITCOIN_ESPLORA_ENDPOINTS_NOT_INDEPENDENT");
    expect(() => createBitcoinEsploraReader("https://127.0.0.1/api")).toThrow("BITCOIN_ESPLORA_URL_NOT_PUBLIC");
    const invalid = createBitcoinEsploraReader("https://a.example/api", (async () => response("not-a-hash")) as typeof fetch);
    await expect(invalid.observe(chainId, fixture().inputs)).rejects.toThrow("BITCOIN_ESPLORA_GENESIS_INVALID");
    const oversized = createBitcoinEsploraReader("https://a.example/api", (async () => new Response("", { headers: { "content-length": "2000001" } })) as typeof fetch);
    await expect(oversized.observe(chainId, fixture().inputs)).rejects.toThrow("BITCOIN_ESPLORA_RESPONSE_TOO_LARGE");
    const unannouncedOversized = createBitcoinEsploraReader("https://a.example/api", (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_000_001)); controller.enqueue(new Uint8Array(1_000_001)); controller.close(); } }))) as typeof fetch);
    await expect(unannouncedOversized.observe(chainId, fixture().inputs)).rejects.toThrow("BITCOIN_ESPLORA_RESPONSE_TOO_LARGE");
  });

  it("fails closed when an Esplora request times out", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await expect(createBitcoinEsploraReader("https://a.example/api", fetchMock as typeof fetch, 1).observe(chainId, fixture().inputs)).rejects.toThrow("BITCOIN_ESPLORA_TIMEOUT");
  });

  it("rejects unsupported targets and malformed fee estimates before they gain authority", async () => {
    const fetchMock = vi.fn(async () => response(JSON.stringify({ "6": 8.1234 })));
    const reader = createBitcoinEsploraReader("https://a.example/api", fetchMock as typeof fetch);
    await expect(reader.feeEstimate(26)).rejects.toThrow("BITCOIN_FEE_TARGET_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(reader.feeEstimate(6)).rejects.toThrow("BITCOIN_ESPLORA_FEE_ESTIMATE_INVALID");
  });
});

function reader(id: string, overrides: Partial<BitcoinUtxoObservation["inputs"][number]> & { genesisHash?: string; tipHeight?: number } = {}): BitcoinEsploraReader {
  return { id, observe: async () => ({ readerId: id, genesisHash: overrides.genesisHash ?? genesisHash, tipHeight: overrides.tipHeight ?? 105, inputs: [{ txid, vout: 1, valueSats: overrides.valueSats ?? "100000", scriptPubKey: overrides.scriptPubKey ?? inputScript(), confirmed: overrides.confirmed ?? true, blockHeight: overrides.blockHeight ?? 101, blockHash: overrides.blockHash ?? "44".repeat(32), spent: overrides.spent ?? false }] }) };
}

function fixture(): BitcoinPsbtIntent {
  const sourceScript = decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey;
  const recipientScript = decodeBitcoinAddress(chainId, recipientAddress)!.scriptPubKey;
  const unsignedTx = concat(u32(2), compact(1), getBytes(`0x${txid}`).slice().reverse(), u32(1), compact(0), u32(0xffff_fffd), compact(1), txOutput(99_000n, recipientScript), u32(0));
  const psbt = concat(Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]), map([{ type: 0x00, value: unsignedTx }]), map([{ type: 0x01, value: txOutput(100_000n, sourceScript) }]), map([]));
  return { schema: "realdex.bitcoin-psbt-intent.v1", chainId, psbtBase64: encodeBase64(psbt), transactionVersion: 2, locktime: 0, feeSats: "1000", issuedAt: "2026-09-01T09:59:00.000Z", expiresAt: "2026-09-01T10:05:00.000Z", inputs: [{ txid, vout: 1, amountSats: "100000", address: inputAddress, sequence: 0xffff_fffd }], outputs: [{ address: recipientAddress, amountSats: "99000", role: "recipient" }] };
}

type Entry = { type: number; value: Uint8Array };
function inputScript(): string { return hexlify(decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey).slice(2); }
function response(body: string, status = 200): Response { return new Response(body, { status }); }
function txOutput(amount: bigint, script: Uint8Array): Uint8Array { return concat(u64(amount), compact(script.length), script); }
function map(entries: Entry[]): Uint8Array { return concat(...entries.flatMap((entry) => { const key = compact(entry.type); return [compact(key.length), key, compact(entry.value.length), entry.value]; }), Uint8Array.from([0])); }
function compact(value: number): Uint8Array { return Uint8Array.from([value]); }
function u32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }
function u64(value: bigint): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; }
function concat(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; parts.forEach((part) => { result.set(part, offset); offset += part.length; }); return result; }
