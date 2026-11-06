import { base58, base64 } from "@scure/base";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import { validateSolanaSwapIntent, type SolanaSwapIntent } from "./solana-swap-boundary";
import { validateSplTokenSwapExactInRouteDescriptor, type SplTokenSwapExactInRouteDescriptor } from "./spl-token-swap-exact-in-decoder";

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SLOT_LAG = 150;
const MAX_QUOTE_TTL_MS = 5 * 60_000;
const SWAP_STATE_LENGTH = 324;
const TOKEN_ACCOUNT_LENGTH = 165;

export const SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID = "spl-token-swap-constant-product-quote-v1";

export type SolanaReadonlyAccount = { owner: string; executable: boolean; dataBase64: string };

export type SplTokenSwapQuoteReader = {
  readonly id: string;
  genesisHash(): Promise<string>;
  currentSlot(): Promise<number>;
  accounts(addresses: readonly string[]): Promise<{ slot: number; accounts: Array<SolanaReadonlyAccount | null> }>;
};

export type VerifiedSplTokenSwapQuote = {
  schema: "realdex.verified-spl-token-swap-quote.v1";
  venueId: string;
  chainId: string;
  curve: "constant-product";
  amountInBaseUnits: string;
  expectedOutBaseUnits: string;
  minimumOutBaseUnits: string;
  slippageBps: number;
  sourceReserveBaseUnits: string;
  destinationReserveBaseUnits: string;
  tradeFeeBaseUnits: string;
  ownerTradeFeeBaseUnits: string;
  observations: Array<{ readerId: string; slot: number; currentSlot: number }>;
  execution: "design-gate";
};

type SwapState = {
  bumpSeed: number;
  fees: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
};

export async function verifySplTokenSwapQuote(input: {
  route: SplTokenSwapExactInRouteDescriptor;
  intent: SolanaSwapIntent;
  readers: readonly SplTokenSwapQuoteReader[];
  now?: number;
}): Promise<VerifiedSplTokenSwapQuote> {
  const route = validateSplTokenSwapExactInRouteDescriptor(input.route);
  const intent = validateSolanaSwapIntent(input.intent);
  const now = input.now ?? Date.now();
  if (intent.venueId !== route.venueId || intent.venueRevision !== route.revision || intent.chainId !== route.chainId || intent.sourceMint !== route.sourceMint || intent.destinationMint !== route.destinationMint || intent.tokenProgramAddress !== route.tokenProgramAddress || intent.executionTarget !== route.swapState) throw new Error("SPL_TOKEN_SWAP_QUOTE_INTENT_IDENTITY_INVALID");
  if (intent.quoteExpiresAt <= now || intent.quoteExpiresAt > now + MAX_QUOTE_TTL_MS) throw new Error("SPL_TOKEN_SWAP_QUOTE_EXPIRED");
  assertReaderQuorum(input.readers);

  const [derivedAuthority, derivedBump] = await getProgramDerivedAddress({
    programAddress: address(route.programAddress),
    seeds: [getAddressEncoder().encode(address(route.swapState))]
  });
  if (derivedAuthority !== route.swapAuthority) throw new Error("SPL_TOKEN_SWAP_QUOTE_AUTHORITY_MISMATCH");

  const observations = await Promise.all(input.readers.map(async (reader) => {
    const [genesisHash, currentSlot, snapshot] = await Promise.all([
      reader.genesisHash(), reader.currentSlot(), reader.accounts([route.swapState, route.poolSourceTokenAccount, route.poolDestinationTokenAccount])
    ]);
    if (!isAddress(genesisHash) || genesisHash.slice(0, 32) !== route.chainId.slice(route.chainId.indexOf(":") + 1)) throw new Error("SPL_TOKEN_SWAP_QUOTE_CHAIN_MISMATCH");
    if (!safeSlot(currentSlot) || !safeSlot(snapshot.slot) || snapshot.slot > currentSlot || currentSlot - snapshot.slot > MAX_SLOT_LAG || snapshot.accounts.length !== 3 || snapshot.accounts.some((value) => value === null)) throw new Error("SPL_TOKEN_SWAP_QUOTE_SNAPSHOT_STALE");
    const state = parseSwapState(snapshot.accounts[0]!, route);
    if (state.bumpSeed !== derivedBump) throw new Error("SPL_TOKEN_SWAP_QUOTE_AUTHORITY_MISMATCH");
    const sourceVault = parseTokenAccount(snapshot.accounts[1]!, route.tokenProgramAddress, route.sourceMint, route.swapAuthority);
    const destinationVault = parseTokenAccount(snapshot.accounts[2]!, route.tokenProgramAddress, route.destinationMint, route.swapAuthority);
    const quote = calculateConstantProductQuote(BigInt(intent.amountInBaseUnits), sourceVault.amount, destinationVault.amount, state.fees);
    return { readerId: reader.id, slot: snapshot.slot, currentSlot, sourceReserve: sourceVault.amount, destinationReserve: destinationVault.amount, ...quote };
  }));

  const first = observations[0];
  if (Math.max(...observations.map((value) => value.currentSlot)) - Math.min(...observations.map((value) => value.currentSlot)) > MAX_SLOT_LAG || Math.max(...observations.map((value) => value.slot)) - Math.min(...observations.map((value) => value.slot)) > MAX_SLOT_LAG) throw new Error("SPL_TOKEN_SWAP_QUOTE_SNAPSHOT_DIVERGED");
  const consensus = observations.map(({ sourceReserve, destinationReserve, expectedOut, tradeFee, ownerFee }) => JSON.stringify({ sourceReserve: sourceReserve.toString(), destinationReserve: destinationReserve.toString(), expectedOut: expectedOut.toString(), tradeFee: tradeFee.toString(), ownerFee: ownerFee.toString() }));
  if (new Set(consensus).size !== 1) throw new Error("SPL_TOKEN_SWAP_QUOTE_QUORUM_MISMATCH");
  const exactMinimum = first.expectedOut * BigInt(10_000 - intent.slippageBps) / 10_000n;
  if (first.expectedOut.toString() !== intent.expectedOutBaseUnits) throw new Error("SPL_TOKEN_SWAP_QUOTE_OUTPUT_MISMATCH");
  if (exactMinimum <= 0n || exactMinimum.toString() !== intent.minimumOutBaseUnits) throw new Error("SPL_TOKEN_SWAP_QUOTE_SLIPPAGE_MISMATCH");

  return {
    schema: "realdex.verified-spl-token-swap-quote.v1", venueId: route.venueId, chainId: route.chainId, curve: "constant-product",
    amountInBaseUnits: intent.amountInBaseUnits, expectedOutBaseUnits: first.expectedOut.toString(), minimumOutBaseUnits: intent.minimumOutBaseUnits,
    slippageBps: intent.slippageBps, sourceReserveBaseUnits: first.sourceReserve.toString(), destinationReserveBaseUnits: first.destinationReserve.toString(),
    tradeFeeBaseUnits: first.tradeFee.toString(), ownerTradeFeeBaseUnits: first.ownerFee.toString(),
    observations: observations.map(({ readerId, slot, currentSlot }) => ({ readerId, slot, currentSlot })), execution: "design-gate"
  };
}

export function createSplTokenSwapQuoteReader(endpointValue: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): SplTokenSwapQuoteReader {
  const endpoint = normalizeEndpoint(endpointValue), request = createRequester(endpoint, fetchImpl, timeoutMs), id = new URL(endpoint).hostname.toLowerCase();
  return {
    id,
    genesisHash: async () => requiredString(await request("getGenesisHash", [])),
    currentSlot: async () => requiredInteger(await request("getSlot", [{ commitment: "confirmed" }])),
    accounts: async (addresses) => {
      if (addresses.length < 1 || addresses.length > 8 || addresses.some((value) => !isAddress(value)) || new Set(addresses).size !== addresses.length) throw new Error("SPL_TOKEN_SWAP_QUOTE_ACCOUNTS_INVALID");
      const result = await request("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }]);
      if (!isRecord(result) || !isRecord(result.context) || !Array.isArray(result.value) || result.value.length !== addresses.length) throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_INVALID");
      return { slot: requiredInteger(result.context.slot), accounts: result.value.map(parseRpcAccount) };
    }
  };
}

export function createSplTokenSwapQuoteReaderQuorum(endpoints: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): SplTokenSwapQuoteReader[] {
  if (endpoints.length !== 2 || endpoints.some((value) => !value.trim())) throw new Error("SPL_TOKEN_SWAP_QUOTE_READER_QUORUM_REQUIRED");
  const normalized = endpoints.map(normalizeEndpoint), hosts = normalized.map((value) => new URL(value).hostname.toLowerCase());
  if (new Set(normalized).size !== 2 || new Set(hosts).size !== 2) throw new Error("SPL_TOKEN_SWAP_QUOTE_READER_NOT_INDEPENDENT");
  return normalized.map((value) => createSplTokenSwapQuoteReader(value, fetchImpl, timeoutMs));
}

function parseSwapState(account: SolanaReadonlyAccount, route: SplTokenSwapExactInRouteDescriptor): SwapState {
  if (account.owner !== route.programAddress || account.executable) throw new Error("SPL_TOKEN_SWAP_QUOTE_STATE_INVALID");
  const bytes = decodeBase64(account.dataBase64, SWAP_STATE_LENGTH, "SPL_TOKEN_SWAP_QUOTE_STATE_INVALID");
  if (bytes[0] !== 1 || bytes[1] !== 1 || base58.encode(bytes.slice(3, 35)) !== route.tokenProgramAddress || base58.encode(bytes.slice(99, 131)) !== route.poolMint || base58.encode(bytes.slice(195, 227)) !== route.poolFeeAccount || bytes[291] !== 0 || bytes.slice(292).some((value) => value !== 0)) throw new Error("SPL_TOKEN_SWAP_QUOTE_STATE_INVALID");
  const tokenA = base58.encode(bytes.slice(35, 67)), tokenB = base58.encode(bytes.slice(67, 99));
  const mintA = base58.encode(bytes.slice(131, 163)), mintB = base58.encode(bytes.slice(163, 195));
  const forward = tokenA === route.poolSourceTokenAccount && tokenB === route.poolDestinationTokenAccount && mintA === route.sourceMint && mintB === route.destinationMint;
  const reverse = tokenB === route.poolSourceTokenAccount && tokenA === route.poolDestinationTokenAccount && mintB === route.sourceMint && mintA === route.destinationMint;
  if (!forward && !reverse) throw new Error("SPL_TOKEN_SWAP_QUOTE_STATE_INVALID");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fees = Array.from({ length: 8 }, (_, index) => view.getBigUint64(227 + index * 8, true)) as unknown as SwapState["fees"];
  for (let index = 0; index < fees.length; index += 2) validateFraction(fees[index], fees[index + 1]);
  return { bumpSeed: bytes[2], fees };
}

function parseTokenAccount(account: SolanaReadonlyAccount, tokenProgram: string, mint: string, owner: string): { amount: bigint } {
  if (account.owner !== tokenProgram || account.executable) throw new Error("SPL_TOKEN_SWAP_QUOTE_VAULT_INVALID");
  const bytes = decodeBase64(account.dataBase64, TOKEN_ACCOUNT_LENGTH, "SPL_TOKEN_SWAP_QUOTE_VAULT_INVALID");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (base58.encode(bytes.slice(0, 32)) !== mint || base58.encode(bytes.slice(32, 64)) !== owner || bytes[108] !== 1 || !canonicalNone(bytes.slice(72, 108)) || view.getBigUint64(121, true) !== 0n || !canonicalNone(bytes.slice(129, 165)) || !canonicalNative(bytes.slice(109, 121))) throw new Error("SPL_TOKEN_SWAP_QUOTE_VAULT_INVALID");
  const amount = view.getBigUint64(64, true);
  if (amount <= 0n) throw new Error("SPL_TOKEN_SWAP_QUOTE_LIQUIDITY_INVALID");
  return { amount };
}

function calculateConstantProductQuote(amountIn: bigint, sourceReserve: bigint, destinationReserve: bigint, fees: SwapState["fees"]) {
  if (amountIn <= 0n || sourceReserve <= 0n || destinationReserve <= 0n) throw new Error("SPL_TOKEN_SWAP_QUOTE_LIQUIDITY_INVALID");
  const tradeFee = calculateFee(amountIn, fees[0], fees[1]), ownerFee = calculateFee(amountIn, fees[2], fees[3]);
  const amountLessFees = amountIn - tradeFee - ownerFee;
  if (amountLessFees <= 0n) throw new Error("SPL_TOKEN_SWAP_QUOTE_FEE_INVALID");
  const invariant = sourceReserve * destinationReserve, newSource = sourceReserve + amountLessFees;
  const newDestination = (invariant + newSource - 1n) / newSource;
  const expectedOut = destinationReserve - newDestination;
  if (expectedOut <= 0n || expectedOut >= destinationReserve) throw new Error("SPL_TOKEN_SWAP_QUOTE_LIQUIDITY_INVALID");
  return { expectedOut, tradeFee, ownerFee };
}

function calculateFee(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (numerator === 0n || amount === 0n) return 0n;
  if (denominator === 0n || numerator >= denominator) throw new Error("SPL_TOKEN_SWAP_QUOTE_FEE_INVALID");
  const fee = amount * numerator / denominator;
  return fee === 0n ? 1n : fee;
}

function validateFraction(numerator: bigint, denominator: bigint): void {
  if ((numerator === 0n && denominator === 0n) || (denominator > 0n && numerator < denominator)) return;
  throw new Error("SPL_TOKEN_SWAP_QUOTE_FEE_INVALID");
}

function canonicalNone(bytes: Uint8Array): boolean { return bytes.length >= 4 && bytes.every((value) => value === 0); }
function canonicalNative(bytes: Uint8Array): boolean { if (bytes.length !== 12) return false; const option = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true); return option === 1 || (option === 0 && bytes.every((value) => value === 0)); }
function decodeBase64(value: string, length: number, code: string): Uint8Array { try { const bytes = base64.decode(value); if (bytes.length !== length) throw new Error(); return bytes; } catch { throw new Error(code); } }
function parseRpcAccount(value: unknown): SolanaReadonlyAccount | null { if (value === null) return null; if (!isRecord(value) || typeof value.owner !== "string" || typeof value.executable !== "boolean" || !Array.isArray(value.data) || typeof value.data[0] !== "string" || value.data[1] !== "base64") throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_INVALID"); return { owner: value.owner, executable: value.executable, dataBase64: value.data[0] }; }
function assertReaderQuorum(readers: readonly SplTokenSwapQuoteReader[]): void { if (readers.length !== 2 || readers.some((reader) => typeof reader.id !== "string" || !reader.id || reader.id.length > 255) || new Set(readers.map((reader) => reader.id.toLowerCase())).size !== 2) throw new Error("SPL_TOKEN_SWAP_QUOTE_READER_QUORUM_REQUIRED"); }
function normalizeEndpoint(value: string): string { try { return normalizePublicRpcEndpoint(value); } catch { throw new Error("SPL_TOKEN_SWAP_QUOTE_ENDPOINT_NOT_PUBLIC"); } }
function isAddress(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 32; } catch { return false; } }
function safeSlot(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function requiredInteger(value: unknown): number { if (!safeSlot(value)) throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_INVALID"); return Number(value); }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_INVALID"); return value; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function createRequester(endpoint: string, fetchImpl: typeof fetch, timeoutMs: number) {
  let id = 0;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs), requestId = ++id;
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_FAILED");
      const payload = JSON.parse(await readBounded(response)) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (payload.jsonrpc !== "2.0" || payload.id !== requestId || payload.error !== undefined || !("result" in payload)) throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_INVALID");
      return payload.result;
    } finally { clearTimeout(timeout); }
  };
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length")); if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_TOO_LARGE");
  if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_TOO_LARGE"); return text; }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = "";
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_TOO_LARGE"); } text += decoder.decode(value, { stream: true }); }
  return text + decoder.decode();
}
