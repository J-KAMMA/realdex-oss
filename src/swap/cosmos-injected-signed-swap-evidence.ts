import { base64 } from "@scure/base";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertGenuineCosmosInjectedBinding, type CosmosInjectedAccountBinding, type CosmosInjectedConnection } from "../wallet/cosmos-injected-session";
import { validateCosmosSwapIntent, validateCosmosVenueDescriptor, type CosmosSwapIntent, type CosmosVenueDescriptor } from "./cosmos-swap-boundary";
import { assertVerifiedSourceBoundOsmosisSwap, type VerifiedSourceBoundOsmosisSwap } from "./cosmos-venue-source";
import { assertGenuineCosmosInjectedSigningPreparation, type CosmosInjectedSigningPreparation } from "./cosmos-injected-signing-preparation";
import { verifySignedCosmosSwapTransaction, type VerifiedSignedCosmosSwapTransaction } from "./cosmos-swap-recovery";

const genuineEvidence = new WeakMap<object, string>();
const DOMAIN = "realdex.cosmos-injected-signed-swap-evidence.v1";

export type CosmosInjectedSignedSwapEvidence = Readonly<
  Omit<CosmosInjectedSigningPreparation, "schema" | "transactionBase64"> & VerifiedSignedCosmosSwapTransaction & {
    schema: typeof DOMAIN;
    evidenceId: string;
    acceptedAt: number;
    venueRevision: number;
    bech32Prefix: string;
    stage: "signed-not-submitted";
    signedTransactionBytesStored: false;
    automaticResendBlocked: true;
    requiresExplicitSubmissionAuthorization: true;
    submissionEnabled: false;
  }
>;

type Input = {
  connection: CosmosInjectedConnection;
  binding: CosmosInjectedAccountBinding;
  preparation: CosmosInjectedSigningPreparation;
  venue: CosmosVenueDescriptor;
  intent: CosmosSwapIntent;
  verified: VerifiedSourceBoundOsmosisSwap;
  signedTransactionBase64: string;
  transactionHash: string;
  now?: number;
};

/** Accepts already-signed bytes for verification, never signing, storing or broadcasting them. */
export async function verifyCosmosInjectedSignedSwap(inputValue: Input): Promise<CosmosInjectedSignedSwapEvidence> {
  // Freeze caller-owned selectors and primitive inputs before the first await.
  const input = { ...inputValue, intent: validateCosmosSwapIntent(inputValue.intent), venue: validateCosmosVenueDescriptor(inputValue.venue) };
  const now = validTime(input.now ?? Date.now());
  await assertCapabilities(input, now);
  assertBinding(input, now);
  const signed = await verifySignedCosmosSwapTransaction(input);
  const p = input.preparation;
  if (signed.unsignedTransactionSha256 !== p.transactionSha256 || signed.signDocSha256 !== p.signDocSha256 || signed.intentSha256 !== p.intentSha256 || hex(base64.decode(signed.publicKeyBase64)) !== p.publicKeyHex) throw new Error("COSMOS_SIGNED_SWAP_PREPARATION_MISMATCH");

  const checkedAt = validTime(input.now ?? Date.now());
  if (checkedAt < now) throw new Error("COSMOS_SIGNED_SWAP_TIME_INVALID");
  await assertCapabilities(input, checkedAt);
  const acceptedAt = validTime(input.now ?? Date.now());
  if (acceptedAt < checkedAt) throw new Error("COSMOS_SIGNED_SWAP_TIME_INVALID");
  assertBinding(input, acceptedAt);

  // Neither unsigned nor signed transaction bytes escape in the receipt.
  const { schema: _schema, transactionBase64: _bytes, ...summary } = p;
  const payload = {
    ...summary, ...signed, schema: DOMAIN, acceptedAt,
    venueRevision: input.venue.revision, bech32Prefix: input.venue.bech32Prefix,
    stage: "signed-not-submitted", signedTransactionBytesStored: false,
    automaticResendBlocked: true, requiresExplicitSubmissionAuthorization: true,
    submissionEnabled: false
  } as const;
  const evidence: CosmosInjectedSignedSwapEvidence = { ...payload, evidenceId: cryptographicFingerprint(DOMAIN, payload) };
  genuineEvidence.set(evidence, cryptographicFingerprint(DOMAIN, evidence));
  return Object.freeze(evidence);
}

export function assertGenuineCosmosInjectedSignedSwapEvidence(value: CosmosInjectedSignedSwapEvidence): void {
  const expected = genuineEvidence.get(value);
  if (!expected) throw new Error("COSMOS_SIGNED_SWAP_EVIDENCE_NOT_AUTHENTIC");
  if (expected !== cryptographicFingerprint(DOMAIN, value)) throw new Error("COSMOS_SIGNED_SWAP_EVIDENCE_CHANGED");
}

async function assertCapabilities(input: Input, now: number): Promise<void> {
  assertGenuineCosmosInjectedSigningPreparation(input.preparation);
  assertVerifiedSourceBoundOsmosisSwap(input.verified);
  await assertGenuineCosmosInjectedBinding(input.connection, input.binding, now);
  // Provider callbacks cannot change source evidence unnoticed during getKey.
  assertGenuineCosmosInjectedSigningPreparation(input.preparation);
  assertVerifiedSourceBoundOsmosisSwap(input.verified);
}

function assertBinding({ binding: b, preparation: p, intent: i, verified: v, venue }: Input, now: number): void {
  if (p.preparedAt > now || v.verifiedAt > now || p.expiresAt <= now || p.expiresAt !== Math.min(b.expiresAt, i.quoteExpiresAt, v.expiresAt)) throw new Error("COSMOS_SIGNED_SWAP_PREPARATION_EXPIRED");
  if (p.walletId !== b.walletId || p.sessionId !== b.sessionId || p.accountId !== b.accountId || p.authority !== b.address || p.chainId !== b.chainId || p.walletChainId !== b.walletChainId || p.publicKeyHex !== b.publicKeyHex || i.authority !== b.address || i.chainId !== b.chainId) throw new Error("COSMOS_SIGNED_SWAP_ACCOUNT_MISMATCH");
  if (p.transactionBase64 !== i.transactionBase64 || p.executionTarget !== venue.executionTarget || p.venueId !== venue.venueId) throw new Error("COSMOS_SIGNED_SWAP_INTENT_MISMATCH");
  for (const key of ["transactionSha256", "signDocSha256", "intentSha256", "publicKeyHex", "executionTarget", "sourceFingerprint", "routeFingerprint", "manifestPayloadHash", "readPolicySourceFingerprint", "readPolicyPayloadHash"] as const) {
    if (p[key] !== v[key]) throw new Error("COSMOS_SIGNED_SWAP_EVIDENCE_MISMATCH");
  }
  if (p.requiresFreshVerification !== true || p.signingEnabled !== false || p.broadcastEnabled !== false || p.executionEnabled !== false) throw new Error("COSMOS_SIGNED_SWAP_AUTHORITY_INVALID");
}

function validTime(value: number): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error("COSMOS_SIGNED_SWAP_TIME_INVALID"); return value; }
function hex(value: Uint8Array): string { return [...value].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
