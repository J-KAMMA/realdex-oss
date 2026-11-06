import { fromBech32 } from "@cosmjs/encoding";
import type { CosmosSwapMessageDecoder, CosmosVenueDescriptor, DecodedCosmosSwapMessage } from "./cosmos-swap-boundary";
import { canonicalProtoFields, canonicalProtoUtf8, scanCanonicalProtoFields } from "./canonical-protobuf";

export const OSMOSIS_EXACT_IN_MESSAGE_TYPE = "/osmosis.gamm.v1beta1.MsgSwapExactAmountIn";
export const OSMOSIS_EXACT_IN_DECODER_ID = "osmosis-gamm-exact-in-v1";
const MAX_POOL_ID = (1n << 64n) - 1n;

export type OsmosisExactInRouteDescriptor = {
  schema: "realdex.osmosis-exact-in-route.v1";
  venueId: string;
  revision: number;
  chainId: `cosmos:${string}`;
  bech32Prefix: string;
  sourceDenom: string;
  destinationDenom: string;
  hops: Array<{ poolId: string; tokenOutDenom: string }>;
  evidenceUrls: string[];
};

export function validateOsmosisExactInRouteDescriptor(value: unknown): OsmosisExactInRouteDescriptor {
  const keys = ["schema", "venueId", "revision", "chainId", "bech32Prefix", "sourceDenom", "destinationDenom", "hops", "evidenceUrls"] as const;
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.osmosis-exact-in-route.v1" || !bounded(value.venueId, 100) || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0 || typeof value.chainId !== "string" || !/^cosmos:[-_a-zA-Z0-9]{1,32}$/.test(value.chainId) || typeof value.bech32Prefix !== "string" || !/^[a-z][a-z0-9]{1,30}$/.test(value.bech32Prefix) || typeof value.sourceDenom !== "string" || typeof value.destinationDenom !== "string") fail("OSMOSIS_EXACT_IN_ROUTE_INVALID");
  assertDenom(value.sourceDenom); assertDenom(value.destinationDenom);
  if (value.sourceDenom === value.destinationDenom || !Array.isArray(value.hops) || value.hops.length < 1 || value.hops.length > 4) fail("OSMOSIS_EXACT_IN_ROUTE_INVALID");
  const pools = new Set<string>(), denoms = new Set<string>([value.sourceDenom]);
  const hops = value.hops.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ["poolId", "tokenOutDenom"]) || typeof item.tokenOutDenom !== "string") fail("OSMOSIS_EXACT_IN_ROUTE_INVALID");
    const poolId = positiveUint(item.poolId, "OSMOSIS_EXACT_IN_ROUTE_INVALID", 20);
    if (BigInt(poolId) > MAX_POOL_ID || pools.has(poolId)) fail("OSMOSIS_EXACT_IN_ROUTE_INVALID");
    assertDenom(item.tokenOutDenom);
    if (denoms.has(item.tokenOutDenom)) fail("OSMOSIS_EXACT_IN_ROUTE_INVALID");
    pools.add(poolId); denoms.add(item.tokenOutDenom);
    return { poolId, tokenOutDenom: item.tokenOutDenom };
  });
  if (hops.at(-1)!.tokenOutDenom !== value.destinationDenom || osmosisExecutionTarget({ hops }).length > 256) fail("OSMOSIS_EXACT_IN_ROUTE_INVALID");
  if (!Array.isArray(value.evidenceUrls) || value.evidenceUrls.length < 2 || value.evidenceUrls.length > 8 || value.evidenceUrls.some((url) => typeof url !== "string" || !isHttps(url)) || new Set(value.evidenceUrls).size !== value.evidenceUrls.length) fail("OSMOSIS_EXACT_IN_ROUTE_INVALID");
  return {
    schema: value.schema,
    venueId: value.venueId,
    revision: Number(value.revision),
    chainId: value.chainId as `cosmos:${string}`,
    bech32Prefix: value.bech32Prefix,
    sourceDenom: value.sourceDenom,
    destinationDenom: value.destinationDenom,
    hops,
    evidenceUrls: [...value.evidenceUrls] as string[]
  };
}

export function osmosisExecutionTarget(route: Pick<OsmosisExactInRouteDescriptor, "hops">): string {
  return `osmosis:gamm:${route.hops.map((hop) => hop.poolId).join(">")}`;
}

export function createOsmosisExactInVenue(route: OsmosisExactInRouteDescriptor): CosmosVenueDescriptor {
  assertRouteDescriptor(route);
  return {
    schema: "realdex.cosmos-venue.v1",
    venueId: route.venueId,
    revision: route.revision,
    chainId: route.chainId,
    bech32Prefix: route.bech32Prefix,
    messageTypeUrl: OSMOSIS_EXACT_IN_MESSAGE_TYPE,
    executionTarget: osmosisExecutionTarget(route),
    publicKeyTypeUrl: "/cosmos.crypto.secp256k1.PubKey",
    evidenceUrls: [...route.evidenceUrls]
  };
}

export function createOsmosisExactInDecoder(route: OsmosisExactInRouteDescriptor): CosmosSwapMessageDecoder {
  assertRouteDescriptor(route);
  const executionTarget = osmosisExecutionTarget(route);
  return (messageValue) => {
    if (!(messageValue instanceof Uint8Array) || messageValue.length === 0 || messageValue.length > 10_000) fail();
    const fields = scanCanonicalProtoFields(messageValue, "OSMOSIS_EXACT_IN_MESSAGE_INVALID");
    if (fields.length !== route.hops.length + 3 || fields[0]?.number !== 1 || fields[0].wireType !== 2) fail();
    if (fields.at(-2)?.number !== 3 || fields.at(-2)?.wireType !== 2 || fields.at(-1)?.number !== 4 || fields.at(-1)?.wireType !== 2) fail();
    const routeFields = fields.slice(1, -2);
    if (routeFields.length !== route.hops.length || routeFields.some((field) => field.number !== 2 || field.wireType !== 2)) fail();

    const sender = text(fields[0].bytes!);
    assertAddress(sender, route.bech32Prefix);
    const decodedHops = routeFields.map((field) => decodeHop(field.bytes!));
    const tokenIn = decodeCoin(fields.at(-2)!.bytes!);
    const minimumOut = positiveUint(text(fields.at(-1)!.bytes!));

    if (tokenIn.denom !== route.sourceDenom) fail();
    if (decodedHops.some((hop, index) => hop.poolId !== route.hops[index].poolId || hop.tokenOutDenom !== route.hops[index].tokenOutDenom)) fail();

    const outputDenoms = decodedHops.map((hop) => hop.tokenOutDenom);
    if (outputDenoms.at(-1) !== route.destinationDenom || new Set([tokenIn.denom, ...outputDenoms]).size !== outputDenoms.length + 1) fail();
    if (new Set(decodedHops.map((hop) => hop.poolId)).size !== decodedHops.length) fail();

    return {
      authority: sender,
      recipient: sender,
      executionTarget,
      sourceDenom: tokenIn.denom,
      destinationDenom: outputDenoms.at(-1)!,
      amountInBaseUnits: tokenIn.amount,
      minimumOutBaseUnits: minimumOut
    } satisfies DecodedCosmosSwapMessage;
  };
}

function decodeHop(bytes: Uint8Array): { poolId: string; tokenOutDenom: string } {
  const fields = canonicalProtoFields(bytes, { 1: [0, 1], 2: [2, 1] }, "OSMOSIS_EXACT_IN_MESSAGE_INVALID");
  const poolId = fields.get(1)![0].integer!;
  if (poolId <= 0n || poolId > MAX_POOL_ID) fail();
  const tokenOutDenom = text(fields.get(2)![0].bytes!);
  assertDenom(tokenOutDenom, "OSMOSIS_EXACT_IN_MESSAGE_INVALID");
  return { poolId: poolId.toString(), tokenOutDenom };
}

function decodeCoin(bytes: Uint8Array): { denom: string; amount: string } {
  const fields = canonicalProtoFields(bytes, { 1: [2, 1], 2: [2, 1] }, "OSMOSIS_EXACT_IN_MESSAGE_INVALID");
  const denom = text(fields.get(1)![0].bytes!);
  assertDenom(denom, "OSMOSIS_EXACT_IN_MESSAGE_INVALID");
  return { denom, amount: positiveUint(text(fields.get(2)![0].bytes!)) };
}

function assertRouteDescriptor(route: OsmosisExactInRouteDescriptor): void {
  validateOsmosisExactInRouteDescriptor(route);
}

function assertAddress(value: string, prefix: string): void {
  try { const decoded = fromBech32(value); if (decoded.prefix !== prefix || decoded.data.length !== 20) throw new Error(); }
  catch { fail(); }
}
function assertDenom(value: string, error = "OSMOSIS_EXACT_IN_ROUTE_INVALID"): void { if (!/^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/.test(value)) fail(error); }
function positiveUint(value: unknown, error = "OSMOSIS_EXACT_IN_MESSAGE_INVALID", maxDigits = 78): string { if (typeof value !== "string" || value.length > maxDigits || !/^[1-9]\d*$/.test(value)) fail(error); return value; }
function text(value: Uint8Array): string { return canonicalProtoUtf8(value, "OSMOSIS_EXACT_IN_MESSAGE_INVALID"); }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function isHttps(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && value.length <= 2_048; } catch { return false; } }
function fail(message = "OSMOSIS_EXACT_IN_MESSAGE_INVALID"): never { throw new Error(message); }
