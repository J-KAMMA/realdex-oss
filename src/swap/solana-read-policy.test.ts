import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { SOLANA_SWAP_BOUNDARY_ID } from "./solana-swap-boundary";
import { SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID } from "./spl-token-swap-quote-boundary";
import {
  canonicalSignedSolanaReadPolicyPayload,
  createPolicyBoundSolanaReaders,
  revalidateSolanaReadPolicy,
  solanaReadPolicySourceFingerprint,
  verifySignedSolanaReadPolicy,
  type SignedSolanaReadPolicy,
  type SolanaReadPolicySourceDescriptor
} from "./solana-read-policy";

const now = 1_800_000_000_000;
const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 51);
const publicKey = base58.encode(ed25519.getPublicKey(privateKey));
const genesis = base58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const chainId = `solana:${genesis.slice(0, 32)}`;
const source: SolanaReadPolicySourceDescriptor = {
  schema: "realdex.solana-read-policy-source.v1", id: "independent.solana.read-policy", name: "Independent Solana read policy",
  signerPublicKey: publicKey, allowedChainIds: [chainId], evidenceUrls: ["https://policy.example.org/solana/read-source"]
};

describe("signed Solana read policy", () => {
  it("accepts exact chain, boundary versions, and distinct public RPC hosts without enabling execution", async () => {
    const verified = await verifySignedSolanaReadPolicy(await signedPolicy(), source, { now });
    expect(verified).toMatchObject({ schema: "realdex.verified-solana-read-policy.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, submissionEnabled: false });
    expect(verified.sourceFingerprint).toBe(await solanaReadPolicySourceFingerprint(source));
    expect(verified.policy.rpcEndpoints).toEqual(["https://rpc-a.example.org/", "https://rpc-b.example.net/"]);
    expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects signature, source, boundary, chain, and unknown-field substitution", async () => {
    const policy = await signedPolicy();
    await expect(verifySignedSolanaReadPolicy({ ...policy, revision: 2 }, source, { now })).rejects.toThrow("SOLANA_READ_POLICY_SIGNER_NOT_PINNED");
    await expect(verifySignedSolanaReadPolicy(policy, { ...source, id: "substituted.solana.policy" }, { now })).rejects.toThrow("SOLANA_READ_POLICY_SOURCE_MISMATCH");
    await expect(signedPolicy({ quoteBoundaryId: "other-boundary" as typeof SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID })).rejects.toThrow("SOLANA_READ_POLICY_BOUNDARY_MISMATCH");
    await expect(verifySignedSolanaReadPolicy(await signedPolicy({ chainId: `solana:${base58.encode(new Uint8Array(32).fill(9)).slice(0, 32)}` }), source, { now })).rejects.toThrow("SOLANA_READ_POLICY_CHAIN_NOT_ALLOWED");
    await expect(verifySignedSolanaReadPolicy({ ...policy, executionEnabled: true }, source, { now })).rejects.toThrow("SOLANA_READ_POLICY_INVALID");
  });

  it("rejects private, credentialed, same-host, and duplicate endpoints before network access", async () => {
    await expect(signedPolicy({ rpcEndpoints: ["http://127.0.0.1:8899", "https://rpc-b.example.net"] })).rejects.toThrow("SOLANA_READ_POLICY_ENDPOINTS_NOT_PUBLIC");
    await expect(signedPolicy({ rpcEndpoints: ["https://user:secret@rpc-a.example.org", "https://rpc-b.example.net"] })).rejects.toThrow("SOLANA_READ_POLICY_ENDPOINTS_NOT_PUBLIC");
    await expect(signedPolicy({ rpcEndpoints: ["https://same.example.org/a", "https://same.example.org/b"] })).rejects.toThrow("SOLANA_READ_POLICY_ENDPOINTS_NOT_INDEPENDENT");
    await expect(signedPolicy({ rpcEndpoints: ["https://rpc-a.example.org", "https://rpc-a.example.org"] })).rejects.toThrow("SOLANA_READ_POLICY_ENDPOINTS_NOT_INDEPENDENT");
  });

  it("rejects expiry, excessive validity, rollback, equivocation, and malformed heads", async () => {
    await expect(verifySignedSolanaReadPolicy(await signedPolicy({ issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now).toISOString() }), source, { now })).rejects.toThrow("SOLANA_READ_POLICY_EXPIRED");
    await expect(verifySignedSolanaReadPolicy(await signedPolicy({ issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString() }), source, { now })).rejects.toThrow("SOLANA_READ_POLICY_VALIDITY_INVALID");
    const revisionTwo = await verifySignedSolanaReadPolicy(await signedPolicy({ revision: 2 }), source, { now });
    await expect(verifySignedSolanaReadPolicy(await signedPolicy({ revision: 1 }), source, { now, previousHead: { revision: 2, payloadHash: revisionTwo.payloadHash } })).rejects.toThrow("SOLANA_READ_POLICY_ROLLBACK_BLOCKED");
    await expect(verifySignedSolanaReadPolicy(await signedPolicy({ revision: 2, evidenceUrls: ["https://policy.example.org/changed"] }), source, { now, previousHead: { revision: 2, payloadHash: revisionTwo.payloadHash } })).rejects.toThrow("SOLANA_READ_POLICY_REVISION_CONFLICT");
    await expect(verifySignedSolanaReadPolicy(revisionTwo.policy, source, { now, previousHead: { revision: 0, payloadHash: "bad" } })).rejects.toThrow("SOLANA_READ_POLICY_HEAD_INVALID");
  });

  it("freshly revalidates the signature and creates both reader quorums from only the signed endpoints", async () => {
    const verified = await verifySignedSolanaReadPolicy(await signedPolicy(), source, { now });
    await expect(revalidateSolanaReadPolicy(verified, now + 1)).resolves.toMatchObject({ payloadHash: verified.payloadHash });
    await expect(revalidateSolanaReadPolicy({ ...verified, executionEnabled: true } as never, now + 1)).rejects.toThrow("SOLANA_READ_POLICY_VERIFICATION_INVALID");
    const fetchMock = vi.fn();
    const readers = await createPolicyBoundSolanaReaders(verified, now + 1, fetchMock as typeof fetch);
    expect(readers.swapReaders.map((reader) => reader.id)).toEqual(["rpc-a.example.org", "rpc-b.example.net"]);
    expect(readers.quoteReaders.map((reader) => reader.id)).toEqual(["rpc-a.example.org", "rpc-b.example.net"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function signedPolicy(changes: Partial<Omit<SignedSolanaReadPolicy, "signature">> = {}): Promise<SignedSolanaReadPolicy> {
  const unsigned: Omit<SignedSolanaReadPolicy, "signature"> = {
    schema: "realdex.signed-solana-read-policy.v1" as const, sourceId: source.id, sourceFingerprint: await solanaReadPolicySourceFingerprint(source), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), chainId,
    rpcEndpoints: ["https://rpc-a.example.org", "https://rpc-b.example.net"] as [string, string],
    quoteBoundaryId: SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID, simulationBoundaryId: SOLANA_SWAP_BOUNDARY_ID,
    evidenceUrls: ["https://policy.example.org/solana/read-policy"], ...changes
  };
  const payload = canonicalSignedSolanaReadPolicyPayload(unsigned);
  return { ...unsigned, signature: base58.encode(ed25519.sign(new TextEncoder().encode(payload), privateKey)) };
}
