import { BrowserProvider, Contract, Interface, JsonRpcProvider, getAddress, type Eip1193Provider } from "ethers";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { assertRouteDescriptor, assertRouteRequest, routeDescriptorFingerprint, routeRequestFingerprint } from "../routing/engine";
import type { RouteDescriptor, RouteExecutionReceipt, RouteQuote, RouteQuoteRequest, UniversalRouteAdapter } from "../routing/types";
import { bindSubmittedEvmTransaction, waitForBoundEvmTransaction, type EvmTransactionLike } from "./evm-transaction-lifecycle";
import { isExplicitWalletRejection } from "../wallet/errors";

export type EvmLocalAmmClient = {
  connectAccount(requestAccess: boolean): Promise<{ account: string; chainId: bigint }>;
  poolTokens(pool: string): Promise<{ token0: string; token1: string }>;
  poolReserves(pool: string): Promise<{ reserve0: bigint; reserve1: bigint }>;
  quoteExactIn(pool: string, tokenIn: string, amountIn: bigint): Promise<bigint>;
  allowance(token: string, owner: string, spender: string): Promise<bigint>;
  blockNumber(): Promise<number>;
  approveExact(token: string, spender: string, amount: bigint): Promise<EvmTransactionLike>;
  swapExactIn(pool: string, tokenIn: string, amountIn: bigint, minimumOut: bigint, recipient: string, deadline: number): Promise<EvmTransactionLike>;
};

export type LocalAmmRouteConfig = {
  chainId: bigint;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  revision?: number;
  venueId?: string;
  venueLabel?: string;
  factoryAddress?: string;
  evidenceUrls?: string[];
};

export function createLocalAmmRouteDescriptor(config: LocalAmmRouteConfig): RouteDescriptor {
  const pool = getAddress(config.poolAddress);
  const tokenIn = getAddress(config.tokenIn);
  const tokenOut = getAddress(config.tokenOut);
  if (tokenIn === tokenOut || config.chainId <= 0n) throw new Error("LOCAL_AMM_ROUTE_INVALID");
  const chain = `eip155:${config.chainId}`;
  return {
    id: `evm-local-amm:${config.chainId}:${config.venueId ?? "manual"}:${pool.toLowerCase()}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`,
    revision: config.revision ?? 1,
    operation: "swap",
    adapterId: "evm-local-amm",
    sourceAsset: `${chain}/erc20:${tokenIn}`,
    destinationAsset: `${chain}/erc20:${tokenOut}`,
    state: "ready",
    walletCapabilityIds: ["eip1193"],
    sourceExecutionTarget: pool,
    executionMethod: "swapExactIn",
    maximumQuoteTtlMs: 10 * 60_000,
    finalityTracking: "tracked",
    trustBoundary: config.factoryAddress
      ? `${config.venueLabel ?? config.venueId ?? "RealDEX venue"}; exact bundled LocalSwapFactory runtime (RealDEX v1) at ${getAddress(config.factoryAddress)}, discovered pool, ERC-20 contracts, wallet, and connected RPC`
      : "Manually configured RealDEX LocalSwapPool v1 contract, ERC-20 contracts, wallet, and connected RPC",
    evidenceUrls: config.evidenceUrls ?? ["https://eips.ethereum.org/EIPS/eip-20"]
  };
}

export function createEvmLocalAmmAdapter(client: EvmLocalAmmClient): UniversalRouteAdapter {
  return {
    adapterId: "evm-local-amm",
    supports: (route) => route.adapterId === "evm-local-amm" && route.operation === "swap" && route.sourceAsset.startsWith("eip155:") && route.destinationAsset.startsWith("eip155:"),
    connectAccount: async (route) => {
      const session = await client.connectAccount(true);
      assertRouteChain(route, session.chainId);
      return `eip155:${session.chainId}:${session.account}`;
    },
    quote: async (route, request) => {
      assertRouteDescriptor(route); assertRouteRequest(request);
      const session = await client.connectAccount(false);
      assertRouteChain(route, session.chainId);
      assertAccount(request.accountId, session.account, session.chainId);
      const tokenIn = assetAddress(route.sourceAsset);
      const tokenOut = assetAddress(route.destinationAsset);
      const pool = getAddress(route.sourceExecutionTarget);
      const pair = await client.poolTokens(pool);
      assertPoolPair(pair, tokenIn, tokenOut);
      const [expectedOut, allowance, reserves] = await Promise.all([
        client.quoteExactIn(pool, tokenIn, request.amountInBaseUnits),
        client.allowance(tokenIn, session.account, pool),
        client.poolReserves(pool)
      ]);
      if (expectedOut <= 0n) throw new Error("LOCAL_AMM_QUOTE_EMPTY");
      const now = Date.now();
      const expiresAt = now + route.maximumQuoteTtlMs;
      return {
        quoteId: `evm-swap:${routeDescriptorFingerprint(route)}:${routeRequestFingerprint(request)}:${expiresAt}`,
        routeId: route.id,
        routeFingerprint: routeDescriptorFingerprint(route),
        requestFingerprint: routeRequestFingerprint(request),
        adapterId: route.adapterId,
        amountInBaseUnits: request.amountInBaseUnits,
        expectedOutBaseUnits: expectedOut,
        minimumOutBaseUnits: applySlippage(expectedOut, request.slippageBps),
        priceImpactBps: calculatePriceImpactBps(tokenIn, pair, reserves, request.amountInBaseUnits, expectedOut),
        fees: [],
        unpricedCosts: ["Network gas is estimated by the wallet before the exact approval and swap transactions."],
        expiresAt,
        estimatedSeconds: null,
        authorization: allowance >= request.amountInBaseUnits
          ? { type: "none" }
          : { type: "approval", spender: pool, amountBaseUnits: request.amountInBaseUnits, expiresAt: null },
        executionPreview: { chainId: `eip155:${session.chainId}`, target: pool, method: "swapExactIn", valueBaseUnits: 0n },
        adapterData: { format: "evm-local-amm.swap.v1", value: { pool, tokenIn, tokenOut, deadline: Math.floor(expiresAt / 1000) } }
      };
    },
    execute: async (route, request, quote, onProgress) => {
      const payload = swapPayload(quote);
      if (payload.pool.toLowerCase() !== route.sourceExecutionTarget.toLowerCase() || payload.tokenIn.toLowerCase() !== assetAddress(route.sourceAsset).toLowerCase() || payload.tokenOut.toLowerCase() !== assetAddress(route.destinationAsset).toLowerCase()) throw new Error("LOCAL_AMM_EXECUTION_PAYLOAD_MISMATCH");
      const session = await client.connectAccount(false);
      assertRouteChain(route, session.chainId); assertAccount(request.accountId, session.account, session.chainId);
      const steps: RouteExecutionReceipt["steps"] = [];
      const allowance = await client.allowance(payload.tokenIn, session.account, payload.pool);
      if (allowance < request.amountInBaseUnits) {
        const observedBeforeBlock = await client.blockNumber();
        let approval: EvmTransactionLike;
        try { approval = await client.approveExact(payload.tokenIn, payload.pool, request.amountInBaseUnits); }
        catch (reason) { if (isExplicitWalletRejection(reason)) return failedReceipt(quote, "Exact approval", reason); throw reason; }
        const evidence = bindSubmittedEvmTransaction(approval, {
          from: session.account, to: payload.tokenIn, nonce: approval.nonce,
          data: new Interface(ERC20_ABI).encodeFunctionData("approve", [payload.pool, request.amountInBaseUnits]),
          valueBaseUnits: "0", chainId: session.chainId.toString()
        }, observedBeforeBlock);
        steps.push({ name: "Exact token approval", state: "submitted", kind: "approval", txHash: approval.hash, evmTransaction: evidence });
        onProgress?.(pendingReceipt(quote, steps));
        const result = await waitForBoundEvmTransaction(approval, evidence);
        steps[0] = { ...steps[0], state: result.state, evmTransaction: result.transaction, evmReceipt: result.receipt };
        if (result.state === "unknown" || result.state === "replaced") return unknownReceipt(quote, "Approval outcome is not the bound approval; do not submit the swap or reuse this Quote.", steps);
        if (result.state === "reverted") {
          return failedReceipt(quote, "Exact approval reverted", undefined, steps);
        }
        onProgress?.(pendingReceipt(quote, steps));
      }
      if (quote.expiresAt <= Date.now()) return failedReceipt(quote, "Quote expired after approval; no swap was submitted.", undefined, steps);
      const observedBeforeBlock = await client.blockNumber();
      let swap: EvmTransactionLike;
      try { swap = await client.swapExactIn(payload.pool, payload.tokenIn, request.amountInBaseUnits, quote.minimumOutBaseUnits, request.recipient, payload.deadline); }
      catch (reason) { if (isExplicitWalletRejection(reason)) return failedReceipt(quote, "Swap transaction rejected; no swap was submitted.", reason, steps); throw reason; }
      const evidence = bindSubmittedEvmTransaction(swap, {
        from: session.account, to: payload.pool, nonce: swap.nonce,
        data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [payload.tokenIn, request.amountInBaseUnits, quote.minimumOutBaseUnits, request.recipient, payload.deadline]),
        valueBaseUnits: "0", chainId: session.chainId.toString()
      }, observedBeforeBlock);
      steps.push({ name: "Swap transaction", state: "submitted", kind: "swap", txHash: swap.hash, evmTransaction: evidence });
      onProgress?.(pendingReceipt(quote, steps));
      const result = await waitForBoundEvmTransaction(swap, evidence);
      steps[steps.length - 1] = { ...steps[steps.length - 1], state: result.state, evmTransaction: result.transaction, evmReceipt: result.receipt };
      if (result.state === "unknown" || result.state === "replaced") return unknownReceipt(quote, "Swap outcome is not proven for the bound transaction; do not resubmit this Quote.", steps);
      if (result.state === "reverted") {
        return failedReceipt(quote, "Swap transaction reverted.", undefined, steps);
      }
      return { executionId: `evm-swap:${swap.hash}`, quoteId: quote.quoteId, state: "confirmed", provider: "RealDEX Pool v1", steps };
    }
  };
}

export function createBrowserEvmLocalAmmClient(readProvider: JsonRpcProvider, ethereum: Eip1193Provider): EvmLocalAmmClient {
  const walletProvider = new BrowserProvider(ethereum);
  return {
    connectAccount: async (requestAccess) => {
      const accounts = await walletProvider.send(requestAccess ? "eth_requestAccounts" : "eth_accounts", []);
      const network = await walletProvider.getNetwork();
      if (!accounts[0]) throw new Error("EVM_ACCOUNT_UNAVAILABLE");
      return { account: getAddress(accounts[0]), chainId: network.chainId };
    },
    poolTokens: async (pool) => {
      const contract = new Contract(pool, POOL_ABI, readProvider);
      const [token0, token1] = await Promise.all([contract.token0(), contract.token1()]);
      return { token0: getAddress(token0), token1: getAddress(token1) };
    },
    poolReserves: async (pool) => {
      const reserves = await new Contract(pool, POOL_ABI, readProvider).getReserves();
      return { reserve0: BigInt(reserves[0]), reserve1: BigInt(reserves[1]) };
    },
    quoteExactIn: async (pool, tokenIn, amountIn) => new Contract(pool, POOL_ABI, readProvider).quoteExactIn(tokenIn, amountIn),
    allowance: async (token, owner, spender) => new Contract(token, ERC20_ABI, readProvider).allowance(owner, spender),
    blockNumber: () => readProvider.getBlockNumber(),
    approveExact: async (token, spender, amount) => new Contract(token, ERC20_ABI, await walletProvider.getSigner()).approve(spender, amount),
    swapExactIn: async (pool, tokenIn, amountIn, minimumOut, recipient, deadline) => new Contract(pool, POOL_ABI, await walletProvider.getSigner()).swapExactIn(tokenIn, amountIn, minimumOut, recipient, deadline)
  };
}

function assetAddress(assetType: string): string {
  const marker = "/erc20:";
  const index = assetType.indexOf(marker);
  if (index < 0) throw new Error("LOCAL_AMM_ASSET_UNSUPPORTED");
  return getAddress(assetType.slice(index + marker.length));
}

function assertRouteChain(route: RouteDescriptor, chainId: bigint): void {
  if (!route.sourceAsset.startsWith(`eip155:${chainId}/`) || !route.destinationAsset.startsWith(`eip155:${chainId}/`)) throw new Error("WALLET_NETWORK_CHANGED");
}

function assertAccount(accountId: string, account: string, chainId: bigint): void {
  if (accountId.toLowerCase() !== `eip155:${chainId}:${account}`.toLowerCase()) throw new Error("WALLET_ACCOUNT_CHANGED");
}

function assertPoolPair(pair: { token0: string; token1: string }, tokenIn: string, tokenOut: string): void {
  const actual = new Set([getAddress(pair.token0).toLowerCase(), getAddress(pair.token1).toLowerCase()]);
  if (actual.size !== 2 || !actual.has(tokenIn.toLowerCase()) || !actual.has(tokenOut.toLowerCase())) throw new Error("LOCAL_AMM_POOL_PAIR_CHANGED");
}

function applySlippage(value: bigint, slippageBps: number): bigint {
  const minimum = value * BigInt(10_000 - slippageBps) / 10_000n;
  if (minimum <= 0n) throw new Error("QUOTE_MINIMUM_OUT_ZERO");
  return minimum;
}

function calculatePriceImpactBps(
  tokenIn: string,
  pair: { token0: string; token1: string },
  reserves: { reserve0: bigint; reserve1: bigint },
  amountIn: bigint,
  amountOut: bigint
): number {
  const zeroForOne = getAddress(tokenIn) === getAddress(pair.token0);
  const reserveIn = zeroForOne ? reserves.reserve0 : reserves.reserve1;
  const reserveOut = zeroForOne ? reserves.reserve1 : reserves.reserve0;
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("LOCAL_AMM_RESERVES_EMPTY");
  const spotScaled = reserveOut * 10n ** 18n / reserveIn;
  const executionScaled = amountOut * 10n ** 18n / amountIn;
  if (spotScaled <= 0n || executionScaled > spotScaled) throw new Error("LOCAL_AMM_PRICE_IMPACT_INVALID");
  return Number((spotScaled - executionScaled) * 10_000n / spotScaled);
}

function swapPayload(quote: RouteQuote): { pool: string; tokenIn: string; tokenOut: string; deadline: number } {
  if (quote.adapterData.format !== "evm-local-amm.swap.v1" || !quote.adapterData.value || typeof quote.adapterData.value !== "object") throw new Error("LOCAL_AMM_EXECUTION_PAYLOAD_INVALID");
  const value = quote.adapterData.value as { pool?: string; tokenIn?: string; tokenOut?: string; deadline?: number };
  if (!value.pool || !value.tokenIn || !value.tokenOut || !Number.isInteger(value.deadline) || Number(value.deadline) <= 0) throw new Error("LOCAL_AMM_EXECUTION_PAYLOAD_INVALID");
  return { pool: getAddress(value.pool), tokenIn: getAddress(value.tokenIn), tokenOut: getAddress(value.tokenOut), deadline: Number(value.deadline) };
}

function pendingReceipt(quote: RouteQuote, steps: RouteExecutionReceipt["steps"]): RouteExecutionReceipt {
  return { executionId: `evm-swap:${quote.quoteId}`, quoteId: quote.quoteId, state: "pending", provider: "RealDEX Pool v1", steps: [...steps] };
}

function failedReceipt(quote: RouteQuote, detail: string, reason?: unknown, previous: RouteExecutionReceipt["steps"] = []): RouteExecutionReceipt {
  const revertedSwap = previous.find((step) => step.kind === "swap" && step.txHash && step.evmReceipt?.status === 0);
  const failureProof = revertedSwap
    ? { type: "evm-value-transfer-reverted" as const, transactionHash: revertedSwap.txHash! }
    : { type: "no-value-transfer-submitted" as const };
  // Rejection errors from Ethers can include a very long provider payload. Keep the
  // receipt bounded and avoid persisting arbitrary RPC text or embedded credentials.
  return { executionId: `evm-swap:${quote.quoteId}:failed`, quoteId: quote.quoteId, state: "failed", provider: "RealDEX Pool v1", steps: [...previous, { name: detail, state: "failed", errorMessage: reason === undefined ? undefined : "Wallet rejected the request." }], failureProof };
}

function unknownReceipt(quote: RouteQuote, detail: string, previous: RouteExecutionReceipt["steps"]): RouteExecutionReceipt {
  return { executionId: `evm-swap:${quote.quoteId}:unknown`, quoteId: quote.quoteId, state: "unknown", provider: "RealDEX Pool v1", steps: [...previous, { name: detail, state: "unknown" }] };
}
