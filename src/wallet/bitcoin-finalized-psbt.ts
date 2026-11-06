import { getBytes, hexlify, sha256 } from "ethers";
import { decodeBitcoinAddress } from "./bitcoin-address";
import { parseBitcoinPsbtDocument, type BitcoinPsbtInspection, type BitcoinPsbtIntent, type BitcoinPsbtMapEntry } from "./bitcoin-psbt";
import { verifySignedBitcoinPsbt, type BitcoinSignedPsbtEnvelope, type VerifiedBitcoinSignedPsbt } from "./bitcoin-signed-psbt";
import type { VerifiedBitcoinPsbtUtxoQuorum } from "./bitcoin-utxo-quorum";
import type { VerifiedBitcoinFeeSafety } from "./bitcoin-fee-policy";
import type { VerifiedBitcoinReadPolicy } from "./bitcoin-read-policy";

export type BitcoinFinalizedPsbtEnvelope = {
  schema: "realdex.bitcoin-finalized-psbt.v1";
  finalizedPsbtBase64: string;
  signedPsbtFingerprint: string;
  issuedAt: string;
  expiresAt: string;
};

export type VerifiedBitcoinFinalizedPsbt = {
  schema: "realdex.verified-bitcoin-finalized-psbt.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  finalizationEnabled: false;
  transactionExtractionEnabled: false;
  broadcastEnabled: false;
  chainId: string;
  originalPsbtFingerprint: string;
  signedPsbtFingerprint: string;
  finalizedPsbtFingerprint: string;
  unsignedTransactionFingerprint: string;
  finalTransactionFingerprint: string;
  txid: string;
  wtxid: string;
  inputCount: number;
  outputCount: number;
  virtualSize: number;
  feeSats: string;
  feeRateMilliSatsPerVbyte: string;
  expiresAt: number;
  verifiedAt: number;
};

const MAX_FINALIZED_TTL_MS = 5 * 60_000;

export function verifyFinalizedBitcoinPsbt(
  value: unknown,
  signedEnvelopeValue: unknown,
  intent: BitcoinPsbtIntent,
  inspection: BitcoinPsbtInspection,
  utxo: VerifiedBitcoinPsbtUtxoQuorum,
  fee: VerifiedBitcoinFeeSafety,
  readPolicy: VerifiedBitcoinReadPolicy,
  signedVerification: VerifiedBitcoinSignedPsbt,
  now = Date.now()
): VerifiedBitcoinFinalizedPsbt {
  const envelope = validateEnvelope(value, now);
  const freshSigned = verifySignedBitcoinPsbt(signedEnvelopeValue, intent, inspection, utxo, fee, readPolicy, now);
  if (!sameSignedVerification(freshSigned, signedVerification) || envelope.signedPsbtFingerprint !== freshSigned.signedPsbtFingerprint) throw new Error("BITCOIN_FINALIZED_PSBT_SIGNED_BINDING_INVALID");
  const signedEnvelope = signedEnvelopeValue as BitcoinSignedPsbtEnvelope;
  const signed = parseBitcoinPsbtDocument(signedEnvelope.signedPsbtBase64);
  const finalized = parseBitcoinPsbtDocument(envelope.finalizedPsbtBase64);
  if (!equalBytes(signed.unsignedTransactionBytes, finalized.unsignedTransactionBytes)) throw new Error("BITCOIN_FINALIZED_PSBT_TRANSACTION_CHANGED");
  assertMapEqual(signed.globalMap, finalized.globalMap, "BITCOIN_FINALIZED_PSBT_GLOBAL_CHANGED");
  if (signed.outputMaps.length !== finalized.outputMaps.length) throw new Error("BITCOIN_FINALIZED_PSBT_OUTPUT_CHANGED");
  finalized.outputMaps.forEach((map, index) => assertMapEqual(signed.outputMaps[index], map, "BITCOIN_FINALIZED_PSBT_OUTPUT_CHANGED"));

  const witnesses: Uint8Array[] = [];
  finalized.inputMaps.forEach((finalMap, index) => {
    const signedMap = signed.inputMaps[index];
    if (finalMap.length !== 2 || finalMap.some((entry) => entry.type !== 0x01 && entry.type !== 0x08)) throw new Error("BITCOIN_FINALIZED_PSBT_INPUT_FIELDS_INVALID");
    const finalUtxo = single(finalMap, 0x01, "BITCOIN_FINALIZED_PSBT_WITNESS_UTXO_REQUIRED");
    const signedUtxo = single(signedMap, 0x01, "BITCOIN_FINALIZED_PSBT_WITNESS_UTXO_REQUIRED");
    if (finalUtxo.keyData.length !== 0 || !equalBytes(finalUtxo.value, signedUtxo.value)) throw new Error("BITCOIN_FINALIZED_PSBT_WITNESS_UTXO_CHANGED");
    const finalWitness = single(finalMap, 0x08, "BITCOIN_FINALIZED_PSBT_WITNESS_REQUIRED");
    if (finalWitness.keyData.length !== 0) throw new Error("BITCOIN_FINALIZED_PSBT_WITNESS_KEY_INVALID");
    const stack = parseWitness(finalWitness.value);
    const decoded = decodeBitcoinAddress(intent.chainId, intent.inputs[index].address);
    if (!decoded || (decoded.type !== "p2wpkh" && decoded.type !== "p2tr")) throw new Error("BITCOIN_FINALIZED_PSBT_INPUT_UNSUPPORTED");
    if (decoded.type === "p2wpkh") {
      const signature = single(signedMap, 0x02, "BITCOIN_FINALIZED_PSBT_SIGNED_SIGNATURE_REQUIRED");
      if (stack.length !== 2 || !equalBytes(stack[0], signature.value) || !equalBytes(stack[1], signature.keyData)) throw new Error("BITCOIN_FINALIZED_PSBT_WITNESS_MISMATCH");
    } else {
      const signature = single(signedMap, 0x13, "BITCOIN_FINALIZED_PSBT_SIGNED_SIGNATURE_REQUIRED");
      if (stack.length !== 1 || !equalBytes(stack[0], signature.value)) throw new Error("BITCOIN_FINALIZED_PSBT_WITNESS_MISMATCH");
    }
    witnesses.push(finalWitness.value);
  });

  const base = finalized.unsignedTransactionBytes;
  const finalTransaction = concat([base.slice(0, 4), Uint8Array.of(0, 1), base.slice(4, -4), ...witnesses, base.slice(-4)]);
  const transactionId = displayHash(doubleSha(base));
  const witnessTransactionId = displayHash(doubleSha(finalTransaction));
  const weight = base.length * 3 + finalTransaction.length;
  const virtualSize = Math.ceil(weight / 4);
  if (virtualSize < inspection.signedVsizeMin || virtualSize > inspection.signedVsizeMax) throw new Error("BITCOIN_FINALIZED_PSBT_VSIZE_OUT_OF_RANGE");
  const feeSats = BigInt(inspection.feeSats);

  return {
    schema: "realdex.verified-bitcoin-finalized-psbt.v1", status: "verified-design-gate",
    executionEnabled: false, signingEnabled: false, finalizationEnabled: false, transactionExtractionEnabled: false, broadcastEnabled: false,
    chainId: inspection.chainId, originalPsbtFingerprint: inspection.psbtFingerprint, signedPsbtFingerprint: freshSigned.signedPsbtFingerprint,
    finalizedPsbtFingerprint: sha256(finalized.bytes), unsignedTransactionFingerprint: inspection.unsignedTransactionFingerprint,
    finalTransactionFingerprint: sha256(finalTransaction), txid: transactionId, wtxid: witnessTransactionId,
    inputCount: inspection.inputCount, outputCount: inspection.outputCount, virtualSize, feeSats: inspection.feeSats,
    feeRateMilliSatsPerVbyte: (feeSats * 1_000n / BigInt(virtualSize)).toString(), expiresAt: Date.parse(envelope.expiresAt), verifiedAt: now
  };
}

function validateEnvelope(value: unknown, now: number): BitcoinFinalizedPsbtEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BITCOIN_FINALIZED_PSBT_ENVELOPE_INVALID");
  const root = value as Record<string, unknown>;
  const expected = ["schema", "finalizedPsbtBase64", "signedPsbtFingerprint", "issuedAt", "expiresAt"].sort();
  const actual = Object.keys(root).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) || root.schema !== "realdex.bitcoin-finalized-psbt.v1" || typeof root.finalizedPsbtBase64 !== "string" || typeof root.signedPsbtFingerprint !== "string" || !/^0x[0-9a-f]{64}$/.test(root.signedPsbtFingerprint)) throw new Error("BITCOIN_FINALIZED_PSBT_ENVELOPE_INVALID");
  const issuedAt = canonicalDate(root.issuedAt, "BITCOIN_FINALIZED_PSBT_ISSUED_AT_INVALID");
  const expiresAt = canonicalDate(root.expiresAt, "BITCOIN_FINALIZED_PSBT_EXPIRES_AT_INVALID");
  if (issuedAt > now + 60_000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_FINALIZED_TTL_MS) throw new Error("BITCOIN_FINALIZED_PSBT_ENVELOPE_EXPIRED_OR_TTL_INVALID");
  return root as BitcoinFinalizedPsbtEnvelope;
}

function sameSignedVerification(left: VerifiedBitcoinSignedPsbt, right: VerifiedBitcoinSignedPsbt): boolean {
  return right?.schema === "realdex.verified-bitcoin-signed-psbt.v1" && right.status === "verified-design-gate" && right.executionEnabled === false && right.signingEnabled === false && right.finalizationEnabled === false && right.broadcastEnabled === false && left.chainId === right.chainId && left.originalPsbtFingerprint === right.originalPsbtFingerprint && left.signedPsbtFingerprint === right.signedPsbtFingerprint && left.unsignedTransactionFingerprint === right.unsignedTransactionFingerprint && left.intentFingerprint === right.intentFingerprint && left.readPolicyPayloadHash === right.readPolicyPayloadHash && left.inputCount === right.inputCount && left.p2wpkhSignatureCount === right.p2wpkhSignatureCount && left.p2trSignatureCount === right.p2trSignatureCount && left.expiresAt === right.expiresAt && right.verifiedAt <= left.verifiedAt;
}

function parseWitness(value: Uint8Array): Uint8Array[] {
  const reader = new Reader(value);
  const count = reader.compactSize();
  if (count < 1 || count > 2) throw new Error("BITCOIN_FINALIZED_PSBT_WITNESS_STACK_INVALID");
  const items: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = reader.compactSize();
    if (length < 1 || length > 520) throw new Error("BITCOIN_FINALIZED_PSBT_WITNESS_ITEM_INVALID");
    items.push(reader.bytes(length));
  }
  if (!reader.done()) throw new Error("BITCOIN_FINALIZED_PSBT_WITNESS_TRAILING_DATA");
  return items;
}

function single(map: BitcoinPsbtMapEntry[], type: number, error: string): BitcoinPsbtMapEntry { const entries = map.filter((entry) => entry.type === type); if (entries.length !== 1) throw new Error(error); return entries[0]; }
function assertMapEqual(left: BitcoinPsbtMapEntry[], right: BitcoinPsbtMapEntry[], error: string): void { const normalize = (entries: BitcoinPsbtMapEntry[]) => entries.map((entry) => `${entry.type}:${hexlify(entry.keyData)}:${hexlify(entry.value)}`).sort(); const a = normalize(left); const b = normalize(right); if (a.length !== b.length || a.some((value, index) => value !== b[index])) throw new Error(error); }
function concat(parts: readonly Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function doubleSha(value: Uint8Array): Uint8Array { return getBytes(sha256(getBytes(sha256(value)))); }
function displayHash(value: Uint8Array): string { return hexlify(value.slice().reverse()).slice(2); }
function equalBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function canonicalDate(value: unknown, error: string): number { if (typeof value !== "string") throw new Error(error); const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(error); return parsed; }

class Reader {
  private offset = 0;
  constructor(private readonly value: Uint8Array) {}
  done(): boolean { return this.offset === this.value.length; }
  bytes(length: number): Uint8Array { if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.value.length) throw new Error("BITCOIN_FINALIZED_PSBT_WITNESS_TRUNCATED"); const result = this.value.slice(this.offset, this.offset + length); this.offset += length; return result; }
  compactSize(): number { const prefix = this.bytes(1)[0]; if (prefix < 0xfd) return prefix; if (prefix === 0xfd) { const bytes = this.bytes(2); const result = new DataView(bytes.buffer).getUint16(0, true); if (result < 0xfd) throw new Error("BITCOIN_FINALIZED_PSBT_COMPACT_SIZE_NON_MINIMAL"); return result; } if (prefix === 0xfe) { const bytes = this.bytes(4); const result = new DataView(bytes.buffer).getUint32(0, true); if (result <= 0xffff) throw new Error("BITCOIN_FINALIZED_PSBT_COMPACT_SIZE_NON_MINIMAL"); return result; } throw new Error("BITCOIN_FINALIZED_PSBT_COMPACT_SIZE_TOO_LARGE"); }
}
