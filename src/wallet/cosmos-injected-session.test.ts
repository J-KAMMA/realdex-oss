import { ripemd160, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { secp256k1 } from "@noble/curves/secp256k1";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertGenuineCosmosInjectedBinding,
  connectCosmosInjectedWallet,
  type CosmosInjectedChainProfile,
  type CosmosInjectedConnection
} from "./cosmos-injected-session";

const now = 1_800_000_000_000;
const profile: CosmosInjectedChainProfile = {
  schema: "realdex.cosmos-injected-chain-profile.v1",
  chainId: "cosmos:osmo-test-5",
  walletChainId: "osmo-test-5",
  bech32Prefix: "osmo"
};
const live: CosmosInjectedConnection[] = [];

afterEach(() => {
  for (const connection of live) connection.dispose();
  live.length = 0;
  vi.restoreAllMocks();
});

describe("Cosmos injected wallet connection session", () => {
  it("creates an explicit connection-only binding from a cryptographically consistent key", async () => {
    const provider = syntheticProvider(key(1));
    Object.defineProperty(provider, "signDirect", { get: () => { throw new Error("signing must not be read"); } });
    Object.defineProperty(provider, "sendTx", { get: () => { throw new Error("broadcast must not be read"); } });
    const events = new EventTarget();
    const connection = await connect(provider, events);
    const binding = connection.selectAccount(now + 1);

    expect(provider.enable).toHaveBeenCalledWith("osmo-test-5");
    expect(provider.getKey).toHaveBeenCalledTimes(2);
    expect(connection.account).toMatchObject({ algorithm: "secp256k1", bech32Address: key(1).bech32Address, hardware: "none" });
    expect(binding).toMatchObject({
      chainId: "cosmos:osmo-test-5",
      walletChainId: "osmo-test-5",
      accountId: `cosmos:osmo-test-5:${key(1).bech32Address}`,
      signingEnabled: false,
      submissionEnabled: false,
      executionEnabled: false
    });
    expect(Object.isFrozen(connection)).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);
    await expect(connection.assertCurrent(binding, now + 2)).resolves.toBeUndefined();
    expect(provider.getKey).toHaveBeenCalledTimes(3);
  });

  it("rejects a wrong prefix, raw address, algorithm, public-key shape, and malformed profile", async () => {
    const valid = key(2);
    await expect(connect(syntheticProvider({ ...valid, bech32Address: toBech32("noble", valid.address) }))).rejects.toThrow("COSMOS_INJECTED_KEY_MISMATCH");
    await expect(connect(syntheticProvider({ ...valid, address: new Uint8Array(20).fill(9), bech32Address: toBech32("osmo", new Uint8Array(20).fill(9)) }))).rejects.toThrow("COSMOS_INJECTED_KEY_MISMATCH");
    await expect(connect(syntheticProvider({ ...valid, algo: "eth-secp256k1" }))).rejects.toThrow("COSMOS_INJECTED_KEY_INVALID");
    await expect(connect(syntheticProvider({ ...valid, pubKey: valid.pubKey.slice(1) }))).rejects.toThrow("COSMOS_INJECTED_KEY_INVALID");
    await expect(connect(syntheticProvider({ ...valid, pubKey: Uint8Array.from([2, ...new Uint8Array(32).fill(255)]) }))).rejects.toThrow("COSMOS_INJECTED_KEY_INVALID");
    await expect(connectCosmosInjectedWallet(syntheticProvider(valid), { ...profile, walletChainId: "grand-1" }, { walletId: "synthetic", now: () => now })).rejects.toThrow("COSMOS_INJECTED_CHAIN_PROFILE_INVALID");
  });

  it("invalidates immediately on keystore change and also catches silent account replacement", async () => {
    const events = new EventTarget();
    const eventProvider = syntheticProvider(key(3));
    const eventConnection = await connect(eventProvider, events);
    const eventBinding = eventConnection.selectAccount();
    events.dispatchEvent(new Event("keplr_keystorechange"));
    await expect(eventConnection.assertCurrent(eventBinding, now + 1)).rejects.toThrow("COSMOS_INJECTED_SESSION_INVALIDATED");

    const silentProvider = syntheticProvider(key(4));
    const silentConnection = await connect(silentProvider);
    const silentBinding = silentConnection.selectAccount();
    silentProvider.currentKey = key(5);
    await expect(silentConnection.assertCurrent(silentBinding, now + 1)).rejects.toThrow("COSMOS_INJECTED_ACCOUNT_CHANGED");
  });

  it("rejects an account event or silent key change during final connection verification", async () => {
    const events = new EventTarget();
    const eventProvider = syntheticProvider(key(6));
    eventProvider.onGetKey = (count) => { if (count === 2) events.dispatchEvent(new Event("keplr_keystorechange")); };
    await expect(connect(eventProvider, events)).rejects.toThrow("COSMOS_INJECTED_ACCOUNT_CHANGED");

    const silentProvider = syntheticProvider(key(7));
    silentProvider.onGetKey = (count) => { if (count === 2) silentProvider.currentKey = key(8); };
    await expect(connect(silentProvider)).rejects.toThrow("COSMOS_INJECTED_ACCOUNT_CHANGED");
  });

  it("keeps a timed-out wallet request excluded until its original promise settles", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const provider = syntheticProvider(key(9));
    provider.enable = vi.fn(() => pending);
    await expect(connectCosmosInjectedWallet(provider, profile, { walletId: "synthetic", timeoutMs: 10, now: () => now })).rejects.toThrow("COSMOS_INJECTED_CONNECTION_TIMEOUT");
    await expect(connect(provider)).rejects.toThrow("COSMOS_INJECTED_CONNECTION_PENDING");
    release();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connection = await connect(provider);
    expect(connection.account.bech32Address).toBe(key(9).bech32Address);
  });

  it("cancels local observation without reviving a late connection", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const provider = syntheticProvider(key(10));
    provider.enable = vi.fn(() => pending);
    const controller = new AbortController();
    const attempt = connectCosmosInjectedWallet(provider, profile, { walletId: "synthetic", signal: controller.signal, now: () => now });
    controller.abort();
    await expect(attempt).rejects.toThrow("COSMOS_INJECTED_CONNECTION_CANCELLED");
    release();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fresh = await connect(provider);
    expect(fresh.revision).toBeGreaterThan(0);
  });

  it("supersedes an older session and rejects cloned bindings, provider replacement, expiry, and clock rollback", async () => {
    const provider = syntheticProvider(key(11));
    const first = await connect(provider);
    const firstBinding = first.selectAccount();
    const second = await connect(provider);
    await expect(first.assertCurrent(firstBinding, now + 1)).rejects.toThrow("COSMOS_INJECTED_SESSION_INVALIDATED");
    const binding = second.selectAccount(now + 10);
    await expect(assertGenuineCosmosInjectedBinding(second, structuredClone(binding), now + 11)).rejects.toThrow("COSMOS_INJECTED_BINDING_NOT_CURRENT");
    await expect(second.assertCurrent(binding, now + 9)).rejects.toThrow("COSMOS_INJECTED_CLOCK_ROLLBACK");

    const expiring = await connect(syntheticProvider(key(12)));
    const expiringBinding = expiring.selectAccount(now);
    await expect(expiring.assertCurrent(expiringBinding, now + 5 * 60_000)).rejects.toThrow("COSMOS_INJECTED_SESSION_EXPIRED");

    const changedProvider = syntheticProvider(key(13));
    const changed = await connect(changedProvider);
    const changedBinding = changed.selectAccount();
    changedProvider.getKey = vi.fn(async () => changedProvider.currentKey);
    await expect(changed.assertCurrent(changedBinding, now + 1)).rejects.toThrow("COSMOS_INJECTED_PROVIDER_CHANGED");
  });

  it("preserves explicit hardware identity without granting any signing authority", async () => {
    const ledger = await connect(syntheticProvider({ ...key(14), isNanoLedger: true }));
    expect(ledger.selectAccount()).toMatchObject({ hardware: "ledger", signingEnabled: false });
    const keystone = await connect(syntheticProvider({ ...key(15), isKeystone: true }));
    expect(keystone.selectAccount()).toMatchObject({ hardware: "keystone", signingEnabled: false });
  });
});

function key(seed: number) {
  const privateKey = new Uint8Array(32); privateKey[31] = seed;
  const pubKey = secp256k1.getPublicKey(privateKey, true);
  const address = ripemd160(sha256(pubKey));
  return { name: `Synthetic ${seed}`, algo: "secp256k1", pubKey, address, bech32Address: toBech32("osmo", address), ethereumHexAddress: "", isNanoLedger: false, isKeystone: false };
}

function syntheticProvider(initialKey: ReturnType<typeof key> | Record<string, unknown>) {
  const provider = {
    currentKey: initialKey,
    getKeyCount: 0,
    onGetKey: undefined as ((count: number) => void) | undefined,
    enable: vi.fn(async (_chainId: string | string[]): Promise<void> => undefined),
    getKey: vi.fn(async (_chainId: string) => {
      provider.getKeyCount += 1;
      provider.onGetKey?.(provider.getKeyCount);
      return provider.currentKey;
    })
  };
  return provider;
}

async function connect(provider: ReturnType<typeof syntheticProvider>, events?: EventTarget): Promise<CosmosInjectedConnection> {
  const connection = await connectCosmosInjectedWallet(provider, profile, { walletId: "synthetic", eventTarget: events, now: () => now });
  live.push(connection);
  return connection;
}
