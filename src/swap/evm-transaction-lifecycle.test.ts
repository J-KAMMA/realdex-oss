import { describe, expect, it } from "vitest";
import { bindSubmittedEvmTransaction, waitForBoundEvmTransaction, type EvmTransactionLike } from "./evm-transaction-lifecycle";

const from = "0x1000000000000000000000000000000000000001";
const to = "0x2000000000000000000000000000000000000002";
const hash = `0x${"a".repeat(64)}`;
const replacementHash = `0x${"b".repeat(64)}`;
const blockHash = `0x${"c".repeat(64)}`;

function transaction(overrides: Partial<EvmTransactionLike> = {}): EvmTransactionLike {
  return { hash, from, to, nonce: 7, data: "0x1234", value: 0n, chainId: 31337n, wait: async () => ({ hash, status: 1, blockNumber: 100, blockHash }), ...overrides };
}

describe("bound EVM transaction lifecycle", () => {
  it.each([{ from: to }, { nonce: 8 }, { chainId: 1n }, { hash }])("rejects a replacement with a different identity (%#)", async change => {
    const replacement = transaction({ hash: replacementHash, ...change });
    const tx = transaction({ replaceableTransaction: () => ({ wait: async () => { throw { code: "TRANSACTION_REPLACED", replacement, receipt: { hash: replacement.hash, status: 1, blockNumber: 101, blockHash }, reason: "replaced", cancelled: true }; } }) });
    const evidence = bindSubmittedEvmTransaction(tx, { from, to, nonce: 7, data: "0x1234", valueBaseUnits: "0", chainId: "31337" }, 90);
    await expect(waitForBoundEvmTransaction(tx, evidence)).rejects.toThrow("EVM_TRANSACTION_REPLACEMENT_MISMATCH");
  });
  it("binds the complete immutable envelope and rejects changed calldata", () => {
    const tx = transaction();
    const expected = { from, to, nonce: 7, data: "0x1234", valueBaseUnits: "0", chainId: "31337" };
    expect(bindSubmittedEvmTransaction(tx, expected, 90)).toEqual({ ...expected, from, to, observedBeforeBlock: 90 });
    expect(() => bindSubmittedEvmTransaction(tx, { ...expected, data: "0xabcd" }, 90)).toThrow("EVM_TRANSACTION_ENVELOPE_MISMATCH");
  });

  it("accepts only an exact repriced replacement as the same transaction", async () => {
    const replacement = transaction({ hash: replacementHash });
    const tx = transaction({ replaceableTransaction: () => ({ wait: async () => { throw { code: "TRANSACTION_REPLACED", replacement, receipt: { hash: replacementHash, status: 1, blockNumber: 101, blockHash }, reason: "repriced", cancelled: false }; } }) });
    const evidence = bindSubmittedEvmTransaction(tx, { from, to, nonce: 7, data: "0x1234", valueBaseUnits: "0", chainId: "31337" }, 90);
    const result = await waitForBoundEvmTransaction(tx, evidence);
    expect(result).toMatchObject({ state: "confirmed", transaction: { replacement: { hash: replacementHash, reason: "repriced" } }, receipt: { hash: replacementHash, status: 1 } });
  });

  it("classifies cancellation or changed content as replaced, never confirmed", async () => {
    const replacement = transaction({ hash: replacementHash, to: from, data: "0x" });
    const tx = transaction({ replaceableTransaction: () => ({ wait: async () => { throw { code: "TRANSACTION_REPLACED", replacement, receipt: { hash: replacementHash, status: 1, blockNumber: 101, blockHash }, reason: "cancelled", cancelled: true }; } }) });
    const evidence = bindSubmittedEvmTransaction(tx, { from, to, nonce: 7, data: "0x1234", valueBaseUnits: "0", chainId: "31337" }, 90);
    const result = await waitForBoundEvmTransaction(tx, evidence);
    expect(result).toMatchObject({ state: "replaced", transaction: { replacement: { reason: "cancelled" } } });
  });
});
