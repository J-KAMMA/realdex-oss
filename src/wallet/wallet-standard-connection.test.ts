/** @vitest-environment jsdom */
import { base58 } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWalletStandardDiscovery, type WalletStandardDiscoverySnapshot } from "./wallet-standard-discovery";
import { assertGenuineSolanaStandardBinding } from "./solana-standard-session";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); });

function setup(deferred = false) {
  const key = new Uint8Array(32).fill(7);
  const accounts = [{ address: base58.encode(key), publicKey: key, chains: ["solana:devnet"], features: ["solana:signTransaction"] }];
  const listeners = new Set<() => void>();
  const on = (_event: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  let resolve!: (value: unknown) => void;
  const pending = new Promise(value => { resolve = value; });
  const connect = vi.fn(async () => deferred ? pending : { accounts });
  const sign = vi.fn(() => { throw new Error("Never sign"); });
  let readingFeatures = () => {};
  const wallet = { version: "1.0.0", name: "Same name", chains: ["solana:devnet"], accounts,
    // Standard implementations may return fresh feature wrappers on every read.
    get features() { readingFeatures(); return {
      "standard:events": { version: "1.0.0", on },
      "standard:connect": { version: "1.0.0", connect },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: sign }
    }; }
  };
  let snapshot!: WalletStandardDiscoverySnapshot;
  const controller = startWalletStandardDiscovery(window, next => { snapshot = next; });
  stops.push(controller);
  const register = () => {
    let remove!: () => void;
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: { register(value: unknown): () => void }) => { remove = api.register(wallet); } }));
    return remove;
  };
  const remove = register();
  return { wallet, accounts, controller, connect, sign, register, remove, resolve: () => resolve({ accounts }),
    onFeatureRead: (callback: () => void) => { readingFeatures = callback; },
    snapshot: () => snapshot, emit: () => [...listeners].forEach(listener => listener()), listeners };
}

describe("Wallet Standard registration-bound Solana connections", () => {
  it("checks removal again after synchronous provider feature getters run", async () => {
    const fixture = setup();
    let reads = 0;
    fixture.onFeatureRead(() => { if (++reads === 2) fixture.remove(); });
    await expect(fixture.controller.connectSolana(fixture.snapshot().wallets[0].id, DEVNET)).rejects.toThrow("CONNECTION_CANCELLED");
    expect(fixture.connect).not.toHaveBeenCalled();
    expect(fixture.listeners.size).toBe(0);
  });

  it("retains a stable event method across feature wrapper reads and invalidates on unregister", async () => {
    const fixture = setup();
    const id = fixture.snapshot().wallets[0].id;
    fixture.emit();
    expect(fixture.snapshot().wallets[0].id).toBe(id);
    expect(fixture.connect).not.toHaveBeenCalled();
    const connection = await fixture.controller.connectSolana(id, DEVNET);
    const snapshot = connection.snapshot();
    expect(snapshot.transactionVersions).toEqual([0, "legacy"]);
    expect(snapshot.expiresAt).toBeGreaterThan(Date.now());
    const binding = connection.selectAccount(fixture.accounts[0].address, 0);
    expect(() => assertGenuineSolanaStandardBinding(connection, binding)).not.toThrow();
    fixture.remove();
    expect(connection.snapshot()).toMatchObject({ status: "disposed", accounts: [], transactionVersions: [] });
    expect(() => connection.assertCurrent(binding)).toThrow();
    expect(fixture.listeners.size).toBe(0);
    expect(fixture.sign).not.toHaveBeenCalled();
  });

  it("clears an old binding without discarding available accounts", async () => {
    const fixture = setup();
    const connection = await fixture.controller.connectSolana(fixture.snapshot().wallets[0].id, DEVNET);
    const binding = connection.selectAccount(fixture.accounts[0].address, "legacy");
    connection.clearSelection();
    expect(() => connection.assertCurrent(binding)).toThrow("BINDING_NOT_CURRENT");
    expect(connection.snapshot()).toMatchObject({ status: "connected", accounts: [fixture.accounts[0].address] });
    const next = connection.selectAccount(fixture.accounts[0].address, 0);
    expect(() => connection.assertCurrent(next)).not.toThrow();
  });

  it("does not revive an old connection after the same object re-registers", async () => {
    const fixture = setup();
    const id = fixture.snapshot().wallets[0].id;
    const old = await fixture.controller.connectSolana(id, DEVNET);
    fixture.remove(); fixture.register(); fixture.remove();
    expect(fixture.snapshot().wallets).toHaveLength(1);
    expect(old.snapshot().status).toBe("disposed");
    const current = await fixture.controller.connectSolana(id, DEVNET);
    old.dispose();
    expect(current.snapshot().status).toBe("connected");
    fixture.controller();
    expect(current.snapshot().status).toBe("disposed");
    await expect(fixture.controller.connectSolana(id, DEVNET)).rejects.toThrow("REGISTRATION_UNAVAILABLE");
  });

  it("aborts removed pending registrations and prevents retry until the raw request settles", async () => {
    const fixture = setup(true);
    const id = fixture.snapshot().wallets[0].id;
    const request = fixture.controller.connectSolana(id, DEVNET);
    const rejected = expect(request).rejects.toThrow("CONNECTION_CANCELLED");
    await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    fixture.remove();
    await rejected;
    fixture.register();
    await expect(fixture.controller.connectSolana(id, DEVNET)).rejects.toThrow("CONNECTION_PENDING");
    fixture.resolve(); await Promise.resolve(); await Promise.resolve();
    const retried = await fixture.controller.connectSolana(id, DEVNET);
    expect(retried.snapshot().status).toBe("connected");
    expect(fixture.sign).not.toHaveBeenCalled();
  });

  it("does not contact a wallet when removed before the async capability load completes", async () => {
    const fixture = setup();
    const request = fixture.controller.connectSolana(fixture.snapshot().wallets[0].id, DEVNET);
    fixture.remove();
    await expect(request).rejects.toThrow("CONNECTION_CANCELLED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });
});
