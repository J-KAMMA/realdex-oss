import { encodeBase64, getBytes } from "ethers";
import { describe, expect, it } from "vitest";
import { decodeBitcoinAddress } from "./bitcoin-address";
import { inspectBitcoinPsbtIntent, type BitcoinPsbtIntent } from "./bitcoin-psbt";

const now = Date.parse("2026-09-01T10:00:00.000Z");
const chainId = "bip122:000000000019d6689c085ae165831e93";
const inputAddress = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const recipientAddress = "bc1qwz2lhc40s8ty3l5jg3plpve3y3l82x9l42q7fk";
const changeAddress = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const txid = "11".repeat(32);

function fixture(options: { inputEntries?: Entry[]; outputMaps?: Entry[][]; globalExtra?: Entry[]; outputAmount?: bigint } = {}): BitcoinPsbtIntent {
  const inputScript = decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey;
  const recipientScript = decodeBitcoinAddress(chainId, recipientAddress)!.scriptPubKey;
  const changeScript = decodeBitcoinAddress(chainId, changeAddress)!.scriptPubKey;
  const unsignedTx = transaction([
    { amount: options.outputAmount ?? 90_000n, script: recipientScript },
    { amount: 9_000n, script: changeScript }
  ]);
  const witnessUtxo: Entry = { type: 0x01, value: txOutput(100_000n, inputScript) };
  const psbt = concat(
    Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]),
    map([{ type: 0x00, value: unsignedTx }, ...(options.globalExtra ?? [])]),
    map(options.inputEntries ?? [witnessUtxo]),
    ...(options.outputMaps ?? [[], []]).map(map)
  );
  return {
    schema: "realdex.bitcoin-psbt-intent.v1", chainId, psbtBase64: encodeBase64(psbt), transactionVersion: 2, locktime: 0,
    feeSats: "1000", issuedAt: "2026-09-01T09:59:00.000Z", expiresAt: "2026-09-01T10:05:00.000Z",
    inputs: [{ txid, vout: 1, amountSats: "100000", address: inputAddress, sequence: 0xffff_fffd }],
    outputs: [{ address: recipientAddress, amountSats: "90000", role: "recipient" }, { address: changeAddress, amountSats: "9000", role: "change" }]
  };
}

describe("Bitcoin PSBT v0 exact-intent inspection", () => {
  it("binds an unsigned native-witness PSBT to exact inputs, outputs, fee, locktime, and expiry", () => {
    const intent = fixture();
    const report = inspectBitcoinPsbtIntent(intent, now);
    expect(report).toMatchObject({
      status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false,
      chainId, inputCount: 1, outputCount: 2, totalInputSats: "100000", totalOutputSats: "99000", feeSats: "1000",
      signedVsizeMin: 153, signedVsizeMax: 153, feeRateMilliSatsPerVbyteMin: "6535", feeRateMilliSatsPerVbyteMax: "6536"
    });
    expect(report.psbtFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(report.unsignedTransactionFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    const serialized = JSON.stringify(report);
    for (const secretlessIdentifier of [intent.psbtBase64, txid, inputAddress, recipientAddress, changeAddress]) expect(serialized).not.toContain(secretlessIdentifier);
  });

  it("rejects substituted output amounts and hidden extra output intent", () => {
    expect(() => inspectBitcoinPsbtIntent(fixture({ outputAmount: 89_999n }), now)).toThrow("BITCOIN_PSBT_OUTPUT_MISMATCH");
    const intent = fixture();
    expect(() => inspectBitcoinPsbtIntent({ ...intent, outputs: [...intent.outputs, { address: recipientAddress, amountSats: "1", role: "recipient" }] }, now)).toThrow("BITCOIN_PSBT_INTENT_COUNT_MISMATCH");
  });

  it("rejects a mismatched witness UTXO amount or source script", () => {
    const inputScript = decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey;
    expect(() => inspectBitcoinPsbtIntent(fixture({ inputEntries: [{ type: 0x01, value: txOutput(99_999n, inputScript) }] }), now)).toThrow("BITCOIN_PSBT_INPUT_UTXO_MISMATCH");
    const otherScript = decodeBitcoinAddress(chainId, recipientAddress)!.scriptPubKey;
    expect(() => inspectBitcoinPsbtIntent(fixture({ inputEntries: [{ type: 0x01, value: txOutput(100_000n, otherScript) }] }), now)).toThrow("BITCOIN_PSBT_INPUT_UTXO_MISMATCH");
  });

  it("rejects fee, sequence, version, and locktime drift from the declared intent", () => {
    const intent = fixture();
    expect(() => inspectBitcoinPsbtIntent({ ...intent, feeSats: "999" }, now)).toThrow("BITCOIN_PSBT_FEE_MISMATCH");
    expect(() => inspectBitcoinPsbtIntent({ ...intent, inputs: [{ ...intent.inputs[0], sequence: 0xffff_fffc }] }, now)).toThrow("BITCOIN_PSBT_INPUT_OUTPOINT_MISMATCH");
    expect(() => inspectBitcoinPsbtIntent({ ...intent, transactionVersion: 1 }, now)).toThrow("BITCOIN_PSBT_TRANSACTION_HEADER_MISMATCH");
    expect(() => inspectBitcoinPsbtIntent({ ...intent, locktime: 1 }, now)).toThrow("BITCOIN_PSBT_TRANSACTION_HEADER_MISMATCH");
  });

  it("rejects partial/final signatures and unsafe sighash modes", () => {
    const script = decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey;
    const witness: Entry = { type: 0x01, value: txOutput(100_000n, script) };
    expect(() => inspectBitcoinPsbtIntent(fixture({ inputEntries: [witness, { type: 0x02, keyData: new Uint8Array(33).fill(2), value: Uint8Array.from([1]) }] }), now)).toThrow("BITCOIN_PSBT_ALREADY_SIGNED");
    expect(() => inspectBitcoinPsbtIntent(fixture({ inputEntries: [witness, { type: 0x03, value: u32(3) }] }), now)).toThrow("BITCOIN_PSBT_SIGHASH_UNSAFE");
  });

  it("rejects non-witness inputs, output metadata, and PSBT v2", () => {
    const script = decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey;
    const witness: Entry = { type: 0x01, value: txOutput(100_000n, script) };
    expect(() => inspectBitcoinPsbtIntent(fixture({ inputEntries: [witness, { type: 0x00, value: Uint8Array.from([1]) }] }), now)).toThrow("BITCOIN_PSBT_NON_WITNESS_INPUT_UNSUPPORTED");
    expect(() => inspectBitcoinPsbtIntent(fixture({ outputMaps: [[{ type: 0x02, value: Uint8Array.from([1]) }], []] }), now)).toThrow("BITCOIN_PSBT_OUTPUT_METADATA_UNSUPPORTED");
    expect(() => inspectBitcoinPsbtIntent(fixture({ globalExtra: [{ type: 0xfb, value: u32(2) }] }), now)).toThrow("BITCOIN_PSBT_VERSION_UNSUPPORTED");
  });

  it("rejects non-minimal CompactSize, malformed base64, and duplicate keys", () => {
    const nonMinimal = concat(Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff, 0xfd, 0x01, 0x00]));
    expect(() => inspectBitcoinPsbtIntent({ ...fixture(), psbtBase64: encodeBase64(nonMinimal) }, now)).toThrow("BITCOIN_PSBT_COMPACT_SIZE_NON_MINIMAL");
    expect(() => inspectBitcoinPsbtIntent({ ...fixture(), psbtBase64: "not base64" }, now)).toThrow("BITCOIN_PSBT_BASE64_INVALID");
    const script = decodeBitcoinAddress(chainId, inputAddress)!.scriptPubKey;
    const witness: Entry = { type: 0x01, value: txOutput(100_000n, script) };
    expect(() => inspectBitcoinPsbtIntent(fixture({ inputEntries: [witness, witness] }), now)).toThrow("BITCOIN_PSBT_DUPLICATE_KEY");
  });

  it("rejects expired, overlong, or structurally extended intents", () => {
    expect(() => inspectBitcoinPsbtIntent({ ...fixture(), expiresAt: "2026-09-01T10:00:00.000Z" }, now)).toThrow("BITCOIN_PSBT_INTENT_EXPIRED_OR_TTL_INVALID");
    expect(() => inspectBitcoinPsbtIntent({ ...fixture(), issuedAt: "2026-09-01T09:00:00.000Z" }, now)).toThrow("BITCOIN_PSBT_INTENT_EXPIRED_OR_TTL_INVALID");
    expect(() => inspectBitcoinPsbtIntent({ ...fixture(), unexpected: true }, now)).toThrow("BITCOIN_PSBT_INTENT_FIELDS_INVALID");
  });
});

type Entry = { type: number; keyData?: Uint8Array; value: Uint8Array };

function transaction(outputs: Array<{ amount: bigint; script: Uint8Array }>): Uint8Array {
  return concat(
    u32(2), compact(1), getBytes(`0x${txid}`).slice().reverse(), u32(1), compact(0), u32(0xffff_fffd), compact(outputs.length),
    ...outputs.map((output) => txOutput(output.amount, output.script)), u32(0)
  );
}

function txOutput(amount: bigint, script: Uint8Array): Uint8Array { return concat(u64(amount), compact(script.length), script); }
function map(entries: Entry[]): Uint8Array {
  return concat(...entries.flatMap((entry) => {
    const key = concat(compact(entry.type), entry.keyData ?? new Uint8Array());
    return [compact(key.length), key, compact(entry.value.length), entry.value];
  }), Uint8Array.from([0]));
}
function compact(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.from([value]);
  if (value <= 0xffff) return Uint8Array.from([0xfd, value & 0xff, value >>> 8]);
  return concat(Uint8Array.from([0xfe]), u32(value));
}
function u32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }
function u64(value: bigint): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; }
function concat(...parts: Uint8Array[]): Uint8Array { const length = parts.reduce((sum, part) => sum + part.length, 0); const result = new Uint8Array(length); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
