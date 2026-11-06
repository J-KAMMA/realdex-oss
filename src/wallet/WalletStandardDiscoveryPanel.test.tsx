/** @vitest-environment jsdom */
import { base58 } from "@scure/base";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WalletStandardDiscoveryPanel from "./WalletStandardDiscoveryPanel";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const TESTNET = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

type WalletAccount = {
  address: string;
  publicKey: Uint8Array;
  chains: string[];
  features: string[];
};

type MockWallet = {
  version: "1.0.0";
  name: string;
  chains: string[];
  features: Record<string, unknown>;
  connectCalls: number;
  signCalls: number;
  readAccounts: number;
  emit: (payload?: unknown) => void;
  setAccounts: (accounts: WalletAccount[]) => void;
  unsubscribeCalls: number;
};

let root: Root | undefined;
let container: HTMLDivElement;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<WalletStandardDiscoveryPanel />));
}

function account(seed: number, chains = ["solana:devnet"]): WalletAccount {
  const publicKey = new Uint8Array(32);
  publicKey.fill(seed);
  return { address: base58.encode(publicKey), publicKey, chains, features: ["solana:signTransaction"] };
}

function makeWallet(
  initialAccounts: WalletAccount[] = [account(1)],
  options: { name?: string; chains?: string[]; connect?: (input: { silent: boolean }) => unknown } = {}
): MockWallet {
  let currentAccounts = initialAccounts;
  const listeners = new Set<(payload?: unknown) => void>();
  const wallet = {
    version: "1.0.0" as const,
    name: options.name ?? "Test Solana Wallet",
    chains: options.chains ?? ["solana:devnet"],
    features: {} as Record<string, unknown>,
    connectCalls: 0,
    signCalls: 0,
    readAccounts: 0,
    unsubscribeCalls: 0,
    emit: (payload?: unknown) => { for (const listener of [...listeners]) listener(payload); },
    setAccounts: (next: WalletAccount[]) => { currentAccounts = next; }
  } satisfies MockWallet;

  const signTransaction = vi.fn(() => { wallet.signCalls += 1; });
  wallet.features["standard:connect"] = {
    version: "1.0.0",
    connect: options.connect ?? (async ({ silent }: { silent: boolean }) => {
      expect(silent).toBe(false);
      wallet.connectCalls += 1;
      return { accounts: currentAccounts };
    })
  };
  wallet.features["standard:events"] = {
    version: "1.0.0",
    on: (_event: "change", listener: (payload?: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        wallet.unsubscribeCalls += 1;
      };
    }
  };
  wallet.features["solana:signTransaction"] = {
    version: "1.0.0",
    supportedTransactionVersions: ["legacy", 0],
    signTransaction
  };
  Object.defineProperty(wallet, "accounts", {
    configurable: true,
    get: () => {
      wallet.readAccounts += 1;
      return currentAccounts;
    }
  });
  return wallet;
}

function announce(wallet: unknown) {
  let unregister = () => {};
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", {
    detail: (api: { register(wallet: unknown): () => void }) => { unregister = api.register(wallet); }
  }));
  return unregister;
}

function button(name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === name);
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return result;
}

function select(labelText: string): HTMLSelectElement {
  const label = [...container.querySelectorAll("label")].find(item => item.textContent?.includes(labelText));
  const nested = label?.querySelector("select");
  if (nested instanceof HTMLSelectElement) return nested;
  const id = label?.htmlFor;
  const linked = id ? document.getElementById(id) : undefined;
  if (linked instanceof HTMLSelectElement) return linked;
  const aria = container.querySelector(`select[aria-label="${labelText}"]`);
  if (aria instanceof HTMLSelectElement) return aria;
  throw new Error(`Missing select: ${labelText}`);
}

async function choose(control: HTMLSelectElement, value: string) {
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(control: HTMLButtonElement) {
  await act(async () => { control.click(); });
}

async function flushMicrotasks(rounds = 12) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function firstNonBlankOption(control: HTMLSelectElement): HTMLOptionElement {
  const option = [...control.options].find(item => item.value !== "");
  if (!option) throw new Error("Expected a non-blank option");
  return option;
}

describe("Wallet Standard discovery panel", () => {
  it("shows an honest empty state and keeps account access disabled until wallet and network are selected", async () => {
    await render();
    expect(container.textContent).toContain("No Wallet Standard wallets detected");
    expect(container.textContent).toContain("not trust or permission");
    expect(button("Request account access").disabled).toBe(true);
    expect(select("Solana wallet registration").value).toBe("");
    expect(select("Solana connection network").value).toBe("");
    expect(select("Solana account").value).toBe("");
    expect(select("Solana account").disabled).toBe(true);
    expect(select("Transaction format").value).toBe("");
    expect(select("Transaction format").disabled).toBe(true);
  });

  it("renders live self-reported metadata as text and removes unregistered wallets", async () => {
    await render();
    const wallet = { version: "1.0.0", name: "<img src=x>", chains: ["solana:devnet", "sui:testnet"], features: { "solana:signTransaction": vi.fn() } };
    Object.defineProperty(wallet, "accounts", { get() { throw new Error("Account access forbidden"); } });
    let unregister = () => {};
    await act(async () => { unregister = announce(wallet); });
    expect(container.textContent).toContain("<img src=x>");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("solana:devnet · sui:testnet");
    expect(container.textContent).toContain("Unavailable — snapshot only");
    expect(container.querySelector("summary")?.textContent).toBe("Reported features (1)");
    expect(wallet.features["solana:signTransaction"]).not.toHaveBeenCalled();
    await act(async () => unregister());
    expect(container.textContent).toContain("No Wallet Standard wallets detected");
  });

  it("updates metadata but never consumes change-event account payloads", async () => {
    await render();
    let changed: (payload: unknown) => void = () => {};
    const unsubscribe = vi.fn();
    const wallet = { version: "1.0.0", name: "Test wallet", chains: ["solana:devnet"], features: { "standard:events": { version: "1.0.0", on: (_event: string, callback: typeof changed) => { changed = callback; return unsubscribe; } } } };
    await act(async () => { announce(wallet); });
    expect(container.textContent).toContain("Listening for changes");
    const payload = Object.defineProperty({}, "accounts", { get() { throw new Error("Do not inspect payload"); } });
    wallet.chains = ["sui:testnet"];
    await act(async () => changed(payload));
    expect(container.textContent).toContain("sui:testnet");
    expect(container.textContent).not.toContain("solana:devnet");
    await act(async () => root?.unmount());
    root = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not read accounts or connect while a wallet is merely discovered", async () => {
    await render();
    const wallet = makeWallet([account(3)]);
    await act(async () => { announce(wallet); });
    expect(wallet.readAccounts).toBe(0);
    expect(wallet.connectCalls).toBe(0);
    expect(button("Request account access").disabled).toBe(true);
  });

  it("uses the selected registered object for explicit connection and leaves execution disabled", async () => {
    await render();
    const first = account(1);
    const second = account(2);
    const wallet = makeWallet([first, second]);
    await act(async () => { announce(wallet); });

    const walletSelect = select("Solana wallet registration");
    const networkSelect = select("Solana connection network");
    expect(walletSelect.value).toBe("");
    expect(networkSelect.value).toBe("");
    await choose(walletSelect, firstNonBlankOption(walletSelect).value);
    expect([...networkSelect.options].map(option => option.value)).toContain(DEVNET);
    await choose(networkSelect, DEVNET);
    expect(button("Request account access").disabled).toBe(false);
    expect(wallet.readAccounts).toBe(0);
    expect(wallet.connectCalls).toBe(0);

    await click(button("Request account access"));
    await vi.waitFor(() => expect(wallet.connectCalls).toBe(1));
    expect(wallet.readAccounts).toBeGreaterThan(0);
    expect(select("Solana account").value).toBe("");
    expect(select("Transaction format").value).toBe("");
    expect(container.textContent).toContain("execution disabled");
    expect(wallet.signCalls).toBe(0);

    const accountSelect = select("Solana account");
    const versionSelect = select("Transaction format");
    await choose(accountSelect, second.address);
    await choose(versionSelect, "0");
    await click(button("Keep account selection"));
    expect(container.textContent).toContain(second.address);
    expect(container.textContent).toContain("0");
    expect(wallet.signCalls).toBe(0);
    expect(button("Forget local connection").disabled).toBe(false);
    await click(button("Forget local connection"));
    expect(select("Solana account").value).toBe("");
    expect(select("Transaction format").value).toBe("");
    expect(button("Request account access").disabled).toBe(false);
  });

  it("clears the previous account/version binding when a new explicit selection is kept", async () => {
    await render();
    const first = account(10);
    const second = account(11);
    const wallet = makeWallet([first, second]);
    await act(async () => { announce(wallet); });
    const walletSelect = select("Solana wallet registration");
    await choose(walletSelect, firstNonBlankOption(walletSelect).value);
    await choose(select("Solana connection network"), DEVNET);
    await click(button("Request account access"));
    await vi.waitFor(() => expect(wallet.connectCalls).toBe(1));

    await choose(select("Solana account"), first.address);
    await choose(select("Transaction format"), "legacy");
    await click(button("Keep account selection"));
    await choose(select("Solana account"), second.address);
    await choose(select("Transaction format"), "0");
    await click(button("Keep account selection"));
    expect(container.textContent).toContain(second.address);
    expect(container.textContent).not.toContain(`Selected account: ${first.address}`);
    expect(wallet.signCalls).toBe(0);
  });

  it("invalidates local connection state when wallet or network selection changes", async () => {
    await render();
    const devnetAccount = account(20, ["solana:devnet", "solana:testnet"]);
    const wallet = makeWallet([devnetAccount], { chains: ["solana:devnet", "solana:testnet"] });
    await act(async () => { announce(wallet); });
    const walletSelect = select("Solana wallet registration");
    const networkSelect = select("Solana connection network");
    await choose(walletSelect, firstNonBlankOption(walletSelect).value);
    await choose(networkSelect, DEVNET);
    await click(button("Request account access"));
    await vi.waitFor(() => expect(wallet.connectCalls).toBe(1));
    expect(button("Request account access").disabled).toBe(true);

    await choose(networkSelect, TESTNET);
    expect(select("Solana account").value).toBe("");
    expect(select("Transaction format").value).toBe("");
    expect(button("Request account access").disabled).toBe(false);
  });

  it("expires the local connection at exactly five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await render();
    const current = account(25);
    const wallet = makeWallet([current]);
    await act(async () => { announce(wallet); });
    const walletSelect = select("Solana wallet registration");
    await choose(walletSelect, firstNonBlankOption(walletSelect).value);
    await choose(select("Solana connection network"), DEVNET);
    await click(button("Request account access"));
    await flushMicrotasks();
    expect(wallet.connectCalls).toBe(1);
    expect(button("Forget local connection")).toBeTruthy();

    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000 - 1); });
    expect(button("Forget local connection")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(select("Solana account").value).toBe("");
    expect(select("Transaction format").value).toBe("");
    expect([...container.querySelectorAll("button")].some(item => item.textContent?.trim() === "Forget local connection")).toBe(false);
    expect(button("Request account access").disabled).toBe(false);
  });

  it("detects a silent account mutation on the one-second session poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await render();
    const first = account(26);
    const second = account(27);
    const wallet = makeWallet([first]);
    await act(async () => { announce(wallet); });
    const walletSelect = select("Solana wallet registration");
    await choose(walletSelect, firstNonBlankOption(walletSelect).value);
    await choose(select("Solana connection network"), DEVNET);
    await click(button("Request account access"));
    await flushMicrotasks();
    expect(wallet.connectCalls).toBe(1);
    expect(button("Forget local connection")).toBeTruthy();

    wallet.setAccounts([second]);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(select("Solana account").value).toBe("");
    expect(select("Transaction format").value).toBe("");
    expect([...container.querySelectorAll("button")].some(item => item.textContent?.trim() === "Forget local connection")).toBe(false);
    expect(button("Request account access").disabled).toBe(false);
  });

  it("invalidates after a post-connect event and unregisters cleanly", async () => {
    await render();
    const current = account(30);
    const wallet = makeWallet([current]);
    let unregister = () => {};
    await act(async () => { unregister = announce(wallet); });
    await choose(select("Solana wallet registration"), firstNonBlankOption(select("Solana wallet registration")).value);
    await choose(select("Solana connection network"), DEVNET);
    await click(button("Request account access"));
    await vi.waitFor(() => expect(wallet.connectCalls).toBe(1));
    await choose(select("Solana account"), current.address);
    await choose(select("Transaction format"), "legacy");
    await click(button("Keep account selection"));

    const payload = Object.defineProperty({}, "accounts", { get() { throw new Error("Do not inspect event payload"); } });
    await act(async () => wallet.emit(payload));
    expect(select("Solana account").value).toBe("");
    expect(select("Transaction format").value).toBe("");
    expect(button("Request account access").disabled).toBe(false);
    await act(async () => unregister());
    expect(container.textContent).toContain("No Wallet Standard wallets detected");
  });

  it("cancels a pending connection, ignores its late resolution, and permits a later retry", async () => {
    await render();
    let resolveConnect!: (value: unknown) => void;
    const late = account(40);
    const pending = new Promise(resolve => { resolveConnect = resolve; });
    const wallet = makeWallet([late]);
    (wallet.features["standard:connect"] as { connect: (input: { silent: boolean }) => unknown }).connect = () => {
      wallet.connectCalls += 1;
      return pending;
    };
    await act(async () => { announce(wallet); });
    await choose(select("Solana wallet registration"), firstNonBlankOption(select("Solana wallet registration")).value);
    await choose(select("Solana connection network"), DEVNET);
    await click(button("Request account access"));
    await vi.waitFor(() => expect(wallet.connectCalls).toBe(1));
    await click(button("Stop waiting"));
    expect(select("Solana account").value).toBe("");
    resolveConnect({ accounts: [late] });
    await vi.waitFor(() => expect(button("Request account access")).toBeTruthy());
    await click(button("Request account access"));
    await vi.waitFor(() => expect(wallet.connectCalls).toBe(2));
  });

  it("cancels and disposes a pending connection when the panel unmounts", async () => {
    await render();
    let resolveConnect!: (value: unknown) => void;
    const current = account(45);
    const pending = new Promise(resolve => { resolveConnect = resolve; });
    const wallet = makeWallet([current]);
    (wallet.features["standard:connect"] as { connect: (input: { silent: boolean }) => unknown }).connect = () => {
      wallet.connectCalls += 1;
      return pending;
    };
    await act(async () => { announce(wallet); });
    const walletSelect = select("Solana wallet registration");
    await choose(walletSelect, firstNonBlankOption(walletSelect).value);
    await choose(select("Solana connection network"), DEVNET);
    await click(button("Request account access"));
    await vi.waitFor(() => expect(wallet.connectCalls).toBe(1));

    await act(async () => root?.unmount());
    root = undefined;
    const readsBeforeLateResolution = wallet.readAccounts;
    resolveConnect({ accounts: [current] });
    await Promise.resolve();
    expect(wallet.readAccounts).toBe(readsBeforeLateResolution);
    expect(wallet.unsubscribeCalls).toBeGreaterThan(0);
  });

  it("keeps same-name wallet registrations distinct and cleans up event subscriptions on unmount", async () => {
    await render();
    const first = makeWallet([account(50)], { name: "Same name" });
    const second = makeWallet([account(51)], { name: "Same name" });
    await act(async () => { announce(first); announce(second); });
    const walletSelect = select("Solana wallet registration");
    const walletOptions = [...walletSelect.options].filter(option => option.value !== "");
    expect(walletOptions).toHaveLength(2);
    expect(new Set(walletOptions.map(option => option.value)).size).toBe(2);
    expect(walletOptions.every(option => option.textContent?.includes("Same name"))).toBe(true);
    expect(walletOptions.every(option => option.textContent?.includes(option.value))).toBe(true);
    expect(new Set(walletOptions.map(option => option.textContent)).size).toBe(2);
    await choose(walletSelect, walletOptions[1].value);
    await choose(select("Solana connection network"), DEVNET);
    await click(button("Request account access"));
    await vi.waitFor(() => expect(second.connectCalls).toBe(1));
    expect(first.connectCalls).toBe(0);

    await act(async () => root?.unmount());
    root = undefined;
    expect(first.unsubscribeCalls).toBeGreaterThan(0);
    expect(second.unsubscribeCalls).toBeGreaterThan(0);
    expect(() => first.emit({})).not.toThrow();
  });

  it("does not expose invalid wallet details or raw errors", async () => {
    await render();
    await act(async () => { announce({ version: "9.0.0", name: "Do not display", chains: [], features: {} }); });
    expect(container.textContent).toContain("Some registrations were rejected");
    expect(container.textContent).not.toContain("Do not display");
  });
});
