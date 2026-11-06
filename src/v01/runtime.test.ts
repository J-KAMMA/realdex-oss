import { Interface, JsonRpcProvider, type Eip1193Provider } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { routeDescriptorFingerprint, routeRequestFingerprint } from "../routing/engine";
import type { RouteQuote, RouteQuoteRequest } from "../routing/types";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { createLocalAmmRouteDescriptor, type EvmLocalAmmClient } from "../swap/evm-local-amm";
import { v01FeeTransaction, V01_GAS_ORACLE_ABI } from "./fees";
import type { V01SendAttempt } from "./send-attempt";

const mocks = vi.hoisted(() => ({
  guarded: undefined as Eip1193Provider | undefined,
  base: undefined as {
    adapterId: string;
    supports: (route: unknown) => boolean;
    quote: (route: any, request: any) => Promise<RouteQuote>;
    connectAccount: (route: any) => Promise<string>;
    execute: (route: any, request: any, quote: RouteQuote, onProgress?: any) => Promise<any>;
  } | undefined,
  client: undefined as EvmLocalAmmClient | undefined
}));

vi.mock("../release/v01-profile", () => ({
  assertCurrentV01Profile: vi.fn(),
  assertV01Route: vi.fn(),
  verifyV01Eoa: vi.fn(async () => undefined)
}));

vi.mock("../swap/evm-local-amm", async () => {
  const actual = await vi.importActual<typeof import("../swap/evm-local-amm")>("../swap/evm-local-amm");
  return {
    ...actual,
    createBrowserEvmLocalAmmClient: vi.fn((_readProvider: JsonRpcProvider, guarded: Eip1193Provider) => {
      mocks.guarded = guarded;
      return mocks.client!;
    }),
    createEvmLocalAmmAdapter: vi.fn(() => mocks.base!)
  };
});

import { createV01Runtime, isV01WalletCandidate } from "./runtime";
import type { VerifiedV01Profile } from "../release/v01-profile";

const POOL = "0x1000000000000000000000000000000000000001";
const AMBR = "0x2000000000000000000000000000000000000002";
const JADE = "0x3000000000000000000000000000000000000003";
const ACCOUNT = "0x4000000000000000000000000000000000000004";
const FACTORY = "0x5000000000000000000000000000000000000005";
const CHAIN_HEX = "0x14a34";
const CHAIN = 84532n;
const DEADLINE = Math.floor((Date.now() + 120_000) / 1000);

const route = createLocalAmmRouteDescriptor({
  chainId: CHAIN, poolAddress: POOL, tokenIn: AMBR, tokenOut: JADE,
  factoryAddress: FACTORY, venueId: "v01", venueLabel: "RealDEX v0.1 test tokens"
});

const profile = {
  status: "verified-profile",
  profile: { pool: { address: POOL, runtimeCodeHash: `0x${"a".repeat(64)}` }, tokens: { ambr: AMBR, jade: JADE } },
  fingerprint: `0x${"b".repeat(64)}`,
  verifiedAt: Date.now() - 1_000,
  expiresAt: Date.now() + 120_000,
  readerIds: ["rpc-a", "rpc-b"],
  routes: [route]
} as unknown as VerifiedV01Profile;

function request(overrides: Partial<RouteQuoteRequest> = {}): RouteQuoteRequest {
  const accountId = `eip155:${CHAIN}:${ACCOUNT}`;
  return {
    executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000101",
    sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset,
    amountInBaseUnits: 1_000n, accountId, recipient: ACCOUNT,
    walletCapabilityId: "eip1193", sessionRevision: 7,
    walletGrant: createProviderBindingGrant({ transportId: "test:v01", accountId, walletCapabilityId: "eip1193", sessionRevision: 7, expiresAt: Date.now() + 120_000 }),
    slippageBps: 50,
    ...overrides
  };
}

function quoteFor(input: RouteQuoteRequest, overrides: Partial<RouteQuote> = {}): RouteQuote {
  const expiresAt = Date.now() + 600_000;
  return {
    quoteId: "base-quote-101", routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route),
    requestFingerprint: routeRequestFingerprint(input), adapterId: route.adapterId,
    amountInBaseUnits: input.amountInBaseUnits, expectedOutBaseUnits: 900n, minimumOutBaseUnits: 890n,
    fees: [], unpricedCosts: [], expiresAt, estimatedSeconds: null,
    authorization: { type: "approval", spender: POOL, amountBaseUnits: input.amountInBaseUnits, expiresAt: null },
    executionPreview: { chainId: `eip155:${CHAIN}`, target: POOL, method: "swapExactIn", valueBaseUnits: 0n },
    adapterData: { format: "evm-local-amm.swap.v1", value: { pool: POOL, tokenIn: AMBR, tokenOut: JADE, deadline: Math.floor(expiresAt / 1000) } },
    ...overrides
  };
}

type WalletState = { chain: string; accounts: string[]; tokenBalance: bigint; gasBalance: bigint; allowance: bigint };
type PersistBeforeWalletRequest = (attempt: V01SendAttempt) => true;

function provider(state: WalletState = { chain: CHAIN_HEX, accounts: [ACCOUNT], tokenBalance: 2_000n, gasBalance: 10n ** 18n, allowance: 0n }) {
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  let nextNonce = 1;
  const wallet: Eip1193Provider & { on: () => void; removeListener: () => void } = {
    on: () => undefined,
    removeListener: () => undefined,
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params });
      if (method === "eth_chainId") return state.chain;
      if (method === "eth_accounts") return state.accounts;
      if (method === "eth_requestAccounts") return state.accounts;
      if (method === "eth_sendTransaction") {
        nextNonce++;
        const tx = params?.[0] as { to?: string } | undefined;
        if (tx?.to?.toLowerCase() === AMBR.toLowerCase()) state.allowance = 2_000n;
        return `0x${"c".repeat(64)}`;
      }
      throw new Error(`unexpected wallet method ${method}`);
    })
  };

  const readProvider = new JsonRpcProvider("http://127.0.0.1:8545");
  vi.spyOn(readProvider, "send").mockImplementation(async (method: string, params: any[] | Record<string, any>) => {
    if (method === "eth_chainId") return state.chain;
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getTransactionCount") return `0x${nextNonce.toString(16)}`;
    if (method === "eth_getBalance") return `0x${state.gasBalance.toString(16)}`;
    if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x1" };
    if (method === "eth_maxPriorityFeePerGas") return "0x0";
    if (method === "eth_estimateGas") return "0x186a0";
    if (method === "eth_call") {
      if (!Array.isArray(params)) throw new Error("expected positional RPC params");
      const abi = new Interface(V01_GAS_ORACLE_ABI); const parsed = abi.parseTransaction({ data: params[0].data })!;
      return abi.encodeFunctionResult(parsed.name, [10n]);
    }
    throw new Error(`unexpected fee RPC ${method}`);
  });
  vi.spyOn(readProvider, "getBalance").mockImplementation(async () => state.gasBalance);
  vi.spyOn(readProvider, "getBlockNumber").mockImplementation(async () => 100);
  const erc20 = new Interface(ERC20_ABI);
  vi.spyOn(readProvider, "call").mockImplementation(async (tx: any) => {
    const parsed = erc20.parseTransaction({ data: tx.data });
    if (!parsed) throw new Error("unexpected eth_call");
    if (parsed.name === "balanceOf") return erc20.encodeFunctionResult("balanceOf", [state.tokenBalance]);
    if (parsed.name === "allowance") return erc20.encodeFunctionResult("allowance", [state.allowance]);
    throw new Error(`unexpected contract call ${parsed.name}`);
  });
  return { wallet, readProvider, calls, state };
}

function installClient(wallet: Eip1193Provider, baseOverrides: Partial<NonNullable<typeof mocks.base>> = {}) {
  const guardedSend = async (tx: Record<string, unknown>) => mocks.guarded!.request({ method: "eth_sendTransaction", params: [tx] });
  mocks.client = {
    connectAccount: vi.fn(async () => ({ account: ACCOUNT, chainId: CHAIN })),
    poolTokens: vi.fn(async () => ({ token0: AMBR, token1: JADE })),
    poolReserves: vi.fn(async () => ({ reserve0: 10_000n, reserve1: 10_000n })),
    quoteExactIn: vi.fn(async () => 900n), allowance: vi.fn(async () => 0n), blockNumber: vi.fn(async () => 100),
    approveExact: vi.fn(async (_token, spender, amount) => {
      const data = new Interface(ERC20_ABI).encodeFunctionData("approve", [spender, amount]);
      await guardedSend({ from: ACCOUNT, to: AMBR, data, value: "0x0", chainId: CHAIN_HEX });
      return { hash: `0x${"a".repeat(64)}`, from: ACCOUNT, to: AMBR, nonce: 1, data, value: 0n, chainId: CHAIN, wait: async () => ({ hash: `0x${"a".repeat(64)}`, status: 1, blockNumber: 101, blockHash: `0x${"d".repeat(64)}` }) };
    }),
    swapExactIn: vi.fn(async (pool, token, amount, minimum, recipient, deadline) => {
      const data = new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [token, amount, minimum, recipient, deadline]);
      await guardedSend({ from: ACCOUNT, to: pool, data, value: "0x0", chainId: CHAIN_HEX });
      return { hash: `0x${"b".repeat(64)}`, from: ACCOUNT, to: pool, nonce: 2, data, value: 0n, chainId: CHAIN, wait: async () => ({ hash: `0x${"b".repeat(64)}`, status: 1, blockNumber: 102, blockHash: `0x${"e".repeat(64)}` }) };
    })
  };
  mocks.base = {
    adapterId: "evm-local-amm", supports: () => true,
    connectAccount: async () => `eip155:${CHAIN}:${ACCOUNT}`,
    quote: async (_route, input) => quoteFor(input),
    execute: async (_route, input, quote, _onProgress) => {
      if (quote.authorization.type === "approval") await mocks.client!.approveExact(AMBR, POOL, input.amountInBaseUnits);
      await mocks.client!.swapExactIn(POOL, AMBR, input.amountInBaseUnits, quote.minimumOutBaseUnits, ACCOUNT, Number((quote.adapterData.value as any).deadline));
      return { executionId: `mock:${quote.quoteId}`, quoteId: quote.quoteId, state: "confirmed", provider: "mock", steps: [] };
    },
    ...baseOverrides
  };
  return { wallet };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function runtimeFor(walletEnv = provider(), persistBeforeWalletRequest: PersistBeforeWalletRequest = () => true) {
  installClient(walletEnv.wallet);
  return { runtime: createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "metamask", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: walletEnv.wallet }, explicitlySelected: true, readProvider: walletEnv.readProvider, isCurrent: () => true, persistBeforeWalletRequest }), ...walletEnv };
}

describe("RealDEX v0.1 runtime wallet boundary", () => {
  it.each(["valid", "nonce", "data", "from", "to", "future-start", "negative-start", "receipt-before-send", "missing-attempt"])("binds only matching new receipt evidence to the persisted start: %s", async variant => {
    const saved: V01SendAttempt[] = [];
    const env = runtimeFor(provider(), attempt => { saved.push(structuredClone(attempt)); return true; });
    await env.runtime.connect(); const input = request();
    const quote = await env.runtime.adapter.quote(route, input);
    let rawReceipt: any;
    mocks.base!.execute = async (_route, current, currentQuote, progress) => {
      if (variant !== "missing-attempt") await mocks.client!.approveExact(AMBR, POOL, current.amountInBaseUnits);
      const evidence = { from: ACCOUNT, to: AMBR, nonce: 1, data: new Interface(ERC20_ABI).encodeFunctionData("approve", [POOL, current.amountInBaseUnits]), valueBaseUnits: "0", chainId: "84532", observedBeforeBlock: 99 };
      if (variant === "nonce") evidence.nonce++;
      if (variant === "data") evidence.data = "0x";
      if (variant === "from") evidence.from = POOL;
      if (variant === "to") evidence.to = POOL;
      if (variant === "future-start") evidence.observedBeforeBlock = 101;
      if (variant === "negative-start") evidence.observedBeforeBlock = -1;
      rawReceipt = { executionId: "mock-evidence", quoteId: currentQuote.quoteId, state: "pending", provider: "mock", steps: [{ name: "approval", kind: "approval", state: "submitted", txHash: `0x${"a".repeat(64)}`, evmTransaction: evidence,
        ...(variant === "receipt-before-send" ? { evmReceipt: { hash: `0x${"a".repeat(64)}`, status: 1, blockNumber: 100, blockHash: `0x${"d".repeat(64)}` } } : {}) }] };
      progress?.(rawReceipt);
      return rawReceipt;
    };
    const progress: any[] = [];
    if (variant === "valid") {
      const result = await env.runtime.adapter.execute(route, input, quote, value => progress.push(value));
      expect(saved[0].observedBeforeBlock).toBe(100);
      expect(result.steps[0].evmTransaction?.observedBeforeBlock).toBe(100);
      expect(progress[0].steps[0].evmTransaction.observedBeforeBlock).toBe(100);
      expect(rawReceipt.steps[0].evmTransaction.observedBeforeBlock).toBe(99);
      expect(result).not.toBe(rawReceipt);
    } else {
      await expect(env.runtime.adapter.execute(route, input, quote, value => progress.push(value))).rejects.toThrow("V01_RECEIPT_RECOVERY_MISMATCH");
      expect(progress).toHaveLength(0);
    }
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(variant === "missing-attempt" ? 0 : 1);
  });

  it("blocks a positive but insufficient gas balance before forwarding a wallet request", async () => {
    const env = runtimeFor(); await env.runtime.connect(); const input = request();
    const quote = await env.runtime.adapter.quote(route, input);
    env.state.gasBalance = env.runtime.feePlan(quote).totalBudget - 1n;
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("V01_GAS_BALANCE_INSUFFICIENT");
    expect(env.runtime.signatureWasRequested(quote)).toBe(false);
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(0);
  });

  it("records a confirmed approval but no swap when fee preflight fails before the second wallet request", async () => {
    const env = runtimeFor(); await env.runtime.connect(); const input = request();
    const quote = await env.runtime.adapter.quote(route, input);
    mocks.base!.execute = async (_route, current, currentQuote, progress) => {
      const approval = await mocks.client!.approveExact(AMBR, POOL, current.amountInBaseUnits);
      progress({ executionId: "approval-progress", quoteId: currentQuote.quoteId, state: "pending", provider: "fixture", steps: [{ name: "Exact token approval", kind: "approval", state: "confirmed", txHash: approval.hash, evmReceipt: { status: 1 } }] });
      env.state.gasBalance = 1n;
      await mocks.client!.swapExactIn(POOL, AMBR, current.amountInBaseUnits, currentQuote.minimumOutBaseUnits, ACCOUNT, Math.floor(currentQuote.expiresAt / 1000));
      throw new Error("unexpected swap");
    };
    const result = await env.runtime.adapter.execute(route, input, quote);
    expect(result.state).toBe("failed");
    expect(result.failureProof).toEqual({ type: "no-value-transfer-submitted" });
    expect(result.steps[0]).toMatchObject({ kind: "approval", state: "confirmed" });
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(1);
  });

  it("never converts a lost swap response into a no-send proof", async () => {
    const persist = vi.fn((_attempt: V01SendAttempt): true => true);
    const env = runtimeFor(provider(), persist); await env.runtime.connect(); const input = request();
    const quote = await env.runtime.adapter.quote(route, input);
    const original = env.wallet.request;
    env.wallet.request = async args => {
      if (args.method === "eth_sendTransaction" && Array.isArray(args.params) && args.params[0].to === POOL) throw new Error("connection lost after possible send");
      return original(args);
    };
    mocks.base!.execute = async (_route, current, currentQuote, progress) => {
      const approval = await mocks.client!.approveExact(AMBR, POOL, current.amountInBaseUnits);
      progress({ executionId: "approval-progress", quoteId: currentQuote.quoteId, state: "pending", provider: "fixture", steps: [{ name: "Exact token approval", kind: "approval", state: "confirmed", txHash: approval.hash, evmReceipt: { status: 1 } }] });
      await mocks.client!.swapExactIn(POOL, AMBR, current.amountInBaseUnits, currentQuote.minimumOutBaseUnits, ACCOUNT, Math.floor(currentQuote.expiresAt / 1000));
      throw new Error("unexpected completion");
    };
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("connection lost after possible send");
    expect(env.runtime.signatureWasRequested(quote)).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][0].role).toBe("swap");
    expect(persist.mock.calls[1][0].observedBeforeBlock).toBe(100);
    expect(persist.mock.calls[1][0].transaction).toEqual(v01FeeTransaction(env.runtime.feePlan(quote).steps[1]));
  });

  it("uses EIP-6963 MetaMask compatibility as a filter, not identity proof", () => {
    const good = { source: "eip6963" as const, info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() } };
    expect(isV01WalletCandidate(good)).toBe(true);
    expect(isV01WalletCandidate({ ...good, source: "legacy" })).toBe(false);
    expect(isV01WalletCandidate({ ...good, info: { ...good.info, rdns: "evil.example" } })).toBe(false);
    expect(isV01WalletCandidate({ ...good, provider: { request: vi.fn() } })).toBe(false);
  });

  it("requires explicit selection and performs exactly one explicit connect prompt", async () => {
    const env = provider(); installClient(env.wallet);
    const unselected = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: env.wallet }, explicitlySelected: false, readProvider: env.readProvider, isCurrent: () => true, persistBeforeWalletRequest: () => true });
    await expect(unselected.connect()).rejects.toThrow("V01_WALLET_CONTEXT_CHANGED");
    expect(env.calls).toEqual([]);
    const selected = runtimeFor(env);
    await expect(selected.runtime.connect()).resolves.toBe(ACCOUNT);
    expect(env.calls.filter((call) => call.method === "eth_requestAccounts")).toHaveLength(1);
  });

  it("refuses before eth_requestAccounts when current profile or wallet context is lost", async () => {
    const env = provider(); installClient(env.wallet);
    const runtime = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: env.wallet }, explicitlySelected: true, readProvider: env.readProvider, isCurrent: () => false, persistBeforeWalletRequest: () => true });
    await expect(runtime.connect()).rejects.toThrow("V01_WALLET_CONTEXT_CHANGED");
    expect(env.calls).toEqual([]);
  });

  it("rejects wrong chain and wrong account at connect/live checks", async () => {
    const wrongChain = provider({ chain: "0x1", accounts: [ACCOUNT], tokenBalance: 1n, gasBalance: 1n, allowance: 0n });
    installClient(wrongChain.wallet);
    const first = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: wrongChain.wallet }, explicitlySelected: true, readProvider: wrongChain.readProvider, isCurrent: () => true, persistBeforeWalletRequest: () => true });
    await expect(first.connect()).rejects.toThrow("WALLET_NETWORK_CHANGED");
    const rpcChanged = provider(); installClient(rpcChanged.wallet);
    vi.spyOn(rpcChanged.readProvider, "send").mockResolvedValue("0x1");
    const rpcRuntime = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: rpcChanged.wallet }, explicitlySelected: true, readProvider: rpcChanged.readProvider, isCurrent: () => true, persistBeforeWalletRequest: () => true });
    await expect(rpcRuntime.connect()).rejects.toThrow("WALLET_NETWORK_CHANGED");
    const changed = provider(); installClient(changed.wallet);
    const second = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: changed.wallet }, explicitlySelected: true, readProvider: changed.readProvider, isCurrent: () => true, persistBeforeWalletRequest: () => true });
    await second.connect(); changed.state.accounts = [JADE];
    await expect(second.balances()).rejects.toThrow("WALLET_ACCOUNT_CHANGED");
  });

  it("never implicitly requests accounts through route adapter connectAccount", async () => {
    const env = runtimeFor();
    await expect(env.runtime.adapter.connectAccount(route)).rejects.toThrow("WALLET_ACCOUNT_CHANGED");
    expect(env.calls.some((call) => call.method === "eth_requestAccounts")).toBe(false);
  });

  it.each(["wallet", "rpc"] as const)("rejects malformed %s chain responses at connect, balances and execute without coercion", async source => {
    const coerce = vi.fn(() => CHAIN_HEX);
    const invalid: unknown[] = [undefined, null, {}, [], [CHAIN_HEX], { [Symbol.toPrimitive]: coerce },
      CHAIN, Number(CHAIN), "84532", "0x014a34", "0X14A34", " 0x14a34", "0x14a34 ", "0x", "", "0x1", "0x0", "0xwat"];
    for (const phase of ["connect", "balances", "execute"] as const) {
      for (const value of invalid) {
        const persist = vi.fn<PersistBeforeWalletRequest>(() => true);
        const env = runtimeFor(provider(), persist);
        const input = request();
        if (phase !== "connect") await env.runtime.connect();
        const quote = phase === "execute" ? await env.runtime.adapter.quote(route, input) : undefined;
        if (source === "wallet") {
          const original = vi.mocked(env.wallet.request).getMockImplementation()!;
          vi.mocked(env.wallet.request).mockImplementation(async args => args.method === "eth_chainId" ? value : original(args));
        } else {
          const original = vi.mocked(env.readProvider.send).getMockImplementation()!;
          vi.mocked(env.readProvider.send).mockImplementation(async (method, params) => method === "eth_chainId" ? value : original(method, params));
        }
        const action = phase === "connect" ? env.runtime.connect() : phase === "balances" ? env.runtime.balances() : env.runtime.adapter.execute(route, input, quote!);
        await expect(action, `${source}/${phase}/${String(typeof value)}`).rejects.toThrow("WALLET_NETWORK_CHANGED");
        expect(env.calls.filter(call => call.method === "eth_requestAccounts")).toHaveLength(phase === "connect" && source === "wallet" ? 0 : 1);
        expect(env.calls.some(call => call.method === "eth_sendTransaction")).toBe(false);
        expect(persist).not.toHaveBeenCalled();
        if (quote) expect(env.runtime.signatureWasRequested(quote)).toBe(false);
      }
    }
    expect(coerce).not.toHaveBeenCalled();
  });

  it.each(["0x14a34", "0x14A34"])("accepts canonical Base Sepolia quantity %s through both sends", async chain => {
    const persist = vi.fn<PersistBeforeWalletRequest>(() => true);
    const env = runtimeFor(provider({ chain, accounts: [ACCOUNT], tokenBalance: 2_000n, gasBalance: 10n ** 18n, allowance: 0n }), persist);
    await env.runtime.connect();
    const input = request(), quote = await env.runtime.adapter.quote(route, input);
    await expect(env.runtime.adapter.execute(route, input, quote)).resolves.toMatchObject({ state: "confirmed" });
    expect(env.calls.filter(call => call.method === "eth_requestAccounts")).toHaveLength(1);
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(2);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it.each(["wallet", "rpc"] as const)("rejects a malformed %s chain response introduced at the final send recheck", async source => {
    const persist = vi.fn<PersistBeforeWalletRequest>(() => true);
    const env = runtimeFor(provider(), persist);
    await env.runtime.connect();
    const input = request(), quote = await env.runtime.adapter.quote(route, input);
    let atSendBoundary = false;
    const rpc = vi.mocked(env.readProvider.send).getMockImplementation()!;
    vi.mocked(env.readProvider.send).mockImplementation(async (method, params) => {
      if (method === "eth_blockNumber") atSendBoundary = true;
      if (source === "rpc" && atSendBoundary && method === "eth_chainId") return [CHAIN_HEX];
      return rpc(method, params);
    });
    const wallet = vi.mocked(env.wallet.request).getMockImplementation()!;
    vi.mocked(env.wallet.request).mockImplementation(async args => source === "wallet" && atSendBoundary && args.method === "eth_chainId" ? "0x014a34" : wallet(args));
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("WALLET_NETWORK_CHANGED");
    expect(atSendBoundary).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    expect(env.runtime.signatureWasRequested(quote)).toBe(false);
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(0);
    expect(env.calls.filter(call => call.method === "eth_requestAccounts")).toHaveLength(1);
  });

  it("caps output quote TTL to the reviewed profile and refreshes the calldata deadline", async () => {
    const env = runtimeFor();
    await env.runtime.connect();
    const quote = await env.runtime.adapter.quote(route, request());
    expect(quote.expiresAt).toBeLessThanOrEqual(profile.expiresAt);
    expect((quote.adapterData.value as { deadline: number }).deadline).toBe(Math.floor(quote.expiresAt / 1000));
    expect(quote.quoteId).toContain(`:v01:${profile.fingerprint}`);
  });

  it("accepts only the reviewed zero-value approval and swap envelopes", async () => {
    const env = runtimeFor();
    await env.runtime.connect();
    const input = request();
    const quote = await env.runtime.adapter.quote(route, input);
    await expect(env.runtime.adapter.execute(route, input, quote)).resolves.toMatchObject({ state: "confirmed" });
    expect(env.runtime.signatureWasRequested(quote)).toBe(true);
    const sends = env.calls.filter((call) => call.method === "eth_sendTransaction");
    expect(sends).toHaveLength(2);
    const approval = sends[0].params![0] as any;
    const swap = sends[1].params![0] as any;
    expect(approval).toMatchObject({ from: ACCOUNT, to: AMBR, value: "0x0", chainId: CHAIN_HEX });
    expect(swap).toMatchObject({ from: ACCOUNT, to: POOL, value: "0x0", chainId: CHAIN_HEX });
    const fees = env.runtime.feePlan(quote);
    expect(approval).toMatchObject({ gas: `0x${fees.steps[0].gasLimit.toString(16)}`, maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x0", nonce: "0x1", type: "0x2" });
    expect(swap.nonce).toBe("0x2");
    expect(quote.fees[0].amountBaseUnits).toBe(fees.totalBudget);
    expect(new Interface(ERC20_ABI).parseTransaction({ data: approval.data })?.name).toBe("approve");
    expect(new Interface(POOL_ABI).parseTransaction({ data: swap.data })?.name).toBe("swapExactIn");
  });

  it("persists the exact reviewed transaction before each corresponding wallet request", async () => {
    const env = provider();
    const persist = vi.fn((attempt: V01SendAttempt): true => {
      expect(Object.isFrozen(attempt)).toBe(true);
      expect(Object.isFrozen(attempt.transaction)).toBe(true);
      const sendsForRole = env.calls.filter(call => call.method === "eth_sendTransaction" && (call.params?.[0] as { to?: string })?.to?.toLowerCase() === attempt.transaction.to.toLowerCase());
      expect(sendsForRole).toHaveLength(0);
      return true;
    });
    const runtimeEnv = runtimeFor(env, persist);
    await runtimeEnv.runtime.connect();
    const input = request({ executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000105" });
    const quote = await runtimeEnv.runtime.adapter.quote(route, input);
    await expect(runtimeEnv.runtime.adapter.execute(route, input, quote)).resolves.toMatchObject({ state: "confirmed" });
    const sends = env.calls.filter(call => call.method === "eth_sendTransaction");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[0][0]).toMatchObject({
      intentId: input.executionIntentId, quoteId: quote.quoteId, profileFingerprint: profile.fingerprint,
      role: "approval", observedBeforeBlock: 100, transaction: sends[0].params![0]
    });
    expect(persist.mock.calls[1][0]).toMatchObject({
      intentId: input.executionIntentId, quoteId: quote.quoteId, profileFingerprint: profile.fingerprint,
      role: "swap", observedBeforeBlock: 100, transaction: sends[1].params![0]
    });
    expect(persist.mock.calls[0][0].transaction).toEqual(v01FeeTransaction(runtimeEnv.runtime.feePlan(quote).steps[0]));
    expect(persist.mock.calls[1][0].transaction).toEqual(v01FeeTransaction(runtimeEnv.runtime.feePlan(quote).steps[1]));
  });

  it("blocks broadcast and signature evidence when persistence throws before the first request", async () => {
    const persist = vi.fn((_attempt: V01SendAttempt) => { throw new Error("persistence unavailable"); }) as unknown as PersistBeforeWalletRequest;
    const env = runtimeFor(provider(), persist);
    await env.runtime.connect();
    const input = request({ executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000106" });
    const quote = await env.runtime.adapter.quote(route, input);
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("persistence unavailable");
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(0);
    expect(env.runtime.signatureWasRequested(quote)).toBe(false);
  });

  it("stops a swap before broadcast when its persistence acknowledgement is not true after approval", async () => {
    const persist = vi.fn((attempt: V01SendAttempt) => attempt.role === "approval") as unknown as PersistBeforeWalletRequest;
    const env = runtimeFor(provider(), persist);
    await env.runtime.connect();
    const input = request({ executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000107" });
    const quote = await env.runtime.adapter.quote(route, input);
    mocks.base!.execute = async (_route, current, currentQuote, progress) => {
      const approval = await mocks.client!.approveExact(AMBR, POOL, current.amountInBaseUnits);
      progress({ executionId: "approval-progress", quoteId: currentQuote.quoteId, state: "pending", provider: "fixture", steps: [{ name: "Exact token approval", kind: "approval", state: "confirmed", txHash: approval.hash, evmReceipt: { status: 1 } }] });
      await mocks.client!.swapExactIn(POOL, AMBR, current.amountInBaseUnits, currentQuote.minimumOutBaseUnits, ACCOUNT, Math.floor(currentQuote.expiresAt / 1000));
      throw new Error("unexpected swap");
    };
    const result = await env.runtime.adapter.execute(route, input, quote);
    expect(result).toMatchObject({ state: "failed", failureProof: { type: "no-value-transfer-submitted" } });
    expect(result.steps[0]).toMatchObject({ kind: "approval", state: "confirmed" });
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(1);
    expect(env.runtime.signatureWasRequested(quote)).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("rejects a persistence callback that does not acknowledge with true", async () => {
    const persist = vi.fn((_attempt: V01SendAttempt) => undefined) as unknown as PersistBeforeWalletRequest;
    const env = runtimeFor(provider(), persist);
    await env.runtime.connect();
    const input = request({ executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000108" });
    const quote = await env.runtime.adapter.quote(route, input);
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("V01_SEND_ATTEMPT_NOT_PERSISTED");
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(0);
    expect(env.runtime.signatureWasRequested(quote)).toBe(false);
  });

  it.each([
    ["extra field", { memo: "unexpected" }],
    ["wrong sender", { from: JADE }],
    ["nonzero value", { value: "0x1" }],
    ["wrong chain", { chainId: "0x1" }],
    ["wrong target", { to: JADE }],
    ["wrong calldata", { data: "0x" }],
    ["delegated type", { type: "0x4" }],
    ["authorization list", { authorizationList: [] }]
  ])("refuses an out-of-scope %s transaction envelope", async (_name, change) => {
    const env = runtimeFor();
    mocks.base!.execute = async (_route, input, quote) => {
      const data = new Interface(ERC20_ABI).encodeFunctionData("approve", [POOL, input.amountInBaseUnits]);
      await mocks.guarded!.request({ method: "eth_sendTransaction", params: [{ from: ACCOUNT, to: AMBR, data, value: "0x0", chainId: CHAIN_HEX, ...change }] });
      return { executionId: `mock:${quote.quoteId}`, quoteId: quote.quoteId, state: "confirmed", provider: "mock", steps: [] };
    };
    await env.runtime.connect();
    const input = request(); const quote = await env.runtime.adapter.quote(route, input);
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("V01_TRANSACTION_OUT_OF_SCOPE");
    expect(env.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(0);
    expect(env.runtime.signatureWasRequested(quote)).toBe(false);
  });

  it("rejects forged or cloned quotes, even when their fields match", async () => {
    const env = runtimeFor(); await env.runtime.connect(); const input = request();
    const quote = await env.runtime.adapter.quote(route, input);
    const clone = structuredClone(quote);
    await expect(env.runtime.adapter.execute(route, input, clone)).rejects.toThrow("V01_QUOTE_NOT_CURRENT");
    await expect(env.runtime.adapter.execute(route, input, { ...quote, quoteId: `${quote.quoteId}:forged` })).rejects.toThrow("V01_QUOTE_NOT_CURRENT");
  });

  it("rechecks account and context after asynchronous preflight, immediately before send", async () => {
    const env = provider(); installClient(env.wallet); let current = true;
    const runtime = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: env.wallet }, explicitlySelected: true, readProvider: env.readProvider, isCurrent: () => current, persistBeforeWalletRequest: () => true });
    await runtime.connect(); const input = request(); const quote = await runtime.adapter.quote(route, input);
    const gate = deferred<void>();
    vi.spyOn(env.readProvider, "getBalance").mockImplementation(async () => { await gate.promise; return 1n; });
    const pending = runtime.adapter.execute(route, input, quote);
    env.state.accounts = [JADE]; gate.resolve();
    await expect(pending).rejects.toThrow("WALLET_ACCOUNT_CHANGED");
    expect(env.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(0);

    const env2 = provider(); installClient(env2.wallet);
    const runtime2 = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: env2.wallet }, explicitlySelected: true, readProvider: env2.readProvider, isCurrent: () => current, persistBeforeWalletRequest: () => true });
    await runtime2.connect(); const input2 = request({ executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000102" }); const quote2 = await runtime2.adapter.quote(route, input2);
    const gate2 = deferred<void>(); vi.spyOn(env2.readProvider, "getBalance").mockImplementation(async () => { await gate2.promise; return 1n; });
    const pending2 = runtime2.adapter.execute(route, input2, quote2); gate2.resolve(); current = false;
    await expect(pending2).rejects.toThrow("V01_WALLET_CONTEXT_CHANGED");
    expect(env2.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(0);
  });

  it("rejects a quote that expires during the asynchronous preflight", async () => {
    vi.useFakeTimers();
    try {
      const env = runtimeFor(); await env.runtime.connect();
      const input = request({
        executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000104",
        walletGrant: createProviderBindingGrant({ transportId: "test:v01", accountId: `eip155:${CHAIN}:${ACCOUNT}`, walletCapabilityId: "eip1193", sessionRevision: 7, expiresAt: Date.now() + 600_000 })
      });
      const quote = await env.runtime.adapter.quote(route, input);
      vi.spyOn(env.readProvider, "getBalance").mockImplementation(async () => { vi.advanceTimersByTime(121_000); return 1n; });
      await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow(/QUOTE_EXPIRY_INVALID|V01_FEE_EXPIRED/);
      expect(env.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for zero token/gas balance and changed allowance", async () => {
    for (const balances of [{ tokenBalance: 0n, gasBalance: 1n }, { tokenBalance: 2_000n, gasBalance: 0n }]) {
      const env = provider();
      installClient(env.wallet); const runtime = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: env.wallet }, explicitlySelected: true, readProvider: env.readProvider, isCurrent: () => true, persistBeforeWalletRequest: () => true });
      await runtime.connect(); const input = request({ executionIntentId: `realdex-intent:v1:00000000-0000-4000-8000-00000000010${balances.gasBalance}` }); const quote = await runtime.adapter.quote(route, input);
      Object.assign(env.state, balances);
      await expect(runtime.adapter.execute(route, input, quote)).rejects.toThrow(balances.tokenBalance === 0n ? "V01_TOKEN_BALANCE_INSUFFICIENT" : "V01_GAS_BALANCE_INSUFFICIENT");
      expect(env.calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(0);
      expect(runtime.signatureWasRequested(quote)).toBe(false);
    }
    const env = provider(); installClient(env.wallet);
    mocks.base!.quote = async (_route, input) => quoteFor(input, { authorization: { type: "none" } });
    mocks.base!.execute = async (_route, input, quote) => {
      await mocks.client!.swapExactIn(POOL, AMBR, input.amountInBaseUnits, quote.minimumOutBaseUnits, ACCOUNT, DEADLINE);
      return { executionId: `mock:${quote.quoteId}`, quoteId: quote.quoteId, state: "confirmed", provider: "mock", steps: [] };
    };
    const runtime = createV01Runtime({ profile, entry: { source: "eip6963", info: { uuid: "x", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: env.wallet }, explicitlySelected: true, readProvider: env.readProvider, isCurrent: () => true, persistBeforeWalletRequest: () => true });
    await runtime.connect(); const input = request({ executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000103" }); const quote = await runtime.adapter.quote(route, input);
    await expect(runtime.adapter.execute(route, input, quote)).rejects.toThrow("V01_ALLOWANCE_CHANGED");
    expect(runtime.signatureWasRequested(quote)).toBe(false);
  });

  it.each([false, true])("classifies post-approval failure using whether swap was forwarded (%s)", async forwarded => {
    const env = runtimeFor(); await env.runtime.connect();
    const input = request(); const quote = await env.runtime.adapter.quote(route, input);
    const raw = env.wallet.request;
    env.wallet.request = async args => {
      const result = await raw(args);
      if (args.method === "eth_sendTransaction" && (args.params as any[])[0].to === POOL) throw new Error("RPC access denied after broadcast");
      return result;
    };
    mocks.base!.execute = async (_route, currentInput, currentQuote, onProgress) => {
      const approval = await mocks.client!.approveExact(AMBR, POOL, currentInput.amountInBaseUnits);
      onProgress({ executionId: `mock:${currentQuote.quoteId}`, quoteId: currentQuote.quoteId, state: "pending", provider: "mock", steps: [{ name: "Exact approval", kind: "approval", state: "confirmed", txHash: approval.hash, evmReceipt: { hash: approval.hash, status: 1, blockNumber: 101, blockHash: `0x${"d".repeat(64)}` } }] });
      if (forwarded) await mocks.client!.swapExactIn(POOL, AMBR, currentInput.amountInBaseUnits, currentQuote.minimumOutBaseUnits, ACCOUNT, Math.floor(currentQuote.expiresAt / 1000));
      throw new Error("block number unavailable before swap preparation");
    };
    const result = env.runtime.adapter.execute(route, input, quote);
    if (forwarded) await expect(result).rejects.toThrow("RPC access denied after broadcast");
    else await expect(result).resolves.toMatchObject({ state: "failed", failureProof: { type: "no-value-transfer-submitted" }, steps: [expect.objectContaining({ kind: "approval", state: "confirmed" }), expect.objectContaining({ state: "failed" })] });
    expect(env.calls.filter(call => call.method === "eth_sendTransaction")).toHaveLength(forwarded ? 2 : 1);
    expect(env.runtime.signatureWasRequested(quote)).toBe(true);
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("V01_QUOTE_NOT_CURRENT");
  });

  it("does not duplicate a wallet send after a failed send or after quote consumption", async () => {
    const env = runtimeFor(); await env.runtime.connect(); const input = request(); const quote = await env.runtime.adapter.quote(route, input);
    let attempts = 0;
    env.wallet.request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return CHAIN_HEX;
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [ACCOUNT];
      if (method === "eth_sendTransaction") { attempts++; throw new Error("ACTION_REJECTED"); }
      throw new Error(`unexpected ${method}`);
    });
    mocks.base!.execute = async (_route, _input, currentQuote) => {
      await expect(mocks.client!.approveExact(AMBR, POOL, 1_000n)).rejects.toThrow("ACTION_REJECTED");
      await mocks.client!.approveExact(AMBR, POOL, 1_000n);
      return { executionId: `mock:${currentQuote.quoteId}`, quoteId: currentQuote.quoteId, state: "confirmed", provider: "mock", steps: [] };
    };
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("V01_TRANSACTION_OUT_OF_SCOPE");
    expect(attempts).toBe(1);
    expect(env.runtime.signatureWasRequested(quote)).toBe(true);
    await expect(env.runtime.adapter.execute(route, input, quote)).rejects.toThrow("V01_QUOTE_NOT_CURRENT");
  });
});
