import { encodeBase64, getBytes, hexlify } from "ethers";
import { describe, expect, it } from "vitest";
import { decodeBitcoinAddress } from "./bitcoin-address";
import { DEFAULT_BITCOIN_FEE_SAFETY_POLICY, verifyBitcoinFeeSafety } from "./bitcoin-fee-policy";
import { inspectBitcoinPsbtIntent, type BitcoinPsbtIntent } from "./bitcoin-psbt";
import { verifyBitcoinPsbtUtxoQuorum, type BitcoinEsploraFeeReader, type BitcoinUtxoObservation } from "./bitcoin-utxo-quorum";

const now = Date.parse("2026-09-01T10:00:00.000Z");
const chainId = "bip122:000000000019d6689c085ae165831e93";
const genesisHash = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const inputAddress = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const recipientAddress = "bc1qwz2lhc40s8ty3l5jg3plpve3y3l82x9l42q7fk";
const txid = "11".repeat(32);

describe("Bitcoin two-reader fee safety", () => {
  it("binds conservative signed vsize and a two-reader recommendation without enabling execution", async () => {
    const { intent, inspection, utxo } = await setup();
    const report = await verifyBitcoinFeeSafety(intent, inspection, utxo, [reader("a.example", "8000"), reader("b.example", "9000")], undefined, now);
    expect(report).toMatchObject({ status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false, feeSats: "1000", signedVsizeMin: 110, signedVsizeMax: 110, feeRateMilliSatsPerVbyteMin: "9090", feeRateMilliSatsPerVbyteMax: "9091", confirmationTargetBlocks: 6, recommendationMilliSatsPerVbyteMin: "8000", recommendationMilliSatsPerVbyteMax: "9000" });
    expect(JSON.stringify(report)).not.toContain(txid);
    expect(JSON.stringify(report)).not.toContain(inputAddress);
  });

  it("rejects a rate too far below the more conservative recommendation", async () => {
    const { intent, inspection, utxo } = await setup();
    await expect(verifyBitcoinFeeSafety(intent, inspection, utxo, [reader("a.example", "30000"), reader("b.example", "32000")], undefined, now)).rejects.toThrow("BITCOIN_FEE_RATE_TOO_LOW");
  });

  it("rejects a rate too far above the lower recommendation", async () => {
    const { intent, inspection, utxo } = await setup();
    await expect(verifyBitcoinFeeSafety(intent, inspection, utxo, [reader("a.example", "1000"), reader("b.example", "1200")], undefined, now)).rejects.toThrow("BITCOIN_FEE_RATE_TOO_HIGH");
  });

  it("rejects reader divergence and invalid observations", async () => {
    const { intent, inspection, utxo } = await setup();
    await expect(verifyBitcoinFeeSafety(intent, inspection, utxo, [reader("a.example", "1000"), reader("b.example", "2000")], undefined, now)).rejects.toThrow("BITCOIN_FEE_READER_DIVERGENCE");
    await expect(verifyBitcoinFeeSafety(intent, inspection, utxo, [reader("a.example", "8000"), { ...reader("b.example", "9000"), feeEstimate: async () => ({ readerId: "wrong.example", targetBlocks: 6, feeRateMilliSatsPerVbyte: "9000" }) }], undefined, now)).rejects.toThrow("BITCOIN_FEE_ESTIMATE_INVALID");
  });

  it("rejects absolute-limit and malformed policy substitutions", async () => {
    const { intent, inspection, utxo } = await setup();
    await expect(verifyBitcoinFeeSafety(intent, inspection, utxo, [reader("a.example", "8000"), reader("b.example", "9000")], { ...DEFAULT_BITCOIN_FEE_SAFETY_POLICY, maxFeeRateMilliSatsPerVbyte: "9000" }, now)).rejects.toThrow("BITCOIN_FEE_ABSOLUTE_LIMIT");
    await expect(verifyBitcoinFeeSafety(intent, inspection, utxo, [reader("a.example", "8000"), reader("b.example", "9000")], { ...DEFAULT_BITCOIN_FEE_SAFETY_POLICY, confirmationTargetBlocks: 26 }, now)).rejects.toThrow("BITCOIN_FEE_POLICY_INVALID");
  });

  it("rejects stale inspection and substituted UTXO evidence before querying fee readers", async () => {
    const { intent, inspection, utxo } = await setup();
    const readers = [reader("a.example", "8000"), reader("b.example", "9000")];
    await expect(verifyBitcoinFeeSafety(intent, { ...inspection, intentFingerprint: `0x${"00".repeat(32)}` }, utxo, readers, undefined, now)).rejects.toThrow("BITCOIN_FEE_INSPECTION_STALE");
    await expect(verifyBitcoinFeeSafety(intent, inspection, { ...utxo, psbtFingerprint: `0x${"00".repeat(32)}` }, readers, undefined, now)).rejects.toThrow("BITCOIN_FEE_UTXO_BINDING_INVALID");
  });
});

async function setup() {
  const intent = fixture(); const inspection = inspectBitcoinPsbtIntent(intent, now);
  const utxo = await verifyBitcoinPsbtUtxoQuorum(intent, inspection, [reader("a.example", "8000"), reader("b.example", "9000")], undefined, now);
  return { intent, inspection, utxo };
}

function reader(id: string, feeRateMilliSatsPerVbyte: string): BitcoinEsploraFeeReader {
  return {
    id,
    feeEstimate: async (targetBlocks) => ({ readerId: id, targetBlocks, feeRateMilliSatsPerVbyte }),
    observe: async () => ({ readerId: id, genesisHash, tipHeight: 105, inputs: [observation()] })
  };
}

function observation(): BitcoinUtxoObservation["inputs"][number] {
  return { txid, vout: 1, valueSats: "100000", scriptPubKey: hexlify(decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey).slice(2), confirmed: true, blockHeight: 101, blockHash: "44".repeat(32), spent: false };
}

function fixture(): BitcoinPsbtIntent {
  const sourceScript = decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey;
  const recipientScript = decodeBitcoinAddress(chainId, recipientAddress)!.scriptPubKey;
  const unsignedTx = concat(u32(2), compact(1), getBytes(`0x${txid}`).slice().reverse(), u32(1), compact(0), u32(0xffff_fffd), compact(1), txOutput(99_000n, recipientScript), u32(0));
  const psbt = concat(Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]), map([{ type: 0x00, value: unsignedTx }]), map([{ type: 0x01, value: txOutput(100_000n, sourceScript) }]), map([]));
  return { schema: "realdex.bitcoin-psbt-intent.v1", chainId, psbtBase64: encodeBase64(psbt), transactionVersion: 2, locktime: 0, feeSats: "1000", issuedAt: "2026-09-01T09:59:00.000Z", expiresAt: "2026-09-01T10:05:00.000Z", inputs: [{ txid, vout: 1, amountSats: "100000", address: inputAddress, sequence: 0xffff_fffd }], outputs: [{ address: recipientAddress, amountSats: "99000", role: "recipient" }] };
}

type Entry = { type: number; value: Uint8Array };
function txOutput(amount: bigint, script: Uint8Array): Uint8Array { return concat(u64(amount), compact(script.length), script); }
function map(entries: Entry[]): Uint8Array { return concat(...entries.flatMap((entry) => { const key = compact(entry.type); return [compact(key.length), key, compact(entry.value.length), entry.value]; }), Uint8Array.from([0])); }
function compact(value: number): Uint8Array { return Uint8Array.from([value]); }
function u32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }
function u64(value: bigint): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; }
function concat(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; parts.forEach((part) => { result.set(part, offset); offset += part.length; }); return result; }
