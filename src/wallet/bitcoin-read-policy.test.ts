import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { DEFAULT_BITCOIN_FEE_SAFETY_POLICY } from "./bitcoin-fee-policy";
import {
  bitcoinReadPolicySourceFingerprint, canonicalSignedBitcoinReadPolicyPayload, revalidateBitcoinReadPolicy,
  validateBitcoinReadPolicySource, verifySignedBitcoinReadPolicy,
  type BitcoinReadPolicySourceDescriptor, type SignedBitcoinReadPolicy
} from "./bitcoin-read-policy";

const now = Date.parse("2026-09-01T10:00:00.000Z");
const chainId = "bip122:000000000019d6689c085ae165831e93";
const signer = new Wallet(`0x${"11".repeat(32)}`);
const otherSigner = new Wallet(`0x${"22".repeat(32)}`);

describe("signed Bitcoin read policy", () => {
  it("binds a pinned publisher, BIP122 chain, two public hosts, and exact safety thresholds", async () => {
    const source = sourceFixture(); const signed = await signPolicy(source);
    const verified = verifySignedBitcoinReadPolicy(signed, source, { now });
    expect(verified).toMatchObject({ schema: "realdex.verified-bitcoin-read-policy.v1", status: "verified-design-gate", executionEnabled: false, signingEnabled: false, broadcastEnabled: false, sourceFingerprint: bitcoinReadPolicySourceFingerprint(source), recoveredSigner: signer.address });
    expect(verified.policy.esploraEndpoints).toEqual(["https://a.example/api/", "https://b.example/api/"]);
    expect(verified.policy.utxoPolicy).toEqual({ minConfirmations: 2, maxTipDivergence: 6 });
    expect(verified.policy.feePolicy).toEqual(DEFAULT_BITCOIN_FEE_SAFETY_POLICY);
    expect(revalidateBitcoinReadPolicy(verified, now + 1_000).payloadHash).toBe(verified.payloadHash);
  });

  it("rejects an unpinned signer and payload tampering", async () => {
    const source = sourceFixture(); const signed = await signPolicy(source, {}, otherSigner);
    expect(() => verifySignedBitcoinReadPolicy(signed, source, { now })).toThrow("BITCOIN_READ_POLICY_SIGNER_NOT_PINNED");
    const valid = await signPolicy(source);
    expect(() => verifySignedBitcoinReadPolicy({ ...valid, utxoPolicy: { ...valid.utxoPolicy, minConfirmations: 3 } }, source, { now })).toThrow("BITCOIN_READ_POLICY_SIGNER_NOT_PINNED");
  });

  it("rejects source substitution and out-of-scope chains", async () => {
    const source = sourceFixture(); const signed = await signPolicy(source);
    expect(() => verifySignedBitcoinReadPolicy(signed, { ...source, name: "Substituted" }, { now })).toThrow("BITCOIN_READ_POLICY_SOURCE_MISMATCH");
    const testnet = "bip122:000000000933ea01ad0ee984209779ba";
    const outOfScope = await signPolicy(source, { chainId: testnet });
    expect(() => verifySignedBitcoinReadPolicy(outOfScope, source, { now })).toThrow("BITCOIN_READ_POLICY_CHAIN_NOT_ALLOWED");
  });

  it("blocks rollback and same-revision equivocation", async () => {
    const source = sourceFixture(); const revision2 = verifySignedBitcoinReadPolicy(await signPolicy(source, { revision: 2 }), source, { now });
    const head = { revision: revision2.policy.revision, payloadHash: revision2.payloadHash };
    const revision1 = await signPolicy(source, { revision: 1 });
    expect(() => verifySignedBitcoinReadPolicy(revision1, source, { now, previousHead: head })).toThrow("BITCOIN_READ_POLICY_ROLLBACK_BLOCKED");
    const conflicting = await signPolicy(source, { revision: 2, utxoPolicy: { minConfirmations: 3, maxTipDivergence: 6 } });
    expect(() => verifySignedBitcoinReadPolicy(conflicting, source, { now, previousHead: head })).toThrow("BITCOIN_READ_POLICY_REVISION_CONFLICT");
  });

  it("rejects expired, future, and overlong validity windows", async () => {
    const source = sourceFixture();
    const expired = await signPolicy(source, { issuedAt: "2026-09-01T09:00:00.000Z", expiresAt: "2026-09-01T10:00:00.000Z" });
    const future = await signPolicy(source, { issuedAt: "2026-09-01T10:06:00.000Z", expiresAt: "2026-09-01T10:10:00.000Z" });
    const overlong = await signPolicy(source, { issuedAt: "2026-09-01T09:59:00.000Z", expiresAt: "2026-10-02T10:00:00.000Z" });
    expect(() => verifySignedBitcoinReadPolicy(expired, source, { now })).toThrow("BITCOIN_READ_POLICY_EXPIRED");
    expect(() => verifySignedBitcoinReadPolicy(future, source, { now })).toThrow("BITCOIN_READ_POLICY_FROM_FUTURE");
    expect(() => verifySignedBitcoinReadPolicy(overlong, source, { now })).toThrow("BITCOIN_READ_POLICY_VALIDITY_INVALID");
  });

  it("rejects private/duplicate endpoints and malformed nested policy fields", async () => {
    const source = sourceFixture();
    await expect(signPolicy(source, { esploraEndpoints: ["https://127.0.0.1/api", "https://b.example/api"] })).rejects.toThrow("BITCOIN_ESPLORA_URL_NOT_PUBLIC");
    await expect(signPolicy(source, { esploraEndpoints: ["https://a.example/api", "https://a.example/other"] })).rejects.toThrow("BITCOIN_ESPLORA_ENDPOINTS_NOT_INDEPENDENT");
    await expect(signPolicy(source, { feePolicy: { ...DEFAULT_BITCOIN_FEE_SAFETY_POLICY, confirmationTargetBlocks: 26 } })).rejects.toThrow("BITCOIN_READ_POLICY_FEE_INVALID");
    expect(() => validateBitcoinReadPolicySource({ ...source, unexpected: true })).toThrow("BITCOIN_READ_POLICY_SOURCE_INVALID");
  });

  it("fails current revalidation after expiry or verified-object substitution", async () => {
    const source = sourceFixture(); const verified = verifySignedBitcoinReadPolicy(await signPolicy(source), source, { now });
    expect(() => revalidateBitcoinReadPolicy(verified, Date.parse("2026-09-02T10:01:00.000Z"))).toThrow("BITCOIN_READ_POLICY_EXPIRED");
    expect(() => revalidateBitcoinReadPolicy({ ...verified, sourceFingerprint: `0x${"00".repeat(32)}` }, now)).toThrow("BITCOIN_READ_POLICY_VERIFICATION_INVALID");
  });
});

function sourceFixture(): BitcoinReadPolicySourceDescriptor {
  return { schema: "realdex.bitcoin-read-policy-source.v1", id: "bitcoin-mainnet-read", name: "Bitcoin mainnet read safety", signerAddress: signer.address, allowedChainIds: [chainId], evidenceUrls: ["https://policy.example/evidence"] };
}

function unsignedPolicy(source: BitcoinReadPolicySourceDescriptor, overrides: Partial<Omit<SignedBitcoinReadPolicy, "signature">> = {}): Omit<SignedBitcoinReadPolicy, "signature"> {
  return {
    schema: "realdex.signed-bitcoin-read-policy.v1", sourceId: source.id, sourceFingerprint: bitcoinReadPolicySourceFingerprint(source), revision: 1,
    issuedAt: "2026-09-01T09:59:00.000Z", expiresAt: "2026-09-02T10:00:00.000Z", chainId,
    esploraEndpoints: ["https://a.example/api", "https://b.example/api"], utxoPolicy: { minConfirmations: 2, maxTipDivergence: 6 },
    feePolicy: { ...DEFAULT_BITCOIN_FEE_SAFETY_POLICY }, evidenceUrls: ["https://policy.example/bitcoin-mainnet"], ...overrides
  };
}

async function signPolicy(source: BitcoinReadPolicySourceDescriptor, overrides: Partial<Omit<SignedBitcoinReadPolicy, "signature">> = {}, wallet = signer): Promise<SignedBitcoinReadPolicy> {
  const unsigned = unsignedPolicy(source, overrides);
  return { ...unsigned, signature: await wallet.signMessage(canonicalSignedBitcoinReadPolicyPayload(unsigned)) };
}
