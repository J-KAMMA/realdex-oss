import { Contract, Interface, JsonRpcProvider, getAddress, type Eip1193Provider } from "ethers";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { assertBoundQuote, assertRouteRequest, routeRequestFingerprint } from "../routing/engine";
import type { RouteDescriptor, RouteQuote, RouteQuoteRequest, RouteExecutionReceipt, UniversalRouteAdapter } from "../routing/types";
import { createBrowserEvmLocalAmmClient, createEvmLocalAmmAdapter } from "../swap/evm-local-amm";
import type { EvmWalletProviderEntry } from "../wallet/eip6963";
import { assertCurrentV01Profile, assertV01Route, verifyV01Eoa, type VerifiedV01Profile } from "../release/v01-profile";
import { estimateV01FeePlan, checkV01FeeStep, v01FeeTransaction, type V01FeePlan, type V01FeeCall } from "./fees";
import { assertV01SendAttempt, type V01SendAttempt } from "./send-attempt";
import { sameEvmEnvelope } from "../swap/evm-transaction-lifecycle";

export function isV01WalletCandidate(entry: EvmWalletProviderEntry | undefined): boolean {
  // Compatibility filter, NOT extension authentication. The user must verify the extension.
  return !!entry && entry.source === "eip6963" && entry.info.rdns === "io.metamask" && typeof entry.provider.on === "function" && typeof entry.provider.removeListener === "function";
}

const READ_METHODS = new Set(["eth_accounts", "eth_chainId", "eth_blockNumber", "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call", "eth_getCode"]);

function assertV01Chain(value: unknown): void {
  // Fixed Base Sepolia quantity (84532). Do not coerce arbitrary RPC objects or
  // accept decimal strings, leading zeroes, whitespace, or an unbounded integer.
  if (typeof value !== "string" || value.length !== 7 || value.slice(0, 2) !== "0x" || value.slice(2).toLowerCase() !== "14a34") throw new Error("WALLET_NETWORK_CHANGED");
}

/** Installed only for a current reviewed profile and explicitly selected provider. */
export function createV01Runtime(options: {
  profile: VerifiedV01Profile; entry: EvmWalletProviderEntry; explicitlySelected: boolean;
  readProvider: JsonRpcProvider; isCurrent: () => boolean;
  persistBeforeWalletRequest: (attempt: V01SendAttempt) => true;
}) {
  const { profile, entry, readProvider } = options;
  const ethereum = entry.provider;
  let account = "";
  let intent: { route: RouteDescriptor; request: RouteQuoteRequest; quote: RouteQuote; issued: Set<string>; attempts: Map<string, V01SendAttempt> } | undefined;
  let sending = false;
  let executing = false;
  const issuedQuotes = new WeakSet<RouteQuote>();
  const consumedQuotes = new WeakSet<RouteQuote>();
  const signatureRequests = new WeakSet<RouteQuote>();
  const feePlans = new WeakMap<RouteQuote, V01FeePlan>();

  const assertCurrent = () => {
    assertCurrentV01Profile(profile);
    if (!options.isCurrent() || !options.explicitlySelected || !isV01WalletCandidate(entry)) throw new Error("V01_WALLET_CONTEXT_CHANGED");
  };
  const live = async () => {
    assertCurrent();
    const [accounts, chain, rpcChain] = await Promise.all([
      ethereum.request({ method: "eth_accounts" }), ethereum.request({ method: "eth_chainId" }), readProvider.send("eth_chainId", [])
    ]);
    assertV01Chain(chain); assertV01Chain(rpcChain);
    if (!account || !Array.isArray(accounts) || typeof accounts[0] !== "string" || getAddress(accounts[0]) !== account) throw new Error("WALLET_ACCOUNT_CHANGED");
    await verifyV01Eoa(profile, account, { isCurrent: options.isCurrent });
    assertCurrent();
    return account;
  };
  const validateRequest = (route: RouteDescriptor, request: RouteQuoteRequest) => {
    assertCurrent(); assertV01Route(profile, route); assertRouteRequest(request);
    if (request.sourceAsset !== route.sourceAsset || request.destinationAsset !== route.destinationAsset || request.walletCapabilityId !== "eip1193" || request.walletGrant.authority !== "local-provider-binding" || request.accountId.toLowerCase() !== `eip155:84532:${account}`.toLowerCase() || getAddress(request.recipient) !== account) throw new Error("V01_REQUEST_OUT_OF_SCOPE");
  };

  const guardedProvider: Eip1193Provider = {
    request: async ({ method, params }) => {
      if (READ_METHODS.has(method)) return ethereum.request({ method, params });
      if (method !== "eth_sendTransaction") throw new Error("V01_WALLET_METHOD_BLOCKED");
      if (!intent || sending) throw new Error("V01_EXPLICIT_EXECUTION_REQUIRED");
      const active = intent;
      // Clone the transaction before awaiting anything; accept only conventional EOA fields.
      if (!Array.isArray(params) || params.length !== 1 || !params[0] || typeof params[0] !== "object") throw new Error("V01_TRANSACTION_INVALID");
      const tx = { ...params[0] } as Record<string, unknown>;
      const allowedKeys = ["from", "to", "data", "value", "chainId", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "type"];
      if (Object.keys(tx).some(key => !allowedKeys.includes(key)) || typeof tx.from !== "string" || getAddress(tx.from) !== account || typeof tx.to !== "string" || typeof tx.data !== "string" || (tx.value !== undefined && BigInt(String(tx.value)) !== 0n) || (tx.chainId !== undefined && BigInt(String(tx.chainId)) !== 84532n) || (tx.type !== undefined && ![0n, 2n].includes(BigInt(String(tx.type))))) throw new Error("V01_TRANSACTION_OUT_OF_SCOPE");
      const token = active.route.sourceAsset.split("/erc20:")[1];
      const pool = profile.profile.pool.address;
      const approvalData = new Interface(ERC20_ABI).encodeFunctionData("approve", [pool, active.request.amountInBaseUnits]);
      const swapData = new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [token, active.request.amountInBaseUnits, active.quote.minimumOutBaseUnits, account, Math.floor(active.quote.expiresAt / 1000)]);
      const role = getAddress(tx.to) === getAddress(token) && tx.data.toLowerCase() === approvalData.toLowerCase() ? "approval" : getAddress(tx.to) === pool && tx.data.toLowerCase() === swapData.toLowerCase() ? "swap" : null;
      if (!role || active.issued.has(role) || active.issued.has("swap") || (role === "approval" && active.quote.authorization.type !== "approval")) throw new Error("V01_TRANSACTION_OUT_OF_SCOPE");
      sending = true;
      try {
        validateRequest(active.route, active.request);
        assertBoundQuote(active.route, active.request, active.quote);
        await live();
        const [balance, gasBalance] = await Promise.all([new Contract(token, ERC20_ABI, readProvider).balanceOf(account), readProvider.getBalance(account)]);
        if (balance < active.request.amountInBaseUnits) throw new Error("V01_TOKEN_BALANCE_INSUFFICIENT");
        if (gasBalance <= 0n) throw new Error("V01_GAS_BALANCE_INSUFFICIENT");
        if (role === "swap" && await new Contract(token, ERC20_ABI, readProvider).allowance(account, pool) < active.request.amountInBaseUnits) throw new Error("V01_ALLOWANCE_CHANGED");
        const fees = feePlans.get(active.quote); if (!fees) throw new Error("V01_FEE_REVIEW_REQUIRED");
        const feeStep = await checkV01FeeStep(readProvider, fees, role);
        // The caller's provisional gas fields are replaced by the displayed, reviewed budget.
        const exact = v01FeeTransaction(feeStep);
        if (exact.from !== account || getAddress(exact.to) !== getAddress(tx.to as string) || exact.data.toLowerCase() !== tx.data.toLowerCase()) throw new Error("V01_TRANSACTION_OUT_OF_SCOPE");
        const block = await readProvider.send("eth_blockNumber", []);
        if (typeof block !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(block) || BigInt(block) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("V01_SEND_ATTEMPT_BLOCK_INVALID");
        // Recheck after RPC IO, immediately before the single non-retried wallet request.
        await live();
        validateRequest(active.route, active.request); assertBoundQuote(active.route, active.request, active.quote);
        if (intent !== active) throw new Error("V01_WALLET_CONTEXT_CHANGED");
        const attempt = freeze({ intentId: active.request.executionIntentId, quoteId: active.quote.quoteId, profileFingerprint: profile.fingerprint, role, observedBeforeBlock: Number(BigInt(block)), transaction: exact });
        assertV01SendAttempt(attempt);
        // Write-ahead evidence is required. A saved request alone never means it was sent.
        if (options.persistBeforeWalletRequest(attempt) !== true) throw new Error("V01_SEND_ATTEMPT_NOT_PERSISTED");
        validateRequest(active.route, active.request); assertBoundQuote(active.route, active.request, active.quote);
        active.attempts.set(role, attempt);
        active.issued.add(role);
        signatureRequests.add(active.quote);
        return await ethereum.request({ method, params: [exact] });
      } finally { sending = false; }
    }
  };
  const base = createEvmLocalAmmAdapter(createBrowserEvmLocalAmmClient(readProvider, guardedProvider));
  const adapter: UniversalRouteAdapter = {
    adapterId: base.adapterId,
    supports: route => { try { assertCurrent(); assertV01Route(profile, route); return true; } catch { return false; } },
    // Route-engine execution must not reopen a connection prompt.
    connectAccount: async route => { assertV01Route(profile, route); return `eip155:84532:${await live()}`; },
    quote: async (route, request) => {
      validateRequest(route, request);
      const before = routeRequestFingerprint(request);
      await live();
      const quote = await base.quote(route, request);
      quote.expiresAt = Math.min(quote.expiresAt, profile.expiresAt);
      (quote.adapterData.value as { deadline: number }).deadline = Math.floor(quote.expiresAt / 1000);
      quote.quoteId += `:v01:${profile.fingerprint}`;
      const token = route.sourceAsset.split("/erc20:")[1]; const pool = profile.profile.pool.address;
      const calls: V01FeeCall[] = [];
      if (quote.authorization.type === "approval") calls.push({ role: "approval", from: account, to: token, data: new Interface(ERC20_ABI).encodeFunctionData("approve", [pool, request.amountInBaseUnits]) });
      calls.push({ role: "swap", from: account, to: pool, data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [token, request.amountInBaseUnits, quote.minimumOutBaseUnits, account, Math.floor(quote.expiresAt / 1000)]) });
      const fees = await estimateV01FeePlan(readProvider, calls, quote.expiresAt, quote.authorization.type === "approval" ? { token, spender: pool, amount: request.amountInBaseUnits } : undefined);
      quote.fees = [{ kind: "network", asset: "eip155:84532/slip44:60", amountBaseUnits: fees.totalBudget, estimated: true }];
      quote.unpricedCosts = ["Final network charges can change while wallet confirmation is pending; the displayed amount is a budget, not a guaranteed final fee."];
      await live(); validateRequest(route, request);
      if (before !== routeRequestFingerprint(request)) throw new Error("QUOTE_REQUEST_CHANGED");
      assertBoundQuote(route, request, quote);
      const sealed = freeze(structuredClone(quote));
      issuedQuotes.add(sealed);
      feePlans.set(sealed, fees);
      return sealed;
    },
    execute: async (route, request, quote, onProgress) => {
      validateRequest(route, request); assertBoundQuote(route, request, quote);
      if (!issuedQuotes.has(quote) || consumedQuotes.has(quote) || executing) throw new Error("V01_QUOTE_NOT_CURRENT");
      consumedQuotes.add(quote); executing = true;
      const snapshot = freeze(structuredClone(request));
      intent = { route: freeze(structuredClone(route)), request: snapshot, quote, issued: new Set(), attempts: new Map() };
      const active = intent;
      const bindRecoveryStart = (receipt: RouteExecutionReceipt): RouteExecutionReceipt => {
        if (receipt.quoteId !== quote.quoteId) throw new Error("V01_RECEIPT_RECOVERY_MISMATCH");
        const result = structuredClone(receipt);
        for (const step of result.steps) {
          if (!step.evmTransaction) continue;
          const attempt = active.attempts.get(step.kind ?? "");
          if (!attempt) throw new Error("V01_RECEIPT_RECOVERY_MISMATCH");
          const tx = attempt.transaction;
          const expected = { from: tx.from, to: tx.to, nonce: Number(BigInt(tx.nonce)), data: tx.data, valueBaseUnits: BigInt(tx.value).toString(), chainId: BigInt(tx.chainId).toString() };
          if (!sameEvmEnvelope(step.evmTransaction, expected) || !Number.isSafeInteger(step.evmTransaction.observedBeforeBlock) || step.evmTransaction.observedBeforeBlock < 0 || step.evmTransaction.observedBeforeBlock > attempt.observedBeforeBlock ||
              (step.evmReceipt && step.evmReceipt.blockNumber <= attempt.observedBeforeBlock)) throw new Error("V01_RECEIPT_RECOVERY_MISMATCH");
          // The generic adapter observes a block before its preflight; the v0.1
          // guard may observe a later block before forwarding the wallet request.
          // Use that persisted write-ahead observation for EVERY new v0.1 receipt.
          // This binds new output only: never edit an existing journal or attempt.
          step.evmTransaction.observedBeforeBlock = attempt.observedBeforeBlock;
        }
        return result;
      };
      let lastProgress: RouteExecutionReceipt | undefined;
      try { await live(); return bindRecoveryStart(await base.execute(active.route, snapshot, quote, receipt => { const bound = bindRecoveryStart(receipt); lastProgress = structuredClone(bound); onProgress?.(bound); })); }
      catch (reason) {
        // Only a locally blocked, never-forwarded swap after a proven confirmed approval.
        // A wallet request that threw or lost its hash must never acquire this proof.
        // Includes failures while preparing the swap before entering the send guard.
        // Every permitted send marks issued BEFORE invoking the raw wallet.
        if (!intent.issued.has("swap") && lastProgress?.steps.some(step => step.kind === "approval" && step.state === "confirmed" && step.evmReceipt?.status === 1)) {
          return { ...lastProgress, state: "failed", failureProof: { type: "no-value-transfer-submitted" }, steps: [...lastProgress.steps, { name: "Swap preflight stopped before wallet request; obtain a new review.", state: "failed" }] };
        }
        throw reason;
      }
      finally { intent = undefined; executing = false; }
    }
  };
  return {
    adapter,
    feePlan: (quote: RouteQuote) => { const plan = feePlans.get(quote); if (!plan) throw new Error("V01_FEE_REVIEW_REQUIRED"); return plan; },
    signatureWasRequested: (quote: RouteQuote) => signatureRequests.has(quote),
    connect: async () => {
      assertCurrent();
      const chain = await ethereum.request({ method: "eth_chainId" });
      assertV01Chain(chain);
      assertCurrent();
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("EVM_ACCOUNT_UNAVAILABLE");
      account = getAddress(accounts[0]);
      await live();
      return account;
    },
    balances: async () => {
      await live();
      const [ambr, jade, gas] = await Promise.all([new Contract(profile.profile.tokens.ambr, ERC20_ABI, readProvider).balanceOf(account), new Contract(profile.profile.tokens.jade, ERC20_ABI, readProvider).balanceOf(account), readProvider.getBalance(account)]);
      assertCurrent(); return { ambr: BigInt(ambr), jade: BigInt(jade), gas };
    }
  };
}

function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
