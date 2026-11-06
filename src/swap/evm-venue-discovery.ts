import { Contract, JsonRpcProvider, ZeroAddress, getAddress, keccak256 } from "ethers";
import { FACTORY_ABI, POOL_ABI } from "../abi";
import type { RouteDescriptor } from "../routing/types";
import codeIdentities from "./local-amm-code-identities.json";
import { createLocalAmmRouteDescriptor } from "./evm-local-amm";

const MAX_VENUES = 32;
const MINIMUM_FEE_BASIS_POINTS = 1;
const MAXIMUM_FEE_BASIS_POINTS = 100;

/**
 * The pool contract bakes its fee in at construction and the factory keys pools
 * by it, so a pair can trade at several tiers at several addresses at once. That
 * is the whole mechanism by which the fee "changes" without anyone being able to
 * change it, so the tiers to look at have to be an input rather than a constant.
 */
export function parseFeeBasisPointTiers(value: string): number[] {
  const raw = value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
  if (!raw.length) return [MINIMUM_FEE_BASIS_POINTS];
  const tiers: number[] = [];
  for (const item of raw) {
    if (!/^\d{1,3}$/.test(item)) throw new Error("EVM_VENUE_FEE_INVALID");
    const tier = Number(item);
    // The pool rejects anything outside these bounds, so a tier outside them can
    // only ever resolve to a pool that does not exist. Refusing here says why.
    if (tier < MINIMUM_FEE_BASIS_POINTS || tier > MAXIMUM_FEE_BASIS_POINTS) throw new Error("EVM_VENUE_FEE_INVALID");
    if (!tiers.includes(tier)) tiers.push(tier);
  }
  return tiers;
}

export type EvmLocalAmmVenue = {
  id: string;
  label: string;
  chainId: bigint;
  factoryAddress: string;
  /** The tier this venue trades. A pair can have several, at separate addresses. */
  feeBasisPoints: number;
  factoryRuntimeCodeHash: string;
  revision: number;
  evidenceUrls: string[];
};

export type EvmVenueDiscoveryClient = {
  chainId(): Promise<bigint>;
  code(address: string): Promise<string>;
  poolFor(factory: string, tokenA: string, tokenB: string, feeBasisPoints: number): Promise<string>;
  poolFactory(pool: string): Promise<string>;
  poolTokens(pool: string): Promise<{ token0: string; token1: string }>;
};

export type EvmVenueDiscoveryResult = {
  routes: RouteDescriptor[];
  /**
   * The tier each route trades, by route id. The screen needs this to say why one
   * tier was chosen over another, and reading it back out of the route id would
   * make a display depend on the shape of an identifier.
   */
  feeBasisPointsByRouteId: Map<string, number>;
  rejected: Array<{ venueId: string; code: string; detail?: string }>;
};

export const BUNDLED_LOCAL_AMM_FACTORY_CODE_HASH = codeIdentities.factoryRuntimeCodeHash;

export function configuredLocalAmmVenues(chainId: bigint, primaryFactory: string, additionalFactories: string, feeTiers: string | readonly number[] = [MINIMUM_FEE_BASIS_POINTS]): EvmLocalAmmVenue[] {
  if (chainId <= 0n) throw new Error("EVM_VENUE_CHAIN_INVALID");
  const tiers = typeof feeTiers === "string" ? parseFeeBasisPointTiers(feeTiers) : [...feeTiers];
  if (!tiers.length) throw new Error("EVM_VENUE_FEE_INVALID");
  for (const tier of tiers) {
    if (!Number.isInteger(tier) || tier < MINIMUM_FEE_BASIS_POINTS || tier > MAXIMUM_FEE_BASIS_POINTS) throw new Error("EVM_VENUE_FEE_INVALID");
  }
  const raw = [primaryFactory, ...additionalFactories.split(/[\s,;]+/)].map((item) => item.trim()).filter(Boolean);
  if (raw.length * tiers.length > MAX_VENUES) throw new Error("EVM_VENUE_LIMIT_EXCEEDED");
  const unique = new Map<string, string>();
  for (const value of raw) {
    let normalized: string;
    try { normalized = getAddress(value); } catch { throw new Error("EVM_VENUE_FACTORY_INVALID"); }
    unique.set(normalized.toLowerCase(), normalized);
  }
  return [...unique.values()].flatMap((factoryAddress, index) => tiers.map((feeBasisPoints) => ({
    // The tier belongs in the id: two tiers on one factory are two pools at two
    // addresses, and an id that omitted the tier would collide and be rejected as
    // a duplicate factory. That collision is what made tiers unconfigurable.
    id: `local-amm-factory:${chainId}:${factoryAddress.toLowerCase()}:${feeBasisPoints}`,
    label: `${index === 0 ? "Primary RealDEX factory" : `RealDEX venue ${index + 1}`} ${formatFeeTier(feeBasisPoints)}`,
    chainId,
    factoryAddress,
    factoryRuntimeCodeHash: BUNDLED_LOCAL_AMM_FACTORY_CODE_HASH,
    feeBasisPoints,
    revision: 1,
    evidenceUrls: ["https://eips.ethereum.org/EIPS/eip-20"]
  })));
}

/** Basis points are unreadable on a screen; both forms are shown together. */
export function formatFeeTier(feeBasisPoints: number): string {
  return `${feeBasisPoints} bp (${(feeBasisPoints / 100).toFixed(2)}%)`;
}

export async function discoverLocalAmmVenues(
  venues: readonly EvmLocalAmmVenue[],
  tokenInValue: string,
  tokenOutValue: string,
  client: EvmVenueDiscoveryClient
): Promise<EvmVenueDiscoveryResult> {
  if (!venues.length) return { routes: [], feeBasisPointsByRouteId: new Map(), rejected: [] };
  if (venues.length > MAX_VENUES) throw new Error("EVM_VENUE_LIMIT_EXCEEDED");
  const tokenIn = getAddress(tokenInValue);
  const tokenOut = getAddress(tokenOutValue);
  if (tokenIn === tokenOut) throw new Error("EVM_VENUE_PAIR_INVALID");
  const activeChainId = await client.chainId();
  const routes: RouteDescriptor[] = [];
  const feeBasisPointsByRouteId = new Map<string, number>();
  const rejected: EvmVenueDiscoveryResult["rejected"] = [];
  const seenVenueIds = new Set<string>();
  const seenFactoryTiers = new Set<string>();
  const seenPools = new Set<string>();

  // Which venues are worth reading at all is decided first, in order, because it
  // needs no chain access: a malformed venue, or a second venue on the same
  // factory and tier, is rejected before anything is fetched. Doing this pass
  // separately is what lets the reads below run together without changing which
  // of two identical venues is the duplicate.
  const admitted: EvmLocalAmmVenue[] = [];
  const refusedEarly = new Map<EvmLocalAmmVenue, unknown>();
  for (const venue of venues) {
    try {
      assertVenue(venue);
      const factoryTier = `${venue.factoryAddress.toLowerCase()}:${venue.feeBasisPoints}`;
      if (seenVenueIds.has(venue.id) || seenFactoryTiers.has(factoryTier)) throw new Error("EVM_VENUE_DUPLICATE_FACTORY");
      seenVenueIds.add(venue.id); seenFactoryTiers.add(factoryTier);
      admitted.push(venue);
    } catch (reason) {
      refusedEarly.set(venue, reason);
    }
  }

  // The reads for one venue do not depend on any other venue, so they are issued
  // together. Sequentially this was one round trip after another: a browser tab
  // in the background clamps timers to one second, so a serial run costs about a
  // second per request however fast the chain answers.
  const readings = new Map<EvmLocalAmmVenue, { pool?: string; code?: string; factory?: string; pair?: { token0: string; token1: string }; reason?: unknown }>();
  await Promise.all(admitted.map(async (venue) => {
    try {
      await verifyLocalAmmFactory(venue, client, activeChainId);
      const pool = getAddress(await client.poolFor(venue.factoryAddress, tokenIn, tokenOut, venue.feeBasisPoints));
      if (pool === ZeroAddress) throw new Error("EVM_VENUE_POOL_NOT_FOUND");
      // A pool that a later fold rejects as a duplicate is read here anyway. It is
      // the same pool another venue already named, so with the caching client
      // those reads are answered from memory and cost no request.
      const [code, factory, pair] = await Promise.all([client.code(pool), client.poolFactory(pool), client.poolTokens(pool)]);
      readings.set(venue, { pool, code, factory, pair });
    } catch (reason) {
      readings.set(venue, { reason });
    }
  }));

  // Folded in the configured order. Which venue wins a shared pool, and which
  // reason the screen shows when nothing is executable, both depend on this order.
  for (const venue of venues) {
    try {
      if (refusedEarly.has(venue)) throw refusedEarly.get(venue);
      const reading = readings.get(venue)!;
      if (reading.reason) throw reading.reason;
      const pool = reading.pool!;
      if (seenPools.has(pool.toLowerCase())) throw new Error("EVM_VENUE_DUPLICATE_POOL");
      if (reading.code === "0x") throw new Error("EVM_VENUE_POOL_CODE_MISSING");
      if (getAddress(reading.factory!) !== venue.factoryAddress) throw new Error("EVM_VENUE_POOL_FACTORY_MISMATCH");
      const actual = new Set([getAddress(reading.pair!.token0).toLowerCase(), getAddress(reading.pair!.token1).toLowerCase()]);
      if (actual.size !== 2 || !actual.has(tokenIn.toLowerCase()) || !actual.has(tokenOut.toLowerCase())) throw new Error("EVM_VENUE_POOL_PAIR_MISMATCH");
      seenPools.add(pool.toLowerCase());
      const descriptor = createLocalAmmRouteDescriptor({
        chainId: venue.chainId, poolAddress: pool, tokenIn, tokenOut, revision: venue.revision,
        venueId: venue.id, venueLabel: venue.label, factoryAddress: venue.factoryAddress,
        evidenceUrls: venue.evidenceUrls
      });
      routes.push(descriptor);
      feeBasisPointsByRouteId.set(descriptor.id, venue.feeBasisPoints);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      rejected.push({ venueId: venue.id || "invalid-venue", code: /^[A-Z][A-Z0-9_]+$/.test(message) ? message : "EVM_VENUE_DISCOVERY_FAILED", detail: /^[A-Z][A-Z0-9_]+$/.test(message) ? undefined : message });
    }
  }
  return { routes, feeBasisPointsByRouteId, rejected };
}

export async function verifyLocalAmmFactory(venue: EvmLocalAmmVenue, client: EvmVenueDiscoveryClient, knownChainId?: bigint): Promise<void> {
  assertVenue(venue);
  const activeChainId = knownChainId ?? await client.chainId();
  if (venue.chainId !== activeChainId) throw new Error("EVM_VENUE_CHAIN_MISMATCH");
  const factoryCode = await client.code(venue.factoryAddress);
  if (!factoryCode || factoryCode === "0x" || keccak256(factoryCode) !== venue.factoryRuntimeCodeHash.toLowerCase()) throw new Error("EVM_VENUE_FACTORY_CODE_MISMATCH");
}

export function createBrowserEvmVenueDiscoveryClient(provider: JsonRpcProvider): EvmVenueDiscoveryClient {
  return {
    chainId: async () => (await provider.getNetwork()).chainId,
    code: (address) => provider.getCode(address),
    poolFor: (factory, tokenA, tokenB, feeBasisPoints) => new Contract(factory, FACTORY_ABI, provider).getPool(tokenA, tokenB, feeBasisPoints),
    poolFactory: (pool) => new Contract(pool, POOL_ABI, provider).factory(),
    poolTokens: async (pool) => {
      const contract = new Contract(pool, POOL_ABI, provider);
      const [token0, token1] = await Promise.all([contract.token0(), contract.token1()]);
      return { token0, token1 };
    }
  };
}

/**
 * A read-through cache over one discovery run.
 *
 * Discovery re-verifies every venue for every token pair, so a three-token graph
 * over three factories fetched the same runtime code eighteen times. Measured on a
 * seeded local chain: 33 eth_getCode for at most nine distinct contracts.
 *
 * Caching does not weaken any check — every venue is still verified against the
 * bundled code hash, and every pool still has to name its factory and its pair.
 * What is cached is only what cannot change: the chain a provider is pointed at,
 * and the runtime code, factory and token pair of an already-deployed contract.
 *
 * `poolFor` is cached per (factory, pair, tier), which makes one run a snapshot
 * rather than a moving picture: a pool created while the run is in flight is not
 * picked up until the next one. That is what a run already was — the code and
 * pairs above are read once too — and the alternative is asking the same question
 * up to four times per venue, because the direct pair is also an edge of the
 * multi-hop graph. Measured: 6 of 24 getPool calls were that one repeat.
 * The factory writes both token orders, so the key sorts the pair.
 *
 * A rejected read is dropped rather than remembered: a failed request says nothing
 * about the chain, and remembering it would turn one dropped packet into a verdict
 * for the rest of the run.
 */
export function createCachingEvmVenueDiscoveryClient(inner: EvmVenueDiscoveryClient): EvmVenueDiscoveryClient {
  let chainId: Promise<bigint> | undefined;
  const codes = new Map<string, Promise<string>>();
  const factories = new Map<string, Promise<string>>();
  const pairs = new Map<string, Promise<{ token0: string; token1: string }>>();
  const pools = new Map<string, Promise<string>>();
  const memo = <T>(store: Map<string, Promise<T>>, identity: string, read: () => Promise<T>): Promise<T> => {
    const key = identity.toLowerCase();
    const found = store.get(key);
    if (found) return found;
    const started = read().catch((reason) => { store.delete(key); throw reason; });
    store.set(key, started);
    return started;
  };
  return {
    chainId: () => (chainId ??= inner.chainId().catch((reason) => { chainId = undefined; throw reason; })),
    code: (address) => memo(codes, address, () => inner.code(address)),
    poolFor: (factory, tokenA, tokenB, feeBasisPoints) => {
      const pair = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
      return memo(pools, `${factory}|${pair[0]}|${pair[1]}|${feeBasisPoints}`, () => inner.poolFor(factory, tokenA, tokenB, feeBasisPoints));
    },
    poolFactory: (pool) => memo(factories, pool, () => inner.poolFactory(pool)),
    poolTokens: (pool) => memo(pairs, pool, () => inner.poolTokens(pool))
  };
}

function assertVenue(venue: EvmLocalAmmVenue) {
  if (!venue.id || !/^[a-z0-9][a-z0-9:._-]{2,160}$/.test(venue.id) || !venue.label.trim()) throw new Error("EVM_VENUE_IDENTITY_INVALID");
  if (venue.chainId <= 0n || !Number.isInteger(venue.revision) || venue.revision <= 0) throw new Error("EVM_VENUE_REVISION_INVALID");
  if (getAddress(venue.factoryAddress) !== venue.factoryAddress || !/^0x[0-9a-f]{64}$/.test(venue.factoryRuntimeCodeHash)) throw new Error("EVM_VENUE_FACTORY_INVALID");
  if (!Number.isInteger(venue.feeBasisPoints) || venue.feeBasisPoints < MINIMUM_FEE_BASIS_POINTS || venue.feeBasisPoints > MAXIMUM_FEE_BASIS_POINTS) throw new Error("EVM_VENUE_FEE_INVALID");
  if (!venue.evidenceUrls.length || venue.evidenceUrls.some((url) => { try { return new URL(url).protocol !== "https:"; } catch { return true; } })) throw new Error("EVM_VENUE_EVIDENCE_INVALID");
}
