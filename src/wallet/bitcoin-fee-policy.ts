import { inspectBitcoinPsbtIntent, type BitcoinPsbtInspection, type BitcoinPsbtIntent } from "./bitcoin-psbt";
import type { BitcoinEsploraFeeReader, VerifiedBitcoinPsbtUtxoQuorum } from "./bitcoin-utxo-quorum";

export type BitcoinFeeSafetyPolicy = {
  confirmationTargetBlocks: number;
  minFeeRateMilliSatsPerVbyte: string;
  maxFeeRateMilliSatsPerVbyte: string;
  minRecommendationRatioBps: number;
  maxRecommendationRatioBps: number;
  maxReaderDivergenceBps: number;
};

export type VerifiedBitcoinFeeSafety = {
  schema: "realdex.bitcoin-fee-safety.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  broadcastEnabled: false;
  chainId: string;
  psbtFingerprint: string;
  utxoVerifiedAt: number;
  feeSats: string;
  signedVsizeMin: number;
  signedVsizeMax: number;
  feeRateMilliSatsPerVbyteMin: string;
  feeRateMilliSatsPerVbyteMax: string;
  confirmationTargetBlocks: number;
  recommendationMilliSatsPerVbyteMin: string;
  recommendationMilliSatsPerVbyteMax: string;
  readerIds: string[];
  verifiedAt: number;
};

export const DEFAULT_BITCOIN_FEE_SAFETY_POLICY: Readonly<BitcoinFeeSafetyPolicy> = Object.freeze({
  confirmationTargetBlocks: 6,
  minFeeRateMilliSatsPerVbyte: "1000",
  maxFeeRateMilliSatsPerVbyte: "1000000",
  minRecommendationRatioBps: 5_000,
  maxRecommendationRatioBps: 50_000,
  maxReaderDivergenceBps: 5_000
});

export async function verifyBitcoinFeeSafety(
  intent: BitcoinPsbtIntent,
  inspection: BitcoinPsbtInspection,
  utxo: VerifiedBitcoinPsbtUtxoQuorum,
  readers: readonly BitcoinEsploraFeeReader[],
  policy: BitcoinFeeSafetyPolicy = DEFAULT_BITCOIN_FEE_SAFETY_POLICY,
  now = Date.now()
): Promise<VerifiedBitcoinFeeSafety> {
  const normalized = validateBitcoinFeeSafetyPolicy(policy);
  if (readers.length !== 2 || new Set(readers.map((reader) => reader.id)).size !== 2) throw new Error("BITCOIN_FEE_READER_QUORUM_INVALID");
  const fresh = inspectBitcoinPsbtIntent(intent, now);
  if (fresh.psbtFingerprint !== inspection.psbtFingerprint || fresh.intentFingerprint !== inspection.intentFingerprint || fresh.unsignedTransactionFingerprint !== inspection.unsignedTransactionFingerprint) throw new Error("BITCOIN_FEE_INSPECTION_STALE");
  if (utxo.status !== "verified-design-gate" || utxo.executionEnabled !== false || utxo.signingEnabled !== false || utxo.broadcastEnabled !== false || utxo.chainId !== fresh.chainId || utxo.psbtFingerprint !== fresh.psbtFingerprint || utxo.intentFingerprint !== fresh.intentFingerprint || utxo.inputCount !== fresh.inputCount || utxo.verifiedAt > now || utxo.verifiedAt < inspection.inspectedAt) throw new Error("BITCOIN_FEE_UTXO_BINDING_INVALID");
  const estimates = await Promise.all(readers.map((reader) => reader.feeEstimate(normalized.confirmationTargetBlocks)));
  estimates.forEach((estimate, index) => {
    if (estimate.readerId !== readers[index].id || estimate.targetBlocks !== normalized.confirmationTargetBlocks || !positiveUintString(estimate.feeRateMilliSatsPerVbyte)) throw new Error("BITCOIN_FEE_ESTIMATE_INVALID");
  });
  const recommended = estimates.map((estimate) => BigInt(estimate.feeRateMilliSatsPerVbyte));
  const recommendationMin = recommended[0] < recommended[1] ? recommended[0] : recommended[1];
  const recommendationMax = recommended[0] > recommended[1] ? recommended[0] : recommended[1];
  if ((recommendationMax - recommendationMin) * 10_000n > recommendationMin * BigInt(normalized.maxReaderDivergenceBps)) throw new Error("BITCOIN_FEE_READER_DIVERGENCE");
  const actualMin = BigInt(fresh.feeRateMilliSatsPerVbyteMin);
  const actualMax = BigInt(fresh.feeRateMilliSatsPerVbyteMax);
  if (actualMin < normalized.minFeeRate || actualMax > normalized.maxFeeRate) throw new Error("BITCOIN_FEE_ABSOLUTE_LIMIT");
  const requiredMin = divideCeil(recommendationMax * BigInt(normalized.minRecommendationRatioBps), 10_000n);
  const permittedMax = recommendationMin * BigInt(normalized.maxRecommendationRatioBps) / 10_000n;
  if (actualMin < requiredMin) throw new Error("BITCOIN_FEE_RATE_TOO_LOW");
  if (actualMax > permittedMax) throw new Error("BITCOIN_FEE_RATE_TOO_HIGH");
  return {
    schema: "realdex.bitcoin-fee-safety.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false,
    chainId: fresh.chainId, psbtFingerprint: fresh.psbtFingerprint, utxoVerifiedAt: utxo.verifiedAt, feeSats: fresh.feeSats,
    signedVsizeMin: fresh.signedVsizeMin, signedVsizeMax: fresh.signedVsizeMax,
    feeRateMilliSatsPerVbyteMin: fresh.feeRateMilliSatsPerVbyteMin, feeRateMilliSatsPerVbyteMax: fresh.feeRateMilliSatsPerVbyteMax,
    confirmationTargetBlocks: normalized.confirmationTargetBlocks,
    recommendationMilliSatsPerVbyteMin: recommendationMin.toString(), recommendationMilliSatsPerVbyteMax: recommendationMax.toString(),
    readerIds: readers.map((reader) => reader.id), verifiedAt: now
  };
}

export function validateBitcoinFeeSafetyPolicy(policy: BitcoinFeeSafetyPolicy): BitcoinFeeSafetyPolicy & { minFeeRate: bigint; maxFeeRate: bigint } {
  const targets = [...Array.from({ length: 25 }, (_, index) => index + 1), 144, 504, 1008];
  if (!targets.includes(policy.confirmationTargetBlocks) || !positiveUintString(policy.minFeeRateMilliSatsPerVbyte) || !positiveUintString(policy.maxFeeRateMilliSatsPerVbyte)) throw new Error("BITCOIN_FEE_POLICY_INVALID");
  const minFeeRate = BigInt(policy.minFeeRateMilliSatsPerVbyte); const maxFeeRate = BigInt(policy.maxFeeRateMilliSatsPerVbyte);
  if (minFeeRate > maxFeeRate || maxFeeRate > 100_000_000n || !Number.isSafeInteger(policy.minRecommendationRatioBps) || policy.minRecommendationRatioBps < 1 || policy.minRecommendationRatioBps > 10_000 || !Number.isSafeInteger(policy.maxRecommendationRatioBps) || policy.maxRecommendationRatioBps < 10_000 || policy.maxRecommendationRatioBps > 100_000 || !Number.isSafeInteger(policy.maxReaderDivergenceBps) || policy.maxReaderDivergenceBps < 0 || policy.maxReaderDivergenceBps > 10_000) throw new Error("BITCOIN_FEE_POLICY_INVALID");
  return { ...policy, minFeeRate, maxFeeRate };
}

function positiveUintString(value: unknown): value is string { return typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value); }
function divideCeil(value: bigint, divisor: bigint): bigint { return (value + divisor - 1n) / divisor; }
