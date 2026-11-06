import { getAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { assertDistinctPublicRpcEndpoints } from "../release/evm-json-rpc-reader";
import {
  createExternalEvmV2PublicReadQuorum,
  externalEvmV2VenueSourceFingerprint,
  verifyExternalEvmV2VenueQuorum,
  verifySignedExternalEvmV2VenueManifest,
  type ExternalEvmV2VenueSourceHead,
  type QuorumVerifiedExternalEvmV2Venue
} from "./external-evm-v2-source";
import {
  quoteExternalEvmV2ExactIn,
  type ExternalEvmV2Quote,
  type VerifiedExternalEvmV2Venue
} from "./external-evm-v2";

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const EIP155 = /^eip155:([1-9][0-9]*)$/;
const VENUE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const BASE_UNITS = /^[1-9][0-9]*$/;
const UINT256_MAX = (1n << 256n) - 1n;
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_QUOTE_INTENT_VALIDITY_MS = 5 * 60 * 1_000;

export const EXTERNAL_EVM_V2_READ_POLICY_GATE_ID = "external-evm-v2-signed-read-policy-v2";
export const EXTERNAL_EVM_V2_VERIFICATION_BOUNDARY_ID = "external-evm-v2-venue-quorum-v1";
export const EXTERNAL_EVM_V2_QUOTE_BOUNDARY_ID = "external-evm-v2-quote-quorum-v1";

export type ExternalEvmV2ReadPolicySourceDescriptor = {
  schema: "realdex.external-evm-v2-read-policy-source.v1";
  id: string;
  name: string;
  signerAddress: string;
  allowedChainIds: string[];
  evidenceUrls: string[];
};

export type SignedExternalEvmV2ReadPolicy = {
  schema: "realdex.signed-external-evm-v2-read-policy.v2";
  sourceId: string;
  sourceFingerprint: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  chainId: string;
  rpcEndpoints: [string, string];
  verificationBoundaryId: typeof EXTERNAL_EVM_V2_VERIFICATION_BOUNDARY_ID;
  quoteBoundaryId: typeof EXTERNAL_EVM_V2_QUOTE_BOUNDARY_ID;
  evidenceUrls: string[];
  signature: string;
};

export type ExternalEvmV2ReadPolicyHead = { revision: number; payloadHash: string };

export type VerifiedExternalEvmV2ReadPolicy = {
  schema: "realdex.verified-external-evm-v2-read-policy.v2";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  submissionEnabled: false;
  source: ExternalEvmV2ReadPolicySourceDescriptor;
  sourceFingerprint: string;
  policy: SignedExternalEvmV2ReadPolicy;
  payloadHash: string;
  verifiedAt: number;
};

export type PolicyBoundExternalEvmV2Venue = QuorumVerifiedExternalEvmV2Venue & {
  venueSourceFingerprint: string;
  venueManifestPayloadHash: string;
  readPolicySourceFingerprint: string;
  readPolicyPayloadHash: string;
  signingEnabled: false;
  submissionEnabled: false;
};

export type ExternalEvmV2QuoteObservation = {
  readerId: string;
  quoteId: string;
  amounts: bigint[];
  minimumOut: bigint;
  calldata: string;
};

export type ExternalEvmV2QuoteIntent = {
  schema: "realdex.external-evm-v2-quote-intent.v1";
  venueId: string;
  chainId: string;
  amountInBaseUnits: string;
  slippageBps: number;
  recipient: string;
  issuedAt: string;
  expiresAt: string;
};

export type PolicyBoundExternalEvmV2Quote = {
  schema: "realdex.policy-bound-external-evm-v2-quote.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  submissionEnabled: false;
  venue: PolicyBoundExternalEvmV2Venue;
  intent: ExternalEvmV2QuoteIntent;
  intentFingerprint: string;
  verifiedAt: number;
  quote: ExternalEvmV2Quote;
  slippageBps: number;
  observations: [ExternalEvmV2QuoteObservation, ExternalEvmV2QuoteObservation];
};

export type PolicyBoundExternalEvmV2QuoteRevalidation = {
  schema: "realdex.policy-bound-external-evm-v2-quote-revalidation.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  submissionEnabled: false;
  expectedQuoteId: string;
  expectedIntentFingerprint: string;
  revalidatedAt: number;
  quote: PolicyBoundExternalEvmV2Quote;
};

export function validateExternalEvmV2QuoteIntent(value: unknown, now = Date.now()): ExternalEvmV2QuoteIntent {
  const intent = strictObject(value, ["schema", "venueId", "chainId", "amountInBaseUnits", "slippageBps", "recipient", "issuedAt", "expiresAt"], "EXTERNAL_V2_QUOTE_INTENT_INVALID");
  if (intent.schema !== "realdex.external-evm-v2-quote-intent.v1" || typeof intent.venueId !== "string" || !VENUE_ID.test(intent.venueId) || typeof intent.chainId !== "string" || !EIP155.test(intent.chainId) || typeof intent.amountInBaseUnits !== "string" || !BASE_UNITS.test(intent.amountInBaseUnits) || !Number.isInteger(intent.slippageBps) || Number(intent.slippageBps) < 0 || Number(intent.slippageBps) > 500 || typeof intent.issuedAt !== "string" || typeof intent.expiresAt !== "string") throw new Error("EXTERNAL_V2_QUOTE_INTENT_IDENTITY_INVALID");
  const amountIn = BigInt(intent.amountInBaseUnits);
  if (amountIn > UINT256_MAX) throw new Error("EXTERNAL_V2_QUOTE_INTENT_AMOUNT_INVALID");
  const recipient = normalizedAddress(intent.recipient, "EXTERNAL_V2_QUOTE_INTENT_RECIPIENT_INVALID");
  if (recipient === "0x0000000000000000000000000000000000000000") throw new Error("EXTERNAL_V2_QUOTE_INTENT_RECIPIENT_INVALID");
  const issuedAt = parseCanonicalTimestamp(intent.issuedAt, "EXTERNAL_V2_QUOTE_INTENT_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(intent.expiresAt, "EXTERNAL_V2_QUOTE_INTENT_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("EXTERNAL_V2_QUOTE_INTENT_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("EXTERNAL_V2_QUOTE_INTENT_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_QUOTE_INTENT_VALIDITY_MS) throw new Error("EXTERNAL_V2_QUOTE_INTENT_VALIDITY_INVALID");
  return {
    schema: intent.schema,
    venueId: intent.venueId,
    chainId: intent.chainId,
    amountInBaseUnits: intent.amountInBaseUnits,
    slippageBps: intent.slippageBps as number,
    recipient,
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt
  };
}

export function externalEvmV2QuoteIntentFingerprint(value: unknown, now = Date.now()): string {
  return keccak256(toUtf8Bytes(JSON.stringify(validateExternalEvmV2QuoteIntent(value, now))));
}

export function validateExternalEvmV2ReadPolicySource(value: unknown): ExternalEvmV2ReadPolicySourceDescriptor {
  const source = strictObject(value, ["schema", "id", "name", "signerAddress", "allowedChainIds", "evidenceUrls"], "EXTERNAL_V2_READ_POLICY_SOURCE_INVALID");
  if (source.schema !== "realdex.external-evm-v2-read-policy-source.v1" || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || typeof source.name !== "string" || !source.name.trim() || source.name.length > 100) throw new Error("EXTERNAL_V2_READ_POLICY_SOURCE_IDENTITY_INVALID");
  const signerAddress = normalizedAddress(source.signerAddress, "EXTERNAL_V2_READ_POLICY_SOURCE_SIGNER_INVALID");
  if (!Array.isArray(source.allowedChainIds) || source.allowedChainIds.length < 1 || source.allowedChainIds.length > 16 || source.allowedChainIds.some((chainId) => typeof chainId !== "string" || !EIP155.test(chainId)) || new Set(source.allowedChainIds).size !== source.allowedChainIds.length) throw new Error("EXTERNAL_V2_READ_POLICY_SOURCE_CHAINS_INVALID");
  return {
    schema: source.schema,
    id: source.id,
    name: source.name,
    signerAddress,
    allowedChainIds: [...source.allowedChainIds] as string[],
    evidenceUrls: validEvidenceUrls(source.evidenceUrls, "EXTERNAL_V2_READ_POLICY_SOURCE_EVIDENCE_INVALID")
  };
}

export function externalEvmV2ReadPolicySourceFingerprint(value: unknown): string {
  return keccak256(toUtf8Bytes(JSON.stringify(validateExternalEvmV2ReadPolicySource(value))));
}

export function canonicalSignedExternalEvmV2ReadPolicyPayload(value: Omit<SignedExternalEvmV2ReadPolicy, "signature">): string {
  return `RealDEX signed external EVM V2 read policy v2\n${JSON.stringify(validateUnsignedPolicy(value))}`;
}

export function verifySignedExternalEvmV2ReadPolicy(
  value: unknown,
  sourceValue: unknown,
  options: { now?: number; previousHead?: ExternalEvmV2ReadPolicyHead } = {}
): VerifiedExternalEvmV2ReadPolicy {
  const source = validateExternalEvmV2ReadPolicySource(sourceValue);
  const root = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "chainId", "rpcEndpoints", "verificationBoundaryId", "quoteBoundaryId", "evidenceUrls", "signature"], "EXTERNAL_V2_READ_POLICY_INVALID");
  if (typeof root.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(root.signature)) throw new Error("EXTERNAL_V2_READ_POLICY_SIGNATURE_INVALID");
  const { signature, ...unsignedValue } = root;
  const unsigned = validateUnsignedPolicy(unsignedValue);
  const sourceFingerprint = externalEvmV2ReadPolicySourceFingerprint(source);
  if (unsigned.sourceId !== source.id || unsigned.sourceFingerprint !== sourceFingerprint) throw new Error("EXTERNAL_V2_READ_POLICY_SOURCE_MISMATCH");
  if (!source.allowedChainIds.includes(unsigned.chainId)) throw new Error("EXTERNAL_V2_READ_POLICY_CHAIN_NOT_ALLOWED");
  const now = options.now ?? Date.now();
  const issuedAt = parseCanonicalTimestamp(unsigned.issuedAt, "EXTERNAL_V2_READ_POLICY_ISSUED_AT_INVALID");
  const expiresAt = parseCanonicalTimestamp(unsigned.expiresAt, "EXTERNAL_V2_READ_POLICY_EXPIRES_AT_INVALID");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error("EXTERNAL_V2_READ_POLICY_FROM_FUTURE");
  if (expiresAt <= now) throw new Error("EXTERNAL_V2_READ_POLICY_EXPIRED");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw new Error("EXTERNAL_V2_READ_POLICY_VALIDITY_INVALID");
  const payload = canonicalSignedExternalEvmV2ReadPolicyPayload(unsigned);
  const payloadHash = keccak256(toUtf8Bytes(payload));
  let recoveredSigner: string;
  try { recoveredSigner = getAddress(verifyMessage(payload, signature as string)); }
  catch { throw new Error("EXTERNAL_V2_READ_POLICY_SIGNATURE_INVALID"); }
  if (recoveredSigner !== source.signerAddress) throw new Error("EXTERNAL_V2_READ_POLICY_SIGNER_NOT_PINNED");
  if (options.previousHead) {
    const head = options.previousHead;
    if (!Number.isSafeInteger(head.revision) || head.revision <= 0 || !/^0x[0-9a-f]{64}$/.test(head.payloadHash)) throw new Error("EXTERNAL_V2_READ_POLICY_HEAD_INVALID");
    if (unsigned.revision < head.revision) throw new Error("EXTERNAL_V2_READ_POLICY_ROLLBACK_BLOCKED");
    if (unsigned.revision === head.revision && payloadHash !== head.payloadHash) throw new Error("EXTERNAL_V2_READ_POLICY_REVISION_CONFLICT");
  }
  return {
    schema: "realdex.verified-external-evm-v2-read-policy.v2",
    status: "verified-design-gate",
    executionEnabled: false,
    signingEnabled: false,
    submissionEnabled: false,
    source,
    sourceFingerprint,
    policy: { ...unsigned, signature: signature as string },
    payloadHash,
    verifiedAt: now
  };
}

export function revalidateExternalEvmV2ReadPolicy(value: VerifiedExternalEvmV2ReadPolicy, now = Date.now()): VerifiedExternalEvmV2ReadPolicy {
  const keys = ["schema", "status", "executionEnabled", "signingEnabled", "submissionEnabled", "source", "sourceFingerprint", "policy", "payloadHash", "verifiedAt"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || value.schema !== "realdex.verified-external-evm-v2-read-policy.v2" || value.status !== "verified-design-gate" || value.executionEnabled !== false || value.signingEnabled !== false || value.submissionEnabled !== false || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt <= 0 || value.verifiedAt > now) throw new Error("EXTERNAL_V2_READ_POLICY_VERIFICATION_INVALID");
  const verified = verifySignedExternalEvmV2ReadPolicy(value.policy, value.source, { now, previousHead: { revision: value.policy.revision, payloadHash: value.payloadHash } });
  if (verified.sourceFingerprint !== value.sourceFingerprint || verified.payloadHash !== value.payloadHash) throw new Error("EXTERNAL_V2_READ_POLICY_VERIFICATION_INVALID");
  return verified;
}

export async function verifyPolicyBoundExternalEvmV2Venue(input: {
  venueSource: unknown;
  signedVenueManifest: unknown;
  previousVenueHead?: ExternalEvmV2VenueSourceHead;
  venueId: string;
  readPolicy: VerifiedExternalEvmV2ReadPolicy;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<PolicyBoundExternalEvmV2Venue> {
  const { manifest, identity, policy, readers } = resolvePolicyBoundExternalEvmV2Readers(input);
  const verified = await verifyExternalEvmV2VenueQuorum(identity, readers);
  return {
    ...verified,
    venueSourceFingerprint: externalEvmV2VenueSourceFingerprint(manifest.source),
    venueManifestPayloadHash: manifest.payloadHash,
    readPolicySourceFingerprint: policy.sourceFingerprint,
    readPolicyPayloadHash: policy.payloadHash,
    signingEnabled: false,
    submissionEnabled: false
  };
}

export async function quotePolicyBoundExternalEvmV2ExactIn(input: {
  venueSource: unknown;
  signedVenueManifest: unknown;
  previousVenueHead?: ExternalEvmV2VenueSourceHead;
  readPolicy: VerifiedExternalEvmV2ReadPolicy;
  intent: unknown;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<PolicyBoundExternalEvmV2Quote> {
  const now = input.now ?? Date.now();
  const intent = validateExternalEvmV2QuoteIntent(input.intent, now);
  const { manifest, identity, policy, readers } = resolvePolicyBoundExternalEvmV2Readers({ ...input, venueId: intent.venueId, now });
  if (intent.chainId !== `eip155:${identity.chainId}`) throw new Error("EXTERNAL_V2_QUOTE_INTENT_CHAIN_MISMATCH");
  const verifiedVenue = await verifyExternalEvmV2VenueQuorum(identity, readers);
  const deadlineCeiling = Math.floor(Date.parse(intent.expiresAt) / 1_000);
  const quotes = await Promise.all(readers.map((reader, index) => {
    const observation = verifiedVenue.observations[index];
    const venue: VerifiedExternalEvmV2Venue = {
      status: "verified",
      identity: verifiedVenue.identity,
      fingerprint: verifiedVenue.fingerprint,
      observedCodeHashes: {
        router: observation.routerCodeHash,
        factory: observation.factoryCodeHash,
        pairs: [...observation.pairCodeHashes]
      }
    };
    return quoteExternalEvmV2ExactIn(venue, BigInt(intent.amountInBaseUnits), intent.slippageBps, intent.recipient, reader, now, deadlineCeiling);
  }));
  if (!sameExternalEvmV2Quote(quotes[0], quotes[1])) throw new Error("EXTERNAL_V2_QUOTE_RPC_DIVERGED");
  const verifiedAt = input.now ?? Date.now();
  const finalManifest = verifySignedExternalEvmV2VenueManifest(input.signedVenueManifest, input.venueSource, { now: verifiedAt, previousHead: input.previousVenueHead });
  const finalPolicy = revalidateExternalEvmV2ReadPolicy(policy, verifiedAt);
  if (finalManifest.payloadHash !== manifest.payloadHash || finalPolicy.payloadHash !== policy.payloadHash || Date.parse(intent.expiresAt) <= verifiedAt || quotes[0].deadline <= Math.floor(verifiedAt / 1_000)) throw new Error("EXTERNAL_V2_QUOTE_INTENT_EXPIRED");
  const observations = quotes.map((quote, index): ExternalEvmV2QuoteObservation => ({
    readerId: readers[index].id,
    quoteId: quote.quoteId,
    amounts: [...quote.amounts],
    minimumOut: quote.minimumOut,
    calldata: quote.calldata
  })) as [ExternalEvmV2QuoteObservation, ExternalEvmV2QuoteObservation];
  return {
    schema: "realdex.policy-bound-external-evm-v2-quote.v1",
    status: "verified-design-gate",
    executionEnabled: false,
    signingEnabled: false,
    submissionEnabled: false,
    venue: {
      ...verifiedVenue,
      venueSourceFingerprint: externalEvmV2VenueSourceFingerprint(manifest.source),
      venueManifestPayloadHash: manifest.payloadHash,
      readPolicySourceFingerprint: policy.sourceFingerprint,
      readPolicyPayloadHash: policy.payloadHash,
      signingEnabled: false,
      submissionEnabled: false
    },
    intent,
    intentFingerprint: externalEvmV2QuoteIntentFingerprint(intent, verifiedAt),
    verifiedAt,
    quote: quotes[0],
    slippageBps: intent.slippageBps,
    observations
  };
}

export async function revalidatePolicyBoundExternalEvmV2Quote(input: {
  venueSource: unknown;
  signedVenueManifest: unknown;
  previousVenueHead?: ExternalEvmV2VenueSourceHead;
  readPolicy: VerifiedExternalEvmV2ReadPolicy;
  expectedQuote: PolicyBoundExternalEvmV2Quote;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<PolicyBoundExternalEvmV2QuoteRevalidation> {
  const now = input.now ?? Date.now();
  assertPolicyBoundExternalEvmV2Quote(input.expectedQuote, now);
  const fresh = await quotePolicyBoundExternalEvmV2ExactIn({
    venueSource: input.venueSource,
    signedVenueManifest: input.signedVenueManifest,
    previousVenueHead: input.previousVenueHead,
    readPolicy: input.readPolicy,
    intent: input.expectedQuote.intent,
    fetchImpl: input.fetchImpl,
    now: input.now
  });
  if (!samePolicyBoundExternalEvmV2Quote(input.expectedQuote, fresh)) throw new Error("EXTERNAL_V2_QUOTE_CHANGED_RECONFIRM_REQUIRED");
  return {
    schema: "realdex.policy-bound-external-evm-v2-quote-revalidation.v1",
    status: "verified-design-gate",
    executionEnabled: false,
    signingEnabled: false,
    submissionEnabled: false,
    expectedQuoteId: input.expectedQuote.quote.quoteId,
    expectedIntentFingerprint: input.expectedQuote.intentFingerprint,
    revalidatedAt: fresh.verifiedAt,
    quote: fresh
  };
}

function assertPolicyBoundExternalEvmV2Quote(value: PolicyBoundExternalEvmV2Quote, now: number): void {
  const keys = ["schema", "status", "executionEnabled", "signingEnabled", "submissionEnabled", "venue", "intent", "intentFingerprint", "verifiedAt", "quote", "slippageBps", "observations"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || value.schema !== "realdex.policy-bound-external-evm-v2-quote.v1" || value.status !== "verified-design-gate" || value.executionEnabled !== false || value.signingEnabled !== false || value.submissionEnabled !== false || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt <= 0 || value.verifiedAt > now) throw new Error("EXTERNAL_V2_POLICY_QUOTE_REPORT_INVALID");
  if (!value.venue || value.venue.status !== "verified-design-gate" || value.venue.executionEnabled !== false || value.venue.signingEnabled !== false || value.venue.submissionEnabled !== false) throw new Error("EXTERNAL_V2_POLICY_QUOTE_REPORT_INVALID");
  const intent = validateExternalEvmV2QuoteIntent(value.intent, now);
  if (value.intentFingerprint !== externalEvmV2QuoteIntentFingerprint(intent, now) || value.slippageBps !== intent.slippageBps || value.quote.deadline <= Math.floor(now / 1_000) || !Array.isArray(value.observations) || value.observations.length !== 2) throw new Error("EXTERNAL_V2_POLICY_QUOTE_REPORT_INVALID");
}

function samePolicyBoundExternalEvmV2Quote(left: PolicyBoundExternalEvmV2Quote, right: PolicyBoundExternalEvmV2Quote): boolean {
  return left.intentFingerprint === right.intentFingerprint
    && left.venue.fingerprint === right.venue.fingerprint
    && left.venue.venueSourceFingerprint === right.venue.venueSourceFingerprint
    && left.venue.venueManifestPayloadHash === right.venue.venueManifestPayloadHash
    && left.venue.readPolicySourceFingerprint === right.venue.readPolicySourceFingerprint
    && left.venue.readPolicyPayloadHash === right.venue.readPolicyPayloadHash
    && sameExternalEvmV2Quote(left.quote, right.quote)
    && left.observations.length === right.observations.length
    && left.observations.every((observation, index) => observation.readerId === right.observations[index].readerId && observation.quoteId === right.observations[index].quoteId && observation.minimumOut === right.observations[index].minimumOut && observation.calldata === right.observations[index].calldata && observation.amounts.length === right.observations[index].amounts.length && observation.amounts.every((amount, amountIndex) => amount === right.observations[index].amounts[amountIndex]));
}

function resolvePolicyBoundExternalEvmV2Readers(input: {
  venueSource: unknown;
  signedVenueManifest: unknown;
  previousVenueHead?: ExternalEvmV2VenueSourceHead;
  venueId: string;
  readPolicy: VerifiedExternalEvmV2ReadPolicy;
  fetchImpl?: typeof fetch;
  now?: number;
}) {
  const manifest = verifySignedExternalEvmV2VenueManifest(input.signedVenueManifest, input.venueSource, { now: input.now, previousHead: input.previousVenueHead });
  const identity = manifest.identities.find((candidate) => candidate.venueId === input.venueId);
  if (!identity) throw new Error("EXTERNAL_V2_MANIFEST_VENUE_NOT_FOUND");
  const policy = revalidateExternalEvmV2ReadPolicy(input.readPolicy, input.now);
  if (policy.policy.chainId !== `eip155:${identity.chainId}`) throw new Error("EXTERNAL_V2_READ_POLICY_VENUE_CHAIN_MISMATCH");
  if (policy.source.signerAddress === manifest.source.signerAddress) throw new Error("EXTERNAL_V2_READ_POLICY_REVIEWER_NOT_INDEPENDENT");
  const readers = createExternalEvmV2PublicReadQuorum(policy.policy.rpcEndpoints, input.fetchImpl);
  return { manifest, identity, policy, readers };
}

function sameExternalEvmV2Quote(left: ExternalEvmV2Quote, right: ExternalEvmV2Quote): boolean {
  return left.quoteId === right.quoteId
    && left.venueFingerprint === right.venueFingerprint
    && left.amountIn === right.amountIn
    && left.minimumOut === right.minimumOut
    && left.recipient === right.recipient
    && left.deadline === right.deadline
    && left.calldata === right.calldata
    && left.amounts.length === right.amounts.length
    && left.amounts.every((amount, index) => amount === right.amounts[index]);
}

function validateUnsignedPolicy(value: unknown): Omit<SignedExternalEvmV2ReadPolicy, "signature"> {
  const policy = strictObject(value, ["schema", "sourceId", "sourceFingerprint", "revision", "issuedAt", "expiresAt", "chainId", "rpcEndpoints", "verificationBoundaryId", "quoteBoundaryId", "evidenceUrls"], "EXTERNAL_V2_READ_POLICY_INVALID");
  if (policy.schema !== "realdex.signed-external-evm-v2-read-policy.v2" || typeof policy.sourceId !== "string" || !SOURCE_ID.test(policy.sourceId) || typeof policy.sourceFingerprint !== "string" || !/^0x[0-9a-f]{64}$/.test(policy.sourceFingerprint) || !Number.isSafeInteger(policy.revision) || Number(policy.revision) <= 0 || typeof policy.issuedAt !== "string" || typeof policy.expiresAt !== "string" || typeof policy.chainId !== "string" || !EIP155.test(policy.chainId)) throw new Error("EXTERNAL_V2_READ_POLICY_IDENTITY_INVALID");
  if (policy.verificationBoundaryId !== EXTERNAL_EVM_V2_VERIFICATION_BOUNDARY_ID) throw new Error("EXTERNAL_V2_READ_POLICY_BOUNDARY_MISMATCH");
  if (policy.quoteBoundaryId !== EXTERNAL_EVM_V2_QUOTE_BOUNDARY_ID) throw new Error("EXTERNAL_V2_READ_POLICY_QUOTE_BOUNDARY_MISMATCH");
  if (!Array.isArray(policy.rpcEndpoints) || policy.rpcEndpoints.length !== 2 || policy.rpcEndpoints.some((endpoint) => typeof endpoint !== "string")) throw new Error("EXTERNAL_V2_READ_POLICY_ENDPOINTS_INVALID");
  let rpcEndpoints: [string, string];
  try { rpcEndpoints = assertDistinctPublicRpcEndpoints(policy.rpcEndpoints as string[]) as [string, string]; }
  catch { throw new Error("EXTERNAL_V2_READ_POLICY_ENDPOINTS_NOT_PUBLIC_OR_INDEPENDENT"); }
  return {
    schema: policy.schema,
    sourceId: policy.sourceId,
    sourceFingerprint: policy.sourceFingerprint,
    revision: policy.revision as number,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
    chainId: policy.chainId,
    rpcEndpoints,
    verificationBoundaryId: policy.verificationBoundaryId,
    quoteBoundaryId: policy.quoteBoundaryId,
    evidenceUrls: validEvidenceUrls(policy.evidenceUrls, "EXTERNAL_V2_READ_POLICY_EVIDENCE_INVALID")
  };
}

function strictObject(value: unknown, keys: readonly string[], error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(error);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) throw new Error(error);
  return object;
}

function validEvidenceUrls(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || new Set(value).size !== value.length || value.some((entry) => {
    if (typeof entry !== "string") return true;
    try { const url = new URL(entry); return url.protocol !== "https:" || Boolean(url.username || url.password) || entry.length > 2_048; } catch { return true; }
  })) throw new Error(error);
  return [...value] as string[];
}

function normalizedAddress(value: unknown, error: string): string { try { if (typeof value !== "string") throw new Error(); return getAddress(value); } catch { throw new Error(error); } }
function parseCanonicalTimestamp(value: string, error: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(error); return parsed; }
