import { bech32, bech32m } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { Wallet, encodeBase64, getBytes, ripemd160, sha256 } from "ethers";
import { describe, expect, it } from "vitest";
import { decodeBitcoinAddress } from "./bitcoin-address";
import { DEFAULT_BITCOIN_FEE_SAFETY_POLICY, type VerifiedBitcoinFeeSafety } from "./bitcoin-fee-policy";
import { inspectBitcoinPsbtIntent, parseBitcoinPsbtDocument, type BitcoinPsbtIntent } from "./bitcoin-psbt";
import { bitcoinReadPolicySourceFingerprint, canonicalSignedBitcoinReadPolicyPayload, verifySignedBitcoinReadPolicy } from "./bitcoin-read-policy";
import { bitcoinSignatureDigest, verifySignedBitcoinPsbt } from "./bitcoin-signed-psbt";
import { verifyFinalizedBitcoinPsbt } from "./bitcoin-finalized-psbt";
import type { VerifiedBitcoinPsbtUtxoQuorum } from "./bitcoin-utxo-quorum";

const now = Date.parse("2026-09-01T10:00:00.000Z");
const chainId = "bip122:000000000019d6689c085ae165831e93";
const ecdsaPrivateKey = getBytes(`0x${"11".repeat(32)}`);
const schnorrPrivateKey = getBytes(`0x${"22".repeat(32)}`);
const ecdsaPublicKey = secp256k1.getPublicKey(ecdsaPrivateKey, true);
const p2wpkhAddress = segwitAddress(0, getBytes(ripemd160(sha256(ecdsaPublicKey))));
const p2trAddress = segwitAddress(1, schnorr.getPublicKey(schnorrPrivateKey));
const recipientAddress = "bc1qwz2lhc40s8ty3l5jg3plpve3y3l82x9l42q7fk";

describe("Bitcoin signed PSBT offline verification", () => {
  it("matches the deployed BIP-143 native P2WPKH signature-hash vector", () => {
    const unsigned = getBytes("0x0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000");
    const vectorScript = getBytes("0x00141d0f172a0ecb48aee1be1f2687d2963ae33f71a1");
    const document = parseBitcoinPsbtDocument(encodeBase64(encodePsbt(unsigned, [[{ type: 0x01, value: txOutput(625_000_000n, vectorScript) }], [{ type: 0x01, value: txOutput(600_000_000n, vectorScript) }]], [[], []])));
    const vectorAddress = segwitAddress(0, getBytes("0x1d0f172a0ecb48aee1be1f2687d2963ae33f71a1"));
    const vectorIntent = { ...unsignedIntent(), inputs: [{ ...unsignedIntent().inputs[0] }, { ...unsignedIntent().inputs[1], address: vectorAddress, amountSats: "600000000" }] };
    expect(Buffer.from(bitcoinSignatureDigest(document, vectorIntent, 1, 1)).toString("hex")).toBe("c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670");
  });

  it("verifies exact P2WPKH ECDSA and P2TR key-path Schnorr signatures without finalizing or broadcasting", async () => {
    const gate = await fixture();
    const report = verifySignedBitcoinPsbt(gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, now);
    expect(report).toMatchObject({
      status: "verified-design-gate", executionEnabled: false, signingEnabled: false, finalizationEnabled: false, broadcastEnabled: false,
      inputCount: 2, p2wpkhSignatureCount: 1, p2trSignatureCount: 1,
      originalPsbtFingerprint: gate.inspection.psbtFingerprint, unsignedTransactionFingerprint: gate.inspection.unsignedTransactionFingerprint
    });
    expect(JSON.stringify(report)).not.toContain(gate.envelope.signedPsbtBase64);
    expect(JSON.stringify(report)).not.toContain(p2wpkhAddress);
    expect(JSON.stringify(report)).not.toContain(p2trAddress);
  });

  it("rejects transaction substitution and non-signature metadata changes", async () => {
    const gate = await fixture();
    const changedTransaction = signedPsbt(gate.intent, [{ type: 0x07, value: Uint8Array.of(0) }]);
    expect(() => verifySignedBitcoinPsbt({ ...gate.envelope, signedPsbtBase64: changedTransaction }, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, now)).toThrow("BITCOIN_SIGNED_PSBT_METADATA_CHANGED");
    expect(() => verifySignedBitcoinPsbt({ ...gate.envelope, originalPsbtFingerprint: `0x${"00".repeat(32)}` }, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, now)).toThrow("BITCOIN_SIGNED_PSBT_ORIGINAL_BINDING_INVALID");
  });

  it("rejects an unsafe Taproot sighash and a changed signature", async () => {
    const gate = await fixture();
    const document = parseBitcoinPsbtDocument(gate.intent.psbtBase64);
    const ecdsaDigest = bitcoinSignatureDigest(document, gate.intent, 0, 1);
    const ecdsa = concat(secp256k1.sign(ecdsaDigest, ecdsaPrivateKey, { lowS: true }).toDERRawBytes(), Uint8Array.of(1));
    const tapDigest = bitcoinSignatureDigest(document, gate.intent, 1, 1);
    const unsafeTap = concat(schnorr.sign(tapDigest, schnorrPrivateKey, new Uint8Array(32)), Uint8Array.of(0x81));
    const unsafe = encodeSignedPsbt(gate.intent, [[{ type: 0x02, keyData: ecdsaPublicKey, value: ecdsa }], [{ type: 0x13, value: unsafeTap }]]);
    expect(() => verifySignedBitcoinPsbt({ ...gate.envelope, signedPsbtBase64: unsafe }, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, now)).toThrow("BITCOIN_SIGNED_PSBT_SIGHASH_UNSAFE");

    const bytes = getBytes(`0x${"01".repeat(64)}`);
    const invalid = encodeSignedPsbt(gate.intent, [[{ type: 0x02, keyData: ecdsaPublicKey, value: ecdsa }], [{ type: 0x13, value: bytes }]]);
    expect(() => verifySignedBitcoinPsbt({ ...gate.envelope, signedPsbtBase64: invalid }, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, now)).toThrow("BITCOIN_SIGNED_PSBT_SIGNATURE_INVALID");
  });

  it("rejects stale envelope, UTXO, fee, and read-policy bindings", async () => {
    const gate = await fixture();
    expect(() => verifySignedBitcoinPsbt({ ...gate.envelope, expiresAt: new Date(now).toISOString() }, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, now)).toThrow("BITCOIN_SIGNED_PSBT_ENVELOPE_EXPIRED_OR_TTL_INVALID");
    expect(() => verifySignedBitcoinPsbt(gate.envelope, gate.intent, gate.inspection, { ...gate.utxo, psbtFingerprint: `0x${"01".repeat(32)}` }, gate.fee, gate.policy, now)).toThrow("BITCOIN_SIGNED_PSBT_UTXO_BINDING_INVALID");
    expect(() => verifySignedBitcoinPsbt(gate.envelope, gate.intent, gate.inspection, gate.utxo, { ...gate.fee, feeSats: "2" }, gate.policy, now)).toThrow("BITCOIN_SIGNED_PSBT_FEE_BINDING_INVALID");
    expect(() => verifySignedBitcoinPsbt(gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, { ...gate.policy, payloadHash: `0x${"02".repeat(32)}` }, now)).toThrow();
  });
});

describe("Bitcoin finalized PSBT offline extraction verification", () => {
  it("verifies exact native witnesses and derives txid/wtxid without enabling extraction or broadcast", async () => {
    const gate = await finalizedFixture();
    const report = verifyFinalizedBitcoinPsbt(gate.finalEnvelope, gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, gate.signedVerification, now);
    expect(report).toMatchObject({ status: "verified-design-gate", executionEnabled: false, signingEnabled: false, finalizationEnabled: false, transactionExtractionEnabled: false, broadcastEnabled: false, inputCount: 2, outputCount: 1, feeSats: "1000" });
    expect(report.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(report.wtxid).toMatch(/^[0-9a-f]{64}$/);
    expect(report.wtxid).not.toBe(report.txid);
    expect(report.virtualSize).toBeGreaterThanOrEqual(gate.inspection.signedVsizeMin);
    expect(report.virtualSize).toBeLessThanOrEqual(gate.inspection.signedVsizeMax);
    expect(JSON.stringify(report)).not.toContain(gate.finalEnvelope.finalizedPsbtBase64);
  });

  it("rejects a substituted witness signature or witness item order", async () => {
    const gate = await finalizedFixture();
    const signed = parseBitcoinPsbtDocument(gate.envelope.signedPsbtBase64);
    const wrong = finalizedPsbt(gate.intent, signed, { p2wpkhWitness: [signed.inputMaps[0].find((entry) => entry.type === 0x02)!.keyData, signed.inputMaps[0].find((entry) => entry.type === 0x02)!.value] });
    expect(() => verifyFinalizedBitcoinPsbt({ ...gate.finalEnvelope, finalizedPsbtBase64: wrong }, gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, gate.signedVerification, now)).toThrow("BITCOIN_FINALIZED_PSBT_WITNESS_MISMATCH");
  });

  it("rejects finalScriptSig, retained signing metadata, and non-canonical witness serialization", async () => {
    const gate = await finalizedFixture();
    const signed = parseBitcoinPsbtDocument(gate.envelope.signedPsbtBase64);
    const extra = finalizedPsbt(gate.intent, signed, { firstExtra: { type: 0x07, value: Uint8Array.of(0) } });
    expect(() => verifyFinalizedBitcoinPsbt({ ...gate.finalEnvelope, finalizedPsbtBase64: extra }, gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, gate.signedVerification, now)).toThrow("BITCOIN_FINALIZED_PSBT_INPUT_FIELDS_INVALID");
    const retained = finalizedPsbt(gate.intent, signed, { firstExtra: signed.inputMaps[0].find((entry) => entry.type === 0x02)! });
    expect(() => verifyFinalizedBitcoinPsbt({ ...gate.finalEnvelope, finalizedPsbtBase64: retained }, gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, gate.signedVerification, now)).toThrow("BITCOIN_FINALIZED_PSBT_INPUT_FIELDS_INVALID");
    const nonCanonical = finalizedPsbt(gate.intent, signed, { p2trWitnessValue: concat(Uint8Array.of(0xfd, 1, 0), compact(64), signed.inputMaps[1].find((entry) => entry.type === 0x13)!.value) });
    expect(() => verifyFinalizedBitcoinPsbt({ ...gate.finalEnvelope, finalizedPsbtBase64: nonCanonical }, gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, gate.signedVerification, now)).toThrow("BITCOIN_FINALIZED_PSBT_COMPACT_SIZE_NON_MINIMAL");
  });

  it("rejects stale envelopes and substituted signed verification evidence", async () => {
    const gate = await finalizedFixture();
    expect(() => verifyFinalizedBitcoinPsbt({ ...gate.finalEnvelope, expiresAt: new Date(now).toISOString() }, gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, gate.signedVerification, now)).toThrow("BITCOIN_FINALIZED_PSBT_ENVELOPE_EXPIRED_OR_TTL_INVALID");
    expect(() => verifyFinalizedBitcoinPsbt(gate.finalEnvelope, gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, { ...gate.signedVerification, signedPsbtFingerprint: `0x${"00".repeat(32)}` }, now)).toThrow("BITCOIN_FINALIZED_PSBT_SIGNED_BINDING_INVALID");
  });
});

async function fixture() {
  const intent = unsignedIntent();
  const inspection = inspectBitcoinPsbtIntent(intent, now);
  const signedPsbtBase64 = signedPsbt(intent);
  const utxo: VerifiedBitcoinPsbtUtxoQuorum = {
    schema: "realdex.bitcoin-psbt-utxo-quorum.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false,
    chainId, psbtFingerprint: inspection.psbtFingerprint, intentFingerprint: inspection.intentFingerprint, inputCount: 2,
    minConfirmations: 1, weakestConfirmations: 8, readerIds: ["a.example", "b.example"], inputFingerprints: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`], verifiedAt: now
  };
  const fee: VerifiedBitcoinFeeSafety = {
    schema: "realdex.bitcoin-fee-safety.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false,
    chainId, psbtFingerprint: inspection.psbtFingerprint, utxoVerifiedAt: now, feeSats: inspection.feeSats,
    signedVsizeMin: inspection.signedVsizeMin, signedVsizeMax: inspection.signedVsizeMax,
    feeRateMilliSatsPerVbyteMin: inspection.feeRateMilliSatsPerVbyteMin, feeRateMilliSatsPerVbyteMax: inspection.feeRateMilliSatsPerVbyteMax,
    confirmationTargetBlocks: 6, recommendationMilliSatsPerVbyteMin: "5000", recommendationMilliSatsPerVbyteMax: "5000", readerIds: ["a.example", "b.example"], verifiedAt: now
  };
  const signer = new Wallet(`0x${"33".repeat(32)}`);
  const source = { schema: "realdex.bitcoin-read-policy-source.v1" as const, id: "signed-psbt-test", name: "Signed PSBT test policy", signerAddress: signer.address, allowedChainIds: [chainId], evidenceUrls: ["https://policy.example/evidence"] };
  const unsignedPolicy = {
    schema: "realdex.signed-bitcoin-read-policy.v1" as const, sourceId: source.id, sourceFingerprint: bitcoinReadPolicySourceFingerprint(source), revision: 1,
    issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), chainId,
    esploraEndpoints: ["https://a.example/api/", "https://b.example/api/"] as [string, string], utxoPolicy: { minConfirmations: 1, maxTipDivergence: 6 }, feePolicy: DEFAULT_BITCOIN_FEE_SAFETY_POLICY, evidenceUrls: ["https://policy.example/evidence"]
  };
  const policy = verifySignedBitcoinReadPolicy({ ...unsignedPolicy, signature: await signer.signMessage(canonicalSignedBitcoinReadPolicyPayload(unsignedPolicy)) }, source, { now });
  return { intent, inspection, utxo, fee, policy, envelope: { schema: "realdex.bitcoin-signed-psbt.v1" as const, signedPsbtBase64, originalPsbtFingerprint: inspection.psbtFingerprint, issuedAt: new Date(now - 30_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() } };
}

async function finalizedFixture() {
  const gate = await fixture();
  const signedVerification = verifySignedBitcoinPsbt(gate.envelope, gate.intent, gate.inspection, gate.utxo, gate.fee, gate.policy, now);
  const signed = parseBitcoinPsbtDocument(gate.envelope.signedPsbtBase64);
  return { ...gate, signedVerification, finalEnvelope: { schema: "realdex.bitcoin-finalized-psbt.v1" as const, finalizedPsbtBase64: finalizedPsbt(gate.intent, signed), signedPsbtFingerprint: signedVerification.signedPsbtFingerprint, issuedAt: new Date(now - 20_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() } };
}

function finalizedPsbt(intent: BitcoinPsbtIntent, signed: ReturnType<typeof parseBitcoinPsbtDocument>, options: { firstExtra?: Entry; p2wpkhWitness?: Uint8Array[]; p2trWitnessValue?: Uint8Array } = {}): string {
  const ecdsa = signed.inputMaps[0].find((entry) => entry.type === 0x02)!;
  const tap = signed.inputMaps[1].find((entry) => entry.type === 0x13)!;
  const p2wpkhStack = options.p2wpkhWitness ?? [ecdsa.value, ecdsa.keyData];
  const p2wpkhWitness = concat(compact(p2wpkhStack.length), ...p2wpkhStack.flatMap((item) => [compact(item.length), item]));
  const p2trWitness = options.p2trWitnessValue ?? concat(compact(1), compact(tap.value.length), tap.value);
  const inputMaps: Entry[][] = signed.inputMaps.map((map, index) => [
    { type: 0x01, keyData: map.find((entry) => entry.type === 0x01)!.keyData, value: map.find((entry) => entry.type === 0x01)!.value },
    { type: 0x08, value: index === 0 ? p2wpkhWitness : p2trWitness },
    ...(index === 0 && options.firstExtra ? [options.firstExtra] : [])
  ]);
  return encodeBase64(encodePsbt(signed.unsignedTransactionBytes, inputMaps, signed.outputMaps));
}

function unsignedIntent(): BitcoinPsbtIntent {
  const inputs = [
    { txid: "11".repeat(32), vout: 0, amountSats: "60000", address: p2wpkhAddress, sequence: 0xffff_fffd },
    { txid: "22".repeat(32), vout: 1, amountSats: "60000", address: p2trAddress, sequence: 0xffff_fffd }
  ];
  const recipientScript = decodeBitcoinAddress(chainId, recipientAddress)!.scriptPubKey;
  const unsignedTx = transaction(inputs, [{ amount: 119_000n, script: recipientScript }]);
  const inputMaps = inputs.map((input) => [{ type: 0x01, value: txOutput(BigInt(input.amountSats), decodeBitcoinAddress(chainId, input.address)!.scriptPubKey) }]);
  const psbt = encodePsbt(unsignedTx, inputMaps, [[]]);
  return { schema: "realdex.bitcoin-psbt-intent.v1", chainId, psbtBase64: encodeBase64(psbt), transactionVersion: 2, locktime: 0, feeSats: "1000", issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 5 * 60_000).toISOString(), inputs, outputs: [{ address: recipientAddress, amountSats: "119000", role: "recipient" }] };
}

function signedPsbt(intent: BitcoinPsbtIntent, firstExtras: Entry[] = []): string {
  const document = parseBitcoinPsbtDocument(intent.psbtBase64);
  const ecdsaDigest = bitcoinSignatureDigest(document, intent, 0, 1);
  const ecdsa = concat(secp256k1.sign(ecdsaDigest, ecdsaPrivateKey, { lowS: true }).toDERRawBytes(), Uint8Array.of(1));
  const tapDigest = bitcoinSignatureDigest(document, intent, 1, 0);
  const tap = schnorr.sign(tapDigest, schnorrPrivateKey, new Uint8Array(32));
  return encodeSignedPsbt(intent, [[{ type: 0x02, keyData: ecdsaPublicKey, value: ecdsa }, ...firstExtras], [{ type: 0x13, value: tap }]]);
}

function encodeSignedPsbt(intent: BitcoinPsbtIntent, extras: Entry[][]): string {
  const document = parseBitcoinPsbtDocument(intent.psbtBase64);
  const maps = document.inputMaps.map((original, index) => [...original.map((entry) => ({ type: entry.type, keyData: entry.keyData, value: entry.value })), ...extras[index]]);
  return encodeBase64(encodePsbt(document.unsignedTransactionBytes, maps, document.outputMaps));
}

type Entry = { type: number; keyData?: Uint8Array; value: Uint8Array };
function segwitAddress(version: 0 | 1, program: Uint8Array): string { const codec = version === 0 ? bech32 : bech32m; return codec.encode("bc", [version, ...codec.toWords(program)]); }
function transaction(inputs: BitcoinPsbtIntent["inputs"], outputs: Array<{ amount: bigint; script: Uint8Array }>): Uint8Array { return concat(u32(2), compact(inputs.length), ...inputs.flatMap((input) => [getBytes(`0x${input.txid}`).slice().reverse(), u32(input.vout), compact(0), u32(input.sequence)]), compact(outputs.length), ...outputs.map((output) => txOutput(output.amount, output.script)), u32(0)); }
function txOutput(amount: bigint, script: Uint8Array): Uint8Array { return concat(u64(amount), compact(script.length), script); }
function encodePsbt(unsignedTx: Uint8Array, inputMaps: Entry[][], outputMaps: Entry[][]): Uint8Array { return concat(Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff), map([{ type: 0x00, value: unsignedTx }]), ...inputMaps.map(map), ...outputMaps.map(map)); }
function map(entries: Entry[]): Uint8Array { return concat(...entries.flatMap((entry) => { const key = concat(compact(entry.type), entry.keyData ?? new Uint8Array()); return [compact(key.length), key, compact(entry.value.length), entry.value]; }), Uint8Array.of(0)); }
function compact(value: number): Uint8Array { if (value < 0xfd) return Uint8Array.of(value); throw new Error("fixture too large"); }
function u32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; }
function u64(value: bigint): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; }
function concat(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
