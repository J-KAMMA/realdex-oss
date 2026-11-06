import { getAddress } from "ethers";
import { assertCurrentV01Profile, type VerifiedV01Profile } from "../release/v01-profile";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { EVM_SWAP_RECOVERY_STORAGE_KEY, assertEvmSwapRecoveryRecord, readEvmSwapRecoveryJournal, writeEvmSwapRecoveryRecord, type EvmSwapRecoveryRecord, type EvmSwapRecoveryTransaction } from "../swap/evm-swap-recovery";
import { assertActiveV01Operation, readActiveV01Operation, saveActiveV01Operation, withV01OperationLock, type ActiveV01Operation } from "./active-operation";
import { verifyV01Candidate, type V01CandidateObservation, type V01CandidateReader } from "./candidate-reconciliation";
import { assertV01RecoveryIntentProfile } from "./recovery-intent";
import type { V01SendAttempt } from "./send-attempt";

const fingerprint = (value: unknown) => cryptographicFingerprint("realdex.v01-adoption.v1", value);
function fail(): never { throw new Error("V01_CANDIDATE_ADOPTION_MISMATCH"); }
function envelope(attempt: V01SendAttempt) {
  const tx = attempt.transaction;
  return { from: getAddress(tx.from), to: getAddress(tx.to), nonce: Number(BigInt(tx.nonce)), data: tx.data.toLowerCase(), valueBaseUnits: BigInt(tx.value).toString(), chainId: BigInt(tx.chainId).toString(), observedBeforeBlock: attempt.observedBeforeBlock };
}

/** Explicit local journal mutation only. Re-observes every retained hash under the
 * operation lock; never connects, signs, resends or clears the active operation.
 * Journal-first persistence allows a fresh retry to repair a failed ID attachment.
 * Local storage remains unsigned; reader agreement is not a finality guarantee.
 */
export async function adoptV01Candidate(options: {
  operation: ActiveV01Operation; expected: V01CandidateObservation; profile: VerifiedV01Profile;
  readers: readonly V01CandidateReader[]; isCurrent: () => boolean;
}): Promise<EvmSwapRecoveryRecord> {
  // Capture caller-owned values before waiting for the lock or RPC.
  const operation = structuredClone(options.operation), expected = structuredClone(options.expected);
  const profile = options.profile, binding = fingerprint(operation), expectedBinding = fingerprint(expected);
  const readers = options.readers.map(reader => ({ id: reader.id, send: reader.send.bind(reader) }));
  return withV01OperationLock(async () => {
    assertActiveV01Operation(operation);
    if (operation.schema !== "realdex.v01-active-operation.v3") throw new Error("V01_ORIGINAL_RECOVERY_INTENT_REQUIRED");
    const intent = operation.recovery;
    assertV01RecoveryIntentProfile(intent, profile);
    const journalBefore = localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY);
    const check = () => {
      assertCurrentV01Profile(profile);
      if (!options.isCurrent() || fingerprint(options.operation) !== binding || fingerprint(options.expected) !== expectedBinding ||
          fingerprint(readActiveV01Operation()) !== binding || localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY) !== journalBefore) throw new Error("V01_CANDIDATE_CONTEXT_CHANGED");
    };
    check();
    if (expected.status !== "candidate-matched" || expected.intentId !== operation.intentId || expected.quoteId !== operation.quoteId || expected.profileFingerprint !== operation.profileFingerprint ||
        !["approval", "swap"].includes(expected.role) || !Number.isSafeInteger(expected.checkedAt) || expected.checkedAt > Date.now() || Date.now() - expected.checkedAt > 60_000) fail();
    const previous = readEvmSwapRecoveryJournal().find(item => item.recoveryId === intent.recoveryId);
    if (operation.recoveryId !== null && !previous) fail();
    const route = profile.routes.find(item => item.id === intent.routeId)!;
    const symbol = (asset: string) => getAddress(asset.split("/erc20:")[1]) === getAddress(profile.profile.tokens.ambr) ? "AMBR" : "JADE";
    const fixed = {
      schema: "realdex.evm-swap-recovery.v3" as const, recoveryId: intent.recoveryId, routeId: intent.routeId, routeFingerprint: intent.routeFingerprint,
      quoteId: intent.quoteId, requestFingerprint: intent.requestFingerprint, chainId: "eip155:84532", accountId: intent.accountId, recipient: intent.recipient,
      source: { assetType: intent.sourceAsset, symbol: symbol(intent.sourceAsset), decimals: 18, amountBaseUnits: intent.amountInBaseUnits },
      destination: { assetType: intent.destinationAsset, symbol: symbol(intent.destinationAsset), decimals: 18, minimumOutBaseUnits: intent.minimumOutBaseUnits },
      executionTarget: intent.poolAddress, executionMethod: route.executionMethod, provider: "RealDEX Pool v1", requiredConfirmations: 2
    };
    if (previous) {
      // Do not reinterpret a different route, quote, display, or legacy journal.
      for (const key of Object.keys(fixed) as (keyof typeof fixed)[]) if (fingerprint(previous[key]) !== fingerprint(fixed[key])) fail();
      if (previous.createdAt < intent.capturedAt || previous.updatedAt > Date.now()) fail();
      for (const transaction of previous.transactions) {
        const attempt = operation.attempts.find(item => item.role === transaction.role);
        if (!attempt || fingerprint(transaction.envelope) !== fingerprint(envelope(attempt))) fail();
      }
    }
    const priorSelected = previous?.transactions.find(item => item.role === expected.role);
    if (priorSelected && priorSelected.hash.toLowerCase() !== expected.hash.toLowerCase()) fail();
    const hashes = new Map(previous?.transactions.map(item => [item.role, item.hash]) ?? []);
    hashes.set(expected.role, expected.hash);
    if (hashes.has("swap") && intent.approvalRequired && !hashes.has("approval")) throw new Error("V01_ADOPT_APPROVAL_FIRST");
    const observations = new Map<"approval" | "swap", V01CandidateObservation>();
    for (const [role, hash] of hashes) {
      const observation = await verifyV01Candidate({ operation, role, hash, profile, readers, readOperation: readActiveV01Operation, isCurrent: () => { check(); return true; } });
      if (observation.confirmations < 2) throw new Error("V01_CANDIDATE_CONFIRMATIONS_REQUIRED");
      observations.set(role, observation);
    }
    check();
    const selected = observations.get(expected.role)!;
    // A new head is fine; changed inclusion/result/request requires a new preview.
    for (const key of ["hash", "attemptFingerprint", "blockNumber", "blockHash", "receiptStatus"] as const) if (selected[key] !== expected[key]) fail();
    const approval = observations.get("approval"), swap = observations.get("swap");
    if (approval && swap && (approval.receiptStatus !== 1 || approval.blockNumber > swap.blockNumber)) fail();
    const transactions: EvmSwapRecoveryTransaction[] = [];
    for (const role of ["approval", "swap"] as const) {
      const observed = observations.get(role); if (!observed) continue;
      const attempt = operation.attempts.find(item => item.role === role)!;
      const prior = previous?.transactions.find(item => item.role === role);
      if (prior?.blockHash && (prior.blockHash.toLowerCase() !== observed.blockHash || prior.blockNumber !== observed.blockNumber ||
          (prior.state === "confirmed" && observed.receiptStatus !== 1) || (prior.state === "reverted" && observed.receiptStatus !== 0))) fail();
      transactions.push({ role, hash: observed.hash, state: observed.receiptStatus === 1 ? "confirmed" : "reverted", blockNumber: observed.blockNumber,
        blockHash: observed.blockHash, confirmations: observed.confirmations, envelope: prior?.envelope ?? envelope(attempt), nextSearchBlock: prior?.nextSearchBlock ?? attempt.observedBeforeBlock + 1 });
    }
    const stage = swap ? (swap.receiptStatus === 1 ? "swap-confirmed" : "swap-reverted") : approval!.receiptStatus === 1 ? "approval-confirmed" : "approval-reverted";
    const record: EvmSwapRecoveryRecord = { ...fixed, executionId: previous?.executionId ?? `v01-manual-recovery:${intent.recoveryId}`, stage, transactions,
      revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? intent.capturedAt, updatedAt: Date.now() };
    assertEvmSwapRecoveryRecord(record);
    check();
    writeEvmSwapRecoveryRecord(record);
    // No await between the final binding check and the two durable writes. A
    // failed second write leaves the operation reserved, never silently closed.
    if (fingerprint(readActiveV01Operation()) !== binding) throw new Error("V01_CANDIDATE_CONTEXT_CHANGED");
    saveActiveV01Operation({ ...operation, recoveryId: intent.recoveryId });
    return record;
  });
}
