import { Secp256k1, sha256 } from "@cosmjs/crypto";
import { base64 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { COSMOS_SWAP_BOUNDARY_ID } from "./cosmos-swap-boundary";
import { COSMOS_SWAP_RECOVERY_ID } from "./cosmos-swap-recovery";
import {
  canonicalSignedCosmosReadPolicyPayload,
  cosmosReadPolicySourceFingerprint,
  createPolicyBoundCosmosReaders,
  revalidateCosmosReadPolicy,
  verifySignedCosmosReadPolicy,
  type CosmosReadPolicySourceDescriptor,
  type SignedCosmosReadPolicy
} from "./cosmos-read-policy";

const now = 1_800_000_000_000;
const privateKey = new Uint8Array(32).fill(31);
const publicKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(privateKey).pubkey);
const chainId = "cosmos:osmo-test-5";
const source: CosmosReadPolicySourceDescriptor = {
  schema: "realdex.cosmos-read-policy-source.v1",
  id: "independent.cosmos.read-policy",
  name: "Independent Cosmos read policy",
  signerPublicKeyBase64: base64.encode(publicKey),
  allowedChainIds: [chainId],
  evidenceUrls: ["https://policy.example.org/cosmos/read-source"]
};

describe("signed Cosmos read policy", () => {
  it("accepts an exact chain, simulation boundary, and distinct public REST hosts without enabling execution", () => {
    const verified = verifySignedCosmosReadPolicy(signedPolicy(), source, { now });
    expect(verified).toMatchObject({ schema: "realdex.verified-cosmos-read-policy.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false });
    expect(verified.sourceFingerprint).toBe(cosmosReadPolicySourceFingerprint(source));
    expect(verified.policy.restEndpoints).toEqual(["https://rest-a.example.org/", "https://rest-b.example.net/"]);
    expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects signature, source, boundary, chain, and unknown-field substitution", () => {
    const policy = signedPolicy();
    expect(() => verifySignedCosmosReadPolicy({ ...policy, revision: 2 }, source, { now })).toThrow("COSMOS_READ_POLICY_SIGNER_NOT_PINNED");
    expect(() => verifySignedCosmosReadPolicy(policy, { ...source, id: "substituted.cosmos.policy" }, { now })).toThrow("COSMOS_READ_POLICY_SOURCE_MISMATCH");
    expect(() => signedPolicy({ simulationBoundaryId: "other-boundary" as typeof COSMOS_SWAP_BOUNDARY_ID })).toThrow("COSMOS_READ_POLICY_BOUNDARY_MISMATCH");
    expect(() => verifySignedCosmosReadPolicy(signedPolicy({ chainId: "cosmos:other-test-1" }), source, { now })).toThrow("COSMOS_READ_POLICY_CHAIN_NOT_ALLOWED");
    expect(() => verifySignedCosmosReadPolicy({ ...policy, executionEnabled: true }, source, { now })).toThrow("COSMOS_READ_POLICY_INVALID");
  });

  it("rejects private, credentialed, same-host, and duplicate endpoints before network access", () => {
    expect(() => signedPolicy({ restEndpoints: ["http://127.0.0.1:1317", "https://rest-b.example.net"] })).toThrow("COSMOS_READ_POLICY_ENDPOINTS_NOT_PUBLIC");
    expect(() => signedPolicy({ restEndpoints: ["https://user:secret@rest-a.example.org", "https://rest-b.example.net"] })).toThrow("COSMOS_READ_POLICY_ENDPOINTS_NOT_PUBLIC");
    expect(() => signedPolicy({ restEndpoints: ["https://same.example.org/a", "https://same.example.org/b"] })).toThrow("COSMOS_READ_POLICY_ENDPOINTS_NOT_INDEPENDENT");
    expect(() => signedPolicy({ restEndpoints: ["https://rest-a.example.org", "https://rest-a.example.org"] })).toThrow("COSMOS_READ_POLICY_ENDPOINTS_NOT_INDEPENDENT");
  });

  it("rejects expiry, excessive validity, rollback, equivocation, and malformed heads", () => {
    expect(() => verifySignedCosmosReadPolicy(signedPolicy({ issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now).toISOString() }), source, { now })).toThrow("COSMOS_READ_POLICY_EXPIRED");
    expect(() => verifySignedCosmosReadPolicy(signedPolicy({ issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString() }), source, { now })).toThrow("COSMOS_READ_POLICY_VALIDITY_INVALID");
    const revisionTwo = verifySignedCosmosReadPolicy(signedPolicy({ revision: 2 }), source, { now });
    expect(() => verifySignedCosmosReadPolicy(signedPolicy({ revision: 1 }), source, { now, previousHead: { revision: 2, payloadHash: revisionTwo.payloadHash } })).toThrow("COSMOS_READ_POLICY_ROLLBACK_BLOCKED");
    expect(() => verifySignedCosmosReadPolicy(signedPolicy({ revision: 2, evidenceUrls: ["https://policy.example.org/changed"] }), source, { now, previousHead: { revision: 2, payloadHash: revisionTwo.payloadHash } })).toThrow("COSMOS_READ_POLICY_REVISION_CONFLICT");
    expect(() => verifySignedCosmosReadPolicy(revisionTwo.policy, source, { now, previousHead: { revision: 0, payloadHash: "bad" } })).toThrow("COSMOS_READ_POLICY_HEAD_INVALID");
  });

  it("freshly revalidates the signature and constructs readers only from the signed endpoints", () => {
    const verified = verifySignedCosmosReadPolicy(signedPolicy(), source, { now });
    expect(revalidateCosmosReadPolicy(verified, now + 1)).toMatchObject({ payloadHash: verified.payloadHash });
    expect(() => revalidateCosmosReadPolicy({ ...verified, executionEnabled: true } as never, now + 1)).toThrow("COSMOS_READ_POLICY_VERIFICATION_INVALID");
    const fetchMock = vi.fn();
    const bound = createPolicyBoundCosmosReaders(verified, now + 1, fetchMock as typeof fetch);
    expect(bound.readers.map((reader) => reader.id)).toEqual(["rest-a.example.org", "rest-b.example.net"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the exact recovery opt-in to be included in the signed payload", () => {
    const legacy = signedPolicy();
    const legacyVerified = verifySignedCosmosReadPolicy(legacy, source, { now });
    expect(legacyVerified.policy).not.toHaveProperty("recoveryBoundaryId");
    const { signatureBase64: _signature, ...legacyUnsigned } = legacy;
    expect(canonicalSignedCosmosReadPolicyPayload(legacyUnsigned)).not.toContain("recoveryBoundaryId");
    const optedIn = signedPolicy({ recoveryBoundaryId: COSMOS_SWAP_RECOVERY_ID });
    const verified = verifySignedCosmosReadPolicy(optedIn, source, { now });
    expect(verified.policy.recoveryBoundaryId).toBe(COSMOS_SWAP_RECOVERY_ID);
    expect(verified.payloadHash).not.toBe(legacyVerified.payloadHash);
    expect(revalidateCosmosReadPolicy(verified, now + 1).policy.recoveryBoundaryId).toBe(COSMOS_SWAP_RECOVERY_ID);
    expect(() => verifySignedCosmosReadPolicy({ ...legacy, recoveryBoundaryId: COSMOS_SWAP_RECOVERY_ID }, source, { now })).toThrow("COSMOS_READ_POLICY_SIGNER_NOT_PINNED");
    const { recoveryBoundaryId: _boundary, ...stripped } = optedIn;
    expect(() => verifySignedCosmosReadPolicy(stripped, source, { now })).toThrow("COSMOS_READ_POLICY_SIGNER_NOT_PINNED");
    for (const recoveryBoundaryId of [undefined, null, "other-recovery", true]) {
      expect(() => verifySignedCosmosReadPolicy({ ...legacy, recoveryBoundaryId }, source, { now })).toThrow("COSMOS_READ_POLICY_RECOVERY_BOUNDARY_MISMATCH");
    }
    expect(() => verifySignedCosmosReadPolicy(optedIn, source, { now, previousHead: { revision: legacyVerified.policy.revision, payloadHash: legacyVerified.payloadHash } })).toThrow("COSMOS_READ_POLICY_REVISION_CONFLICT");
  });
});

function signedPolicy(changes: Partial<Omit<SignedCosmosReadPolicy, "signatureBase64">> = {}): SignedCosmosReadPolicy {
  const unsigned: Omit<SignedCosmosReadPolicy, "signatureBase64"> = {
    schema: "realdex.signed-cosmos-read-policy.v1",
    sourceId: source.id,
    sourceFingerprint: cosmosReadPolicySourceFingerprint(source),
    revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    chainId,
    restEndpoints: ["https://rest-a.example.org", "https://rest-b.example.net"],
    simulationBoundaryId: COSMOS_SWAP_BOUNDARY_ID,
    evidenceUrls: ["https://policy.example.org/cosmos/read-policy"],
    ...changes
  };
  const payload = new TextEncoder().encode(canonicalSignedCosmosReadPolicyPayload(unsigned));
  const signature = Secp256k1.trimRecoveryByte(Secp256k1.createSignature(sha256(payload), privateKey).toFixedLength());
  return { ...unsigned, signatureBase64: base64.encode(signature) };
}
