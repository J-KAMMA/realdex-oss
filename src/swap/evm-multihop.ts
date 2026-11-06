import { BrowserProvider, Contract, Interface, JsonRpcProvider, getAddress, keccak256, type Eip1193Provider } from "ethers";
import { ERC20_ABI, POOL_ABI, ROUTER_ABI } from "../abi";
import { assertRouteDescriptor, assertRouteRequest, routeDescriptorFingerprint, routeRequestFingerprint } from "../routing/engine";
import type { RouteDescriptor, RouteExecutionReceipt, RouteQuote, RouteQuoteRequest, UniversalRouteAdapter } from "../routing/types";
import codeIdentities from "./local-amm-code-identities.json";
import { discoverLocalAmmVenues, type EvmLocalAmmVenue, type EvmVenueDiscoveryClient } from "./evm-venue-discovery";
import { bindSubmittedEvmTransaction, waitForBoundEvmTransaction, type EvmTransactionLike } from "./evm-transaction-lifecycle";

const MAX_GRAPH_TOKENS = 6;
const MAX_HOPS = 4;
const MAX_PATHS = 128;

export type EvmMultiHopPath = {
  chainId: bigint;
  router: string;
  pools: string[];
  tokens: string[];
};

export type EvmMultiHopDiscoveryResult = {
  routes: RouteDescriptor[];
  paths: Map<string, EvmMultiHopPath>;
  rejected: Array<{ venueId: string; code: string; detail?: string }>;
};

export type EvmMultiHopClient = {
  connectAccount(requestAccess: boolean): Promise<{ account: string; chainId: bigint }>;
  code(address: string): Promise<string>;
  poolTokens(pool: string): Promise<{ token0: string; token1: string }>;
  quoteExactIn(router: string, pools: string[], tokenIn: string, amountIn: bigint): Promise<{ amountOut: bigint; tokenOut: string }>;
  allowance(token: string, owner: string, spender: string): Promise<bigint>;
  blockNumber(): Promise<number>;
  approveExact(token: string, spender: string, amount: bigint): Promise<EvmTransactionLike>;
  swapExactIn(router: string, pools: string[], tokenIn: string, amountIn: bigint, minimumOut: bigint, recipient: string, deadline: number): Promise<EvmTransactionLike>;
};

export const BUNDLED_LOCAL_AMM_ROUTER_CODE_HASH = codeIdentities.routerRuntimeCodeHash;

export function parseIntermediateTokens(value: string): string[] {
  const raw = value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
  if (raw.length > MAX_GRAPH_TOKENS - 2) throw new Error("EVM_MULTIHOP_TOKEN_LIMIT_EXCEEDED");
  const unique = new Map<string, string>();
  for (const item of raw) {
    let token: string;
    try { token = getAddress(item); } catch { throw new Error("EVM_MULTIHOP_TOKEN_INVALID"); }
    unique.set(token.toLowerCase(), token);
  }
  return [...unique.values()];
}

export async function discoverEvmMultiHopRoutes(config: {
  venues: readonly EvmLocalAmmVenue[];
  routerAddress: string;
  tokenIn: string;
  tokenOut: string;
  intermediateTokens: readonly string[];
  client: EvmVenueDiscoveryClient;
}): Promise<EvmMultiHopDiscoveryResult> {
  const router = getAddress(config.routerAddress);
  const tokenIn = getAddress(config.tokenIn);
  const tokenOut = getAddress(config.tokenOut);
  if (tokenIn === tokenOut) throw new Error("EVM_MULTIHOP_PAIR_INVALID");
  const chainId = await config.client.chainId();
  if (config.venues.some((venue) => venue.chainId !== chainId)) throw new Error("EVM_MULTIHOP_CHAIN_MISMATCH");
  await verifyRouterRuntime(router, config.client);
  const graphTokens = uniqueAddresses([tokenIn, ...config.intermediateTokens, tokenOut]);
  if (graphTokens.length > MAX_GRAPH_TOKENS) throw new Error("EVM_MULTIHOP_TOKEN_LIMIT_EXCEEDED");

  type Edge = { pool: string; from: string; to: string };
  const adjacency = new Map<string, Edge[]>();
  const rejected: EvmMultiHopDiscoveryResult["rejected"] = [];
  // Every pair in the graph is an independent question, so they are asked at once
  // and read back in the order they were listed. The order still decides which
  // edges enter the graph first, and so the order the paths come out in.
  const graphPairs: Array<[string, string]> = [];
  for (let left = 0; left < graphTokens.length; left++) {
    for (let right = left + 1; right < graphTokens.length; right++) graphPairs.push([graphTokens[left], graphTokens[right]]);
  }
  const discoveredPairs = await Promise.all(graphPairs.map(([from, to]) => discoverLocalAmmVenues(config.venues, from, to, config.client)));
  for (const [index, discovered] of discoveredPairs.entries()) {
    const [from, to] = graphPairs[index];
    rejected.push(...discovered.rejected
      .filter((item) => item.code !== "EVM_VENUE_POOL_NOT_FOUND")
      .map((item) => ({ ...item, detail: item.detail ?? `${from} -> ${to}` })));
    for (const route of discovered.routes) {
      addEdge(adjacency, { pool: getAddress(route.sourceExecutionTarget), from, to });
      addEdge(adjacency, { pool: getAddress(route.sourceExecutionTarget), from: to, to: from });
    }
  }

  const paths = new Map<string, EvmMultiHopPath>();
  const routes: RouteDescriptor[] = [];
  const visit = (current: string, tokens: string[], pools: string[]) => {
    if (routes.length >= MAX_PATHS || pools.length >= MAX_HOPS) return;
    for (const edge of adjacency.get(current.toLowerCase()) ?? []) {
      if (tokens.some((token) => token.toLowerCase() === edge.to.toLowerCase()) || pools.some((pool) => pool.toLowerCase() === edge.pool.toLowerCase())) continue;
      const nextTokens = [...tokens, edge.to];
      const nextPools = [...pools, edge.pool];
      if (edge.to.toLowerCase() === tokenOut.toLowerCase()) {
        if (nextPools.length < 2) continue;
        const path: EvmMultiHopPath = { chainId, router, pools: nextPools, tokens: nextTokens };
        const route = createEvmMultiHopRouteDescriptor(path);
        if (!paths.has(route.id)) { paths.set(route.id, path); routes.push(route); }
      } else visit(edge.to, nextTokens, nextPools);
    }
  };
  visit(tokenIn, [tokenIn], []);
  return { routes, paths, rejected };
}

export function createEvmMultiHopRouteDescriptor(path: EvmMultiHopPath): RouteDescriptor {
  assertPath(path);
  const source = path.tokens[0];
  const destination = path.tokens.at(-1)!;
  const identity = path.pools.map((pool) => pool.toLowerCase()).join("-");
  const chain = `eip155:${path.chainId}`;
  return {
    id: `evm-local-amm-router:${path.chainId}:${path.router.toLowerCase()}:${identity}:${source.toLowerCase()}:${destination.toLowerCase()}`,
    revision: 1,
    operation: "swap",
    adapterId: "evm-local-amm-router",
    sourceAsset: `${chain}/erc20:${source}`,
    destinationAsset: `${chain}/erc20:${destination}`,
    state: "ready",
    walletCapabilityIds: ["eip1193"],
    sourceExecutionTarget: path.router,
    executionMethod: "swapExactIn",
    maximumQuoteTtlMs: 10 * 60_000,
    finalityTracking: "tracked",
    trustBoundary: `Exact bundled RealDEX LocalSwapRouter v1 runtime; ${path.pools.length} pools individually verified against exact bundled LocalSwapFactory v1 runtime; ERC-20 contracts, wallet, and connected RPC`,
    evidenceUrls: ["https://eips.ethereum.org/EIPS/eip-20"]
  };
}

export function createEvmMultiHopAdapter(client: EvmMultiHopClient, paths: ReadonlyMap<string, EvmMultiHopPath>, expectedRouterCodeHash = BUNDLED_LOCAL_AMM_ROUTER_CODE_HASH): UniversalRouteAdapter {
  if (!/^0x[0-9a-f]{64}$/.test(expectedRouterCodeHash)) throw new Error("EVM_MULTIHOP_ROUTER_IDENTITY_INVALID");
  return {
    adapterId: "evm-local-amm-router",
    supports: (route) => route.adapterId === "evm-local-amm-router" && paths.has(route.id),
    connectAccount: async (route) => {
      const session = await client.connectAccount(true);
      assertRouteChain(route, session.chainId);
      return `eip155:${session.chainId}:${session.account}`;
    },
    quote: async (route, request) => {
      assertRouteDescriptor(route); assertRouteRequest(request);
      const path = boundPath(route, paths);
      const session = await client.connectAccount(false);
      assertRouteChain(route, session.chainId); assertAccount(request.accountId, session.account, session.chainId);
      await verifyExecutionPath(path, client, expectedRouterCodeHash);
      const result = await client.quoteExactIn(path.router, path.pools, path.tokens[0], request.amountInBaseUnits);
      if (result.amountOut <= 0n || getAddress(result.tokenOut) !== path.tokens.at(-1)) throw new Error("EVM_MULTIHOP_QUOTE_INVALID");
      const allowance = await client.allowance(path.tokens[0], session.account, path.router);
      const expiresAt = Date.now() + route.maximumQuoteTtlMs;
      return {
        quoteId: `evm-multihop:${routeDescriptorFingerprint(route)}:${routeRequestFingerprint(request)}:${expiresAt}`,
        routeId: route.id,
        routeFingerprint: routeDescriptorFingerprint(route),
        requestFingerprint: routeRequestFingerprint(request),
        adapterId: route.adapterId,
        amountInBaseUnits: request.amountInBaseUnits,
        expectedOutBaseUnits: result.amountOut,
        minimumOutBaseUnits: applySlippage(result.amountOut, request.slippageBps),
        fees: [],
        unpricedCosts: [`Network gas covers one exact approval when needed and one atomic ${path.pools.length}-hop swap.`],
        expiresAt,
        estimatedSeconds: null,
        authorization: allowance >= request.amountInBaseUnits ? { type: "none" } : { type: "approval", spender: path.router, amountBaseUnits: request.amountInBaseUnits, expiresAt: null },
        executionPreview: { chainId: `eip155:${session.chainId}`, target: path.router, method: "swapExactIn", valueBaseUnits: 0n },
        adapterData: { format: "evm-local-amm.multihop.v1", value: { router: path.router, pools: path.pools, tokens: path.tokens, deadline: Math.floor(expiresAt / 1000) } }
      };
    },
    execute: async (route, request, quote, onProgress) => {
      const path = boundPath(route, paths);
      const payload = executionPayload(quote);
      assertPayloadMatches(path, payload);
      const session = await client.connectAccount(false);
      assertRouteChain(route, session.chainId); assertAccount(request.accountId, session.account, session.chainId);
      await verifyExecutionPath(path, client, expectedRouterCodeHash);
      const steps: RouteExecutionReceipt["steps"] = [];
      const allowance = await client.allowance(path.tokens[0], session.account, path.router);
      if (allowance < request.amountInBaseUnits) {
        const observedBeforeBlock = await client.blockNumber();
        let approval: EvmTransactionLike;
        try { approval = await client.approveExact(path.tokens[0], path.router, request.amountInBaseUnits); }
        catch (reason) { if (isWalletRejection(reason)) return failedReceipt(quote, "Exact router approval rejected; no swap was submitted.", reason); throw reason; }
        const evidence = bindSubmittedEvmTransaction(approval, {
          from: session.account, to: path.tokens[0], nonce: approval.nonce,
          data: new Interface(ERC20_ABI).encodeFunctionData("approve", [path.router, request.amountInBaseUnits]),
          valueBaseUnits: "0", chainId: session.chainId.toString()
        }, observedBeforeBlock);
        steps.push({ name: "Exact router approval", state: "submitted", kind: "approval", txHash: approval.hash, evmTransaction: evidence });
        onProgress?.(pendingReceipt(quote, steps));
        const result = await waitForBoundEvmTransaction(approval, evidence);
        steps[0] = { ...steps[0], state: result.state, evmTransaction: result.transaction, evmReceipt: result.receipt };
        if (result.state === "unknown" || result.state === "replaced") return unknownReceipt(quote, "Router approval outcome is not the bound approval; do not submit the swap or reuse this Quote.", steps);
        if (result.state === "reverted") {
          return failedReceipt(quote, "Exact router approval reverted.", undefined, steps);
        }
        onProgress?.(pendingReceipt(quote, steps));
      }
      if (quote.expiresAt <= Date.now()) return failedReceipt(quote, "Quote expired after approval; no swap was submitted.", undefined, steps);
      await verifyExecutionPath(path, client, expectedRouterCodeHash);
      const observedBeforeBlock = await client.blockNumber();
      let swap: EvmTransactionLike;
      try { swap = await client.swapExactIn(path.router, path.pools, path.tokens[0], request.amountInBaseUnits, quote.minimumOutBaseUnits, request.recipient, payload.deadline); }
      catch (reason) { if (isWalletRejection(reason)) return failedReceipt(quote, "Atomic swap rejected; no swap was submitted.", reason, steps); throw reason; }
      const evidence = bindSubmittedEvmTransaction(swap, {
        from: session.account, to: path.router, nonce: swap.nonce,
        data: new Interface(ROUTER_ABI).encodeFunctionData("swapExactIn", [path.pools, path.tokens[0], request.amountInBaseUnits, quote.minimumOutBaseUnits, request.recipient, payload.deadline]),
        valueBaseUnits: "0", chainId: session.chainId.toString()
      }, observedBeforeBlock);
      steps.push({ name: `Atomic ${path.pools.length}-hop swap`, state: "submitted", kind: "swap", txHash: swap.hash, evmTransaction: evidence });
      onProgress?.(pendingReceipt(quote, steps));
      const result = await waitForBoundEvmTransaction(swap, evidence);
      steps[steps.length - 1] = { ...steps[steps.length - 1], state: result.state, evmTransaction: result.transaction, evmReceipt: result.receipt };
      if (result.state === "unknown" || result.state === "replaced") return unknownReceipt(quote, "Atomic swap outcome is not proven for the bound transaction; do not resubmit this Quote.", steps);
      if (result.state === "reverted") {
        return failedReceipt(quote, "Atomic swap reverted; every hop was rolled back.", undefined, steps);
      }
      return { executionId: `evm-multihop:${swap.hash}`, quoteId: quote.quoteId, state: "confirmed", provider: "RealDEX Router v1", steps };
    }
  };
}

export function createBrowserEvmMultiHopClient(readProvider: JsonRpcProvider, ethereum: Eip1193Provider): EvmMultiHopClient {
  const walletProvider = new BrowserProvider(ethereum);
  return {
    connectAccount: async (requestAccess) => {
      const accounts = await walletProvider.send(requestAccess ? "eth_requestAccounts" : "eth_accounts", []);
      const network = await walletProvider.getNetwork();
      if (!accounts[0]) throw new Error("EVM_ACCOUNT_UNAVAILABLE");
      return { account: getAddress(accounts[0]), chainId: network.chainId };
    },
    code: (address) => readProvider.getCode(address),
    poolTokens: async (pool) => {
      const contract = new Contract(pool, POOL_ABI, readProvider);
      const [token0, token1] = await Promise.all([contract.token0(), contract.token1()]);
      return { token0: getAddress(token0), token1: getAddress(token1) };
    },
    quoteExactIn: async (router, pools, tokenIn, amountIn) => {
      const result = await new Contract(router, ROUTER_ABI, readProvider).quoteExactIn(pools, tokenIn, amountIn);
      return { amountOut: BigInt(result[0]), tokenOut: getAddress(result[1]) };
    },
    allowance: async (token, owner, spender) => new Contract(token, ERC20_ABI, readProvider).allowance(owner, spender),
    blockNumber: () => readProvider.getBlockNumber(),
    approveExact: async (token, spender, amount) => new Contract(token, ERC20_ABI, await walletProvider.getSigner()).approve(spender, amount),
    swapExactIn: async (router, pools, tokenIn, amountIn, minimumOut, recipient, deadline) => new Contract(router, ROUTER_ABI, await walletProvider.getSigner()).swapExactIn(pools, tokenIn, amountIn, minimumOut, recipient, deadline)
  };
}

async function verifyRouterRuntime(router: string, client: Pick<EvmMultiHopClient, "code"> | Pick<EvmVenueDiscoveryClient, "code">, expectedCodeHash = BUNDLED_LOCAL_AMM_ROUTER_CODE_HASH): Promise<void> {
  const code = await client.code(router);
  if (!code || code === "0x" || keccak256(code) !== expectedCodeHash.toLowerCase()) throw new Error("EVM_MULTIHOP_ROUTER_CODE_MISMATCH");
}

async function verifyExecutionPath(path: EvmMultiHopPath, client: Pick<EvmMultiHopClient, "code" | "poolTokens">, expectedCodeHash: string): Promise<void> {
  assertPath(path);
  await verifyRouterRuntime(path.router, client, expectedCodeHash);
  for (let i = 0; i < path.pools.length; i++) {
    const pair = await client.poolTokens(path.pools[i]);
    const actual = new Set([getAddress(pair.token0).toLowerCase(), getAddress(pair.token1).toLowerCase()]);
    if (actual.size !== 2 || !actual.has(path.tokens[i].toLowerCase()) || !actual.has(path.tokens[i + 1].toLowerCase())) throw new Error("EVM_MULTIHOP_POOL_PATH_CHANGED");
  }
}

function assertPath(path: EvmMultiHopPath): void {
  if (path.chainId <= 0n || getAddress(path.router) !== path.router || path.pools.length < 2 || path.pools.length > MAX_HOPS || path.tokens.length !== path.pools.length + 1) throw new Error("EVM_MULTIHOP_PATH_INVALID");
  const pools = path.pools.map(getAddress);
  const tokens = path.tokens.map(getAddress);
  if (new Set(pools.map((value) => value.toLowerCase())).size !== pools.length || new Set(tokens.map((value) => value.toLowerCase())).size !== tokens.length) throw new Error("EVM_MULTIHOP_PATH_CYCLIC");
}

function boundPath(route: RouteDescriptor, paths: ReadonlyMap<string, EvmMultiHopPath>): EvmMultiHopPath {
  const path = paths.get(route.id);
  if (!path || route.sourceExecutionTarget.toLowerCase() !== path.router.toLowerCase()) throw new Error("EVM_MULTIHOP_ROUTE_UNBOUND");
  assertPath(path);
  return path;
}

function executionPayload(quote: RouteQuote): { router: string; pools: string[]; tokens: string[]; deadline: number } {
  if (quote.adapterData.format !== "evm-local-amm.multihop.v1" || !quote.adapterData.value || typeof quote.adapterData.value !== "object") throw new Error("EVM_MULTIHOP_PAYLOAD_INVALID");
  const value = quote.adapterData.value as { router?: string; pools?: string[]; tokens?: string[]; deadline?: number };
  if (!value.router || !Array.isArray(value.pools) || !Array.isArray(value.tokens) || !Number.isInteger(value.deadline) || Number(value.deadline) <= 0) throw new Error("EVM_MULTIHOP_PAYLOAD_INVALID");
  return { router: getAddress(value.router), pools: value.pools.map(getAddress), tokens: value.tokens.map(getAddress), deadline: Number(value.deadline) };
}

function assertPayloadMatches(path: EvmMultiHopPath, payload: ReturnType<typeof executionPayload>): void {
  if (payload.router !== path.router || payload.pools.length !== path.pools.length || payload.tokens.length !== path.tokens.length || payload.pools.some((value, index) => value !== path.pools[index]) || payload.tokens.some((value, index) => value !== path.tokens[index])) throw new Error("EVM_MULTIHOP_PAYLOAD_MISMATCH");
}

function uniqueAddresses(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) { const address = getAddress(value); unique.set(address.toLowerCase(), address); }
  return [...unique.values()];
}

function addEdge(adjacency: Map<string, Array<{ pool: string; from: string; to: string }>>, edge: { pool: string; from: string; to: string }) {
  const key = edge.from.toLowerCase();
  const list = adjacency.get(key) ?? [];
  if (!list.some((item) => item.pool.toLowerCase() === edge.pool.toLowerCase() && item.to.toLowerCase() === edge.to.toLowerCase())) list.push(edge);
  adjacency.set(key, list);
}

function applySlippage(value: bigint, slippageBps: number): bigint {
  const minimum = value * BigInt(10_000 - slippageBps) / 10_000n;
  if (minimum <= 0n) throw new Error("QUOTE_MINIMUM_OUT_ZERO");
  return minimum;
}

function assertRouteChain(route: RouteDescriptor, chainId: bigint): void {
  if (!route.sourceAsset.startsWith(`eip155:${chainId}/`) || !route.destinationAsset.startsWith(`eip155:${chainId}/`)) throw new Error("WALLET_NETWORK_CHANGED");
}

function assertAccount(accountId: string, account: string, chainId: bigint): void {
  if (accountId.toLowerCase() !== `eip155:${chainId}:${account}`.toLowerCase()) throw new Error("WALLET_ACCOUNT_CHANGED");
}

function pendingReceipt(quote: RouteQuote, steps: RouteExecutionReceipt["steps"]): RouteExecutionReceipt {
  return { executionId: `evm-multihop:${quote.quoteId}`, quoteId: quote.quoteId, state: "pending", provider: "RealDEX Router v1", steps: [...steps] };
}

function failedReceipt(quote: RouteQuote, detail: string, reason?: unknown, previous: RouteExecutionReceipt["steps"] = []): RouteExecutionReceipt {
  const revertedSwap = previous.find((step) => step.kind === "swap" && step.txHash && step.evmReceipt?.status === 0);
  const failureProof = revertedSwap
    ? { type: "evm-value-transfer-reverted" as const, transactionHash: revertedSwap.txHash! }
    : { type: "no-value-transfer-submitted" as const };
  return { executionId: `evm-multihop:${quote.quoteId}:failed`, quoteId: quote.quoteId, state: "failed", provider: "RealDEX Router v1", steps: [...previous, { name: detail, state: "failed", errorMessage: reason instanceof Error ? reason.message : reason ? String(reason) : undefined }], failureProof };
}

function unknownReceipt(quote: RouteQuote, detail: string, previous: RouteExecutionReceipt["steps"]): RouteExecutionReceipt {
  return { executionId: `evm-multihop:${quote.quoteId}:unknown`, quoteId: quote.quoteId, state: "unknown", provider: "RealDEX Router v1", steps: [...previous, { name: detail, state: "unknown" }] };
}

function isWalletRejection(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /rejected|denied|ACTION_REJECTED|4001/i.test(message);
}
