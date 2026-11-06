import { Secp256k1, ripemd160, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { base64 } from "@scure/base";
import { makeSignBytes, makeSignDoc } from "@cosmjs/proto-signing";
import { canonicalProtoFields } from "./canonical-protobuf";
import { cosmosSignedSwapSlotKey, persistCosmosSignedSwapEvidence, readCosmosSignedSwapSlot, readCosmosSigningSlot, reserveCosmosInjectedSigning, type CosmosSignedSwapJournalStorage } from "./cosmos-signed-swap-journal";
import type { CrossTabExecutionLockManager } from "../routing/cross-tab-execution-lock";
import { requestCosmosInjectedSwapSignature } from "./cosmos-injected-direct-signing";
import { createCosmosSignedSwapRecoveryRecord, refreshCosmosSwapRecovery } from "./cosmos-swap-recovery";
import { refreshPolicyBoundCosmosRecovery } from "./cosmos-policy-bound-recovery";
import { assertGenuineCosmosInjectedSignedSwapEvidence, verifyCosmosInjectedSignedSwap } from "./cosmos-injected-signed-swap-evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectCosmosInjectedWallet,
  type CosmosInjectedConnection
} from "../wallet/cosmos-injected-session";
import {
  assertGenuineCosmosInjectedSigningPreparation,
  prepareCosmosInjectedSigning
} from "./cosmos-injected-signing-preparation";
import { COSMOS_SWAP_BOUNDARY_ID, type CosmosSwapIntent } from "./cosmos-swap-boundary";
import {
  canonicalSignedCosmosReadPolicyPayload,
  cosmosReadPolicySourceFingerprint,
  verifySignedCosmosReadPolicy,
  type CosmosReadPolicySourceDescriptor,
  type SignedCosmosReadPolicy
} from "./cosmos-read-policy";
import {
  canonicalSignedOsmosisRouteManifestPayload,
  assertVerifiedSourceBoundOsmosisSwap,
  cosmosVenueSourceFingerprint,
  verifySignedOsmosisRouteManifest,
  verifySourceBoundOsmosisSwap,
  type CosmosVenueSourceDescriptor,
  type SignedOsmosisRouteManifest
} from "./cosmos-venue-source";
import { createOsmosisExactInVenue, type OsmosisExactInRouteDescriptor } from "./osmosis-exact-in-decoder";

const now = 1_788_200_000_000;
const privateKey = new Uint8Array(32).fill(7);
const publisherPublicKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(privateKey).pubkey);
const readPolicyPrivateKey = new Uint8Array(32).fill(8);
const readPolicyPublicKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(readPolicyPrivateKey).pubkey);
const walletPrivateKey = new Uint8Array(32).fill(9);
const walletPublicKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(walletPrivateKey).pubkey);
const sender = toBech32("osmo", ripemd160(sha256(walletPublicKey)));
const destinationDenom = `ibc/${"A".repeat(64)}`;
const route: OsmosisExactInRouteDescriptor = {
  schema: "realdex.osmosis-exact-in-route.v1", venueId: "reviewed-osmosis-route", revision: 1,
  chainId: "cosmos:osmo-test-5", bech32Prefix: "osmo", sourceDenom: "uosmo", destinationDenom,
  hops: [{ poolId: "12", tokenOutDenom: "uion" }, { poolId: "34", tokenOutDenom: destinationDenom }],
  evidenceUrls: ["https://github.com/osmosis-labs/osmosis/blob/main/proto/osmosis/gamm/v1beta1/tx.proto", "https://github.com/osmosis-labs/osmosis/blob/main/x/poolmanager/README.md"]
};
const source: CosmosVenueSourceDescriptor = {
  schema: "realdex.cosmos-venue-source.v1", id: "reviewed.cosmos.routes", name: "Reviewed Cosmos routes",
  signerPublicKeyBase64: base64.encode(publisherPublicKey), allowedChainIds: [route.chainId], evidenceUrls: ["https://policy.example.org/cosmos"]
};
const readPolicySource: CosmosReadPolicySourceDescriptor = {
  schema: "realdex.cosmos-read-policy-source.v1", id: "independent.cosmos.read-policy", name: "Independent Cosmos read policy",
  signerPublicKeyBase64: base64.encode(readPolicyPublicKey), allowedChainIds: [route.chainId], evidenceUrls: ["https://policy.example.org/cosmos/read-source"]
};
const liveConnections: CosmosInjectedConnection[] = [];

afterEach(() => {
  for (const connection of liveConnections) connection.dispose();
  liveConnections.length = 0;
  vi.restoreAllMocks();
});

describe("signed Cosmos/Osmosis venue source", () => {
  it("accepts an exact low-S secp256k1-signed route manifest without enabling broadcast", () => {
    const manifest = signedManifest([route]);
    const verified = verifySignedOsmosisRouteManifest(manifest, source, { now });
    expect(verified).toMatchObject({ status: "verified-design-gate", executionEnabled: false, broadcastEnabled: false, sourceFingerprint: cosmosVenueSourceFingerprint(source) });
    expect(verified.routes).toEqual([route]);
    expect(verified.routeFingerprints[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects mutation, source/chain substitution, unknown fields, and duplicate routes", () => {
    const manifest = signedManifest([route]);
    expect(() => verifySignedOsmosisRouteManifest({ ...manifest, revision: 2 }, source, { now })).toThrow("COSMOS_VENUE_MANIFEST_SIGNER_NOT_PINNED");
    expect(() => verifySignedOsmosisRouteManifest(manifest, { ...source, id: "another.cosmos.source" }, { now })).toThrow("COSMOS_VENUE_MANIFEST_SOURCE_MISMATCH");
    expect(() => verifySignedOsmosisRouteManifest({ ...manifest, extra: true }, source, { now })).toThrow("COSMOS_VENUE_MANIFEST_INVALID");
    expect(() => verifySignedOsmosisRouteManifest(signedManifest([route, route]), source, { now })).toThrow("COSMOS_VENUE_MANIFEST_ROUTE_DUPLICATE");
    expect(() => verifySignedOsmosisRouteManifest(signedManifest([{ ...route, chainId: "cosmos:another-1" }]), source, { now })).toThrow("COSMOS_VENUE_MANIFEST_CHAIN_NOT_ALLOWED");
    expect(() => verifySignedOsmosisRouteManifest(signedManifest([{ ...route, hops: [{ ...route.hops[0], extra: true } as never, route.hops[1]] }]), source, { now })).toThrow("OSMOSIS_EXACT_IN_ROUTE_INVALID");
  });

  it("rejects expiry, excessive validity, high-S signatures, rollback, equivocation, and malformed heads", () => {
    const expired = signedManifest([route], { issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now).toISOString() });
    expect(() => verifySignedOsmosisRouteManifest(expired, source, { now })).toThrow("COSMOS_VENUE_MANIFEST_EXPIRED");
    const long = signedManifest([route], { issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString() });
    expect(() => verifySignedOsmosisRouteManifest(long, source, { now })).toThrow("COSMOS_VENUE_MANIFEST_VALIDITY_INVALID");
    const revisionTwo = signedManifest([route], { revision: 2 });
    const accepted = verifySignedOsmosisRouteManifest(revisionTwo, source, { now });
    expect(() => verifySignedOsmosisRouteManifest(signedManifest([route], { revision: 1 }), source, { now, previousHead: { revision: 2, payloadHash: accepted.payloadHash } })).toThrow("COSMOS_VENUE_MANIFEST_ROLLBACK_BLOCKED");
    expect(() => verifySignedOsmosisRouteManifest(signedManifest([{ ...route, revision: 2 }], { revision: 2 }), source, { now, previousHead: { revision: 2, payloadHash: accepted.payloadHash } })).toThrow("COSMOS_VENUE_MANIFEST_REVISION_CONFLICT");
    expect(() => verifySignedOsmosisRouteManifest(revisionTwo, source, { now, previousHead: { revision: 0, payloadHash: "bad" } })).toThrow("COSMOS_VENUE_MANIFEST_HEAD_INVALID");
    const signature = base64.decode(revisionTwo.signatureBase64), order = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"), s = bytesToBigInt(signature.slice(32));
    const highS = concat(signature.slice(0, 32), bigintBytes(order - s));
    expect(() => verifySignedOsmosisRouteManifest({ ...revisionTwo, signatureBase64: base64.encode(highS) }, source, { now })).toThrow("COSMOS_VENUE_MANIFEST_HIGH_S_SIGNATURE");
  });

  it("freshly re-verifies the signed route before canonical TxRaw and two-REST simulation", async () => {
    const manifest = signedManifest([route]);
    const { intent, fetchImpl } = swapFixture(route);
    const readPolicy = verifySignedCosmosReadPolicy(signedReadPolicy(), readPolicySource, { now });
    const result = await verifySourceBoundOsmosisSwap({ source, signedManifest: manifest, venueId: route.venueId, intent, readPolicy, fetchImpl, now });
    expect(result).toMatchObject({ venueId: route.venueId, sourceDebitBaseUnits: "1000000", destinationCreditBaseUnits: "950000", execution: "design-gate", executionEnabled: false, broadcastEnabled: false });
    expect(result.sourceFingerprint).toBe(cosmosVenueSourceFingerprint(source));
    expect(result.readPolicySourceFingerprint).toBe(cosmosReadPolicySourceFingerprint(readPolicySource));
    expect(result.readPolicyPayloadHash).toBe(readPolicy.payloadHash);
    expect(result.publicKeyHex).toBe(hex(walletPublicKey));
    expect(result.executionTarget).toBe("osmosis:gamm:12>34");
    expect(result.expiresAt).toBe(now + 60_000);
    expect(() => assertVerifiedSourceBoundOsmosisSwap(result)).not.toThrow();
    expect(() => assertVerifiedSourceBoundOsmosisSwap(structuredClone(result))).toThrow("COSMOS_VERIFIED_SWAP_NOT_AUTHENTIC");
    await expect(verifySourceBoundOsmosisSwap({ source, signedManifest: { ...manifest, revision: 2 }, venueId: route.venueId, intent, readPolicy, fetchImpl, now })).rejects.toThrow("COSMOS_VENUE_MANIFEST_SIGNER_NOT_PINNED");
    await expect(verifySourceBoundOsmosisSwap({ source, signedManifest: manifest, venueId: "missing", intent, readPolicy, fetchImpl, now })).rejects.toThrow("COSMOS_VENUE_MANIFEST_ROUTE_NOT_FOUND");
    const wrongChainSource = { ...readPolicySource, allowedChainIds: ["cosmos:other-test-1"] };
    const wrongChainPolicy = verifySignedCosmosReadPolicy(signedReadPolicy({ chainId: "cosmos:other-test-1" }, wrongChainSource, readPolicyPrivateKey), wrongChainSource, { now });
    await expect(verifySourceBoundOsmosisSwap({ source, signedManifest: manifest, venueId: route.venueId, intent, readPolicy: wrongChainPolicy, fetchImpl, now })).rejects.toThrow("COSMOS_READ_POLICY_ROUTE_CHAIN_MISMATCH");
    const sameKeySource = { ...readPolicySource, signerPublicKeyBase64: source.signerPublicKeyBase64 };
    const sameKeyPolicy = verifySignedCosmosReadPolicy(signedReadPolicy({}, sameKeySource, privateKey), sameKeySource, { now });
    await expect(verifySourceBoundOsmosisSwap({ source, signedManifest: manifest, venueId: route.venueId, intent, readPolicy: sameKeyPolicy, fetchImpl, now })).rejects.toThrow("COSMOS_READ_POLICY_REVIEWER_NOT_INDEPENDENT");
  });
});

describe("Cosmos injected signing preparation", () => {
  it("creates a frozen exact review package without reading signing or broadcast capabilities", async () => {
    const fixture = await sourceBoundFixture();
    const session = await walletSession();
    const preparation = await prepareCosmosInjectedSigning({ ...fixture, ...session, now: now + 2 });
    expect(preparation).toMatchObject({
      schema: "realdex.cosmos-injected-signing-preparation.v1",
      authority: sender,
      chainId: route.chainId,
      walletChainId: "osmo-test-5",
      publicKeyHex: hex(walletPublicKey),
      venueId: route.venueId,
      executionTarget: "osmosis:gamm:12>34",
      amountInBaseUnits: "1000000",
      expectedOutBaseUnits: "950000",
      minimumOutBaseUnits: "900000",
      requiresFreshVerification: true,
      signingEnabled: false,
      broadcastEnabled: false,
      executionEnabled: false
    });
    expect(preparation.preparationId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.isFrozen(preparation)).toBe(true);
    expect(session.provider.signReads).toBe(0);
    expect(session.provider.sendReads).toBe(0);
    expect(() => assertGenuineCosmosInjectedSigningPreparation(preparation)).not.toThrow();
    expect(() => assertGenuineCosmosInjectedSigningPreparation(structuredClone(preparation))).toThrow("COSMOS_SIGNING_PREPARATION_NOT_AUTHENTIC");
  });

  it("rejects cloned, forged and mutated source-bound verification evidence", async () => {
    const fixture = await sourceBoundFixture();
    const session = await walletSession();
    await expect(prepareCosmosInjectedSigning({ ...fixture, verified: structuredClone(fixture.verified), ...session, now: now + 2 })).rejects.toThrow("COSMOS_VERIFIED_SWAP_NOT_AUTHENTIC");
    const forged = { ...fixture.verified, routeFingerprint: "00".repeat(32) };
    await expect(prepareCosmosInjectedSigning({ ...fixture, verified: forged, ...session, now: now + 2 })).rejects.toThrow("COSMOS_VERIFIED_SWAP_NOT_AUTHENTIC");
    fixture.verified.gasUsed = "1";
    await expect(prepareCosmosInjectedSigning({ ...fixture, ...session, now: now + 2 })).rejects.toThrow("COSMOS_VERIFIED_SWAP_CHANGED");
  });

  it("rejects cloned bindings, another genuine account and stale quote time", async () => {
    const fixture = await sourceBoundFixture();
    const session = await walletSession();
    await expect(prepareCosmosInjectedSigning({ ...fixture, connection: session.connection, binding: structuredClone(session.binding), now: now + 2 })).rejects.toThrow("COSMOS_INJECTED_BINDING_NOT_CURRENT");

    const otherKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(new Uint8Array(32).fill(10)).pubkey);
    const other = await walletSession(otherKey);
    await expect(prepareCosmosInjectedSigning({ ...fixture, ...other, now: now + 2 })).rejects.toThrow("COSMOS_SIGNING_PREPARATION_ACCOUNT_MISMATCH");
    await expect(prepareCosmosInjectedSigning({ ...fixture, ...session, now: now + 60_000 })).rejects.toThrow("COSMOS_SIGNING_PREPARATION_EVIDENCE_EXPIRED");
    await expect(prepareCosmosInjectedSigning({ ...fixture, ...session, now: fixture.intent.quoteExpiresAt })).rejects.toThrow("COSMOS_SIGNING_PREPARATION_EXPIRED");
  });

  it("rejects changed unsigned bytes and intent fields instead of preparing stale evidence", async () => {
    const fixture = await sourceBoundFixture();
    const session = await walletSession();
    const changedBytes = base64.decode(fixture.intent.transactionBase64);
    changedBytes[changedBytes.length - 1] ^= 1;
    await expect(prepareCosmosInjectedSigning({ ...fixture, intent: { ...fixture.intent, transactionBase64: base64.encode(changedBytes) }, ...session, now: now + 2 })).rejects.toThrow("COSMOS_SIGNING_PREPARATION_HASH_MISMATCH");
    await expect(prepareCosmosInjectedSigning({ ...fixture, intent: { ...fixture.intent, expectedOutBaseUnits: "949999" }, ...session, now: now + 2 })).rejects.toThrow("COSMOS_SIGNING_PREPARATION_EVIDENCE_MISMATCH");
  });

  it("observes a keystore event and silent key replacement before returning preparation authority", async () => {
    const eventFixture = await sourceBoundFixture();
    const events = new EventTarget();
    const eventSession = await walletSession(walletPublicKey, events);
    queueMicrotask(() => events.dispatchEvent(new Event("keplr_keystorechange")));
    await expect(prepareCosmosInjectedSigning({ ...eventFixture, ...eventSession, now: now + 2 })).rejects.toThrow(/COSMOS_INJECTED_(SESSION_INVALIDATED|ACCOUNT_CHANGED)/);

    const silentFixture = await sourceBoundFixture();
    const silentSession = await walletSession();
    const replacement = Secp256k1.compressPubkey(Secp256k1.makeKeypair(new Uint8Array(32).fill(11)).pubkey);
    queueMicrotask(() => { silentSession.provider.currentKey = walletKey(replacement); });
    await expect(prepareCosmosInjectedSigning({ ...silentFixture, ...silentSession, now: now + 2 })).rejects.toThrow("COSMOS_INJECTED_ACCOUNT_CHANGED");
  });
});

describe("Cosmos injected signed-but-not-submitted evidence", () => {
  it("verifies a synthetic DIRECT signature without retaining transaction bytes or granting submission", async () => {
    const input = await signedEvidenceFixture();
    const evidence = await verifyCosmosInjectedSignedSwap(input);
    expect(evidence).toMatchObject({ stage: "signed-not-submitted", authority: sender,
      preparationId: input.preparation.preparationId, signedTransactionBytesStored: false,
      automaticResendBlocked: true, requiresExplicitSubmissionAuthorization: true,
      signingEnabled: false, broadcastEnabled: false, executionEnabled: false, submissionEnabled: false });
    expect(evidence.transactionHash).toBe(input.transactionHash);
    expect(evidence.signedTransactionSha256.toUpperCase()).toBe(input.transactionHash);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(evidence).not.toHaveProperty("transactionBase64");
    expect(evidence).not.toHaveProperty("signedTransactionBase64");
    expect(JSON.stringify(evidence)).not.toContain(input.signedTransactionBase64);
    expect(input.provider.signReads + input.provider.sendReads).toBe(0);
    expect(() => assertGenuineCosmosInjectedSignedSwapEvidence(evidence)).not.toThrow();
    expect(() => assertGenuineCosmosInjectedSignedSwapEvidence(structuredClone(evidence))).toThrow("COSMOS_SIGNED_SWAP_EVIDENCE_NOT_AUTHENTIC");
  });

  it("rejects cloned preparations, source results and bindings", async () => {
    const input = await signedEvidenceFixture();
    await expect(verifyCosmosInjectedSignedSwap({ ...input, preparation: structuredClone(input.preparation) })).rejects.toThrow("COSMOS_SIGNING_PREPARATION_NOT_AUTHENTIC");
    await expect(verifyCosmosInjectedSignedSwap({ ...input, verified: structuredClone(input.verified) })).rejects.toThrow("COSMOS_VERIFIED_SWAP_NOT_AUTHENTIC");
    await expect(verifyCosmosInjectedSignedSwap({ ...input, binding: structuredClone(input.binding) })).rejects.toThrow("COSMOS_INJECTED_BINDING_NOT_CURRENT");
  });

  it("rejects changed signed content, wrong-key and high-S signatures, and a substituted transaction hash", async () => {
    const input = await signedEvidenceFixture();
    const fields = canonicalProtoFields(base64.decode(input.signedTransactionBase64), { 1: [2, 1], 2: [2, 1], 3: [2, 1] }, "TEST_TX");
    const body = fields.get(1)![0].bytes!, auth = fields.get(2)![0].bytes!, signature = fields.get(3)![0].bytes!;
    const changed = signedBytes(concat(body, Uint8Array.of(0)), auth, signature);
    await expect(verifyCosmosInjectedSignedSwap({ ...input, ...changed })).rejects.toThrow("COSMOS_SWAP_RECOVERY_SIGNED_CONTENT_MISMATCH");
    await expect(verifyCosmosInjectedSignedSwap({ ...input, ...signIntent(input.intent, privateKey) })).rejects.toThrow("COSMOS_SWAP_RECOVERY_SIGNATURE_INVALID");
    const order = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const high = concat(signature.slice(0, 32), bigintBytes(order - bytesToBigInt(signature.slice(32))));
    await expect(verifyCosmosInjectedSignedSwap({ ...input, ...signedBytes(body, auth, high) })).rejects.toThrow("COSMOS_SWAP_RECOVERY_SIGNATURE_INVALID");
    for (const malformed of [new Uint8Array(), new Uint8Array(63), new Uint8Array(64)]) {
      await expect(verifyCosmosInjectedSignedSwap({ ...input, ...signedBytes(body, auth, malformed) })).rejects.toThrow("COSMOS_SWAP_RECOVERY_SIGNATURE_INVALID");
    }
    await expect(verifyCosmosInjectedSignedSwap({ ...input, transactionHash: "A".repeat(64) })).rejects.toThrow("COSMOS_SWAP_RECOVERY_VERIFIED_EVIDENCE_MISMATCH");
  });

  it("rejects altered intent summaries and a different current session even for the same key", async () => {
    const input = await signedEvidenceFixture();
    await expect(verifyCosmosInjectedSignedSwap({ ...input, intent: { ...input.intent, minimumOutBaseUnits: "1" } })).rejects.toThrow("COSMOS_SWAP_RECOVERY_VERIFIED_EVIDENCE_MISMATCH");
    const other = await walletSession();
    await expect(verifyCosmosInjectedSignedSwap({ ...input, ...other })).rejects.toThrow("COSMOS_SIGNED_SWAP_ACCOUNT_MISMATCH");
    await expect(verifyCosmosInjectedSignedSwap({ ...input, now: input.preparation.expiresAt })).rejects.toThrow("COSMOS_SIGNED_SWAP_PREPARATION_EXPIRED");
  });

  it("rejects source mutation and keystore changes while revalidating the account", async () => {
    const input = await signedEvidenceFixture();
    input.provider.getKey.mockImplementation(async () => {
      input.verified.routeFingerprint = "0".repeat(64);
      return input.provider.currentKey;
    });
    await expect(verifyCosmosInjectedSignedSwap(input)).rejects.toThrow("COSMOS_VERIFIED_SWAP_CHANGED");
    const events = new EventTarget();
    const next = await signedEvidenceFixture(events);
    let reads = 0;
    next.provider.getKey.mockImplementation(async () => {
      if (++reads === 2) events.dispatchEvent(new Event("keplr_keystorechange"));
      return next.provider.currentKey;
    });
    await expect(verifyCosmosInjectedSignedSwap(next)).rejects.toThrow(/COSMOS_INJECTED_(ACCOUNT_CHANGED|SESSION_INVALIDATED)/);
  });

  it("snapshots caller intent and rejects live-clock expiry during the final account read", async () => {
    const input = await signedEvidenceFixture();
    input.provider.getKey.mockImplementation(async () => {
      input.intent.minimumOutBaseUnits = "1";
      return input.provider.currentKey;
    });
    const evidence = await verifyCosmosInjectedSignedSwap(input);
    expect(evidence.minimumOutBaseUnits).toBe("900000");

    const next = await signedEvidenceFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3);
    let reads = 0;
    next.provider.getKey.mockImplementation(async () => {
      if (++reads === 2) clock.mockReturnValue(next.preparation.expiresAt);
      return next.provider.currentKey;
    });
    await expect(verifyCosmosInjectedSignedSwap({ ...next, now: undefined })).rejects.toThrow("COSMOS_SIGNED_SWAP_PREPARATION_EXPIRED");
  });
});

describe("Cosmos policy-bound recovery", () => {
  it("refreshes signed evidence through both policy-selected hosts without enabling resend or broadcast", async () => {
    const fixture = await policyBoundRecoveryFixture();
    const result = await refreshPolicyBoundCosmosRecovery({
      evidence: fixture.evidence, record: fixture.record, policy: fixture.policy, readHead: fixture.readHead
    }, { fetchImpl: fixture.fetchImpl, now: () => now + 10 });
    expect(result).toMatchObject({
      policySourceFingerprint: fixture.policy.sourceFingerprint, policyPayloadHash: fixture.policy.payloadHash,
      policyRevision: fixture.policy.policy.revision, checkedAt: now + 10,
      executionEnabled: false, broadcastEnabled: false, resendBlocked: true
    });
    expect(result.record).toMatchObject({ transactionHash: fixture.evidence.transactionHash, stage: "committed-success", resendBlocked: true });
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(6);
    expect(fixture.fetchImpl.mock.calls.every(([request, init]) => {
      const url = new URL(String(request));
      return ["rest-a.example.org", "rest-b.example.net"].includes(url.hostname)
        && url.pathname === (url.pathname.endsWith("/node_info") ? "/cosmos/base/tendermint/v1beta1/node_info" : url.pathname.endsWith("/blocks/latest") ? "/cosmos/base/tendermint/v1beta1/blocks/latest" : `/cosmos/tx/v1beta1/txs/${fixture.evidence.transactionHash}`)
        && (init?.method ?? "GET") === "GET";
    })).toBe(true);
    expect(fixture.input.provider.signReads + fixture.input.provider.sendReads).toBe(0);
  });

  it("rejects legacy and forged recovery opt-ins before any REST request", async () => {
    const fixture = await policyBoundRecoveryFixture();
    const legacy = verifySignedCosmosReadPolicy(signedReadPolicy(), readPolicySource, { now });
    await expect(refreshPolicyBoundCosmosRecovery({ ...fixture, policy: legacy }, { fetchImpl: fixture.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_POLICY_NOT_AUTHORIZED");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();

    const forged = { ...legacy, policy: { ...legacy.policy, recoveryBoundaryId: "cosmos-swap-recovery-v1" } } as typeof fixture.policy;
    await expect(refreshPolicyBoundCosmosRecovery({ ...fixture, policy: forged }, { fetchImpl: fixture.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_READ_POLICY_SIGNER_NOT_PINNED");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("requires genuine evidence and exact receipt identity before reading either host", async () => {
    const fixture = await policyBoundRecoveryFixture();
    await expect(refreshPolicyBoundCosmosRecovery({ ...fixture, evidence: structuredClone(fixture.evidence) }, { fetchImpl: fixture.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_SIGNED_SWAP_EVIDENCE_NOT_AUTHENTIC");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    await expect(refreshPolicyBoundCosmosRecovery({ ...fixture, record: { ...fixture.record, amountInBaseUnits: "1000001" } }, { fetchImpl: fixture.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_EVIDENCE_MISMATCH");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    await expect(refreshPolicyBoundCosmosRecovery({ ...fixture, record: { ...fixture.record, venueRevision: fixture.record.venueRevision + 1 } }, { fetchImpl: fixture.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_EVIDENCE_MISMATCH");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a policy source substitution and a policy chain substitution before REST", async () => {
    const fixture = await policyBoundRecoveryFixture();
    const otherSource = { ...readPolicySource, id: "independent.cosmos.other-read-policy" };
    const otherPolicy = verifySignedCosmosReadPolicy(signedReadPolicy({ recoveryBoundaryId: "cosmos-swap-recovery-v1" }, otherSource), otherSource, { now });
    await expect(refreshPolicyBoundCosmosRecovery({ ...fixture, policy: otherPolicy }, { fetchImpl: fixture.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_POLICY_SOURCE_MISMATCH");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();

    const otherChainSource = { ...readPolicySource, allowedChainIds: [route.chainId, "cosmos:other-test-1"] };
    const otherChainPolicy = verifySignedCosmosReadPolicy(signedReadPolicy({ recoveryBoundaryId: "cosmos-swap-recovery-v1", chainId: "cosmos:other-test-1" }, otherChainSource), otherChainSource, { now });
    await expect(refreshPolicyBoundCosmosRecovery({ ...fixture, policy: otherChainPolicy }, { fetchImpl: fixture.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_POLICY_CHAIN_MISMATCH");
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("requires the exact current policy head and detects a head change after IO begins", async () => {
    const missing = await policyBoundRecoveryFixture();
    missing.readHead.mockReturnValue(undefined);
    await expect(refreshPolicyBoundCosmosRecovery({ ...missing }, { fetchImpl: missing.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_POLICY_HEAD_UNAVAILABLE");
    expect(missing.fetchImpl).not.toHaveBeenCalled();
    missing.readHead.mockImplementationOnce(() => { throw new Error("private storage diagnostic"); });
    await expect(refreshPolicyBoundCosmosRecovery({ ...missing }, { fetchImpl: missing.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_POLICY_HEAD_UNAVAILABLE");
    missing.readHead.mockReturnValueOnce({ revision: 0, payloadHash: missing.policy.payloadHash });
    await expect(refreshPolicyBoundCosmosRecovery({ ...missing }, { fetchImpl: missing.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_POLICY_HEAD_UNAVAILABLE");
    expect(missing.fetchImpl).not.toHaveBeenCalled();

    const changed = await policyBoundRecoveryFixture();
    changed.readHead.mockReturnValue({ revision: changed.policy.policy.revision + 1, payloadHash: "f".repeat(64) });
    await expect(refreshPolicyBoundCosmosRecovery({ ...changed }, { fetchImpl: changed.fetchImpl, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_POLICY_HEAD_MISMATCH");
    expect(changed.fetchImpl).not.toHaveBeenCalled();

    const pending = await policyBoundRecoveryFixture({ pending: true });
    const operation = refreshPolicyBoundCosmosRecovery({ ...pending }, { fetchImpl: pending.fetchImpl, now: () => now + 10 });
    await vi.waitFor(() => expect(pending.fetchImpl).toHaveBeenCalled());
    pending.headChanged = true;
    pending.release();
    await expect(operation).rejects.toThrow("COSMOS_RECOVERY_POLICY_HEAD_MISMATCH");
  });

  it("fails closed when policy expiry is observed before or during the HTTP quorum", async () => {
    const before = await policyBoundRecoveryFixture({ expiresAt: now + 4 });
    await expect(refreshPolicyBoundCosmosRecovery({ ...before }, { fetchImpl: before.fetchImpl, now: () => now + 5 })).rejects.toThrow("COSMOS_READ_POLICY_EXPIRED");
    expect(before.fetchImpl).not.toHaveBeenCalled();

    let clock = now + 10;
    const during = await policyBoundRecoveryFixture({ expiresAt: now + 100, pending: true });
    const operation = refreshPolicyBoundCosmosRecovery({ ...during }, { fetchImpl: during.fetchImpl, now: () => clock });
    await vi.waitFor(() => expect(during.fetchImpl).toHaveBeenCalled());
    clock = now + 101;
    during.release();
    await expect(operation).rejects.toThrow("COSMOS_READ_POLICY_EXPIRED");
  });

  it("honors cancellation before and during recovery IO", async () => {
    const before = await policyBoundRecoveryFixture();
    const beforeController = new AbortController();
    beforeController.abort();
    await expect(refreshPolicyBoundCosmosRecovery({ ...before }, { fetchImpl: before.fetchImpl, signal: beforeController.signal, now: () => now + 10 })).rejects.toThrow("COSMOS_RECOVERY_CANCELLED");
    expect(before.fetchImpl).not.toHaveBeenCalled();

    const during = await policyBoundRecoveryFixture({ pending: true });
    const controller = new AbortController();
    const operation = refreshPolicyBoundCosmosRecovery({ ...during }, { fetchImpl: during.fetchImpl, signal: controller.signal, now: () => now + 10 });
    await vi.waitFor(() => expect(during.fetchImpl).toHaveBeenCalled());
    controller.abort();
    await expect(operation).rejects.toThrow("COSMOS_RECOVERY_CANCELLED");
    expect(during.fetchImpl.mock.calls.every(([, init]) => Boolean(init?.signal))).toBe(true);
    during.release();
  });

  it("rejects invalid or backward clocks without performing network IO", async () => {
    const invalid = await policyBoundRecoveryFixture();
    await expect(refreshPolicyBoundCosmosRecovery({ ...invalid }, { fetchImpl: invalid.fetchImpl, now: () => Number.NaN })).rejects.toThrow("COSMOS_RECOVERY_TIME_INVALID");
    expect(invalid.fetchImpl).not.toHaveBeenCalled();
    const backward = await policyBoundRecoveryFixture();
    const advanced = await refreshPolicyBoundCosmosRecovery({ ...backward }, { fetchImpl: backward.fetchImpl, now: () => now + 10 });
    backward.fetchImpl.mockClear();
    await expect(refreshPolicyBoundCosmosRecovery({ ...backward, record: advanced.record }, { fetchImpl: backward.fetchImpl, now: () => advanced.record.updatedAt - 1 })).rejects.toThrow("COSMOS_RECOVERY_TIME_INVALID");
    expect(backward.fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a same-reviewer revision renewal and preserves terminal receipt continuity", async () => {
    const initial = await policyBoundRecoveryFixture({ evidenceChanges: { quoteExpiresAt: now + 5_000 } });
    const first = await refreshPolicyBoundCosmosRecovery({ ...initial }, { fetchImpl: initial.fetchImpl, now: () => now + 10_000 });
    expect(initial.evidence.expiresAt).toBeLessThan(now + 10_000);
    const renewed = verifySignedCosmosReadPolicy(signedReadPolicy({ recoveryBoundaryId: "cosmos-swap-recovery-v1", revision: 2, evidenceUrls: ["https://policy.example.org/cosmos/read-policy-v2"] }), readPolicySource, { now: now + 10_000, previousHead: { revision: 1, payloadHash: initial.policy.payloadHash } });
    const next = await policyBoundRecoveryFixture({ policy: renewed });
    const result = await refreshPolicyBoundCosmosRecovery({ evidence: initial.evidence, record: first.record, policy: renewed, readHead: next.readHead }, { fetchImpl: next.fetchImpl, now: () => now + 20_000 });
    expect(result).toMatchObject({ policyRevision: 2, executionEnabled: false, broadcastEnabled: false, resendBlocked: true });
    expect(result.record.stage).toBe("committed-success");
    expect(result.record.observations.map(({ transactionHeight, code }) => ({ transactionHeight, code }))).toEqual(first.record.observations.map(({ transactionHeight, code }) => ({ transactionHeight, code })));
  });
});

describe("Cosmos signed observation journal", () => {
  it("persists only bounded metadata and restores no execution or signature authority", async () => {
    const input = await signedEvidenceFixture();
    const evidence = await verifyCosmosInjectedSignedSwap(input);
    const { storage, locks, entries } = journalFixture();
    const receipt = await persistCosmosSignedSwapEvidence(evidence, { storage, locks });
    expect(receipt).toMatchObject({ stage: "signed-observed", submissionStatus: "unknown", executionEnabled: false, automaticResendBlocked: true });
    const restored = readCosmosSignedSwapSlot(evidence, { getItem: key => entries.get(key) ?? null, setItem: () => { throw new Error("read only"); } });
    expect(restored).toEqual(receipt);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(() => assertGenuineCosmosInjectedSignedSwapEvidence(restored as never)).toThrow("COSMOS_SIGNED_SWAP_EVIDENCE_NOT_AUTHENTIC");
    const serialized = entries.get(cosmosSignedSwapSlotKey(evidence))!;
    expect(serialized).not.toContain(input.signedTransactionBase64);
    expect(serialized).not.toContain(input.intent.transactionBase64);
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("sessionId");
    expect(input.provider.signReads + input.provider.sendReads).toBe(0);
  });

  it("is idempotent across fresh sessions and retains the first observation after expiry", async () => {
    const input = await signedEvidenceFixture();
    const first = await verifyCosmosInjectedSignedSwap(input);
    const options = journalFixture();
    const receipt = await persistCosmosSignedSwapEvidence(first, options);
    const second = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture());
    expect(second.evidenceId).not.toBe(first.evidenceId);
    vi.spyOn(Date, "now").mockReturnValue(first.expiresAt + 100_000);
    expect(await persistCosmosSignedSwapEvidence(second, options)).toEqual(receipt);
    expect(options.storage.setItem).toHaveBeenCalledTimes(1);
    expect(readCosmosSignedSwapSlot(first, options.storage)).toEqual(receipt);
  });

  it("blocks a different reviewed intent for the same sequence without overwriting", async () => {
    const first = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture());
    const options = journalFixture();
    const receipt = await persistCosmosSignedSwapEvidence(first, options);
    const second = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture(new EventTarget(), { quoteExpiresAt: now + 110_000 }));
    expect(second.transactionHash).toBe(first.transactionHash);
    expect(second.intentSha256).not.toBe(first.intentSha256);
    await expect(persistCosmosSignedSwapEvidence(second, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_SEQUENCE_CONFLICT");
    const differentTx = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture(new EventTarget(), { timeoutHeight: "1201" }));
    expect(differentTx.transactionHash).not.toBe(first.transactionHash);
    await expect(persistCosmosSignedSwapEvidence(differentTx, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_SEQUENCE_CONFLICT");
    expect(options.storage.setItem).toHaveBeenCalledTimes(1);
    expect(readCosmosSignedSwapSlot(first, options.storage)).toEqual(receipt);
  });

  it("excludes simultaneous tabs and refuses unavailable lock services before writing", async () => {
    const evidence = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture());
    const options = journalFixture();
    const first = persistCosmosSignedSwapEvidence(evidence, options);
    await expect(persistCosmosSignedSwapEvidence(evidence, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_BUSY");
    await first;
    expect(options.storage.setItem).toHaveBeenCalledTimes(1);
    const broken = journalFixture();
    const locks: CrossTabExecutionLockManager = { request: async () => { throw new Error("private service error"); } };
    await expect(persistCosmosSignedSwapEvidence(evidence, { ...broken, locks })).rejects.toThrow("COSMOS_SIGNED_JOURNAL_LOCK_UNAVAILABLE");
    expect(broken.storage.getItem).not.toHaveBeenCalled();
    expect(broken.storage.setItem).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", {});
    try {
      await expect(persistCosmosSignedSwapEvidence(evidence, { storage: broken.storage })).rejects.toThrow("COSMOS_SIGNED_JOURNAL_LOCK_UNAVAILABLE");
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects cloned evidence and keeps wallet/venue/session out of slot identity", async () => {
    const evidence = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture());
    const options = journalFixture();
    await expect(persistCosmosSignedSwapEvidence(structuredClone(evidence), options)).rejects.toThrow("COSMOS_SIGNED_SWAP_EVIDENCE_NOT_AUTHENTIC");
    expect(options.storage.setItem).not.toHaveBeenCalled();
    expect(cosmosSignedSwapSlotKey({ ...evidence, walletId: "other", venueId: "other", accountNumber: "12" } as typeof evidence)).toBe(cosmosSignedSwapSlotKey(evidence));
    expect(cosmosSignedSwapSlotKey({ ...evidence, sequence: "8" })).not.toBe(cosmosSignedSwapSlotKey(evidence));
    for (const sequence of ["07", "-1", "18446744073709551616"]) expect(() => cosmosSignedSwapSlotKey({ ...evidence, sequence })).toThrow("COSMOS_SIGNED_JOURNAL_SLOT_INVALID");
    expect(() => cosmosSignedSwapSlotKey({ ...evidence, authority: evidence.authority.toUpperCase() })).toThrow("COSMOS_SIGNED_JOURNAL_SLOT_INVALID");
  });

  it("treats corrupt, oversized, altered and cross-slot records as blockers, never empty slots", async () => {
    const evidence = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture());
    const options = journalFixture();
    const receipt = await persistCosmosSignedSwapEvidence(evidence, options);
    const key = cosmosSignedSwapSlotKey(evidence);
    for (const raw of ["", "null", "{}", "x".repeat(4097), JSON.stringify({ ...receipt, sequence: "8" }), JSON.stringify({ ...receipt, acceptedAt: receipt.acceptedAt + 1 }), JSON.stringify({ ...receipt, executionEnabled: true }), JSON.stringify({ ...receipt, transactionBase64: "unexpected" })]) {
      options.entries.set(key, raw);
      expect(() => readCosmosSignedSwapSlot(evidence, options.storage)).toThrow("COSMOS_SIGNED_JOURNAL_RECORD_INVALID");
      await expect(persistCosmosSignedSwapEvidence(evidence, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_RECORD_INVALID");
      expect(options.entries.get(key)).toBe(raw);
    }
    expect(options.storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("fails closed on storage errors and never clears a record after uncertain write outcome", async () => {
    const evidence = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture());
    const options = journalFixture();
    options.storage.getItem.mockImplementationOnce(() => { throw new Error("private read error"); });
    await expect(persistCosmosSignedSwapEvidence(evidence, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_READ_UNAVAILABLE");
    expect(options.storage.setItem).not.toHaveBeenCalled();
    options.storage.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    await expect(persistCosmosSignedSwapEvidence(evidence, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
    options.storage.getItem.mockImplementationOnce(() => null).mockImplementationOnce(() => { throw new Error("readback failure"); });
    await expect(persistCosmosSignedSwapEvidence(evidence, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
    expect(options.entries.size).toBe(1);
    const receipt = await persistCosmosSignedSwapEvidence(evidence, options);
    expect(receipt.transactionHash).toBe(evidence.transactionHash);
    expect(options.storage.setItem).toHaveBeenCalledTimes(2);
    const dropped = journalFixture();
    dropped.storage.setItem.mockImplementation(() => undefined);
    await expect(persistCosmosSignedSwapEvidence(evidence, dropped)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
  });
});

describe("Cosmos pre-signature sequence reservation", () => {
  it("also snapshots standalone signing preparation before its first wallet read", async () => {
    const input = await signedEvidenceFixture();
    const original = input.intent.minimumOutBaseUnits;
    input.provider.getKey.mockImplementationOnce(async () => {
      input.intent.minimumOutBaseUnits = "1";
      input.binding = structuredClone(input.binding);
      return input.provider.currentKey;
    });
    expect((await prepareCosmosInjectedSigning(input)).minimumOutBaseUnits).toBe(original);
  });

  it("reserves a fresh exact preparation without storing transaction bytes or enabling signing", async () => {
    const input = await signedEvidenceFixture();
    const options = journalFixture();
    const result = await reserveCosmosInjectedSigning({ ...input, now: now + 2 }, options);
    expect(result.preparation).toMatchObject({ signingEnabled: false, executionEnabled: false, broadcastEnabled: false });
    expect(result.reservation).toMatchObject({ stage: "signing-reserved", signingStatus: "unknown", executionEnabled: false, automaticResendBlocked: true, preparationId: result.preparation.preparationId });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reservation)).toBe(true);
    expect(() => assertGenuineCosmosInjectedSigningPreparation(result.preparation)).not.toThrow();
    const restored = readCosmosSigningSlot(input.intent, options.storage);
    expect(restored).toEqual(result.reservation);
    expect(() => assertGenuineCosmosInjectedSigningPreparation(restored as never)).toThrow("COSMOS_SIGNING_PREPARATION_NOT_AUTHENTIC");
    expect(() => readCosmosSignedSwapSlot(input.intent, options.storage)).toThrow("COSMOS_SIGNED_JOURNAL_SLOT_RESERVED");
    const serialized = [...options.entries.values()][0];
    expect(serialized).not.toContain(input.intent.transactionBase64);
    expect(serialized).not.toContain(input.signedTransactionBase64);
    expect(serialized).not.toContain("sessionId");
    expect(input.provider.signReads + input.provider.sendReads).toBe(0);
  });

  it("never releases or reissues an existing reservation on repetition, reload or expiry", async () => {
    const input = await signedEvidenceFixture();
    const options = journalFixture();
    const result = await reserveCosmosInjectedSigning(input, options);
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_SLOT_OCCUPIED");
    const reloaded = { ...options, storage: { getItem: (key: string) => options.entries.get(key) ?? null, setItem: vi.fn() } };
    await expect(reserveCosmosInjectedSigning({ ...input, now: result.preparation.expiresAt + 1 }, reloaded)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_SLOT_OCCUPIED");
    expect(reloaded.storage.setItem).not.toHaveBeenCalled();
    expect(readCosmosSigningSlot(input.intent, options.storage)).toEqual(result.reservation);
    expect(options.storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("advances only the matching reserved preparation to signed observation, then blocks new reservations", async () => {
    const input = await signedEvidenceFixture();
    const options = journalFixture();
    const { preparation } = await reserveCosmosInjectedSigning({ ...input, now: now + 2 }, options);
    const other = await verifyCosmosInjectedSignedSwap(await signedEvidenceFixture());
    await expect(persistCosmosSignedSwapEvidence(other, options)).rejects.toThrow("COSMOS_SIGNING_RESERVATION_MISMATCH");
    const evidence = await verifyCosmosInjectedSignedSwap({ ...input, preparation });
    const signed = await persistCosmosSignedSwapEvidence(evidence, options);
    expect(signed.stage).toBe("signed-observed");
    expect(readCosmosSigningSlot(input.intent, options.storage)).toEqual(signed);
    expect(await persistCosmosSignedSwapEvidence(evidence, options)).toEqual(signed);
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_SLOT_OCCUPIED");
    expect(options.storage.setItem).toHaveBeenCalledTimes(2);
  });

  it("holds the slot lock across async wallet reads and allows only one preparation", async () => {
    const input = await signedEvidenceFixture();
    const options = journalFixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    input.provider.getKey.mockImplementationOnce(async () => { entered = true; await pending; return input.provider.currentKey; });
    const first = reserveCosmosInjectedSigning(input, options);
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_BUSY");
    expect(options.storage.setItem).not.toHaveBeenCalled();
    release();
    await first;
    expect(options.storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("rejects an observation made before reservation even when the preparation identity matches", async () => {
    const input = await signedEvidenceFixture();
    const evidence = await verifyCosmosInjectedSignedSwap(input);
    const options = journalFixture();
    const result = await reserveCosmosInjectedSigning({ ...input, now: now + 4 }, options);
    expect(result.preparation.preparationId).toBe(evidence.preparationId);
    await expect(persistCosmosSignedSwapEvidence(evidence, options)).rejects.toThrow("COSMOS_SIGNING_RESERVATION_MISMATCH");
    expect(readCosmosSigningSlot(input.intent, options.storage)).toEqual(result.reservation);
  });

  it("preserves the blocking phase when reservation-to-signed writes fail or have unknown outcomes", async () => {
    const input = await signedEvidenceFixture();
    const options = journalFixture();
    const { preparation, reservation } = await reserveCosmosInjectedSigning({ ...input, now: now + 2 }, options);
    const evidence = await verifyCosmosInjectedSignedSwap({ ...input, preparation });
    options.storage.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    await expect(persistCosmosSignedSwapEvidence(evidence, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
    expect(readCosmosSigningSlot(input.intent, options.storage)).toEqual(reservation);
    options.storage.setItem.mockImplementationOnce((key, value) => {
      options.entries.set(key, value);
      options.storage.getItem.mockImplementationOnce(() => { throw new Error("unknown write result"); });
    });
    await expect(persistCosmosSignedSwapEvidence(evidence, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signed-observed");
    expect((await persistCosmosSignedSwapEvidence(evidence, options)).transactionHash).toBe(evidence.transactionHash);
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_SLOT_OCCUPIED");
    expect(options.storage.setItem).toHaveBeenCalledTimes(3);
  });

  it("snapshots caller-owned selectors before asynchronous account access", async () => {
    const input = await signedEvidenceFixture();
    const original = { ...input.intent };
    input.provider.getKey.mockImplementationOnce(async () => {
      input.intent.sequence = "8";
      input.intent.minimumOutBaseUnits = "1";
      input.binding = structuredClone(input.binding);
      return input.provider.currentKey;
    });
    const options = journalFixture();
    const result = await reserveCosmosInjectedSigning(input, options);
    expect(result.preparation.sequence).toBe(original.sequence);
    expect(result.preparation.minimumOutBaseUnits).toBe(original.minimumOutBaseUnits);
    expect(readCosmosSigningSlot(original, options.storage)).toEqual(result.reservation);
    expect(readCosmosSigningSlot(input.intent, options.storage)).toBeNull();
  });

  it("rejects invalid capabilities or stale evidence before a durable reservation", async () => {
    const input = await signedEvidenceFixture();
    const options = journalFixture();
    await expect(reserveCosmosInjectedSigning({ ...input, verified: structuredClone(input.verified) }, options)).rejects.toThrow("COSMOS_VERIFIED_SWAP_NOT_AUTHENTIC");
    await expect(reserveCosmosInjectedSigning({ ...input, binding: structuredClone(input.binding) }, options)).rejects.toThrow("COSMOS_INJECTED_BINDING_NOT_CURRENT");
    await expect(reserveCosmosInjectedSigning({ ...input, now: input.preparation.expiresAt }, options)).rejects.toThrow("COSMOS_SIGNING_PREPARATION_EVIDENCE_EXPIRED");
    expect(options.storage.setItem).not.toHaveBeenCalled();
  });

  it("retains a reservation when account invalidation or live expiry occurs after persistence", async () => {
    const events = new EventTarget();
    const input = await signedEvidenceFixture(events);
    const options = journalFixture();
    options.storage.setItem.mockImplementationOnce((key, value) => {
      options.entries.set(key, value);
      events.dispatchEvent(new Event("keplr_keystorechange"));
    });
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow(/COSMOS_INJECTED_(SESSION_INVALIDATED|ACCOUNT_CHANGED)/);
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-reserved");
    const next = await signedEvidenceFixture();
    const expiring = journalFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3);
    expiring.storage.setItem.mockImplementationOnce((key, value) => {
      expiring.entries.set(key, value);
      clock.mockReturnValue(next.preparation.expiresAt);
    });
    await expect(reserveCosmosInjectedSigning({ ...next, now: undefined }, expiring)).rejects.toThrow("COSMOS_SIGNING_RESERVATION_EXPIRED");
    expect(readCosmosSigningSlot(next.intent, expiring.storage)?.stage).toBe("signing-reserved");
  });

  it("keeps reservation state on quota/readback failures and refuses corrupt metadata", async () => {
    const input = await signedEvidenceFixture();
    const options = journalFixture();
    options.storage.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
    options.storage.setItem.mockImplementationOnce((key, value) => {
      options.entries.set(key, value);
      options.storage.getItem.mockImplementationOnce(() => { throw new Error("readback"); });
    });
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
    const reservation = readCosmosSigningSlot(input.intent, options.storage)!;
    expect(reservation.stage).toBe("signing-reserved");
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_SLOT_OCCUPIED");
    const key = cosmosSignedSwapSlotKey(input.intent);
    for (const change of [{ sequence: "8" }, { executionEnabled: true }, { expiresAt: 0 }, { preparationId: "invalid" }, { transactionBase64: "unexpected" }]) {
      options.entries.set(key, JSON.stringify({ ...reservation, ...change }));
      await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_RECORD_INVALID");
    }
    expect(options.storage.setItem).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a non-cooperating writer during async preparation", async () => {
    const input = await signedEvidenceFixture();
    const options = journalFixture();
    const evidence = await verifyCosmosInjectedSignedSwap(input);
    const staged = journalFixture();
    await persistCosmosSignedSwapEvidence(evidence, staged);
    const key = cosmosSignedSwapSlotKey(evidence), serialized = staged.entries.get(key)!;
    input.provider.getKey.mockImplementationOnce(async () => {
      options.entries.set(key, serialized);
      return input.provider.currentKey;
    });
    await expect(reserveCosmosInjectedSigning(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_SLOT_OCCUPIED");
    expect(options.entries.get(key)).toBe(serialized);
    expect(options.storage.setItem).not.toHaveBeenCalled();
  });
});

describe("Cosmos reserved DIRECT signing transport", () => {
  it("consumes before one exact signature request, verifies the response, and never broadcasts", async () => {
    const { input, options, signDirect } = await directSigningFixture();
    signDirect.mockImplementationOnce(async (...args) => {
      expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-requested");
      expect(args[0]).toBe("osmo-test-5");
      expect(args[1]).toBe(sender);
      expect(args[2]).toMatchObject({ accountNumber: "11", chainId: "osmo-test-5" });
      expect(args[3]).toEqual({ preferNoSetFee: true, preferNoSetMemo: true, disableBalanceCheck: false });
      return directSignResponse(args[2]);
    });
    const result = await requestCosmosInjectedSwapSignature(input, options);
    expect(result.record.stage).toBe("signed-observed");
    expect(result.recoveryRecord).toMatchObject({ stage: "signed-not-submitted", transactionHash: result.evidence.transactionHash, resendBlocked: true, refreshCount: 0 });
    expect(result.recoveryRecord).not.toHaveProperty("signedTransactionBase64");
    const recovered = await refreshCosmosSwapRecovery(result.recoveryRecord, ["recovery-a.example.org", "recovery-b.example.org"].map(id => ({
      id, chainId: async () => "osmo-test-5", blockHeight: async () => "1101",
      transaction: async (hash: string) => {
        expect(hash).toBe(result.evidence.transactionHash);
        return { transactionHash: hash, height: "1100", code: 0, codespace: "", gasWanted: "250000", gasUsed: "170000" };
      }
    })), result.recoveryRecord.createdAt + 1);
    expect(recovered.stage).toBe("committed-success");
    expect(recovered.resendBlocked).toBe(true);
    // Read-only recovery does not release the separately persisted signing slot.
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signed-observed");
    expect(result.submissionEnabled).toBe(false);
    expect(result.signedTransactionBase64).toBe(input.signedTransactionBase64);
    expect(() => assertGenuineCosmosInjectedSignedSwapEvidence(result.evidence)).not.toThrow();
    expect([...options.entries.values()].join()).not.toContain(result.signedTransactionBase64);
    expect(input.provider.sendReads).toBe(0);
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_SIGNING_RESERVATION_NOT_AVAILABLE");
    expect(signDirect).toHaveBeenCalledTimes(1);
  });

  it("requires the exact confirmation, genuine preparation and original provider", async () => {
    const { input, options, signDirect } = await directSigningFixture();
    await expect(requestCosmosInjectedSwapSignature({ ...input, confirmation: { ...input.confirmation, preparationId: "different" } }, options)).rejects.toThrow("COSMOS_DIRECT_SIGNING_CONFIRMATION_REQUIRED");
    await expect(requestCosmosInjectedSwapSignature({ ...input, preparation: structuredClone(input.preparation) }, options)).rejects.toThrow("COSMOS_SIGNING_PREPARATION_NOT_AUTHENTIC");
    await expect(requestCosmosInjectedSwapSignature({ ...input, provider: { ...input.provider } }, options)).rejects.toThrow("COSMOS_INJECTED_PROVIDER_MISMATCH");
    expect(signDirect).not.toHaveBeenCalled();
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-reserved");
  });

  it("does not execute signer accessors or fall back to another signing method", async () => {
    const { input, options, signDirect } = await directSigningFixture();
    const getter = vi.fn(() => signDirect);
    Object.defineProperty(input.provider, "signDirect", { get: getter, configurable: true });
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_DIRECT_SIGNING_METHOD_UNAVAILABLE");
    expect(getter).not.toHaveBeenCalled();
    expect(signDirect).not.toHaveBeenCalled();
  });

  it("rejects altered signed documents, public keys, malformed signatures and response accessors", async () => {
    const mutations = [
      (r: any) => { r.signed.bodyBytes[0] ^= 1; },
      (r: any) => { r.signed.authInfoBytes[0] ^= 1; },
      (r: any) => { r.signed.chainId = "other-chain"; },
      (r: any) => { r.signed.accountNumber = { low: 12, high: 0, unsigned: false }; },
      (r: any) => { r.signature.pub_key.value = base64.encode(publisherPublicKey); },
      (r: any) => { r.signature.signature = base64.encode(new Uint8Array(64)); }
    ];
    for (const mutate of mutations) {
      const { input, options, signDirect } = await directSigningFixture();
      signDirect.mockImplementationOnce(async (...args) => { const response = directSignResponse(args[2]); mutate(response); return response; });
      await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow(/COSMOS_(DIRECT_SIGNING_(DOCUMENT_CHANGED|RESPONSE_INVALID)|SWAP_RECOVERY_SIGNATURE_INVALID)/);
      expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-requested");
    }
    const { input, options, signDirect } = await directSigningFixture();
    const getter = vi.fn(() => { throw new Error("do not read"); });
    signDirect.mockImplementationOnce(async (...args) => {
      const response = directSignResponse(args[2]);
      Object.defineProperty(response.signed, "accountNumber", { get: getter });
      return response;
    });
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_DIRECT_SIGNING_RESPONSE_INVALID");
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps a rejected request consumed and does not expose wallet errors", async () => {
    const { input, options, signDirect } = await directSigningFixture();
    signDirect.mockRejectedValueOnce(new Error("private provider diagnostic"));
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_DIRECT_SIGNING_REQUEST_FAILED");
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_SIGNING_RESERVATION_NOT_AVAILABLE");
    expect(signDirect).toHaveBeenCalledTimes(1);
  });

  it("stops before invocation when claiming cannot be persisted or read back", async () => {
    const { input, options, signDirect } = await directSigningFixture();
    options.storage.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-reserved");
    options.storage.setItem.mockImplementationOnce((key, value) => {
      options.entries.set(key, value);
      options.storage.getItem.mockImplementationOnce(() => { throw new Error("readback"); });
    });
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE");
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-requested");
    expect(signDirect).not.toHaveBeenCalled();
  });

  it("blocks concurrent requests through cancellation until the raw provider settles and discards late responses", async () => {
    const { input, options, signDirect } = await directSigningFixture();
    let release!: (value: unknown) => void;
    signDirect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const operation = requestCosmosInjectedSwapSignature(input, { ...options, signal: controller.signal });
    const rejected = expect(operation).rejects.toThrow("COSMOS_DIRECT_SIGNING_CANCELLED");
    await vi.waitFor(() => expect(signDirect).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_DIRECT_SIGNING_PROVIDER_PENDING");
    release(directSignResponse(signDirect.mock.calls[0][2]));
    await vi.waitFor(async () => {
      await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_SIGNING_RESERVATION_NOT_AVAILABLE");
    });
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-requested");
    expect(signDirect).toHaveBeenCalledTimes(1);
  });

  it("times out observation without cancelling or retrying the raw wallet request", async () => {
    const { input, options, signDirect } = await directSigningFixture();
    let release!: (value: unknown) => void;
    signDirect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const operation = requestCosmosInjectedSwapSignature(input, { ...options, timeoutMs: 1000 });
    const rejected = expect(operation).rejects.toThrow("COSMOS_DIRECT_SIGNING_TIMEOUT");
    await vi.waitFor(() => expect(signDirect).toHaveBeenCalledTimes(1));
    await rejected;
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_DIRECT_SIGNING_PROVIDER_PENDING");
    release(directSignResponse(signDirect.mock.calls[0][2]));
    await vi.waitFor(async () => {
      await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_SIGNING_RESERVATION_NOT_AVAILABLE");
    });
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-requested");
  });

  it("rejects account changes or expiry during signing and retains requested history", async () => {
    const events = new EventTarget();
    const { input, options, signDirect } = await directSigningFixture(events);
    signDirect.mockImplementationOnce(async (...args) => { events.dispatchEvent(new Event("keplr_keystorechange")); return directSignResponse(args[2]); });
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_INJECTED_SESSION_INVALIDATED");
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-requested");
    const next = await directSigningFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3);
    next.signDirect.mockImplementationOnce(async (...args) => { clock.mockReturnValue(next.input.preparation.expiresAt); return directSignResponse(args[2]); });
    await expect(requestCosmosInjectedSwapSignature({ ...next.input, now: undefined }, next.options)).rejects.toThrow("COSMOS_SIGNED_SWAP_PREPARATION_EXPIRED");
  });

  it("rejects method replacement after reservation consumption without calling either method", async () => {
    const { input, options, signDirect } = await directSigningFixture();
    const replacement = vi.fn(async (...args: unknown[]) => directSignResponse(args[2]));
    options.storage.setItem.mockImplementationOnce((key, value) => {
      options.entries.set(key, value);
      Object.defineProperty(input.provider, "signDirect", { value: replacement, configurable: true });
    });
    await expect(requestCosmosInjectedSwapSignature(input, options)).rejects.toThrow("COSMOS_DIRECT_SIGNING_PROVIDER_CHANGED");
    expect(signDirect).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  });

  it("preserves account zero and uint64 precision at the provider boundary", async () => {
    for (const accountNumber of ["0", "18446744073709551615"]) {
      const { input, options, signDirect } = await directSigningFixture(new EventTarget(), { accountNumber });
      const result = await requestCosmosInjectedSwapSignature(input, options);
      expect(result.evidence.accountNumber).toBe(accountNumber);
      expect(signDirect.mock.calls[0][2]).toMatchObject({ accountNumber });
    }
  });

  it("blocks unreviewed hardware and pre-aborted requests before signer access", async () => {
    const hardware = await directSigningFixture(new EventTarget(), {}, true);
    await expect(requestCosmosInjectedSwapSignature(hardware.input, hardware.options)).rejects.toThrow("COSMOS_DIRECT_SIGNING_HARDWARE_UNSUPPORTED");
    expect(hardware.signDirect).not.toHaveBeenCalled();
    const { input, options, signDirect } = await directSigningFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(requestCosmosInjectedSwapSignature(input, { ...options, signal: controller.signal })).rejects.toThrow("COSMOS_DIRECT_SIGNING_CANCELLED");
    expect(signDirect).not.toHaveBeenCalled();
    expect(readCosmosSigningSlot(input.intent, options.storage)?.stage).toBe("signing-reserved");
  });
});

async function directSigningFixture(events = new EventTarget(), changes: Partial<CosmosSwapIntent> = {}, hardware = false) {
  const signDirect = vi.fn(async (...args: unknown[]) => directSignResponse(args[2]));
  const fixture = await signedEvidenceFixture(events, changes, signDirect, hardware);
  const options = journalFixture();
  const { preparation } = await reserveCosmosInjectedSigning({ ...fixture, now: now + 2 }, options);
  const input = { ...fixture, preparation, confirmation: {
    action: "request-cosmos-direct-signature-only" as const,
    preparationId: preparation.preparationId, transactionSha256: preparation.transactionSha256
  } };
  return { input, options, signDirect };
}

function directSignResponse(value: unknown): any {
  const doc = value as { bodyBytes: Uint8Array; authInfoBytes: Uint8Array; chainId: string; accountNumber: string };
  const signBytes = makeSignBytes(makeSignDoc(doc.bodyBytes, doc.authInfoBytes, doc.chainId, BigInt(doc.accountNumber)));
  const signature = Secp256k1.trimRecoveryByte(Secp256k1.createSignature(sha256(signBytes), walletPrivateKey).toFixedLength());
  const account = BigInt(doc.accountNumber);
  return { signed: { ...doc, bodyBytes: doc.bodyBytes.slice(), authInfoBytes: doc.authInfoBytes.slice(), accountNumber: { low: Number(BigInt.asIntN(32, account)), high: Number(BigInt.asIntN(32, account >> 32n)), unsigned: true } },
    signature: { pub_key: { type: "tendermint/PubKeySecp256k1", value: base64.encode(walletPublicKey) }, signature: base64.encode(signature) } };
}

function journalFixture() {
  const entries = new Map<string, string>();
  const held = new Set<string>();
  const storage = {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { entries.set(key, value); })
  } satisfies CosmosSignedSwapJournalStorage;
  const locks: CrossTabExecutionLockManager = {
    async request(name, options, callback) {
      expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); }
      finally { held.delete(name); }
    }
  };
  return { entries, storage, locks };
}

async function signedEvidenceFixture(events = new EventTarget(), changes: Partial<CosmosSwapIntent> = {}, signDirect?: (...args: unknown[]) => Promise<unknown>, hardware = false) {
  const fixture = await sourceBoundFixture(changes);
  const session = await walletSession(walletPublicKey, events, signDirect, hardware);
  const preparation = await prepareCosmosInjectedSigning({ ...fixture, ...session, now: now + 2 });
  return { ...fixture, ...session, preparation, venue: createOsmosisExactInVenue(route), ...signIntent(fixture.intent), now: now + 3 };
}

async function policyBoundRecoveryFixture(options: {
  expiresAt?: number;
  pending?: boolean;
  evidenceChanges?: Partial<CosmosSwapIntent>;
  policy?: Awaited<ReturnType<typeof verifySignedCosmosReadPolicy>>;
} = {}) {
  const input = await signedEvidenceFixture(new EventTarget(), options.evidenceChanges ?? {});
  const evidence = await verifyCosmosInjectedSignedSwap(input);
  const record = await createCosmosSignedSwapRecoveryRecord({ ...input, now: evidence.acceptedAt });
  const policy = options.policy ?? verifySignedCosmosReadPolicy(
    signedReadPolicy({ recoveryBoundaryId: "cosmos-swap-recovery-v1", ...(options.expiresAt === undefined ? {} : { expiresAt: new Date(options.expiresAt).toISOString() }) }),
    readPolicySource, { now }
  );
  const state = { headChanged: false };
  const transport = recoveryFetch(evidence.transactionHash, { pending: options.pending });
  const readHead = vi.fn((fingerprint: string) => {
    if (fingerprint !== policy.sourceFingerprint) return undefined;
    return state.headChanged
      ? { revision: policy.policy.revision + 1, payloadHash: "f".repeat(64) }
      : { revision: policy.policy.revision, payloadHash: policy.payloadHash };
  });
  return {
    input, evidence, record, policy, readHead, fetchImpl: transport.fetchImpl,
    release: transport.release, set headChanged(value: boolean) { state.headChanged = value; }, get headChanged() { return state.headChanged; }
  };
}

function recoveryFetch(transactionHash: string, options: { pending?: boolean } = {}) {
  let releaseGate: () => void = () => {};
  const gate = options.pending ? new Promise<void>(resolve => { releaseGate = resolve; }) : Promise.resolve();
  const fetchImpl = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    if (!["rest-a.example.org", "rest-b.example.net"].includes(url.hostname)) throw new Error(`unexpected recovery host ${url.hostname}`);
    if ((init?.method ?? "GET") !== "GET") throw new Error(`unexpected recovery method ${init?.method}`);
    if (options.pending) await waitForRecoveryGate(gate, init?.signal);
    if (url.pathname.endsWith("/node_info")) return jsonResponse({ default_node_info: { network: "osmo-test-5" } });
    if (url.pathname.endsWith("/blocks/latest")) return jsonResponse({ block: { header: { height: "1000" } } });
    if (url.pathname === `/cosmos/tx/v1beta1/txs/${transactionHash}`) return jsonResponse({ tx_response: {
      txhash: transactionHash, height: "999", code: 0, codespace: "", gas_wanted: "180000", gas_used: "170000"
    } });
    throw new Error(`unexpected recovery path ${url.pathname}`);
  });
  return { fetchImpl, release: releaseGate };
}

async function waitForRecoveryGate(gate: Promise<void>, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    gate.then(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, reject);
  });
}

function signIntent(intent: CosmosSwapIntent, signerKey = walletPrivateKey) {
  const fields = canonicalProtoFields(base64.decode(intent.transactionBase64), { 1: [2, 1], 2: [2, 1], 3: [2, 1] }, "TEST_TX");
  const body = fields.get(1)![0].bytes!, auth = fields.get(2)![0].bytes!;
  const signBytes = makeSignBytes(makeSignDoc(body, auth, "osmo-test-5", BigInt(intent.accountNumber)));
  const signature = Secp256k1.trimRecoveryByte(Secp256k1.createSignature(sha256(signBytes), signerKey).toFixedLength());
  return signedBytes(body, auth, signature);
}

function signedBytes(body: Uint8Array, auth: Uint8Array, signature: Uint8Array) {
  const bytes = concat(bytesField(1, body), bytesField(2, auth), bytesField(3, signature));
  return { signedTransactionBase64: base64.encode(bytes), transactionHash: hex(sha256(bytes)).toUpperCase() };
}

async function sourceBoundFixture(changes: Partial<CosmosSwapIntent> = {}) {
  const manifest = signedManifest([route]);
  const { intent, fetchImpl } = swapFixture(route, changes.timeoutHeight, changes.accountNumber);
  Object.assign(intent, changes);
  const readPolicy = verifySignedCosmosReadPolicy(signedReadPolicy(), readPolicySource, { now });
  const verified = await verifySourceBoundOsmosisSwap({ source, signedManifest: manifest, venueId: route.venueId, intent, readPolicy, fetchImpl, now });
  return { intent, verified };
}

async function walletSession(publicKey = walletPublicKey, events = new EventTarget(), signDirect?: (...args: unknown[]) => Promise<unknown>, hardware = false) {
  const provider = {
    currentKey: { ...walletKey(publicKey), isNanoLedger: hardware },
    enable: vi.fn(async () => undefined),
    getKey: vi.fn(async function(this: { currentKey: ReturnType<typeof walletKey> }) { return this.currentKey; }),
    signReads: 0,
    sendReads: 0
  };
  Object.defineProperty(provider, "signDirect", signDirect ? { value: signDirect, configurable: true } : { get: () => { provider.signReads += 1; throw new Error("signing must not be read"); } });
  Object.defineProperty(provider, "sendTx", { get: () => { provider.sendReads += 1; throw new Error("broadcast must not be read"); } });
  const connection = await connectCosmosInjectedWallet(provider, {
    schema: "realdex.cosmos-injected-chain-profile.v1", chainId: route.chainId,
    walletChainId: "osmo-test-5", bech32Prefix: "osmo"
  }, { walletId: "synthetic-cosmos-wallet", eventTarget: events, now: () => now });
  liveConnections.push(connection);
  const binding = connection.selectAccount(now + 1);
  return { provider, connection, binding };
}

function walletKey(publicKey: Uint8Array) {
  const address = ripemd160(sha256(publicKey));
  return { name: "Synthetic Cosmos account", algo: "secp256k1", pubKey: publicKey, address, bech32Address: toBech32("osmo", address), isNanoLedger: false };
}

function signedManifest(routes: OsmosisExactInRouteDescriptor[], changes: Partial<Omit<SignedOsmosisRouteManifest, "signatureBase64" | "routes">> = {}): SignedOsmosisRouteManifest {
  const unsigned = { schema: "realdex.signed-osmosis-routes.v1" as const, sourceId: source.id, sourceFingerprint: cosmosVenueSourceFingerprint(source), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), routes,
    evidenceUrls: ["https://manifest.example.org/cosmos-revision-1"], ...changes };
  const payloadBytes = new TextEncoder().encode(canonicalSignedOsmosisRouteManifestPayload(unsigned));
  const signature = Secp256k1.trimRecoveryByte(Secp256k1.createSignature(sha256(payloadBytes), privateKey).toFixedLength());
  return { ...unsigned, signatureBase64: base64.encode(signature) };
}

function signedReadPolicy(
  changes: Partial<Omit<SignedCosmosReadPolicy, "signatureBase64">> = {},
  sourceValue = readPolicySource,
  signerKey = readPolicyPrivateKey
): SignedCosmosReadPolicy {
  const unsigned: Omit<SignedCosmosReadPolicy, "signatureBase64"> = {
    schema: "realdex.signed-cosmos-read-policy.v1", sourceId: sourceValue.id, sourceFingerprint: cosmosReadPolicySourceFingerprint(sourceValue), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), chainId: sourceValue.allowedChainIds[0],
    restEndpoints: ["https://rest-a.example.org", "https://rest-b.example.net"], simulationBoundaryId: COSMOS_SWAP_BOUNDARY_ID,
    evidenceUrls: ["https://policy.example.org/cosmos/read-policy"], ...changes
  };
  const payload = new TextEncoder().encode(canonicalSignedCosmosReadPolicyPayload(unsigned));
  const signature = Secp256k1.trimRecoveryByte(Secp256k1.createSignature(sha256(payload), signerKey).toFixedLength());
  return { ...unsigned, signatureBase64: base64.encode(signature) };
}

function swapFixture(routeValue: OsmosisExactInRouteDescriptor, timeoutHeight = "1200", accountNumber = "11"): { intent: CosmosSwapIntent; fetchImpl: typeof fetch } {
  const venue = createOsmosisExactInVenue(routeValue), publicKey = walletPublicKey;
  const signerInfo = concat(bytesField(1, any(venue.publicKeyTypeUrl, bytesField(1, publicKey))), bytesField(2, bytesField(1, uintField(1, 1n))), uintField(3, 7n));
  const fee = concat(bytesField(1, concat(bytesField(1, text("uosmo")), bytesField(2, text("2500")))), uintField(2, 250000n));
  const authInfo = concat(bytesField(1, signerInfo), bytesField(2, fee));
  const body = concat(bytesField(1, any(venue.messageTypeUrl, message())), uintField(3, BigInt(timeoutHeight)));
  const transactionBase64 = base64.encode(concat(bytesField(1, body), bytesField(2, authInfo), bytesField(3, new Uint8Array())));
  const intent: CosmosSwapIntent = { schema: "realdex.cosmos-swap-intent.v1", venueId: routeValue.venueId, venueRevision: routeValue.revision, chainId: routeValue.chainId,
    authority: sender, recipient: sender, sourceDenom: routeValue.sourceDenom, destinationDenom: routeValue.destinationDenom,
    amountInBaseUnits: "1000000", expectedOutBaseUnits: "950000", minimumOutBaseUnits: "900000", accountNumber, sequence: "7", feeDenom: "uosmo",
    feeAmountBaseUnits: "2500", gasLimit: "250000", timeoutHeight, quoteExpiresAt: now + 120_000, transactionBase64 };
  const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.endsWith("node_info")) return jsonResponse({ default_node_info: { network: "osmo-test-5" } });
    if (url.endsWith("blocks/latest")) return jsonResponse({ block: { header: { height: "1000" } } });
    if (url.includes("/accounts/")) return jsonResponse({ account: { "@type": "/cosmos.auth.v1beta1.BaseAccount", account_number: accountNumber, sequence: "7", pub_key: { "@type": venue.publicKeyTypeUrl, key: base64.encode(publicKey) } } });
    if (url.endsWith("/simulate")) return jsonResponse({ gas_info: { gas_wanted: "180000", gas_used: "170000" }, result: { events: [
      { type: "coin_spent", attributes: [{ key: "spender", value: sender }, { key: "amount", value: "1002500uosmo" }] },
      { type: "coin_received", attributes: [{ key: "receiver", value: sender }, { key: "amount", value: `950000${routeValue.destinationDenom}` }] }
    ] } });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { intent, fetchImpl };
}

function message(): Uint8Array { return concat(bytesField(1, text(sender)), bytesField(2, concat(uintField(1, 12n), bytesField(2, text("uion")))), bytesField(2, concat(uintField(1, 34n), bytesField(2, text(destinationDenom)))), bytesField(3, concat(bytesField(1, text("uosmo")), bytesField(2, text("1000000")))), bytesField(4, text("900000"))); }
function uintField(number: number, value: bigint): Uint8Array { return concat(varint(BigInt(number << 3)), varint(value)); }
function bytesField(number: number, value: Uint8Array): Uint8Array { return concat(varint(BigInt((number << 3) | 2)), varint(BigInt(value.length)), value); }
function any(typeUrl: string, value: Uint8Array): Uint8Array { return concat(bytesField(1, text(typeUrl)), bytesField(2, value)); }
function varint(value: bigint): Uint8Array { const result: number[] = []; do { let byte = Number(value & 0x7fn); value >>= 7n; if (value) byte |= 0x80; result.push(byte); } while (value); return Uint8Array.from(result); }
function text(value: string): Uint8Array { return new TextEncoder().encode(value); }
function concat(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function bytesToBigInt(value: Uint8Array): bigint { return BigInt(`0x${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`); }
function bigintBytes(value: bigint): Uint8Array { const hex = value.toString(16).padStart(64, "0"); return Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16))); }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function jsonResponse(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
