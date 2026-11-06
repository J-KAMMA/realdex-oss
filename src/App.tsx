import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, ZeroAddress, formatUnits, isAddress } from "ethers";
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Droplets,
  ExternalLink,
  Github,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Unplug,
  Wallet
} from "lucide-react";
import { ERC20_ABI, FACTORY_ABI, POOL_ABI, ROUTER_ABI } from "./abi";
import BridgePanel from "./bridge/BridgePanel";
import UniversePanel from "./universe/UniversePanel";
import { executeRouteQuote, quoteRoutes } from "./routing/engine";
import { createRouteExecutionIntentId } from "./routing/execution-intent";
import { findRoutePlanGaps, findRoutePlans, type RoutePlan, type RoutePlanGap } from "./routing/plan";
import { ROUTE_DESCRIPTORS } from "./routing/registry";
import { readRoutePlanProgress, routePlanStateFromRecord, type RoutePlanState } from "./routing/plan-progress";
import { BUILT_IN_ASSETS } from "./universe/registry";
import type { RouteDescriptor, RouteQuote, RouteQuoteRequest, UniversalRouteAdapter } from "./routing/types";
import { createBrowserEvmLocalAmmClient, createEvmLocalAmmAdapter } from "./swap/evm-local-amm";
import { createBrowserEvmMultiHopClient, createEvmMultiHopAdapter, discoverEvmMultiHopRoutes, parseIntermediateTokens, type EvmMultiHopPath } from "./swap/evm-multihop";
import EvmSwapRecoveryCard from "./swap/EvmSwapRecoveryCard";
import { createJsonRpcEvmSwapRecoveryReader, readEvmSwapRecoveryJournal, recordEvmSwapReceipt, refreshEvmSwapRecovery, writeEvmSwapRecoveryRecord, type EvmSwapRecoveryRecord } from "./swap/evm-swap-recovery";
import { depositResidue as computeDepositResidue } from "./swap/deposit-residue";
import { PROVIDER_TIER_DISCLAIMER, describeProviderTiers, type PoolTierReading } from "./swap/provider-tier-choice";
import { createBrowserPoolTierReader, readPoolTiers } from "./swap/read-pool-tiers";
import { defaultWithdrawPool, describeWithdrawTiers, withdrawalAmounts } from "./swap/withdraw-tier-choice";
import { estimateLiquidityShares } from "./swap/deposit-shares";
import { venueConfigKey as buildVenueConfigKey } from "./swap/venue-config-key";
import { compareFeeTiers } from "./swap/fee-tier-comparison";
import { configuredLocalAmmVenues, createBrowserEvmVenueDiscoveryClient, createCachingEvmVenueDiscoveryClient, discoverLocalAmmVenues, formatFeeTier, parseFeeBasisPointTiers, verifyLocalAmmFactory } from "./swap/evm-venue-discovery";
import { initialWalletSession, parseEip1193ChainId, quoteRequestMatchesWallet, walletSessionReducer } from "./wallet/session";
import { createProviderBindingGrant } from "./wallet/capabilities";
import { useEip6963Wallets } from "./wallet/use-eip6963";
import { EVM_NETWORKS, assertContractsConfigured, evmNetworkByChainId, networkContractsMessage, resolveEvmNetwork, type EvmNetworkId } from "./release/evm-networks";
import {
  friendlyError,
  minimumReceived,
  normalizeAddress,
  parsePositiveAmount,
  shortAddress,
  type TokenInfo,
  type TxStage
} from "./lib";

type View = "swap" | "bridge" | "universe" | "liquidity" | "setup";

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("localswap-config") || "{}");
  } catch {
    return {};
  }
})();

/** Contract addresses the user entered, remembered per chain id so switching networks never carries one chain's addresses to another. */
const NETWORK_STORE = "localswap-networks";
type NetworkContracts = { factoryAddress?: string; additionalFactories?: string; routerAddress?: string };
function readNetworkStore(): Record<string, NetworkContracts> {
  try { return JSON.parse(localStorage.getItem(NETWORK_STORE) || "{}"); } catch { return {}; }
}

const EMPTY_TOKEN: TokenInfo = { address: "", symbol: "TOKEN", name: "", decimals: 18, balance: 0n };
/** A reviewed asset's symbol when it is one, otherwise the identifier itself. */
function assetLabel (assetType: string): string {
  return BUILT_IN_ASSETS.find((asset) => asset.assetType === assetType)?.symbol ?? assetType;
}

type VenueDiscoveryState = { key: string; loading: boolean; factories: number; routes: RouteDescriptor[]; feeByRouteId: Map<string, number>; paths: Map<string, EvmMultiHopPath>; rejected: Array<{ venueId: string; code: string; detail?: string }> };

function App() {
  const evmWallets = useEip6963Wallets();
  const [view, setView] = useState<View>("swap");
  const [rpcUrl, setRpcUrl] = useState(saved.rpcUrl || "http://127.0.0.1:8545");
  const [chainId, setChainId] = useState(saved.chainId || "31337");
  const [factoryAddress, setFactoryAddress] = useState(saved.factoryAddress || "");
  const [additionalFactories, setAdditionalFactories] = useState(saved.additionalFactories || "");
  // Which fee tiers to look for. A pair can trade at several at once, each at its
  // own address, and the best price is not always the cheapest tier: a thin 1 bp
  // pool loses to a deep 30 bp one. Both are quoted and compared, not assumed.
  const [feeTiers, setFeeTiers] = useState(saved.feeTiers || "1");
  const [routerAddress, setRouterAddress] = useState(saved.routerAddress || "");
  const [intermediateTokens, setIntermediateTokens] = useState(saved.intermediateTokens || "");
  const [poolAddress, setPoolAddress] = useState(saved.poolAddress || "");
  const [verifiedPoolAddress, setVerifiedPoolAddress] = useState("");
  // The verified pool's own rate. The liquidity screen used to state the pool was
  // zero-fee, which stopped being true the moment the fee became a constructor
  // argument — and a provider reading it would have concluded the opposite of the
  // truth about whether providing pays. It is read, never assumed.
  const [poolFeeBasisPoints, setPoolFeeBasisPoints] = useState<number | null>(null);
  const [tokenAAddress, setTokenAAddress] = useState(saved.tokenAAddress || "");
  const [tokenBAddress, setTokenBAddress] = useState(saved.tokenBAddress || "");
  const [token0, setToken0] = useState<TokenInfo>(EMPTY_TOKEN);
  const [token1, setToken1] = useState<TokenInfo>(EMPTY_TOKEN);
  const [reserve0, setReserve0] = useState(0n);
  const [reserve1, setReserve1] = useState(0n);
  const [poolTotalSupply, setPoolTotalSupply] = useState(0n);
  const [lpBalance, setLpBalance] = useState(0n);
  const [walletSession, dispatchWalletSession] = useReducer(walletSessionReducer, false, initialWalletSession);
  const [inputIsToken0, setInputIsToken0] = useState(true);
  const [amountIn, setAmountIn] = useState("");
  const [swapExecutionIntentId, setSwapExecutionIntentId] = useState(createRouteExecutionIntentId);
  const [swapQuote, setSwapQuote] = useState<RouteQuote>();
  const [swapRequest, setSwapRequest] = useState<RouteQuoteRequest>();
  const [swapRoute, setSwapRoute] = useState<RouteDescriptor>();
  const [venueDiscovery, setVenueDiscovery] = useState<VenueDiscoveryState>({ key: "", loading: false, factories: 0, routes: [], feeByRouteId: new Map(), paths: new Map(), rejected: [] });
  const [quoteRejectedCount, setQuoteRejectedCount] = useState(0);
  // Every bound quote, best first, so the screen can show what the choice was
  // between. Keeping only the winner leaves "best selected" unfalsifiable.
  const [comparedQuotes, setComparedQuotes] = useState<RouteQuote[]>([]);
  // Empty means the destination is on this chain, which is every route the
  // pools themselves can carry. Naming an asset elsewhere is the only way to ask
  // a question a single pool cannot answer.
  const [planDestination, setPlanDestination] = useState("");
  const [slippage, setSlippage] = useState("0.50");
  const [liquidity0, setLiquidity0] = useState("");
  const [liquidity1, setLiquidity1] = useState("");
  const [liquidityMode, setLiquidityMode] = useState<"add" | "remove">("add");
  // Which fee tiers exist for this pair, and which one the deposit goes to. A
  // provider choosing where to put liquidity is the mechanism by which the rate
  // "changes" without anyone being able to change it, so the choice has to be on
  // screen. Shares are pool-specific, so the withdrawal side has to name a pool
  // too: burning against the verified pool while showing another pool's balance
  // reads correctly and is wrong.
  const [providerTiers, setProviderTiers] = useState<PoolTierReading[]>([]);
  const [providerTierError, setProviderTierError] = useState("");
  const [depositPool, setDepositPool] = useState("");
  const [withdrawPool, setWithdrawPool] = useState("");
  const [lpAmount, setLpAmount] = useState("");
  const [stage, setStage] = useState<TxStage>("idle");
  const [txHash, setTxHash] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const initialRecovery = useMemo(loadSwapRecoverySnapshot, []);
  const [swapRecovery, setSwapRecovery] = useState<EvmSwapRecoveryRecord | undefined>(initialRecovery.record);
  const [swapRecoveryError, setSwapRecoveryError] = useState(initialRecovery.error);
  const [swapRecoveryBusy, setSwapRecoveryBusy] = useState(false);
  const swapRecoveryRef = useRef<EvmSwapRecoveryRecord | undefined>(initialRecovery.record);
  const swapRecoveryAttempt = useRef(0);
  const initialLoad = useRef(false);
  const previousWalletRevision = useRef(walletSession.revision);
  const previousEvmProviderId = useRef<string | null>(null);

  const expectedChainId = useMemo(() => {
    try { return BigInt(chainId); } catch { return -1n; }
  }, [chainId]);
  const selectedEvmProvider = evmWallets.selected?.provider;
  const selectedEvmProviderId = evmWallets.selectedId;
  const selectedWalletCapabilityId = "eip1193";
  const walletCanConnect = Boolean(selectedEvmProvider);
  const account = walletSession.status === "connected" ? walletSession.account : "";
  const walletChainId = walletSession.status === "connected" ? walletSession.chainId : null;
  const wrongNetwork = walletChainId !== null && walletChainId !== expectedChainId;
  const connected = walletSession.status === "connected";
  const busy = ["approving", "awaiting-wallet", "submitted"].includes(stage);
  const inputToken = inputIsToken0 ? token0 : token1;
  const outputToken = inputIsToken0 ? token1 : token0;
  const outputDecimals = outputToken.decimals;
  const quote = swapQuote?.expectedOutBaseUnits ?? 0n;

  const provider = useMemo(() => {
    try { return new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true }); }
    catch { return null; }
  }, [rpcUrl, chainId]);

  useEffect(() => {
    swapRecoveryAttempt.current += 1;
    setSwapRecoveryBusy(false);
  }, [provider]);

  // The fee tiers were in the key's value but missing from its dependency list,
  // so a change of tiers produced the same key for a different configuration.
  const venueConfigKey = useMemo(() => buildVenueConfigKey({
    chainId: expectedChainId,
    factoryAddress,
    additionalFactories,
    feeTiers,
    routerAddress,
    intermediateTokens,
    tokenIn: inputToken.address,
    tokenOut: outputToken.address
  }), [additionalFactories, expectedChainId, factoryAddress, feeTiers, inputToken.address, intermediateTokens, outputToken.address, routerAddress]);

  const swapAdapter = useMemo<UniversalRouteAdapter | undefined>(() => {
    if (!provider || !selectedEvmProvider) return undefined;
    return createEvmLocalAmmAdapter(createBrowserEvmLocalAmmClient(provider, selectedEvmProvider));
  }, [provider, selectedEvmProvider]);

  const multiHopAdapter = useMemo<UniversalRouteAdapter | undefined>(() => {
    if (!provider || !selectedEvmProvider) return undefined;
    return createEvmMultiHopAdapter(createBrowserEvmMultiHopClient(provider, selectedEvmProvider), venueDiscovery.paths);
  }, [provider, selectedEvmProvider, venueDiscovery.paths]);
  const swapAdapters = useMemo(() => [swapAdapter, multiHopAdapter].filter((adapter): adapter is UniversalRouteAdapter => Boolean(adapter)), [multiHopAdapter, swapAdapter]);

  useEffect(() => {
    let cancelled = false;
    setVenueDiscovery({ key: venueConfigKey, loading: true, factories: 0, routes: [], feeByRouteId: new Map(), paths: new Map(), rejected: [] });
    // The compared quotes have to go with them. They are rendered through the
    // tier map this effect just emptied, so leaving them behind relabels every
    // row as "multi-hop" and keeps one marked selected while nothing is.
    setSwapRoute(undefined); setSwapQuote(undefined); setSwapRequest(undefined); setComparedQuotes([]); setQuoteRejectedCount(0);
    setSwapExecutionIntentId(createRouteExecutionIntentId());
    const run = async () => {
      if (!provider || expectedChainId <= 0n || !isAddress(inputToken.address) || !isAddress(outputToken.address)) {
        if (!cancelled) setVenueDiscovery({ key: venueConfigKey, loading: false, factories: 0, routes: [], feeByRouteId: new Map(), paths: new Map(), rejected: [] });
        return;
      }
      try {
        const venues = configuredLocalAmmVenues(expectedChainId, factoryAddress, additionalFactories, feeTiers);
        // One cache for this run. Direct and multi-hop discovery share it, so the
        // same factory is fetched once instead of once per token pair.
        const discoveryClient = createCachingEvmVenueDiscoveryClient(createBrowserEvmVenueDiscoveryClient(provider));
        const direct = await discoverLocalAmmVenues(venues, inputToken.address, outputToken.address, discoveryClient);
        let routes = direct.routes;
        let paths = new Map<string, EvmMultiHopPath>();
        const rejected = direct.rejected.filter((item) => item.code !== "EVM_VENUE_POOL_NOT_FOUND");
        if (routerAddress.trim() && intermediateTokens.trim()) {
          try {
            const multiHop = await discoverEvmMultiHopRoutes({ venues, routerAddress, tokenIn: inputToken.address, tokenOut: outputToken.address, intermediateTokens: parseIntermediateTokens(intermediateTokens), client: discoveryClient });
            routes = [...routes, ...multiHop.routes]; paths = multiHop.paths; rejected.push(...multiHop.rejected);
          } catch (reason) {
            rejected.push({ venueId: "multihop-configuration", code: reason instanceof Error ? reason.message : "EVM_MULTIHOP_DISCOVERY_FAILED" });
          }
        }
        if (!cancelled) {
          // venues.length counts (factory, tier) pairs now, so it is not a factory count.
          const factoryCount = new Set(venues.map((venue) => venue.factoryAddress.toLowerCase())).size;
          setVenueDiscovery({ key: venueConfigKey, loading: false, factories: factoryCount, routes, feeByRouteId: direct.feeBasisPointsByRouteId, paths, rejected });
        }
      } catch (reason) {
        if (!cancelled) {
          setVenueDiscovery({ key: venueConfigKey, loading: false, factories: 0, routes: [], feeByRouteId: new Map(), paths: new Map(), rejected: [{ venueId: "configuration", code: reason instanceof Error ? reason.message : "EVM_VENUE_DISCOVERY_FAILED" }] });
        }
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [additionalFactories, expectedChainId, factoryAddress, feeTiers, inputToken.address, intermediateTokens, outputToken.address, provider, routerAddress, venueConfigKey]);

  const readToken = useCallback(async (address: string, owner?: string): Promise<TokenInfo> => {
    if (!provider) throw new Error("RPC URLを確認してください。");
    const normalized = normalizeAddress(address);
    const token = new Contract(normalized, ERC20_ABI, provider);
    const [symbol, name, decimals, balance] = await Promise.all([
      token.symbol(), token.name(), token.decimals(), owner ? token.balanceOf(owner) : 0n
    ]);
    return { address: normalized, symbol, name, decimals: Number(decimals), balance };
  }, [provider]);

  // `keepNotice` is for the refresh that follows a completed operation. Without
  // it the refresh replaces "your deposit is confirmed" with "the factory runtime
  // was verified" — a true sentence about something the participant did not just
  // do, shown next to a Confirmed on-chain badge, right when they are looking for
  // the outcome of their own transaction.
  const selectNetworkPreset = (value: string) => {
    if (value === "custom") return;
    try { localStorage.setItem(NETWORK_STORE, JSON.stringify({ ...readNetworkStore(), [chainId]: { factoryAddress, additionalFactories, routerAddress } })); } catch { /* storage is a convenience only */ }
    const target = value === "local" ? { chainId: "31337", rpc: "http://127.0.0.1:8545" } : (() => { const resolved = resolveEvmNetwork(value as EvmNetworkId); return { chainId: String(resolved.network.chainId), rpc: resolved.rpcUrls[0] }; })();
    const remembered = readNetworkStore()[target.chainId] ?? {};
    setChainId(target.chainId); setRpcUrl(target.rpc);
    setFactoryAddress(remembered.factoryAddress ?? ""); setAdditionalFactories(remembered.additionalFactories ?? ""); setRouterAddress(remembered.routerAddress ?? "");
    setPoolAddress(""); setTokenAAddress(""); setTokenBAddress(""); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); setError("");
  };
  const mainnetWithoutContracts = (() => { const preset = evmNetworkByChainId(chainId); return preset?.environment === "mainnet" && !factoryAddress.trim() ? preset : undefined; })();

  const refreshPool = useCallback(async (options?: { keepNotice?: boolean }) => {
    setLoading(true); setError("");
    if (!options?.keepNotice) setNotice("");
    setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null);
    try {
      try { assertContractsConfigured(chainId, factoryAddress); }
      catch { throw new Error(`NETWORK_CONTRACTS_NOT_CONFIGURED: ${networkContractsMessage(evmNetworkByChainId(chainId)!)}`); }
      if (!provider) throw new Error("RPC URLを確認してください。");
      const network = await provider.getNetwork();
      if (network.chainId !== expectedChainId) throw new Error(`RPCはchain ${network.chainId}を返しました。`);
      let resolvedPool = poolAddress.trim();
      if (!resolvedPool) {
        if (!factoryAddress || !tokenAAddress || !tokenBAddress) throw new Error("Pool、またはFactoryと2つのTokenを指定してください。");
        const factory = new Contract(normalizeAddress(factoryAddress), FACTORY_ABI, provider);
        resolvedPool = await factory.getPool(normalizeAddress(tokenAAddress), normalizeAddress(tokenBAddress), parseFeeBasisPointTiers(feeTiers)[0]);
        if (resolvedPool === ZeroAddress) throw new Error("このトークンペアのPoolはまだありません。");
        setPoolAddress(resolvedPool);
      }
      const normalizedPool = normalizeAddress(resolvedPool);
      const pool = new Contract(normalizedPool, POOL_ABI, provider);
      const [address0, address1, reserves, totalSupply, shares, feeBasisPoints] = await Promise.all([
        pool.token0(), pool.token1(), pool.getReserves(), pool.totalSupply(), account ? pool.balanceOf(account) : 0n, pool.feeBasisPoints()
      ]);
      const [info0, info1] = await Promise.all([readToken(address0, account), readToken(address1, account)]);
      const venues = configuredLocalAmmVenues(expectedChainId, factoryAddress, additionalFactories, feeTiers);
      if (!venues.length) throw new Error("EVM_VENUE_FACTORY_REQUIRED");
      const discovery = await discoverLocalAmmVenues(venues, info0.address, info1.address, createBrowserEvmVenueDiscoveryClient(provider));
      if (!discovery.routes.some((route) => route.sourceExecutionTarget.toLowerCase() === normalizedPool.toLowerCase())) throw new Error(discovery.rejected[0]?.code ?? "EVM_VENUE_POOL_NOT_VERIFIED");
      setPoolFeeBasisPoints(Number(feeBasisPoints));
      setToken0(info0); setToken1(info1); setReserve0(reserves[0]); setReserve1(reserves[1]);
      setPoolTotalSupply(totalSupply); setLpBalance(shares);
      setTokenAAddress(info0.address); setTokenBAddress(info1.address);
      setVerifiedPoolAddress(normalizedPool);
      try { localStorage.setItem(NETWORK_STORE, JSON.stringify({ ...readNetworkStore(), [chainId]: { factoryAddress, additionalFactories, routerAddress } })); } catch { /* storage is a convenience only */ }
      localStorage.setItem("localswap-config", JSON.stringify({ rpcUrl, chainId, factoryAddress, additionalFactories, feeTiers, routerAddress, intermediateTokens, poolAddress: normalizedPool, tokenAAddress: info0.address, tokenBAddress: info1.address }));
      if (!options?.keepNotice) setNotice(`PoolとFactory runtimeをRPCから検証しました。${discovery.routes.length} venue候補を確認できます。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [account, additionalFactories, chainId, expectedChainId, factoryAddress, feeTiers, intermediateTokens, poolAddress, provider, readToken, routerAddress, rpcUrl, tokenAAddress, tokenBAddress]);

  useEffect(() => {
    let cancelled = false;
    setProviderTiers([]); setProviderTierError(""); setDepositPool(verifiedPoolAddress); setWithdrawPool(verifiedPoolAddress);
    if (!provider || !verifiedPoolAddress || !factoryAddress || !token0.address || !token1.address) return;
    (async () => {
      try {
        // With an account, each reading also carries that account's LP balance in
        // that pool, which is what the withdrawal side has to spend.
        const tiers = await readPoolTiers(normalizeAddress(factoryAddress), token0.address, token1.address, createBrowserPoolTierReader(provider), account || undefined);
        if (cancelled) return;
        setProviderTiers(tiers);
        // Land on the pool the shares are actually in when there is only one.
        setWithdrawPool(defaultWithdrawPool(tiers, verifiedPoolAddress));
      } catch (reason) {
        // Naming the failure beats showing one tier as if it were all of them.
        if (!cancelled) setProviderTierError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [account, factoryAddress, provider, token0.address, token1.address, verifiedPoolAddress]);

  useEffect(() => {
    if (!initialLoad.current && poolAddress) {
      initialLoad.current = true;
      void refreshPool();
    }
  }, [poolAddress, refreshPool]);

  const connectWallet = async () => {
    setError(""); setNotice("");
    try {
      let nextAccount = "";
      let nextChainId = -1n;
      if (!selectedEvmProvider) throw new Error(evmWallets.providers.length > 1 ? "使用するEVMウォレットを選択してください。" : "EVMウォレットが見つかりません。ブラウザ拡張を有効にしてください。");
      const walletProvider = new BrowserProvider(selectedEvmProvider);
      const accounts = await walletProvider.send("eth_requestAccounts", []);
      const network = await walletProvider.getNetwork();
      nextAccount = accounts[0] || "";
      nextChainId = network.chainId;
      dispatchWalletSession({ type: "connectionSucceeded", account: nextAccount, chainId: nextChainId });
      if (nextChainId !== expectedChainId) setError(`ウォレットはchain ${nextChainId}です。設定したchain ${expectedChainId}へ切り替えてください。`);
      else setNotice("ウォレットを接続しました。接続だけでは資産移転権限は付与されません。");
    } catch (reason) { setError(friendlyError(reason)); }
  };

  useEffect(() => {
    if (previousEvmProviderId.current === selectedEvmProviderId) return;
    previousEvmProviderId.current = selectedEvmProviderId;
    dispatchWalletSession({ type: "providerChanged", available: walletCanConnect });
  }, [selectedEvmProviderId, walletCanConnect]);

  useEffect(() => {
    if (!selectedEvmProvider?.on) return;
    const changedAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      dispatchWalletSession({ type: "accountsChanged", accounts: Array.isArray(accounts) ? accounts : [] });
    };
    const changedChain = (...args: unknown[]) => {
      try { dispatchWalletSession({ type: "chainChanged", chainId: parseEip1193ChainId(args[0]) }); }
      catch { dispatchWalletSession({ type: "providerDisconnected" }); setError("ウォレットから不正なchain ID通知を受信したため、接続状態を失効させました。"); }
    };
    const disconnected = () => dispatchWalletSession({ type: "providerDisconnected" });
    selectedEvmProvider.on("accountsChanged", changedAccounts);
    selectedEvmProvider.on("chainChanged", changedChain);
    selectedEvmProvider.on("disconnect", disconnected);
    return () => {
      selectedEvmProvider.removeListener?.("accountsChanged", changedAccounts);
      selectedEvmProvider.removeListener?.("chainChanged", changedChain);
      selectedEvmProvider.removeListener?.("disconnect", disconnected);
    };
  }, [selectedEvmProvider]);

  useEffect(() => {
    if (previousWalletRevision.current === walletSession.revision) return;
    previousWalletRevision.current = walletSession.revision;
    setSwapQuote(undefined); setComparedQuotes([]); setSwapRequest(undefined); setSwapRoute(undefined);
    setSwapExecutionIntentId(createRouteExecutionIntentId());
    if (!busy) { setStage("idle"); setTxHash(""); }
    setNotice(busy ? "ウォレット状態が変わりました。送信済み取引の状態は維持し、新しい操作用Quoteだけを失効させました。" : "ウォレットのaccountまたはnetworkが変わったため、古いQuoteと確認状態を失効させました。");
    if (poolAddress) void refreshPool();
  }, [busy, poolAddress, refreshPool, walletSession.revision]);

  useEffect(() => {
    let cancelled = false;
    const getQuote = async () => {
      setSwapQuote(undefined); setComparedQuotes([]); setSwapRequest(undefined); setSwapRoute(undefined); setQuoteRejectedCount(0);
      if (!swapAdapters.length || walletSession.status !== "connected" || wrongNetwork || !amountIn) return;
      if (venueDiscovery.key !== venueConfigKey || venueDiscovery.loading) return;
      try {
        if (!venueDiscovery.routes.length) throw new Error(venueDiscovery.rejected[0]?.code ?? "EVM_VENUE_NO_VERIFIED_ROUTE");
        const parsed = parsePositiveAmount(amountIn, inputToken.decimals);
        const slippageBps = Math.round(Number(slippage) * 100);
        const routeTemplate = venueDiscovery.routes[0];
        const request: RouteQuoteRequest = {
          executionIntentId: swapExecutionIntentId,
          sourceAsset: routeTemplate.sourceAsset, destinationAsset: routeTemplate.destinationAsset, amountInBaseUnits: parsed,
          accountId: `eip155:${walletSession.chainId}:${walletSession.account}`, recipient: walletSession.account,
          walletCapabilityId: selectedWalletCapabilityId, sessionRevision: walletSession.revision,
          walletGrant: createProviderBindingGrant({ transportId: `eip6963:${evmWallets.selectedId}`, accountId: `eip155:${walletSession.chainId}:${walletSession.account}`, walletCapabilityId: "eip1193", sessionRevision: walletSession.revision, expiresAt: Date.now() + routeTemplate.maximumQuoteTtlMs }),
          slippageBps
        };
        const result = await quoteRoutes(request, venueDiscovery.routes, swapAdapters);
        if (!result.quotes[0]) throw new Error(result.rejected[0]?.code ?? "NO_EXECUTABLE_QUOTE");
        const selectedRoute = venueDiscovery.routes.find((route) => route.id === result.quotes[0].routeId);
        if (!selectedRoute) throw new Error("QUOTE_ROUTE_CHANGED");
        if (!cancelled) { setSwapRequest(request); setSwapQuote(result.quotes[0]); setComparedQuotes(result.quotes); setSwapRoute(selectedRoute); setQuoteRejectedCount(result.rejected.length); setError(""); }
      } catch (reason) {
        if (!cancelled) setError(friendlyError(reason));
      }
    };
    const timer = setTimeout(getQuote, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [amountIn, evmWallets.selectedId, inputToken.decimals, selectedWalletCapabilityId, slippage, swapAdapters, swapExecutionIntentId, venueConfigKey, venueDiscovery, walletSession, wrongNetwork]);

  useEffect(() => {
    if (!swapQuote) return;
    const remaining = swapQuote.expiresAt - Date.now();
    if (remaining <= 0) { setSwapQuote(undefined); setComparedQuotes([]); setSwapRequest(undefined); return; }
    const timer = window.setTimeout(() => {
      setSwapQuote(undefined); setComparedQuotes([]); setSwapRequest(undefined);
      setNotice("Swap Quoteの有効期限が切れました。現在のPool状態から再取得してください。");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [swapQuote]);

  const walletContracts = async () => {
    if (!selectedEvmProvider || !account) throw new Error("ウォレットを接続してください。");
    if (wrongNetwork) throw new Error("接続中のチェーンが設定と一致しません。");
    if (!verifiedPoolAddress || normalizeAddress(poolAddress) !== verifiedPoolAddress) throw new Error("PoolとFactory runtimeを再検証してください。");
    const walletProvider = new BrowserProvider(selectedEvmProvider);
    const signer = await walletProvider.getSigner();
    return { signer, pool: new Contract(normalizeAddress(poolAddress), POOL_ABI, signer) };
  };

  const approveExact = async (token: TokenInfo, amount: bigint, spender: string) => {
    const { signer } = await walletContracts();
    const contract = new Contract(token.address, ERC20_ABI, signer);
    const current: bigint = await contract.allowance(account, spender);
    if (current >= amount) return;
    setStage("approving"); setNotice(`${token.symbol}を今回の数量だけ許可します。ウォレットで内容を確認してください。`);
    const approval = await contract.approve(spender, amount);
    setStage("submitted"); setTxHash(approval.hash); setNotice("承認トランザクションを送信しました。まだ交換は実行されていません。");
    await approval.wait();
  };

  const swap = async () => {
    if (busy) return;
    setError(""); setTxHash("");
    try {
      const amount = parsePositiveAmount(amountIn, inputToken.decimals);
      if (!swapQuote || !swapRequest || !swapRoute || !swapAdapters.length || !quoteRequestMatchesWallet(swapRequest, walletSession)) throw new Error("有効な見積りがありません。ウォレット状態とQuoteを更新してください。");
      const currentSlippageBps = Math.round(Number(slippage) * 100);
      if (swapRequest.amountInBaseUnits !== amount || swapRequest.slippageBps !== currentSlippageBps || swapRequest.recipient.toLowerCase() !== account.toLowerCase()) throw new Error("入力またはウォレット状態が見積り後に変わりました。Quoteを更新してください。");
      setStage("awaiting-wallet"); setNotice("正確な承認額、Pool、最小受取額をウォレットで確認してください。承認と交換は別の操作です。");
      const receipt = await executeRouteQuote(swapRoute, swapRequest, swapQuote, swapAdapters, Date.now(), (progress) => {
        const latest = progress.steps.at(-1);
        persistSwapRecovery(progress, swapRoute, swapRequest, swapQuote);
        setStage("submitted"); setTxHash(latest?.txHash ?? "");
        setNotice(latest?.name.includes("approval") ? "承認トランザクションを送信しました。交換はまだ実行されていません。" : "交換を送信しました。チェーンでの確定を待っています。");
      });
      persistSwapRecovery(receipt, swapRoute, swapRequest, swapQuote);
      const latest = receipt.steps.at(-1);
      setTxHash(latest?.txHash ?? "");
      if (receipt.state === "confirmed") {
        setStage("confirmed"); setNotice("ウォレットRPCが交換のblock inclusionを報告しました。保存済み復旧記録から確認数を再照会できます。"); setAmountIn(""); setSwapQuote(undefined); setComparedQuotes([]); setSwapRequest(undefined); setSwapExecutionIntentId(createRouteExecutionIntentId());
        await refreshPool({ keepNotice: true });
      } else if (receipt.state === "failed") {
        setStage("failed"); setError(latest?.errorMessage ? friendlyError(new Error(latest.errorMessage)) : "交換は送信されなかったか、チェーン上で失敗しました。新しいQuoteを取得してください。");
      } else {
        setStage("submitted"); setNotice("取引状態が未確定です。同じQuoteを再送せず、トランザクションハッシュを確認してください。");
      }
    } catch (reason) { setStage("failed"); setError(friendlyError(reason)); }
  };

  const persistSwapRecovery = (receipt: Parameters<typeof recordEvmSwapReceipt>[3], route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote) => {
    try {
      const previous = swapRecoveryRef.current?.routeId === route.id && swapRecoveryRef.current.quoteId === quote.quoteId ? swapRecoveryRef.current : undefined;
      const next = recordEvmSwapReceipt(route, request, quote, receipt, {
        sourceSymbol: inputToken.symbol, sourceDecimals: inputToken.decimals,
        destinationSymbol: outputToken.symbol, destinationDecimals: outputToken.decimals
      }, previous);
      if (!next) return;
      writeEvmSwapRecoveryRecord(next);
      swapRecoveryRef.current = next; setSwapRecovery(next); setSwapRecoveryError("");
    } catch (reason) { setSwapRecoveryError(recoveryErrorMessage(reason)); }
  };

  const refreshSwapRecoveryStatus = async () => {
    const current = swapRecoveryRef.current;
    if (!current || !provider || swapRecoveryBusy) return;
    const attempt = ++swapRecoveryAttempt.current;
    setSwapRecoveryBusy(true); setSwapRecoveryError("");
    try {
      const next = await refreshEvmSwapRecovery(current, createJsonRpcEvmSwapRecoveryReader(provider));
      if (swapRecoveryAttempt.current !== attempt) return;
      writeEvmSwapRecoveryRecord(next);
      swapRecoveryRef.current = next; setSwapRecovery(next);
      if (next.stage === "swap-confirmed") void refreshPool({ keepNotice: true });
    } catch (reason) {
      if (swapRecoveryAttempt.current === attempt) setSwapRecoveryError(recoveryErrorMessage(reason));
    } finally { if (swapRecoveryAttempt.current === attempt) setSwapRecoveryBusy(false); }
  };

  const addLiquidity = async () => {
    if (busy) return;
    setError(""); setTxHash("");
    try {
      const amount0 = parsePositiveAmount(liquidity0, token0.decimals);
      const amount1 = parsePositiveAmount(liquidity1, token1.decimals);
      if (!routerAddress.trim()) throw new Error("預け入れはRouter経由で行います。SetupでRouterアドレスを設定してください。");
      // The chosen tier, which is the verified pool unless the provider picked
      // another. Every candidate came from the registry of the factory whose
      // runtime code was checked, and each named that factory as its creator.
      const targetPool = normalizeAddress(depositPool || poolAddress);
      if (targetPool !== normalizeAddress(poolAddress) && !providerTiers.some(tier => normalizeAddress(tier.pool) === targetPool)) {
        throw new Error("選んだ料率のプールが確認済みの一覧にありません。再検証してください。");
      }
      // Ask the router what it will actually pull, then approve exactly that.
      // Approving what was typed is what left an allowance standing: the pool
      // credits only the current ratio, and the difference stayed approved.
      const { signer } = await walletContracts();
      const router = new Contract(normalizeAddress(routerAddress), ROUTER_ABI, signer);
      const [settled0, settled1] = await router.quoteAddLiquidity(targetPool, amount0, amount1);
      // Against the pool being deposited into. The floor the participant is
      // protected by is worthless if it is computed from a different pool's book.
      const expectedShares = estimateLiquidityShares(settled0, settled1, depositTier.reserve0, depositTier.reserve1, depositTier.totalSupply);
      const minShares = minimumReceived(expectedShares, 50);
      // The floors are what the participant refuses at, if the ratio moves between
      // this quote and the mined transaction. The router rejects a floor of zero.
      const min0 = minimumReceived(settled0, 50);
      const min1 = minimumReceived(settled1, 50);
      if (min0 <= 0n || min1 <= 0n || minShares <= 0n) throw new Error("預け入れの数量が小さすぎます。");
      await approveExact(token0, settled0, normalizeAddress(routerAddress));
      await approveExact(token1, settled1, normalizeAddress(routerAddress));
      setStage("awaiting-wallet"); setNotice("預ける2資産とRouterアドレスをウォレットで確認してください。Routerが比率を確定し、その分だけ引きます。");
      const tx = await router.addLiquidity(targetPool, settled0, settled1, min0, min1, minShares, account, Math.floor(Date.now() / 1000) + 600);
      setStage("submitted"); setTxHash(tx.hash); setNotice("流動性追加を送信しました。確定を待っています。");
      await tx.wait();
      setStage("confirmed"); setNotice("流動性追加が確認されました。"); setLiquidity0(""); setLiquidity1("");
      await refreshPool({ keepNotice: true });
    } catch (reason) { setStage("failed"); setError(friendlyError(reason)); }
  };

  const removeLiquidity = async () => {
    if (busy) return;
    setError(""); setTxHash("");
    try {
      const shares = parsePositiveAmount(lpAmount, 18);
      // Burn against the pool the shares are in. Every candidate came from the
      // registry of the factory whose runtime code was verified, and each named
      // that factory as its creator.
      const target = normalizeAddress(withdrawTier.pool);
      if (target !== normalizeAddress(poolAddress) && !providerTiers.some((tier) => normalizeAddress(tier.pool) === target)) {
        throw new Error("選んだ料率のプールが確認済みの一覧にありません。再検証してください。");
      }
      if (shares > (withdrawTier.lpBalance ?? 0n)) throw new Error("LP残高が不足しています。");
      if (!withdrawTier.totalSupply) throw new Error("Poolの供給量を取得できません。");
      const [expected0, expected1] = withdrawalAmounts(shares, withdrawTier);
      const { signer } = await walletContracts();
      const pool = new Contract(target, POOL_ABI, signer);
      setStage("awaiting-wallet"); setNotice("受取最小額とPoolアドレスを確認してください。LP shareは焼却されます。");
      const tx = await pool.removeLiquidity(
        shares,
        minimumReceived(expected0, 50),
        minimumReceived(expected1, 50),
        account,
        Math.floor(Date.now() / 1000) + 600
      );
      setStage("submitted"); setTxHash(tx.hash); setNotice("流動性引出しを送信しました。確定を待っています。");
      await tx.wait();
      setStage("confirmed"); setNotice("流動性引出しが確認されました。"); setLpAmount("");
      await refreshPool({ keepNotice: true });
    } catch (reason) { setStage("failed"); setError(friendlyError(reason)); }
  };

  const createPool = async () => {
    if (busy) return;
    setError(""); setTxHash("");
    try {
      const tokenA = normalizeAddress(tokenAAddress);
      const tokenB = normalizeAddress(tokenBAddress);
      if (!provider) throw new Error("RPC URLを確認してください。");
      const venues = configuredLocalAmmVenues(expectedChainId, factoryAddress, additionalFactories, feeTiers);
      const primaryVenue = venues.find((venue) => venue.factoryAddress.toLowerCase() === normalizeAddress(factoryAddress).toLowerCase() && venue.feeBasisPoints === parseFeeBasisPointTiers(feeTiers)[0]);
      if (!primaryVenue) throw new Error("EVM_VENUE_FACTORY_REQUIRED");
      await verifyLocalAmmFactory(primaryVenue, createBrowserEvmVenueDiscoveryClient(provider));
      const { signer } = await walletContractsFor(factoryAddress);
      const factory = new Contract(normalizeAddress(factoryAddress), FACTORY_ABI, signer);
      const createdTier = parseFeeBasisPointTiers(feeTiers)[0];
      setStage("awaiting-wallet"); setNotice(`手数料 ${formatFeeTier(createdTier)} の新しいimmutable Poolを作成します。手数料は作成時に焼き込まれ、後から誰にも変更できません。別の料率が要る場合は別のPoolになります。`);
      const tx = await factory.createPool(tokenA, tokenB, createdTier);
      setStage("submitted"); setTxHash(tx.hash); setNotice("Pool作成を送信しました。確定を待っています。");
      await tx.wait();
      const created = await factory.getPool(tokenA, tokenB, createdTier);
      setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); setPoolAddress(created); setStage("confirmed"); setNotice(`Pool ${shortAddress(created)} を作成しました。SetupでFactory runtimeとPoolを検証してください。`);
    } catch (reason) { setStage("failed"); setError(friendlyError(reason)); }
  };

  const walletContractsFor = async (_target: string) => {
    if (!selectedEvmProvider || !account) throw new Error("ウォレットを接続してください。");
    if (wrongNetwork) throw new Error("接続中のチェーンが設定と一致しません。");
    const walletProvider = new BrowserProvider(selectedEvmProvider);
    return { signer: await walletProvider.getSigner() };
  };

  // Comparison lives in fee-tier-comparison.ts so it can be tested without a DOM.
  const planDestinations = useMemo(
    () => BUILT_IN_ASSETS.filter((asset) => !asset.assetType.startsWith(`eip155:${expectedChainId}/`) && asset.assetType.includes(":")),
    [expectedChainId]
  );

  const routePlanning = useMemo((): { plans: RoutePlan[]; gaps: RoutePlanGap[]; code: string } => {
    if (!planDestination) return { plans: [], gaps: [], code: "" };
    if (venueDiscovery.loading || !isAddress(inputToken.address) || expectedChainId <= 0n) return { plans: [], gaps: [], code: "" };
    try {
      const amountInBaseUnits = amountIn ? parsePositiveAmount(amountIn, inputToken.decimals) : 1n;
      const sourceAsset = `eip155:${expectedChainId}/erc20:${normalizeAddress(inputToken.address)}`;
      const intent = { sourceAsset, destinationAsset: planDestination, amountInBaseUnits };
      const routes = [...venueDiscovery.routes, ...ROUTE_DESCRIPTORS];
      const plans = findRoutePlans(intent, routes);
      // A dead end is worth more as a direction. What one route would open it?
      return { plans, gaps: plans.length ? [] : findRoutePlanGaps(intent, routes), code: plans.length ? "" : "NO_VERIFIED_SEQUENCE_JOINS_THESE_ASSETS" };
    } catch (reason) {
      return { plans: [], gaps: [], code: reason instanceof Error ? reason.message : "ROUTE_PLAN_FAILED" };
    }
  }, [amountIn, expectedChainId, inputToken.address, inputToken.decimals, planDestination, venueDiscovery.loading, venueDiscovery.routes]);

  const routePlanWalks = useMemo((): Array<{ planId: string; state: RoutePlanState }> => {
    if (!routePlanning.plans.length) return [];
    const storage = (() => { try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; } })();
    if (!storage) return [];
    return routePlanning.plans.flatMap((plan) => {
      const record = readRoutePlanProgress(storage, plan.planId);
      // A record for another plan is not this plan's, whatever it says inside.
      if (!record) return [];
      const state = routePlanStateFromRecord(plan, record);
      return state.kind === "ready" && state.legIndex === 0 ? [] : [{ planId: plan.planId, state }];
    });
  }, [routePlanning.plans]);

  const feeTierComparison = useMemo(() => compareFeeTiers(comparedQuotes, venueDiscovery.feeByRouteId, outputDecimals), [comparedQuotes, outputDecimals, venueDiscovery.feeByRouteId]);

  // Which tier the executed route trades. Not the same as the pool the Setup tab
  // verified: the swap runs on whichever tier quoted best, and it can be either.
  const selectedFeeTier = swapRoute ? venueDiscovery.feeByRouteId.get(swapRoute.id) ?? null : null;

  // The pool takes only what its current ratio credits, but the screen approves
  // what was typed. Off ratio, the difference stays approved on the pool after the
  // deposit — measured at 300 JADE for a 100 / 500 deposit into a 1 : 2 pool — and
  // the panel used to state the approval scope was exact, which is the opposite.
  //
  // This is a display of the residue, not a fix: reserves move between this read
  // and the mined transaction, so the real residue can differ. Settling the ratio
  // at execution time needs a router-side addLiquidity — the internal design notes (not published).
  // The pool a deposit is going to, with its own reserves and supply. Everything
  // the review panel says about a deposit — what the pool takes, what is left
  // over, how many shares — is a function of that pool's ratio, so reading the
  // verified pool's figures while depositing into another tier describes the
  // wrong pool in the one place the participant is asked to accept a number.
  const depositTier = useMemo<PoolTierReading>(() => {
    const wanted = (depositPool || verifiedPoolAddress).toLowerCase();
    return providerTiers.find((tier) => tier.pool.toLowerCase() === wanted)
      ?? { pool: verifiedPoolAddress, feeBasisPoints: poolFeeBasisPoints ?? 0, reserve0, reserve1, totalSupply: poolTotalSupply };
  }, [depositPool, poolFeeBasisPoints, poolTotalSupply, providerTiers, reserve0, reserve1, verifiedPoolAddress]);

  const depositResidue = useMemo(() => {
    if (liquidityMode !== "add") return null;
    try {
      return computeDepositResidue(parsePositiveAmount(liquidity0, token0.decimals), parsePositiveAmount(liquidity1, token1.decimals), depositTier.reserve0, depositTier.reserve1);
    } catch { return null; }
  }, [depositTier, liquidity0, liquidity1, liquidityMode, token0.decimals, token1.decimals]);

  const providerTierRows = useMemo(() => {
    if (liquidityMode !== "add" || providerTiers.length === 0) return [];
    let amount0 = 0n; let amount1 = 0n;
    try {
      amount0 = parsePositiveAmount(liquidity0, token0.decimals);
      amount1 = parsePositiveAmount(liquidity1, token1.decimals);
    } catch { /* nothing entered yet; the rows still show depth */ }
    return describeProviderTiers(providerTiers, amount0, amount1, depositPool || verifiedPoolAddress, token0.decimals, token1.decimals);
  }, [depositPool, liquidity0, liquidity1, liquidityMode, providerTiers, token0.decimals, token1.decimals, verifiedPoolAddress]);

  const updateSwapAmount = (value: string) => { setAmountIn(value); setSwapExecutionIntentId(createRouteExecutionIntentId()); setSwapQuote(undefined); setComparedQuotes([]); setSwapRequest(undefined); setSwapRoute(undefined); };
  const updateSwapSlippage = (value: string) => { setSlippage(value); setSwapExecutionIntentId(createRouteExecutionIntentId()); setSwapQuote(undefined); setComparedQuotes([]); setSwapRequest(undefined); setSwapRoute(undefined); };
  const switchDirection = () => { setInputIsToken0((value) => !value); setAmountIn(""); setSwapExecutionIntentId(createRouteExecutionIntentId()); setSwapQuote(undefined); setComparedQuotes([]); setSwapRequest(undefined); setSwapRoute(undefined); };
  const copy = async (value: string) => { await navigator.clipboard.writeText(value); setNotice("アドレスをコピーしました。"); };
  const formattedQuote = quote ? formatUnits(quote, outputDecimals) : "0";
  const slippageBps = Number.isFinite(Number(slippage)) ? Math.round(Number(slippage) * 100) : 0;
  const minOut = swapQuote?.minimumOutBaseUnits ?? 0n;
  const priceImpact = swapQuote?.priceImpactBps === undefined ? "—" : (swapQuote.priceImpactBps / 100).toFixed(2);
  const selectedHopCount = swapRoute ? (venueDiscovery.paths.get(swapRoute.id)?.pools.length ?? 1) : 0;
  const swapReady = useMemo(() => {
    try {
      return Boolean(
        swapQuote && swapRequest && swapRoute && swapAdapters.length > 0 && quoteRequestMatchesWallet(swapRequest, walletSession) &&
        swapQuote.expiresAt > Date.now() && swapRequest.amountInBaseUnits === parsePositiveAmount(amountIn, inputToken.decimals) &&
        swapRequest.slippageBps === slippageBps && swapRequest.sourceAsset === swapRoute.sourceAsset && swapRequest.destinationAsset === swapRoute.destinationAsset
      );
    } catch { return false; }
  }, [amountIn, inputToken.decimals, slippageBps, swapAdapters.length, swapQuote, swapRequest, swapRoute, walletSession]);
  const expectedLpShares = useMemo(() => {
    try {
      return estimateLiquidityShares(
        parsePositiveAmount(liquidity0, token0.decimals),
        parsePositiveAmount(liquidity1, token1.decimals),
        depositTier.reserve0,
        depositTier.reserve1,
        depositTier.totalSupply
      );
    } catch { return 0n; }
  }, [depositTier, liquidity0, liquidity1, token0.decimals, token1.decimals]);
  // The pool a withdrawal will actually burn against, with its own reserves,
  // supply and balance. Falls back to the verified pool's figures so that a
  // registry that could not be read leaves this side working exactly as before.
  const withdrawTier = useMemo<PoolTierReading>(() => {
    const wanted = (withdrawPool || verifiedPoolAddress).toLowerCase();
    return providerTiers.find((tier) => tier.pool.toLowerCase() === wanted)
      ?? { pool: verifiedPoolAddress, feeBasisPoints: poolFeeBasisPoints ?? 0, reserve0, reserve1, totalSupply: poolTotalSupply, lpBalance };
  }, [lpBalance, poolFeeBasisPoints, poolTotalSupply, providerTiers, reserve0, reserve1, verifiedPoolAddress, withdrawPool]);

  const withdrawTierRows = useMemo(
    () => liquidityMode === "remove" && providerTiers.length > 1 ? describeWithdrawTiers(providerTiers, withdrawTier.pool, token0.decimals, token1.decimals) : [],
    [liquidityMode, providerTiers, token0.decimals, token1.decimals, withdrawTier.pool]
  );

  // Whose rate the panel is talking about: the pool being withdrawn from, or the
  // verified pool on the deposit side.
  const shownFeeBasisPoints = providerTiers.length === 0
    ? poolFeeBasisPoints
    : (liquidityMode === "remove" ? withdrawTier : depositTier).feeBasisPoints;

  // The journal holds the most recently updated record, whatever chain or pair
  // it belongs to, and the screen shows it beside whatever is configured now.
  // The card calls itself a route-bound record, so when it is about a different
  // pair the screen has to say so: the chain is printed inside the card, but
  // nothing there tells the reader it is not the route in front of them. The
  // card itself is a pinned release source and is left alone.
  const recoveryMatchesConfiguration = useMemo(() => {
    if (!swapRecovery || !token0.address || !token1.address) return true;
    const configured = new Set([token0.address, token1.address].map((address) => `eip155:${expectedChainId}/erc20:${address}`.toLowerCase()));
    return configured.has(swapRecovery.source.assetType.toLowerCase()) && configured.has(swapRecovery.destination.assetType.toLowerCase());
  }, [expectedChainId, swapRecovery, token0.address, token1.address]);

  const removePreview = useMemo(() => {
    try {
      return withdrawalAmounts(parsePositiveAmount(lpAmount, 18), withdrawTier);
    } catch { return [0n, 0n] as const; }
  }, [lpAmount, withdrawTier]);

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header className="topbar">
        <a className="brand" href="#top" aria-label="RealDEX home">
          <span className="brand-mark"><ArrowDownUp size={17} /></span>
          <span>REAL<span>DEX</span></span>
        </a>
        <div className="network-pill" title={`Expected chain ${chainId}`}>
          <span className={wrongNetwork ? "status-dot warning" : "status-dot"} />
          chain {chainId}
        </div>
        <div className="wallet-cluster">
          <button className="wallet-disconnect-button" type="button" disabled={connected} title="Start node wallet/cli.mjs, then approve the connection in its local window" onClick={() => {
            evmWallets.enableLocalProvider(`0x${expectedChainId.toString(16)}`);
            setNotice("PC Walletを選択しました。node wallet/cli.mjs start を起動し、端末の専用リンクで解除してからConnect walletを押してください。内蔵署名は指定テストネット限定です。");
          }}>PC Wallet</button>
          <label className="wallet-provider-select">
            <span className="sr-only">EVM wallet provider</span>
            <select aria-label="EVM wallet provider" value={evmWallets.selectedId ?? ""} onChange={(event) => evmWallets.selectProvider(event.target.value)}>
              {!evmWallets.selectedId && <option value="">{evmWallets.providers.length > 1 ? "Select wallet" : "No injected wallet"}</option>}
              {evmWallets.providers.map((entry) => <option key={entry.info.uuid} value={entry.info.uuid}>{entry.info.name}</option>)}
            </select>
          </label>
          <button className={`wallet-button ${wrongNetwork ? "danger" : ""}`} onClick={connectWallet} disabled={connected || !walletCanConnect} aria-label={connected ? (wrongNetwork ? "Wrong network" : `Connected account ${account}`) : walletCanConnect ? "Connect selected wallet" : "Select or configure an EVM wallet first"}>
            <Wallet size={17} />
            <span>{connected ? (wrongNetwork ? "Wrong network" : shortAddress(account)) : walletCanConnect ? "Connect wallet" : "Select wallet"}</span>
          </button>
          {connected && evmWallets.selected?.info.rdns === "local.realdex.wallet" && <button className="wallet-disconnect-button" type="button" onClick={() => void evmWallets.disconnectLocalProvider()} aria-label="Disconnect local wallet"><Unplug size={17} /></button>}
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="eyebrow"><Radio size={14} /> DIRECT TO CHAIN</div>
          <h1>Exchange without<br /><em>an operator.</em></h1>
          <p>The swap talks directly to your wallet and RPC. The optional bridge discloses its external verifier, relayer, and route fees.</p>
          <div className="trust-row">
            <span><ShieldCheck size={15} /> Exact approvals</span>
            <span><Unplug size={15} /> No app backend</span>
            <span><Github size={15} /> AGPL-3.0-only</span>
          </div>
        </section>

        <section className="workspace" aria-label="DEX workspace">
          <nav className="tabs" aria-label="DEX sections">
            {(["swap", "bridge", "universe", "liquidity", "setup"] as View[]).map((item) => (
              <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
                {item === "swap" ? "Swap" : item === "bridge" ? "Bridge" : item === "universe" ? "Universe" : item === "liquidity" ? "Liquidity" : "Setup"}
              </button>
            ))}
          </nav>

          {view === "swap" && (
            <div className="trade-panel">
              <PanelHeader title="Swap tokens" subtitle="Verified direct + atomic multi-hop routes · best bound quote" onRefresh={() => void refreshPool()} loading={loading} />
              <TokenAmount label="YOU PAY" token={inputToken} value={amountIn} onChange={updateSwapAmount} />
              <button className="direction" onClick={switchDirection} aria-label="Reverse token direction"><ArrowDownUp size={18} /></button>
              <TokenAmount label="YOU RECEIVE (EST.)" token={outputToken} value={formattedQuote} readOnly />

              <div className="quote-card">
                <div><span>Route discovery</span><strong>{venueDiscovery.loading ? "Verifying factory and router bytecode…" : `${venueDiscovery.routes.length} executable route${venueDiscovery.routes.length === 1 ? "" : "s"} · ${venueDiscovery.factories} ${venueDiscovery.factories === 1 ? "factory" : "factories"}${venueDiscovery.rejected.length ? ` · ${venueDiscovery.rejected.length} rejected checks` : ""}`}</strong></div>
                <div><span>Quoted venues</span><strong>{swapQuote ? `${Math.max(venueDiscovery.routes.length - quoteRejectedCount, 1)} comparable · best selected` : "Awaiting a bound quote"}</strong></div>
                {feeTierComparison.length > 1 ? (
                  <div className="fee-tier-comparison">
                    <span>Fee tiers compared</span>
                    <ul>
                      {feeTierComparison.map((entry) => (
                        <li key={entry.routeId} className={entry.selected ? "selected" : undefined}>
                          <strong>{entry.label}</strong>
                          <span>{entry.minimumOut} {outputToken.symbol}</span>
                          <em>{entry.selected ? "selected" : `-${entry.behindBasisPoints} bp`}</em>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div><span>Selected path</span><strong>{selectedHopCount ? `${selectedHopCount} hop${selectedHopCount === 1 ? "" : "s"} · ${selectedHopCount === 1 ? "direct pool" : "atomic router"}` : "Awaiting route"}</strong></div>
                <div><span>Minimum received</span><strong>{formatUnits(minOut, outputDecimals)} {outputToken.symbol}</strong></div>
                <div><span>Price impact</span><strong className={priceImpact !== "—" && Number(priceImpact) > 5 ? "negative" : ""}>{priceImpact === "—" ? "—" : `${priceImpact}%`}</strong></div>
                <div><span>Pool fee (to providers)</span><strong>{!swapRoute ? "Awaiting route" : selectedFeeTier === null ? "Multi-hop · each pool charges its own" : formatFeeTier(selectedFeeTier)}</strong></div>
                <div><span>Protocol fee</span><strong>0.00%</strong></div>
                <label><span>Somewhere else</span><select value={planDestination} onChange={(event) => setPlanDestination(event.target.value)} aria-label="Destination on another chain">
                  <option value="">This chain only</option>
                  {planDestinations.map((asset) => <option key={asset.assetType} value={asset.assetType}>{asset.symbol} · {asset.name}</option>)}
                </select></label>
                {routePlanWalks.map(({ planId, state }) => (
                  <div key={planId} className={state.kind === "holding-intermediate" ? "route-walk holding" : "route-walk"}>
                    {state.kind === "holding-intermediate" ? (
                      <>
                        <strong>A walk stopped part way, and you are holding {assetLabel(state.heldAsset)}.</strong>
                        <span>Leg {state.legIndex + 1} did not go through. This is a position, not a failure — you can finish the walk or stop here and keep what you hold.</span>
                      </>
                    ) : state.kind === "stopped-before-any-value-moved" ? (
                      <>
                        <strong>A walk stopped before anything moved.</strong>
                        <span>You still hold {assetLabel(state.heldAsset)}. Nothing was spent, so this one can simply be started again.</span>
                      </>
                    ) : state.kind === "indeterminate" ? (
                      <>
                        <strong>A walk cannot be read as either done or undone.</strong>
                        <span>Leg {state.legIndex + 1} came back unreadable, and holding {assetLabel(state.heldAsset)} is the last thing known. Nothing further will start against it.</span>
                      </>
                    ) : state.kind === "plan-superseded" ? (
                      <>
                        <strong>A saved walk belongs to a route that is no longer on offer.</strong>
                        <span>It is not this plan's, so it is not being treated as this plan's progress.</span>
                      </>
                    ) : state.kind === "awaiting-settlement" ? (
                      <>
                        <strong>A walk is waiting for leg {state.legIndex + 1} to arrive.</strong>
                        <span>Stage: {state.stage}. Nothing may start against money that is still in flight.</span>
                      </>
                    ) : state.kind === "complete" ? (
                      <>
                        <strong>A walk finished.</strong>
                        <span>Every leg arrived at {assetLabel(state.destinationAsset)}.</span>
                      </>
                    ) : (
                      <>
                        <strong>A walk is part way through.</strong>
                        <span>Next is leg {state.legIndex + 1}; you are holding {assetLabel(state.heldAsset)}.</span>
                      </>
                    )}
                  </div>
                ))}
                {planDestination ? (
                  <div className="route-plans">
                    {routePlanning.plans.length ? routePlanning.plans.map((plan) => (
                      <div key={plan.planId} className="route-plan">
                        <strong>{plan.legs.length} leg{plan.legs.length === 1 ? "" : "s"}: {plan.legs.map((leg) => leg.operation).join(" → ")}</strong>
                        <span>Held in between: {plan.intermediateAssets.length ? plan.intermediateAssets.map(assetLabel).join(", ") : "nothing"}</span>
                        <span>Needs a wallet on: {plan.chainIds.join(", ")}</span>
                        <em>Not priced here. Each leg is quoted when it is reached, and the holder can stop at any asset held in between.</em>
                      </div>
                    )) : (
                      <div className="route-plan">
                        <strong>No verified sequence joins these two assets.</strong>
                        <span>{routePlanning.code || "Enter an amount to plan a route."}</span>
                        {routePlanning.gaps.length ? (
                          <em>One more route would open it: {assetLabel(routePlanning.gaps[0].sourceAsset)} → {assetLabel(routePlanning.gaps[0].destinationAsset)}, giving a {routePlanning.gaps[0].legs}-leg plan.</em>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
                <div><span>Network cost</span><strong>{swapQuote?.unpricedCosts[0] ?? "Wallet estimate required"}</strong></div>
                <div><span>Authorization</span><strong>{swapQuote?.authorization.type === "approval" ? `Exact ${formatUnits(swapQuote.authorization.amountBaseUnits, inputToken.decimals)} ${inputToken.symbol} to ${shortAddress(swapQuote.authorization.spender)}` : swapQuote ? "No new token approval required" : "Checked with quote"}</strong></div>
                <label><span>Slippage limit</span><span className="slippage"><input value={slippage} onChange={(event) => updateSwapSlippage(event.target.value)} inputMode="decimal" min="0" max="5" aria-label="Slippage percent" />%</span></label>
                <div><span>Quote expires</span><strong>{swapQuote ? new Date(swapQuote.expiresAt).toLocaleTimeString() : "Connect wallet and enter amount"}</strong></div>
                <div><span>Execution intent</span><strong title={swapRequest?.executionIntentId}>{swapRequest ? shortExecutionIntent(swapRequest.executionIntentId) : "Created with transaction inputs"}</strong></div>
                <div><span>Execution target</span><strong>{swapRoute ? shortAddress(swapRoute.sourceExecutionTarget) : "Verified venue required"} · swapExactIn</strong></div>
              </div>

              <ActionButton connected={connected} providerAvailable={walletCanConnect} wrongNetwork={wrongNetwork} busy={busy} disabled={!swapReady} onConnect={connectWallet} onAction={swap} label={`Swap ${inputToken.symbol} for ${outputToken.symbol}`} />
              <p className="action-note">Each factory runtime, pool origin, token pair, and optional router runtime is verified before quoting. Multi-hop execution is one transaction: every hop succeeds or every hop rolls back.</p>
              {!swapRecovery && swapRecoveryError && <p className="recovery-unreadable" role="alert">
                保存済みの取引証跡を読み取れませんでした。{swapRecoveryError}送信済みの取引が無いことを確かめるまで、新しい交換を始めないでください。
              </p>}
              {swapRecovery && !recoveryMatchesConfiguration && <p className="recovery-foreign" role="status">
                This saved record is not about the pair configured here. It belongs to {swapRecovery.source.symbol} → {swapRecovery.destination.symbol} on {swapRecovery.chainId}. Nothing below describes the route on this screen.
              </p>}
              {swapRecovery && <EvmSwapRecoveryCard record={swapRecovery} busy={swapRecoveryBusy} error={swapRecoveryError} onRefresh={() => void refreshSwapRecoveryStatus()} />}
            </div>
          )}

          {view === "bridge" && <BridgePanel evmProvider={selectedEvmProvider} evmProviderId={selectedEvmProviderId} evmWalletRevision={walletSession.revision} evmWalletCapabilityId={selectedWalletCapabilityId} />}

          {view === "universe" && <UniversePanel provider={provider} />}

          {view === "liquidity" && (
            <div className="trade-panel">
              <PanelHeader title="Manage liquidity" subtitle="Transferable LS-LP shares · 0.5% protection" onRefresh={() => void refreshPool()} loading={loading} />
              <div className="liquidity-switch" role="group" aria-label="Liquidity action">
                <button className={liquidityMode === "add" ? "active" : ""} onClick={() => setLiquidityMode("add")}>Add</button>
                <button className={liquidityMode === "remove" ? "active" : ""} onClick={() => setLiquidityMode("remove")}>Remove</button>
              </div>
              <div className="risk-callout"><CircleAlert size={18} /><span>{shownFeeBasisPoints === null
                ? "Liquidity can lose value through price movement. Verify the pool to read the fee it charges."
                : `Liquidity can lose value through price movement. This pool charges ${formatFeeTier(shownFeeBasisPoints)} on each swap and it accrues to providers, which does not guarantee the fees outweigh that movement.`}</span></div>
              {liquidityMode === "add" && (providerTierRows.length > 1 || providerTierError) ? (
                <div className="provider-tiers">
                  <span>どの料率のプールへ預けるか</span>
                  {providerTierError ? <p className="provider-tier-error">{providerTierError}</p> : <>
                    <ul>
                      {providerTierRows.map((row) => (
                        <li key={row.pool} className={row.selected ? "selected" : undefined}>
                          <button type="button" onClick={() => setDepositPool(row.pool)} disabled={busy}>
                            <strong>{row.label}</strong>
                            <span>深さ {row.depth}</span>
                            <em>{row.empty ? "空のプール" : `持分 ${row.shareLabel}`}</em>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="provider-tier-note">{PROVIDER_TIER_DISCLAIMER}</p>
                  </>}
                </div>
              ) : null}
              {liquidityMode === "add" ? <>
                <TokenAmount label="TOKEN 0" token={token0} value={liquidity0} onChange={setLiquidity0} />
                <div className="plus">+</div>
                <TokenAmount label="TOKEN 1" token={token1} value={liquidity1} onChange={setLiquidity1} />
              </> : <><div className="token-box">
                <div className="token-label"><span>LP SHARES TO BURN</span><span>Balance {formatUnits(withdrawTier.lpBalance ?? 0n, 18)}</span></div>
                <div className="token-input-row"><input value={lpAmount} onChange={(event) => setLpAmount(event.target.value)} inputMode="decimal" placeholder="0.0" aria-label="LP shares to remove" /><span className="lp-chip">LS-LP</span></div>
              </div>
              {withdrawTierRows.length > 1 ? (
                <div className="provider-tiers">
                  <span>どの料率のプールから引き出すか</span>
                  <ul>
                    {withdrawTierRows.map((row) => (
                      <li key={row.pool} className={row.selected ? "selected" : undefined}>
                        <button type="button" onClick={() => { setWithdrawPool(row.pool); setLpAmount(""); }} disabled={busy}>
                          <strong>{row.label}</strong>
                          <span>持分 {row.lpLabel} LS-LP</span>
                          <em>{row.empty ? "この料率には預けていません" : `全部で ${row.wholeLabel}`}</em>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}</>}
              <div className="quote-card">
                <div><span>Pool</span><AddressValue value={liquidityMode === "remove" ? withdrawTier.pool : (depositTier.pool || poolAddress)} onCopy={copy} /></div>
                <div><span>Current reserves</span><strong>{liquidityMode === "remove"
                  ? `${formatUnits(withdrawTier.reserve0, token0.decimals)} / ${formatUnits(withdrawTier.reserve1, token1.decimals)}`
                  : `${formatUnits(depositTier.reserve0, token0.decimals)} / ${formatUnits(depositTier.reserve1, token1.decimals)}`}</strong></div>
                {liquidityMode === "add" ? <>
                  <div><span>Minimum LP shares</span><strong>{formatUnits(minimumReceived(expectedLpShares, 50), 18)} LS-LP</strong></div>
                  <div><span>Pool will take</span><strong>{depositResidue
                    ? `${formatUnits(depositResidue.taken0, token0.decimals)} ${token0.symbol} + ${formatUnits(depositResidue.taken1, token1.decimals)} ${token1.symbol}`
                    : "Enter both amounts"}</strong></div>
                  <div><span>Approval scope</span><strong>{!depositResidue
                    ? "Router · exactly what the pool will take"
                    : "Router · exactly the amounts above · nothing left approved"}</strong></div>
                  {depositResidue && (depositResidue.left0 > 0n || depositResidue.left1 > 0n) ? (
                    <div><span>Not deposited</span><strong>{`${formatUnits(depositResidue.left0 > 0n ? depositResidue.left0 : depositResidue.left1, depositResidue.left0 > 0n ? token0.decimals : token1.decimals)} ${depositResidue.left0 > 0n ? token0.symbol : token1.symbol} · stays in your wallet, not approved`}</strong></div>
                  ) : null}
                </> : <>
                  <div><span>Estimated return</span><strong>{formatUnits(removePreview[0], token0.decimals)} {token0.symbol} + {formatUnits(removePreview[1], token1.decimals)} {token1.symbol}</strong></div>
                  <div><span>Minimum return</span><strong>99.5% of estimate</strong></div>
                </>}
                <div><span>Deadline</span><strong>10 minutes</strong></div>
              </div>
              <ActionButton connected={connected} providerAvailable={walletCanConnect} wrongNetwork={wrongNetwork} busy={busy} disabled={liquidityMode === "add" ? (!liquidity0 || !liquidity1 || !verifiedPoolAddress) : (!lpAmount || !verifiedPoolAddress)} onConnect={connectWallet} onAction={liquidityMode === "add" ? addLiquidity : removeLiquidity} label={liquidityMode === "add" ? "Approve and add liquidity" : "Burn LP shares and withdraw"} />
            </div>
          )}

          {view === "setup" && (
            <div className="trade-panel settings-panel">
              <PanelHeader title="Local connection" subtitle="Stored only in this browser" onRefresh={() => void refreshPool()} loading={loading} />
              <label className="field"><span>Network</span><select aria-label="Network" value={evmNetworkByChainId(chainId)?.id ?? (chainId === "31337" ? "local" : "custom")} onChange={(event) => selectNetworkPreset(event.target.value)}>
                <option value="local">Local node · 31337</option>
                {Object.values(EVM_NETWORKS).map((network) => <option key={network.id} value={network.id}>{network.name} · {network.chainId.toString()} · {network.environment}</option>)}
                {!evmNetworkByChainId(chainId) && chainId !== "31337" && <option value="custom">Custom · {chainId}</option>}
              </select></label>
              {mainnetWithoutContracts && <div className="risk-callout"><CircleAlert size={18} /><span><strong>NETWORK_CONTRACTS_NOT_CONFIGURED</strong> {networkContractsMessage(mainnetWithoutContracts)}</span></div>}
              <Field label="RPC URL" value={rpcUrl} onChange={(value) => { setRpcUrl(value); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); }} placeholder="http://127.0.0.1:8545" />
              <Field label="Expected chain ID" value={chainId} onChange={(value) => { setChainId(value); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); }} placeholder="31337" />
              <Field label="Primary RealDEX factory (LocalSwapFactory v1)" value={factoryAddress} onChange={(value) => { setFactoryAddress(value); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); }} placeholder="0x…" mono />
              <Field label="Additional RealDEX factories (comma or space separated)" value={additionalFactories} onChange={(value) => { setAdditionalFactories(value); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); }} placeholder="0x…, 0x…" mono />
              <Field label="探索する手数料の料率 (basis points, 1–100)" value={feeTiers} onChange={(value) => { setFeeTiers(value); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); }} placeholder="1, 5, 30" mono />
              <Field label="RealDEX Router (LocalSwapRouter v1 · atomic multi-hop)" value={routerAddress} onChange={(value) => setRouterAddress(value)} placeholder="0x…" mono />
              <Field label="Routing intermediary tokens (up to 4)" value={intermediateTokens} onChange={(value) => setIntermediateTokens(value)} placeholder="0x…, 0x…" mono />
              <div className="wallet-provider-status"><span>Detected EVM wallets</span><strong>{evmWallets.providers.length ? `${evmWallets.providers.length} · ${evmWallets.selected?.info.name ?? "selection required"}` : "None detected"}</strong>{evmWallets.blockedIds.length > 0 && <small>{evmWallets.blockedIds.length} conflicting provider identity blocked</small>}</div>
              <Field label="Pool contract (optional if pair exists)" value={poolAddress} onChange={(value) => { setPoolAddress(value); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); }} placeholder="0x…" mono />
              <div className="field-grid">
                <Field label="Token A" value={tokenAAddress} onChange={(value) => { setTokenAAddress(value); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); }} placeholder="0x…" mono />
                <Field label="Token B" value={tokenBAddress} onChange={(value) => { setTokenBAddress(value); setVerifiedPoolAddress(""); setPoolFeeBasisPoints(null); }} placeholder="0x…" mono />
              </div>
              <button className="secondary-button" onClick={() => void refreshPool()} disabled={loading}>{loading ? "Verifying…" : "Verify and save locally"}<RefreshCw size={16} /></button>
              <div className="setup-divider"><span>OR</span></div>
              <button className="danger-outline" onClick={createPool} disabled={busy || !connected || wrongNetwork || !factoryAddress || !tokenAAddress || !tokenBAddress}>Create immutable pool</button>
              <p className="action-note">RealDEX accepts only the exact bundled LocalSwapFactory and LocalSwapRouter v1 runtime hashes. Multi-hop paths use 2–4 verified pools and reject token cycles, duplicate pools, and partial execution.</p>
            </div>
          )}

          {view !== "bridge" && view !== "universe" && (notice || error || txHash) && (
            <aside className={`receipt ${error ? "error" : stage === "confirmed" ? "success" : ""}`} aria-live="polite">
              <div className="receipt-icon">{error ? <CircleAlert size={19} /> : stage === "confirmed" ? <Check size={19} /> : <RefreshCw size={19} className={busy ? "spin" : ""} />}</div>
              <div><strong>{error ? "Action stopped" : stageLabel(stage)}</strong><p>{error || notice}</p>{txHash && <code>{txHash}</code>}</div>
            </aside>
          )}
        </section>
      </main>

      <footer>
        <span>RealDEX（リアルデックス） v0.1 · AGPL-3.0-only</span>
        <span>Operatorless by construction <ExternalLink size={13} /></span>
      </footer>
    </div>
  );
}

function PanelHeader({ title, subtitle, onRefresh, loading }: { title: string; subtitle: string; onRefresh: () => void; loading: boolean }) {
  return <div className="panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onRefresh} aria-label="Refresh pool"><RefreshCw size={17} className={loading ? "spin" : ""} /></button></div>;
}

function TokenAmount({ label, token, value, onChange, readOnly = false }: { label: string; token: TokenInfo; value: string; onChange?: (value: string) => void; readOnly?: boolean }) {
  return <div className={`token-box ${readOnly ? "readonly" : ""}`}>
    <div className="token-label"><span>{label}</span>{token.address && <span>Balance {formatUnits(token.balance, token.decimals)}</span>}</div>
    <div className="token-input-row">
      <input value={value} onChange={(event) => onChange?.(event.target.value)} readOnly={readOnly} inputMode="decimal" placeholder="0.0" aria-label={`${label} amount`} />
      <button className="token-chip" type="button"><span className="token-orb">{token.symbol.slice(0, 1)}</span>{token.symbol}<ChevronDown size={15} /></button>
    </div>
    {token.address && <div className="token-address">{shortAddress(token.address)}</div>}
  </div>;
}

function Field({ label, value, onChange, placeholder, mono = false }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; mono?: boolean }) {
  return <label className="field"><span>{label}</span><input className={mono ? "mono" : ""} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function AddressValue({ value, onCopy }: { value: string; onCopy: (value: string) => void }) {
  return value ? <button className="address-value" onClick={() => onCopy(value)}>{shortAddress(value)} <Copy size={13} /></button> : <strong>Not configured</strong>;
}

function ActionButton({ connected, providerAvailable, wrongNetwork, busy, disabled, onConnect, onAction, label }: { connected: boolean; providerAvailable: boolean; wrongNetwork: boolean; busy: boolean; disabled: boolean; onConnect: () => void; onAction: () => void; label: string }) {
  if (!connected) return <button className="primary-button" onClick={onConnect} disabled={!providerAvailable}><Wallet size={18} />{providerAvailable ? "Connect selected wallet" : "Select an EVM wallet above"}</button>;
  if (wrongNetwork) return <button className="primary-button blocked" disabled><CircleAlert size={18} />Switch to configured chain</button>;
  return <button className="primary-button" onClick={onAction} disabled={busy || disabled}>{busy ? <><RefreshCw size={18} className="spin" />Transaction in progress</> : label}</button>;
}

function stageLabel(stage: TxStage) {
  return ({ idle: "Ready", approving: "Approval required", "awaiting-wallet": "Check your wallet", submitted: "Submitted, not confirmed", confirmed: "Confirmed on-chain", failed: "Action stopped" } as Record<TxStage, string>)[stage];
}

function shortExecutionIntent(value: string): string { return `intent …${value.slice(-12)}`; }

function loadSwapRecoverySnapshot(): { record?: EvmSwapRecoveryRecord; error: string } {
  try { return { record: readEvmSwapRecoveryJournal()[0], error: "" }; }
  catch (reason) { return { error: recoveryErrorMessage(reason) }; }
}

function recoveryErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/CHAIN_MISMATCH/.test(message)) return "保存記録のchainと設定中RPCのchainが一致しません。正しいread-only RPCへ戻してください。";
  if (/RECEIPT_REGRESSED/.test(message)) return "以前に観測したreceiptを現在のRPCが返しません。RPC差異またはreorgの可能性があるため、状態を維持して再送を止めています。";
  if (/REVISION_NOT_ADVANCED/.test(message)) return "別の画面が新しい復旧revisionを保存しました。再読み込みして最新状態を確認してください。";
  if (/STORAGE_INVALID|RECORD_INVALID|BINDING_INVALID|IDENTITY_CHANGED|TRANSACTION_CHANGED|SEQUENCE_INVALID|STAGE_REGRESSION/.test(message)) return "保存済み取引証跡が現在のrouteまたは検証規則と一致しないため採用しませんでした。";
  return "RPCから安全に状態を確定できませんでした。保存済み証跡を保持し、同じQuoteの再送を止めています。";
}

export default App;
