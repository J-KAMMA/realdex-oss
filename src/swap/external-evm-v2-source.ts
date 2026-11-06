import { Interface, getAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { assertDistinctPublicRpcEndpoints, normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import {
  externalEvmV2VenueFingerprint,
  validateExternalEvmV2VenueIdentity,
  verifyExternalEvmV2Venue,
  type ExternalEvmV2ReadClient,
  type ExternalEvmV2VenueIdentity
} from "./external-evm-v2";

const MAX_VENUES = 64;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_RPC_RESPONSE_BYTES = 1_000_000;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const EIP155 = /^eip155:([1-9][0-9]*)$/;
const DECIMAL_CHAIN_ID = /^[1-9][0-9]*$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;

const ROUTER = new Interface([
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)"
]);
const FACTORY = new Interface(["function getPair(address tokenA,address tokenB) view returns (address pair)"]);
const PAIR = new Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)"
]);

export const EXTERNAL_EVM_V2_SOURCE_GATE_ID = "external-evm-v2-signed-source-v1";

export type ExternalEvmV2VenueSourceDescriptor = {
  schema: "realdex.external-evm-v2-source.v1";
  id: string;
  name: string;
  signerAddress: string;
  allowedChainIds: string[];
  evidenceUrls: string[];
};

export type SerializedExternalEvmV2VenueIdentity = Omit<ExternalEvmV2VenueIdentity, "chainId"> & { chainId: string };

export type SignedExternalEvmV2VenueManifest = {
  schema: "realdex.signed-external-evm-v2-venues.v1";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  venues: SerializedExternalEvmV2VenueIdentity[];
  evidenceUrls: string[];
  signature: string;
};

export type ExternalEvmV2VenueSourceHead = { revision: number; payloadHash: string };

export type VerifiedExternalEvmV2VenueManifest = {
  status: "verified-design-gate";
  executionEnabled: false;
  source: ExternalEvmV2VenueSourceDescriptor;
  sourceFingerprint: string;
  manifest: SignedExternalEvmV2VenueManifest;
  identities: ExternalEvmV2VenueIdentity[];
  payloadHash: string;
  recoveredSigner: string;
};

export type ExternalEvmV2QuorumReader = ExternalEvmV2ReadClient & { id: string };

export type ExternalEvmV2VenueObservation = {
  readerId: string;
  fingerprint: string;
  routerCodeHash: string;
  factoryCodeHash: string;
  pairCodeHashes: string[];
};

export type QuorumVerifiedExternalEvmV2Venue = {
  status: "verified-design-gate";
  executionEnabled: false;
  identity: ExternalEvmV2VenueIdentity;
  fingerprint: string;
  observations: [ExternalEvmV2VenueObservation, ExternalEvmV2VenueObservation];
};

export function validateExternalEvmV2VenueSource(value: unknown): ExternalEvmV2VenueSourceDescriptor {
  const source = strictObject(value, ["schema", "id", "name", "signerAddress", "allowedChainIds", "evidenceUrls"], "EXTERNAL_V2_SOURCE_INVALID");
  if (source.schema !== "realdex.external-evm-v2-source.v1" || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 100) throw new Error("EXTERNAL_V2_SOURCE_IDENTITY_INVALID");
  const signerAddress = normalizedAddress(source.signerAddress, "EXTERNAL_V2_SOURCE_SIGNER_INVALID");
  if (!Array.isArray(source.allowedChainIds) || source.allowedChainIds.length < 1 || source.allowedChainIds.length > 100 || source.allowedChainIds.some((chain) => typeof chain !== "string" || !EIP155.test(chain)) || new Set(source.allowedChainIds).size !== source.allowedChainIds.length) throw new Error("EXTERNAL_V2_SOURCE_CHAINS_INVALID");
  const evidenceUrls = validEvidenceUrls(source.evidenceUrls, 1, 16, "EXTERNAL_V2_SOURCE_EVIDENCE_INVALID");
  return {
    schema: source.schema,
    id: source.id,
    name: source.name,
    signerAddress,
    allowedChainIds: [...source.allowedChainIds] as string[],
    evidenceUrls
  };
}

export function externalEvmV2VenueSourceFingerprint(value: unknown): string {
  const source = validateExternalEvmV2VenueSource(value);
  return keccak256(toUtf8Bytes(JSON.stringify(source)));
}

export function canonicalSignedExternalEvmV2VenueManifestPayload(manifestValue: Omit<SignedExternalEvmV2VenueManifest, "signature">): string {
  const manifest = validateUnsignedManifest(manifestValue);
  return `RealDEX signed external EVM V2 venue manifest v1\n${JSON.stringify(manifest)}`;
}

export function verifySignedExternalEvmV2VenueManifest(
  value: unknown,
  sourceValue: unknown,
  options: { now?: number; previousHead?: ExternalEvmV2VenueSourceHead } = {}
): VerifiedExternalEvmV2VenueManifest {
  const source = validateExternalEvmV2VenueSource(sourceValue);
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "venues", "evidenceUrls", "signature"], "EXTERNAL_V2_MANIFEST_INVALID");
  if (typeof root.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(root.signature)) throw new Error("EXTERNAL_V2_MANIFEST_SIGNATURE_INVALID");
  const { signature, ...unsignedValue } = root;
  const unsigned = validateUnsignedManifest(unsignedValue);
  if (unsigned.sourceId !== source.id) throw new Error("EXTERNAL_V2_MANIFEST_SOURCE_MISMATCH");
  const sourceFingerprint = externalEvmV2VenueSourceFingerprint(source);
  if (unsigned.sourceFingerprint !== sourceFingerprint) throw new Error("EXTERNAL_V2_MANIFEST_SOURCE_MISMATCH");

  const now = options.now ?? Date.now();
  const issuedAt = parseCanonicalTimestamp(unsigned.issuedAt, "EXTERNAL_V2_MANIFEST_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(unsigned.expiresAt, "EXTERNAL_V2_MANIFEST_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("EXTERNAL_V2_MANIFEST_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("EXTERNAL_V2_MANIFEST_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("EXTERNAL_V2_MANIFEST_VALIDITY_INVALID");

  const identities = unsigned.venues.map(serializedExternalEvmV2VenueToIdentity);
  for (const identity of identities) {
    if (!source.allowedChainIds.includes(`eip155:${identity.chainId}`)) throw new Error("EXTERNAL_V2_MANIFEST_CHAIN_NOT_ALLOWED");
  }
  const fingerprints = identities.map(externalEvmV2VenueFingerprint);
  if (new Set(identities.map((identity) => identity.venueId)).size !== identities.length || new Set(fingerprints).size !== fingerprints.length) throw new Error("EXTERNAL_V2_MANIFEST_VENUE_DUPLICATE");

  const payload = canonicalSignedExternalEvmV2VenueManifestPayload(unsigned);
  const payloadHash = keccak256(toUtf8Bytes(payload));
  let recoveredSigner: string;
  try { recoveredSigner = getAddress(verifyMessage(payload, signature)); }
  catch { throw new Error("EXTERNAL_V2_MANIFEST_SIGNATURE_INVALID"); }
  if (recoveredSigner !== source.signerAddress) throw new Error("EXTERNAL_V2_MANIFEST_SIGNER_NOT_PINNED");

  if (options.previousHead) {
    const head = options.previousHead;
    if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !/^0x[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error("EXTERNAL_V2_MANIFEST_HEAD_INVALID");
    if (unsigned.revision < head.revision) throw new Error("EXTERNAL_V2_MANIFEST_ROLLBACK_BLOCKED");
    if (unsigned.revision === head.revision && payloadHash !== head.payloadHash) throw new Error("EXTERNAL_V2_MANIFEST_REVISION_CONFLICT");
  }

  return {
    status: "verified-design-gate",
    executionEnabled: false,
    source,
    sourceFingerprint,
    manifest: { ...unsigned, signature },
    identities,
    payloadHash,
    recoveredSigner
  };
}

export async function verifyExternalEvmV2VenueQuorum(
  identityValue: ExternalEvmV2VenueIdentity,
  readers: readonly ExternalEvmV2QuorumReader[]
): Promise<QuorumVerifiedExternalEvmV2Venue> {
  const identity = validateExternalEvmV2VenueIdentity(identityValue);
  if (readers.length !== 2 || readers.some((reader) => typeof reader.id !== "string" || !reader.id.trim() || reader.id.length > 100) || new Set(readers.map((reader) => reader.id)).size !== 2) throw new Error("EXTERNAL_V2_SOURCE_RPC_QUORUM_INVALID");
  const verified = await Promise.all(readers.map((reader) => verifyExternalEvmV2Venue(identity, reader)));
  const observations = verified.map((item, index): ExternalEvmV2VenueObservation => ({
    readerId: readers[index].id,
    fingerprint: item.fingerprint,
    routerCodeHash: item.observedCodeHashes.router,
    factoryCodeHash: item.observedCodeHashes.factory,
    pairCodeHashes: [...item.observedCodeHashes.pairs]
  })) as [ExternalEvmV2VenueObservation, ExternalEvmV2VenueObservation];
  if (observations[0].fingerprint !== observations[1].fingerprint || observations[0].routerCodeHash !== observations[1].routerCodeHash || observations[0].factoryCodeHash !== observations[1].factoryCodeHash || observations[0].pairCodeHashes.join(":") !== observations[1].pairCodeHashes.join(":")) throw new Error("EXTERNAL_V2_SOURCE_RPC_DIVERGED");
  return { status: "verified-design-gate", executionEnabled: false, identity, fingerprint: observations[0].fingerprint, observations };
}

export function createExternalEvmV2PublicReadClient(endpointValue: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): ExternalEvmV2QuorumReader {
  const endpoint = normalizePublicRpcEndpoint(endpointValue);
  const id = new URL(endpoint).hostname.toLowerCase();
  let requestId = 0;

  const request = async (method: "eth_chainId" | "eth_getCode" | "eth_call", params: readonly unknown[]): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const rpcId = ++requestId;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error("EXTERNAL_V2_SOURCE_RPC_HTTP_FAILED");
      const text = await readBoundedResponse(response);
      const payload = JSON.parse(text) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (!payload || typeof payload !== "object" || payload.jsonrpc !== "2.0" || payload.id !== rpcId || payload.error !== undefined || !("result" in payload)) throw new Error("EXTERNAL_V2_SOURCE_RPC_RESPONSE_INVALID");
      return payload.result;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") throw new Error("EXTERNAL_V2_SOURCE_RPC_TIMEOUT");
      throw reason;
    } finally { clearTimeout(timeout); }
  };

  const call = async (toValue: string, data: string): Promise<string> => {
    const to = normalizedAddress(toValue, "EXTERNAL_V2_SOURCE_RPC_ADDRESS_INVALID");
    return parseRpcHexData(await request("eth_call", [{ to, data }, "latest"]));
  };

  return {
    id,
    chainId: async () => parseRpcQuantity(await request("eth_chainId", [])),
    code: async (address) => parseRpcHexData(await request("eth_getCode", [normalizedAddress(address, "EXTERNAL_V2_SOURCE_RPC_ADDRESS_INVALID"), "latest"])),
    routerFactory: async (router) => decodeAddress(ROUTER, "factory", await call(router, ROUTER.encodeFunctionData("factory"))),
    factoryPair: async (factory, tokenA, tokenB) => decodeAddress(FACTORY, "getPair", await call(factory, FACTORY.encodeFunctionData("getPair", [normalizedAddress(tokenA, "EXTERNAL_V2_SOURCE_RPC_ADDRESS_INVALID"), normalizedAddress(tokenB, "EXTERNAL_V2_SOURCE_RPC_ADDRESS_INVALID")]))),
    pairFactory: async (pair) => decodeAddress(PAIR, "factory", await call(pair, PAIR.encodeFunctionData("factory"))),
    pairTokens: async (pair) => {
      const [token0, token1] = await Promise.all([
        call(pair, PAIR.encodeFunctionData("token0")),
        call(pair, PAIR.encodeFunctionData("token1"))
      ]);
      return [decodeAddress(PAIR, "token0", token0), decodeAddress(PAIR, "token1", token1)] as const;
    },
    pairReserves: async (pair) => {
      const decoded = PAIR.decodeFunctionResult("getReserves", await call(pair, PAIR.encodeFunctionData("getReserves")));
      return [BigInt(decoded[0]), BigInt(decoded[1])] as const;
    },
    routerAmountsOut: async (router, amountIn, path) => {
      if (amountIn <= 0n) throw new Error("EXTERNAL_V2_SOURCE_RPC_CALL_INVALID");
      const normalizedPath = path.map((address) => normalizedAddress(address, "EXTERNAL_V2_SOURCE_RPC_ADDRESS_INVALID"));
      const decoded = ROUTER.decodeFunctionResult("getAmountsOut", await call(router, ROUTER.encodeFunctionData("getAmountsOut", [amountIn, normalizedPath])));
      return [...decoded[0]].map(BigInt);
    }
  };
}

export function createExternalEvmV2PublicReadQuorum(endpoints: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): [ExternalEvmV2QuorumReader, ExternalEvmV2QuorumReader] {
  if (endpoints.length !== 2) throw new Error("EXTERNAL_V2_SOURCE_RPC_QUORUM_INVALID");
  const normalized = assertDistinctPublicRpcEndpoints(endpoints);
  return normalized.map((endpoint) => createExternalEvmV2PublicReadClient(endpoint, fetchImpl, timeoutMs)) as [ExternalEvmV2QuorumReader, ExternalEvmV2QuorumReader];
}

function validateUnsignedManifest(value: unknown): Omit<SignedExternalEvmV2VenueManifest, "signature"> {
  const manifest = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "venues", "evidenceUrls"], "EXTERNAL_V2_MANIFEST_INVALID");
  if (manifest.schema !== "realdex.signed-external-evm-v2-venues.v1" || typeof manifest.sourceId !== "string" || !SOURCE_ID.test(manifest.sourceId) || typeof manifest.sourceFingerprint !== "string" || !/^0x[0-9a-f]{64}$/.test(manifest.sourceFingerprint) || !Number.isSafeInteger(manifest.revision) || Number(manifest.revision) <= 0 || typeof manifest.issuedAt !== "string" || typeof manifest.expiresAt !== "string") throw new Error("EXTERNAL_V2_MANIFEST_IDENTITY_INVALID");
  if (!Array.isArray(manifest.venues) || manifest.venues.length < 1 || manifest.venues.length > MAX_VENUES) throw new Error("EXTERNAL_V2_MANIFEST_SIZE_INVALID");
  const venues = manifest.venues.map(validateSerializedVenue);
  const evidenceUrls = validEvidenceUrls(manifest.evidenceUrls, 1, 32, "EXTERNAL_V2_MANIFEST_EVIDENCE_INVALID");
  return {
    schema: manifest.schema,
    sourceId: manifest.sourceId,
    sourceFingerprint: manifest.sourceFingerprint,
    revision: manifest.revision as number,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    venues,
    evidenceUrls
  };
}

function validateSerializedVenue(value: unknown): SerializedExternalEvmV2VenueIdentity {
  const venue = strictObject(value, ["schema", "venueId", "chainId", "router", "factory", "path", "pairs", "feeBps", "evidenceUrls"], "EXTERNAL_V2_MANIFEST_VENUE_INVALID");
  if (typeof venue.chainId !== "string" || !DECIMAL_CHAIN_ID.test(venue.chainId)) throw new Error("EXTERNAL_V2_MANIFEST_CHAIN_INVALID");
  strictObject(venue.router, ["address", "runtimeCodeHash"], "EXTERNAL_V2_MANIFEST_VENUE_INVALID");
  strictObject(venue.factory, ["address", "runtimeCodeHash"], "EXTERNAL_V2_MANIFEST_VENUE_INVALID");
  if (!Array.isArray(venue.pairs)) throw new Error("EXTERNAL_V2_MANIFEST_VENUE_INVALID");
  for (const pair of venue.pairs) strictObject(pair, ["address", "runtimeCodeHash", "token0", "token1"], "EXTERNAL_V2_MANIFEST_VENUE_INVALID");
  const identity = validateExternalEvmV2VenueIdentity({ ...(venue as unknown as ExternalEvmV2VenueIdentity), chainId: BigInt(venue.chainId) });
  return serializeExternalEvmV2VenueIdentity(identity);
}

export function serializeExternalEvmV2VenueIdentity(identityValue: ExternalEvmV2VenueIdentity): SerializedExternalEvmV2VenueIdentity {
  const identity = validateExternalEvmV2VenueIdentity(identityValue);
  return { ...identity, chainId: identity.chainId.toString() };
}

export function serializedExternalEvmV2VenueToIdentity(value: SerializedExternalEvmV2VenueIdentity): ExternalEvmV2VenueIdentity {
  const serialized = validateSerializedVenue(value);
  return validateExternalEvmV2VenueIdentity({ ...serialized, chainId: BigInt(serialized.chainId) });
}

function decodeAddress(abi: Interface, method: string, data: string): string {
  try { return normalizedAddress(abi.decodeFunctionResult(method, data)[0], "EXTERNAL_V2_SOURCE_RPC_RESULT_INVALID"); }
  catch { throw new Error("EXTERNAL_V2_SOURCE_RPC_RESULT_INVALID"); }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RPC_RESPONSE_BYTES) throw new Error("EXTERNAL_V2_SOURCE_RPC_RESPONSE_TOO_LARGE");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RPC_RESPONSE_BYTES) throw new Error("EXTERNAL_V2_SOURCE_RPC_RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RPC_RESPONSE_BYTES) { await reader.cancel(); throw new Error("EXTERNAL_V2_SOURCE_RPC_RESPONSE_TOO_LARGE"); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseRpcQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) throw new Error("EXTERNAL_V2_SOURCE_RPC_QUANTITY_INVALID");
  return BigInt(value);
}

function parseRpcHexData(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error("EXTERNAL_V2_SOURCE_RPC_DATA_INVALID");
  return value.toLowerCase();
}

function normalizedAddress(value: unknown, code: string): string {
  try {
    if (typeof value !== "string" || value === "0x0000000000000000000000000000000000000000") throw new Error(code);
    return getAddress(value);
  } catch { throw new Error(code); }
}

function validEvidenceUrls(value: unknown, minimum: number, maximum: number, code: string): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || value.some((url) => typeof url !== "string" || !isHttps(url)) || new Set(value).size !== value.length) throw new Error(code);
  return [...value] as string[];
}

function parseCanonicalTimestamp(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
  return parsed;
}

function strictObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(code);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) throw new Error(code);
  return object;
}

function isHttps(value: string): boolean {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
