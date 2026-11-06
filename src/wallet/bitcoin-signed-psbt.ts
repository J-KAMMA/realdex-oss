import { concat as ethersConcat, getBytes, hexlify, ripemd160, sha256 } from "ethers";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { decodeBitcoinAddress } from "./bitcoin-address";
import {
  inspectBitcoinPsbtIntent,
  parseBitcoinPsbtDocument,
  type BitcoinPsbtInspection,
  type BitcoinPsbtIntent,
  type BitcoinPsbtMapEntry,
  type ParsedBitcoinPsbtDocument
} from "./bitcoin-psbt";
import type { VerifiedBitcoinPsbtUtxoQuorum } from "./bitcoin-utxo-quorum";
import type { VerifiedBitcoinFeeSafety } from "./bitcoin-fee-policy";
import { revalidateBitcoinReadPolicy, type VerifiedBitcoinReadPolicy } from "./bitcoin-read-policy";

export type BitcoinSignedPsbtEnvelope = {
  schema: "realdex.bitcoin-signed-psbt.v1";
  signedPsbtBase64: string;
  originalPsbtFingerprint: string;
  issuedAt: string;
  expiresAt: string;
};

export type VerifiedBitcoinSignedPsbt = {
  schema: "realdex.verified-bitcoin-signed-psbt.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  finalizationEnabled: false;
  broadcastEnabled: false;
  chainId: string;
  originalPsbtFingerprint: string;
  signedPsbtFingerprint: string;
  unsignedTransactionFingerprint: string;
  intentFingerprint: string;
  inputCount: number;
  p2wpkhSignatureCount: number;
  p2trSignatureCount: number;
  readPolicyPayloadHash: string;
  expiresAt: number;
  verifiedAt: number;
};

const MAX_ENVELOPE_TTL_MS = 5 * 60_000;

export function verifySignedBitcoinPsbt(
  value: unknown,
  intent: BitcoinPsbtIntent,
  inspection: BitcoinPsbtInspection,
  utxo: VerifiedBitcoinPsbtUtxoQuorum,
  fee: VerifiedBitcoinFeeSafety,
  readPolicy: VerifiedBitcoinReadPolicy,
  now = Date.now()
): VerifiedBitcoinSignedPsbt {
  const envelope = validateEnvelope(value, now);
  const fresh = inspectBitcoinPsbtIntent(intent, now);
  if (!sameInspection(fresh, inspection) || envelope.originalPsbtFingerprint !== fresh.psbtFingerprint) throw new Error("BITCOIN_SIGNED_PSBT_ORIGINAL_BINDING_INVALID");
  assertSafetyBindings(fresh, inspection, utxo, fee, revalidateBitcoinReadPolicy(readPolicy, now), now);

  const original = parseBitcoinPsbtDocument(intent.psbtBase64);
  const signed = parseBitcoinPsbtDocument(envelope.signedPsbtBase64);
  if (!equalBytes(original.unsignedTransactionBytes, signed.unsignedTransactionBytes)) throw new Error("BITCOIN_SIGNED_PSBT_TRANSACTION_CHANGED");
  assertMapEqual(original.globalMap, signed.globalMap, "BITCOIN_SIGNED_PSBT_GLOBAL_CHANGED");
  if (signed.outputMaps.length !== original.outputMaps.length) throw new Error("BITCOIN_SIGNED_PSBT_OUTPUT_CHANGED");
  signed.outputMaps.forEach((map, index) => assertMapEqual(original.outputMaps[index], map, "BITCOIN_SIGNED_PSBT_OUTPUT_CHANGED"));

  let p2wpkhSignatureCount = 0;
  let p2trSignatureCount = 0;
  for (let index = 0; index < signed.inputMaps.length; index += 1) {
    const originalMap = original.inputMaps[index];
    const signedMap = signed.inputMaps[index];
    assertMapEqual(originalMap, signedMap.filter((entry) => entry.type !== 0x02 && entry.type !== 0x13), "BITCOIN_SIGNED_PSBT_METADATA_CHANGED");
    const decoded = decodeBitcoinAddress(intent.chainId, intent.inputs[index].address);
    if (!decoded || (decoded.type !== "p2wpkh" && decoded.type !== "p2tr")) throw new Error("BITCOIN_SIGNED_PSBT_INPUT_UNSUPPORTED");
    if (decoded.type === "p2wpkh") {
      verifyP2wpkhSignature(signed, signedMap, decoded.scriptPubKey.slice(2), index);
      p2wpkhSignatureCount += 1;
    } else {
      verifyP2trSignature(signed, signedMap, decoded.scriptPubKey.slice(2), index, intent);
      p2trSignatureCount += 1;
    }
  }

  return {
    schema: "realdex.verified-bitcoin-signed-psbt.v1", status: "verified-design-gate",
    executionEnabled: false, signingEnabled: false, finalizationEnabled: false, broadcastEnabled: false,
    chainId: fresh.chainId, originalPsbtFingerprint: fresh.psbtFingerprint,
    signedPsbtFingerprint: sha256(signed.bytes), unsignedTransactionFingerprint: fresh.unsignedTransactionFingerprint,
    intentFingerprint: fresh.intentFingerprint, inputCount: fresh.inputCount, p2wpkhSignatureCount, p2trSignatureCount,
    readPolicyPayloadHash: readPolicy.payloadHash, expiresAt: Date.parse(envelope.expiresAt), verifiedAt: now
  };
}

function verifyP2wpkhSignature(document: ParsedBitcoinPsbtDocument, map: BitcoinPsbtMapEntry[], program: Uint8Array, index: number): void {
  const signatures = map.filter((entry) => entry.type === 0x02);
  if (signatures.length !== 1 || map.some((entry) => entry.type === 0x13)) throw new Error("BITCOIN_SIGNED_PSBT_SIGNATURE_SET_INVALID");
  const entry = signatures[0];
  if (entry.keyData.length !== 33 || (entry.keyData[0] !== 0x02 && entry.keyData[0] !== 0x03) || entry.value.length < 9 || entry.value.at(-1) !== 0x01) throw new Error("BITCOIN_SIGNED_PSBT_ECDSA_ENCODING_INVALID");
  if (!equalBytes(getBytes(ripemd160(sha256(entry.keyData))), program)) throw new Error("BITCOIN_SIGNED_PSBT_PUBKEY_MISMATCH");
  let signature: ReturnType<typeof secp256k1.Signature.fromDER>;
  try { signature = secp256k1.Signature.fromDER(entry.value.slice(0, -1)); } catch { throw new Error("BITCOIN_SIGNED_PSBT_ECDSA_ENCODING_INVALID"); }
  if (signature.hasHighS()) throw new Error("BITCOIN_SIGNED_PSBT_ECDSA_HIGH_S");
  const digest = bip143Digest(document, index, program);
  if (!secp256k1.verify(signature, digest, entry.keyData, { lowS: true })) throw new Error("BITCOIN_SIGNED_PSBT_SIGNATURE_INVALID");
}

function verifyP2trSignature(document: ParsedBitcoinPsbtDocument, map: BitcoinPsbtMapEntry[], program: Uint8Array, index: number, intent: BitcoinPsbtIntent): void {
  const signatures = map.filter((entry) => entry.type === 0x13);
  if (signatures.length !== 1 || map.some((entry) => entry.type === 0x02)) throw new Error("BITCOIN_SIGNED_PSBT_SIGNATURE_SET_INVALID");
  const entry = signatures[0];
  if (entry.keyData.length !== 0 || (entry.value.length !== 64 && entry.value.length !== 65)) throw new Error("BITCOIN_SIGNED_PSBT_SCHNORR_ENCODING_INVALID");
  const hashType = entry.value.length === 64 ? 0 : entry.value[64];
  if (hashType !== 0 && hashType !== 1) throw new Error("BITCOIN_SIGNED_PSBT_SIGHASH_UNSAFE");
  if (entry.value.length === 65 && hashType === 0) throw new Error("BITCOIN_SIGNED_PSBT_SCHNORR_ENCODING_INVALID");
  const declared = map.find((item) => item.type === 0x03);
  if (declared && (declared.value.length !== 4 || readU32(declared.value) !== hashType)) throw new Error("BITCOIN_SIGNED_PSBT_SIGHASH_MISMATCH");
  const digest = bip341KeyPathDigest(document, intent, index, hashType);
  if (!schnorr.verify(entry.value.slice(0, 64), digest, program)) throw new Error("BITCOIN_SIGNED_PSBT_SIGNATURE_INVALID");
}

export function bitcoinSignatureDigest(document: ParsedBitcoinPsbtDocument, intent: BitcoinPsbtIntent, index: number, hashType: 0 | 1): Uint8Array {
  const decoded = decodeBitcoinAddress(intent.chainId, intent.inputs[index]?.address ?? "");
  if (!decoded) throw new Error("BITCOIN_SIGNED_PSBT_INPUT_UNSUPPORTED");
  if (decoded.type === "p2wpkh" && hashType === 1) return bip143Digest(document, index, decoded.scriptPubKey.slice(2));
  if (decoded.type === "p2tr") return bip341KeyPathDigest(document, intent, index, hashType);
  throw new Error("BITCOIN_SIGNED_PSBT_INPUT_UNSUPPORTED");
}

function bip143Digest(document: ParsedBitcoinPsbtDocument, index: number, program: Uint8Array): Uint8Array {
  const tx = document.transaction;
  const input = tx.inputs[index];
  const witness = witnessUtxo(document.inputMaps[index]);
  const hashPrevouts = doubleSha(concat(tx.inputs.map((item) => concat([reverse(getBytes(`0x${item.txid}`)), u32(item.vout)]))));
  const hashSequence = doubleSha(concat(tx.inputs.map((item) => u32(item.sequence))));
  const hashOutputs = doubleSha(concat(tx.outputs.map(serializeOutput)));
  const scriptCode = concat([Uint8Array.of(0x19, 0x76, 0xa9, 0x14), program, Uint8Array.of(0x88, 0xac)]);
  return doubleSha(concat([u32(tx.version), hashPrevouts, hashSequence, reverse(getBytes(`0x${input.txid}`)), u32(input.vout), scriptCode, u64(witness.amount), u32(input.sequence), hashOutputs, u32(tx.locktime), u32(1)]));
}

function bip341KeyPathDigest(document: ParsedBitcoinPsbtDocument, intent: BitcoinPsbtIntent, index: number, hashType: number): Uint8Array {
  const tx = document.transaction;
  const prevouts = concat(tx.inputs.map((item) => concat([reverse(getBytes(`0x${item.txid}`)), u32(item.vout)])));
  const amounts = concat(intent.inputs.map((item) => u64(BigInt(item.amountSats))));
  const scripts = concat(intent.inputs.map((item) => {
    const decoded = decodeBitcoinAddress(intent.chainId, item.address);
    if (!decoded) throw new Error("BITCOIN_SIGNED_PSBT_INPUT_UNSUPPORTED");
    return concat([compactSize(decoded.scriptPubKey.length), decoded.scriptPubKey]);
  }));
  const sequences = concat(tx.inputs.map((item) => u32(item.sequence)));
  const outputs = concat(tx.outputs.map(serializeOutput));
  const message = concat([Uint8Array.of(hashType), u32(tx.version), u32(tx.locktime), getBytes(sha256(prevouts)), getBytes(sha256(amounts)), getBytes(sha256(scripts)), getBytes(sha256(sequences)), getBytes(sha256(outputs)), Uint8Array.of(0), u32(index)]);
  const tag = getBytes(sha256(new TextEncoder().encode("TapSighash")));
  return getBytes(sha256(concat([tag, tag, Uint8Array.of(0), message])));
}

function assertSafetyBindings(fresh: BitcoinPsbtInspection, inspection: BitcoinPsbtInspection, utxo: VerifiedBitcoinPsbtUtxoQuorum, fee: VerifiedBitcoinFeeSafety, policy: VerifiedBitcoinReadPolicy, now: number): void {
  if (policy.policy.chainId !== fresh.chainId || policy.verifiedAt > now) throw new Error("BITCOIN_SIGNED_PSBT_POLICY_BINDING_INVALID");
  if (utxo.schema !== "realdex.bitcoin-psbt-utxo-quorum.v1" || utxo.status !== "verified-design-gate" || utxo.executionEnabled !== false || utxo.signingEnabled !== false || utxo.broadcastEnabled !== false || utxo.chainId !== fresh.chainId || utxo.psbtFingerprint !== fresh.psbtFingerprint || utxo.intentFingerprint !== fresh.intentFingerprint || utxo.inputCount !== fresh.inputCount || utxo.verifiedAt < inspection.inspectedAt || utxo.verifiedAt > now) throw new Error("BITCOIN_SIGNED_PSBT_UTXO_BINDING_INVALID");
  if (fee.schema !== "realdex.bitcoin-fee-safety.v1" || fee.status !== "verified-design-gate" || fee.executionEnabled !== false || fee.signingEnabled !== false || fee.broadcastEnabled !== false || fee.chainId !== fresh.chainId || fee.psbtFingerprint !== fresh.psbtFingerprint || fee.utxoVerifiedAt !== utxo.verifiedAt || fee.feeSats !== fresh.feeSats || fee.verifiedAt < utxo.verifiedAt || fee.verifiedAt > now) throw new Error("BITCOIN_SIGNED_PSBT_FEE_BINDING_INVALID");
}

function validateEnvelope(value: unknown, now: number): BitcoinSignedPsbtEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BITCOIN_SIGNED_PSBT_ENVELOPE_INVALID");
  const root = value as Record<string, unknown>;
  const keys = ["schema", "signedPsbtBase64", "originalPsbtFingerprint", "issuedAt", "expiresAt"].sort();
  const actual = Object.keys(root).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index]) || root.schema !== "realdex.bitcoin-signed-psbt.v1" || typeof root.signedPsbtBase64 !== "string" || typeof root.originalPsbtFingerprint !== "string" || !/^0x[0-9a-f]{64}$/.test(root.originalPsbtFingerprint)) throw new Error("BITCOIN_SIGNED_PSBT_ENVELOPE_INVALID");
  const issuedAt = canonicalDate(root.issuedAt, "BITCOIN_SIGNED_PSBT_ISSUED_AT_INVALID");
  const expiresAt = canonicalDate(root.expiresAt, "BITCOIN_SIGNED_PSBT_EXPIRES_AT_INVALID");
  if (issuedAt > now + 60_000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_ENVELOPE_TTL_MS) throw new Error("BITCOIN_SIGNED_PSBT_ENVELOPE_EXPIRED_OR_TTL_INVALID");
  return root as BitcoinSignedPsbtEnvelope;
}

function sameInspection(left: BitcoinPsbtInspection, right: BitcoinPsbtInspection): boolean {
  return right.schema === "realdex.bitcoin-psbt-inspection.v1" && right.status === "verified-design-gate" && right.executionEnabled === false && right.signingEnabled === false && right.broadcastEnabled === false && left.psbtFingerprint === right.psbtFingerprint && left.unsignedTransactionFingerprint === right.unsignedTransactionFingerprint && left.intentFingerprint === right.intentFingerprint;
}

function assertMapEqual(left: BitcoinPsbtMapEntry[], right: BitcoinPsbtMapEntry[], error: string): void {
  const normalize = (entries: BitcoinPsbtMapEntry[]) => entries.map((entry) => `${entry.type}:${hexlify(entry.keyData)}:${hexlify(entry.value)}`).sort();
  const a = normalize(left); const b = normalize(right);
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) throw new Error(error);
}

function witnessUtxo(map: BitcoinPsbtMapEntry[]): { amount: bigint; script: Uint8Array } {
  const entry = map.find((item) => item.type === 0x01);
  if (!entry || entry.keyData.length !== 0 || entry.value.length < 10) throw new Error("BITCOIN_SIGNED_PSBT_WITNESS_UTXO_INVALID");
  const amount = new DataView(entry.value.buffer, entry.value.byteOffset, 8).getBigUint64(0, true);
  const length = entry.value[8];
  if (length >= 0xfd || entry.value.length !== 9 + length) throw new Error("BITCOIN_SIGNED_PSBT_WITNESS_UTXO_INVALID");
  return { amount, script: entry.value.slice(9) };
}

function serializeOutput(output: { amount: bigint; scriptPubKey: Uint8Array }): Uint8Array { return concat([u64(output.amount), compactSize(output.scriptPubKey.length), output.scriptPubKey]); }
function concat(values: readonly Uint8Array[]): Uint8Array { return getBytes(ethersConcat(values)); }
function compactSize(value: number): Uint8Array { if (value < 0xfd) return Uint8Array.of(value); throw new Error("BITCOIN_SIGNED_PSBT_COMPACT_SIZE_UNSUPPORTED"); }
function u32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }
function u64(value: bigint): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; }
function readU32(value: Uint8Array): number { return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true); }
function reverse(value: Uint8Array): Uint8Array { return value.slice().reverse(); }
function doubleSha(value: Uint8Array): Uint8Array { return getBytes(sha256(getBytes(sha256(value)))); }
function equalBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function canonicalDate(value: unknown, error: string): number { if (typeof value !== "string") throw new Error(error); const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(error); return parsed; }
