import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  Interface,
  JsonRpcProvider,
  keccak256,
  parseEther,
  type Eip1193Provider
} from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import codeIdentities from "../swap/local-amm-code-identities.json";
import { POOL_ABI } from "../abi";
import { executeRouteQuote } from "../routing/engine";
import { createProviderBindingGrant } from "../wallet/capabilities";
import {
  createJsonRpcEvmSwapRecoveryReader,
  readEvmSwapRecoveryJournal,
  recordEvmSwapReceipt,
  refreshEvmSwapRecovery,
  writeEvmSwapRecoveryRecord
} from "../swap/evm-swap-recovery";
import { createV01ProfileReaders } from "../release/v01-profile-reader";
import { invalidateV01Profile, verifyV01Profile, v01ProfileFingerprint, type VerifiedV01Profile } from "../release/v01-profile";
import { createV01Runtime } from "./runtime";
import type { V01SendAttempt } from "./send-attempt";
import { createV01RecoveryIntent, assertV01AttemptMatchesRecoveryIntent } from "./recovery-intent";
import { verifyV01Candidate } from "./candidate-reconciliation";
import type { ActiveV01Operation } from "./active-operation";
import { V01_GAS_ORACLE, V01_GAS_ORACLE_ABI } from "./fees";
import type { EvmWalletProviderEntry } from "../wallet/eip6963";
import type { RouteDescriptor, RouteExecutionReceipt, RouteQuote, RouteQuoteRequest } from "../routing/types";

// The environment must be selected before loading Hardhat. This keeps the chain in-process,
// test-only, and deterministic; no localhost server, public RPC, wallet, or secret is used.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.env.HARDHAT_CONFIG = resolve(projectRoot, "hardhat.v01-test.config.cjs");
process.env.HARDHAT_NETWORK = "hardhat";
const hre = createRequire(import.meta.url)("hardhat") as {
  ethers: any;
  network: { name: string; provider: { send(method: string, params: unknown[]): Promise<any> } };
  run: (task: string) => Promise<void>;
};

type RpcPayload = { id: number; method: string; params: unknown[] };
type LocalRawRpc = { send(method: string, params: unknown[]): Promise<any> };

/**
 * Test transport only: Ethers JsonRpcProvider backed by Hardhat's in-process raw provider.
 * It has no HTTP fallback. The two explicitly marked shims below are local test fixtures:
 * Hardhat has no Base fee oracle at the reviewed address, and its estimateGas state override
 * support is not assumed. Neither shim is production fee evidence or a public-network proof.
 */
class LocalHardhatJsonRpcProvider extends JsonRpcProvider {
  readonly oracleObservations: Array<{ method: string; input: bigint; output: bigint }> = [];
  readonly allowanceOverrideObservations: Array<{ token: string; slotCount: number }> = [];
  readonly failedPlainEstimates: Array<{ target: string; error: string }> = [];
  nonceOverride?: string;

  private readonly raw: LocalRawRpc;
  private readonly oracle = new Interface(V01_GAS_ORACLE_ABI);
  private serialized: Promise<void> = Promise.resolve();

  constructor(raw: LocalRawRpc) {
    super("http://hardhat-in-process.invalid", { name: "base-sepolia-local", chainId: 84532 }, { cacheTimeout: -1 });
    this.raw = raw;
  }

  override async _send(payload: any): Promise<any[]> {
    const run = this.serialized.then(() => this.handlePayload(payload));
    this.serialized = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handlePayload(payload: any): Promise<any[]> {
    const requests = Array.isArray(payload) ? payload : [payload];
    const responses: any[] = [];
    // Preserve request order because the allowance state-diff shim is deliberately serialized.
    for (const request of requests as RpcPayload[]) {
      try {
        const result = await this.sendOne(request.method, request.params ?? []);
        responses.push({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        responses.push({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    return responses;
  }

  private async sendOne(method: string, params: unknown[]): Promise<any> {
    if (method === "eth_getTransactionCount" && this.nonceOverride !== undefined) return this.nonceOverride;
    if (method === "eth_call" && isOracleCall(params[0])) {
      // Test-only synthetic fee oracle observation. This is not native Hardhat support and
      // is not a public fee proof; production fee checks remain untouched.
      const parsed = this.oracle.parseTransaction({ data: String((params[0] as { data: string }).data) });
      if (!parsed || (parsed.name !== "getL1FeeUpperBound" && parsed.name !== "getOperatorFee")) throw new Error("test oracle calldata invalid");
      const input = BigInt(parsed.args[0]);
      const output = parsed.name === "getL1FeeUpperBound" ? 100_000n : 25_000n;
      this.oracleObservations.push({ method: parsed.name, input, output });
      return this.oracle.encodeFunctionResult(parsed.name, [output]);
    }

    if (method === "eth_estimateGas" && params.length === 3) {
      return this.estimateWithLocalAllowanceOverride(params);
    }

    try {
      return await this.raw.send(method, params);
    } catch (reason) {
      if (method === "eth_estimateGas") this.failedPlainEstimates.push({
        target: String((params[0] as { to?: unknown })?.to).toLowerCase(),
        error: reason instanceof Error ? reason.message : String(reason)
      });
      throw reason;
    }
  }

  private async estimateWithLocalAllowanceOverride(params: unknown[]): Promise<string> {
    const override = params[2];
    if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("test allowance override invalid");
    const snapshot = await this.raw.send("evm_snapshot", []);
    try {
      const entries = Object.entries(override as Record<string, unknown>);
      let slotCount = 0;
      for (const [token, value] of entries) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("test allowance override shape invalid");
        const stateDiff = (value as { stateDiff?: unknown }).stateDiff;
        if (!stateDiff || typeof stateDiff !== "object" || Array.isArray(stateDiff)) throw new Error("test allowance override stateDiff invalid");
        for (const [slot, word] of Object.entries(stateDiff as Record<string, unknown>)) {
          if (typeof word !== "string") throw new Error("test allowance override word invalid");
          // Serialized snapshot -> storage write -> plain estimate -> revert. No signing or
          // persistent state change is allowed to escape this test transport shim.
          await this.raw.send("hardhat_setStorageAt", [token, slot, word]);
          slotCount += 1;
        }
      }
      this.allowanceOverrideObservations.push({ token: entries[0]?.[0] ?? "", slotCount });
      return await this.raw.send("eth_estimateGas", [params[0], params[1]]);
    } finally {
      if (await this.raw.send("evm_revert", [snapshot]) !== true) throw new Error("test state override rollback failed");
    }
  }
}

type SyntheticWallet = Eip1193Provider & {
  account: string;
  chainId: string;
  sendTransactionCalls: number;
  calls: Array<{ method: string; params: unknown[] }>;
  on: (...args: unknown[]) => void;
  removeListener: (...args: unknown[]) => void;
};

type Fixture = {
  raw: LocalRawRpc;
  readProvider: LocalHardhatJsonRpcProvider;
  wallet: SyntheticWallet;
  owner: any;
  trader: any;
  ambr: any;
  jade: any;
  factory: any;
  router: any;
  pool: any;
  profile: any;
  verified: VerifiedV01Profile;
  runtime: ReturnType<typeof createV01Runtime>;
  context: { current: boolean };
  attempts: V01SendAttempt[];
};

function isOracleCall(value: unknown): value is { to: string; data: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { to?: unknown }).to === "string"
    && (value as { to: string }).to.toLowerCase() === V01_GAS_ORACLE.toLowerCase()
    && typeof (value as { data?: unknown }).data === "string";
}

async function rawRpc(method: string, params: unknown[] = []): Promise<any> {
  return hre.network.provider.send(method, params);
}

function walletRejected(message: string): Error {
  // EIP-1193 user rejection is a structured code, not an inferred message substring.
  return Object.assign(new Error(message), { code: 4001 });
}

function deploymentEvidence(contract: any, receipt: any, runtimeCodeHash: string) {
  return { address: contract.target, deploymentTxHash: receipt.hash, blockNumber: receipt.blockNumber, runtimeCodeHash };
}

function requestFor(route: RouteDescriptor, account: string, intentUuid: string, amount: bigint): RouteQuoteRequest {
  const accountId = `eip155:84532:${account}`;
  return {
    executionIntentId: `realdex-intent:v1:${intentUuid}`,
    sourceAsset: route.sourceAsset,
    destinationAsset: route.destinationAsset,
    amountInBaseUnits: amount,
    accountId,
    recipient: account,
    walletCapabilityId: "eip1193",
    sessionRevision: 1,
    walletGrant: createProviderBindingGrant({ transportId: "hardhat-local-test", accountId, walletCapabilityId: "eip1193", sessionRevision: 1, expiresAt: Date.now() + 120_000 }),
    slippageBps: 50
  };
}

async function localFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const payload = JSON.parse(String(init?.body)) as { jsonrpc: string; id: number; method: string; params: unknown[] };
  try {
    const result = await rawRpc(payload.method, payload.params ?? []);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

async function setupFixture(seedLiquidity = true): Promise<Fixture> {
  if (hre.network.name !== "hardhat" || BigInt(await rawRpc("eth_chainId")) !== 84532n) throw new Error("test requires isolated in-process Hardhat network");
  await rawRpc("hardhat_reset", []);
  if (BigInt(await rawRpc("eth_chainId")) !== 84532n) throw new Error("test Hardhat reset changed chain");
  const raw = { send: rawRpc };
  const [owner, trader] = await hre.ethers.getSigners();
  const Token = await hre.ethers.getContractFactory("MockERC20");
  const ambr = await Token.deploy("Demo Amber", "AMBR", 18);
  const jade = await Token.deploy("Demo Jade", "JADE", 18);
  await ambr.waitForDeployment();
  await jade.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("LocalSwapFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const poolTx = await factory.createPool(ambr.target, jade.target, 1);
  const poolReceipt = await poolTx.wait();
  const poolAddress = await factory.getPool(ambr.target, jade.target, 1);
  const pool = await hre.ethers.getContractAt("LocalSwapPool", poolAddress);
  const Router = await hre.ethers.getContractFactory("LocalSwapRouter");
  const router = await Router.deploy();
  await router.waitForDeployment();

  const supply = parseEther("1000000");
  await (await ambr.mint(owner.address, supply)).wait();
  await (await jade.mint(owner.address, supply)).wait();
  await (await ambr.mint(trader.address, parseEther("1000"))).wait();
  await (await jade.mint(trader.address, parseEther("1000"))).wait();

  const amount0 = parseEther("100000");
  const amount1 = parseEther("200000");
  const token0 = (await pool.token0()).toLowerCase() === ambr.target.toLowerCase() ? ambr : jade;
  const token1 = token0.target.toLowerCase() === ambr.target.toLowerCase() ? jade : ambr;
  if (seedLiquidity) {
    await (await token0.connect(owner).approve(pool.target, amount0)).wait();
    await (await token1.connect(owner).approve(pool.target, amount1)).wait();
    const latest = await hre.ethers.provider.getBlock("latest");
    await (await pool.connect(owner).addLiquidity(amount0, amount1, 1n, owner.address, Number(latest.timestamp) + 3600)).wait();
  }

  const factoryReceipt = await hre.ethers.provider.getTransactionReceipt(factory.deploymentTransaction()!.hash);
  const routerReceipt = await hre.ethers.provider.getTransactionReceipt(router.deploymentTransaction()!.hash);
  if (!factoryReceipt || !routerReceipt || !poolReceipt) throw new Error("local deployment receipt missing");
  const factoryCode = await hre.ethers.provider.getCode(factory.target);
  const routerCode = await hre.ethers.provider.getCode(router.target);
  const poolCode = await hre.ethers.provider.getCode(pool.target);
  const profile = {
    schema: "realdex.v01-profile.v1" as const,
    deployment: {
      schema: "realdex.evm-public-testnet-deployment.v1" as const,
      releaseId: "realdex-v01-local-test",
      environment: "public-testnet" as const,
      network: { caip2: "eip155:84532" as const, name: "Base Sepolia" },
      source: {
        // Synthetic source/pin labels exercise schema binding; they are not release approval.
        bundleSha256: `sha256:${"0".repeat(64)}`,
        solidity: codeIdentities.solidity,
        optimizerRuns: codeIdentities.optimizerRuns,
        factoryRuntimeCodeHash: codeIdentities.factoryRuntimeCodeHash,
        routerRuntimeCodeHash: codeIdentities.routerRuntimeCodeHash
      },
      deployer: owner.address,
      contracts: {
        factory: deploymentEvidence(factory, factoryReceipt, keccak256(factoryCode)),
        router: deploymentEvidence(router, routerReceipt, keccak256(routerCode))
      },
      createdAt: Date.now(),
      evidenceUrls: ["https://example.com/realdex-v01-local-test", "https://example.org/realdex-v01-local-test"]
    },
    pool: { address: pool.target, runtimeCodeHash: keccak256(poolCode), feeBasisPoints: 1 },
    tokens: { ambr: ambr.target, jade: jade.target }
  };
  const pin = {
    releaseId: profile.deployment.releaseId,
    bundleSha256: profile.deployment.source.bundleSha256,
    profileFingerprint: v01ProfileFingerprint(profile)
  };
  // The two reader IDs exercise the production quorum path, but intentionally dispatch to
  // the same in-process Hardhat backend; this is not independent public RPC evidence.
  const readers = createV01ProfileReaders(["https://hardhat-a.example", "https://hardhat-b.example"], localFetch);
  const verified = await verifyV01Profile(profile, pin, readers);
  const readProvider = new LocalHardhatJsonRpcProvider(raw);
  const wallet: SyntheticWallet = {
    account: trader.address,
    chainId: "0x14a34",
    sendTransactionCalls: 0,
    calls: [],
    on: () => undefined,
    removeListener: () => undefined,
    request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
      const normalized = [...(params ?? [])];
      wallet.calls.push({ method, params: normalized });
      if (method === "eth_chainId") return wallet.chainId;
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [wallet.account];
      if (method === "eth_sendTransaction") {
        wallet.sendTransactionCalls += 1;
        return rawRpc(method, normalized);
      }
      if (["eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getCode", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getTransactionCount", "eth_getBalance"].includes(method)) {
        return rawRpc(method, normalized);
      }
      throw new Error(`unexpected synthetic wallet method ${method}`);
    }
  };
  const entry: EvmWalletProviderEntry = {
    source: "eip6963",
    info: { uuid: "00000000-0000-4000-8000-000000000001", name: "Local MetaMask fixture", icon: "", rdns: "io.metamask" },
    provider: wallet
  };
  const context = { current: true };
  // In-memory test sink; durable browser storage is exercised by connected QA.
  const attempts: V01SendAttempt[] = [];
  const runtime = createV01Runtime({ profile: verified, entry, explicitlySelected: true, readProvider, isCurrent: () => context.current, persistBeforeWalletRequest: attempt => { attempts.push(JSON.parse(JSON.stringify(attempt))); return true; } });
  await runtime.connect();
  return { raw, readProvider, wallet, owner, trader, ambr, jade, factory, router, pool, profile, verified, runtime, context, attempts };
}

describe.sequential("RealDEX v0.1 local EVM integration", () => {
  let fixture!: Fixture;

  beforeAll(async () => {
    // Keep this test runnable from a fresh checkout without relying on committed artifacts.
    await hre.run("compile");
    fixture = await setupFixture();
  }, 60_000);

  afterAll(() => {
    fixture?.readProvider.destroy();
  });

  it("verifies deployment evidence and rejects wrong chain before any wallet send", async () => {
    expect(fixture.verified.status).toBe("verified-profile");
    expect(fixture.verified.readerIds).toEqual(["hardhat-a.example", "hardhat-b.example"]);
    expect(await fixture.readProvider.getNetwork()).toMatchObject({ chainId: 84532n });
    const route = fixture.verified.routes[0];
    const request = requestFor(route, fixture.trader.address, "00000000-0000-4000-8000-000000000001", parseEther("1"));
    const before = fixture.wallet.sendTransactionCalls;
    fixture.wallet.chainId = "0x1";
    await expect(fixture.runtime.adapter.quote(route, request)).rejects.toThrow("WALLET_NETWORK_CHANGED");
    expect(fixture.wallet.sendTransactionCalls).toBe(before);
    fixture.wallet.chainId = "0x14a34";
  });

  it("runs AMBR -> JADE with exact approval, fee review, local execution, journal, and confirmations", async () => {
    const route = fixture.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(fixture.ambr.target.toLowerCase()))!;
    const amount = parseEther("10");
    const request = requestFor(route, fixture.trader.address, "00000000-0000-4000-8000-000000000002", amount);
    expect(await fixture.ambr.allowance(fixture.trader.address, fixture.pool.target)).toBe(0n);
    const quote = await fixture.runtime.adapter.quote(route, request);
    expect(quote.authorization).toMatchObject({ type: "approval", spender: fixture.pool.target, amountBaseUnits: amount });
    expect(() => createV01RecoveryIntent({ ...fixture.verified }, route, request, quote)).toThrow("V01_VERIFIED_PROFILE_REQUIRED");
    const recoveryIntent = createV01RecoveryIntent(fixture.verified, route, request, quote);
    const feePlan = fixture.runtime.feePlan(quote);
    expect(feePlan.approvalSimulation).toBe(true);
    expect(feePlan.steps.map((step) => step.role)).toEqual(["approval", "swap"]);
    expect(fixture.readProvider.oracleObservations.length).toBeGreaterThanOrEqual(4);
    expect(fixture.readProvider.allowanceOverrideObservations.length).toBeGreaterThanOrEqual(1);
    expect(await fixture.ambr.allowance(fixture.trader.address, fixture.pool.target)).toBe(0n);

    const beforeAmbr = await fixture.ambr.balanceOf(fixture.trader.address);
    const beforeJade = await fixture.jade.balanceOf(fixture.trader.address);
    const progress: RouteExecutionReceipt[] = [];
    const storage = new Map<string, string>();
    const storageLike = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
    const display = { sourceSymbol: "AMBR", sourceDecimals: 18, destinationSymbol: "JADE", destinationDecimals: 18 };
    let journalRecord: ReturnType<typeof recordEvmSwapReceipt>;
    const persistProgress = (value: RouteExecutionReceipt) => {
      const next = recordEvmSwapReceipt(route, request, quote, value, display, journalRecord);
      if (next) {
        journalRecord = next;
        writeEvmSwapRecoveryRecord(next, storageLike);
      }
      progress.push(value);
    };
    const receipt = await executeRouteQuote(route, request, quote, [fixture.runtime.adapter], Date.now(), persistProgress);
    expect(receipt.state).toBe("confirmed");
    expect(receipt.steps.filter((step) => step.kind === "approval")).toHaveLength(1);
    expect(receipt.steps.filter((step) => step.kind === "swap")).toHaveLength(1);
    const expectedOut = quote.expectedOutBaseUnits;
    expect(await fixture.ambr.balanceOf(fixture.trader.address)).toBe(beforeAmbr - amount);
    expect(await fixture.jade.balanceOf(fixture.trader.address)).toBe(beforeJade + expectedOut);
    expect(progress.some((item) => item.state === "pending")).toBe(true);
    expect(fixture.wallet.sendTransactionCalls).toBe(2);

    const record = recordEvmSwapReceipt(route, request, quote, receipt, display, journalRecord);
    expect(record).toMatchObject({ recoveryId: recoveryIntent.recoveryId, routeFingerprint: recoveryIntent.routeFingerprint, requestFingerprint: recoveryIntent.requestFingerprint, quoteId: recoveryIntent.quoteId });
    for (const attempt of fixture.attempts.filter(item => item.quoteId === quote.quoteId)) assertV01AttemptMatchesRecoveryIntent(attempt, recoveryIntent);
    expect(record?.stage).toBe("swap-included");
    writeEvmSwapRecoveryRecord(record!, storageLike);
    // Parse the bytes written during progress before doing the later read-only refresh.
    expect(readEvmSwapRecoveryJournal(storageLike)).toHaveLength(1);
    const restored = readEvmSwapRecoveryJournal(storageLike)[0];
    expect(restored.stage).toBe("swap-included");
    expect(restored).not.toBe(record);
    await fixture.raw.send("evm_mine", []);
    await fixture.raw.send("evm_mine", []);
    const recovered = await refreshEvmSwapRecovery(restored, createJsonRpcEvmSwapRecoveryReader(fixture.readProvider));
    expect(recovered.stage).toBe("swap-confirmed");
    writeEvmSwapRecoveryRecord(recovered, storageLike);
    expect(recovered.revision).toBe(record!.revision + 1);
    expect(readEvmSwapRecoveryJournal(storageLike)[0].revision).toBe(recovered.revision);
  });

  it("runs JADE -> AMBR with sufficient allowance and blocks duplicate quote execution", async () => {
    const route = fixture.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(fixture.jade.target.toLowerCase()))!;
    const amount = parseEther("7");
    await (await fixture.jade.connect(fixture.trader).approve(fixture.pool.target, amount)).wait();
    const request = requestFor(route, fixture.trader.address, "00000000-0000-4000-8000-000000000003", amount);
    const quote = await fixture.runtime.adapter.quote(route, request);
    expect(quote.authorization).toEqual({ type: "none" });
    const recoveryIntent = createV01RecoveryIntent(fixture.verified, route, request, quote);
    const beforeJade = await fixture.jade.balanceOf(fixture.trader.address);
    const beforeAmbr = await fixture.ambr.balanceOf(fixture.trader.address);
    const receipt = await executeRouteQuote(route, request, quote, [fixture.runtime.adapter]);
    expect(receipt.state).toBe("confirmed");
    expect(receipt.steps.filter((step) => step.kind === "approval")).toHaveLength(0);
    expect(receipt.steps.filter((step) => step.kind === "swap")).toHaveLength(1);
    expect(await fixture.jade.balanceOf(fixture.trader.address)).toBe(beforeJade - amount);
    expect(await fixture.ambr.balanceOf(fixture.trader.address)).toBe(beforeAmbr + quote.expectedOutBaseUnits);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const record = recordEvmSwapReceipt(route, request, quote, receipt, { sourceSymbol: "JADE", sourceDecimals: 18, destinationSymbol: "AMBR", destinationDecimals: 18 })!;
    expect(record.recoveryId).toBe(recoveryIntent.recoveryId);
    const sent = fixture.attempts.filter(item => item.quoteId === quote.quoteId); expect(sent).toHaveLength(1);
    assertV01AttemptMatchesRecoveryIntent(sent[0], recoveryIntent);
    writeEvmSwapRecoveryRecord(record, storage);
    await fixture.raw.send("evm_mine", []);
    const restored = readEvmSwapRecoveryJournal(storage)[0];
    const confirmed = await refreshEvmSwapRecovery(restored, createJsonRpcEvmSwapRecoveryReader(fixture.readProvider));
    expect(confirmed.stage).toBe("swap-confirmed");
    expect(confirmed.transactions.map(tx => tx.role)).toEqual(["swap"]);
    writeEvmSwapRecoveryRecord(confirmed, storage);
    expect(readEvmSwapRecoveryJournal(storage)[0].stage).toBe("swap-confirmed");
    await expect(executeRouteQuote(route, request, quote, [fixture.runtime.adapter])).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
  });

  it("invalidates the verified profile before a wallet send", async () => {
    invalidateV01Profile(fixture.verified);
    expect(fixture.wallet.sendTransactionCalls).toBe(3);
    const route = fixture.verified.routes[0];
    const request = requestFor(route, fixture.trader.address, "00000000-0000-4000-8000-000000000004", parseEther("1"));
    await expect(fixture.runtime.adapter.quote(route, request)).rejects.toThrow("V01_VERIFIED_PROFILE_REQUIRED");
    await expect(fixture.runtime.balances()).rejects.toThrow("V01_VERIFIED_PROFILE_REQUIRED");
    expect(fixture.wallet.sendTransactionCalls).toBe(3);
    expect(() => fixture.runtime.feePlan({} as RouteQuote)).toThrow("V01_FEE_REVIEW_REQUIRED");
  });
});

describe.sequential("RealDEX v0.1 local EVM failure integration", () => {
  it("keeps write-ahead and receipt recovery start blocks identical when blocks advance during preflight", async () => {
    const env = await setupFixture();
    const observed: number[] = [];
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const route = env.verified.routes[0];
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000301", parseEther("3"));
      const quote = await env.runtime.adapter.quote(route, request);
      spy = vi.spyOn(env.readProvider, "getBlockNumber").mockImplementation(async () => {
        const block = Number(BigInt(await env.raw.send("eth_blockNumber", [])));
        observed.push(block);
        await env.raw.send("evm_mine", []);
        return block;
      });
      const progress: RouteExecutionReceipt[] = [];
      const receipt = await executeRouteQuote(route, request, quote, [env.runtime.adapter], Date.now(), item => progress.push(structuredClone(item)));
      expect(receipt.state).toBe("confirmed");
      expect(observed).toHaveLength(2);
      expect(env.attempts).toHaveLength(2);
      for (const [index, attempt] of env.attempts.entries()) {
        expect(attempt.observedBeforeBlock).toBe(observed[index] + 1);
        for (const item of [...progress, receipt]) {
          const step = item.steps.find(value => value.kind === attempt.role);
          if (step?.evmTransaction) expect(step.evmTransaction.observedBeforeBlock).toBe(attempt.observedBeforeBlock);
        }
      }
    } finally { spy?.mockRestore(); env.readProvider.destroy(); }
  });

  it("does not broadcast approval when the selected wallet rejects it", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.ambr.target.toLowerCase()))!;
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000101", parseEther("3"));
      const quote = await env.runtime.adapter.quote(route, request);
      const original = env.wallet.request;
      let attempts = 0;
      env.wallet.request = async (args) => {
        if (args.method === "eth_sendTransaction") {
          attempts += 1;
          throw walletRejected("approval rejected by local wallet fixture");
        }
        return original(args);
      };
      const before = await env.ambr.balanceOf(env.trader.address);
      const receipt = await executeRouteQuote(route, request, quote, [env.runtime.adapter]);
      expect(receipt.state).toBe("failed");
      expect(receipt.failureProof).toEqual({ type: "no-value-transfer-submitted" });
      expect(attempts).toBe(1);
      expect(env.wallet.sendTransactionCalls).toBe(0);
      expect(await env.ambr.balanceOf(env.trader.address)).toBe(before);
      expect(await env.ambr.allowance(env.trader.address, env.pool.target)).toBe(0n);
      expect(receipt.steps.some((step) => step.txHash)).toBe(false);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("keeps a confirmed approval but never broadcasts a rejected swap", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.ambr.target.toLowerCase()))!;
      const amount = parseEther("4");
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000102", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      const original = env.wallet.request;
      let attempts = 0;
      env.wallet.request = async (args) => {
        if (args.method === "eth_sendTransaction") {
          attempts += 1;
          if (attempts === 2) throw walletRejected("swap rejected by local wallet fixture");
        }
        return original(args);
      };
      const beforeAmbr = await env.ambr.balanceOf(env.trader.address);
      const beforeJade = await env.jade.balanceOf(env.trader.address);
      const storage = new Map<string, string>();
      const storageLike = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
      const display = { sourceSymbol: "AMBR", sourceDecimals: 18, destinationSymbol: "JADE", destinationDecimals: 18 };
      let journalRecord: ReturnType<typeof recordEvmSwapReceipt>;
      const progress = (value: RouteExecutionReceipt) => {
        const next = recordEvmSwapReceipt(route, request, quote, value, display, journalRecord);
        if (next) {
          journalRecord = next;
          writeEvmSwapRecoveryRecord(next, storageLike);
        }
      };
      const receipt = await executeRouteQuote(route, request, quote, [env.runtime.adapter], Date.now(), progress);
      expect(receipt.state).toBe("failed");
      expect(receipt.failureProof).toEqual({ type: "no-value-transfer-submitted" });
      expect(attempts).toBe(2);
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(receipt.steps.find((step) => step.kind === "approval")?.state).toBe("confirmed");
      expect(receipt.steps.some((step) => step.kind === "swap" && step.txHash)).toBe(false);
      expect(await env.ambr.allowance(env.trader.address, env.pool.target)).toBe(amount);
      expect(await env.ambr.balanceOf(env.trader.address)).toBe(beforeAmbr);
      expect(await env.jade.balanceOf(env.trader.address)).toBe(beforeJade);
      const finalRecord = recordEvmSwapReceipt(route, request, quote, receipt, display, journalRecord)!;
      writeEvmSwapRecoveryRecord(finalRecord, storageLike);
      const restored = readEvmSwapRecoveryJournal(storageLike)[0];
      expect(restored.stage).toBe("stopped-after-approval");
      expect(restored.transactions.map((tx) => tx.role)).toEqual(["approval"]);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("distinguishes a locally mined swap with a lost wallet response from no-send failure and blocks reuse", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.jade.target.toLowerCase()))!;
      const amount = parseEther("5");
      await (await env.jade.connect(env.trader).approve(env.pool.target, amount)).wait();
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000103", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      const recovery = createV01RecoveryIntent(env.verified, route, request, quote);
      const original = env.wallet.request;
      let sentHash: string | undefined;
      env.wallet.request = async (args) => {
        const transaction = Array.isArray(args.params) ? args.params[0] as { to?: unknown } : undefined;
        if (args.method === "eth_sendTransaction" && String(transaction?.to).toLowerCase() === env.pool.target.toLowerCase()) {
          sentHash = await original(args) as string;
          // Ambiguous transport prose must not be mistaken for an explicit user rejection.
          throw new Error("RPC access denied after broadcast");
        }
        return original(args);
      };
      const beforeJade = await env.jade.balanceOf(env.trader.address);
      const beforeAmbr = await env.ambr.balanceOf(env.trader.address);
      const storage = new Map<string, string>();
      const storageLike = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
      const display = { sourceSymbol: "JADE", sourceDecimals: 18, destinationSymbol: "AMBR", destinationDecimals: 18 };
      let journalRecord: ReturnType<typeof recordEvmSwapReceipt>;
      const progress = (value: RouteExecutionReceipt) => {
        const next = recordEvmSwapReceipt(route, request, quote, value, display, journalRecord);
        if (next) {
          journalRecord = next;
          writeEvmSwapRecoveryRecord(next, storageLike);
        }
      };
      await expect(executeRouteQuote(route, request, quote, [env.runtime.adapter], Date.now(), progress)).rejects.toThrow("RPC access denied after broadcast");
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(sentHash).toMatch(/^0x[0-9a-f]{64}$/i);
      const onChain = await env.readProvider.getTransactionReceipt(sentHash!);
      expect(onChain?.status).toBe(1);
      expect(env.attempts).toHaveLength(1);
      const captured = env.attempts[0];
      const observed = await env.readProvider.getTransaction(sentHash!);
      expect(captured).toMatchObject({ role: "swap", intentId: request.executionIntentId, quoteId: quote.quoteId, profileFingerprint: env.verified.fingerprint });
      expect(observed).toMatchObject({ from: captured.transaction.from, to: captured.transaction.to, data: captured.transaction.data, nonce: Number(BigInt(captured.transaction.nonce)), value: 0n, chainId: 84532n });
      expect(captured.observedBeforeBlock).toBeLessThan(onChain!.blockNumber);
      const operation: ActiveV01Operation = JSON.parse(JSON.stringify({ schema: "realdex.v01-active-operation.v3", intentId: captured.intentId, quoteId: captured.quoteId, profileFingerprint: captured.profileFingerprint, recoveryId: null, attempts: [captured], recovery }));
      const operationBytes = JSON.stringify(operation);
      // Both test reader IDs use one isolated backend; this is not independent RPC evidence.
      const readers = env.verified.readerIds.map(id => ({ id, send: (method: string, params: unknown[]) => env.readProvider.send(method, params) }));
      const candidateOptions = { operation, role: "swap" as const, hash: sentHash!, profile: env.verified, readers, readOperation: () => operation, isCurrent: () => env.context.current };
      await expect(verifyV01Candidate({ ...candidateOptions, profile: { ...env.verified } })).rejects.toThrow();
      expect(await verifyV01Candidate(candidateOptions)).toMatchObject({ status: "candidate-matched", hash: sentHash, receiptStatus: 1, confirmations: 1, blockNumber: onChain!.blockNumber });
      await env.raw.send("evm_mine", []);
      expect(await verifyV01Candidate(candidateOptions)).toMatchObject({ status: "candidate-matched", receiptStatus: 1, confirmations: 2 });
      expect(JSON.stringify(operation)).toBe(operationBytes);
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(await env.jade.balanceOf(env.trader.address)).toBe(beforeJade - amount);
      expect(await env.ambr.balanceOf(env.trader.address)).toBe(beforeAmbr + quote.expectedOutBaseUnits);
      // Matching a candidate is read-only: it cannot insert history or release the operation.
      expect(readEvmSwapRecoveryJournal(storageLike)).toEqual([]);
      await expect(executeRouteQuote(route, request, quote, [env.runtime.adapter])).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
      expect(env.wallet.sendTransactionCalls).toBe(1);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("retains a persisted swap hash when receipt lookup is unavailable, then refreshes it read-only", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.jade.target.toLowerCase()))!;
      const amount = parseEther("5");
      await (await env.jade.connect(env.trader).approve(env.pool.target, amount)).wait();
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000105", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      const original = env.wallet.request;
      let swapSent = false;
      let sentHash: string | undefined;
      env.wallet.request = async (args) => {
        const transaction = Array.isArray(args.params) ? args.params[0] as { to?: unknown } : undefined;
        if (args.method === "eth_sendTransaction" && String(transaction?.to).toLowerCase() === env.pool.target.toLowerCase()) {
          sentHash = await original(args) as string;
          swapSent = true;
          return sentHash;
        }
        if (swapSent && args.method === "eth_getTransactionReceipt") throw new Error("RPC_RECEIPT_LOOKUP_LOST");
        return original(args);
      };
      const storage = new Map<string, string>();
      const storageLike = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
      const display = { sourceSymbol: "JADE", sourceDecimals: 18, destinationSymbol: "AMBR", destinationDecimals: 18 };
      let journalRecord: ReturnType<typeof recordEvmSwapReceipt>;
      const progress = (value: RouteExecutionReceipt) => {
        const next = recordEvmSwapReceipt(route, request, quote, value, display, journalRecord);
        if (next) {
          journalRecord = next;
          writeEvmSwapRecoveryRecord(next, storageLike);
        }
      };
      await expect(executeRouteQuote(route, request, quote, [env.runtime.adapter], Date.now(), progress)).rejects.toThrow("RPC_RECEIPT_LOOKUP_LOST");
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(sentHash).toMatch(/^0x[0-9a-f]{64}$/i);
      const stored = readEvmSwapRecoveryJournal(storageLike)[0];
      expect(stored.stage).toBe("swap-submitted");
      expect(stored.transactions[0].hash).toBe(sentHash!.toLowerCase());
      // Bypass the failed wallet transport with the read-only local RPC provider.
      const onChain = await env.readProvider.getTransactionReceipt(sentHash!);
      expect(onChain?.status).toBe(1);
      const refreshed = await refreshEvmSwapRecovery(stored, createJsonRpcEvmSwapRecoveryReader(env.readProvider));
      expect(refreshed.stage).toBe("swap-included");
      expect(refreshed.transactions[0].confirmations).toBeGreaterThanOrEqual(1);
      await expect(executeRouteQuote(route, request, quote, [env.runtime.adapter])).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
      expect(env.wallet.sendTransactionCalls).toBe(1);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("stops after confirmed approval when local nonce preflight changes, distinct from forwarded unknown", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.ambr.target.toLowerCase()))!;
      const amount = parseEther("6");
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000104", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      const original = env.wallet.request;
      env.wallet.request = async (args) => {
        const result = await original(args);
        const transaction = Array.isArray(args.params) ? args.params[0] as { to?: unknown } : undefined;
        if (args.method === "eth_sendTransaction" && String(transaction?.to).toLowerCase() === env.ambr.target.toLowerCase()) {
          const current = BigInt(await rawRpc("eth_getTransactionCount", [env.trader.address, "pending"]));
          env.readProvider.nonceOverride = `0x${(current + 1n).toString(16)}`;
        }
        return result;
      };
      const storage = new Map<string, string>();
      const storageLike = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
      const display = { sourceSymbol: "AMBR", sourceDecimals: 18, destinationSymbol: "JADE", destinationDecimals: 18 };
      let journalRecord: ReturnType<typeof recordEvmSwapReceipt>;
      const progress = (value: RouteExecutionReceipt) => {
        const next = recordEvmSwapReceipt(route, request, quote, value, display, journalRecord);
        if (next) {
          journalRecord = next;
          writeEvmSwapRecoveryRecord(next, storageLike);
        }
      };
      const receipt = await executeRouteQuote(route, request, quote, [env.runtime.adapter], Date.now(), progress);
      expect(receipt.state).toBe("failed");
      expect(receipt.failureProof).toEqual({ type: "no-value-transfer-submitted" });
      expect(receipt.steps.find((step) => step.kind === "approval")?.state).toBe("confirmed");
      expect(receipt.steps.some((step) => step.kind === "swap" && step.txHash)).toBe(false);
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(await env.ambr.allowance(env.trader.address, env.pool.target)).toBe(amount);
      const finalRecord = recordEvmSwapReceipt(route, request, quote, receipt, display, journalRecord)!;
      writeEvmSwapRecoveryRecord(finalRecord, storageLike);
      expect(readEvmSwapRecoveryJournal(storageLike)[0].stage).toBe("stopped-after-approval");
    } finally {
      env.readProvider.destroy();
    }
  });
});

describe.sequential("RealDEX v0.1 local EVM preflight and state fault integration", () => {
  it("stops before wallet send when the quoted token balance becomes insufficient", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.ambr.target.toLowerCase()))!;
      const amount = parseEther("3");
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000201", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      const balance = await env.ambr.balanceOf(env.trader.address);
      await (await env.ambr.connect(env.trader).transfer(env.owner.address, balance)).wait();
      await expect(executeRouteQuote(route, request, quote, [env.runtime.adapter])).rejects.toThrow("V01_TOKEN_BALANCE_INSUFFICIENT");
      expect(env.wallet.sendTransactionCalls).toBe(0);
      expect(await env.ambr.balanceOf(env.trader.address)).toBe(0n);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("stops before wallet send when the selected account changes after quote", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes[0];
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000202", parseEther("1"));
      const quote = await env.runtime.adapter.quote(route, request);
      env.wallet.account = env.owner.address;
      await expect(executeRouteQuote(route, request, quote, [env.runtime.adapter])).rejects.toThrow("WALLET_ACCOUNT_CHANGED");
      expect(env.wallet.sendTransactionCalls).toBe(0);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("stops before wallet send when isCurrent context changes after quote", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes[0];
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000203", parseEther("1"));
      const quote = await env.runtime.adapter.quote(route, request);
      env.context.current = false;
      await expect(executeRouteQuote(route, request, quote, [env.runtime.adapter])).rejects.toThrow("ADAPTER_NOT_INSTALLED");
      expect(env.wallet.sendTransactionCalls).toBe(0);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("stops after approval when a real market change makes the reviewed swap simulation fail", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.ambr.target.toLowerCase()))!;
      const amount = parseEther("4");
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000204", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      const original = env.wallet.request;
      let failedWalletSwapEstimate = false;
      env.wallet.request = async (args) => {
        const transaction = Array.isArray(args.params) ? args.params[0] as { to?: unknown } : undefined;
        let result: unknown;
        try { result = await original(args); }
        catch (reason) {
          if (args.method === "eth_estimateGas" && String(transaction?.to).toLowerCase() === env.pool.target.toLowerCase()) failedWalletSwapEstimate = true;
          throw reason;
        }
        if (args.method === "eth_sendTransaction" && String(transaction?.to).toLowerCase() === env.ambr.target.toLowerCase()) {
          const perturbation = parseEther("50000");
          await (await env.ambr.connect(env.owner).approve(env.pool.target, perturbation)).wait();
          const latest = await env.raw.send("eth_getBlockByNumber", ["latest", false]);
          const deadline = Number(BigInt(String(latest.timestamp))) + 3600;
          await (await env.pool.connect(env.owner).swapExactIn(env.ambr.target, perturbation, 1n, env.owner.address, deadline)).wait();
        }
        return result;
      };
      const beforeAmbr = await env.ambr.balanceOf(env.trader.address);
      const beforeJade = await env.jade.balanceOf(env.trader.address);
      const receipt = await executeRouteQuote(route, request, quote, [env.runtime.adapter]);
      expect(receipt.state).toBe("failed");
      expect(receipt.failureProof).toEqual({ type: "no-value-transfer-submitted" });
      expect(receipt.steps.find((step) => step.kind === "approval")?.state).toBe("confirmed");
      expect(receipt.steps.some((step) => step.kind === "swap" && step.txHash)).toBe(false);
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(await env.ambr.allowance(env.trader.address, env.pool.target)).toBe(amount);
      expect(await env.ambr.balanceOf(env.trader.address)).toBe(beforeAmbr);
      expect(await env.jade.balanceOf(env.trader.address)).toBe(beforeJade);
      expect(failedWalletSwapEstimate || env.readProvider.failedPlainEstimates.some(item => item.target === env.pool.target.toLowerCase())).toBe(true);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("preserves an on-chain reverted swap receipt when the local deadline passes immediately before broadcast", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.jade.target.toLowerCase()))!;
      const amount = parseEther("5");
      await (await env.jade.connect(env.trader).approve(env.pool.target, amount)).wait();
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000205", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      const original = env.wallet.request;
      env.wallet.request = async (args) => {
        const transaction = Array.isArray(args.params) ? args.params[0] as { data?: unknown; to?: unknown } : undefined;
        if (args.method === "eth_sendTransaction" && String(transaction?.to).toLowerCase() === env.pool.target.toLowerCase()) {
          const decoded = new Interface(POOL_ABI).parseTransaction({ data: String(transaction?.data) });
          const deadline = Number(decoded?.args[4]);
          const latest = await env.raw.send("eth_getBlockByNumber", ["latest", false]);
          const now = Number(BigInt(String(latest.timestamp)));
          await env.raw.send("evm_increaseTime", [Math.max(1, deadline - now + 2)]);
          await env.raw.send("evm_mine", []);
        }
        return original(args);
      };
      const beforeJade = await env.jade.balanceOf(env.trader.address);
      const beforeAmbr = await env.ambr.balanceOf(env.trader.address);
      const receipt = await executeRouteQuote(route, request, quote, [env.runtime.adapter]);
      expect(receipt.state).toBe("failed");
      expect(receipt.failureProof?.type).toBe("evm-value-transfer-reverted");
      const swap = receipt.steps.find((step) => step.kind === "swap");
      expect(swap?.state).toBe("reverted");
      expect(swap?.evmReceipt?.status).toBe(0);
      expect(swap?.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect((await env.readProvider.getTransactionReceipt(swap!.txHash!))?.status).toBe(0);
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(await env.jade.balanceOf(env.trader.address)).toBe(beforeJade);
      expect(await env.ambr.balanceOf(env.trader.address)).toBe(beforeAmbr);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("stops after approved progress persistence fails and does not submit the swap", async () => {
    const env = await setupFixture();
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.ambr.target.toLowerCase()))!;
      const amount = parseEther("4");
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000206", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      const storage = new Map<string, string>();
      let failWrites = false;
      const storageLike = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => {
        if (failWrites) throw new Error("PROGRESS_STORAGE_WRITE_FAILED");
        storage.set(key, value);
      } };
      const display = { sourceSymbol: "AMBR", sourceDecimals: 18, destinationSymbol: "JADE", destinationDecimals: 18 };
      let journalRecord: ReturnType<typeof recordEvmSwapReceipt>;
      let progressCount = 0;
      const progress = (value: RouteExecutionReceipt) => {
        progressCount += 1;
        if (value.steps.some((step) => step.kind === "approval" && step.state === "confirmed")) failWrites = true;
        const next = recordEvmSwapReceipt(route, request, quote, value, display, journalRecord);
        if (next) {
          writeEvmSwapRecoveryRecord(next, storageLike);
          journalRecord = next;
        }
      };
      const receipt = await executeRouteQuote(route, request, quote, [env.runtime.adapter], Date.now(), progress);
      expect(progressCount).toBe(2);
      expect(receipt.state).toBe("failed");
      expect(receipt.failureProof).toEqual({ type: "no-value-transfer-submitted" });
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(receipt.steps.some((step) => step.kind === "swap" && step.txHash)).toBe(false);
      expect(await env.ambr.allowance(env.trader.address, env.pool.target)).toBe(amount);
      expect(readEvmSwapRecoveryJournal(storageLike)[0].stage).toBe("approval-submitted");
      const finalRecord = recordEvmSwapReceipt(route, request, quote, receipt, display, journalRecord)!;
      expect(() => writeEvmSwapRecoveryRecord(finalRecord, storageLike)).toThrow("PROGRESS_STORAGE_WRITE_FAILED");
      // Test-only recovery of the storage service. Production does not silently retry a
      // failed write or claim the returned stopped receipt has already been persisted.
      failWrites = false;
      writeEvmSwapRecoveryRecord(finalRecord, storageLike);
      expect(readEvmSwapRecoveryJournal(storageLike)[0].stage).toBe("stopped-after-approval");
    } finally {
      env.readProvider.destroy();
    }
  });

  it("rejects both directions on a verified but unseeded pool without approval or swap requests", async () => {
    const env = await setupFixture(false);
    try {
      expect(env.verified.status).toBe("verified-profile");
      expect((await env.pool.getReserves()).slice(0, 2)).toEqual([0n, 0n]);
      const before = [await env.ambr.balanceOf(env.trader.address), await env.jade.balanceOf(env.trader.address)];
      for (const [index, route] of env.verified.routes.entries()) {
        const request = requestFor(route, env.trader.address, `00000000-0000-4000-8000-00000000030${index}`, parseEther("1"));
        await expect(env.runtime.adapter.quote(route, request)).rejects.toMatchObject({ code: "CALL_EXCEPTION" });
      }
      expect(env.wallet.sendTransactionCalls).toBe(0);
      expect(env.attempts).toEqual([]);
      expect(await env.ambr.allowance(env.trader.address, env.pool.target)).toBe(0n);
      expect(await env.jade.allowance(env.trader.address, env.pool.target)).toBe(0n);
      expect([await env.ambr.balanceOf(env.trader.address), await env.jade.balanceOf(env.trader.address)]).toEqual(before);
    } finally {
      env.readProvider.destroy();
    }
  });

  it("expires the quote after approval and does not permit unsafe reuse", async () => {
    const env = await setupFixture();
    const realNow = Date.now;
    try {
      const route = env.verified.routes.find((item) => item.sourceAsset.toLowerCase().includes(env.ambr.target.toLowerCase()))!;
      const amount = parseEther("4");
      const request = requestFor(route, env.trader.address, "00000000-0000-4000-8000-000000000207", amount);
      const quote = await env.runtime.adapter.quote(route, request);
      let now = realNow();
      Date.now = () => now;
      const original = env.wallet.request;
      env.wallet.request = async (args) => {
        const result = await original(args);
        const transaction = Array.isArray(args.params) ? args.params[0] as { to?: unknown } : undefined;
        if (args.method === "eth_sendTransaction" && String(transaction?.to).toLowerCase() === env.ambr.target.toLowerCase()) now = quote.expiresAt + 1;
        return result;
      };
      const receipt = await executeRouteQuote(route, request, quote, [env.runtime.adapter]);
      expect(receipt.state).toBe("failed");
      expect(receipt.failureProof).toEqual({ type: "no-value-transfer-submitted" });
      expect(env.wallet.sendTransactionCalls).toBe(1);
      expect(receipt.steps.some((step) => step.kind === "swap" && step.txHash)).toBe(false);
      expect(await env.ambr.allowance(env.trader.address, env.pool.target)).toBe(amount);
      await expect(executeRouteQuote(route, request, quote, [env.runtime.adapter])).rejects.toThrow("QUOTE_EXPIRY_INVALID");
      expect(env.wallet.sendTransactionCalls).toBe(1);
    } finally {
      Date.now = realNow;
      env.readProvider.destroy();
    }
  });
});
