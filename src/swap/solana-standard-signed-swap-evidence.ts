import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertGenuineSolanaStandardBinding, type SolanaStandardAccountBinding, type SolanaStandardConnection } from "../wallet/solana-standard-session";
import { type SolanaSwapIntent } from "./solana-swap-boundary";
import { assertVerifiedSourceBoundSplTokenSwap, type VerifiedSourceBoundSplTokenSwap } from "./solana-spl-route-source";
import { assertGenuineSolanaStandardSigningPreparation, type SolanaStandardSigningPreparation } from "./solana-standard-signing-preparation";
import { verifySignedSolanaSwapTransaction } from "./solana-swap-recovery";

const genuineEvidence = new WeakMap<object, string>();

export type SolanaStandardSignedSwapEvidence = Readonly<{
  schema: "realdex.solana-standard-signed-swap-evidence.v1";
  evidenceId: string;
  preparationId: string;
  acceptedAt: number;
  expiresAt: number;
  walletId: string;
  sessionId: string;
  accountId: string;
  authority: string;
  chainId: string;
  venueId: string;
  executionTarget: string;
  sourceMint: string;
  destinationMint: string;
  destinationTokenAccount: string;
  destinationTokenOwner: string;
  amountInBaseUnits: string;
  expectedOutBaseUnits: string;
  minimumOutBaseUnits: string;
  feeLamports: number;
  transactionSignature: string;
  signedTransactionSha256: string;
  unsignedTransactionSha256: string;
  messageSha256: string;
  intentSha256: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  sourceFingerprint: string;
  routeFingerprint: string;
  manifestPayloadHash: string;
  readPolicySourceFingerprint: string;
  readPolicyPayloadHash: string;
  stage: "signed-not-submitted";
  signedTransactionBytesStored: false;
  automaticResendBlocked: true;
  requiresExplicitSubmissionAuthorization: true;
  submissionEnabled: false;
  executionEnabled: false;
}>;

/**
 * Accepts already-signed bytes for verification only. It does not request a
 * signature, retain the signed bytes, call RPC, or submit a transaction.
 */
export async function verifySolanaStandardSignedSwap(input: {
  connection: SolanaStandardConnection;
  binding: SolanaStandardAccountBinding;
  preparation: SolanaStandardSigningPreparation;
  intent: SolanaSwapIntent;
  verified: VerifiedSourceBoundSplTokenSwap;
  signedTransactionBase64: string;
  transactionSignature: string;
  now?: number;
}): Promise<SolanaStandardSignedSwapEvidence> {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("SOLANA_SIGNED_SWAP_TIME_INVALID");
  assertCapabilities(input);
  assertPreparationBinding(input, now);

  const signed = await verifySignedSolanaSwapTransaction({
    intent: input.intent,
    verified: input.verified,
    signedTransactionBase64: input.signedTransactionBase64,
    transactionSignature: input.transactionSignature
  });
  if (signed.unsignedTransactionSha256 !== input.preparation.transactionSha256 || signed.intentSha256 !== input.preparation.intentSha256) throw new Error("SOLANA_SIGNED_SWAP_PREPARATION_MISMATCH");

  // Wallet accounts and source evidence may change while WebCrypto is active.
  assertCapabilities(input);
  assertPreparationBinding(input, now);

  const unsignedEvidence = {
    schema: "realdex.solana-standard-signed-swap-evidence.v1",
    preparationId: input.preparation.preparationId,
    acceptedAt: now,
    expiresAt: input.preparation.expiresAt,
    walletId: input.binding.walletId,
    sessionId: input.binding.sessionId,
    accountId: input.binding.accountId,
    authority: input.intent.authority,
    chainId: input.intent.chainId,
    venueId: input.intent.venueId,
    executionTarget: input.intent.executionTarget,
    sourceMint: input.intent.sourceMint,
    destinationMint: input.intent.destinationMint,
    destinationTokenAccount: input.intent.destinationTokenAccount,
    destinationTokenOwner: input.intent.destinationTokenOwner,
    amountInBaseUnits: input.intent.amountInBaseUnits,
    expectedOutBaseUnits: input.intent.expectedOutBaseUnits,
    minimumOutBaseUnits: input.intent.minimumOutBaseUnits,
    feeLamports: input.verified.feeLamports,
    transactionSignature: signed.transactionSignature,
    signedTransactionSha256: signed.signedTransactionSha256,
    unsignedTransactionSha256: signed.unsignedTransactionSha256,
    messageSha256: signed.messageSha256,
    intentSha256: signed.intentSha256,
    recentBlockhash: signed.recentBlockhash,
    lastValidBlockHeight: signed.lastValidBlockHeight,
    sourceFingerprint: input.verified.sourceFingerprint,
    routeFingerprint: input.verified.routeFingerprint,
    manifestPayloadHash: input.verified.manifestPayloadHash,
    readPolicySourceFingerprint: input.verified.readPolicySourceFingerprint,
    readPolicyPayloadHash: input.verified.readPolicyPayloadHash,
    stage: "signed-not-submitted",
    signedTransactionBytesStored: false,
    automaticResendBlocked: true,
    requiresExplicitSubmissionAuthorization: true,
    submissionEnabled: false,
    executionEnabled: false
  } as const;
  const evidence: SolanaStandardSignedSwapEvidence = {
    ...unsignedEvidence,
    evidenceId: cryptographicFingerprint("realdex.solana-standard-signed-swap-evidence-id.v1", unsignedEvidence)
  };
  genuineEvidence.set(evidence, cryptographicFingerprint("realdex.solana-standard-signed-swap-evidence.v1", evidence));
  return Object.freeze(evidence);
}

export function assertGenuineSolanaStandardSignedSwapEvidence(value: SolanaStandardSignedSwapEvidence): void {
  const expected = genuineEvidence.get(value);
  if (!expected) throw new Error("SOLANA_SIGNED_SWAP_EVIDENCE_NOT_AUTHENTIC");
  if (expected !== cryptographicFingerprint("realdex.solana-standard-signed-swap-evidence.v1", value)) throw new Error("SOLANA_SIGNED_SWAP_EVIDENCE_CHANGED");
}

function assertCapabilities(input: {
  connection: SolanaStandardConnection;
  binding: SolanaStandardAccountBinding;
  preparation: SolanaStandardSigningPreparation;
  verified: VerifiedSourceBoundSplTokenSwap;
}): void {
  assertGenuineSolanaStandardBinding(input.connection, input.binding);
  assertGenuineSolanaStandardSigningPreparation(input.preparation);
  assertVerifiedSourceBoundSplTokenSwap(input.verified);
}

function assertPreparationBinding(input: {
  binding: SolanaStandardAccountBinding;
  preparation: SolanaStandardSigningPreparation;
  intent: SolanaSwapIntent;
  verified: VerifiedSourceBoundSplTokenSwap;
}, now: number): void {
  const { binding, preparation, intent, verified } = input;
  if (preparation.preparedAt > now || preparation.expiresAt <= now || preparation.expiresAt !== Math.min(binding.expiresAt, intent.quoteExpiresAt)) throw new Error("SOLANA_SIGNED_SWAP_PREPARATION_EXPIRED");
  if (preparation.walletId !== binding.walletId || preparation.sessionId !== binding.sessionId || preparation.accountId !== binding.accountId || preparation.authority !== binding.address || preparation.chainId !== binding.chainId || preparation.transactionVersion !== binding.transactionVersion) throw new Error("SOLANA_SIGNED_SWAP_ACCOUNT_MISMATCH");
  if (preparation.venueId !== intent.venueId || preparation.executionTarget !== intent.executionTarget || preparation.sourceMint !== intent.sourceMint || preparation.destinationMint !== intent.destinationMint || preparation.destinationTokenAccount !== intent.destinationTokenAccount || preparation.destinationTokenOwner !== intent.destinationTokenOwner || preparation.amountInBaseUnits !== intent.amountInBaseUnits || preparation.expectedOutBaseUnits !== intent.expectedOutBaseUnits || preparation.minimumOutBaseUnits !== intent.minimumOutBaseUnits || preparation.transactionBase64 !== intent.transactionBase64) throw new Error("SOLANA_SIGNED_SWAP_INTENT_MISMATCH");
  if (preparation.feeLamports !== verified.feeLamports || preparation.transactionSha256 !== verified.transactionSha256 || preparation.intentSha256 !== verified.intentSha256 || preparation.sourceFingerprint !== verified.sourceFingerprint || preparation.routeFingerprint !== verified.routeFingerprint || preparation.manifestPayloadHash !== verified.manifestPayloadHash || preparation.readPolicySourceFingerprint !== verified.readPolicySourceFingerprint || preparation.readPolicyPayloadHash !== verified.readPolicyPayloadHash) throw new Error("SOLANA_SIGNED_SWAP_EVIDENCE_MISMATCH");
  if (preparation.requiresFreshVerification !== true || preparation.signingEnabled !== false || preparation.submissionEnabled !== false || preparation.executionEnabled !== false) throw new Error("SOLANA_SIGNED_SWAP_AUTHORITY_INVALID");
}
