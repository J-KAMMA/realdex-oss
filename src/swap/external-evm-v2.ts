import { Contract, Interface, JsonRpcProvider, getAddress, keccak256, toUtf8Bytes } from "ethers";

export const EXTERNAL_EVM_V2_ADAPTER_ID = "external-evm-v2-exact-in";
export const EXTERNAL_EVM_V2_METHOD = "swapExactTokensForTokens";

const ROUTER_INTERFACE = new Interface([
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)"
]);
const ROUTER_READ_ABI = ["function factory() view returns (address)", "function getAmountsOut(uint256,address[]) view returns (uint256[])"];
const FACTORY_READ_ABI = ["function getPair(address,address) view returns (address)"];
const PAIR_READ_ABI = ["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"];
const HASH = /^0x[0-9a-f]{64}$/;
const VENUE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export type ExternalEvmV2PairIdentity = {
  address: string;
  runtimeCodeHash: string;
  token0: string;
  token1: string;
};

export type ExternalEvmV2VenueIdentity = {
  schema: "realdex.external-evm-v2-venue.v1";
  venueId: string;
  chainId: bigint;
  router: { address: string; runtimeCodeHash: string };
  factory: { address: string; runtimeCodeHash: string };
  path: string[];
  pairs: ExternalEvmV2PairIdentity[];
  feeBps: 30;
  evidenceUrls: string[];
};

export type ExternalEvmV2ReadClient = {
  chainId(): Promise<bigint>;
  code(address: string): Promise<string>;
  routerFactory(router: string): Promise<string>;
  factoryPair(factory: string, tokenA: string, tokenB: string): Promise<string>;
  pairFactory(pair: string): Promise<string>;
  pairTokens(pair: string): Promise<readonly [string, string]>;
  pairReserves(pair: string): Promise<readonly [bigint, bigint]>;
  routerAmountsOut(router: string, amountIn: bigint, path: readonly string[]): Promise<readonly bigint[]>;
};

export type VerifiedExternalEvmV2Venue = {
  status: "verified";
  identity: ExternalEvmV2VenueIdentity;
  fingerprint: string;
  observedCodeHashes: { router: string; factory: string; pairs: string[] };
};

export type ExternalEvmV2Quote = {
  quoteId: string;
  venueFingerprint: string;
  amountIn: bigint;
  amounts: bigint[];
  minimumOut: bigint;
  recipient: string;
  deadline: number;
  calldata: string;
};

export function createBrowserExternalEvmV2ReadClient(provider: JsonRpcProvider): ExternalEvmV2ReadClient {
  return {
    chainId: async () => (await provider.getNetwork()).chainId,
    code: (address) => provider.getCode(address),
    routerFactory: async (router) => getAddress(await new Contract(router, ROUTER_READ_ABI, provider).factory()),
    factoryPair: async (factory, tokenA, tokenB) => getAddress(await new Contract(factory, FACTORY_READ_ABI, provider).getPair(tokenA, tokenB)),
    pairFactory: async (pair) => getAddress(await new Contract(pair, PAIR_READ_ABI, provider).factory()),
    pairTokens: async (pair) => {
      const contract = new Contract(pair, PAIR_READ_ABI, provider);
      const [token0, token1] = await Promise.all([contract.token0(), contract.token1()]);
      return [getAddress(token0), getAddress(token1)] as const;
    },
    pairReserves: async (pair) => {
      const reserves = await new Contract(pair, PAIR_READ_ABI, provider).getReserves();
      return [BigInt(reserves[0]), BigInt(reserves[1])] as const;
    },
    routerAmountsOut: async (router, amountIn, path) => {
      const amounts = await new Contract(router, ROUTER_READ_ABI, provider).getAmountsOut(amountIn, path);
      return [...amounts].map(BigInt);
    }
  };
}

export function validateExternalEvmV2VenueIdentity(input: ExternalEvmV2VenueIdentity): ExternalEvmV2VenueIdentity {
  if (!input || input.schema !== "realdex.external-evm-v2-venue.v1" || !VENUE_ID.test(input.venueId) || input.chainId <= 0n || input.feeBps !== 30) throw new Error("EXTERNAL_V2_IDENTITY_INVALID");
  const router = validateCodeIdentity(input.router, "EXTERNAL_V2_ROUTER_IDENTITY_INVALID");
  const factory = validateCodeIdentity(input.factory, "EXTERNAL_V2_FACTORY_IDENTITY_INVALID");
  if (router.address === factory.address) throw new Error("EXTERNAL_V2_IDENTITY_INVALID");
  if (!Array.isArray(input.path) || input.path.length < 2 || input.path.length > 4) throw new Error("EXTERNAL_V2_PATH_INVALID");
  const path = input.path.map((address) => normalizedAddress(address, "EXTERNAL_V2_PATH_INVALID"));
  if (new Set(path).size !== path.length) throw new Error("EXTERNAL_V2_PATH_INVALID");
  if (!Array.isArray(input.pairs) || input.pairs.length !== path.length - 1) throw new Error("EXTERNAL_V2_PAIR_SET_INVALID");
  const pairs = input.pairs.map((pair, index) => {
    const codeIdentity = validateCodeIdentity(pair, "EXTERNAL_V2_PAIR_IDENTITY_INVALID");
    const token0 = normalizedAddress(pair.token0, "EXTERNAL_V2_PAIR_IDENTITY_INVALID");
    const token1 = normalizedAddress(pair.token1, "EXTERNAL_V2_PAIR_IDENTITY_INVALID");
    if (token0.toLowerCase() >= token1.toLowerCase()) throw new Error("EXTERNAL_V2_PAIR_TOKEN_ORDER_INVALID");
    const expected = new Set([path[index].toLowerCase(), path[index + 1].toLowerCase()]);
    if (!expected.has(token0.toLowerCase()) || !expected.has(token1.toLowerCase())) throw new Error("EXTERNAL_V2_PAIR_PATH_MISMATCH");
    return { ...codeIdentity, token0, token1 };
  });
  if (new Set(pairs.map((pair) => pair.address)).size !== pairs.length) throw new Error("EXTERNAL_V2_PAIR_SET_INVALID");
  if (!Array.isArray(input.evidenceUrls) || input.evidenceUrls.length < 2 || input.evidenceUrls.length > 8 || input.evidenceUrls.some((url) => typeof url !== "string" || !isHttps(url)) || new Set(input.evidenceUrls).size !== input.evidenceUrls.length) throw new Error("EXTERNAL_V2_EVIDENCE_INVALID");
  return { ...input, router, factory, path, pairs, evidenceUrls: [...input.evidenceUrls] };
}

export async function verifyExternalEvmV2Venue(input: ExternalEvmV2VenueIdentity, client: ExternalEvmV2ReadClient): Promise<VerifiedExternalEvmV2Venue> {
  const identity = validateExternalEvmV2VenueIdentity(input);
  const [chainId, routerCode, factoryCode, routerFactory] = await Promise.all([
    client.chainId(), client.code(identity.router.address), client.code(identity.factory.address), client.routerFactory(identity.router.address)
  ]);
  if (chainId !== identity.chainId) throw new Error("EXTERNAL_V2_CHAIN_MISMATCH");
  const routerHash = runtimeHash(routerCode, "EXTERNAL_V2_ROUTER_CODE_MISSING");
  const factoryHash = runtimeHash(factoryCode, "EXTERNAL_V2_FACTORY_CODE_MISSING");
  if (routerHash !== identity.router.runtimeCodeHash) throw new Error("EXTERNAL_V2_ROUTER_CODE_MISMATCH");
  if (factoryHash !== identity.factory.runtimeCodeHash) throw new Error("EXTERNAL_V2_FACTORY_CODE_MISMATCH");
  if (normalizedAddress(routerFactory, "EXTERNAL_V2_ROUTER_FACTORY_INVALID") !== identity.factory.address) throw new Error("EXTERNAL_V2_ROUTER_FACTORY_MISMATCH");

  const pairHashes = await Promise.all(identity.pairs.map(async (pair, index) => {
    const [code, factoryPair, pairFactory, tokens] = await Promise.all([
      client.code(pair.address), client.factoryPair(identity.factory.address, identity.path[index], identity.path[index + 1]),
      client.pairFactory(pair.address), client.pairTokens(pair.address)
    ]);
    const codeHash = runtimeHash(code, "EXTERNAL_V2_PAIR_CODE_MISSING");
    if (codeHash !== pair.runtimeCodeHash) throw new Error("EXTERNAL_V2_PAIR_CODE_MISMATCH");
    if (normalizedAddress(factoryPair, "EXTERNAL_V2_FACTORY_PAIR_INVALID") !== pair.address) throw new Error("EXTERNAL_V2_FACTORY_PAIR_MISMATCH");
    if (normalizedAddress(pairFactory, "EXTERNAL_V2_PAIR_FACTORY_INVALID") !== identity.factory.address) throw new Error("EXTERNAL_V2_PAIR_FACTORY_MISMATCH");
    const observed = tokens.map((token) => normalizedAddress(token, "EXTERNAL_V2_PAIR_TOKENS_INVALID"));
    if (observed[0] !== pair.token0 || observed[1] !== pair.token1) throw new Error("EXTERNAL_V2_PAIR_TOKENS_MISMATCH");
    return codeHash;
  }));
  return { status: "verified", identity, fingerprint: externalEvmV2VenueFingerprint(identity), observedCodeHashes: { router: routerHash, factory: factoryHash, pairs: pairHashes } };
}

export async function quoteExternalEvmV2ExactIn(
  venue: VerifiedExternalEvmV2Venue,
  amountIn: bigint,
  slippageBps: number,
  recipientValue: string,
  client: ExternalEvmV2ReadClient,
  now = Date.now(),
  deadlineCeiling?: number
): Promise<ExternalEvmV2Quote> {
  if (amountIn <= 0n) throw new Error("EXTERNAL_V2_AMOUNT_INVALID");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) throw new Error("EXTERNAL_V2_SLIPPAGE_INVALID");
  const recipient = normalizedAddress(recipientValue, "EXTERNAL_V2_RECIPIENT_INVALID");
  const identity = validateExternalEvmV2VenueIdentity(venue.identity);
  if (venue.fingerprint !== externalEvmV2VenueFingerprint(identity)) throw new Error("EXTERNAL_V2_VERIFIED_IDENTITY_CHANGED");
  const reserves = await Promise.all(identity.pairs.map((pair) => client.pairReserves(pair.address)));
  const locallyComputed = [amountIn];
  for (let index = 0; index < identity.pairs.length; index++) {
    const pair = identity.pairs[index];
    const [reserve0, reserve1] = reserves[index];
    if (reserve0 <= 0n || reserve1 <= 0n) throw new Error("EXTERNAL_V2_LIQUIDITY_MISSING");
    const inputIsToken0 = identity.path[index] === pair.token0;
    locallyComputed.push(amountOut(locallyComputed[index], inputIsToken0 ? reserve0 : reserve1, inputIsToken0 ? reserve1 : reserve0));
  }
  const routerAmounts = [...await client.routerAmountsOut(identity.router.address, amountIn, identity.path)];
  if (routerAmounts.length !== locallyComputed.length || routerAmounts.some((value, index) => value !== locallyComputed[index])) throw new Error("EXTERNAL_V2_ROUTER_QUOTE_DIVERGED");
  const minimumOut = (routerAmounts.at(-1)! * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minimumOut <= 0n) throw new Error("EXTERNAL_V2_OUTPUT_INVALID");
  const defaultDeadline = Math.floor(now / 1_000) + 5 * 60;
  if (deadlineCeiling !== undefined && (!Number.isSafeInteger(deadlineCeiling) || deadlineCeiling <= Math.floor(now / 1_000))) throw new Error("EXTERNAL_V2_DEADLINE_INVALID");
  const deadline = deadlineCeiling === undefined ? defaultDeadline : Math.min(defaultDeadline, deadlineCeiling);
  const calldata = ROUTER_INTERFACE.encodeFunctionData(EXTERNAL_EVM_V2_METHOD, [amountIn, minimumOut, identity.path, recipient, deadline]);
  const quote: ExternalEvmV2Quote = {
    quoteId: keccak256(toUtf8Bytes([venue.fingerprint, amountIn, routerAmounts.join(","), minimumOut, recipient, deadline].join("|"))),
    venueFingerprint: venue.fingerprint, amountIn, amounts: routerAmounts, minimumOut, recipient, deadline, calldata
  };
  assertExternalEvmV2Calldata(venue, quote);
  return quote;
}

export async function revalidateExternalEvmV2QuoteForExecution(
  input: ExternalEvmV2VenueIdentity,
  quote: ExternalEvmV2Quote,
  client: ExternalEvmV2ReadClient,
  now = Date.now()
): Promise<VerifiedExternalEvmV2Venue> {
  const venue = await verifyExternalEvmV2Venue(input, client);
  if (quote.venueFingerprint !== venue.fingerprint) throw new Error("EXTERNAL_V2_QUOTE_VENUE_CHANGED");
  if (quote.deadline <= Math.floor(now / 1_000)) throw new Error("EXTERNAL_V2_QUOTE_EXPIRED");
  assertExternalEvmV2Calldata(venue, quote);
  return venue;
}

export function assertExternalEvmV2Calldata(venue: VerifiedExternalEvmV2Venue, quote: ExternalEvmV2Quote): void {
  const identity = validateExternalEvmV2VenueIdentity(venue.identity);
  if (venue.fingerprint !== externalEvmV2VenueFingerprint(identity)) throw new Error("EXTERNAL_V2_VERIFIED_IDENTITY_CHANGED");
  if (!Array.isArray(quote.amounts) || quote.amounts.length !== identity.path.length || quote.amounts[0] !== quote.amountIn || quote.amounts.some((amount) => amount <= 0n) || quote.minimumOut <= 0n || quote.minimumOut > quote.amounts.at(-1)!) throw new Error("EXTERNAL_V2_QUOTE_AMOUNTS_INVALID");
  let decoded;
  try { decoded = ROUTER_INTERFACE.decodeFunctionData(EXTERNAL_EVM_V2_METHOD, quote.calldata); }
  catch { throw new Error("EXTERNAL_V2_CALLDATA_INVALID"); }
  const path = [...decoded[2]].map((address) => normalizedAddress(address, "EXTERNAL_V2_CALLDATA_INVALID"));
  if (decoded[0] !== quote.amountIn || decoded[1] !== quote.minimumOut || decoded[3] !== quote.recipient || Number(decoded[4]) !== quote.deadline || path.length !== identity.path.length || path.some((address, index) => address !== identity.path[index])) throw new Error("EXTERNAL_V2_CALLDATA_MISMATCH");
  const expectedQuoteId = keccak256(toUtf8Bytes([venue.fingerprint, quote.amountIn, quote.amounts.join(","), quote.minimumOut, quote.recipient, quote.deadline].join("|")));
  if (quote.quoteId !== expectedQuoteId) throw new Error("EXTERNAL_V2_QUOTE_ID_MISMATCH");
}

function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 997n;
  const output = (amountInWithFee * reserveOut) / (reserveIn * 1_000n + amountInWithFee);
  if (output <= 0n || output >= reserveOut) throw new Error("EXTERNAL_V2_OUTPUT_INVALID");
  return output;
}

export function externalEvmV2VenueFingerprint(identity: ExternalEvmV2VenueIdentity): string {
  return keccak256(toUtf8Bytes([
    identity.schema, identity.venueId, identity.chainId, identity.router.address, identity.router.runtimeCodeHash,
    identity.factory.address, identity.factory.runtimeCodeHash, identity.path.join(","),
    identity.pairs.map((pair) => `${pair.address}:${pair.runtimeCodeHash}:${pair.token0}:${pair.token1}`).join(","),
    identity.feeBps, [...identity.evidenceUrls].sort().join(",")
  ].join("|")));
}

function validateCodeIdentity(value: { address: string; runtimeCodeHash: string }, code: string) {
  const address = normalizedAddress(value.address, code);
  if (typeof value.runtimeCodeHash !== "string" || !HASH.test(value.runtimeCodeHash)) throw new Error(code);
  return { address, runtimeCodeHash: value.runtimeCodeHash };
}

function runtimeHash(code: string, missingCode: string): string {
  if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || code === "0x") throw new Error(missingCode);
  return keccak256(code).toLowerCase();
}

function normalizedAddress(value: unknown, code: string): string {
  try {
    if (typeof value !== "string" || value === "0x0000000000000000000000000000000000000000") throw new Error(code);
    return getAddress(value);
  } catch { throw new Error(code); }
}

function isHttps(value: string): boolean {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
