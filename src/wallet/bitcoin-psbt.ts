import { decodeBase64, encodeBase64, hexlify, sha256, toUtf8Bytes } from "ethers";
import { decodeBitcoinAddress } from "./bitcoin-address";

export const BITCOIN_PSBT_INSPECTION_ID = "bitcoin-psbt-v0-exact-intent-inspection-v1";

export type BitcoinPsbtInputIntent = { txid: string; vout: number; amountSats: string; address: string; sequence: number };
export type BitcoinPsbtOutputIntent = { address: string; amountSats: string; role: "recipient" | "change" };
export type BitcoinPsbtIntent = {
  schema: "realdex.bitcoin-psbt-intent.v1";
  chainId: string;
  psbtBase64: string;
  transactionVersion: 1 | 2;
  locktime: number;
  feeSats: string;
  issuedAt: string;
  expiresAt: string;
  inputs: BitcoinPsbtInputIntent[];
  outputs: BitcoinPsbtOutputIntent[];
};

export type BitcoinPsbtInspection = {
  schema: "realdex.bitcoin-psbt-inspection.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  broadcastEnabled: false;
  chainId: string;
  transactionVersion: 1 | 2;
  locktime: number;
  inputCount: number;
  outputCount: number;
  totalInputSats: string;
  totalOutputSats: string;
  feeSats: string;
  signedVsizeMin: number;
  signedVsizeMax: number;
  feeRateMilliSatsPerVbyteMin: string;
  feeRateMilliSatsPerVbyteMax: string;
  psbtFingerprint: string;
  unsignedTransactionFingerprint: string;
  intentFingerprint: string;
  expiresAt: number;
  inspectedAt: number;
};

export type ParsedBitcoinTransaction = {
  version: number;
  locktime: number;
  inputs: Array<{ txid: string; vout: number; sequence: number }>;
  outputs: Array<{ amount: bigint; scriptPubKey: Uint8Array }>;
};

export type BitcoinPsbtMapEntry = { type: number; keyData: Uint8Array; value: Uint8Array };
export type ParsedBitcoinPsbtDocument = {
  bytes: Uint8Array;
  unsignedTransactionBytes: Uint8Array;
  transaction: ParsedBitcoinTransaction;
  globalMap: BitcoinPsbtMapEntry[];
  inputMaps: BitcoinPsbtMapEntry[][];
  outputMaps: BitcoinPsbtMapEntry[][];
};
const MAX_MONEY = 2_100_000_000_000_000n;
const MAX_PSBT_BYTES = 1_000_000;
const MAX_TTL_MS = 15 * 60_000;

export function inspectBitcoinPsbtIntent(value: unknown, now = Date.now()): BitcoinPsbtInspection {
  const intent = validateIntent(value, now);
  const psbtBytes = decodeCanonicalBase64(intent.psbtBase64);
  const reader = new Reader(psbtBytes);
  if (hexlify(reader.readBytes(5)) !== "0x70736274ff") throw new Error("BITCOIN_PSBT_MAGIC_INVALID");
  const globalMap = readMap(reader, "GLOBAL");
  const unsignedEntry = singleEntry(globalMap, 0x00, "BITCOIN_PSBT_UNSIGNED_TX_REQUIRED");
  if (unsignedEntry.keyData.length !== 0) throw new Error("BITCOIN_PSBT_UNSIGNED_TX_KEY_INVALID");
  const versionEntry = globalMap.find((entry) => entry.type === 0xfb);
  if (versionEntry) {
    if (versionEntry.keyData.length !== 0 || versionEntry.value.length !== 4 || readUint32(versionEntry.value) !== 0) throw new Error("BITCOIN_PSBT_VERSION_UNSUPPORTED");
  }
  if (globalMap.some((entry) => entry.type !== 0x00 && entry.type !== 0xfb)) throw new Error("BITCOIN_PSBT_GLOBAL_FIELD_UNSUPPORTED");

  const transaction = parseUnsignedTransaction(unsignedEntry.value);
  if (transaction.inputs.length !== intent.inputs.length || transaction.outputs.length !== intent.outputs.length) throw new Error("BITCOIN_PSBT_INTENT_COUNT_MISMATCH");
  if (transaction.version !== intent.transactionVersion || transaction.locktime !== intent.locktime) throw new Error("BITCOIN_PSBT_TRANSACTION_HEADER_MISMATCH");

  let totalInput = 0n;
  let witnessBytesMin = 0;
  let witnessBytesMax = 0;
  const seenOutpoints = new Set<string>();
  for (let index = 0; index < transaction.inputs.length; index += 1) {
    const map = readMap(reader, `INPUT_${index}`);
    assertUnsignedWitnessInputMap(map);
    const expected = intent.inputs[index];
    const actual = transaction.inputs[index];
    if (actual.txid !== expected.txid || actual.vout !== expected.vout || actual.sequence !== expected.sequence) throw new Error("BITCOIN_PSBT_INPUT_OUTPOINT_MISMATCH");
    const outpoint = `${actual.txid}:${actual.vout}`;
    if (seenOutpoints.has(outpoint)) throw new Error("BITCOIN_PSBT_DUPLICATE_INPUT");
    seenOutpoints.add(outpoint);
    const decodedAddress = decodeBitcoinAddress(intent.chainId, expected.address);
    if (!decodedAddress || (decodedAddress.type !== "p2wpkh" && decodedAddress.type !== "p2tr")) throw new Error("BITCOIN_PSBT_INPUT_ADDRESS_UNSUPPORTED");
    if (decodedAddress.type === "p2wpkh") { witnessBytesMin += 107; witnessBytesMax += 109; }
    else { witnessBytesMin += 66; witnessBytesMax += 67; }
    const witnessUtxo = parseTransactionOutput(singleEntry(map, 0x01, "BITCOIN_PSBT_WITNESS_UTXO_REQUIRED").value);
    const expectedAmount = parseSats(expected.amountSats, "BITCOIN_PSBT_INPUT_AMOUNT_INVALID");
    if (witnessUtxo.amount !== expectedAmount || !equalBytes(witnessUtxo.scriptPubKey, decodedAddress.scriptPubKey)) throw new Error("BITCOIN_PSBT_INPUT_UTXO_MISMATCH");
    totalInput += expectedAmount;
    if (totalInput > MAX_MONEY) throw new Error("BITCOIN_PSBT_TOTAL_INPUT_INVALID");
  }

  let totalOutput = 0n;
  for (let index = 0; index < transaction.outputs.length; index += 1) {
    const map = readMap(reader, `OUTPUT_${index}`);
    if (map.length !== 0) throw new Error("BITCOIN_PSBT_OUTPUT_METADATA_UNSUPPORTED");
    const expected = intent.outputs[index];
    const decodedAddress = decodeBitcoinAddress(intent.chainId, expected.address);
    if (!decodedAddress) throw new Error("BITCOIN_PSBT_OUTPUT_ADDRESS_INVALID");
    const expectedAmount = parseSats(expected.amountSats, "BITCOIN_PSBT_OUTPUT_AMOUNT_INVALID");
    const actual = transaction.outputs[index];
    if (actual.amount !== expectedAmount || !equalBytes(actual.scriptPubKey, decodedAddress.scriptPubKey)) throw new Error("BITCOIN_PSBT_OUTPUT_MISMATCH");
    totalOutput += expectedAmount;
    if (totalOutput > MAX_MONEY) throw new Error("BITCOIN_PSBT_TOTAL_OUTPUT_INVALID");
  }
  if (!reader.done()) throw new Error("BITCOIN_PSBT_TRAILING_DATA");
  const fee = parseSats(intent.feeSats, "BITCOIN_PSBT_FEE_INVALID");
  if (totalOutput > totalInput || totalInput - totalOutput !== fee) throw new Error("BITCOIN_PSBT_FEE_MISMATCH");
  const signedVsizeMin = Math.ceil((unsignedEntry.value.length * 4 + 2 + witnessBytesMin) / 4);
  const signedVsizeMax = Math.ceil((unsignedEntry.value.length * 4 + 2 + witnessBytesMax) / 4);

  return {
    schema: "realdex.bitcoin-psbt-inspection.v1",
    status: "verified-design-gate",
    executionEnabled: false,
    signingEnabled: false,
    broadcastEnabled: false,
    chainId: intent.chainId,
    transactionVersion: intent.transactionVersion,
    locktime: intent.locktime,
    inputCount: intent.inputs.length,
    outputCount: intent.outputs.length,
    totalInputSats: totalInput.toString(),
    totalOutputSats: totalOutput.toString(),
    feeSats: fee.toString(),
    signedVsizeMin,
    signedVsizeMax,
    feeRateMilliSatsPerVbyteMin: (fee * 1_000n / BigInt(signedVsizeMax)).toString(),
    feeRateMilliSatsPerVbyteMax: ((fee * 1_000n + BigInt(signedVsizeMin) - 1n) / BigInt(signedVsizeMin)).toString(),
    psbtFingerprint: sha256(psbtBytes),
    unsignedTransactionFingerprint: sha256(unsignedEntry.value),
    intentFingerprint: sha256(toUtf8Bytes(JSON.stringify(intent))),
    expiresAt: Date.parse(intent.expiresAt),
    inspectedAt: now
  };
}

export function parseBitcoinPsbtDocument(base64: string): ParsedBitcoinPsbtDocument {
  const bytes = decodeCanonicalBase64(base64);
  const reader = new Reader(bytes);
  if (hexlify(reader.readBytes(5)) !== "0x70736274ff") throw new Error("BITCOIN_PSBT_MAGIC_INVALID");
  const globalMap = readMap(reader, "GLOBAL");
  const unsignedEntry = singleEntry(globalMap, 0x00, "BITCOIN_PSBT_UNSIGNED_TX_REQUIRED");
  if (unsignedEntry.keyData.length !== 0) throw new Error("BITCOIN_PSBT_UNSIGNED_TX_KEY_INVALID");
  const versionEntry = globalMap.find((entry) => entry.type === 0xfb);
  if (versionEntry && (versionEntry.keyData.length !== 0 || versionEntry.value.length !== 4 || readUint32(versionEntry.value) !== 0)) throw new Error("BITCOIN_PSBT_VERSION_UNSUPPORTED");
  if (globalMap.some((entry) => entry.type !== 0x00 && entry.type !== 0xfb)) throw new Error("BITCOIN_PSBT_GLOBAL_FIELD_UNSUPPORTED");
  const transaction = parseUnsignedTransaction(unsignedEntry.value);
  const inputMaps = transaction.inputs.map((_, index) => readMap(reader, `INPUT_${index}`));
  const outputMaps = transaction.outputs.map((_, index) => readMap(reader, `OUTPUT_${index}`));
  if (!reader.done()) throw new Error("BITCOIN_PSBT_TRAILING_DATA");
  return { bytes, unsignedTransactionBytes: unsignedEntry.value, transaction, globalMap, inputMaps, outputMaps };
}

function validateIntent(value: unknown, now: number): BitcoinPsbtIntent {
  if (!value || typeof value !== "object") throw new Error("BITCOIN_PSBT_INTENT_OBJECT_REQUIRED");
  const intent = value as Record<string, unknown>;
  assertExactKeys(intent, ["schema", "chainId", "psbtBase64", "transactionVersion", "locktime", "feeSats", "issuedAt", "expiresAt", "inputs", "outputs"], "BITCOIN_PSBT_INTENT_FIELDS_INVALID");
  if (intent.schema !== "realdex.bitcoin-psbt-intent.v1" || typeof intent.chainId !== "string" || typeof intent.psbtBase64 !== "string") throw new Error("BITCOIN_PSBT_INTENT_IDENTITY_INVALID");
  if (intent.transactionVersion !== 1 && intent.transactionVersion !== 2) throw new Error("BITCOIN_PSBT_TRANSACTION_VERSION_INVALID");
  if (!Number.isInteger(intent.locktime) || Number(intent.locktime) < 0 || Number(intent.locktime) > 0xffff_ffff) throw new Error("BITCOIN_PSBT_LOCKTIME_INVALID");
  if (typeof intent.feeSats !== "string") throw new Error("BITCOIN_PSBT_FEE_INVALID");
  const issuedAt = parseCanonicalDate(intent.issuedAt, "BITCOIN_PSBT_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalDate(intent.expiresAt, "BITCOIN_PSBT_EXPIRES_AT_INVALID");
  if (issuedAt > now + 60_000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) throw new Error("BITCOIN_PSBT_INTENT_EXPIRED_OR_TTL_INVALID");
  if (!Array.isArray(intent.inputs) || intent.inputs.length < 1 || intent.inputs.length > 64) throw new Error("BITCOIN_PSBT_INPUT_COUNT_INVALID");
  if (!Array.isArray(intent.outputs) || intent.outputs.length < 1 || intent.outputs.length > 64) throw new Error("BITCOIN_PSBT_OUTPUT_COUNT_INVALID");
  const inputs = intent.inputs.map((item) => validateInputIntent(item));
  const outputs = intent.outputs.map((item) => validateOutputIntent(item));
  if (!outputs.some((output) => output.role === "recipient")) throw new Error("BITCOIN_PSBT_RECIPIENT_REQUIRED");
  parseSats(intent.feeSats, "BITCOIN_PSBT_FEE_INVALID");
  return { schema: "realdex.bitcoin-psbt-intent.v1", chainId: intent.chainId, psbtBase64: intent.psbtBase64, transactionVersion: intent.transactionVersion, locktime: Number(intent.locktime), feeSats: intent.feeSats, issuedAt: intent.issuedAt as string, expiresAt: intent.expiresAt as string, inputs, outputs };
}

function validateInputIntent(value: unknown): BitcoinPsbtInputIntent {
  if (!value || typeof value !== "object") throw new Error("BITCOIN_PSBT_INPUT_INTENT_INVALID");
  const input = value as Record<string, unknown>;
  assertExactKeys(input, ["txid", "vout", "amountSats", "address", "sequence"], "BITCOIN_PSBT_INPUT_INTENT_INVALID");
  if (typeof input.txid !== "string" || !/^[0-9a-f]{64}$/.test(input.txid) || /^0+$/.test(input.txid) || !Number.isInteger(input.vout) || Number(input.vout) < 0 || Number(input.vout) > 0xffff_ffff || typeof input.amountSats !== "string" || typeof input.address !== "string" || !Number.isInteger(input.sequence) || Number(input.sequence) < 0 || Number(input.sequence) > 0xffff_ffff) throw new Error("BITCOIN_PSBT_INPUT_INTENT_INVALID");
  parseSats(input.amountSats, "BITCOIN_PSBT_INPUT_AMOUNT_INVALID");
  return input as BitcoinPsbtInputIntent;
}

function validateOutputIntent(value: unknown): BitcoinPsbtOutputIntent {
  if (!value || typeof value !== "object") throw new Error("BITCOIN_PSBT_OUTPUT_INTENT_INVALID");
  const output = value as Record<string, unknown>;
  assertExactKeys(output, ["address", "amountSats", "role"], "BITCOIN_PSBT_OUTPUT_INTENT_INVALID");
  if (typeof output.address !== "string" || typeof output.amountSats !== "string" || (output.role !== "recipient" && output.role !== "change")) throw new Error("BITCOIN_PSBT_OUTPUT_INTENT_INVALID");
  parseSats(output.amountSats, "BITCOIN_PSBT_OUTPUT_AMOUNT_INVALID");
  return output as BitcoinPsbtOutputIntent;
}

function parseUnsignedTransaction(bytes: Uint8Array): ParsedBitcoinTransaction {
  const reader = new Reader(bytes);
  const version = reader.readUint32();
  if (version !== 1 && version !== 2) throw new Error("BITCOIN_PSBT_TRANSACTION_VERSION_INVALID");
  const inputCount = reader.readCompactSize();
  if (inputCount < 1 || inputCount > 64) throw new Error("BITCOIN_PSBT_UNSIGNED_INPUT_COUNT_INVALID");
  const inputs: ParsedBitcoinTransaction["inputs"] = [];
  for (let index = 0; index < inputCount; index += 1) {
    const txid = hexlify(reader.readBytes(32).slice().reverse()).slice(2);
    const vout = reader.readUint32();
    const scriptLength = reader.readCompactSize();
    if (scriptLength !== 0) throw new Error("BITCOIN_PSBT_UNSIGNED_SCRIPTSIG_PRESENT");
    const sequence = reader.readUint32();
    inputs.push({ txid, vout, sequence });
  }
  const outputCount = reader.readCompactSize();
  if (outputCount < 1 || outputCount > 64) throw new Error("BITCOIN_PSBT_UNSIGNED_OUTPUT_COUNT_INVALID");
  const outputs: ParsedBitcoinTransaction["outputs"] = [];
  for (let index = 0; index < outputCount; index += 1) outputs.push(parseTransactionOutputFromReader(reader));
  const locktime = reader.readUint32();
  if (!reader.done()) throw new Error("BITCOIN_PSBT_UNSIGNED_TX_TRAILING_DATA");
  return { version, locktime, inputs, outputs };
}

function assertUnsignedWitnessInputMap(map: BitcoinPsbtMapEntry[]): void {
  for (const entry of map) {
    if ([0x02, 0x07, 0x08, 0x13, 0x14].includes(entry.type)) throw new Error("BITCOIN_PSBT_ALREADY_SIGNED");
    if (entry.type === 0x00) throw new Error("BITCOIN_PSBT_NON_WITNESS_INPUT_UNSUPPORTED");
    if (entry.type === 0x01) {
      if (entry.keyData.length !== 0) throw new Error("BITCOIN_PSBT_WITNESS_UTXO_KEY_INVALID");
      continue;
    }
    if (entry.type === 0x03) {
      if (entry.keyData.length !== 0 || entry.value.length !== 4 || readUint32(entry.value) !== 1) throw new Error("BITCOIN_PSBT_SIGHASH_UNSAFE");
      continue;
    }
    if (entry.type === 0x06) {
      if ((entry.keyData.length !== 33 && entry.keyData.length !== 65) || entry.value.length < 4 || entry.value.length % 4 !== 0) throw new Error("BITCOIN_PSBT_BIP32_DERIVATION_INVALID");
      continue;
    }
    throw new Error("BITCOIN_PSBT_INPUT_FIELD_UNSUPPORTED");
  }
  if (map.filter((entry) => entry.type === 0x01).length !== 1) throw new Error("BITCOIN_PSBT_WITNESS_UTXO_REQUIRED");
}

function parseTransactionOutput(bytes: Uint8Array): { amount: bigint; scriptPubKey: Uint8Array } {
  const reader = new Reader(bytes);
  const output = parseTransactionOutputFromReader(reader);
  if (!reader.done()) throw new Error("BITCOIN_PSBT_WITNESS_UTXO_INVALID");
  return output;
}

function parseTransactionOutputFromReader(reader: Reader): { amount: bigint; scriptPubKey: Uint8Array } {
  const amount = reader.readUint64();
  if (amount > MAX_MONEY) throw new Error("BITCOIN_PSBT_AMOUNT_OUT_OF_RANGE");
  const scriptLength = reader.readCompactSize();
  if (scriptLength < 2 || scriptLength > 10_000) throw new Error("BITCOIN_PSBT_SCRIPT_LENGTH_INVALID");
  return { amount, scriptPubKey: reader.readBytes(scriptLength) };
}

function readMap(reader: Reader, scope: string): BitcoinPsbtMapEntry[] {
  const entries: BitcoinPsbtMapEntry[] = [];
  const keys = new Set<string>();
  while (true) {
    const keyLength = reader.readCompactSize();
    if (keyLength === 0) return entries;
    if (keyLength > 1_024 || entries.length >= 256) throw new Error(`BITCOIN_PSBT_${scope}_MAP_BOUNDS_EXCEEDED`);
    const key = reader.readBytes(keyLength);
    const keyHex = hexlify(key);
    if (keys.has(keyHex)) throw new Error("BITCOIN_PSBT_DUPLICATE_KEY");
    keys.add(keyHex);
    const keyReader = new Reader(key);
    const type = keyReader.readCompactSize();
    const keyData = keyReader.readBytes(keyReader.remaining());
    const valueLength = reader.readCompactSize();
    if (valueLength > MAX_PSBT_BYTES) throw new Error(`BITCOIN_PSBT_${scope}_VALUE_TOO_LARGE`);
    entries.push({ type, keyData, value: reader.readBytes(valueLength) });
  }
}

function singleEntry(map: BitcoinPsbtMapEntry[], type: number, error: string): BitcoinPsbtMapEntry {
  const entries = map.filter((entry) => entry.type === type);
  if (entries.length !== 1) throw new Error(error);
  return entries[0];
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length < 8 || value.length > 1_400_000 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("BITCOIN_PSBT_BASE64_INVALID");
  try {
    const bytes = decodeBase64(value);
    if (bytes.length > MAX_PSBT_BYTES || encodeBase64(bytes) !== value) throw new Error("BITCOIN_PSBT_BASE64_INVALID");
    return bytes;
  } catch { throw new Error("BITCOIN_PSBT_BASE64_INVALID"); }
}

function parseSats(value: string, error: string): bigint {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new Error(error);
  const amount = BigInt(value);
  if (amount > MAX_MONEY) throw new Error(error);
  return amount;
}

function parseCanonicalDate(value: unknown, error: string): number {
  if (typeof value !== "string") throw new Error(error);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(error);
  return parsed;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], error: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(error);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readUint32(bytes: Uint8Array): number {
  if (bytes.length !== 4) throw new Error("BITCOIN_PSBT_UINT32_INVALID");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length > MAX_PSBT_BYTES) throw new Error("BITCOIN_PSBT_TOO_LARGE");
  }
  done(): boolean { return this.offset === this.bytes.length; }
  remaining(): number { return this.bytes.length - this.offset; }
  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining()) throw new Error("BITCOIN_PSBT_TRUNCATED");
    const value = this.bytes.slice(this.offset, this.offset + length); this.offset += length; return value;
  }
  readUint32(): number { return readUint32(this.readBytes(4)); }
  readUint64(): bigint {
    const value = new DataView(this.readBytes(8).buffer);
    return value.getBigUint64(0, true);
  }
  readCompactSize(): number {
    const prefix = this.readBytes(1)[0];
    if (prefix < 0xfd) return prefix;
    if (prefix === 0xfd) {
      const bytes = this.readBytes(2); const value = new DataView(bytes.buffer).getUint16(0, true);
      if (value < 0xfd) throw new Error("BITCOIN_PSBT_COMPACT_SIZE_NON_MINIMAL"); return value;
    }
    if (prefix === 0xfe) {
      const value = this.readUint32(); if (value <= 0xffff) throw new Error("BITCOIN_PSBT_COMPACT_SIZE_NON_MINIMAL"); return value;
    }
    const bytes = this.readBytes(8); const value = new DataView(bytes.buffer).getBigUint64(0, true);
    if (value <= 0xffff_ffffn) throw new Error("BITCOIN_PSBT_COMPACT_SIZE_NON_MINIMAL");
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("BITCOIN_PSBT_COMPACT_SIZE_TOO_LARGE"); return Number(value);
  }
}
