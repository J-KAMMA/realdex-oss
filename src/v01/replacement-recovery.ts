import { getAddress, toQuantity } from "ethers";
import { assertCurrentV01Profile, type VerifiedV01Profile } from "../release/v01-profile";
import { assertEvmSwapRecoveryRecord, type EvmSwapRecoveryRecord, type EvmSwapRecoveryTransaction } from "../swap/evm-swap-recovery";
import { cancellationEnvelope, sameEvmEnvelope } from "../swap/evm-transaction-lifecycle";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertActiveV01Operation, type ActiveV01Operation } from "./active-operation";
import { assertV01RecoveryIntentProfile } from "./recovery-intent";
import type { V01CandidateReader } from "./candidate-reconciliation";

const fingerprint = (value: unknown) => cryptographicFingerprint("realdex.v01-replacement-recovery.v1", value);
function fail(): never { throw new Error("V01_REPLACEMENT_RECOVERY_MISMATCH"); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return fail(); return value as Record<string, unknown>; }
function hash(value: unknown): string { if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return fail(); return value.toLowerCase(); }
function quantity(value: unknown): bigint { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) || value.length > 66) return fail(); return BigInt(value); }
function number(value: unknown): number { const result = quantity(value); if (result > BigInt(Number.MAX_SAFE_INTEGER)) return fail(); return Number(result); }
function address(value: unknown): string { if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) return fail(); return getAddress(value.toLowerCase()); }

/** Read-only close prerequisite for records containing a replacement. Caller must
 * hold the origin operation lock and recheck binding before write/clear. Never
 * signs, submits, adopts a guessed hash or itself releases an operation.
 * Same-nonce inclusion is not a guarantee of finality or reader independence.
 */
export async function verifyV01ReplacementRecovery(options: {
  operation: ActiveV01Operation; record: EvmSwapRecoveryRecord; profile: VerifiedV01Profile;
  readers: readonly V01CandidateReader[]; readOperation: () => ActiveV01Operation | null;
  readRecord: () => EvmSwapRecoveryRecord | undefined; isCurrent: () => boolean;
}): Promise<EvmSwapRecoveryRecord> {
  const started = Date.now(), deadline = started + 15_000;
  assertActiveV01Operation(options.operation); assertEvmSwapRecoveryRecord(options.record);
  const operation = structuredClone(options.operation), record = structuredClone(options.record), profile = options.profile;
  const operationBinding = fingerprint(operation), recordBinding = fingerprint(record);
  const check = () => {
    if (Date.now() < started || Date.now() >= deadline) throw new Error("V01_REPLACEMENT_RECOVERY_TIMEOUT");
    assertCurrentV01Profile(profile);
    if (!options.isCurrent() || fingerprint(options.operation) !== operationBinding || fingerprint(options.record) !== recordBinding ||
        fingerprint(options.readOperation()) !== operationBinding || fingerprint(options.readRecord()) !== recordBinding) throw new Error("V01_REPLACEMENT_RECOVERY_CONTEXT_CHANGED");
  };
  check();
  if (operation.schema !== "realdex.v01-active-operation.v3" || record.schema !== "realdex.evm-swap-recovery.v3") fail();
  const intent = operation.recovery;
  assertV01RecoveryIntentProfile(intent, profile);
  const route = profile.routes.find(item => item.id === intent.routeId)!;
  if (record.recoveryId !== intent.recoveryId || operation.recoveryId !== record.recoveryId || record.quoteId !== intent.quoteId || record.routeId !== intent.routeId ||
      record.routeFingerprint !== intent.routeFingerprint || record.requestFingerprint !== intent.requestFingerprint || record.chainId !== "eip155:84532" ||
      record.accountId !== intent.accountId || address(record.recipient) !== intent.recipient || address(record.executionTarget) !== intent.poolAddress || record.executionMethod !== route.executionMethod ||
      record.source.assetType !== intent.sourceAsset || record.destination.assetType !== intent.destinationAsset || record.source.amountBaseUnits !== intent.amountInBaseUnits ||
      record.destination.minimumOutBaseUnits !== intent.minimumOutBaseUnits || record.source.decimals !== 18 || record.destination.decimals !== 18) fail();
  if (!record.transactions.some(tx => tx.envelope?.replacement)) fail();
  const hasSwap = record.transactions.some(tx => tx.role === "swap");
  if ((hasSwap && intent.approvalRequired && !record.transactions.some(tx => tx.role === "approval")) ||
      (!hasSwap && operation.attempts.some(attempt => attempt.role === "swap") && record.stage !== "stopped-after-approval")) fail();
  const readers = options.readers.map(reader => ({ id: reader.id, send: reader.send.bind(reader) }));
  if (readers.length < 2 || readers.length > 4 || new Set(readers.map(reader => reader.id)).size !== readers.length ||
      JSON.stringify(readers.map(reader => reader.id).sort()) !== JSON.stringify([...profile.readerIds].sort())) fail();
  const read = async (reader: V01CandidateReader, method: string, params: unknown[]) => {
    check(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([reader.send(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("V01_REPLACEMENT_RECOVERY_TIMEOUT")), Math.max(1, deadline - Date.now())); })]);
      check(); return structuredClone(result);
    } catch (error) {
      if (error instanceof Error && ["V01_REPLACEMENT_RECOVERY_TIMEOUT", "V01_REPLACEMENT_RECOVERY_CONTEXT_CHANGED"].includes(error.message)) throw error;
      throw new Error("V01_REPLACEMENT_RECOVERY_READ_FAILED");
    } finally { clearTimeout(timer); }
  };
  const chain = async (reader: V01CandidateReader) => { if (quantity(await read(reader, "eth_chainId", [])) !== 84532n) fail(); };
  const observations = await Promise.all(record.transactions.map(async saved => {
    const attempt = operation.attempts.find(item => item.role === saved.role), original = saved.envelope;
    if (!attempt || !original) return fail();
    const tx = attempt.transaction;
    const base = { from: address(tx.from), to: address(tx.to), nonce: number(tx.nonce), data: tx.data.toLowerCase(), valueBaseUnits: BigInt(tx.value).toString(), chainId: "84532" };
    if (!sameEvmEnvelope(original, base) || original.observedBeforeBlock !== attempt.observedBeforeBlock) fail();
    const replacement = original.replacement, expected = replacement ?? original, expectedHash = hash(replacement?.hash ?? saved.hash);
    const reason = replacement ? (sameEvmEnvelope(replacement, original) ? "repriced" : cancellationEnvelope(replacement) ? "cancelled" : "replaced") : undefined;
    if (replacement && (hash(saved.hash) === expectedHash || address(replacement.from) !== address(original.from) || replacement.nonce !== original.nonce || replacement.chainId !== original.chainId || replacement.reason !== reason)) fail();
    const values = await Promise.all(readers.map(async reader => {
      await chain(reader);
      const observed = object(await read(reader, "eth_getTransactionByHash", [expectedHash]));
      if (hash(observed.hash) !== expectedHash || address(observed.from) !== address(expected.from) || address(observed.to) !== address(expected.to) ||
          typeof observed.input !== "string" || observed.input.toLowerCase() !== expected.data.toLowerCase() || number(observed.nonce) !== expected.nonce ||
          quantity(observed.chainId).toString() !== expected.chainId || quantity(observed.value).toString() !== expected.valueBaseUnits) fail();
      // Non-replaced requests must still match the exact saved fee envelope. A
      // replacement deliberately has a different envelope; do not call it original.
      if (!replacement) {
        if (!Array.isArray(observed.accessList) || observed.accessList.length !== 0) fail();
        for (const field of ["type", "gas", "maxFeePerGas", "maxPriorityFeePerGas"] as const) if (quantity(observed[field]) !== quantity(tx[field])) fail();
      }
      const receipt = object(await read(reader, "eth_getTransactionReceipt", [expectedHash]));
      const blockNumber = number(receipt.blockNumber), blockHash = hash(receipt.blockHash), status = quantity(receipt.status);
      if (hash(receipt.transactionHash) !== expectedHash || address(receipt.from) !== address(expected.from) || address(receipt.to) !== address(expected.to) ||
          number(observed.blockNumber) !== blockNumber || hash(observed.blockHash) !== blockHash || blockNumber <= original.observedBeforeBlock || (status !== 0n && status !== 1n) ||
          (saved.blockHash !== null && (saved.blockHash.toLowerCase() !== blockHash || saved.blockNumber !== blockNumber))) fail();
      const canonical = async () => {
        const block = object(await read(reader, "eth_getBlockByNumber", [toQuantity(blockNumber), false]));
        if (number(block.number) !== blockNumber || hash(block.hash) !== blockHash || !Array.isArray(block.transactions) || block.transactions.filter(item => typeof item === "string" && item.toLowerCase() === expectedHash).length !== 1) fail();
      };
      await canonical();
      const head = number(await read(reader, "eth_blockNumber", []));
      if (head < blockNumber + 1) throw new Error("V01_REPLACEMENT_RECOVERY_CONFIRMATIONS_REQUIRED");
      return { reader, blockNumber, blockHash, status: Number(status), head, canonical };
    }));
    const first = values[0];
    if (values.some(value => value.blockNumber !== first.blockNumber || value.blockHash !== first.blockHash || value.status !== first.status)) fail();
    const state = replacement && reason !== "repriced" ? "replaced" : first.status === 1 ? "confirmed" : "reverted";
    if (["confirmed", "reverted", "replaced"].includes(saved.state) && saved.state !== state) fail();
    return { saved, state: state as EvmSwapRecoveryTransaction["state"], values };
  }));
  const all = observations.flatMap(item => item.values), head = Math.min(...all.map(item => item.head));
  const heads = await Promise.all(all.map(async item => {
    if (head < item.blockNumber + 1) throw new Error("V01_REPLACEMENT_RECOVERY_CONFIRMATIONS_REQUIRED");
    const block = object(await read(item.reader, "eth_getBlockByNumber", [toQuantity(head), false]));
    if (number(block.number) !== head) fail();
    const headHash = hash(block.hash); await item.canonical(); await chain(item.reader); return headHash;
  }));
  if (heads.some(item => item !== heads[0])) fail();
  const transactions = observations.map(({ saved, state, values }) => ({ ...saved, state, blockNumber: values[0].blockNumber, blockHash: values[0].blockHash, confirmations: head - values[0].blockNumber + 1 }));
  const approval = transactions.find(tx => tx.role === "approval"), swap = transactions.find(tx => tx.role === "swap");
  if (approval && swap && (approval.state !== "confirmed" || approval.blockNumber > swap.blockNumber)) fail();
  const stage = swap ? (swap.state === "replaced" ? "swap-replaced" : swap.state === "confirmed" ? "swap-confirmed" : "swap-reverted")
    : approval?.state === "replaced" ? "approval-replaced" : approval?.state === "reverted" ? "approval-reverted" : record.stage === "stopped-after-approval" ? "stopped-after-approval" : "approval-confirmed";
  check();
  return assertEvmSwapRecoveryRecord({ ...record, stage, transactions, revision: record.revision + 1, updatedAt: Date.now() });
}
