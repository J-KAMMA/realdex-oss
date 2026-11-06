import { Secp256k1, ripemd160, sha256 } from "@cosmjs/crypto";
import { fromBech32 } from "@cosmjs/encoding";
import { makeSignBytes, makeSignDoc } from "@cosmjs/proto-signing";
import { base64 } from "@scure/base";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import { canonicalProtoFields, canonicalProtoUtf8 } from "./canonical-protobuf";

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TRANSACTION_BYTES = 20_000;
const MAX_QUOTE_TTL_MS = 5 * 60_000;
const MAX_HEIGHT_LIFETIME = 300n;
const MAX_GAS = 20_000_000n;
export const COSMOS_SWAP_BOUNDARY_ID = "cosmos-swap-boundary";

export type CosmosVenueDescriptor = {
  schema: "realdex.cosmos-venue.v1";
  venueId: string;
  revision: number;
  chainId: string;
  bech32Prefix: string;
  messageTypeUrl: string;
  executionTarget: string;
  publicKeyTypeUrl: "/cosmos.crypto.secp256k1.PubKey";
  evidenceUrls: string[];
};

export type CosmosSwapIntent = {
  schema: "realdex.cosmos-swap-intent.v1";
  venueId: string;
  venueRevision: number;
  chainId: string;
  authority: string;
  recipient: string;
  sourceDenom: string;
  destinationDenom: string;
  amountInBaseUnits: string;
  expectedOutBaseUnits: string;
  minimumOutBaseUnits: string;
  accountNumber: string;
  sequence: string;
  feeDenom: string;
  feeAmountBaseUnits: string;
  gasLimit: string;
  timeoutHeight: string;
  quoteExpiresAt: number;
  transactionBase64: string;
};

export type DecodedCosmosSwapMessage = {
  authority: string;
  recipient: string;
  executionTarget: string;
  sourceDenom: string;
  destinationDenom: string;
  amountInBaseUnits: string;
  minimumOutBaseUnits: string;
};

export type CosmosSwapMessageDecoder = (messageValue: Uint8Array) => DecodedCosmosSwapMessage;

export type CosmosSwapSimulation = {
  gasWanted: string;
  gasUsed: string;
  authoritySpent: Array<{ denom: string; amount: string }>;
  recipientReceived: Array<{ denom: string; amount: string }>;
};

export type CosmosSwapReader = {
  readonly id: string;
  chainId(): Promise<string>;
  blockHeight(): Promise<string>;
  account(address: string): Promise<{ accountNumber: string; sequence: string; publicKeyTypeUrl: string; publicKeyBase64: string }>;
  simulate(transactionBase64: string, authority: string, recipient: string): Promise<CosmosSwapSimulation>;
};

export type VerifiedCosmosSwap = {
  schema: "realdex.verified-cosmos-swap.v1";
  venueId: string;
  chainId: string;
  executionTarget: string;
  publicKeyHex: string;
  transactionSha256: string;
  signDocSha256: string;
  intentSha256: string;
  sourceDebitBaseUnits: string;
  destinationCreditBaseUnits: string;
  feeAmountBaseUnits: string;
  gasUsed: string;
  observations: Array<{ readerId: string; blockHeight: string }>;
  execution: "design-gate";
};

export function validateCosmosSwapIntent(value: unknown): CosmosSwapIntent {
  const keys = [
    "schema", "venueId", "venueRevision", "chainId", "authority", "recipient", "sourceDenom", "destinationDenom",
    "amountInBaseUnits", "expectedOutBaseUnits", "minimumOutBaseUnits", "accountNumber", "sequence", "feeDenom",
    "feeAmountBaseUnits", "gasLimit", "timeoutHeight", "quoteExpiresAt", "transactionBase64"
  ] as const;
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.cosmos-swap-intent.v1" || !bounded(value.venueId, 100) || !Number.isSafeInteger(value.venueRevision) || Number(value.venueRevision) <= 0 || typeof value.chainId !== "string" || !/^cosmos:[-_a-zA-Z0-9]{1,32}$/.test(value.chainId)) throw new Error("COSMOS_SWAP_INTENT_INVALID");
  if (typeof value.authority !== "string" || typeof value.recipient !== "string") throw new Error("COSMOS_SWAP_INTENT_INVALID");
  assertBech32Address(value.authority); assertBech32Address(value.recipient);
  for (const denom of [value.sourceDenom, value.destinationDenom, value.feeDenom]) { if (typeof denom !== "string") throw new Error("COSMOS_SWAP_INTENT_INVALID"); assertDenom(denom); }
  for (const amount of [value.amountInBaseUnits, value.expectedOutBaseUnits, value.minimumOutBaseUnits, value.accountNumber, value.sequence, value.feeAmountBaseUnits, value.gasLimit, value.timeoutHeight]) uint(amount, "COSMOS_SWAP_INTENT_INVALID");
  if (!Number.isSafeInteger(value.quoteExpiresAt) || !bounded(value.transactionBase64, 30_000)) throw new Error("COSMOS_SWAP_INTENT_INVALID");
  return { ...value } as CosmosSwapIntent;
}

export function validateCosmosVenueDescriptor(value: unknown): CosmosVenueDescriptor {
  const keys = ["schema", "venueId", "revision", "chainId", "bech32Prefix", "messageTypeUrl", "executionTarget", "publicKeyTypeUrl", "evidenceUrls"] as const;
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.cosmos-venue.v1" || !bounded(value.venueId, 100) || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0 || typeof value.chainId !== "string" || !/^cosmos:[-_a-zA-Z0-9]{1,32}$/.test(value.chainId) || typeof value.bech32Prefix !== "string" || !/^[a-z][a-z0-9]{1,30}$/.test(value.bech32Prefix) || typeof value.messageTypeUrl !== "string" || !/^\/[A-Za-z][A-Za-z0-9.]{1,150}$/.test(value.messageTypeUrl) || !bounded(value.executionTarget, 256) || value.publicKeyTypeUrl !== "/cosmos.crypto.secp256k1.PubKey") throw new Error("COSMOS_SWAP_VENUE_INVALID");
  if (!Array.isArray(value.evidenceUrls) || value.evidenceUrls.length < 2 || value.evidenceUrls.length > 8 || value.evidenceUrls.some((url) => typeof url !== "string" || !isHttps(url)) || new Set(value.evidenceUrls).size !== value.evidenceUrls.length) throw new Error("COSMOS_SWAP_VENUE_INVALID");
  return {
    schema: value.schema,
    venueId: value.venueId,
    revision: Number(value.revision),
    chainId: value.chainId,
    bech32Prefix: value.bech32Prefix,
    messageTypeUrl: value.messageTypeUrl,
    executionTarget: value.executionTarget,
    publicKeyTypeUrl: value.publicKeyTypeUrl,
    evidenceUrls: [...value.evidenceUrls] as string[]
  };
}

export async function verifyCosmosSwapBoundary(input: {
  venue: CosmosVenueDescriptor;
  intent: CosmosSwapIntent;
  readers: readonly CosmosSwapReader[];
  decodeSwapMessage: CosmosSwapMessageDecoder;
  now?: number;
}): Promise<VerifiedCosmosSwap> {
  const now = input.now ?? Date.now();
  const venue = validateCosmosVenueDescriptor(input.venue);
  const intent = validateCosmosSwapIntent(input.intent);
  assertIntent(intent, venue, now);
  assertReaderQuorum(input.readers);
  const bound = decodeAndBindTransaction(intent, venue, input.decodeSwapMessage);
  const observations = await Promise.all(input.readers.map(async (reader) => {
    const [chainId, blockHeightValue, account, simulation] = await Promise.all([
      reader.chainId(), reader.blockHeight(), reader.account(intent.authority),
      reader.simulate(intent.transactionBase64, intent.authority, intent.recipient)
    ]);
    if (chainId !== chainReference(venue.chainId)) throw new Error("COSMOS_SWAP_CHAIN_MISMATCH");
    const blockHeight = uint(blockHeightValue, "COSMOS_SWAP_HEIGHT_INVALID");
    const timeoutHeight = uint(intent.timeoutHeight, "COSMOS_SWAP_HEIGHT_INVALID");
    if (blockHeight >= timeoutHeight || timeoutHeight - blockHeight > MAX_HEIGHT_LIFETIME) throw new Error("COSMOS_SWAP_TIMEOUT_HEIGHT_INVALID");
    if (account.accountNumber !== intent.accountNumber || account.sequence !== intent.sequence || account.publicKeyTypeUrl !== venue.publicKeyTypeUrl || account.publicKeyBase64 !== bound.publicKeyBase64) throw new Error("COSMOS_SWAP_ACCOUNT_STATE_MISMATCH");
    const result = assertSimulation(intent, simulation);
    return { readerId: reader.id, blockHeight: blockHeight.toString(), ...result };
  }));
  const consensus = observations.map(({ sourceDebitBaseUnits, destinationCreditBaseUnits, gasWanted, gasUsed }) => JSON.stringify({ sourceDebitBaseUnits, destinationCreditBaseUnits, gasWanted, gasUsed }));
  if (new Set(consensus).size !== 1) throw new Error("COSMOS_SWAP_SIMULATION_QUORUM_MISMATCH");
  const first = observations[0];
  const signBytes = makeSignBytes(makeSignDoc(bound.bodyBytes, bound.authInfoBytes, chainReference(intent.chainId), uint(intent.accountNumber, "COSMOS_SWAP_ACCOUNT_INVALID")));
  return {
    schema: "realdex.verified-cosmos-swap.v1", venueId: venue.venueId, chainId: venue.chainId,
    executionTarget: venue.executionTarget, publicKeyHex: hex(bound.publicKey),
    transactionSha256: await sha256Hex(bound.transactionBytes), signDocSha256: await sha256Hex(signBytes),
    intentSha256: await sha256Hex(new TextEncoder().encode(canonicalIntent(intent))),
    sourceDebitBaseUnits: first.sourceDebitBaseUnits, destinationCreditBaseUnits: first.destinationCreditBaseUnits,
    feeAmountBaseUnits: intent.feeAmountBaseUnits, gasUsed: first.gasUsed,
    observations: observations.map(({ readerId, blockHeight }) => ({ readerId, blockHeight })), execution: "design-gate"
  };
}

export async function cosmosSwapTransactionSha256(value: CosmosSwapIntent): Promise<string> {
  const intent = validateCosmosSwapIntent(value);
  let bytes: Uint8Array;
  try { bytes = base64.decode(intent.transactionBase64); }
  catch { throw new Error("COSMOS_SWAP_TRANSACTION_ENCODING_INVALID"); }
  if (!bytes.length || bytes.length > MAX_TRANSACTION_BYTES) throw new Error("COSMOS_SWAP_TRANSACTION_SIZE_INVALID");
  return sha256Hex(bytes);
}

export async function cosmosSwapIntentSha256(value: CosmosSwapIntent): Promise<string> {
  const intent = validateCosmosSwapIntent(value);
  return sha256Hex(new TextEncoder().encode(canonicalIntent(intent)));
}

export function createCosmosSwapReader(endpointValue: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): CosmosSwapReader {
  const endpoint = normalizeEndpoint(endpointValue);
  const request = createRestRequester(endpoint, fetchImpl, timeoutMs);
  return {
    id: new URL(endpoint).hostname.toLowerCase(),
    chainId: async () => {
      const body = record(await request("GET", "cosmos/base/tendermint/v1beta1/node_info"));
      return requiredString(record(body.default_node_info).network);
    },
    blockHeight: async () => {
      const body = record(await request("GET", "cosmos/base/tendermint/v1beta1/blocks/latest"));
      return requiredUint(record(record(body.block).header).height);
    },
    account: async (address) => {
      assertBech32Address(address);
      const body = record(await request("GET", `cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`));
      const account = record(body.account);
      if (account["@type"] !== "/cosmos.auth.v1beta1.BaseAccount") throw new Error("COSMOS_SWAP_ACCOUNT_TYPE_UNSUPPORTED");
      const pubkey = record(account.pub_key);
      return { accountNumber: requiredUint(account.account_number), sequence: requiredUint(account.sequence), publicKeyTypeUrl: requiredString(pubkey["@type"]), publicKeyBase64: requiredBase64(pubkey.key) };
    },
    simulate: async (transactionBase64, authority, recipient) => {
      const body = record(await request("POST", "cosmos/tx/v1beta1/simulate", { tx_bytes: transactionBase64 }));
      const gas = record(body.gas_info), result = record(body.result);
      const events = Array.isArray(result.events) ? result.events : fail("COSMOS_SWAP_REST_RESPONSE_INVALID");
      return {
        gasWanted: requiredUint(gas.gas_wanted), gasUsed: requiredUint(gas.gas_used),
        authoritySpent: aggregateCoins(events, "coin_spent", "spender", authority),
        recipientReceived: aggregateCoins(events, "coin_received", "receiver", recipient)
      };
    }
  };
}

export function createCosmosSwapReaderQuorum(endpoints: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): CosmosSwapReader[] {
  if (endpoints.length !== 2 || endpoints.some((value) => !value.trim())) throw new Error("COSMOS_SWAP_READER_QUORUM_REQUIRED");
  const normalized = endpoints.map(normalizeEndpoint), hosts = normalized.map((value) => new URL(value).hostname.toLowerCase());
  if (new Set(normalized).size !== 2 || new Set(hosts).size !== 2) throw new Error("COSMOS_SWAP_READER_QUORUM_NOT_INDEPENDENT");
  return normalized.map((value) => createCosmosSwapReader(value, fetchImpl, timeoutMs));
}

function decodeAndBindTransaction(intent: CosmosSwapIntent, venue: CosmosVenueDescriptor, decoder: CosmosSwapMessageDecoder) {
  let transactionBytes: Uint8Array;
  try { transactionBytes = base64.decode(intent.transactionBase64); } catch { throw new Error("COSMOS_SWAP_TRANSACTION_ENCODING_INVALID"); }
  if (!transactionBytes.length || transactionBytes.length > MAX_TRANSACTION_BYTES) throw new Error("COSMOS_SWAP_TRANSACTION_SIZE_INVALID");
  const tx = canonicalProtoFields(transactionBytes, { 1: [2, 1], 2: [2, 1], 3: [2, 1] }, "COSMOS_SWAP_TXRAW_INVALID");
  const bodyBytes = tx.get(1)![0].bytes!, authInfoBytes = tx.get(2)![0].bytes!, signature = tx.get(3)![0].bytes!;
  if (signature.length !== 0) throw new Error("COSMOS_SWAP_PRE_SIGNED_TRANSACTION_BLOCKED");
  const body = canonicalProtoFields(bodyBytes, { 1: [2, 1], 3: [0, 1] }, "COSMOS_SWAP_BODY_INVALID");
  if (body.get(3)![0].integer !== uint(intent.timeoutHeight, "COSMOS_SWAP_HEIGHT_INVALID")) throw new Error("COSMOS_SWAP_TIMEOUT_HEIGHT_INVALID");
  const message = parseAny(body.get(1)![0].bytes!, "COSMOS_SWAP_MESSAGE_INVALID");
  if (message.typeUrl !== venue.messageTypeUrl) throw new Error("COSMOS_SWAP_MESSAGE_TYPE_MISMATCH");
  let decoded: DecodedCosmosSwapMessage;
  try { decoded = decoder(message.value); } catch { throw new Error("COSMOS_SWAP_MESSAGE_DECODE_FAILED"); }
  assertDecodedMessage(decoded, intent, venue);
  const auth = canonicalProtoFields(authInfoBytes, { 1: [2, 1], 2: [2, 1] }, "COSMOS_SWAP_AUTH_INFO_INVALID");
  const signer = canonicalProtoFields(auth.get(1)![0].bytes!, { 1: [2, 1], 2: [2, 1], 3: [0, -1] }, "COSMOS_SWAP_SIGNER_INFO_INVALID");
  if ((signer.get(3)?.[0].integer ?? 0n) !== uint(intent.sequence, "COSMOS_SWAP_ACCOUNT_INVALID")) throw new Error("COSMOS_SWAP_SEQUENCE_MISMATCH");
  const publicKey = parseAny(signer.get(1)![0].bytes!, "COSMOS_SWAP_PUBLIC_KEY_INVALID");
  if (publicKey.typeUrl !== venue.publicKeyTypeUrl) throw new Error("COSMOS_SWAP_PUBLIC_KEY_INVALID");
  const key = canonicalProtoFields(publicKey.value, { 1: [2, 1] }, "COSMOS_SWAP_PUBLIC_KEY_INVALID").get(1)![0].bytes!;
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) throw new Error("COSMOS_SWAP_PUBLIC_KEY_INVALID");
  try { Secp256k1.uncompressPubkey(key); }
  catch { throw new Error("COSMOS_SWAP_PUBLIC_KEY_INVALID"); }
  const authority = fromBech32(intent.authority).data;
  if (!sameBytes(authority, ripemd160(sha256(key)))) throw new Error("COSMOS_SWAP_PUBLIC_KEY_AUTHORITY_MISMATCH");
  const modeInfo = canonicalProtoFields(signer.get(2)![0].bytes!, { 1: [2, 1] }, "COSMOS_SWAP_SIGN_MODE_INVALID");
  const single = canonicalProtoFields(modeInfo.get(1)![0].bytes!, { 1: [0, 1] }, "COSMOS_SWAP_SIGN_MODE_INVALID");
  if (single.get(1)![0].integer !== 1n) throw new Error("COSMOS_SWAP_SIGN_MODE_INVALID");
  const fee = canonicalProtoFields(auth.get(2)![0].bytes!, { 1: [2, 1], 2: [0, 1] }, "COSMOS_SWAP_FEE_INVALID");
  const coin = canonicalProtoFields(fee.get(1)![0].bytes!, { 1: [2, 1], 2: [2, 1] }, "COSMOS_SWAP_FEE_INVALID");
  if (canonicalProtoUtf8(coin.get(1)![0].bytes!, "COSMOS_SWAP_PROTO_STRING_INVALID") !== intent.feeDenom || canonicalProtoUtf8(coin.get(2)![0].bytes!, "COSMOS_SWAP_PROTO_STRING_INVALID") !== intent.feeAmountBaseUnits || fee.get(2)![0].integer !== uint(intent.gasLimit, "COSMOS_SWAP_FEE_INVALID")) throw new Error("COSMOS_SWAP_FEE_MISMATCH");
  return { transactionBytes, bodyBytes, authInfoBytes, publicKeyBase64: base64.encode(key), publicKey: key };
}

function assertSimulation(intent: CosmosSwapIntent, simulation: CosmosSwapSimulation) {
  const gasWanted = uint(simulation.gasWanted, "COSMOS_SWAP_SIMULATION_FAILED"), gasUsed = uint(simulation.gasUsed, "COSMOS_SWAP_SIMULATION_FAILED"), gasLimit = uint(intent.gasLimit, "COSMOS_SWAP_FEE_INVALID");
  if (gasWanted <= 0n || gasUsed <= 0n || gasWanted > gasLimit || gasUsed > gasLimit || gasLimit > MAX_GAS) throw new Error("COSMOS_SWAP_SIMULATION_FAILED");
  const spent = coinMap(simulation.authoritySpent), received = coinMap(simulation.recipientReceived);
  const expectedSpent = new Map<string, bigint>([[intent.sourceDenom, uint(intent.amountInBaseUnits, "COSMOS_SWAP_AMOUNT_INVALID")]]);
  expectedSpent.set(intent.feeDenom, (expectedSpent.get(intent.feeDenom) ?? 0n) + uint(intent.feeAmountBaseUnits, "COSMOS_SWAP_FEE_INVALID"));
  if (!sameCoinMap(spent, expectedSpent)) throw new Error("COSMOS_SWAP_SIMULATION_DEBIT_MISMATCH");
  const expectedOut = uint(intent.expectedOutBaseUnits, "COSMOS_SWAP_AMOUNT_INVALID"), minimumOut = uint(intent.minimumOutBaseUnits, "COSMOS_SWAP_AMOUNT_INVALID");
  if (received.size !== 1 || received.get(intent.destinationDenom) !== expectedOut || expectedOut < minimumOut) throw new Error("COSMOS_SWAP_SIMULATION_CREDIT_MISMATCH");
  return { sourceDebitBaseUnits: intent.amountInBaseUnits, destinationCreditBaseUnits: expectedOut.toString(), gasWanted: gasWanted.toString(), gasUsed: gasUsed.toString() };
}

function assertVenue(value: CosmosVenueDescriptor): void {
  validateCosmosVenueDescriptor(value);
}

function assertIntent(value: CosmosSwapIntent, venue: CosmosVenueDescriptor, now: number): void {
  validateCosmosSwapIntent(value);
  if (value.schema !== "realdex.cosmos-swap-intent.v1" || value.venueId !== venue.venueId || value.venueRevision !== venue.revision || value.chainId !== venue.chainId) throw new Error("COSMOS_SWAP_INTENT_IDENTITY_INVALID");
  assertBech32Address(value.authority, venue.bech32Prefix); assertBech32Address(value.recipient, venue.bech32Prefix);
  [value.sourceDenom, value.destinationDenom, value.feeDenom].forEach(assertDenom);
  const input = uint(value.amountInBaseUnits, "COSMOS_SWAP_AMOUNT_INVALID"), expected = uint(value.expectedOutBaseUnits, "COSMOS_SWAP_AMOUNT_INVALID"), minimum = uint(value.minimumOutBaseUnits, "COSMOS_SWAP_AMOUNT_INVALID");
  if (value.sourceDenom === value.destinationDenom || input <= 0n || minimum <= 0n || expected < minimum || uint(value.feeAmountBaseUnits, "COSMOS_SWAP_FEE_INVALID") <= 0n || uint(value.gasLimit, "COSMOS_SWAP_FEE_INVALID") <= 0n || uint(value.gasLimit, "COSMOS_SWAP_FEE_INVALID") > MAX_GAS) throw new Error("COSMOS_SWAP_AMOUNT_INVALID");
  uint(value.accountNumber, "COSMOS_SWAP_ACCOUNT_INVALID"); uint(value.sequence, "COSMOS_SWAP_ACCOUNT_INVALID");
  if (!Number.isSafeInteger(value.quoteExpiresAt) || value.quoteExpiresAt <= now || value.quoteExpiresAt > now + MAX_QUOTE_TTL_MS || !bounded(value.transactionBase64, 30_000)) throw new Error("COSMOS_SWAP_INTENT_EXPIRY_INVALID");
}

function assertDecodedMessage(decoded: DecodedCosmosSwapMessage, intent: CosmosSwapIntent, venue: CosmosVenueDescriptor): void {
  const expected = { authority: intent.authority, recipient: intent.recipient, executionTarget: venue.executionTarget, sourceDenom: intent.sourceDenom, destinationDenom: intent.destinationDenom, amountInBaseUnits: intent.amountInBaseUnits, minimumOutBaseUnits: intent.minimumOutBaseUnits };
  if (!isRecord(decoded) || Object.keys(decoded).length !== Object.keys(expected).length || (Object.keys(expected) as Array<keyof DecodedCosmosSwapMessage>).some((key) => decoded[key] !== expected[key])) throw new Error("COSMOS_SWAP_MESSAGE_BINDING_INVALID");
}

function parseAny(bytes: Uint8Array, error: string): { typeUrl: string; value: Uint8Array } { const fields = canonicalProtoFields(bytes, { 1: [2, 1], 2: [2, 1] }, error); return { typeUrl: canonicalProtoUtf8(fields.get(1)![0].bytes!, "COSMOS_SWAP_PROTO_STRING_INVALID"), value: fields.get(2)![0].bytes! }; }

function aggregateCoins(events: unknown[], eventType: string, addressKey: string, address: string): Array<{ denom: string; amount: string }> {
  const totals = new Map<string, bigint>();
  for (const item of events) {
    if (!isRecord(item) || item.type !== eventType || !Array.isArray(item.attributes)) continue;
    const attrs = new Map(item.attributes.filter(isRecord).map((attr) => [String(attr.key), String(attr.value)]));
    if (attrs.get(addressKey) !== address) continue;
    for (const coin of parseCoins(attrs.get("amount") ?? "")) totals.set(coin.denom, (totals.get(coin.denom) ?? 0n) + coin.amount);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([denom, amount]) => ({ denom, amount: amount.toString() }));
}

function parseCoins(value: string): Array<{ denom: string; amount: bigint }> {
  if (!value) throw new Error("COSMOS_SWAP_REST_RESPONSE_INVALID");
  return value.split(",").map((part) => { const match = /^(0|[1-9]\d*)([a-zA-Z][a-zA-Z0-9/:._-]{1,127})$/.exec(part); if (!match) throw new Error("COSMOS_SWAP_REST_RESPONSE_INVALID"); return { amount: BigInt(match[1]), denom: match[2] }; });
}

function coinMap(coins: Array<{ denom: string; amount: string }>): Map<string, bigint> { const map = new Map<string, bigint>(); for (const coin of coins) { assertDenom(coin.denom); if (map.has(coin.denom)) throw new Error("COSMOS_SWAP_SIMULATION_COIN_DUPLICATE"); map.set(coin.denom, uint(coin.amount, "COSMOS_SWAP_SIMULATION_FAILED")); } return map; }
function sameCoinMap(a: Map<string, bigint>, b: Map<string, bigint>): boolean { return a.size === b.size && [...a].every(([denom, amount]) => b.get(denom) === amount); }
function assertReaderQuorum(readers: readonly CosmosSwapReader[]): void { if (readers.length !== 2 || readers.some((reader) => !bounded(reader.id, 255)) || new Set(readers.map((reader) => reader.id.toLowerCase())).size !== 2) throw new Error("COSMOS_SWAP_READER_QUORUM_REQUIRED"); }
function assertBech32Address(value: string, prefix?: string): void { try { const decoded = fromBech32(value); if (decoded.data.length !== 20 || (prefix && decoded.prefix !== prefix)) throw new Error(); } catch { throw new Error("COSMOS_SWAP_ADDRESS_INVALID"); } }
function assertDenom(value: string): void { if (!/^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/.test(value)) throw new Error("COSMOS_SWAP_DENOM_INVALID"); }
function chainReference(value: string): string { return value.slice(value.indexOf(":") + 1); }
function canonicalIntent(value: CosmosSwapIntent): string { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key as keyof CosmosSwapIntent]]))); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function uint(value: unknown, error: string): bigint { if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(error); return BigInt(value); }
function requiredUint(value: unknown): string { const text = requiredString(value); uint(text, "COSMOS_SWAP_REST_RESPONSE_INVALID"); return text; }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("COSMOS_SWAP_REST_RESPONSE_INVALID"); return value; }
function requiredBase64(value: unknown): string { const text = requiredString(value); try { if (base64.decode(text).length !== 33) throw new Error(); } catch { throw new Error("COSMOS_SWAP_REST_RESPONSE_INVALID"); } return text; }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function record(value: unknown): Record<string, any> { if (!isRecord(value)) throw new Error("COSMOS_SWAP_REST_RESPONSE_INVALID"); return value; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function isHttps(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }
function fail(message: string): never { throw new Error(message); }
function normalizeEndpoint(value: string): string { try { return normalizePublicRpcEndpoint(value); } catch { throw new Error("COSMOS_SWAP_ENDPOINT_NOT_PUBLIC"); } }
async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }

function createRestRequester(endpoint: string, fetchImpl: typeof fetch, timeoutMs: number) {
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return async (method: "GET" | "POST", path: string, body?: object): Promise<unknown> => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, base), { method, headers: method === "POST" ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("COSMOS_SWAP_REST_FAILED");
      return JSON.parse(await readBounded(response));
    } finally { clearTimeout(timeout); }
  };
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length")); if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("COSMOS_SWAP_RESPONSE_TOO_LARGE");
  if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("COSMOS_SWAP_RESPONSE_TOO_LARGE"); return text; }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = "";
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("COSMOS_SWAP_RESPONSE_TOO_LARGE"); } text += decoder.decode(value, { stream: true }); }
  return text + decoder.decode();
}
