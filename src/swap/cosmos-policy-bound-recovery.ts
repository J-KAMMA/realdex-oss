import { sha256 } from "@cosmjs/crypto";
import { assertGenuineCosmosInjectedSignedSwapEvidence, type CosmosInjectedSignedSwapEvidence } from "./cosmos-injected-signed-swap-evidence";
import { revalidateCosmosReadPolicy, type CosmosReadPolicyHead, type VerifiedCosmosReadPolicy } from "./cosmos-read-policy";
import { COSMOS_SWAP_RECOVERY_ID, createCosmosSwapRecoveryReaderQuorum, refreshCosmosSwapRecovery, snapshotCosmosSwapRecoveryRecord, type CosmosSwapRecoveryRecord } from "./cosmos-swap-recovery";

type Input = {
  evidence: CosmosInjectedSignedSwapEvidence;
  record: CosmosSwapRecoveryRecord;
  policy: VerifiedCosmosReadPolicy;
  /** Current accepted head for this exact pinned reviewer. No missing-head fallback. */
  readHead: (sourceFingerprint: string) => CosmosReadPolicyHead | undefined;
};
type Options = { fetchImpl?: typeof fetch; now?: () => number; signal?: AbortSignal; timeoutMs?: number };

/** Explicit read-only lookup. Does not call the wallet, save/release history, or
 * sign/submit/retry a transaction. Historical genuine signature evidence may be
 * expired; the current recovery read policy must not be. Imported evidence is not
 * an in-memory capability and needs a separately reviewed restoration path.
 */
export async function refreshPolicyBoundCosmosRecovery(inputValue: Input, optionsValue: Options = {}) {
  const { evidence, readHead } = inputValue;
  const { fetchImpl = fetch, now = Date.now, signal, timeoutMs = 8_000 } = optionsValue;
  assertGenuineCosmosInjectedSignedSwapEvidence(evidence);
  const record = snapshotCosmosSwapRecoveryRecord(inputValue.record);
  assertEvidenceBinding(record, evidence);
  let lastTime = record.updatedAt;
  const time = () => {
    let value: number;
    try { value = now(); } catch { throw new Error("COSMOS_RECOVERY_TIME_INVALID"); }
    if (!Number.isSafeInteger(value) || value < lastTime || value <= 0) throw new Error("COSMOS_RECOVERY_TIME_INVALID");
    lastTime = value;
    return value;
  };
  const active = () => { if (signal?.aborted) throw new Error("COSMOS_RECOVERY_CANCELLED"); };
  active();
  const startedAt = time();
  // Revalidation returns isolated, canonical source/policy data, never raw UI refs.
  const policy = revalidateCosmosReadPolicy(inputValue.policy, startedAt);
  if (policy.policy.recoveryBoundaryId !== COSMOS_SWAP_RECOVERY_ID) throw new Error("COSMOS_RECOVERY_POLICY_NOT_AUTHORIZED");
  if (policy.policy.chainId !== record.chainId) throw new Error("COSMOS_RECOVERY_POLICY_CHAIN_MISMATCH");
  if (policy.sourceFingerprint !== evidence.readPolicySourceFingerprint) throw new Error("COSMOS_RECOVERY_POLICY_SOURCE_MISMATCH");

  const gate = () => {
    active();
    const checkedAt = time();
    revalidateCosmosReadPolicy(policy, checkedAt);
    let head: CosmosReadPolicyHead | undefined;
    try {
      const current = readHead(policy.sourceFingerprint);
      if (!current || Object.keys(current).length !== 2 || !Object.hasOwn(current, "revision") || !Object.hasOwn(current, "payloadHash")) throw new Error();
      head = { revision: current.revision, payloadHash: current.payloadHash };
      if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || typeof head.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error();
    } catch { throw new Error("COSMOS_RECOVERY_POLICY_HEAD_UNAVAILABLE"); }
    if (head.revision !== policy.policy.revision || head.payloadHash !== policy.payloadHash) throw new Error("COSMOS_RECOVERY_POLICY_HEAD_MISMATCH");
    return checkedAt;
  };
  gate();

  // This wrapper is given only to readers constructed from the signed pair.
  const guardedFetch: typeof fetch = async (request, init) => {
    gate();
    const response = await fetchImpl(request, init);
    try { gate(); }
    catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    return response;
  };
  const lookupController = new AbortController();
  const readers = createCosmosSwapRecoveryReaderQuorum(policy.policy.restEndpoints, guardedFetch, timeoutMs, lookupController.signal);
  const abortLookup = () => lookupController.abort();
  signal?.addEventListener("abort", abortLookup, { once: true });
  if (signal?.aborted) abortLookup();
  let removeCancel = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error("COSMOS_RECOVERY_CANCELLED"));
    signal?.addEventListener("abort", abort, { once: true });
    removeCancel = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) abort();
  });
  try {
    const refreshed = await Promise.race([refreshCosmosSwapRecovery(record, readers, startedAt), cancelled]);
    const checkedAt = gate();
    assertGenuineCosmosInjectedSignedSwapEvidence(evidence);
    assertEvidenceBinding(refreshed, evidence);
    const completed = snapshotCosmosSwapRecoveryRecord({ ...refreshed, updatedAt: checkedAt });
    for (const observation of completed.observations) Object.freeze(observation);
    Object.freeze(completed.observations);
    return Object.freeze({
      record: Object.freeze(completed), checkedAt,
      policySourceFingerprint: policy.sourceFingerprint,
      policyPayloadHash: policy.payloadHash, policyRevision: policy.policy.revision,
      executionEnabled: false as const, broadcastEnabled: false as const, resendBlocked: true as const
    });
  } catch (error) {
    // A guarded fetch error may be normalized by the REST adapter. Re-check the
    // trusted local policy/head/clock so a stale result cannot hide that change.
    gate();
    const code = error instanceof Error && /^COSMOS_[A-Z0-9_]+$/.test(error.message) ? error.message : "COSMOS_RECOVERY_LOOKUP_FAILED";
    throw new Error(code);
  } finally { removeCancel(); signal?.removeEventListener("abort", abortLookup); lookupController.abort(); }
}

function assertEvidenceBinding(record: CosmosSwapRecoveryRecord, evidence: CosmosInjectedSignedSwapEvidence): void {
  const fields = ["chainId", "venueId", "venueRevision", "bech32Prefix", "executionTarget", "authority", "recipient", "sourceDenom", "destinationDenom", "amountInBaseUnits", "expectedOutBaseUnits", "minimumOutBaseUnits", "accountNumber", "sequence", "feeDenom", "feeAmountBaseUnits", "gasLimit", "timeoutHeight", "transactionHash", "signedTransactionSha256", "unsignedTransactionSha256", "signDocSha256", "intentSha256", "publicKeyBase64", "signatureSha256"] as const;
  const recoveryId = [...sha256(new TextEncoder().encode(`${evidence.chainId}|${evidence.venueId}|${evidence.intentSha256}|${evidence.transactionHash}`))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (fields.some(field => record[field] !== evidence[field]) || record.createdAt !== evidence.acceptedAt || record.recoveryId !== recoveryId) throw new Error("COSMOS_RECOVERY_EVIDENCE_MISMATCH");
}
