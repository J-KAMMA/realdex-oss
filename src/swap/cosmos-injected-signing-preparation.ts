import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import {
  assertGenuineCosmosInjectedBinding,
  type CosmosInjectedAccountBinding,
  type CosmosInjectedConnection
} from "../wallet/cosmos-injected-session";
import {
  cosmosSwapIntentSha256,
  cosmosSwapTransactionSha256,
  validateCosmosSwapIntent,
  type CosmosSwapIntent
} from "./cosmos-swap-boundary";
import {
  assertVerifiedSourceBoundOsmosisSwap,
  type VerifiedSourceBoundOsmosisSwap
} from "./cosmos-venue-source";

const genuinePreparations = new WeakMap<object, string>();

export type CosmosInjectedSigningPreparation = Readonly<{
  schema: "realdex.cosmos-injected-signing-preparation.v1";
  preparationId: string;
  preparedAt: number;
  expiresAt: number;
  walletId: string;
  sessionId: string;
  accountId: string;
  authority: string;
  chainId: string;
  walletChainId: string;
  publicKeyHex: string;
  hardware: "ledger" | "keystone" | "none";
  venueId: string;
  executionTarget: string;
  recipient: string;
  sourceDenom: string;
  destinationDenom: string;
  amountInBaseUnits: string;
  expectedOutBaseUnits: string;
  minimumOutBaseUnits: string;
  accountNumber: string;
  sequence: string;
  feeDenom: string;
  feeAmountBaseUnits: string;
  gasLimit: string;
  timeoutHeight: string;
  gasUsed: string;
  transactionBase64: string;
  transactionSha256: string;
  signDocSha256: string;
  intentSha256: string;
  sourceFingerprint: string;
  routeFingerprint: string;
  manifestPayloadHash: string;
  readPolicySourceFingerprint: string;
  readPolicyPayloadHash: string;
  requiresFreshVerification: true;
  signingEnabled: false;
  broadcastEnabled: false;
  executionEnabled: false;
}>;

/**
 * Creates a page-local, non-authorizing package for a future explicit signing
 * review. It never reads a signer, calls a signing method, uses RPC, or stores
 * signed bytes.
 */
export async function prepareCosmosInjectedSigning(inputValue: {
  connection: CosmosInjectedConnection;
  binding: CosmosInjectedAccountBinding;
  intent: CosmosSwapIntent;
  verified: VerifiedSourceBoundOsmosisSwap;
  now?: number;
}): Promise<CosmosInjectedSigningPreparation> {
  const input = { ...inputValue, intent: validateCosmosSwapIntent(inputValue.intent) };
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("COSMOS_SIGNING_PREPARATION_TIME_INVALID");
  await assertGenuineCosmosInjectedBinding(input.connection, input.binding, now);
  assertVerifiedSourceBoundOsmosisSwap(input.verified);
  const intent = validateCosmosSwapIntent(input.intent);
  const binding = input.binding;
  if (binding.chainId !== intent.chainId || binding.address !== intent.authority || binding.accountId !== `${intent.chainId}:${intent.authority}`) throw new Error("COSMOS_SIGNING_PREPARATION_ACCOUNT_MISMATCH");
  if (intent.quoteExpiresAt <= now || binding.expiresAt <= now) throw new Error("COSMOS_SIGNING_PREPARATION_EXPIRED");
  const verified = input.verified;
  if (verified.verifiedAt > now || verified.expiresAt <= now) throw new Error("COSMOS_SIGNING_PREPARATION_EVIDENCE_EXPIRED");
  if (verified.schema !== "realdex.verified-cosmos-swap.v1" || verified.execution !== "design-gate" || verified.executionEnabled !== false || verified.broadcastEnabled !== false || verified.venueId !== intent.venueId || verified.chainId !== intent.chainId || verified.sourceDebitBaseUnits !== intent.amountInBaseUnits || verified.destinationCreditBaseUnits !== intent.expectedOutBaseUnits) throw new Error("COSMOS_SIGNING_PREPARATION_EVIDENCE_MISMATCH");
  if (verified.publicKeyHex !== binding.publicKeyHex) throw new Error("COSMOS_SIGNING_PREPARATION_PUBLIC_KEY_MISMATCH");
  const [transactionSha256, intentSha256] = await Promise.all([
    cosmosSwapTransactionSha256(intent),
    cosmosSwapIntentSha256(intent)
  ]);
  if (transactionSha256 !== verified.transactionSha256 || intentSha256 !== verified.intentSha256) throw new Error("COSMOS_SIGNING_PREPARATION_HASH_MISMATCH");
  // The wallet key or source capability may be invalidated while hashing.
  const checkedAt = input.now ?? Date.now();
  if (checkedAt < now) throw new Error("COSMOS_SIGNING_PREPARATION_TIME_INVALID");
  await assertGenuineCosmosInjectedBinding(input.connection, binding, checkedAt);
  assertVerifiedSourceBoundOsmosisSwap(verified);
  const completedAt = input.now ?? Date.now();
  const expiresAt = Math.min(binding.expiresAt, intent.quoteExpiresAt, verified.expiresAt);
  if (completedAt < checkedAt || expiresAt <= completedAt) throw new Error("COSMOS_SIGNING_PREPARATION_EXPIRED");
  const identity = {
    walletId: binding.walletId, sessionId: binding.sessionId, accountId: binding.accountId,
    authority: binding.address, chainId: intent.chainId, venueId: intent.venueId,
    transactionSha256, signDocSha256: verified.signDocSha256, intentSha256,
    sourceFingerprint: verified.sourceFingerprint, routeFingerprint: verified.routeFingerprint,
    manifestPayloadHash: verified.manifestPayloadHash,
    readPolicySourceFingerprint: verified.readPolicySourceFingerprint,
    readPolicyPayloadHash: verified.readPolicyPayloadHash, expiresAt
  };
  const preparation: CosmosInjectedSigningPreparation = {
    schema: "realdex.cosmos-injected-signing-preparation.v1",
    preparationId: cryptographicFingerprint("realdex.cosmos-injected-signing-preparation.v1", identity),
    preparedAt: completedAt, expiresAt, walletId: binding.walletId, sessionId: binding.sessionId,
    accountId: binding.accountId, authority: binding.address, chainId: binding.chainId,
    walletChainId: binding.walletChainId, publicKeyHex: binding.publicKeyHex, hardware: binding.hardware,
    venueId: intent.venueId, executionTarget: verified.executionTarget, recipient: intent.recipient,
    sourceDenom: intent.sourceDenom, destinationDenom: intent.destinationDenom,
    amountInBaseUnits: intent.amountInBaseUnits, expectedOutBaseUnits: intent.expectedOutBaseUnits,
    minimumOutBaseUnits: intent.minimumOutBaseUnits, accountNumber: intent.accountNumber, sequence: intent.sequence,
    feeDenom: intent.feeDenom, feeAmountBaseUnits: intent.feeAmountBaseUnits, gasLimit: intent.gasLimit,
    timeoutHeight: intent.timeoutHeight, gasUsed: verified.gasUsed, transactionBase64: intent.transactionBase64,
    transactionSha256, signDocSha256: verified.signDocSha256, intentSha256,
    sourceFingerprint: verified.sourceFingerprint, routeFingerprint: verified.routeFingerprint,
    manifestPayloadHash: verified.manifestPayloadHash,
    readPolicySourceFingerprint: verified.readPolicySourceFingerprint,
    readPolicyPayloadHash: verified.readPolicyPayloadHash,
    requiresFreshVerification: true, signingEnabled: false, broadcastEnabled: false, executionEnabled: false
  };
  genuinePreparations.set(preparation, cryptographicFingerprint("realdex.cosmos-injected-signing-preparation.v1", preparation));
  return Object.freeze(preparation);
}

export function assertGenuineCosmosInjectedSigningPreparation(value: CosmosInjectedSigningPreparation): void {
  const expected = genuinePreparations.get(value);
  if (!expected) throw new Error("COSMOS_SIGNING_PREPARATION_NOT_AUTHENTIC");
  if (expected !== cryptographicFingerprint("realdex.cosmos-injected-signing-preparation.v1", value)) throw new Error("COSMOS_SIGNING_PREPARATION_CHANGED");
}
