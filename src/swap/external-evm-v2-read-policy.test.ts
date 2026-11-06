import { Interface, Wallet, keccak256 } from "ethers";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalSignedExternalEvmV2VenueManifestPayload,
  externalEvmV2VenueSourceFingerprint,
  serializeExternalEvmV2VenueIdentity,
  type ExternalEvmV2VenueSourceDescriptor,
  type SignedExternalEvmV2VenueManifest
} from "./external-evm-v2-source";
import type { ExternalEvmV2VenueIdentity } from "./external-evm-v2";
import {
  EXTERNAL_EVM_V2_VERIFICATION_BOUNDARY_ID,
  EXTERNAL_EVM_V2_QUOTE_BOUNDARY_ID,
  canonicalSignedExternalEvmV2ReadPolicyPayload,
  externalEvmV2ReadPolicySourceFingerprint,
  externalEvmV2QuoteIntentFingerprint,
  quotePolicyBoundExternalEvmV2ExactIn,
  revalidatePolicyBoundExternalEvmV2Quote,
  revalidateExternalEvmV2ReadPolicy,
  verifyPolicyBoundExternalEvmV2Venue,
  verifySignedExternalEvmV2ReadPolicy,
  validateExternalEvmV2QuoteIntent,
  type ExternalEvmV2ReadPolicySourceDescriptor,
  type SignedExternalEvmV2ReadPolicy
} from "./external-evm-v2-read-policy";

const now = 1_800_000_000_000;
const venueSigner = new Wallet(`0x${"11".repeat(32)}`);
const policySigner = new Wallet(`0x${"22".repeat(32)}`);
const router = "0x1000000000000000000000000000000000000001";
const factory = "0x2000000000000000000000000000000000000002";
const token0 = "0x3000000000000000000000000000000000000003";
const token1 = "0x4000000000000000000000000000000000000004";
const pair = "0x5000000000000000000000000000000000000005";
const runtime = "0x6001";
const venue: ExternalEvmV2VenueIdentity = {
  schema: "realdex.external-evm-v2-venue.v1", venueId: "policy-bound-v2", chainId: 84532n,
  router: { address: router, runtimeCodeHash: keccak256(runtime) }, factory: { address: factory, runtimeCodeHash: keccak256(runtime) },
  path: [token0, token1], pairs: [{ address: pair, runtimeCodeHash: keccak256(runtime), token0, token1 }], feeBps: 30,
  evidenceUrls: ["https://evidence.example.org/router", "https://evidence.example.net/factory"]
};
const venueSource: ExternalEvmV2VenueSourceDescriptor = {
  schema: "realdex.external-evm-v2-source.v1", id: "reviewed.external.v2", name: "Reviewed External V2",
  signerAddress: venueSigner.address, allowedChainIds: ["eip155:84532"], evidenceUrls: ["https://policy.example.org/venue-source"]
};
const policySource: ExternalEvmV2ReadPolicySourceDescriptor = {
  schema: "realdex.external-evm-v2-read-policy-source.v1", id: "independent.external.v2.read", name: "Independent External V2 read policy",
  signerAddress: policySigner.address, allowedChainIds: ["eip155:84532"], evidenceUrls: ["https://policy.example.org/read-source"]
};

describe("signed External EVM V2 read policy", () => {
  it("accepts exact chain, boundary, and distinct public RPC hosts with execution disabled", async () => {
    const verified = verifySignedExternalEvmV2ReadPolicy(await signedPolicy(), policySource, { now });
    expect(verified).toMatchObject({ schema: "realdex.verified-external-evm-v2-read-policy.v2", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, submissionEnabled: false });
    expect(verified.sourceFingerprint).toBe(externalEvmV2ReadPolicySourceFingerprint(policySource));
    expect(verified.policy.rpcEndpoints).toEqual(["https://rpc-a.example.org/", "https://rpc-b.example.net/"]);
  });

  it("rejects signature, source, boundary, chain, unknown fields, and unsafe endpoint substitution", async () => {
    const policy = await signedPolicy();
    expect(() => verifySignedExternalEvmV2ReadPolicy({ ...policy, revision: 2 }, policySource, { now })).toThrow("EXTERNAL_V2_READ_POLICY_SIGNER_NOT_PINNED");
    expect(() => verifySignedExternalEvmV2ReadPolicy(policy, { ...policySource, id: "substituted.external.read" }, { now })).toThrow("EXTERNAL_V2_READ_POLICY_SOURCE_MISMATCH");
    await expect(signedPolicy({ verificationBoundaryId: "other" as typeof EXTERNAL_EVM_V2_VERIFICATION_BOUNDARY_ID })).rejects.toThrow("EXTERNAL_V2_READ_POLICY_BOUNDARY_MISMATCH");
    await expect(signedPolicy({ quoteBoundaryId: "other" as typeof EXTERNAL_EVM_V2_QUOTE_BOUNDARY_ID })).rejects.toThrow("EXTERNAL_V2_READ_POLICY_QUOTE_BOUNDARY_MISMATCH");
    const wrongChain = await signedPolicy({ chainId: "eip155:1" });
    expect(() => verifySignedExternalEvmV2ReadPolicy(wrongChain, policySource, { now })).toThrow("EXTERNAL_V2_READ_POLICY_CHAIN_NOT_ALLOWED");
    expect(() => verifySignedExternalEvmV2ReadPolicy({ ...policy, executionEnabled: true }, policySource, { now })).toThrow("EXTERNAL_V2_READ_POLICY_INVALID");
    await expect(signedPolicy({ rpcEndpoints: ["http://127.0.0.1:8545", "https://rpc-b.example.net"] })).rejects.toThrow("EXTERNAL_V2_READ_POLICY_ENDPOINTS_NOT_PUBLIC_OR_INDEPENDENT");
    await expect(signedPolicy({ rpcEndpoints: ["https://same.example.org/a", "https://same.example.org/b"] })).rejects.toThrow("EXTERNAL_V2_READ_POLICY_ENDPOINTS_NOT_PUBLIC_OR_INDEPENDENT");
  });

  it("rejects expiry, excessive validity, rollback, equivocation, malformed heads, and accepted-object mutation", async () => {
    const expired = await signedPolicy({ issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now).toISOString() });
    expect(() => verifySignedExternalEvmV2ReadPolicy(expired, policySource, { now })).toThrow("EXTERNAL_V2_READ_POLICY_EXPIRED");
    const excessive = await signedPolicy({ issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString() });
    expect(() => verifySignedExternalEvmV2ReadPolicy(excessive, policySource, { now })).toThrow("EXTERNAL_V2_READ_POLICY_VALIDITY_INVALID");
    const revisionTwo = verifySignedExternalEvmV2ReadPolicy(await signedPolicy({ revision: 2 }), policySource, { now });
    const rollback = await signedPolicy({ revision: 1 });
    expect(() => verifySignedExternalEvmV2ReadPolicy(rollback, policySource, { now, previousHead: { revision: 2, payloadHash: revisionTwo.payloadHash } })).toThrow("EXTERNAL_V2_READ_POLICY_ROLLBACK_BLOCKED");
    const equivocation = await signedPolicy({ revision: 2, evidenceUrls: ["https://policy.example.org/changed"] });
    expect(() => verifySignedExternalEvmV2ReadPolicy(equivocation, policySource, { now, previousHead: { revision: 2, payloadHash: revisionTwo.payloadHash } })).toThrow("EXTERNAL_V2_READ_POLICY_REVISION_CONFLICT");
    expect(() => verifySignedExternalEvmV2ReadPolicy(revisionTwo.policy, policySource, { now, previousHead: { revision: 0, payloadHash: "bad" } })).toThrow("EXTERNAL_V2_READ_POLICY_HEAD_INVALID");
    expect(() => revalidateExternalEvmV2ReadPolicy({ ...revisionTwo, executionEnabled: true } as never, now + 1)).toThrow("EXTERNAL_V2_READ_POLICY_VERIFICATION_INVALID");
  });

  it("freshly binds venue manifest, independent policy, chain, and policy-derived readers", async () => {
    const signedVenueManifest = await venueManifest();
    const readPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy(), policySource, { now });
    const fetchImpl = rpcFetch();
    const verified = await verifyPolicyBoundExternalEvmV2Venue({ venueSource, signedVenueManifest, venueId: venue.venueId, readPolicy, fetchImpl, now });
    expect(verified).toMatchObject({ status: "verified-design-gate", executionEnabled: false, signingEnabled: false, submissionEnabled: false, readPolicyPayloadHash: readPolicy.payloadHash });
    expect(verified.venueSourceFingerprint).toBe(externalEvmV2VenueSourceFingerprint(venueSource));
    expect(fetchImpl).toHaveBeenCalled();

    const wrongSource = { ...policySource, allowedChainIds: ["eip155:1"] };
    const wrongPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy({ chainId: "eip155:1" }, wrongSource, policySigner), wrongSource, { now });
    await expect(verifyPolicyBoundExternalEvmV2Venue({ venueSource, signedVenueManifest, venueId: venue.venueId, readPolicy: wrongPolicy, fetchImpl, now })).rejects.toThrow("EXTERNAL_V2_READ_POLICY_VENUE_CHAIN_MISMATCH");
    const sameKeySource = { ...policySource, signerAddress: venueSigner.address };
    const sameKeyPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy({}, sameKeySource, venueSigner), sameKeySource, { now });
    await expect(verifyPolicyBoundExternalEvmV2Venue({ venueSource, signedVenueManifest, venueId: venue.venueId, readPolicy: sameKeyPolicy, fetchImpl, now })).rejects.toThrow("EXTERNAL_V2_READ_POLICY_REVIEWER_NOT_INDEPENDENT");
  });

  it("requires both policy-selected RPCs to return the same reserves, router quote, and calldata", async () => {
    const signedVenueManifest = await venueManifest();
    const readPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy(), policySource, { now });
    const result = await quotePolicyBoundExternalEvmV2ExactIn({
      venueSource, signedVenueManifest, readPolicy, intent: quoteIntent(), fetchImpl: rpcFetch(), now
    });
    expect(result).toMatchObject({
      schema: "realdex.policy-bound-external-evm-v2-quote.v1",
      status: "verified-design-gate",
      executionEnabled: false,
      signingEnabled: false,
      submissionEnabled: false,
      slippageBps: 50
    });
    expect(result.quote.amounts).toEqual([10_000n, 19_743n]);
    expect(result.quote.minimumOut).toBe(19_644n);
    expect(result.quote.deadline).toBe(Math.floor((now + 240_000) / 1_000));
    expect(result.intentFingerprint).toBe(externalEvmV2QuoteIntentFingerprint(quoteIntent(), now));
    expect(result.observations.map((observation) => observation.readerId)).toEqual(["rpc-a.example.org", "rpc-b.example.net"]);
    expect({ ...result.observations[0], readerId: undefined }).toEqual({ ...result.observations[1], readerId: undefined });
    expect(result.venue.readPolicyPayloadHash).toBe(readPolicy.payloadHash);
  });

  it("fails closed when independently valid RPC quotes disagree", async () => {
    const signedVenueManifest = await venueManifest();
    const readPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy(), policySource, { now });
    await expect(quotePolicyBoundExternalEvmV2ExactIn({
      venueSource, signedVenueManifest, readPolicy, intent: quoteIntent(), fetchImpl: rpcFetch({ secondReserveOut: 2_100_000n }), now
    })).rejects.toThrow("EXTERNAL_V2_QUOTE_RPC_DIVERGED");
  });

  it("strictly binds venue, chain, amount, recipient, slippage, and a short quote lifetime", async () => {
    expect(validateExternalEvmV2QuoteIntent(quoteIntent(), now)).toMatchObject({ venueId: venue.venueId, chainId: "eip155:84532", amountInBaseUnits: "10000", recipient: token0 });
    expect(() => validateExternalEvmV2QuoteIntent({ ...quoteIntent(), extra: true }, now)).toThrow("EXTERNAL_V2_QUOTE_INTENT_INVALID");
    expect(() => validateExternalEvmV2QuoteIntent({ ...quoteIntent(), amountInBaseUnits: "010000" }, now)).toThrow("EXTERNAL_V2_QUOTE_INTENT_IDENTITY_INVALID");
    expect(() => validateExternalEvmV2QuoteIntent({ ...quoteIntent(), expiresAt: new Date(now).toISOString() }, now)).toThrow("EXTERNAL_V2_QUOTE_INTENT_EXPIRED");
    expect(() => validateExternalEvmV2QuoteIntent({ ...quoteIntent(), expiresAt: new Date(now + 301_000).toISOString() }, now)).toThrow("EXTERNAL_V2_QUOTE_INTENT_VALIDITY_INVALID");
    const signedVenueManifest = await venueManifest();
    const readPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy(), policySource, { now });
    await expect(quotePolicyBoundExternalEvmV2ExactIn({ venueSource, signedVenueManifest, readPolicy, intent: { ...quoteIntent(), chainId: "eip155:1" }, fetchImpl: rpcFetch(), now })).rejects.toThrow("EXTERNAL_V2_QUOTE_INTENT_CHAIN_MISMATCH");
  });

  it("rejects a quote that expires while the RPC quorum is being collected", async () => {
    const signedVenueManifest = await venueManifest(now + 300_000);
    const readPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy({ expiresAt: new Date(now + 300_000).toISOString() }), policySource, { now });
    const dateNow = vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 101_000);
    try {
      await expect(quotePolicyBoundExternalEvmV2ExactIn({ venueSource, signedVenueManifest, readPolicy, intent: { ...quoteIntent(), expiresAt: new Date(now + 100_000).toISOString() }, fetchImpl: rpcFetch() })).rejects.toThrow("EXTERNAL_V2_QUOTE_INTENT_EXPIRED");
    } finally { dateNow.mockRestore(); }
  });

  it("revalidates the exact accepted quote without granting execution authority", async () => {
    const signedVenueManifest = await venueManifest();
    const readPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy(), policySource, { now });
    const expectedQuote = await quotePolicyBoundExternalEvmV2ExactIn({ venueSource, signedVenueManifest, readPolicy, intent: quoteIntent(), fetchImpl: rpcFetch(), now });
    const result = await revalidatePolicyBoundExternalEvmV2Quote({ venueSource, signedVenueManifest, readPolicy, expectedQuote, fetchImpl: rpcFetch(), now: now + 10_000 });
    expect(result).toMatchObject({ schema: "realdex.policy-bound-external-evm-v2-quote-revalidation.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, submissionEnabled: false, expectedQuoteId: expectedQuote.quote.quoteId, expectedIntentFingerprint: expectedQuote.intentFingerprint, revalidatedAt: now + 10_000 });
    expect(result.quote.quote).toEqual(expectedQuote.quote);
  });

  it("requires renewed confirmation when the fresh two-reader quote changes", async () => {
    const signedVenueManifest = await venueManifest();
    const readPolicy = verifySignedExternalEvmV2ReadPolicy(await signedPolicy(), policySource, { now });
    const expectedQuote = await quotePolicyBoundExternalEvmV2ExactIn({ venueSource, signedVenueManifest, readPolicy, intent: quoteIntent(), fetchImpl: rpcFetch(), now });
    await expect(revalidatePolicyBoundExternalEvmV2Quote({ venueSource, signedVenueManifest, readPolicy, expectedQuote, fetchImpl: rpcFetch({ reserveOut: 2_100_000n }), now: now + 10_000 })).rejects.toThrow("EXTERNAL_V2_QUOTE_CHANGED_RECONFIRM_REQUIRED");
    await expect(revalidatePolicyBoundExternalEvmV2Quote({ venueSource, signedVenueManifest, readPolicy, expectedQuote: { ...expectedQuote, executionEnabled: true } as never, fetchImpl: rpcFetch(), now: now + 10_000 })).rejects.toThrow("EXTERNAL_V2_POLICY_QUOTE_REPORT_INVALID");
    await expect(revalidatePolicyBoundExternalEvmV2Quote({ venueSource, signedVenueManifest, readPolicy, expectedQuote: { ...expectedQuote, venue: { ...expectedQuote.venue, executionEnabled: true } } as never, fetchImpl: rpcFetch(), now: now + 10_000 })).rejects.toThrow("EXTERNAL_V2_POLICY_QUOTE_REPORT_INVALID");
  });
});

function quoteIntent() {
  return {
    schema: "realdex.external-evm-v2-quote-intent.v1" as const,
    venueId: venue.venueId,
    chainId: "eip155:84532",
    amountInBaseUnits: "10000",
    slippageBps: 50,
    recipient: token0,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 240_000).toISOString()
  };
}

async function signedPolicy(
  changes: Partial<Omit<SignedExternalEvmV2ReadPolicy, "signature">> = {},
  source = policySource,
  signer = policySigner
): Promise<SignedExternalEvmV2ReadPolicy> {
  const unsigned: Omit<SignedExternalEvmV2ReadPolicy, "signature"> = {
    schema: "realdex.signed-external-evm-v2-read-policy.v2", sourceId: source.id, sourceFingerprint: externalEvmV2ReadPolicySourceFingerprint(source), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), chainId: source.allowedChainIds[0],
    rpcEndpoints: ["https://rpc-a.example.org", "https://rpc-b.example.net"], verificationBoundaryId: EXTERNAL_EVM_V2_VERIFICATION_BOUNDARY_ID,
    quoteBoundaryId: EXTERNAL_EVM_V2_QUOTE_BOUNDARY_ID,
    evidenceUrls: ["https://policy.example.org/read-policy"], ...changes
  };
  return { ...unsigned, signature: await signer.signMessage(canonicalSignedExternalEvmV2ReadPolicyPayload(unsigned)) };
}

async function venueManifest(expiresAt = now + 60_000): Promise<SignedExternalEvmV2VenueManifest> {
  const unsigned: Omit<SignedExternalEvmV2VenueManifest, "signature"> = {
    schema: "realdex.signed-external-evm-v2-venues.v1", sourceId: venueSource.id, sourceFingerprint: externalEvmV2VenueSourceFingerprint(venueSource), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(expiresAt).toISOString(), venues: [serializeExternalEvmV2VenueIdentity(venue)], evidenceUrls: ["https://policy.example.org/venue-revision"]
  };
  return { ...unsigned, signature: await venueSigner.signMessage(canonicalSignedExternalEvmV2VenueManifestPayload(unsigned)) };
}

function rpcFetch(options: { reserveOut?: bigint; secondReserveOut?: bigint } = {}) {
  const routerAbi = new Interface(["function factory() view returns (address)", "function getAmountsOut(uint256,address[]) view returns (uint256[])"]);
  const factoryAbi = new Interface(["function getPair(address,address) view returns (address)"]);
  const pairAbi = new Interface(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"]);
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: string; data: string }] };
    let result = "0x14a34";
    if (body.method === "eth_getCode") result = runtime;
    if (body.method === "eth_call") {
      const selector = body.params[0].data.slice(0, 10);
      const reserveIn = 1_000_000n;
      const baseReserveOut = options.reserveOut ?? 2_000_000n;
      const reserveOut = String(url).includes("rpc-b.example.net") && options.secondReserveOut ? options.secondReserveOut : baseReserveOut;
      if (selector === routerAbi.getFunction("factory")!.selector || selector === pairAbi.getFunction("factory")!.selector) result = routerAbi.encodeFunctionResult("factory", [factory]);
      else if (selector === factoryAbi.getFunction("getPair")!.selector) result = factoryAbi.encodeFunctionResult("getPair", [pair]);
      else if (selector === pairAbi.getFunction("token0")!.selector) result = pairAbi.encodeFunctionResult("token0", [token0]);
      else if (selector === pairAbi.getFunction("token1")!.selector) result = pairAbi.encodeFunctionResult("token1", [token1]);
      else if (selector === pairAbi.getFunction("getReserves")!.selector) result = pairAbi.encodeFunctionResult("getReserves", [reserveIn, reserveOut, 0]);
      else if (selector === routerAbi.getFunction("getAmountsOut")!.selector) {
        const [amountIn] = routerAbi.decodeFunctionData("getAmountsOut", body.params[0].data);
        const input = BigInt(amountIn);
        const inputWithFee = input * 997n;
        const output = (inputWithFee * reserveOut) / (reserveIn * 1_000n + inputWithFee);
        result = routerAbi.encodeFunctionResult("getAmountsOut", [[input, output]]);
      }
      else throw new Error(`unexpected selector ${selector}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
  });
}
