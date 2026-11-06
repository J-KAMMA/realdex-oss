/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import EvmSwapRecoveryCard, { recoveryStatusLabel } from "./EvmSwapRecoveryCard";
import type { EvmSwapRecoveryRecord, EvmSwapRecoveryStage } from "./evm-swap-recovery";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; container?.remove(); container = undefined; });

const hash = `0x${"b".repeat(64)}`;
const record: EvmSwapRecoveryRecord = {
  schema: "localswap.evm-swap-recovery.v1", recoveryId: "fnv1a:12345678", executionId: `evm:${hash}`, routeId: "route", routeFingerprint: "fnv1a:23456789", quoteId: "quote", requestFingerprint: "fnv1a:3456789a",
  chainId: "eip155:31337", accountId: "eip155:31337:0x4000000000000000000000000000000000000004", recipient: "0x4000000000000000000000000000000000000004",
  source: { assetType: "eip155:31337/erc20:0x2000000000000000000000000000000000000002", symbol: "TKA", decimals: 6, amountBaseUnits: "1000000" },
  destination: { assetType: "eip155:31337/erc20:0x3000000000000000000000000000000000000003", symbol: "TKB", decimals: 6, minimumOutBaseUnits: "895500" },
  executionTarget: "0x1000000000000000000000000000000000000001", executionMethod: "swapExactIn", provider: "RealDEX Pool v1", stage: "swap-submitted",
  transactions: [{ role: "swap", hash, state: "submitted", blockNumber: null, blockHash: null, confirmations: null }], requiredConfirmations: 2, revision: 1, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000
};

describe("EVM swap recovery card", () => {
  const japaneseStatuses = {
    "approval-submitted": "トークン承認を送信・交換の送信状況は未確認",
    "approval-confirmed": "トークン承認を確認・交換の送信状況は未確認",
    "approval-reverted": "トークン承認が失敗・交換ハッシュは未保存",
    "approval-replaced": "トークン承認が置換・交換ハッシュは未保存",
    "stopped-after-approval": "トークン承認後に停止・交換は未送信",
    "swap-submitted": "交換を送信・確認待ち",
    "replacement-searching": "置換された取引を検索中",
    "swap-included": "交換をブロックに取り込み・確認数待ち",
    "swap-confirmed": "交換を確認（チェーン上）",
    "swap-reverted": "交換が失敗（チェーン上）",
    "swap-replaced": "交換が別内容の取引に置換",
    unknown: "交換の状態は不明・再送禁止"
  } satisfies Record<EvmSwapRecoveryStage, string>;

  it.each(Object.entries(japaneseStatuses))("localizes %s without changing identifiers or amounts", async (stage, label) => {
    const value = { ...record, stage: stage as EvmSwapRecoveryStage };
    const before = JSON.stringify(value), refresh = vi.fn();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<EvmSwapRecoveryCard locale="ja" record={value} busy={false} error="" onRefresh={refresh} />));
    expect(container.querySelector("strong")?.textContent).toBe(label);
    expect(recoveryStatusLabel(value.stage, "ja")).toBe(label);
    for (const preserved of ["1.0 TKA", "0.8955 TKB", record.source.assetType, record.destination.assetType, record.chainId, record.accountId, record.executionMethod, record.executionTarget, hash]) expect(container.textContent).toContain(preserved);
    expect(container.textContent).toContain("入力数量");
    expect(container.textContent).toContain("最低受取数量");
    expect(container.textContent).toContain("照会は読み取りのみ");
    expect(container.textContent).toContain("再送しないでください");
    const button = container.querySelector('button[aria-label="設定済みRPCで取引状況を照会（読み取りのみ）"]')!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([null, 0, 1, 2])("distinguishes Japanese confirmation count %s and disables busy refresh", async confirmations => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const refresh = vi.fn();
    await act(async () => root?.render(<EvmSwapRecoveryCard locale="ja" record={{ ...record, transactions: [{ ...record.transactions[0], confirmations }] }} busy error="RPC_UNAVAILABLE" onRefresh={refresh} />));
    expect(container.textContent).toContain(confirmations === null ? "確認数はRPCへの照会で未確認です。" : `観測した確認数：${confirmations}`);
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(container.textContent).toContain("照会中…");
    expect(container.textContent).toContain("取引状況の照会を停止しました：RPC_UNAVAILABLE");
    await act(async () => container?.querySelector("button")?.click());
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["approval-submitted", "approval-confirmed"] as const)("keeps Japanese %s distinct from no-swap evidence", async stage => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<EvmSwapRecoveryCard locale="ja" record={{ ...record, stage, transactions: [{ ...record.transactions[0], role: "approval" }] }} busy={false} error="" onRefresh={() => undefined} />));
    expect(container.textContent).toContain("交換の送信状況は未確認");
    expect(container.textContent).toContain("再送しないでください");
    expect(container.textContent).toContain("承認の成功は交換完了を意味しません");
    expect(container.textContent).not.toContain("交換は未送信");
    expect(container.textContent).not.toContain("交換を確認（チェーン上）");
  });

  it.each(["repriced", "cancelled", "replaced"] as const)("retains Japanese %s replacement evidence and bounded search", async reason => {
    const replacementHash = `0x${"d".repeat(64)}`;
    const envelope = { from: record.recipient, to: record.executionTarget, nonce: 7, data: "0x1234", valueBaseUnits: "0", chainId: "31337", observedBeforeBlock: 90 };
    const searching: EvmSwapRecoveryRecord = { ...record, schema: "localswap.evm-swap-recovery.v2", stage: "replacement-searching", transactions: [{ ...record.transactions[0], state: "searching", nextSearchBlock: 91, envelope: { ...envelope, replacement: { ...envelope, hash: replacementHash, reason } } }] };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<EvmSwapRecoveryCard locale="ja" record={searching} busy={false} error="" onRefresh={() => undefined} />));
    for (const text of ["元の交換取引", "置換後の取引", `(${reason})`, hash, replacementHash, "ブロック 91 から"]) expect(container.textContent).toContain(text);
    expect(container.textContent).toContain(reason === "repriced" ? "手数料だけの変更とは保証しません" : "元のトークン承認や交換が成功した証拠ではありません");
    await act(async () => root?.render(<EvmSwapRecoveryCard record={searching} busy={false} error="" onRefresh={() => undefined} />));
    expect(container.textContent).not.toContain("only fee pricing was replaced");
    if (reason === "repriced") expect(container.textContent).toContain("This does not establish that only fees changed.");
  });

  it.each(["approval-submitted", "approval-confirmed"] as const)("does not treat a %s-only record as proof of no swap submission", async stage => {
    const approvalOnly: EvmSwapRecoveryRecord = { ...record, stage, transactions: [{ ...record.transactions[0], role: "approval", state: stage === "approval-confirmed" ? "confirmed" : "submitted" }] };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<EvmSwapRecoveryCard record={approvalOnly} busy={false} error="" onRefresh={() => undefined} />); });
    expect(container.textContent).toContain("swap submission unverified");
    expect(container.textContent).toContain("Do not resend");
    expect(container.textContent).not.toContain("swap not sent");
    expect(container.textContent).not.toContain("Swap confirmed on-chain");
  });

  it("keeps submission, amounts, chain, target, tx evidence, and read-only recovery distinct", async () => {
    const refresh = vi.fn(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<EvmSwapRecoveryCard record={record} busy={false} error="" onRefresh={refresh} />); });
    expect(container.textContent).toContain("Swap submitted · not confirmed");
    expect(container.textContent).toContain("Input amount");
    expect(container.textContent).not.toContain("You paid");
    expect(container.textContent).toContain("1.0 TKA");
    expect(container.textContent).toContain("0.8955 TKB");
    expect(container.textContent).toContain("eip155:31337");
    expect(container.textContent).toContain(hash);
    expect(container.textContent).toContain("Refreshing is read-only");
    const button = container.querySelector('button[aria-label="Refresh swap status from configured RPC"]')!;
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows the original and changed replacement without claiming success", async () => {
    const replacementHash = `0x${"d".repeat(64)}`;
    const replaced: EvmSwapRecoveryRecord = { ...record, schema: "localswap.evm-swap-recovery.v2", stage: "swap-replaced", transactions: [{ ...record.transactions[0], state: "replaced", blockNumber: 101, blockHash: `0x${"e".repeat(64)}`, confirmations: 1, nextSearchBlock: 91, envelope: { from: "0x4000000000000000000000000000000000000004", to: record.executionTarget, nonce: 7, data: "0x1234", valueBaseUnits: "0", chainId: "31337", observedBeforeBlock: 90, replacement: { from: "0x4000000000000000000000000000000000000004", to: "0x4000000000000000000000000000000000000004", nonce: 7, data: "0x", valueBaseUnits: "0", chainId: "31337", hash: replacementHash, reason: "cancelled" } } }] };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<EvmSwapRecoveryCard record={replaced} busy={false} error="" onRefresh={() => undefined} />); });
    expect(container.textContent).toContain("Swap replaced by different content");
    expect(container.textContent).toContain("Original swap tx");
    expect(container.textContent).toContain("Replacement tx · cancelled");
    expect(container.textContent).toContain(replacementHash);
  });
});
