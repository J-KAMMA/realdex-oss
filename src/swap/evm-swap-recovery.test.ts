import { describe, expect, it } from "vitest";
import { routeDescriptorFingerprint, routeRequestFingerprint } from "../routing/engine";
import type { RouteExecutionReceipt, RouteQuote, RouteQuoteRequest } from "../routing/types";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { canCloseV01Operation, type ActiveV01Operation } from "../v01/active-operation";
import { createLocalAmmRouteDescriptor } from "./evm-local-amm";
import { EVM_SWAP_RECOVERY_STORAGE_KEY, assertEvmSwapRecoveryCapacity, assertEvmSwapRecoveryRecord, readEvmSwapRecoveryJournal, recordEvmSwapReceipt, refreshEvmSwapRecovery, writeEvmSwapRecoveryRecord, type EvmSwapRecoveryReader } from "./evm-swap-recovery";

const pool = "0x1000000000000000000000000000000000000001";
const tokenIn = "0x2000000000000000000000000000000000000002";
const tokenOut = "0x3000000000000000000000000000000000000003";
const account = "0x4000000000000000000000000000000000000004";
const approvalHash = `0x${"a".repeat(64)}`;
const swapHash = `0x${"b".repeat(64)}`;
const blockHash = `0x${"c".repeat(64)}`;
const replacementHash = `0x${"d".repeat(64)}`;
const route = createLocalAmmRouteDescriptor({ chainId: 31337n, poolAddress: pool, tokenIn, tokenOut });

function fixture() {
  const now = Date.now();
  const accountId = `eip155:31337:${account}`;
  const request: RouteQuoteRequest = {
    executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000030",
    sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset, amountInBaseUnits: 1_000_000n,
    accountId, recipient: account, walletCapabilityId: "eip1193", sessionRevision: 3,
    walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId, walletCapabilityId: "eip1193", sessionRevision: 3, expiresAt: now + 120_000 }), slippageBps: 50
  };
  const quote: RouteQuote = {
    quoteId: "quote:recovery:1", routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), requestFingerprint: routeRequestFingerprint(request), adapterId: route.adapterId,
    amountInBaseUnits: request.amountInBaseUnits, expectedOutBaseUnits: 900_000n, minimumOutBaseUnits: 895_500n, fees: [], unpricedCosts: [], expiresAt: now + 60_000, estimatedSeconds: null,
    authorization: { type: "approval", spender: pool, amountBaseUnits: request.amountInBaseUnits, expiresAt: null }, executionPreview: { chainId: "eip155:31337", target: pool, method: "swapExactIn", valueBaseUnits: 0n }, adapterData: { format: "test", value: {} }
  };
  const display = { sourceSymbol: "TKA", sourceDecimals: 6, destinationSymbol: "TKB", destinationDecimals: 6 };
  return { now, request, quote, display };
}

function receipt(steps: RouteExecutionReceipt["steps"], state: RouteExecutionReceipt["state"] = "pending"): RouteExecutionReceipt {
  const bound = steps.map((step) => step.kind && step.txHash && !step.evmTransaction ? {
    ...step,
    evmTransaction: {
      from: account, to: step.kind === "approval" ? tokenIn : pool, nonce: step.kind === "approval" ? 6 : 7,
      data: step.kind === "approval" ? "0x1234" : "0x5678", valueBaseUnits: "0", chainId: "31337", observedBeforeBlock: 90
    }
  } : step);
  return { executionId: `evm-swap:${swapHash}`, quoteId: "quote:recovery:1", state, provider: "RealDEX Pool v1", steps: bound };
}

const envelope = { from: account, to: pool, nonce: 7, data: "0x1234", valueBaseUnits: "0", chainId: "31337", observedBeforeBlock: 90 } as const;

function v3Submitted() {
  const { now, request, quote, display } = fixture();
  return { now, record: recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Swap", state: "submitted", kind: "swap", txHash: swapHash, evmTransaction: envelope }]), display, undefined, now)! };
}

function reader(values: Partial<EvmSwapRecoveryReader> = {}): EvmSwapRecoveryReader {
  return {
    chainId: async () => 31337n,
    blockNumber: async () => 100,
    receipt: async (hash) => ({ transactionHash: hash, status: 1, blockNumber: 100, blockHash }),
    transaction: async () => null,
    transactionCount: async () => 0,
    block: async (number) => ({ number, hash: blockHash, transactions: [] }),
    ...values
  };
}

describe("EVM swap recovery journal", () => {
  it.each(["cancelled", "replaced"])("preserves %s after replacement discovery precedes its receipt", async reason => {
    const { now, record } = v3Submitted();
    const replacement = { ...envelope, hash: replacementHash, to: reason === "cancelled" ? envelope.from : tokenOut, data: "0x", blockNumber: 92 };
    const observations = reader({
      receipt: async () => null,
      transaction: async hash => hash === replacementHash ? replacement : null,
      transactionCount: async () => 8,
      block: async number => ({ number, hash: blockHash, transactions: number === 92 ? [replacement] : [] })
    });
    const searching = await refreshEvmSwapRecovery(record, observations, now + 1);
    expect(searching.transactions[0].envelope?.replacement?.reason).toBe(reason);
    expect(searching.transactions[0].state).toBe("searching");
    const settled = await refreshEvmSwapRecovery(searching, { ...observations, receipt: async hash => hash === replacementHash ? { transactionHash: hash, status: 1, blockNumber: 92, blockHash } : null }, now + 2);
    expect(settled.stage).toBe("swap-replaced");
    expect(settled.transactions[0]).toMatchObject({ hash: swapHash, state: "replaced", confirmations: 9 });
  });

  it.each([{ from: tokenOut }, { nonce: 8 }, { chainId: "1" }, { reason: "cancelled" }, { hash: swapHash }])("rejects corrupted replacement identity or reason: %j", async change => {
    const { now, record } = v3Submitted();
    const changed = structuredClone(record);
    const { observedBeforeBlock: _omitted, ...replacementEnvelope } = envelope;
    changed.transactions[0].envelope!.replacement = { ...replacementEnvelope, hash: replacementHash, reason: "repriced", ...change } as NonNullable<typeof changed.transactions[0]["envelope"]>["replacement"];
    await expect(refreshEvmSwapRecovery(changed, reader(), now + 1)).rejects.toThrow("EVM_SWAP_RECOVERY_REPLACEMENT_MISMATCH");
  });
  it("requires explicit no-send evidence before a failed approval-only receipt permits closing", async () => {
    const { now, request, quote, display } = fixture();
    const failed = receipt([{ name: "Approval", state: "confirmed", kind: "approval", txHash: approvalHash }], "failed");
    const unknown = recordEvmSwapReceipt(route, request, quote, failed, display, undefined, now)!;
    expect(unknown.stage).toBe("unknown");
    const active: ActiveV01Operation = { schema: "realdex.v01-active-operation.v1", intentId: request.executionIntentId, quoteId: quote.quoteId, profileFingerprint: `0x${"e".repeat(64)}`, recoveryId: unknown.recoveryId };
    expect(canCloseV01Operation(active, unknown)).toBe(false);
    const approvalReader = reader({ blockNumber: async () => 102, transaction: async hash => ({ ...unknown.transactions[0].envelope!, hash, blockNumber: 100 }) });
    const refreshed = await refreshEvmSwapRecovery(unknown, approvalReader, now + 1);
    expect(refreshed.stage).toBe("approval-confirmed");
    expect(refreshed.transactions[0].confirmations).toBe(3);
    expect(canCloseV01Operation(active, refreshed)).toBe(false);
    const proven = recordEvmSwapReceipt(route, request, quote, { ...failed, failureProof: { type: "no-value-transfer-submitted" } }, display, undefined, now)!;
    expect(proven.stage).toBe("stopped-after-approval");
    const provenRefreshed = await refreshEvmSwapRecovery(proven, approvalReader, now + 1);
    expect(provenRefreshed.stage).toBe("stopped-after-approval");
    expect(canCloseV01Operation(active, provenRefreshed)).toBe(true);
  });

  it("binds an approval submission to the exact route, quote, account, values, and target", () => {
    const { now, request, quote, display } = fixture();
    const record = recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Exact token approval", state: "submitted", kind: "approval", txHash: approvalHash }]), display, undefined, now)!;
    expect(record.stage).toBe("approval-submitted");
    expect(record).toMatchObject({ chainId: "eip155:31337", accountId: request.accountId, routeFingerprint: quote.routeFingerprint, quoteId: quote.quoteId, executionTarget: pool });
    expect(record.source.amountBaseUnits).toBe("1000000");
    expect(record.destination.minimumOutBaseUnits).toBe("895500");
  });

  it("advances from approval to swap without accepting a changed transaction identity", () => {
    const { now, request, quote, display } = fixture();
    const approval = recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Approval", state: "confirmed", kind: "approval", txHash: approvalHash }]), display, undefined, now)!;
    const swap = recordEvmSwapReceipt(route, request, quote, receipt([
      { name: "Approval", state: "confirmed", kind: "approval", txHash: approvalHash },
      { name: "Swap", state: "submitted", kind: "swap", txHash: swapHash }
    ]), display, approval, now + 1)!;
    expect(swap.stage).toBe("swap-submitted");
    expect(swap.revision).toBe(2);
    expect(() => recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Swap", state: "submitted", kind: "swap", txHash: `0x${"d".repeat(64)}` }]), display, swap, now + 2)).toThrow("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
  });

  it("distinguishes inclusion from the required confirmation threshold", async () => {
    const { now, request, quote, display } = fixture();
    const submitted = recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Swap", state: "submitted", kind: "swap", txHash: swapHash }]), display, undefined, now)!;
    const included = await refreshEvmSwapRecovery(submitted, reader(), now + 1);
    expect(included.stage).toBe("swap-included");
    expect(included.transactions[0].confirmations).toBe(1);
    const confirmed = await refreshEvmSwapRecovery(included, reader({ blockNumber: async () => 101 }), now + 2);
    expect(confirmed.stage).toBe("swap-confirmed");
    expect(confirmed.transactions[0].confirmations).toBe(2);
  });

  it("records a reverted swap as terminal failure", async () => {
    const { now, request, quote, display } = fixture();
    const submitted = recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Swap", state: "submitted", kind: "swap", txHash: swapHash }]), display, undefined, now)!;
    const reverted = await refreshEvmSwapRecovery(submitted, reader({ receipt: async (hash) => ({ transactionHash: hash, status: 0, blockNumber: 99, blockHash }) }), now + 1);
    expect(reverted.stage).toBe("swap-reverted");
  });

  it("fails closed on the wrong chain and on disappearance of previously observed evidence", async () => {
    const { now, request, quote, display } = fixture();
    const submitted = recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Swap", state: "submitted", kind: "swap", txHash: swapHash }]), display, undefined, now)!;
    await expect(refreshEvmSwapRecovery(submitted, reader({ chainId: async () => 1n }), now + 1)).rejects.toThrow("EVM_SWAP_RECOVERY_CHAIN_MISMATCH");
    const included = await refreshEvmSwapRecovery(submitted, reader(), now + 1);
    await expect(refreshEvmSwapRecovery(included, reader({ receipt: async () => null }), now + 2)).rejects.toThrow("EVM_SWAP_RECOVERY_RECEIPT_REGRESSED");
  });

  it("keeps a never-observed receipt pending instead of authorizing a retry", async () => {
    const { now, request, quote, display } = fixture();
    const submitted = recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Swap", state: "submitted", kind: "swap", txHash: swapHash }]), display, undefined, now)!;
    const next = await refreshEvmSwapRecovery(submitted, reader({ receipt: async () => null }), now + 1);
    expect(next.stage).toBe("swap-submitted");
    expect(next.transactions[0].confirmations).toBe(0);
  });

  it("finds and confirms an exact fee-only nonce replacement", async () => {
    const { now, record } = v3Submitted();
    expect(record.schema).toBe("realdex.evm-swap-recovery.v3");
    const replacement = { ...envelope, hash: replacementHash, blockNumber: 92 };
    const next = await refreshEvmSwapRecovery(record, reader({
      receipt: async (hash) => hash === replacementHash ? { transactionHash: hash, status: 1, blockNumber: 92, blockHash } : null,
      transactionCount: async () => 8,
      block: async (number) => ({ number, hash: blockHash, transactions: number === 92 ? [replacement] : [] })
    }), now + 1);
    expect(next.stage).toBe("swap-confirmed");
    expect(next.transactions[0]).toMatchObject({ state: "confirmed", envelope: { replacement: { hash: replacementHash, reason: "repriced" } } });
  });

  it("marks a cancellation replacement as terminal non-success", async () => {
    const { now, record } = v3Submitted();
    const cancellation = { ...envelope, hash: replacementHash, to: account, data: "0x", blockNumber: 92 };
    const next = await refreshEvmSwapRecovery(record, reader({
      receipt: async (hash) => hash === replacementHash ? { transactionHash: hash, status: 1, blockNumber: 92, blockHash } : null,
      transactionCount: async () => 8,
      block: async (number) => ({ number, hash: blockHash, transactions: number === 92 ? [cancellation] : [] })
    }), now + 1);
    expect(next.stage).toBe("swap-replaced");
    expect(next.transactions[0]).toMatchObject({ state: "replaced", envelope: { replacement: { reason: "cancelled" } } });
  });

  it("bounds each replacement scan and persists the next block cursor", async () => {
    const { now, record } = v3Submitted();
    const next = await refreshEvmSwapRecovery(record, reader({ blockNumber: async () => 200, transactionCount: async () => 8, receipt: async () => null }), now + 1);
    expect(next.stage).toBe("replacement-searching");
    expect(next.transactions[0]).toMatchObject({ state: "searching", nextSearchBlock: 115 });
  });

  it("persists a bounded revisioned journal and rejects stale overwrites", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const { now, request, quote, display } = fixture();
    const first = recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Swap", state: "submitted", kind: "swap", txHash: swapHash }]), display, undefined, now)!;
    writeEvmSwapRecoveryRecord(first, storage);
    expect(readEvmSwapRecoveryJournal(storage)[0]).toEqual(first);
    expect(() => writeEvmSwapRecoveryRecord(first, storage)).toThrow("EVM_SWAP_RECOVERY_REVISION_NOT_ADVANCED");
  });

  it("rejects unknown persisted fields instead of trusting modified browser storage", () => {
    const values = new Map([[EVM_SWAP_RECOVERY_STORAGE_KEY, JSON.stringify({ schema: "localswap.evm-swap-recovery-journal.v1", records: [], injected: true })]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(() => readEvmSwapRecoveryJournal(storage)).toThrow("EVM_SWAP_RECOVERY_STORAGE_INVALID");
  });

  it("rejects dropped, modified, and throwing storage writes", () => {
    const { record } = v3Submitted();
    expect(() => writeEvmSwapRecoveryRecord(record, { getItem: () => null, setItem: () => {} })).toThrow("EVM_SWAP_RECOVERY_STORAGE_NOT_CONFIRMED");
    let value: string | null = null;
    expect(() => writeEvmSwapRecoveryRecord(record, { getItem: () => value, setItem: () => { value = "{}"; } })).toThrow("EVM_SWAP_RECOVERY_STORAGE_NOT_CONFIRMED");
    expect(() => writeEvmSwapRecoveryRecord(record, { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } })).toThrow("quota exceeded");
  });

  it("preserves all sixteen records, blocks new records, and still permits recovery updates", async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const { now, record } = v3Submitted();
    for (let index = 1; index <= 16; index++) {
      assertEvmSwapRecoveryCapacity(storage);
      writeEvmSwapRecoveryRecord({ ...record, recoveryId: `0x${index.toString(16).padStart(64, "0")}` }, storage);
    }
    const before = storage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY);
    expect(() => assertEvmSwapRecoveryCapacity(storage)).toThrow("EVM_SWAP_RECOVERY_STORAGE_FULL");
    expect(() => writeEvmSwapRecoveryRecord(record, storage)).toThrow("EVM_SWAP_RECOVERY_STORAGE_FULL");
    expect(storage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY)).toBe(before);
    const first = readEvmSwapRecoveryJournal(storage)[0];
    const next = await refreshEvmSwapRecovery(first, reader(), now + 1);
    writeEvmSwapRecoveryRecord(next, storage);
    expect(readEvmSwapRecoveryJournal(storage)).toHaveLength(16);
    expect(readEvmSwapRecoveryJournal(storage)[0]).toEqual(next);
  });

  it("does not allow a higher revision to rewrite identity or discard submitted evidence", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const { now, request, quote, display } = fixture();
    const original = recordEvmSwapReceipt(route, request, quote, receipt([
      { name: "Approval", state: "confirmed", kind: "approval", txHash: approvalHash },
      { name: "Swap", state: "submitted", kind: "swap", txHash: swapHash }
    ]), display, undefined, now)!;
    writeEvmSwapRecoveryRecord(original, storage);
    const next = { ...original, revision: 2, updatedAt: now + 1 };
    expect(() => writeEvmSwapRecoveryRecord({ ...next, recipient: tokenOut }, storage)).toThrow("EVM_SWAP_RECOVERY_IDENTITY_CHANGED");
    expect(() => writeEvmSwapRecoveryRecord({ ...next, transactions: [next.transactions[1]] }, storage)).toThrow("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
    expect(() => writeEvmSwapRecoveryRecord({ ...next, transactions: next.transactions.map(tx => ({ ...tx, hash: replacementHash })) }, storage)).toThrow("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
    expect(() => writeEvmSwapRecoveryRecord({ ...next, transactions: next.transactions.map(tx => ({ ...tx, envelope: { ...tx.envelope!, nonce: 99 } })) }, storage)).toThrow("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
    expect(() => writeEvmSwapRecoveryRecord({ ...next, stage: "approval-submitted" }, storage)).toThrow("EVM_SWAP_RECOVERY_STAGE_REGRESSION");
    expect(readEvmSwapRecoveryJournal(storage)).toEqual([original]);
  });

  it("preserves replacement evidence when updating a persisted record", async () => {
    const { now, record } = v3Submitted();
    const replaced = await refreshEvmSwapRecovery(record, reader({
      receipt: async hash => hash === replacementHash ? { transactionHash: hash, status: 1, blockNumber: 92, blockHash } : null,
      transactionCount: async () => 8,
      block: async number => ({ number, hash: blockHash, transactions: number === 92 ? [{ ...envelope, hash: replacementHash, blockNumber: 92 }] : [] })
    }), now + 1);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeEvmSwapRecoveryRecord(replaced, storage);
    expect(() => writeEvmSwapRecoveryRecord({ ...replaced, revision: replaced.revision + 1, transactions: replaced.transactions.map(tx => ({ ...tx, envelope })) }, storage)).toThrow("EVM_SWAP_RECOVERY_TRANSACTION_CHANGED");
  });

  it("rejects a chain change during a recovery lookup", async () => {
    const { now, record } = v3Submitted();
    let chainReads = 0;
    await expect(refreshEvmSwapRecovery(record, reader({ chainId: async () => ++chainReads === 1 ? 31337n : 1n }), now + 1)).rejects.toThrow("EVM_SWAP_RECOVERY_CHAIN_MISMATCH");
    expect(chainReads).toBe(2);
  });

  it("keeps legacy FNV recovery readable for tracking but blocks appending new authority", async () => {
    const { now, record } = v3Submitted();
    const legacy = {
      ...record,
      schema: "localswap.evm-swap-recovery.v2" as const,
      recoveryId: "fnv1a:12345678",
      routeFingerprint: "fnv1a:23456789",
      requestFingerprint: "fnv1a:3456789a"
    };
    expect(assertEvmSwapRecoveryRecord(legacy)).toEqual(legacy);
    expect((await refreshEvmSwapRecovery(legacy, reader(), now + 1)).schema).toBe("localswap.evm-swap-recovery.v2");
    const { request, quote, display } = fixture();
    expect(() => recordEvmSwapReceipt(route, request, quote, receipt([{ name: "Swap", state: "submitted", kind: "swap", txHash: swapHash }]), display, legacy, now + 2)).toThrow("EVM_SWAP_RECOVERY_LEGACY_APPEND_BLOCKED");
  });
});
