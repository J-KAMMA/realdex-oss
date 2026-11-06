import { ZeroAddress, getAddress, keccak256 } from "ethers";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { routeDescriptorFingerprint } from "../routing/engine";
import type { RouteDescriptor } from "../routing/types";
import { createLocalAmmRouteDescriptor } from "../swap/evm-local-amm";
import codeIdentities from "../swap/local-amm-code-identities.json";
import { validatePublicTestnetDeploymentManifest, verifyPublicTestnetDeployment, type EvmDeploymentReader, type EvmPublicTestnetDeploymentManifest } from "./evm-public-testnet";

export const V01_CHAIN_ID = 84532n;
export const V01_PROFILE_TTL_MS = 60_000;
export type V01Profile = {
  schema: "realdex.v01-profile.v1";
  deployment: EvmPublicTestnetDeploymentManifest;
  pool: { address: string; runtimeCodeHash: string; feeBasisPoints: number };
  tokens: { ambr: string; jade: string };
};

/** A reviewed build pin, never derived from the same untrusted import being checked. */
export type V01ProfilePin = {
  releaseId: string;
  bundleSha256: string;
  profileFingerprint: string;
};

export type V01ProfileReader = EvmDeploymentReader & {
  poolFor(factory: string, tokenA: string, tokenB: string, feeBasisPoints: number): Promise<string>;
  poolFee(pool: string): Promise<number>;
  poolFactory(pool: string): Promise<string>;
  poolTokens(pool: string): Promise<{ token0: string; token1: string }>;
  tokenMetadata(token: string): Promise<{ name: string; symbol: string; decimals: number }>;
};

export type VerifiedV01Profile = {
  status: "verified-profile";
  profile: V01Profile;
  fingerprint: string;
  verifiedAt: number;
  expiresAt: number;
  readerIds: string[];
  routes: RouteDescriptor[];
};

const accepted = new WeakMap<VerifiedV01Profile, readonly V01ProfileReader[]>();
const HASH = /^0x[0-9a-f]{64}$/;

export function parseV01Profile(input: unknown, now = Date.now()): V01Profile {
  // Reject accessors, cycles and non-JSON objects before calling existing parsers.
  const root = exactObject(copyJson(input), ["schema", "deployment", "pool", "tokens"]);
  if (root.schema !== "realdex.v01-profile.v1") throw new Error("V01_PROFILE_SCHEMA_INVALID");
  const deployment = validatePublicTestnetDeploymentManifest(root.deployment, now);
  const poolInput = exactObject(root.pool, ["address", "runtimeCodeHash", "feeBasisPoints"]);
  // Bounds mirror the pool's own constructor: a zero-fee pool cannot pay anyone.
  if (!Number.isSafeInteger(poolInput.feeBasisPoints) || Number(poolInput.feeBasisPoints) < 1 || Number(poolInput.feeBasisPoints) > 100) throw new Error("V01_POOL_FEE_INVALID");
  if (typeof poolInput.runtimeCodeHash !== "string" || !HASH.test(poolInput.runtimeCodeHash)) throw new Error("V01_POOL_CODE_HASH_INVALID");
  const tokensInput = exactObject(root.tokens, ["ambr", "jade"]);
  const pool = { address: address(poolInput.address), runtimeCodeHash: poolInput.runtimeCodeHash, feeBasisPoints: poolInput.feeBasisPoints as number };
  const tokens = { ambr: address(tokensInput.ambr), jade: address(tokensInput.jade) };
  if (new Set([pool.address, tokens.ambr, tokens.jade, deployment.contracts.factory.address, deployment.contracts.router.address]).size !== 5) throw new Error("V01_TARGETS_NOT_DISTINCT");
  return deepFreeze({ schema: "realdex.v01-profile.v1", deployment, pool, tokens });
}

/** Planning utility only. Generating a fingerprint does not approve a profile. */
export function v01ProfileFingerprint(input: unknown, now = Date.now()): string {
  return cryptographicFingerprint("realdex.v01-profile.v1", parseV01Profile(input, now));
}

/** Read-only verification. No connection, signing, minting or submission authority. */
export async function verifyV01Profile(
  input: unknown,
  pin: V01ProfilePin | null,
  readers: readonly V01ProfileReader[],
  options: { now?: () => number; isCurrent?: () => boolean } = {}
): Promise<VerifiedV01Profile> {
  const clock = options.now ?? Date.now;
  const startedAt = clock();
  assertTime(startedAt);
  if (!pin) throw new Error("V01_REVIEWED_PROFILE_REQUIRED");
  const profile = parseV01Profile(input, startedAt);
  const fingerprint = v01ProfileFingerprint(profile, startedAt);
  // Capture caller-owned pins/readers before asynchronous observations.
  const expected = { ...pin };
  if (profile.deployment.releaseId !== expected.releaseId || profile.deployment.source.bundleSha256 !== expected.bundleSha256 || fingerprint !== expected.profileFingerprint) throw new Error("V01_REVIEWED_PROFILE_MISMATCH");
  if (readers.length < 2 || readers.length > 4) throw new Error("DEPLOYMENT_RPC_QUORUM_INVALID");
  const selected = readers.map(reader => Object.freeze({
    id: reader.id,
    chainId: reader.chainId.bind(reader), blockNumber: reader.blockNumber.bind(reader),
    code: reader.code.bind(reader), deploymentReceipt: reader.deploymentReceipt.bind(reader),
    poolFor: reader.poolFor.bind(reader), poolFee: reader.poolFee.bind(reader), poolFactory: reader.poolFactory.bind(reader),
    poolTokens: reader.poolTokens.bind(reader), tokenMetadata: reader.tokenMetadata.bind(reader)
  }));
  if (options.isCurrent?.() === false) throw new Error("V01_PROFILE_CONTEXT_CHANGED");
  // Do not accept a caller-created {status: verified} receipt or skip the Router gate.
  await verifyPublicTestnetDeployment(profile.deployment, selected, startedAt);
  await Promise.all(selected.map(async reader => {
    const factory = profile.deployment.contracts.factory.address;
    const { ambr, jade } = profile.tokens;
    const [poolFor, poolFee, poolFactory, pair, poolCode, ambrCode, jadeCode, ambrMetadata, jadeMetadata] = await Promise.all([
      reader.poolFor(factory, ambr, jade, profile.pool.feeBasisPoints), reader.poolFee(profile.pool.address),
      reader.poolFactory(profile.pool.address), reader.poolTokens(profile.pool.address),
      reader.code(profile.pool.address), reader.code(ambr), reader.code(jade), reader.tokenMetadata(ambr), reader.tokenMetadata(jade)
    ]);
    if (address(poolFor) !== profile.pool.address || address(poolFactory) !== factory) throw new Error("V01_POOL_ORIGIN_MISMATCH");
    // The tier the pool reports must be the tier the profile names, or the screen
    // would describe a fee the pool does not charge.
    if (poolFee !== profile.pool.feeBasisPoints) throw new Error("V01_POOL_FEE_MISMATCH");
    const sorted = [ambr, jade].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    if (address(pair.token0) !== sorted[0] || address(pair.token1) !== sorted[1]) throw new Error("V01_POOL_PAIR_MISMATCH");
    if (runtimeHash(poolCode) !== profile.pool.runtimeCodeHash) throw new Error("V01_POOL_CODE_MISMATCH");
    if (runtimeHash(ambrCode) !== codeIdentities.mockErc20Decimals18RuntimeCodeHash || runtimeHash(jadeCode) !== codeIdentities.mockErc20Decimals18RuntimeCodeHash) throw new Error("V01_TOKEN_CODE_MISMATCH");
    if (ambrMetadata.name !== "Demo Amber" || ambrMetadata.symbol !== "AMBR" || ambrMetadata.decimals !== 18 || jadeMetadata.name !== "Demo Jade" || jadeMetadata.symbol !== "JADE" || jadeMetadata.decimals !== 18) throw new Error("V01_TOKEN_METADATA_MISMATCH");
    // An endpoint switching networks during the observations invalidates the result.
    if (await reader.chainId() !== V01_CHAIN_ID) throw new Error("DEPLOYMENT_RPC_CHAIN_MISMATCH");
  }));
  const finishedAt = clock();
  assertTime(finishedAt);
  if (finishedAt < startedAt || finishedAt >= startedAt + V01_PROFILE_TTL_MS) throw new Error("V01_PROFILE_VERIFICATION_EXPIRED");
  if (options.isCurrent?.() === false || pin.releaseId !== expected.releaseId || pin.bundleSha256 !== expected.bundleSha256 || pin.profileFingerprint !== expected.profileFingerprint) throw new Error("V01_PROFILE_CONTEXT_CHANGED");
  const routes = [[profile.tokens.ambr, profile.tokens.jade], [profile.tokens.jade, profile.tokens.ambr]].map(([tokenIn, tokenOut]) => ({
    ...createLocalAmmRouteDescriptor({ chainId: V01_CHAIN_ID, poolAddress: profile.pool.address, tokenIn, tokenOut, factoryAddress: profile.deployment.contracts.factory.address, venueId: "v01", venueLabel: "RealDEX v0.1 test tokens", evidenceUrls: profile.deployment.evidenceUrls }),
    walletCapabilityIds: ["eip1193"], maximumQuoteTtlMs: V01_PROFILE_TTL_MS
  }));
  const result = deepFreeze({ status: "verified-profile" as const, profile, fingerprint, verifiedAt: startedAt, expiresAt: startedAt + V01_PROFILE_TTL_MS, readerIds: selected.map(reader => reader.id), routes });
  accepted.set(result, selected);
  return result;
}

export function assertCurrentV01Profile(value: VerifiedV01Profile | undefined, now = Date.now()): asserts value is VerifiedV01Profile {
  assertTime(now);
  if (!value || !accepted.has(value)) throw new Error("V01_VERIFIED_PROFILE_REQUIRED");
  if (now < value.verifiedAt || now >= value.expiresAt) throw new Error("V01_PROFILE_EXPIRED");
}

/** Explicit invalidation is required on profile/endpoint selection changes. */
export function invalidateV01Profile(value: VerifiedV01Profile): void { accepted.delete(value); }

export function assertV01Route(value: VerifiedV01Profile | undefined, route: RouteDescriptor, now = Date.now()): void {
  assertCurrentV01Profile(value, now);
  if (!value.routes.some(allowed => routeDescriptorFingerprint(allowed) === routeDescriptorFingerprint(route))) throw new Error("V01_ROUTE_OUT_OF_SCOPE");
}

/** Read-only ordinary-EOA check. Does not prove the identity of a browser extension. */
export async function verifyV01Eoa(value: VerifiedV01Profile, account: string, options: { now?: () => number; isCurrent?: () => boolean } = {}): Promise<void> {
  const clock = options.now ?? Date.now;
  assertCurrentV01Profile(value, clock());
  if (options.isCurrent?.() === false) throw new Error("V01_WALLET_CONTEXT_CHANGED");
  const owner = address(account);
  await Promise.all(accepted.get(value)!.map(async reader => {
    const [chain, code] = await Promise.all([reader.chainId(), reader.code(owner)]);
    if (chain !== V01_CHAIN_ID) throw new Error("DEPLOYMENT_RPC_CHAIN_MISMATCH");
    if (code !== "0x") throw new Error("V01_ACCOUNT_NOT_ORDINARY_EOA");
    if (await reader.chainId() !== V01_CHAIN_ID) throw new Error("DEPLOYMENT_RPC_CHAIN_MISMATCH");
  }));
  assertCurrentV01Profile(value, clock());
  if (options.isCurrent?.() === false) throw new Error("V01_WALLET_CONTEXT_CHANGED");
}

function assertTime(now: number): void {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("V01_TIME_INVALID");
}
function address(value: unknown): string {
  try { if (typeof value !== "string") throw new Error(); const result = getAddress(value); if (result === ZeroAddress) throw new Error(); return result; }
  catch { throw new Error("V01_ADDRESS_INVALID"); }
}
function runtimeHash(value: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("V01_RUNTIME_CODE_MISSING");
  return keccak256(value);
}
function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error("V01_PROFILE_SHAPE_INVALID");
  return value as Record<string, unknown>;
}
function copyJson(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("V01_PROFILE_SHAPE_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error("V01_PROFILE_SHAPE_INVALID");
  const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  const keys = Reflect.ownKeys(value).filter(key => !(Array.isArray(value) && key === "length"));
  if (keys.length > 64) throw new Error("V01_PROFILE_SHAPE_INVALID");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || key === "__proto__" || !descriptor.enumerable || !("value" in descriptor)) throw new Error("V01_PROFILE_SHAPE_INVALID");
    Object.defineProperty(result, key, { value: copyJson(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
