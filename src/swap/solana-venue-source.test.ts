import { ed25519 } from "@noble/curves/ed25519";
import { base58, base64 } from "@scure/base";
import { AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { SolanaSwapInstructionDecoder, SolanaSwapReader, SolanaVenueDescriptor } from "./solana-swap-boundary";
import {
  canonicalSignedSolanaVenueManifestPayload,
  solanaVenueSourceFingerprint,
  verifySignedSolanaVenueManifest,
  verifySourceBoundSolanaSwap,
  type SignedSolanaVenueManifest,
  type SolanaVenueSourceDescriptor
} from "./solana-venue-source";

const now = 1_800_000_000_000;
const key = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256));
const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = base58.encode(ed25519.getPublicKey(privateKey));
const genesis = key(1), authority = key(2), program = key(3), programData = key(4), sourceMint = key(5), destinationMint = key(6), sourceAccount = key(7), destinationAccount = key(8), destinationOwner = key(9), recentBlockhash = key(10);
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const loader = "BPFLoaderUpgradeab1e11111111111111111111111";
const programDataBytes = Uint8Array.from([9, 8, 7, 6, 5]);
const chainId = `solana:${genesis.slice(0, 32)}`;

const source: SolanaVenueSourceDescriptor = {
  schema: "realdex.solana-venue-source.v1",
  id: "reviewed.solana.venues",
  name: "Reviewed Solana venues",
  signerPublicKey: publicKey,
  allowedChainIds: [chainId],
  evidenceUrls: ["https://policy.example.org/solana"]
};

describe("signed Solana venue source", () => {
  it("accepts an exact Ed25519-signed source-bound venue manifest without enabling execution", async () => {
    const venue = await fixtureVenue();
    const manifest = await signedManifest([venue]);
    const verified = await verifySignedSolanaVenueManifest(manifest, source, { now });
    expect(verified).toMatchObject({ status: "verified-design-gate", executionEnabled: false, sourceFingerprint: await solanaVenueSourceFingerprint(source) });
    expect(verified.venues).toEqual([venue]);
    expect(verified.venueFingerprints[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unsigned-field mutation, source substitution, unknown fields, and duplicate venues", async () => {
    const venue = await fixtureVenue();
    const manifest = await signedManifest([venue]);
    await expect(verifySignedSolanaVenueManifest({ ...manifest, revision: 2 }, source, { now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_SIGNER_NOT_PINNED");
    await expect(verifySignedSolanaVenueManifest(manifest, { ...source, id: "another.solana.source" }, { now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_SOURCE_MISMATCH");
    await expect(verifySignedSolanaVenueManifest({ ...manifest, extra: true }, source, { now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_INVALID");
    await expect(verifySignedSolanaVenueManifest(await signedManifest([venue, venue]), source, { now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_VENUE_DUPLICATE");
    await expect(verifySignedSolanaVenueManifest(await signedManifest([{ ...venue, chainId: `solana:${key(30).slice(0, 32)}` }]), source, { now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_CHAIN_NOT_ALLOWED");
  });

  it("rejects expiry, excessive validity, rollback, equivocation, and malformed heads", async () => {
    const venue = await fixtureVenue();
    const expired = await signedManifest([venue], { issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now).toISOString() });
    await expect(verifySignedSolanaVenueManifest(expired, source, { now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_EXPIRED");
    const long = await signedManifest([venue], { issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString() });
    await expect(verifySignedSolanaVenueManifest(long, source, { now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_VALIDITY_INVALID");
    const revisionTwo = await signedManifest([venue], { revision: 2 });
    const accepted = await verifySignedSolanaVenueManifest(revisionTwo, source, { now });
    const revisionOne = await signedManifest([venue], { revision: 1 });
    await expect(verifySignedSolanaVenueManifest(revisionOne, source, { now, previousHead: { revision: 2, payloadHash: accepted.payloadHash } })).rejects.toThrow("SOLANA_VENUE_MANIFEST_ROLLBACK_BLOCKED");
    const conflict = await signedManifest([{ ...venue, revision: 2 }], { revision: 2 });
    await expect(verifySignedSolanaVenueManifest(conflict, source, { now, previousHead: { revision: 2, payloadHash: accepted.payloadHash } })).rejects.toThrow("SOLANA_VENUE_MANIFEST_REVISION_CONFLICT");
    await expect(verifySignedSolanaVenueManifest(revisionTwo, source, { now, previousHead: { revision: 0, payloadHash: "bad" } })).rejects.toThrow("SOLANA_VENUE_MANIFEST_HEAD_INVALID");
  });

  it("freshly re-verifies the signed manifest before the existing two-reader swap boundary", async () => {
    const venue = await fixtureVenue();
    const manifest = await signedManifest([venue]);
    const intent = fixtureIntent(venue);
    const result = await verifySourceBoundSolanaSwap({ source, signedManifest: manifest, venueId: venue.venueId, intent, readers: [reader("rpc-a", venue), reader("rpc-b", venue)], decodeSwapInstruction: decoder, now });
    expect(result).toMatchObject({ venueId: venue.venueId, sourceDebitBaseUnits: "1000", destinationCreditBaseUnits: "900", execution: "design-gate", executionEnabled: false });
    expect(result.sourceFingerprint).toBe(await solanaVenueSourceFingerprint(source));
    await expect(verifySourceBoundSolanaSwap({ source, signedManifest: { ...manifest, revision: 2 }, venueId: venue.venueId, intent, readers: [reader("a", venue), reader("b", venue)], decodeSwapInstruction: decoder, now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_SIGNER_NOT_PINNED");
    await expect(verifySourceBoundSolanaSwap({ source, signedManifest: manifest, venueId: "missing", intent, readers: [reader("a", venue), reader("b", venue)], decodeSwapInstruction: decoder, now })).rejects.toThrow("SOLANA_VENUE_MANIFEST_VENUE_NOT_FOUND");
  });
});

async function fixtureVenue(): Promise<SolanaVenueDescriptor> {
  const digest = await crypto.subtle.digest("SHA-256", programDataBytes);
  return { schema: "realdex.solana-venue.v1", venueId: "reviewed-solana-pool", revision: 1, chainId, programAddress: program, programOwner: loader, programDataAddress: programData, programDataSha256: hex(new Uint8Array(digest)), tokenProgramAddress: tokenProgram, executionTarget: program, evidenceUrls: ["https://source.example.org/program", "https://deploy.example.net/program"] };
}

async function signedManifest(venues: SolanaVenueDescriptor[], changes: Partial<Omit<SignedSolanaVenueManifest, "signature" | "venues">> = {}): Promise<SignedSolanaVenueManifest> {
  const unsigned = {
    schema: "realdex.signed-solana-venues.v1" as const,
    sourceId: source.id,
    sourceFingerprint: await solanaVenueSourceFingerprint(source),
    revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    venues,
    evidenceUrls: ["https://manifest.example.org/review"],
    ...changes
  };
  const message = new TextEncoder().encode(canonicalSignedSolanaVenueManifestPayload(unsigned));
  return { ...unsigned, signature: base58.encode(ed25519.sign(message, privateKey)) };
}

function fixtureIntent(venue: SolanaVenueDescriptor) {
  return { schema: "realdex.solana-swap-intent.v1" as const, venueId: venue.venueId, venueRevision: venue.revision, chainId: venue.chainId, authority, sourceMint, destinationMint, sourceTokenAccount: sourceAccount, destinationTokenAccount: destinationAccount, destinationTokenOwner: destinationOwner, tokenProgramAddress: tokenProgram, executionTarget: program, amountInBaseUnits: "1000", expectedOutBaseUnits: "900", minimumOutBaseUnits: "890", slippageBps: 111, quoteExpiresAt: now + 60_000, lastValidBlockHeight: 200, transactionBase64: wire() };
}

const decoder: SolanaSwapInstructionDecoder = ({ data, accounts }) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { authority: accounts[0].address, sourceMint: accounts[1].address, destinationMint: accounts[2].address, sourceTokenAccount: accounts[3].address, destinationTokenAccount: accounts[4].address, tokenProgramAddress: accounts[5].address, executionTarget: program, amountInBaseUnits: view.getBigUint64(0, true).toString(), minimumOutBaseUnits: view.getBigUint64(8, true).toString() };
};

function wire(): string {
  const data = new Uint8Array(16), view = new DataView(data.buffer); view.setBigUint64(0, 1_000n, true); view.setBigUint64(8, 890n, true);
  let message: any = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(address(authority), message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight: 200n }, message);
  message = appendTransactionMessageInstruction({ programAddress: address(program), accounts: [
    { address: address(authority), role: AccountRole.READONLY_SIGNER }, { address: address(sourceMint), role: AccountRole.READONLY }, { address: address(destinationMint), role: AccountRole.READONLY },
    { address: address(sourceAccount), role: AccountRole.WRITABLE }, { address: address(destinationAccount), role: AccountRole.WRITABLE }, { address: address(tokenProgram), role: AccountRole.READONLY }
  ], data }, message);
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

function reader(id: string, venue: SolanaVenueDescriptor): SolanaSwapReader {
  const pointer = new Uint8Array(36); new DataView(pointer.buffer).setUint32(0, 2, true); pointer.set(base58.decode(programData), 4);
  return { id, genesisHash: async () => genesis, blockHeight: async () => 150, blockhashValid: async () => true,
    account: async (accountAddress) => accountAddress === venue.programAddress ? { owner: loader, executable: true, dataBase64: base64.encode(pointer) } : accountAddress === venue.programDataAddress ? { owner: loader, executable: false, dataBase64: base64.encode(programDataBytes) } : null,
    simulate: async () => ({ slot: 1_000, error: null, unitsConsumed: 120_000, feeLamports: 5_000, source: { mint: sourceMint, owner: authority, preAmount: "5000", postAmount: "4000" }, destination: { mint: destinationMint, owner: destinationOwner, preAmount: "100", postAmount: "1000" } }) };
}

function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
