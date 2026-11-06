import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertGenuineSolanaStandardBinding, type SolanaStandardAccountBinding, type SolanaStandardConnection } from "../wallet/solana-standard-session";
import { solanaSwapIntentSha256, solanaSwapTransactionSha256, validateSolanaSwapIntent, type SolanaSwapIntent } from "./solana-swap-boundary";
import { assertVerifiedSourceBoundSplTokenSwap, type VerifiedSourceBoundSplTokenSwap } from "./solana-spl-route-source";

const genuinePreparations = new WeakMap<object, string>();

export type SolanaStandardSigningPreparation = Readonly<{
  schema: "realdex.solana-standard-signing-preparation.v1";
  preparationId: string;
  preparedAt: number;
  expiresAt: number;
  walletId: string;
  sessionId: string;
  accountId: string;
  authority: string;
  chainId: string;
  walletChain: string;
  transactionVersion: 0;
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
  transactionBase64: string;
  transactionSha256: string;
  intentSha256: string;
  sourceFingerprint: string;
  routeFingerprint: string;
  manifestPayloadHash: string;
  readPolicySourceFingerprint: string;
  readPolicyPayloadHash: string;
  requiresFreshVerification: true;
  signingEnabled: false;
  submissionEnabled: false;
  executionEnabled: false;
}>;

/**
 * Creates a page-local, non-authorizing package for a future explicit signing
 * review. It never reads a signing method and never calls a wallet or RPC.
 */
export async function prepareSolanaStandardSigning(input: {
  connection: SolanaStandardConnection;
  binding: SolanaStandardAccountBinding;
  intent: SolanaSwapIntent;
  verified: VerifiedSourceBoundSplTokenSwap;
  now?: number;
}): Promise<SolanaStandardSigningPreparation> {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("SOLANA_SIGNING_PREPARATION_TIME_INVALID");
  assertGenuineSolanaStandardBinding(input.connection, input.binding);
  assertVerifiedSourceBoundSplTokenSwap(input.verified);
  const intent = validateSolanaSwapIntent(input.intent);
  const binding = input.binding;
  if (binding.transactionVersion !== 0) throw new Error("SOLANA_SIGNING_PREPARATION_VERSION_UNSUPPORTED");
  if (binding.chainId !== intent.chainId || binding.address !== intent.authority || binding.accountId !== `${intent.chainId}:${intent.authority}`) throw new Error("SOLANA_SIGNING_PREPARATION_ACCOUNT_MISMATCH");
  if (intent.quoteExpiresAt <= now || binding.expiresAt <= now) throw new Error("SOLANA_SIGNING_PREPARATION_EXPIRED");
  const verified = input.verified;
  if (verified.schema !== "realdex.verified-solana-swap.v1" || verified.execution !== "design-gate" || verified.executionEnabled !== false || verified.submissionEnabled !== false || verified.venueId !== intent.venueId || verified.chainId !== intent.chainId || verified.sourceDebitBaseUnits !== intent.amountInBaseUnits || verified.destinationCreditBaseUnits !== intent.expectedOutBaseUnits || verified.quote.venueId !== intent.venueId || verified.quote.chainId !== intent.chainId || verified.quote.amountInBaseUnits !== intent.amountInBaseUnits || verified.quote.expectedOutBaseUnits !== intent.expectedOutBaseUnits || verified.quote.minimumOutBaseUnits !== intent.minimumOutBaseUnits || verified.quote.slippageBps !== intent.slippageBps) throw new Error("SOLANA_SIGNING_PREPARATION_EVIDENCE_MISMATCH");
  const [transactionSha256, intentSha256] = await Promise.all([solanaSwapTransactionSha256(intent), solanaSwapIntentSha256(intent)]);
  if (transactionSha256 !== verified.transactionSha256 || intentSha256 !== verified.intentSha256) throw new Error("SOLANA_SIGNING_PREPARATION_HASH_MISMATCH");
  // An account or source capability may be invalidated while hashing.
  assertGenuineSolanaStandardBinding(input.connection, binding);
  assertVerifiedSourceBoundSplTokenSwap(verified);
  const expiresAt = Math.min(binding.expiresAt, intent.quoteExpiresAt);
  const identity = {
    walletId: binding.walletId, sessionId: binding.sessionId, accountId: binding.accountId,
    authority: binding.address, chainId: intent.chainId, venueId: intent.venueId,
    transactionSha256, intentSha256, sourceFingerprint: verified.sourceFingerprint, routeFingerprint: verified.routeFingerprint,
    manifestPayloadHash: verified.manifestPayloadHash, readPolicySourceFingerprint: verified.readPolicySourceFingerprint,
    readPolicyPayloadHash: verified.readPolicyPayloadHash,
    expiresAt
  };
  const preparation: SolanaStandardSigningPreparation = {
    schema: "realdex.solana-standard-signing-preparation.v1",
    preparationId: cryptographicFingerprint("realdex.solana-standard-signing-preparation.v1", identity),
    preparedAt: now, expiresAt, walletId: binding.walletId, sessionId: binding.sessionId, accountId: binding.accountId,
    authority: binding.address, chainId: binding.chainId, walletChain: binding.walletChain, transactionVersion: 0,
    venueId: intent.venueId, executionTarget: intent.executionTarget, sourceMint: intent.sourceMint,
    destinationMint: intent.destinationMint, destinationTokenAccount: intent.destinationTokenAccount,
    destinationTokenOwner: intent.destinationTokenOwner, amountInBaseUnits: intent.amountInBaseUnits,
    expectedOutBaseUnits: intent.expectedOutBaseUnits, minimumOutBaseUnits: intent.minimumOutBaseUnits,
    feeLamports: verified.feeLamports, transactionBase64: intent.transactionBase64, transactionSha256, intentSha256,
    sourceFingerprint: verified.sourceFingerprint, routeFingerprint: verified.routeFingerprint,
    manifestPayloadHash: verified.manifestPayloadHash, readPolicySourceFingerprint: verified.readPolicySourceFingerprint,
    readPolicyPayloadHash: verified.readPolicyPayloadHash, requiresFreshVerification: true,
    signingEnabled: false, submissionEnabled: false, executionEnabled: false
  };
  genuinePreparations.set(preparation, cryptographicFingerprint("realdex.solana-standard-signing-preparation.v1", preparation));
  return Object.freeze(preparation);
}

export function assertGenuineSolanaStandardSigningPreparation(value: SolanaStandardSigningPreparation): void {
  const expected = genuinePreparations.get(value);
  if (!expected) throw new Error("SOLANA_SIGNING_PREPARATION_NOT_AUTHENTIC");
  if (expected !== cryptographicFingerprint("realdex.solana-standard-signing-preparation.v1", value)) throw new Error("SOLANA_SIGNING_PREPARATION_CHANGED");
}
