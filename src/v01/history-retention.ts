import { getAddress } from "ethers";
import { assertCurrentV01Profile, type VerifiedV01Profile } from "../release/v01-profile";
import { routeDescriptorFingerprint } from "../routing/engine";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertEvmSwapRecoveryRecord, EVM_SWAP_RECOVERY_STORAGE_KEY, readEvmSwapRecoveryJournal, type EvmSwapRecoveryRecord } from "../swap/evm-swap-recovery";
import { readActiveV01Operation, withV01OperationLock } from "./active-operation";

export type V01HistoryExport = Readonly<{ filename: string; serialized: string; recordFingerprint: string; record: EvmSwapRecoveryRecord; expiresAt: number }>;
const issued = new WeakMap<V01HistoryExport, string>();
const fingerprint = (record: EvmSwapRecoveryRecord) => cryptographicFingerprint("realdex.v01-history-export.v1", record);

/** Stored confirmations are historical observations, not current chain finality. */
export function isV01HistorySettled(record: EvmSwapRecoveryRecord): boolean {
  assertEvmSwapRecoveryRecord(record);
  if (record.schema !== "realdex.evm-swap-recovery.v3" || !["swap-confirmed", "swap-reverted", "approval-reverted", "stopped-after-approval"].includes(record.stage)) return false;
  const swap = record.transactions.find(tx => tx.role === "swap"), approval = record.transactions.find(tx => tx.role === "approval");
  const terminal = record.stage.startsWith("swap-") ? swap : approval;
  if (!terminal || (!record.stage.startsWith("swap-") && swap)) return false;
  if (terminal.state !== (record.stage.endsWith("reverted") ? "reverted" : "confirmed")) return false;
  return record.transactions.every(tx => !tx.envelope?.replacement && (tx.state === "confirmed" || tx.state === "reverted") &&
    tx.blockNumber !== null && tx.blockHash !== null && tx.confirmations !== null && tx.confirmations >= Math.max(2, record.requiredConfirmations)) &&
    !(swap && approval?.state === "reverted");
}

/** Export only the selected validated record, never the entire origin's storage.
 * The browser cannot prove that the user saved/opened a download. The subsequent
 * removal therefore requires their explicit acknowledgement, not a download event.
 */
export async function prepareV01HistoryExport(expected: EvmSwapRecoveryRecord): Promise<V01HistoryExport> {
  assertEvmSwapRecoveryRecord(expected);
  const expectedFingerprint = fingerprint(expected);
  return withV01OperationLock(async () => {
    const record = readEvmSwapRecoveryJournal().find(item => item.recoveryId === expected.recoveryId);
    if (!record || fingerprint(record) !== expectedFingerprint || fingerprint(expected) !== expectedFingerprint) throw new Error("V01_HISTORY_CHANGED");
    const exportedAt = Date.now(), recordFingerprint = fingerprint(record);
    const serialized = JSON.stringify({ schema: "realdex.v01-history-export.v1", exportedAt, recordFingerprint, record }, null, 2);
    const result = Object.freeze({ filename: `realdex-history-${recordFingerprint.slice(2, 18)}.json`, serialized, recordFingerprint, record: structuredClone(record), expiresAt: exportedAt + 300_000 });
    issued.set(result, serialized);
    return result;
  });
}

/** Explicit one-record removal only. No active operation is ever cleared here.
 * Do not auto-evict on capacity exhaustion or retry an uncertain storage write.
 */
export async function removeV01ExportedHistory(options: {
  archive: V01HistoryExport; savedCopyConfirmed: boolean; profile: VerifiedV01Profile; isCurrent: () => boolean;
}): Promise<void> {
  const archive = options.archive, serialized = issued.get(archive), profile = options.profile;
  if (!serialized || serialized !== archive.serialized || options.savedCopyConfirmed !== true) throw new Error("V01_HISTORY_COPY_REQUIRED");
  return withV01OperationLock(async () => {
    if (issued.get(archive) !== serialized || options.savedCopyConfirmed !== true) throw new Error("V01_HISTORY_COPY_REQUIRED");
    assertCurrentV01Profile(profile);
    if (!options.isCurrent() || Date.now() >= archive.expiresAt || serialized !== archive.serialized || fingerprint(archive.record) !== archive.recordFingerprint) throw new Error("V01_HISTORY_CHANGED");
    if (readActiveV01Operation() !== null) throw new Error("V01_HISTORY_ACTIVE_OPERATION");
    const raw = localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY), records = readEvmSwapRecoveryJournal();
    const record = records.find(item => item.recoveryId === archive.record.recoveryId);
    if (!record || fingerprint(record) !== archive.recordFingerprint || !isV01HistorySettled(record)) throw new Error("V01_HISTORY_NOT_SETTLED");
    const route = profile.routes.find(item => item.id === record.routeId && routeDescriptorFingerprint(item) === record.routeFingerprint);
    if (!route || record.chainId !== "eip155:84532" || record.source.assetType !== route.sourceAsset || record.destination.assetType !== route.destinationAsset ||
        getAddress(record.executionTarget) !== getAddress(profile.profile.pool.address) || record.executionMethod !== route.executionMethod) throw new Error("V01_HISTORY_PROFILE_MISMATCH");
    const next = JSON.stringify({ schema: "localswap.evm-swap-recovery-journal.v1", records: records.filter(item => item.recoveryId !== record.recoveryId) });
    assertCurrentV01Profile(profile);
    if (!options.isCurrent() || readActiveV01Operation() !== null || localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY) !== raw) throw new Error("V01_HISTORY_CHANGED");
    // Consume before the write: if write/readback is uncertain, inspect current
    // history and explicitly export again. Never repeat deletion automatically.
    issued.delete(archive);
    localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, next);
    if (localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY) !== next) throw new Error("V01_HISTORY_REMOVAL_UNCONFIRMED");
  });
}
