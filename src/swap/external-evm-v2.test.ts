import { keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import {
  assertExternalEvmV2Calldata, quoteExternalEvmV2ExactIn, revalidateExternalEvmV2QuoteForExecution,
  validateExternalEvmV2VenueIdentity, verifyExternalEvmV2Venue,
  type ExternalEvmV2ReadClient, type ExternalEvmV2VenueIdentity
} from "./external-evm-v2";

const tokenA = "0x1111111111111111111111111111111111111111";
const tokenB = "0x2222222222222222222222222222222222222222";
const tokenC = "0x3333333333333333333333333333333333333333";
const router = "0x4444444444444444444444444444444444444444";
const factory = "0x5555555555555555555555555555555555555555";
const pairAB = "0x6666666666666666666666666666666666666666";
const pairBC = "0x7777777777777777777777777777777777777777";
const routerCode = "0x6000";
const factoryCode = "0x6001";
const pairCode = "0x6002";

function identity(): ExternalEvmV2VenueIdentity {
  return {
    schema: "realdex.external-evm-v2-venue.v1", venueId: "official-v2-compatible-test", chainId: 84532n,
    router: { address: router, runtimeCodeHash: keccak256(routerCode) },
    factory: { address: factory, runtimeCodeHash: keccak256(factoryCode) },
    path: [tokenA, tokenB, tokenC],
    pairs: [
      { address: pairAB, runtimeCodeHash: keccak256(pairCode), token0: tokenA, token1: tokenB },
      { address: pairBC, runtimeCodeHash: keccak256(pairCode), token0: tokenB, token1: tokenC }
    ], feeBps: 30,
    evidenceUrls: ["https://github.com/Uniswap/v2-periphery", "https://github.com/Uniswap/v2-core"]
  };
}

function client(change: Partial<{
  chainId: bigint; routerCode: string; factoryCode: string; pairCode: string; routerFactory: string;
  factoryPair: string; pairFactory: string; pairToken0: string; quoteDelta: bigint;
}> = {}): ExternalEvmV2ReadClient {
  return {
    chainId: async () => change.chainId ?? 84532n,
    code: async (address) => address === router ? change.routerCode ?? routerCode : address === factory ? change.factoryCode ?? factoryCode : change.pairCode ?? pairCode,
    routerFactory: async () => change.routerFactory ?? factory,
    factoryPair: async (_factory, a) => change.factoryPair ?? (a === tokenA ? pairAB : pairBC),
    pairFactory: async () => change.pairFactory ?? factory,
    pairTokens: async (pair) => pair === pairAB ? [change.pairToken0 ?? tokenA, tokenB] : [tokenB, tokenC],
    pairReserves: async (pair) => pair === pairAB ? [1_000_000n, 2_000_000n] : [2_000_000n, 1_000_000n],
    routerAmountsOut: async (_router, amountIn) => {
      const first = output(amountIn, 1_000_000n, 2_000_000n);
      const second = output(first, 2_000_000n, 1_000_000n) + (change.quoteDelta ?? 0n);
      return [amountIn, first, second];
    }
  };
}

describe("external EVM V2 exact-input safety boundary", () => {
  it("verifies exact chain, Router and Factory code, pair code, origin, and token path", async () => {
    const verified = await verifyExternalEvmV2Venue(identity(), client());
    expect(verified).toMatchObject({ status: "verified", identity: { chainId: 84532n, path: [tokenA, tokenB, tokenC] } });
    expect(verified.observedCodeHashes.pairs).toEqual([keccak256(pairCode), keccak256(pairCode)]);
  });

  it("rejects code, Router factory, Factory pair, pair origin, and pair-token substitutions", async () => {
    await expect(verifyExternalEvmV2Venue(identity(), client({ routerCode: "0x6009" }))).rejects.toThrow("EXTERNAL_V2_ROUTER_CODE_MISMATCH");
    await expect(verifyExternalEvmV2Venue(identity(), client({ routerFactory: tokenA }))).rejects.toThrow("EXTERNAL_V2_ROUTER_FACTORY_MISMATCH");
    await expect(verifyExternalEvmV2Venue(identity(), client({ factoryPair: tokenA }))).rejects.toThrow("EXTERNAL_V2_FACTORY_PAIR_MISMATCH");
    await expect(verifyExternalEvmV2Venue(identity(), client({ pairFactory: tokenA }))).rejects.toThrow("EXTERNAL_V2_PAIR_FACTORY_MISMATCH");
    await expect(verifyExternalEvmV2Venue(identity(), client({ pairToken0: tokenC }))).rejects.toThrow("EXTERNAL_V2_PAIR_TOKENS_MISMATCH");
  });

  it("recomputes every hop from reserves and binds exact-input calldata", async () => {
    const verified = await verifyExternalEvmV2Venue(identity(), client());
    const quote = await quoteExternalEvmV2ExactIn(verified, 10_000n, 50, tokenA, client(), 1_800_000_000_000);
    const first = output(10_000n, 1_000_000n, 2_000_000n);
    const second = output(first, 2_000_000n, 1_000_000n);
    expect(quote.amounts).toEqual([10_000n, first, second]);
    expect(quote.minimumOut).toBe((second * 9_950n) / 10_000n);
    expect(quote.deadline).toBe(1_800_000_300);
    expect(quote.calldata.startsWith("0x38ed1739")).toBe(true);
    expect(() => assertExternalEvmV2Calldata(verified, quote)).not.toThrow();
  });

  it("rejects a Router quote that diverges from independently observed reserves", async () => {
    const verified = await verifyExternalEvmV2Venue(identity(), client());
    await expect(quoteExternalEvmV2ExactIn(verified, 10_000n, 50, tokenA, client({ quoteDelta: 1n }))).rejects.toThrow("EXTERNAL_V2_ROUTER_QUOTE_DIVERGED");
  });

  it("rejects tampered calldata, changed venue code, and expired quotes before execution", async () => {
    const venueIdentity = identity();
    const verified = await verifyExternalEvmV2Venue(venueIdentity, client());
    const quote = await quoteExternalEvmV2ExactIn(verified, 10_000n, 50, tokenA, client(), 1_800_000_000_000);
    expect(() => assertExternalEvmV2Calldata(verified, { ...quote, minimumOut: quote.minimumOut - 1n })).toThrow("EXTERNAL_V2_CALLDATA_MISMATCH");
    expect(() => assertExternalEvmV2Calldata(verified, { ...quote, amounts: [...quote.amounts.slice(0, -1), quote.amounts.at(-1)! + 1n] })).toThrow("EXTERNAL_V2_QUOTE_ID_MISMATCH");
    await expect(revalidateExternalEvmV2QuoteForExecution(venueIdentity, quote, client({ pairCode: "0x6009" }), 1_800_000_001_000)).rejects.toThrow("EXTERNAL_V2_PAIR_CODE_MISMATCH");
    await expect(revalidateExternalEvmV2QuoteForExecution(venueIdentity, quote, client(), 1_800_000_301_000)).rejects.toThrow("EXTERNAL_V2_QUOTE_EXPIRED");
  });

  it("invalidates a verified object if its identity is mutated after verification", async () => {
    const verified = await verifyExternalEvmV2Venue(identity(), client());
    verified.identity.path[1] = tokenC;
    await expect(quoteExternalEvmV2ExactIn(verified, 10_000n, 50, tokenA, client())).rejects.toThrow();
  });

  it("fails closed on cycles, unsupported fees, and path/pair identity mismatches", () => {
    expect(() => validateExternalEvmV2VenueIdentity({ ...identity(), path: [tokenA, tokenB, tokenA] })).toThrow("EXTERNAL_V2_PATH_INVALID");
    expect(() => validateExternalEvmV2VenueIdentity({ ...identity(), feeBps: 25 as 30 })).toThrow("EXTERNAL_V2_IDENTITY_INVALID");
    const changed = identity(); changed.pairs[0] = { ...changed.pairs[0], token1: tokenC };
    expect(() => validateExternalEvmV2VenueIdentity(changed)).toThrow("EXTERNAL_V2_PAIR_PATH_MISMATCH");
  });
});

function output(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1_000n + withFee);
}
