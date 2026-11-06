import { describe, expect, it, vi } from "vitest";

const factoryCode = "0x6000";
const routerCode = "0x6001";
const tokenCode = "0x6002";
const factoryHash = "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d";
const routerHash = "0x309c67890bde4c575dc23d2cc3b5c3a3d599e312e980e9b61b5bc8f3cd87c8bb";
const tokenHash = "0xcde7aac41575d8b30bd84f598371d46d266fadb09c9dcfcdd047fd087ef8763e";

vi.mock("../swap/local-amm-code-identities.json", () => ({
  default: {
    schema: "localswap.evm-code-identities.v1",
    solidity: "0.8.24",
    optimizerRuns: 500,
    factoryRuntimeCodeHash: "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d",
    routerRuntimeCodeHash: "0x309c67890bde4c575dc23d2cc3b5c3a3d599e312e980e9b61b5bc8f3cd87c8bb",
    mockErc20Decimals18RuntimeCodeHash: "0xcde7aac41575d8b30bd84f598371d46d266fadb09c9dcfcdd047fd087ef8763e"
  }
}));

import {
  V01_CHAIN_ID,
  V01_PROFILE_TTL_MS,
  assertCurrentV01Profile,
  assertV01Route,
  invalidateV01Profile,
  parseV01Profile,
  v01ProfileFingerprint,
  verifyV01Eoa,
  verifyV01Profile,
  type V01Profile,
  type V01ProfilePin,
  type V01ProfileReader,
  type VerifiedV01Profile
} from "./v01-profile";

const NOW = 1_800_000_000_000;
const factoryAddress = "0x1111111111111111111111111111111111111111";
const routerAddress = "0x2222222222222222222222222222222222222222";
const poolAddress = "0x3333333333333333333333333333333333333333";
const ambrAddress = "0x4444444444444444444444444444444444444444";
const jadeAddress = "0x5555555555555555555555555555555555555555";
const deployerAddress = "0x6666666666666666666666666666666666666666";
const eoaAddress = "0x7777777777777777777777777777777777777777";
const factoryTx = `0x${"a".repeat(64)}`;
const routerTx = `0x${"b".repeat(64)}`;

const V01_POOL_FEE_BASIS_POINTS = 1;

type ReaderChange = Partial<{
  chainId: bigint;
  blockNumber: number;
  factoryCode: string;
  routerCode: string;
  poolCode: string;
  ambrCode: string;
  jadeCode: string;
  eoaCode: string;
  poolFor: string;
  poolFee: number;
  poolFactory: string;
  poolTokens: { token0: string; token1: string };
  ambrMetadata: { name: string; symbol: string; decimals: number };
  jadeMetadata: { name: string; symbol: string; decimals: number };
  factoryReceiptAddress: string;
  routerReceiptAddress: string;
  factoryReceiptStatus: "success" | "failed";
  routerReceiptStatus: "success" | "failed";
  factoryReceiptBlock: number;
  routerReceiptBlock: number;
}> & { delay?: Promise<void>; eoaDelay?: Promise<void>; chainIdGate?: Promise<void>; chainIdAfter?: bigint };

function manifest(overrides: Partial<V01Profile["deployment"]> = {}): V01Profile {
  return {
    schema: "realdex.v01-profile.v1",
    deployment: {
      schema: "realdex.evm-public-testnet-deployment.v1",
      releaseId: "base-sepolia-2026-09-01-a",
      environment: "public-testnet",
      network: { caip2: "eip155:84532", name: "Base Sepolia" },
      source: {
        bundleSha256: `sha256:${"c".repeat(64)}`,
        solidity: "0.8.24",
        optimizerRuns: 500,
        factoryRuntimeCodeHash: factoryHash,
        routerRuntimeCodeHash: routerHash
      },
      deployer: deployerAddress,
      contracts: {
        factory: { address: factoryAddress, deploymentTxHash: factoryTx, blockNumber: 100, runtimeCodeHash: factoryHash },
        router: { address: routerAddress, deploymentTxHash: routerTx, blockNumber: 101, runtimeCodeHash: routerHash }
      },
      createdAt: NOW,
      evidenceUrls: ["https://example.invalid/source", "https://example.invalid/build"],
      ...overrides
    },
    pool: { address: poolAddress, runtimeCodeHash: "0x124787cd33af4a91148bc5521374b123cb0c5aaa5b0f02ff8d9bf1bb816791b8", feeBasisPoints: V01_POOL_FEE_BASIS_POINTS },
    tokens: { ambr: ambrAddress, jade: jadeAddress }
  };
}

function reader(id: string, change: ReaderChange = {}): V01ProfileReader {
  const wait = async () => { if (change.delay) await change.delay; };
  let chainCalls = 0;
  return {
    id,
    chainId: async () => {
      await wait();
      chainCalls++;
      if (chainCalls >= 3 && change.chainIdGate) {
        await change.chainIdGate;
        return change.chainIdAfter ?? V01_CHAIN_ID;
      }
      return change.chainId ?? V01_CHAIN_ID;
    },
    blockNumber: async () => { await wait(); return change.blockNumber ?? 120; },
    poolFee: async () => { await wait(); return change.poolFee ?? V01_POOL_FEE_BASIS_POINTS; },
    code: async (address) => {
      await wait();
      const normalized = address.toLowerCase();
      if (normalized === factoryAddress.toLowerCase()) return change.factoryCode ?? factoryCode;
      if (normalized === routerAddress.toLowerCase()) return change.routerCode ?? routerCode;
      if (normalized === poolAddress.toLowerCase()) return change.poolCode ?? "0x6003";
      if (normalized === ambrAddress.toLowerCase()) return change.ambrCode ?? tokenCode;
      if (normalized === jadeAddress.toLowerCase()) return change.jadeCode ?? tokenCode;
      if (change.eoaDelay) await change.eoaDelay;
      return change.eoaCode ?? "0x";
    },
    deploymentReceipt: async (txHash) => {
      await wait();
      if (txHash === factoryTx) return {
        status: change.factoryReceiptStatus ?? "success",
        contractAddress: change.factoryReceiptAddress ?? factoryAddress,
        blockNumber: change.factoryReceiptBlock ?? 100
      };
      return {
        status: change.routerReceiptStatus ?? "success",
        contractAddress: change.routerReceiptAddress ?? routerAddress,
        blockNumber: change.routerReceiptBlock ?? 101
      };
    },
    poolFor: async () => { await wait(); return change.poolFor ?? poolAddress; },
    poolFactory: async () => { await wait(); return change.poolFactory ?? factoryAddress; },
    poolTokens: async () => {
      await wait();
      return change.poolTokens ?? { token0: ambrAddress, token1: jadeAddress };
    },
    tokenMetadata: async (address) => {
      await wait();
      return address.toLowerCase() === ambrAddress.toLowerCase()
        ? change.ambrMetadata ?? { name: "Demo Amber", symbol: "AMBR", decimals: 18 }
        : change.jadeMetadata ?? { name: "Demo Jade", symbol: "JADE", decimals: 18 };
    }
  };
}

function pinFor(input: unknown): V01ProfilePin {
  const profile = parseV01Profile(input, NOW);
  // This derives a fixture pin for deterministic tests; production pins are reviewed separately.
  return {
    releaseId: profile.deployment.releaseId,
    bundleSha256: profile.deployment.source.bundleSha256,
    profileFingerprint: v01ProfileFingerprint(profile, NOW)
  };
}

async function verified(changes: ReaderChange[] = []): Promise<VerifiedV01Profile> {
  const input = manifest();
  return verifyV01Profile(input, pinFor(input), changes.length ? changes.map((change, index) => reader(`rpc-${index}`, change)) : [reader("rpc-a"), reader("rpc-b")], { now: () => NOW });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("RealDEX v0.1 reviewed profile", () => {
  it("verifies the reviewed profile and creates both token directions", async () => {
    const result = await verified();
    expect(result.status).toBe("verified-profile");
    expect(result.profile.tokens).toEqual({ ambr: ambrAddress, jade: jadeAddress });
    expect(result.routes).toHaveLength(2);
    expect(result.routes.map((route) => [route.sourceAsset, route.destinationAsset])).toEqual([
      [`eip155:${V01_CHAIN_ID}/erc20:${ambrAddress}`, `eip155:${V01_CHAIN_ID}/erc20:${jadeAddress}`],
      [`eip155:${V01_CHAIN_ID}/erc20:${jadeAddress}`, `eip155:${V01_CHAIN_ID}/erc20:${ambrAddress}`]
    ]);
    expect(result.routes.every((route) => route.sourceExecutionTarget === poolAddress && route.maximumQuoteTtlMs === V01_PROFILE_TTL_MS)).toBe(true);
    expect(() => assertCurrentV01Profile(result, NOW)).not.toThrow();
  });

  it("requires a reviewed pin and rejects release, source, or fingerprint mismatches", async () => {
    const input = manifest();
    const noCallReader = reader("a");
    const noCallSpy = vi.spyOn(noCallReader, "chainId");
    await expect(verifyV01Profile(input, null, [noCallReader, reader("b")], { now: () => NOW })).rejects.toThrow("V01_REVIEWED_PROFILE_REQUIRED");
    expect(noCallSpy).not.toHaveBeenCalled();
    const goodPin = pinFor(input);
    const expectNoRpc = async (candidate: unknown, pin: V01ProfilePin) => {
      const first = reader("a");
      const second = reader("b");
      const chainSpy = vi.spyOn(first, "chainId");
      const codeSpy = vi.spyOn(first, "code");
      await expect(verifyV01Profile(candidate, pin, [first, second], { now: () => NOW })).rejects.toThrow("V01_REVIEWED_PROFILE_MISMATCH");
      expect(chainSpy).not.toHaveBeenCalled();
      expect(codeSpy).not.toHaveBeenCalled();
    };
    await expectNoRpc(input, { ...goodPin, releaseId: "another-release" });
    await expectNoRpc(input, { ...goodPin, bundleSha256: `sha256:${"d".repeat(64)}` });
    await expectNoRpc(input, { ...goodPin, profileFingerprint: `0x${"e".repeat(64)}` });
    const changedAddress = { ...input, pool: { ...input.pool, address: "0x8888888888888888888888888888888888888888" } };
    await expectNoRpc(changedAddress, goodPin);
    const changedSource = manifest({ source: { ...input.deployment.source, bundleSha256: `sha256:${"d".repeat(64)}` } });
    await expect(verifyV01Profile(changedSource, goodPin, [reader("a"), reader("b")], { now: () => NOW })).rejects.toThrow("V01_REVIEWED_PROFILE_MISMATCH");
  });

  it("fails closed on wrong chain, factory/router receipt, and runtime observations", async () => {
    await expect(verified([{ chainId: 84531n }, {}])).rejects.toThrow("DEPLOYMENT_RPC_CHAIN_MISMATCH");
    await expect(verified([{ factoryReceiptAddress: routerAddress }, {}])).rejects.toThrow("DEPLOYMENT_RECEIPT_INVALID");
    await expect(verified([{ routerReceiptStatus: "failed" }, {}])).rejects.toThrow("DEPLOYMENT_RECEIPT_INVALID");
    await expect(verified([{ factoryCode: "0x6004" }, {}])).rejects.toThrow("DEPLOYMENT_RUNTIME_CODE_MISMATCH");
    await expect(verified([{ routerCode: "0x6004" }, {}])).rejects.toThrow("DEPLOYMENT_RUNTIME_CODE_MISMATCH");
    await expect(verifyV01Profile(manifest(), pinFor(manifest()), [reader("same"), reader("same")], { now: () => NOW })).rejects.toThrow("DEPLOYMENT_RPC_QUORUM_INVALID");
  });

  it("rejects wrong pool origin, pair, pool hash, token code, and metadata", async () => {
    await expect(verified([{ poolFor: routerAddress }, {}])).rejects.toThrow("V01_POOL_ORIGIN_MISMATCH");
    await expect(verified([{ poolFactory: routerAddress }, {}])).rejects.toThrow("V01_POOL_ORIGIN_MISMATCH");
    await expect(verified([{ poolTokens: { token0: jadeAddress, token1: factoryAddress } }, {}])).rejects.toThrow("V01_POOL_PAIR_MISMATCH");
    await expect(verified([{ poolCode: "0x6004" }, {}])).rejects.toThrow("V01_POOL_CODE_MISMATCH");
    await expect(verified([{ ambrCode: "0x6004" }, {}])).rejects.toThrow("V01_TOKEN_CODE_MISMATCH");
    await expect(verified([{ jadeCode: "0x6004" }, {}])).rejects.toThrow("V01_TOKEN_CODE_MISMATCH");
    await expect(verified([{ ambrMetadata: { name: "Amber", symbol: "AMBR", decimals: 18 } }, {}])).rejects.toThrow("V01_TOKEN_METADATA_MISMATCH");
    await expect(verified([{ jadeMetadata: { name: "Demo Jade", symbol: "JADE", decimals: 6 } }, {}])).rejects.toThrow("V01_TOKEN_METADATA_MISMATCH");
  });

  it("rejects duplicate targets, unknown fields, accessors, cycles, and malformed shape", () => {
    const input = manifest();
    expect(() => parseV01Profile({ ...input, tokens: { ambr: poolAddress, jade: jadeAddress } }, NOW)).toThrow("V01_TARGETS_NOT_DISTINCT");
    expect(() => parseV01Profile({ ...input, extra: true }, NOW)).toThrow("V01_PROFILE_SHAPE_INVALID");
    expect(() => parseV01Profile({ ...input, pool: { ...input.pool, extra: true } }, NOW)).toThrow("V01_PROFILE_SHAPE_INVALID");
    const accessor = { ...input } as Record<string, unknown>;
    Object.defineProperty(accessor, "schema", { enumerable: true, get: () => input.schema });
    expect(() => parseV01Profile(accessor, NOW)).toThrow("V01_PROFILE_SHAPE_INVALID");
    const cycle = { ...input, pool: { ...input.pool } } as Record<string, unknown>;
    (cycle.pool as Record<string, unknown>).cycle = cycle;
    expect(() => parseV01Profile(cycle, NOW)).toThrow("V01_PROFILE_SHAPE_INVALID");
    expect(() => parseV01Profile({ ...input, tokens: [ambrAddress, jadeAddress] }, NOW)).toThrow("V01_PROFILE_SHAPE_INVALID");
  });

  it("snapshots caller input and reader methods before asynchronous observations", async () => {
    const gate = deferred<void>();
    const input = manifest();
    const pin = pinFor(input);
    const originalReader = reader("rpc-a", { delay: gate.promise });
    const secondReader = reader("rpc-b", { delay: gate.promise });
    const readers = [originalReader, secondReader];
    const pending = verifyV01Profile(input, pin, readers, { now: () => NOW });
    input.pool.address = routerAddress;
    readers.push(reader("rpc-c"));
    (originalReader as unknown as Record<string, unknown>).chainId = async () => { throw new Error("caller mutation leaked"); };
    gate.resolve();
    const result = await pending;
    expect(result.profile.pool.address).toBe(poolAddress);
    expect(result.readerIds).toEqual(["rpc-a", "rpc-b"]);
  });

  it("rejects an isCurrent context change after observation and expiry during IO", async () => {
    let currentCalls = 0;
    await expect(verifyV01Profile(manifest(), pinFor(manifest()), [reader("a"), reader("b")], {
      now: () => NOW,
      isCurrent: () => ++currentCalls < 2
    })).rejects.toThrow("V01_PROFILE_CONTEXT_CHANGED");
    const times = [NOW, NOW + V01_PROFILE_TTL_MS];
    let index = 0;
    await expect(verifyV01Profile(manifest(), pinFor(manifest()), [reader("a"), reader("b")], { now: () => times[index++] ?? times[1] })).rejects.toThrow("V01_PROFILE_VERIFICATION_EXPIRED");
  });

  it("freezes verified results, rejects copies, and supports explicit invalidation", async () => {
    const result = await verified();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.profile)).toBe(true);
    expect(Object.isFrozen(result.profile.deployment.contracts.factory)).toBe(true);
    expect(Object.isFrozen(result.routes[0])).toBe(true);
    expect(() => { (result.profile.tokens as { ambr: string }).ambr = eoaAddress; }).toThrow();
    const copy = { ...result, profile: result.profile } as VerifiedV01Profile;
    expect(() => assertCurrentV01Profile(copy, NOW)).toThrow("V01_VERIFIED_PROFILE_REQUIRED");
    expect(() => assertCurrentV01Profile(result, NOW + V01_PROFILE_TTL_MS)).toThrow("V01_PROFILE_EXPIRED");
    expect(() => assertCurrentV01Profile(result, 0)).toThrow("V01_TIME_INVALID");
    invalidateV01Profile(result);
    expect(() => assertCurrentV01Profile(result, NOW)).toThrow("V01_VERIFIED_PROFILE_REQUIRED");
    expect(() => assertV01Route(result, result.routes[0], NOW)).toThrow("V01_VERIFIED_PROFILE_REQUIRED");
  });

  it("accepts only the exact reviewed routes and rejects arbitrary chain, asset, pool, multihop, and unsupported wallet descriptors", async () => {
    const result = await verified();
    const allowed = result.routes[0];
    expect(() => assertV01Route(result, allowed, NOW)).not.toThrow();
    const cases: Array<[string, Partial<typeof allowed>]> = [
      ["chain", { sourceAsset: allowed.sourceAsset.replace("eip155:84532", "eip155:1") }],
      ["asset", { destinationAsset: allowed.destinationAsset.replace(jadeAddress, eoaAddress) }],
      ["pool", { sourceExecutionTarget: routerAddress }],
      ["multihop", { destinationAsset: "eip155:84532/erc20:0x8888888888888888888888888888888888888888" }],
      ["adapter", { adapterId: "another-adapter" }],
      ["wallet", { walletCapabilityIds: ["unsupported-wallet"] }]
    ];
    for (const [, changes] of cases) {
      expect(() => assertV01Route(result, { ...allowed, ...changes }, NOW)).toThrow("V01_ROUTE_OUT_OF_SCOPE");
    }
  });

  it("rejects delegation and malformed bytecode as non-ordinary EOAs", async () => {
    const delegation = await verified([{ eoaCode: "0xef01000000000000000000000000000000000000000001" }, {}]);
    await expect(verifyV01Eoa(delegation, eoaAddress, { now: () => NOW })).rejects.toThrow("V01_ACCOUNT_NOT_ORDINARY_EOA");
    const malformed = await verified([{ eoaCode: "0x0" }, {}]);
    await expect(verifyV01Eoa(malformed, eoaAddress, { now: () => NOW })).rejects.toThrow("V01_ACCOUNT_NOT_ORDINARY_EOA");
    const ordinary = await verified();
    await expect(verifyV01Eoa(ordinary, eoaAddress, { now: () => NOW })).resolves.toBeUndefined();
    const wrongSymbol = verified([{ jadeMetadata: { name: "Demo Jade", symbol: "JDE", decimals: 18 } }, {}]);
    await expect(wrongSymbol).rejects.toThrow("V01_TOKEN_METADATA_MISMATCH");
  });

  it("invalidates EOA verification when the profile is invalidated or the network changes across await", async () => {
    const gate = deferred<void>();
    const gatedReaders = [reader("rpc-a", { eoaDelay: gate.promise }), reader("rpc-b", { eoaDelay: gate.promise })];
    const gated = await verifyV01Profile(manifest(), pinFor(manifest()), gatedReaders, { now: () => NOW });
    const eoa = verifyV01Eoa(gated, eoaAddress, { now: () => NOW });
    invalidateV01Profile(gated);
    gate.resolve();
    await expect(eoa).rejects.toThrow("V01_VERIFIED_PROFILE_REQUIRED");

    const networkGate = deferred<void>();
    const networkReaders = [reader("rpc-a", { chainIdGate: networkGate.promise, chainIdAfter: 84531n }), reader("rpc-b", { chainIdGate: networkGate.promise, chainIdAfter: 84531n })];
    const networkProfile = await verifyV01Profile(manifest(), pinFor(manifest()), networkReaders, { now: () => NOW });
    const networkCheck = verifyV01Eoa(networkProfile, eoaAddress, { now: () => NOW });
    networkGate.resolve();
    await expect(networkCheck).rejects.toThrow("DEPLOYMENT_RPC_CHAIN_MISMATCH");
  });

  it("rejects EOA verification when isCurrent changes after await", async () => {
    const result = await verified();
    let calls = 0;
    await expect(verifyV01Eoa(result, eoaAddress, { now: () => NOW, isCurrent: () => ++calls < 2 })).rejects.toThrow("V01_WALLET_CONTEXT_CHANGED");
  });

  it("rejects a reviewed pin changed while deployment verification is pending", async () => {
    const gate = deferred<void>();
    const input = manifest();
    const pin = pinFor(input);
    const pending = verifyV01Profile(input, pin, [reader("a", { delay: gate.promise }), reader("b", { delay: gate.promise })], { now: () => NOW });
    pin.profileFingerprint = `0x${"f".repeat(64)}`;
    gate.resolve();
    await expect(pending).rejects.toThrow("V01_PROFILE_CONTEXT_CHANGED");
  });

  it("rechecks the EOA reader chain after account-code observation", async () => {
    const input = manifest();
    let chainCalls = 0;
    const switching = reader("switching");
    switching.chainId = async () => ++chainCalls >= 4 ? 8453n : V01_CHAIN_ID;
    const result = await verifyV01Profile(input, pinFor(input), [switching, reader("stable")], { now: () => NOW });
    await expect(verifyV01Eoa(result, eoaAddress, { now: () => NOW })).rejects.toThrow("DEPLOYMENT_RPC_CHAIN_MISMATCH");
    expect(chainCalls).toBe(4);
  });
});
