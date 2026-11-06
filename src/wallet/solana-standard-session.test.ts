import { afterEach, describe, expect, it, vi } from "vitest";
import { base58 } from "@scure/base";
import { connectSolanaWalletStandard } from "./solana-standard-session";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TESTNET = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

type Account = {
  address: string;
  publicKey: Uint8Array;
  chains: string[];
  features: string[];
};

type MockWallet = {
  version: string;
  name: string;
  chains: string[];
  features: Record<string, unknown>;
  accounts: Account[];
  connectCalls: number;
  signCalls: number;
  emit: (payload?: unknown) => void;
  setAccounts: (accounts: Account[]) => void;
  readAccounts: number;
};

const wallets: MockWallet[] = [];

function account(seed: number, chain = "solana:devnet"): Account {
  const publicKey = new Uint8Array(32);
  publicKey.fill(seed);
  return { address: base58.encode(publicKey), publicKey, chains: [chain], features: ["solana:signTransaction"] };
}

function makeWallet(
  initialAccounts: Account[] = [account(1)],
  chain = "solana:devnet",
  overrides: { connect?: unknown; events?: unknown; sign?: unknown; walletChains?: string[] } = {}
): MockWallet {
  let currentAccounts = initialAccounts;
  let change: ((payload?: unknown) => void) | undefined;
  const wallet = {
    version: "1.0.0",
    name: "Test Solana Wallet",
    chains: overrides.walletChains ?? [chain],
    features: {} as Record<string, unknown>,
    connectCalls: 0,
    signCalls: 0,
    emit: (payload?: unknown) => change?.(payload),
    setAccounts: (next: Account[]) => { currentAccounts = next; },
    readAccounts: 0
  } as MockWallet;

  const sign = overrides.sign ?? {
    version: "1.0.0",
    supportedTransactionVersions: ["legacy", 0],
    signTransaction: () => { wallet.signCalls += 1; }
  };
  wallet.features["standard:connect"] = overrides.connect ?? {
    version: "1.0.0",
    connect: async ({ silent }: { silent: boolean }) => {
      expect(silent).toBe(false);
      wallet.connectCalls += 1;
      return { accounts: currentAccounts };
    }
  };
  wallet.features["standard:events"] = overrides.events ?? {
    version: "1.0.0",
    on: (_event: "change", callback: (payload?: unknown) => void) => {
      change = callback;
      return () => { change = undefined; };
    }
  };
  wallet.features["solana:signTransaction"] = sign;
  Object.defineProperty(wallet, "accounts", {
    configurable: true,
    get: () => {
      wallet.readAccounts += 1;
      return currentAccounts;
    }
  });
  wallets.push(wallet);
  return wallet;
}

function expectSanitizedError(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({
    message: expect.stringMatching(/^SOLANA_STANDARD_[A-Z_]+$/)
  });
}

function expectFailureCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ message: `SOLANA_STANDARD_${code}` });
}

afterEach(() => {
  for (const wallet of wallets) wallet.setAccounts([]);
  wallets.length = 0;
  vi.useRealTimers();
});

describe("Solana Wallet Standard session", () => {
  it("keeps exclusion through post-resolution validation, not only raw promise settlement", async () => {
    const current = account(120);
    let resolveConnect!: (value: unknown) => void;
    const raw = new Promise(resolve => { resolveConnect = resolve; });
    const connect = vi.fn(() => raw);
    const wallet = makeWallet([current], "solana:devnet", { connect: { version: "1.0.0", connect } });
    const first = connectSolanaWalletStandard(wallet, { walletId: "microtask-race", chainId: DEVNET });
    const nested = raw.then(() => connectSolanaWalletStandard(wallet, { walletId: "microtask-race", chainId: DEVNET }).catch(error => error.message));
    resolveConnect({ accounts: [current] });
    const connection = await first;
    expect(await nested).toBe("SOLANA_STANDARD_CONNECTION_PENDING");
    expect(connect).toHaveBeenCalledOnce();
    expect(connection.snapshot().status).toBe("connected");
    connection.dispose();
  });

  it("connects without selecting an account and binds an explicitly selected account", async () => {
    const first = account(1);
    const second = account(2);
    const wallet = makeWallet([first, second]);

    const connection = await connectSolanaWalletStandard(wallet, { walletId: "wallet-a", chainId: DEVNET });
    expect(connection.snapshot()).toMatchObject({
      status: "connected",
      accounts: [first.address, second.address],
      chainId: DEVNET,
      walletChain: "solana:devnet",
      executionEnabled: false
    });
    const binding = connection.selectAccount(second.address, 0);
    expect(binding).toMatchObject({
      schema: expect.any(String),
      address: second.address,
      chainId: DEVNET,
      walletChain: "solana:devnet",
      transactionVersion: 0,
      executionEnabled: false,
      signingEnabled: false,
      submissionEnabled: false
    });
    expect(() => connection.assertCurrent(binding)).not.toThrow();
    expect(wallet.signCalls).toBe(0);
  });

  it("does not read wallet.accounts until after standard:connect resolves", async () => {
    const current = account(3);
    const wallet = makeWallet([current]);
    let getterReadDuringConnect = false;
    const connectFeature = wallet.features["standard:connect"] as { connect: (input: { silent: boolean }) => Promise<unknown> };
    connectFeature.connect = async (input) => {
      getterReadDuringConnect = wallet.readAccounts > 0;
      return { accounts: [current] };
    };

    await connectSolanaWalletStandard(wallet, { walletId: "wallet-b", chainId: DEVNET });
    expect(getterReadDuringConnect).toBe(false);
    expect(wallet.readAccounts).toBeGreaterThan(0);
  });

  it.each([
    [MAINNET, "solana:mainnet"],
    [DEVNET, "solana:devnet"],
    [TESTNET, "solana:testnet"]
  ])("maps the exact public-cluster CAIP chain %s to %s", async (chainId, walletChain) => {
    const wallet = makeWallet([account(4, walletChain)], walletChain);
    const connection = await connectSolanaWalletStandard(wallet, { walletId: "wallet-c", chainId });
    expect(connection.snapshot()).toMatchObject({ chainId, walletChain });
  });

  it("rejects unsupported chains, chain mismatches, and missing or incompatible features before connect", async () => {
    const unsupported = makeWallet();
    const unsupportedResult = connectSolanaWalletStandard(unsupported, { walletId: "wallet-d", chainId: "solana:unknown" });
    await expectSanitizedError(unsupportedResult);
    expect(unsupported.connectCalls).toBe(0);

    const mismatch = makeWallet([account(5, "solana:mainnet")], "solana:mainnet");
    await expectSanitizedError(connectSolanaWalletStandard(mismatch, { walletId: "wallet-e", chainId: DEVNET }));
    expect(mismatch.connectCalls).toBe(0);

    const missingConnect = makeWallet();
    delete missingConnect.features["standard:connect"];
    await expectSanitizedError(connectSolanaWalletStandard(missingConnect, { walletId: "wallet-f", chainId: DEVNET }));

    const missingEvents = makeWallet();
    delete missingEvents.features["standard:events"];
    await expectSanitizedError(connectSolanaWalletStandard(missingEvents, { walletId: "wallet-f-events", chainId: DEVNET }));

    const wrongVersion = makeWallet([account(6)]);
    (wrongVersion.features["solana:signTransaction"] as Record<string, unknown>).version = "2.0.0";
    await expectSanitizedError(connectSolanaWalletStandard(wrongVersion, { walletId: "wallet-g", chainId: DEVNET }));
    expect(wrongVersion.connectCalls).toBe(0);
  });

  it("rejects malformed public keys and addresses after connect metadata is read", async () => {
    const badKey = account(7);
    badKey.publicKey = new Uint8Array(31);
    const wallet = makeWallet([badKey]);
    await expectSanitizedError(connectSolanaWalletStandard(wallet, { walletId: "wallet-h", chainId: DEVNET }));
    expect(wallet.connectCalls).toBe(1);

    const badAddress = account(8);
    badAddress.address = "not-a-base58-public-key";
    const other = makeWallet([badAddress]);
    await expectSanitizedError(connectSolanaWalletStandard(other, { walletId: "wallet-i", chainId: DEVNET }));
    expect(other.connectCalls).toBe(1);
  });

  it("requires connect output and current wallet.accounts to be identical", async () => {
    const returned = account(9);
    const current = account(10);
    const wallet = makeWallet([current]);
    const connectFeature = wallet.features["standard:connect"] as { connect: (input: { silent: boolean }) => Promise<unknown> };
    connectFeature.connect = async () => ({ accounts: [returned] });
    await expectSanitizedError(connectSolanaWalletStandard(wallet, { walletId: "wallet-j", chainId: DEVNET }));
    expect(wallet.connectCalls).toBe(0);
  });

  it("accepts a synchronous change emitted during connect when final metadata remains consistent", async () => {
    const current = account(11);
    const wallet = makeWallet([current]);
    const connectFeature = wallet.features["standard:connect"] as { connect: (input: { silent: boolean }) => Promise<unknown> };
    connectFeature.connect = async () => {
      wallet.emit({ accounts: [account(99)] });
      return { accounts: [current] };
    };
    const connection = await connectSolanaWalletStandard(wallet, { walletId: "wallet-k", chainId: DEVNET });
    expect(connection.snapshot().status).toBe("connected");
  });

  it("rejects a reentrant connect started by event subscription as already pending", async () => {
    let nested: Promise<unknown> | undefined;
    let subscribed = false;
    const wallet = makeWallet([account(111)], "solana:devnet", {
      events: {
        version: "1.0.0",
        on: () => {
          subscribed = true;
          nested = connectSolanaWalletStandard(wallet, { walletId: "wallet-reentrant", chainId: DEVNET });
          return () => undefined;
        }
      }
    });
    await connectSolanaWalletStandard(wallet, { walletId: "wallet-reentrant", chainId: DEVNET });
    expect(subscribed).toBe(true);
    await expectSanitizedError(nested!);
  });

  it("rejects when a metadata getter emits change during the final current-account read", async () => {
    const current = account(112);
    const wallet = makeWallet([current]);
    let fire = true;
    Object.defineProperty(wallet, "accounts", {
      configurable: true,
      get: () => {
        if (fire) {
          fire = false;
          wallet.emit({ accounts: [current] });
        }
        return [current];
      }
    });
    await expectSanitizedError(connectSolanaWalletStandard(wallet, { walletId: "wallet-getter-change", chainId: DEVNET }));
  });

  it("invalidates on a post-connect event and ignores the event payload", async () => {
    const current = account(12);
    const wallet = makeWallet([current]);
    const connection = await connectSolanaWalletStandard(wallet, { walletId: "wallet-l", chainId: DEVNET });
    wallet.emit({ accounts: [current], chainId: "solana:payload-is-not-authority" });
    expect(connection.snapshot()).toMatchObject({ status: "invalidated", revision: expect.any(Number) });
    await expectSanitizedError(Promise.resolve().then(() => connection.selectAccount(current.address, "legacy")));
  });

  it("silently detects account changes when selecting or asserting a binding", async () => {
    const first = account(13);
    const second = account(14);
    const wallet = makeWallet([first, second]);
    const connection = await connectSolanaWalletStandard(wallet, { walletId: "wallet-m", chainId: DEVNET });
    const binding = connection.selectAccount(first.address, "legacy");
    wallet.setAccounts([second]);
    expect(connection.snapshot().status).toBe("invalidated");
    await expectSanitizedError(Promise.resolve().then(() => connection.assertCurrent(binding)));
  });

  it("times out, retains the pending exclusion until the original connect settles, and discards the late response", async () => {
    let resolveConnect!: (value: unknown) => void;
    const late = account(15);
    const pending = new Promise((resolve) => { resolveConnect = resolve; });
    let connectCalls = 0;
    const wallet = makeWallet([late], "solana:devnet", { connect: { version: "1.0.0", connect: () => { connectCalls += 1; return pending; } } });
    await expectFailureCode(connectSolanaWalletStandard(wallet, { walletId: "wallet-n", chainId: DEVNET }, { timeoutMs: 100 }), "CONNECTION_TIMEOUT");
    await expectFailureCode(connectSolanaWalletStandard(wallet, { walletId: "wallet-n", chainId: DEVNET }), "CONNECTION_PENDING");
    resolveConnect({ accounts: [late] });
    await vi.waitFor(() => expect(connectCalls).toBe(1));
    const retried = await connectSolanaWalletStandard(wallet, { walletId: "wallet-n", chainId: DEVNET });
    expect(retried.snapshot().status).toBe("connected");
    retried.dispose();
  });

  it("cancels without allowing a late response or overlapping connect", async () => {
    let resolveConnect!: (value: unknown) => void;
    const late = account(16);
    const pending = new Promise((resolve) => { resolveConnect = resolve; });
    let connectCalls = 0;
    const wallet = makeWallet([late], "solana:devnet", { connect: { version: "1.0.0", connect: () => { connectCalls += 1; return pending; } } });
    const controller = new AbortController();
    const request = connectSolanaWalletStandard(wallet, { walletId: "wallet-o", chainId: DEVNET }, { signal: controller.signal });
    controller.abort();
    await expectFailureCode(request, "CONNECTION_CANCELLED");
    await expectFailureCode(connectSolanaWalletStandard(wallet, { walletId: "wallet-o", chainId: DEVNET }), "CONNECTION_PENDING");
    resolveConnect({ accounts: [late] });
    await vi.waitFor(() => expect(connectCalls).toBe(1));
    const retried = await connectSolanaWalletStandard(wallet, { walletId: "wallet-o", chainId: DEVNET });
    expect(retried.snapshot().status).toBe("connected");
    retried.dispose();
  });

  it("disposes safely, ignores stale callbacks, and exposes only sanitized errors", async () => {
    const current = account(17);
    const wallet = makeWallet([current]);
    const connection = await connectSolanaWalletStandard(wallet, { walletId: "wallet-p", chainId: DEVNET });
    connection.dispose();
    wallet.emit({ accounts: [account(18)] });
    expect(connection.snapshot()).toMatchObject({ status: "disposed" });
    expect(() => connection.dispose()).not.toThrow();

    const throwing = makeWallet([current]);
    Object.defineProperty(throwing, "accounts", { get: () => { throw new Error("secret wallet internals"); } });
    await expectSanitizedError(connectSolanaWalletStandard(throwing, { walletId: "wallet-q", chainId: DEVNET }));
  });

  it("invalidates the previous connection before a new provider call without letting old cleanup affect the new one", async () => {
    const current = account(20);
    const wallet = makeWallet([current]);
    const first = await connectSolanaWalletStandard(wallet, { walletId: "wallet-replace", chainId: DEVNET });
    const oldBinding = first.selectAccount(current.address, "legacy");
    let oldStatusDuringNewConnect: string | undefined;
    const connectFeature = wallet.features["standard:connect"] as { connect: (input: { silent: boolean }) => Promise<unknown> };
    connectFeature.connect = async () => {
      oldStatusDuringNewConnect = first.snapshot().status;
      return { accounts: [current] };
    };

    const second = await connectSolanaWalletStandard(wallet, { walletId: "wallet-replace", chainId: DEVNET });
    expect(oldStatusDuringNewConnect).toBe("invalidated");
    await expectSanitizedError(Promise.resolve().then(() => first.assertCurrent(oldBinding)));
    first.dispose();
    expect(second.snapshot().status).toBe("connected");
  });

  it("expires bindings after five minutes and rejects binding mutation", async () => {
    let now = 1_000_000;
    const current = account(19);
    const wallet = makeWallet([current]);
    const connection = await connectSolanaWalletStandard(wallet, { walletId: "wallet-r", chainId: DEVNET }, { now: () => now });
    const binding = connection.selectAccount(current.address, "legacy");
    expect(() => connection.assertCurrent(binding)).not.toThrow();
    now += 5 * 60 * 1000 + 1;
    expect(() => connection.assertCurrent(binding)).toThrow();

    const fresh = await connectSolanaWalletStandard(wallet, { walletId: "wallet-s", chainId: DEVNET }, { now: () => now });
    const mutable = fresh.selectAccount(current.address, 0);
    mutable.address = "11111111111111111111111111111111";
    expect(() => fresh.assertCurrent(mutable)).toThrow();
  });
});
