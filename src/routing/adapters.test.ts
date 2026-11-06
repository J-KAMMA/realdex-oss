import { describe, expect, it, vi } from "vitest";
import type { CctpEstimate } from "../bridge/cctp";
import type { IbcEstimate } from "../bridge/ibc";
import { baseUnitsToDecimal, createCctpQuoteAdapter, createIbcQuoteAdapter, decimalToBaseUnits, resolveEip1193CctpAccount } from "./adapters";
import { executeRouteQuote, quoteRoutes } from "./engine";
import { ROUTE_DESCRIPTORS } from "./registry";
import type { RouteQuoteRequest } from "./types";
import { createProviderBindingGrant } from "../wallet/capabilities";

const cctpRoute = ROUTE_DESCRIPTORS.find((route) => route.id === "cctp-v2-base-sepolia-arbitrum-sepolia-usdc")!;
const ibcRoute = ROUTE_DESCRIPTORS.find((route) => route.id === "ibc-grand-1-osmo-test-5-usdc")!;
const allowCctpTestRoute = () => {};

const cctpRequest: RouteQuoteRequest = {
  executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000002",
  sourceAsset: cctpRoute.sourceAsset, destinationAsset: cctpRoute.destinationAsset, amountInBaseUnits: 10_000_000n,
  accountId: "eip155:84532:0x1111111111111111111111111111111111111111", recipient: "0x2222222222222222222222222222222222222222",
  walletCapabilityId: "eip1193", sessionRevision: 4, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: "eip155:84532:0x1111111111111111111111111111111111111111", walletCapabilityId: "eip1193", sessionRevision: 4, expiresAt: Date.now() + 120_000 }), slippageBps: 50
};

const cctpEstimate = (): CctpEstimate => ({
  amountReceived: "9.98", feeTotal: "0.02", totalDebit: "10", quote: "signed-provider-quote", quoteExpiresAt: Date.now() + 60_000,
  gasFees: [{ name: "source gas", token: "ETH", amount: "0.00001" }]
});

const ibcRequest: RouteQuoteRequest = {
  executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000003",
  sourceAsset: ibcRoute.sourceAsset, destinationAsset: ibcRoute.destinationAsset, amountInBaseUnits: 5_000_000n,
  accountId: "cosmos:grand-1:noble1sender", recipient: "osmo1recipient", walletCapabilityId: "cosmos-injected", sessionRevision: 1, walletGrant: createProviderBindingGrant({ transportId: "test:cosmos", accountId: "cosmos:grand-1:noble1sender", walletCapabilityId: "cosmos-injected", sessionRevision: 1, expiresAt: Date.now() + 120_000 }), slippageBps: 0
};

const ibcEstimate = (): IbcEstimate => ({
  amountReceived: "5", feeAmount: "0.025", feeSymbol: "USDC.n", totalDebit: "5.025", sender: "noble1sender", gasLimit: 120_000,
  timeoutAt: Date.now() + 20 * 60_000, quoteExpiresAt: Date.now() + 60_000, fee: { amount: [{ denom: "uusdc", amount: "25000" }], gas: "120000" }
});

describe("installed universal quote adapters", () => {
  it("resolves the exact selected EIP-1193 provider without consulting another wallet", async () => {
    const selected = { request: vi.fn(async ({ method }: { method: string }) => method === "eth_chainId" ? "0x14a34" : ["0x1111111111111111111111111111111111111111"]) };
    const other = { request: vi.fn(async () => { throw new Error("wrong provider called"); }) };
    expect(await resolveEip1193CctpAccount("base-to-arbitrum", selected, true)).toBe(cctpRequest.accountId);
    expect(selected.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(other.request).not.toHaveBeenCalled();
  });

  it("stops Base-dependent CCTP before quote or wallet access while release approval is closed", async () => {
    const estimator = vi.fn(async () => cctpEstimate());
    const account = vi.fn(async () => cctpRequest.accountId);
    const result = await quoteRoutes(cctpRequest, [cctpRoute], [createCctpQuoteAdapter(estimator, account)]);
    expect(result.quotes).toEqual([]);
    expect(result.rejected[0].code).toBe("CCTP_BASE_SEPOLIA_USDC_RELEASE_APPROVAL_REQUIRED");
    expect(estimator).not.toHaveBeenCalled();
    expect(account).not.toHaveBeenCalled();
  });

  it("normalizes a live CCTP estimate without guessing its managed approval", async () => {
    const adapter = createCctpQuoteAdapter(async () => cctpEstimate(), async () => cctpRequest.accountId, undefined, allowCctpTestRoute);
    const result = await quoteRoutes(cctpRequest, [cctpRoute], [adapter]);
    expect(result.rejected).toEqual([]);
    expect(result.quotes[0].expectedOutBaseUnits).toBe(9_980_000n);
    expect(result.quotes[0].minimumOutBaseUnits).toBe(9_930_100n);
    expect(result.quotes[0].authorization.type).toBe("adapter-managed");
    expect(result.quotes[0].fees).toEqual([
      { kind: "bridge", asset: cctpRoute.sourceAsset, amountBaseUnits: 20_000n, estimated: false },
      { kind: "network", asset: "eip155:84532/slip44:60", amountBaseUnits: 10_000_000_000_000n, estimated: true }
    ]);
  });

  it("invalidates a CCTP quote when the wallet account changes", async () => {
    const adapter = createCctpQuoteAdapter(async () => cctpEstimate(), async () => "eip155:84532:0x9999999999999999999999999999999999999999", undefined, allowCctpTestRoute);
    const result = await quoteRoutes(cctpRequest, [cctpRoute], [adapter]);
    expect(result.quotes).toEqual([]);
    expect(result.rejected[0].code).toBe("WALLET_ACCOUNT_CHANGED");
  });

  it("executes the exact bound CCTP quote once and retains a pending guard", async () => {
    const burnTx = `0x${"a".repeat(64)}`;
    const execute = vi.fn(async () => ({ state: "pending" as const, provider: "Circle test", steps: [{ name: "Burn", state: "submitted", txHash: burnTx }] }));
    const adapter = createCctpQuoteAdapter(async () => cctpEstimate(), async () => cctpRequest.accountId, execute, allowCctpTestRoute);
    const quote = (await quoteRoutes(cctpRequest, [cctpRoute], [adapter])).quotes[0];
    const receipt = await executeRouteQuote(cctpRoute, cctpRequest, quote, [adapter]);
    expect(receipt.state).toBe("pending");
    expect(receipt.finality).toMatchObject({ stage: "source-submitted", cursor: { protocol: "cctp-v2", sourceDomain: 6, destinationDomain: 3, sourceTxCandidates: [burnTx], transferBinding: { expectedAmount: "10000000", expectedBurnToken: `0x${"0".repeat(24)}036cbd53842c5426634e7929541ec2318f3dcf7e`, expectedMintRecipient: `0x${"0".repeat(24)}${"2".repeat(40)}`, expectedMessageSender: `0x${"0".repeat(24)}${"1".repeat(40)}` } } });
    expect(execute).toHaveBeenCalledWith("base-to-arbitrum", "10", cctpRequest.recipient, "signed-provider-quote", expect.any(Function));
    await expect(executeRouteQuote(cctpRoute, cctpRequest, quote, [adapter])).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
  });

  it("keeps a provider-pending CCTP result unknown when no recoverable transaction identity exists", async () => {
    const changedRequest = { ...cctpRequest, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000004", sessionRevision: 14, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: cctpRequest.accountId, walletCapabilityId: "eip1193", sessionRevision: 14, expiresAt: Date.now() + 120_000 }) };
    const execute = vi.fn(async () => ({ state: "pending" as const, provider: "Circle test", steps: [{ name: "Burn", state: "submitted" }] }));
    const adapter = createCctpQuoteAdapter(async () => cctpEstimate(), async () => changedRequest.accountId, execute, allowCctpTestRoute);
    const quote = (await quoteRoutes(changedRequest, [cctpRoute], [adapter])).quotes[0];
    const receipt = await executeRouteQuote(cctpRoute, changedRequest, quote, [adapter]);
    expect(receipt.state).toBe("unknown");
    expect(receipt.finality).toBeUndefined();
  });

  it("keeps provider-reported CCTP success at source-submitted until source log proof exists", async () => {
    const changedRequest = { ...cctpRequest, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000008", sessionRevision: 18, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: cctpRequest.accountId, walletCapabilityId: "eip1193", sessionRevision: 18, expiresAt: Date.now() + 120_000 }) };
    const burnTx = `0x${"e".repeat(64)}`;
    const execute = vi.fn(async () => ({ state: "success" as const, provider: "Circle test", steps: [{ name: "Approve", state: "success", txHash: `0x${"d".repeat(64)}` }, { name: "Burn", state: "success", txHash: burnTx }, { name: "Mint", state: "success", txHash: `0x${"c".repeat(64)}` }] }));
    const adapter = createCctpQuoteAdapter(async () => cctpEstimate(), async () => changedRequest.accountId, execute, allowCctpTestRoute);
    const quote = (await quoteRoutes(changedRequest, [cctpRoute], [adapter])).quotes[0];
    const receipt = await executeRouteQuote(cctpRoute, changedRequest, quote, [adapter]);
    expect(receipt.state).toBe("pending");
    expect(receipt.finality).toMatchObject({ stage: "source-submitted", cursor: { sourceTxCandidates: [burnTx] } });
  });

  it("emits a validated recoverable receipt as soon as a CCTP burn hash is reported", async () => {
    const changedRequest = { ...cctpRequest, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000009", sessionRevision: 19, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: cctpRequest.accountId, walletCapabilityId: "eip1193", sessionRevision: 19, expiresAt: Date.now() + 120_000 }) };
    const burnTx = `0x${"f".repeat(64)}`;
    const execute = vi.fn(async (_direction, _amount, _recipient, _quote, onProgress?: (result: { state: "pending"; provider: string; steps: Array<{ name: string; state: string; txHash: string }> }) => void) => {
      onProgress?.({ state: "pending", provider: "Circle test", steps: [{ name: "Burn", state: "success", txHash: burnTx }] });
      return { state: "success" as const, provider: "Circle test", steps: [{ name: "Burn", state: "success", txHash: burnTx }] };
    });
    const adapter = createCctpQuoteAdapter(async () => cctpEstimate(), async () => changedRequest.accountId, execute, allowCctpTestRoute);
    const quote = (await quoteRoutes(changedRequest, [cctpRoute], [adapter])).quotes[0];
    const progress = vi.fn();
    await executeRouteQuote(cctpRoute, changedRequest, quote, [adapter], Date.now(), progress);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0][0]).toMatchObject({ state: "pending", provider: "Circle test", finality: { stage: "source-submitted", cursor: { sourceTxCandidates: [burnTx] } } });
  });

  it("retains the common guard for a provider-reported CCTP error without a no-submission proof", async () => {
    const changedRequest = { ...cctpRequest, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000006", sessionRevision: 16, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: cctpRequest.accountId, walletCapabilityId: "eip1193", sessionRevision: 16, expiresAt: Date.now() + 120_000 }) };
    const execute = vi.fn(async () => ({ state: "error" as const, provider: "Circle test", steps: [{ name: "Bridge", state: "failed" }] }));
    const adapter = createCctpQuoteAdapter(async () => cctpEstimate(), async () => changedRequest.accountId, execute, allowCctpTestRoute);
    const quote = (await quoteRoutes(changedRequest, [cctpRoute], [adapter])).quotes[0];
    expect((await executeRouteQuote(cctpRoute, changedRequest, quote, [adapter])).state).toBe("failed");
    await expect(executeRouteQuote(cctpRoute, changedRequest, quote, [adapter])).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rechecks the active CCTP account immediately before value movement", async () => {
    let calls = 0;
    const changedRequest = { ...cctpRequest, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000005", sessionRevision: 5, walletGrant: createProviderBindingGrant({ transportId: "test:evm", accountId: cctpRequest.accountId, walletCapabilityId: "eip1193", sessionRevision: 5, expiresAt: Date.now() + 120_000 }) };
    const adapter = createCctpQuoteAdapter(async () => cctpEstimate(), async () => ++calls === 1 ? changedRequest.accountId : "eip155:84532:0x9999999999999999999999999999999999999999", undefined, allowCctpTestRoute);
    const quote = (await quoteRoutes(changedRequest, [cctpRoute], [adapter])).quotes[0];
    await expect(executeRouteQuote(cctpRoute, changedRequest, quote, [adapter])).rejects.toThrow("WALLET_ACCOUNT_CHANGED");
  });

  it("normalizes an IBC simulation and binds the signer returned by Keplr", async () => {
    const adapter = createIbcQuoteAdapter(async () => ibcEstimate());
    const result = await quoteRoutes(ibcRequest, [ibcRoute], [adapter]);
    expect(result.rejected).toEqual([]);
    expect(result.quotes[0].authorization).toEqual({ type: "none" });
    expect(result.quotes[0].fees).toEqual([{ kind: "network", asset: "cosmos:grand-1/denom:uusdc", amountBaseUnits: 25_000n, estimated: true }]);
    expect(result.quotes[0].executionPreview.target).toBe("transfer/channel-22");
  });

  it("binds an IBC source transaction and exact packet identity into a pending finality record", async () => {
    const sourceTxHash = "A".repeat(64);
    const execute = vi.fn(async () => ({
      state: "pending" as const,
      provider: "IBC test",
      steps: [{ name: "IBC transfer", state: "included", txHash: sourceTxHash, explorerUrl: `https://example.invalid/tx/${sourceTxHash}` }],
      tracking: { sourceTxHash, sequence: "17", sourceChannel: "channel-22", destinationChannel: "channel-1442", timeoutAt: Date.now() + 20 * 60_000 }
    }));
    const adapter = createIbcQuoteAdapter(async () => ibcEstimate(), async () => ibcRequest.accountId, execute);
    const quote = (await quoteRoutes(ibcRequest, [ibcRoute], [adapter])).quotes[0];
    const receipt = await executeRouteQuote(ibcRoute, ibcRequest, quote, [adapter]);
    expect(receipt.state).toBe("pending");
    expect(receipt.finality).toMatchObject({
      stage: "source-included",
      cursor: { protocol: "ibc-ics20", sourceTxHash, sequence: "17", sourceChannel: "channel-22", destinationChannel: "channel-1442" },
      evidence: [{ kind: "source-tx", id: sourceTxHash }]
    });
  });

  it("releases the common guard after an explicitly failed Cosmos source transaction", async () => {
    const changedRequest = { ...ibcRequest, executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000007", sessionRevision: 17, walletGrant: createProviderBindingGrant({ transportId: "test:cosmos", accountId: ibcRequest.accountId, walletCapabilityId: "cosmos-injected", sessionRevision: 17, expiresAt: Date.now() + 120_000 }) };
    const sourceTxHash = "B".repeat(64);
    const execute = vi.fn(async () => ({ state: "error" as const, provider: "IBC test", steps: [{ name: "Source transaction", state: "failed", txHash: sourceTxHash }], failureCode: 7 }));
    const adapter = createIbcQuoteAdapter(async () => ibcEstimate(), async () => changedRequest.accountId, execute);
    const quote = (await quoteRoutes(changedRequest, [ibcRoute], [adapter])).quotes[0];
    expect((await executeRouteQuote(ibcRoute, changedRequest, quote, [adapter])).failureProof).toEqual({ type: "cosmos-source-transaction-failed", transactionHash: sourceTxHash, code: 7 });
    expect((await executeRouteQuote(ibcRoute, changedRequest, quote, [adapter])).state).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("converts decimal units exactly and rejects precision loss", () => {
    expect(decimalToBaseUnits("1.000001", 6)).toBe(1_000_001n);
    expect(baseUnitsToDecimal(1_000_001n, 6)).toBe("1.000001");
    expect(() => decimalToBaseUnits("1.0000001", 6)).toThrow("DECIMAL_PRECISION_EXCEEDED");
    expect(() => decimalToBaseUnits("1e-6", 6)).toThrow("DECIMAL_AMOUNT_INVALID");
  });
});
