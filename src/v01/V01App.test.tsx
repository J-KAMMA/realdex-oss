/** @vitest-environment jsdom */
import { act, StrictMode } from "react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAmmRouteDescriptor } from "../swap/evm-local-amm";
import { EVM_SWAP_RECOVERY_STORAGE_KEY } from "../swap/evm-swap-recovery";
import { REVIEWED_V01_CONFIGURATION, type ReviewedV01Configuration } from "./reviewed-profile";
import type { ActiveV01Operation } from "./active-operation";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), connect: vi.fn(), quote: vi.fn(), balances: vi.fn(), create: vi.fn(), candidate: vi.fn() }));
vi.mock("../release/v01-profile", async () => ({ ...await vi.importActual<typeof import("../release/v01-profile")>("../release/v01-profile"), verifyV01Profile: mocks.verify }));
vi.mock("./runtime", async () => ({ ...await vi.importActual<typeof import("./runtime")>("./runtime"), createV01Runtime: mocks.create }));
vi.mock("./candidate-reconciliation", () => ({ verifyV01Candidate: mocks.candidate }));
import V01App from "./V01App";

const owner = "0x1111111111111111111111111111111111111111";
const pool = "0x2222222222222222222222222222222222222222";
const a = "0x3333333333333333333333333333333333333333";
const b = "0x4444444444444444444444444444444444444444";
const route = createLocalAmmRouteDescriptor({ chainId: 84532n, poolAddress: pool, tokenIn: a, tokenOut: b });
const configuration = { profile: { pool: { address: pool }, tokens: { ambr: a, jade: b } }, pin: { releaseId: "synthetic-component-fixture" } } as ReviewedV01Configuration;
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  mocks.verify.mockResolvedValue({ status: "verified-profile", profile: configuration.profile, routes: [route, { ...route, sourceAsset: route.destinationAsset, destinationAsset: route.sourceAsset }], expiresAt: Date.now() + 60_000 });
  mocks.connect.mockResolvedValue(owner); mocks.balances.mockResolvedValue({ ambr: 100n * 10n ** 18n, jade: 100n * 10n ** 18n, gas: 10n ** 18n });
  mocks.quote.mockImplementation(async (_route, request) => ({ authorization: { type: "approval" }, expectedOutBaseUnits: 2n * 10n ** 18n, minimumOutBaseUnits: 19n * 10n ** 17n, expiresAt: Date.now() + 30_000, amountInBaseUnits: request.amountInBaseUnits }));
  mocks.create.mockReturnValue({ connect: mocks.connect, balances: mocks.balances, adapter: { quote: mocks.quote }, feePlan: () => ({ totalBudget: 123n, approvalSimulation: true, steps: [{ role: "approval", totalBudget: 23n, l2Budget: 20n, l1Budget: 2n, operatorBudget: 1n, gasLimit: 50000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n, nonce: 3 }, { role: "swap", totalBudget: 100n, l2Budget: 90n, l1Budget: 8n, operatorBudget: 2n, gasLimit: 100000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n, nonce: 4 }] }) });
});

// Component orchestration only: candidate and profile proofs are mocked here.
// The connected browser faults suite exercises the real verifier and mined txs.
describe("v0.1 explicit read-only candidate UI", () => {
  const activeKey = "realdex:v01-active-operation:v1";
  const txHash = `0x${"c".repeat(64)}`;
  function operation(approvalOnly = false): ActiveV01Operation {
    const binding = { intentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000002", quoteId: "saved-quote", profileFingerprint: `0x${"a".repeat(64)}` };
    return { schema: "realdex.v01-active-operation.v2", ...binding, recoveryId: null,
      attempts: (approvalOnly ? ["approval"] as const : ["approval", "swap"] as const).map((role, index) => ({
        ...binding, role, observedBeforeBlock: 1,
        transaction: { from: owner, to: role === "approval" ? a : pool, data: `0x${"0".repeat(role === "approval" ? 136 : 328)}`, value: "0x0", chainId: "0x14a34", type: "0x2", nonce: `0x${index + 1}`, gas: "0x186a0", maxFeePerGas: "0x64", maxPriorityFeePerGas: "0x1" }
      })) };
  }
  async function prepare(approvalOnly = false) {
    const saved = operation(approvalOnly); localStorage.setItem(activeKey, JSON.stringify(saved));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } });
    mocks.candidate.mockImplementation(async options => ({ ...saved, status: "candidate-matched", role: options.role, hash: options.hash, attemptFingerprint: "fixture", blockNumber: 2, blockHash: txHash, receiptStatus: 1, confirmations: 2, commonHead: { number: 3, hash: txHash }, readerIds: options.readers.map((reader: { id: string }) => reader.id), checkedAt: Date.now() }));
    await render(configuration); const wallet = await announce();
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org"); await click("配置記録とトークンを照合");
    return { saved, wallet };
  }
  async function hashInput(value: string) {
    await act(async () => {
      const field = container.querySelector('.v01-candidate input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function roleInput(value: string) {
    await act(async () => { const field = container.querySelector('.v01-candidate select') as HTMLSelectElement; field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  const result = () => container.querySelector(".v01-candidate-result");

  it("requires a valid hash and an explicit click without connecting or writing recovery", async () => {
    const { saved, wallet } = await prepare();
    expect(button("取引ハッシュを照合").disabled).toBe(true);
    await hashInput("0x123"); expect(button("取引ハッシュを照合").disabled).toBe(true);
    await hashInput(txHash); expect(mocks.candidate).not.toHaveBeenCalled();
    expect(button("取引ハッシュを照合").disabled).toBe(false);
    await click("取引ハッシュを照合");
    const options = mocks.candidate.mock.calls[0][0];
    expect(options.role).toBe("swap"); expect(options.hash).toBe(txHash);
    expect(options.readers.map((reader: { id: string }) => reader.id)).toEqual(["rpc-a.example.org", "rpc-b.example.org"]);
    expect(options.isCurrent()).toBe(true); expect(options.readOperation()).toEqual(saved);
    expect(result()?.textContent).toContain("保存した要求と一致");
    expect(result()?.textContent).toContain("最終確定を保証しません");
    expect(localStorage.getItem(activeKey)).toBe(JSON.stringify(saved));
    expect(localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(wallet.request).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
    expect(button("見積りを取得").disabled).toBe(true);
    expect(container.textContent).not.toContain("照会済みの操作を終了し");
  });
  it("offers only a recorded approval when no swap attempt exists", async () => {
    await prepare(true); await hashInput(txHash); await click("取引ハッシュを照合");
    expect(container.querySelectorAll(".v01-candidate option")).toHaveLength(1);
    expect(mocks.candidate.mock.calls[0][0].role).toBe("approval");
  });
  it.each(["hash", "role", "rpc", "storage"])("clears an old observation after %s changes", async change => {
    await prepare(); await hashInput(txHash); await click("取引ハッシュを照合"); expect(result()).not.toBeNull();
    if (change === "hash") await hashInput(`0x${"d".repeat(64)}`);
    if (change === "role") await roleInput("approval");
    if (change === "rpc") await input(0, "https://changed.example.org");
    if (change === "storage") await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: activeKey })));
    expect(result()).toBeNull();
  });
  it.each([false, true])("discards a delayed result after storage changes (event %s), without clearing the operation", async event => {
    const { saved } = await prepare(); await hashInput(txHash);
    let finish!: (value: unknown) => void;
    mocks.candidate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await click("取引ハッシュを照合"); expect(button("取引ハッシュを照合").disabled).toBe(true);
    await click("取引ハッシュを照合"); expect(mocks.candidate).toHaveBeenCalledTimes(1);
    if (event) await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: activeKey })));
    else {
      if (saved.schema === "realdex.v01-active-operation.v2") saved.attempts.forEach(attempt => { attempt.observedBeforeBlock++; });
      localStorage.setItem(activeKey, JSON.stringify(saved));
    }
    await act(async () => finish({ status: "candidate-matched" }));
    expect(result()).toBeNull(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("未送信とは判断できません");
    expect(localStorage.getItem(activeKey)).toBe(JSON.stringify(saved));
  });
  it("hides the observation and disables checks once profile verification expires", async () => {
    await prepare(); await hashInput(txHash); await click("取引ハッシュを照合"); expect(result()).not.toBeNull();
    // The live clock interval was installed with real timers; move wall time and let
    // that interval observe expiry rather than replacing or mocking the UI clock.
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try { await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); }); }
    finally { clock.mockRestore(); }
    expect(result()).toBeNull(); expect(button("取引ハッシュを照合").disabled).toBe(true);
  });
  it("does not turn verifier failure or revert into permission to resend", async () => {
    const { saved } = await prepare(); await hashInput(txHash);
    mocks.candidate.mockRejectedValueOnce(new Error("V01_CANDIDATE_MISMATCH")); await click("取引ハッシュを照合");
    expect(result()).toBeNull(); expect(container.textContent).toContain("未送信とは判断できません");
    mocks.candidate.mockResolvedValueOnce({ role: "swap", hash: txHash, blockNumber: 2, blockHash: txHash, receiptStatus: 0, confirmations: 1, readerIds: ["a", "b"], checkedAt: Date.now() });
    await click("取引ハッシュを照合"); expect(result()?.textContent).toContain("失敗・revert（status 0）");
    expect(localStorage.getItem(activeKey)).toBe(JSON.stringify(saved)); expect(container.textContent).not.toContain("照会済みの操作を終了し");
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); Reflect.deleteProperty(navigator, "locks"); });
async function render(config: ReviewedV01Configuration | null = null) { await act(async () => root.render(<StrictMode><V01App configuration={config} /></StrictMode>)); }
function button(text: string) { return [...container.querySelectorAll("button")].find(item => item.textContent?.includes(text))!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function input(index: number, value: string) { await act(async () => { const field = container.querySelectorAll("input")[index]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function announce(rdns = "io.metamask") {
  const request = vi.fn();
  const detail = { info: { uuid: "00000000-0000-4000-8000-000000000001", name: "MetaMask", rdns, icon: "data:image/png;base64,AA==" }, provider: { request, on: vi.fn(), removeListener: vi.fn() } };
  await act(async () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail })));
  return { request, detail };
}
async function select() { await act(async () => { const field = container.querySelectorAll("select")[0]; field.value = "00000000-0000-4000-8000-000000000001"; field.dispatchEvent(new Event("change", { bubbles: true })); }); }

describe("v0.1 unreadable saved history", () => {
  // The journal and the unresolved-operation record are what tell a participant
  // whether a swap was already sent. If they cannot be read, saying nothing looks
  // exactly like "nothing is pending" — the reading that invites a second send.
  const activeKey = "realdex:v01-active-operation:v1";
  const warning = "保存した履歴または未解決操作を読み取れません";

  it("says so when the saved journal cannot be read", async () => {
    localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, JSON.stringify({ schema: "wrong", records: [] }));
    await render(configuration);
    expect(container.textContent).toContain(warning);
    expect(container.textContent).toContain("新しい交換を始めないでください");
  });

  it("says so when the unresolved operation record cannot be read", async () => {
    localStorage.setItem(activeKey, JSON.stringify({ schema: "realdex.v01-active-operation.v1", unexpected: true }));
    await render(configuration);
    expect(container.textContent).toContain(warning);
  });

  it("withdraws the warning once the store reads again", async () => {
    // It used to stay. The block lifts — the screen re-reads and replaces the
    // synthetic unresolved operation — so a sentence still saying the history
    // cannot be read is no longer true, and a warning that outlives what it
    // warns about is what teaches people to skim the next one. Fixed in the
    // release rebuilt on 2026-09-05; see the internal design notes (not published).
    localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, JSON.stringify({ schema: "wrong", records: [] }));
    await render(configuration);
    expect(container.textContent).toContain(warning);

    localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, JSON.stringify({ schema: "localswap.evm-swap-recovery-journal.v1", records: [] }));
    await act(async () => { window.dispatchEvent(new StorageEvent("storage")); await Promise.resolve(); });
    expect(container.textContent).not.toContain(warning);
  });

  it("says nothing when there is simply nothing saved", async () => {
    // An empty store is not a failure, and the same warning there would train a
    // participant to ignore it.
    localStorage.removeItem(EVM_SWAP_RECOVERY_STORAGE_KEY);
    localStorage.removeItem(activeKey);
    await render(configuration);
    expect(container.textContent).not.toContain(warning);
  });
});

describe("v0.1 default entry and explicit flow", () => {
  function captureQaState(name: "verify-loading" | "verify-error" | "quote-loading" | "quote-error") {
    const directory = process.env.REALDEX_QA_STATES_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.html`), container.innerHTML);
  }

  async function prepareConnected() {
    await render(configuration); const wallet = await announce();
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org"); await click("照合");
    await select(); await click("接続");
    return wallet;
  }

  it("keeps verification loading single-flight and fails closed on deployment mismatch", async () => {
    let finish!: (reason: unknown) => void;
    mocks.verify.mockImplementationOnce(() => new Promise((_resolve, reject) => { finish = reject; }));
    await render(configuration); const wallet = await announce();
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org");
    await click("照合");
    expect(container.querySelector(".v01-notice")?.textContent).toContain("処理中です。重ねて実行しないでください。");
    expect(button("照合").disabled).toBe(true);
    expect(button("確認した内容で交換").disabled).toBe(true);
    captureQaState("verify-loading");
    await click("照合");
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(wallet.request).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
    await act(async () => finish(new Error("DEPLOYMENT_RPC_CHAIN_MISMATCH")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("DEPLOYMENT_RPC_CHAIN_MISMATCH");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("確認条件を満たさないため停止しました");
    expect(container.querySelector(".v01-review")).toBeNull();
    expect(button("照合").disabled).toBe(false);
    expect(button("接続").disabled).toBe(true); expect(button("見積りを取得").disabled).toBe(true);
    expect(button("確認した内容で交換").disabled).toBe(true);
    expect(wallet.request).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
    captureQaState("verify-error");
  });

  it("keeps quote loading single-flight and fails closed on unavailable fees", async () => {
    const wallet = await prepareConnected();
    await input(2, "1"); await click("見積りを取得");
    expect(container.querySelector(".v01-review")).not.toBeNull();
    // Requote unchanged input so only entering the pending quote path can clear
    // the old review (an input change would clear it before this assertion).
    let finish!: (reason: unknown) => void;
    mocks.quote.mockImplementationOnce(() => new Promise((_resolve, reject) => { finish = reject; }));
    await click("見積りを取得");
    expect(container.querySelector(".v01-notice")?.textContent).toContain("処理中です。重ねて実行しないでください。");
    expect(button("見積りを取得").disabled).toBe(true); expect(button("確認した内容で交換").disabled).toBe(true);
    expect(container.querySelector(".v01-review")).toBeNull();
    captureQaState("quote-loading");
    await click("見積りを取得");
    expect(mocks.quote).toHaveBeenCalledTimes(2); expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(wallet.request).not.toHaveBeenCalled();
    await act(async () => finish(new Error("V01_FEE_UNAVAILABLE")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("手数料の確認ができないか");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("送信せず停止しました");
    expect(container.querySelector(".v01-notice")?.textContent).toBe("");
    expect(container.querySelector(".v01-review")).toBeNull();
    expect(button("見積りを取得").disabled).toBe(false); expect(button("確認した内容で交換").disabled).toBe(true);
    expect(mocks.quote).toHaveBeenCalledTimes(2); expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(wallet.request).not.toHaveBeenCalled();
    captureQaState("quote-error");
  });

  it("ignores old arbitrary configuration and makes no wallet request on load", async () => {
    localStorage.setItem("localswap-config", JSON.stringify({ chainId: "1", tokenAAddress: a, factoryAddress: pool }));
    await render(); const wallet = await announce();
    expect(container.textContent).toContain("承認済みの配置記録が未設定");
    expect(button("照合").disabled).toBe(true); expect(button("接続").disabled).toBe(true); expect(button("交換").disabled).toBe(true);
    expect(wallet.request).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
    expect(container.querySelectorAll('input[placeholder="0x…"]')).toHaveLength(0);
    expect([...container.querySelectorAll("button")].some(item => /Bridge|Liquidity|Create immutable pool/.test(item.textContent ?? ""))).toBe(false);
    expect(localStorage.getItem("localswap-config")).toContain('"chainId":"1"');
  });
  it("requires explicit candidate selection even when discovery auto-selects a provider", async () => {
    await render(configuration); const wallet = await announce();
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org"); await click("照合");
    expect(button("接続").disabled).toBe(true); await select(); expect(button("接続").disabled).toBe(false);
    expect(wallet.request).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
    await click("接続"); expect(mocks.connect).toHaveBeenCalledTimes(1); expect(container.textContent).toContain(owner);
  });
  it("excludes other wallets despite an impersonated display name", async () => {
    await render(configuration); await announce("org.otherwallet");
    expect(container.querySelectorAll("select")[0].options[1].disabled).toBe(true); expect(button("接続").disabled).toBe(true);
  });
  it("displays bound review values and clears them when amount or endpoints change", async () => {
    await render(configuration); await announce(); await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org"); await click("照合"); await select(); await click("接続");
    await input(2, "1"); await click("見積りを取得");
    expect(container.textContent).toContain("1.9 JADE"); expect(container.textContent).toContain("手数料予算（合計）: 0.000000000000000123 test ETH");
    expect(container.textContent).toContain("交換gasは承認後を仮定"); expect(container.textContent).toContain("L1データ予算");
    expect(button("2回確認").disabled).toBe(false);
    // Optional generated QA artifact: actual component markup with synthetic data, no live handlers.
    if (process.env.REALDEX_QA_HTML) writeFileSync(process.env.REALDEX_QA_HTML, container.innerHTML);
    await input(2, "2"); expect(container.textContent).not.toContain("1.9 JADE"); expect(button("確認した内容で交換").disabled).toBe(true);
    await input(0, "https://changed.example.org"); expect(container.textContent).not.toContain(owner); expect(button("見積りを取得").disabled).toBe(true);
  });
  it("stops offering execution once the quote's own deadline passes, with the profile still fresh", async () => {
    // The public-network evidence for P0-08 covers a quote left to expire, but
    // nothing here did. The profile deadline is separately covered, so this quote
    // is made to expire first: if the profile were doing the work, the check
    // would pass while proving nothing about the quote.
    mocks.quote.mockImplementation(async (_route, request) => ({
      authorization: { type: "approval" }, expectedOutBaseUnits: 2n * 10n ** 18n,
      minimumOutBaseUnits: 19n * 10n ** 17n, expiresAt: Date.now() + 1_000,
      amountInBaseUnits: request.amountInBaseUnits
    }));
    await prepareConnected();
    await input(2, "1"); await click("見積りを取得");
    expect(button("2回確認").disabled).toBe(false);
    expect(container.textContent).toContain("照合済み（短時間のみ有効）");

    // Move wall time past the quote but not past the profile, and let the live
    // interval observe it rather than replacing the screen's clock.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
    try { await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); }); }
    finally { clock.mockRestore(); }

    expect(button("2回確認").disabled).toBe(true);
    // Still verified: what expired was the quote, and the reviewed figures stay
    // on screen so the participant can see what it was.
    expect(container.textContent).toContain("照合済み（短時間のみ有効）");
    expect(container.textContent).toContain("1.9 JADE");
  });

  it.each(["accountsChanged", "chainChanged", "disconnect"])("invalidates the displayed account and quote on %s without reconnecting or sending", async event => {
    await render(configuration); const wallet = await announce();
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org");
    await click("照合"); await select(); await click("接続");
    await input(2, "1"); await click("見積りを取得");
    expect(container.textContent).toContain("1.9 JADE");
    expect(button("2回確認").disabled).toBe(false);
    const handlers = wallet.detail.provider.on.mock.calls.filter(([name]) => name === event);
    expect(handlers.length).toBeGreaterThan(0);
    await act(async () => { handlers[handlers.length - 1][1](); });
    expect(container.textContent).not.toContain("1.9 JADE");
    expect(container.textContent).not.toContain(owner);
    expect(button("確認した内容で交換").disabled).toBe(true);
    expect(button("見積りを取得").disabled).toBe(true);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("blocks new quotes when a previous hashless operation is retained across reload", async () => {
    localStorage.setItem("realdex:v01-active-operation:v1", JSON.stringify({ schema: "realdex.v01-active-operation.v1", intentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000001", quoteId: "unknown", profileFingerprint: `0x${"a".repeat(64)}`, recoveryId: null }));
    await render(configuration); expect(container.textContent).toContain("未解決または確認待ちの操作があります"); expect(button("見積りを取得").disabled).toBe(true);
    expect([...container.querySelectorAll("button")].some(item => item.textContent?.includes("操作を終了"))).toBe(false);
  });
  it("blocks a new execution before adapter entry when history is full, without deleting records", async () => {
    // jsdom has no Web Locks. This single-tab fixture supplies the lock callback only;
    // competing-tab exclusion remains a separate test, not a claim of this fixture.
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } });
    const now = Date.now();
    const records = Array.from({ length: 16 }, (_, index) => ({
      schema: "realdex.evm-swap-recovery.v3", recoveryId: `0x${index.toString(16).padStart(64, "0")}`,
      executionId: `test:${index}`, routeId: route.id, routeFingerprint: `0x${"a".repeat(64)}`,
      quoteId: `fixture:${index}`, requestFingerprint: `0x${"b".repeat(64)}`, chainId: "eip155:84532", accountId: `eip155:84532:${owner}`, recipient: owner,
      source: { assetType: route.sourceAsset, symbol: "AMBR", decimals: 18, amountBaseUnits: "1" },
      destination: { assetType: route.destinationAsset, symbol: "JADE", decimals: 18, minimumOutBaseUnits: "1" },
      executionTarget: pool, executionMethod: "swapExactIn", provider: "test", stage: "swap-submitted",
      transactions: [{ role: "swap", hash: `0x${"c".repeat(64)}`, state: "submitted", blockNumber: null, blockHash: null, confirmations: 0,
        envelope: { from: owner, to: pool, nonce: index, data: "0x1234", valueBaseUnits: "0", chainId: "84532", observedBeforeBlock: 1 }, nextSearchBlock: 2 }],
      requiredConfirmations: 2, revision: 1, createdAt: now, updatedAt: now
    }));
    const saved = JSON.stringify({ schema: "localswap.evm-swap-recovery-journal.v1", records });
    localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, saved);
    await render(configuration); const wallet = await announce();
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org"); await click("照合"); await select(); await click("接続");
    await input(2, "1"); await click("見積りを取得"); await click("2回確認");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("上限の16件");
    expect(wallet.request).not.toHaveBeenCalled();
    expect(localStorage.getItem("realdex:v01-active-operation:v1")).toBeNull();
    expect(localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY)).toBe(saved);
    expect(container.querySelector(".swap-recovery strong")?.textContent).toBe("交換を送信・確認待ち");
    expect(container.querySelector('.swap-recovery button')?.getAttribute("aria-label")).toBe("設定済みRPCで取引状況を照会（読み取りのみ）");
    const historyOptions = [...container.querySelectorAll("option")].filter(option => option.textContent?.includes("AMBR→JADE"));
    expect(historyOptions).toHaveLength(16);
    expect(historyOptions.every(option => option.textContent?.includes("交換を送信・確認待ち") && !option.textContent?.includes("swap-submitted"))).toBe(true);
    if (process.env.REALDEX_QA_HISTORY_HTML) writeFileSync(process.env.REALDEX_QA_HISTORY_HTML, container.innerHTML);
  });

  it.each([false, true])("labels rejection only for structured wallet errors (%s)", async explicit => {
    const error = explicit ? Object.assign(new Error("localized rejection"), { code: 4001 }) : new Error("RPC access denied after broadcast");
    mocks.connect.mockRejectedValueOnce(error);
    await render(configuration); await announce();
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org"); await click("照合"); await select(); await click("接続");
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    if (explicit) expect(alert).toContain("ウォレットで拒否されました");
    else { expect(alert).not.toContain("拒否されました"); expect(alert).toContain("再送せず"); }
  });

  it.each(["MISMATCH", "TIMEOUT", "CONTEXT_CHANGED", "READ_FAILED", "CONFIRMATIONS_REQUIRED", "PROFILE_REQUIRED"])("shows only the known replacement %s diagnostic without changing recovery state", async suffix => {
    const code = `V01_REPLACEMENT_RECOVERY_${suffix}`;
    mocks.verify.mockRejectedValueOnce(new Error(code));
    await render(configuration); const wallet = await announce();
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org"); await click("照合");
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain(`（${code}）`);
    expect(alert).toContain("操作は終了せず、再送もしません");
    expect(localStorage.length).toBe(0);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it.each(["V01_REPLACEMENT_RECOVERY_TIMEOUT https://rpc.invalid/?key=do-not-show", "V01_REPLACEMENT_RECOVERY_NEW_SECRET", "V01_REPLACEMENT_RECOVERY_MISMATCH\nprivate details"])("does not echo unrecognized replacement error text", async message => {
    mocks.verify.mockRejectedValueOnce(new Error(message));
    await render(configuration);
    await input(0, "https://rpc-a.example.org"); await input(1, "https://rpc-b.example.org"); await click("照合");
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("操作は終了せず、再送もしません");
    expect(alert).not.toContain(message);
    expect(alert).not.toContain("V01_REPLACEMENT_RECOVERY_");
  });

  it("rejects private/credentialed RPC endpoints before starting verification", async () => {
    await render(configuration); await input(0, "https://localhost"); await input(1, "https://rpc-b.example.org"); await click("照合");
    expect(mocks.verify).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

// The actual default must be tested without injecting a synthetic configuration.
//
// This used to assert the surface was unconfigured, which held only while the build
// shipped no profile. The build now ships one approved from public deployment
// evidence, so the rule to assert is the one the test was named for: what the
// participant sees comes from the build, and neither localStorage nor a wallet that
// announces itself can substitute a different profile. Loading still asks the wallet
// for nothing either way.
it("default build does not activate a retired profile from storage or a discovered wallet", async () => {
  localStorage.setItem("realdex-reviewed-profile", JSON.stringify(configuration));
  await act(async () => root.render(<StrictMode><V01App /></StrictMode>));
  const wallet = await announce();
  expect(container.textContent).not.toContain(configuration.pin.releaseId);
  expect(container.textContent).not.toContain(configuration.profile.pool.address);
  if (REVIEWED_V01_CONFIGURATION === null) {
    expect(container.textContent).toContain("承認済みの配置記録が未設定");
    expect(button("配置記録とトークンを照合").disabled).toBe(true);
  } else {
    expect(container.textContent).toContain(REVIEWED_V01_CONFIGURATION.pin.releaseId);
    expect(container.textContent).toContain(REVIEWED_V01_CONFIGURATION.profile.pool.address);
    // With a profile the participant may start verification; the endpoints they type
    // are judged on the click, so an empty pair must still reach no reader.
    expect(button("配置記録とトークンを照合").disabled).toBe(false);
  }
  expect(button("選択したウォレットに接続").disabled).toBe(true);
  expect(button("見積りを取得").disabled).toBe(true);
  await click("配置記録とトークンを照合");
  await click("選択したウォレットに接続");
  expect(wallet.request).not.toHaveBeenCalled();
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
