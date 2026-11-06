import { base58, base64 } from "@scure/base";
import { AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, getTransactionDecoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { SolanaSwapIntent, SolanaVenueDescriptor, VerifiedSolanaSwap } from "./solana-swap-boundary";
import { createSolanaSwapRecoveryReader, createSolanaSwapRecoveryReaderQuorum, createSolanaSwapRecoveryRecord, readSolanaSwapRecoveryJournal, refreshSolanaSwapRecovery, writeSolanaSwapRecoveryRecord, type SolanaSwapRecoveryReader, type SolanaSwapRecoveryStatus } from "./solana-swap-recovery";

const key = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 5) % 256));
const genesis = key(1), program = key(2), loader = key(3), programData = key(4), pool = key(5), sourceMint = key(6), destinationMint = key(7), sourceAccount = key(8), destinationAccount = key(9), destinationOwner = key(10), tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", recentBlockhash = key(11);

describe("Solana swap recovery journal", () => {
  it("cryptographically binds the signed message, verified intent, signature, pool, and lifetime", async () => {
    const item = await fixture();
    expect(item.record).toMatchObject({ schema: "realdex.solana-swap-recovery.v1", stage: "submitted", resendBlocked: true, executionTarget: pool, lastValidBlockHeight: 200, refreshCount: 0 });
    expect(item.record.transactionSignature).toBe(item.signature);
    expect(item.record.signedTransactionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.record.messageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.record.recoveryId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects signature, signed-message, and verified-evidence substitution", async () => {
    const item = await fixture();
    const otherSignature = base58.encode(new Uint8Array(64).fill(9));
    await expect(createSolanaSwapRecoveryRecord({ ...item.input, transactionSignature: otherSignature })).rejects.toThrow("SOLANA_SWAP_RECOVERY_SIGNATURE_MISMATCH");
    const changed = base64.decode(item.input.signedTransactionBase64); changed[changed.length - 1] ^= 1;
    await expect(createSolanaSwapRecoveryRecord({ ...item.input, signedTransactionBase64: base64.encode(changed) })).rejects.toThrow("SOLANA_SWAP_RECOVERY_TRANSACTION_INVALID");
    await expect(createSolanaSwapRecoveryRecord({ ...item.input, verified: { ...item.input.verified, intentSha256: "00".repeat(32) } })).rejects.toThrow("SOLANA_SWAP_RECOVERY_VERIFIED_EVIDENCE_MISMATCH");
  });

  it("advances monotonically through processed, confirmed, and finalized quorum evidence", async () => {
    let record = (await fixture()).record;
    record = await refreshSolanaSwapRecovery(record, readers(status("processed", 2)), 1_800_000_001_000);
    expect(record.stage).toBe("processed");
    await expect(refreshSolanaSwapRecovery(record, readers(status("confirmed", 1), status("confirmed", 1), 149), 1_800_000_002_000)).rejects.toThrow("SOLANA_SWAP_RECOVERY_EVIDENCE_REGRESSION");
    record = await refreshSolanaSwapRecovery(record, readers(status("confirmed", 1), status("finalized", null)), 1_800_000_002_000);
    expect(record.stage).toBe("confirmed");
    record = await refreshSolanaSwapRecovery(record, readers(status("finalized", null)), 1_800_000_003_000);
    expect(record.stage).toBe("finalized");
    expect(record.observations).toHaveLength(2);
    expect(record.resendBlocked).toBe(true);
    await expect(refreshSolanaSwapRecovery(record, readers(status("confirmed", 1)), 1_800_000_004_000)).rejects.toThrow("SOLANA_SWAP_RECOVERY_STAGE_REGRESSION");
  });

  it("keeps an absent expired signature unresolved and later accepts matching history evidence", async () => {
    const initial = (await fixture()).record;
    const pending = await refreshSolanaSwapRecovery(initial, readers(null, null, 199), 1_800_000_001_000);
    expect(pending.stage).toBe("submitted");
    const expired = await refreshSolanaSwapRecovery(pending, readers(null, null, 201), 1_800_000_002_000);
    expect(expired).toMatchObject({ stage: "expired-unresolved", resendBlocked: true });
    const recovered = await refreshSolanaSwapRecovery(expired, readers(status("finalized", null), status("finalized", null), 250), 1_800_000_003_000);
    expect(recovered.stage).toBe("finalized");
  });

  it("records agreed failures but rejects missing-status, slot, chain, height, and reader quorum disagreement", async () => {
    const initial = (await fixture()).record;
    const failed = await refreshSolanaSwapRecovery(initial, readers({ ...status("processed", 0), failed: true }), 1_800_000_001_000);
    expect(failed.stage).toBe("failed");
    await expect(refreshSolanaSwapRecovery(initial, readers(null, status("processed", 0)), 1_800_000_001_000)).rejects.toThrow("SOLANA_SWAP_RECOVERY_STATUS_QUORUM_MISMATCH");
    await expect(refreshSolanaSwapRecovery(initial, readers(status("confirmed", 1), { ...status("confirmed", 1), slot: 901 }), 1_800_000_001_000)).rejects.toThrow("SOLANA_SWAP_RECOVERY_STATUS_QUORUM_MISMATCH");
    const wrongChain = readers(null); wrongChain[1] = { ...wrongChain[1], genesisHash: async () => key(30) };
    await expect(refreshSolanaSwapRecovery(initial, wrongChain, 1_800_000_001_000)).rejects.toThrow("SOLANA_SWAP_RECOVERY_CHAIN_MISMATCH");
    await expect(refreshSolanaSwapRecovery(initial, readers(null, null, [1, 500]), 1_800_000_001_000)).rejects.toThrow("SOLANA_SWAP_RECOVERY_HEIGHT_QUORUM_MISMATCH");
    await expect(refreshSolanaSwapRecovery(initial, [readers(null)[0]], 1_800_000_001_000)).rejects.toThrow("SOLANA_SWAP_RECOVERY_READER_QUORUM_REQUIRED");
  });

  it("persists a bounded strict journal without restoring quote or execution authority", async () => {
    const record = (await fixture()).record, storage = memoryStorage();
    writeSolanaSwapRecoveryRecord(record, storage);
    expect(readSolanaSwapRecoveryJournal(storage)).toEqual([record]);
    const updated = await refreshSolanaSwapRecovery(record, readers(null, null, 201), record.updatedAt + 1);
    writeSolanaSwapRecoveryRecord(updated, storage);
    expect(readSolanaSwapRecoveryJournal(storage)).toEqual([updated]);
    const incompleteQuorum = JSON.parse(storage.value!); incompleteQuorum.records[0].observations = [{ readerId: "a", blockHeight: 1, contextSlot: 1, transactionSlot: null, confirmationStatus: null, confirmations: null, failed: null }]; storage.value = JSON.stringify(incompleteQuorum);
    expect(() => readSolanaSwapRecoveryJournal(storage)).toThrow("SOLANA_SWAP_RECOVERY_RECORD_INVALID");
    storage.value = null;
    writeSolanaSwapRecoveryRecord(updated, storage);
    const payload = JSON.parse(storage.value!); payload.records[0].amountInBaseUnits = "01"; storage.value = JSON.stringify(payload);
    expect(() => readSolanaSwapRecoveryJournal(storage)).toThrow("SOLANA_SWAP_RECOVERY_RECORD_INVALID");
  });

  it("uses independent public RPC hosts and searches full signature history read-only", async () => {
    const signature = base58.encode(new Uint8Array(64).fill(3));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result = body.method === "getGenesisHash" ? genesis : body.method === "getBlockHeight" ? 150 : { context: { slot: 1_000 }, value: [{ slot: 900, confirmations: 2, err: null, status: { Ok: null }, confirmationStatus: "confirmed" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const reader = createSolanaSwapRecoveryReader("https://rpc.example.org", fetchMock as typeof fetch);
    expect(await reader.signatureStatus(signature)).toMatchObject({ confirmationStatus: "confirmed", failed: false, slot: 900 });
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request).toMatchObject({ method: "getSignatureStatuses", params: [[signature], { searchTransactionHistory: true }] });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(() => createSolanaSwapRecoveryReaderQuorum(["https://same.example.org/a", "https://same.example.org/b"])).toThrow("SOLANA_SWAP_RECOVERY_READER_QUORUM_NOT_INDEPENDENT");
    expect(() => createSolanaSwapRecoveryReader("http://127.0.0.1:8899")).toThrow("SOLANA_SWAP_RECOVERY_ENDPOINT_NOT_PUBLIC");
  });
});

async function fixture() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const authority = base58.encode(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
  const transactionBase64 = wire(authority), unsignedBytes = base64.decode(transactionBase64), unsigned = getTransactionDecoder().decode(unsignedBytes);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, Uint8Array.from(unsigned.messageBytes).buffer as ArrayBuffer));
  const signedBytes = Uint8Array.from(unsignedBytes); expect(signedBytes[0]).toBe(1); signedBytes.set(signatureBytes, 1);
  const signature = base58.encode(signatureBytes), now = 1_800_000_000_000;
  const venue: SolanaVenueDescriptor = { schema: "realdex.solana-venue.v1", venueId: "recovery-test", revision: 1, chainId: `solana:${genesis.slice(0, 32)}`, programAddress: program, programOwner: loader, programDataAddress: programData, programDataSha256: "11".repeat(32), tokenProgramAddress: tokenProgram, executionTarget: pool, evidenceUrls: ["https://example.org/source", "https://example.net/deployment"] };
  const intent: SolanaSwapIntent = { schema: "realdex.solana-swap-intent.v1", venueId: venue.venueId, venueRevision: venue.revision, chainId: venue.chainId, authority, sourceMint, destinationMint, sourceTokenAccount: sourceAccount, destinationTokenAccount: destinationAccount, destinationTokenOwner: destinationOwner, tokenProgramAddress: tokenProgram, executionTarget: pool, amountInBaseUnits: "1000", expectedOutBaseUnits: "900", minimumOutBaseUnits: "890", slippageBps: 111, quoteExpiresAt: now + 60_000, lastValidBlockHeight: 200, transactionBase64 };
  const verified: VerifiedSolanaSwap = { schema: "realdex.verified-solana-swap.v1", venueId: venue.venueId, chainId: venue.chainId, transactionSha256: await sha256(unsignedBytes), intentSha256: await sha256(new TextEncoder().encode(canonicalIntent(intent))), sourceDebitBaseUnits: "1000", destinationCreditBaseUnits: "900", feeLamports: 5_000, unitsConsumed: 100_000, observations: [{ readerId: "a", slot: 1, blockHeight: 150 }, { readerId: "b", slot: 1, blockHeight: 150 }], execution: "design-gate" };
  const input = { venue, intent, verified, signedTransactionBase64: base64.encode(signedBytes), transactionSignature: signature, now };
  return { input, signature, record: await createSolanaSwapRecoveryRecord(input) };
}

function wire(authority: string): string {
  let message: any = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(address(authority), message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight: 200n }, message);
  message = appendTransactionMessageInstruction({ programAddress: address(program), accounts: [
    { address: address(authority), role: AccountRole.WRITABLE_SIGNER }, { address: address(sourceMint), role: AccountRole.READONLY }, { address: address(destinationMint), role: AccountRole.READONLY },
    { address: address(sourceAccount), role: AccountRole.WRITABLE }, { address: address(destinationAccount), role: AccountRole.WRITABLE }, { address: address(tokenProgram), role: AccountRole.READONLY }
  ], data: new Uint8Array(16).fill(1) }, message);
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

function status(confirmationStatus: SolanaSwapRecoveryStatus["confirmationStatus"], confirmations: number | null): SolanaSwapRecoveryStatus { return { contextSlot: 1_000, slot: 900, confirmations, confirmationStatus, failed: false }; }
function readers(first: SolanaSwapRecoveryStatus | null, second: SolanaSwapRecoveryStatus | null = first, heights: number | [number, number] = 150): SolanaSwapRecoveryReader[] { const pair = Array.isArray(heights) ? heights : [heights, heights]; return [0, 1].map((index) => ({ id: index ? "rpc-b" : "rpc-a", genesisHash: async () => genesis, blockHeight: async () => pair[index], signatureStatus: async () => index ? second : first })); }
function memoryStorage() { return { value: null as string | null, getItem() { return this.value; }, setItem(_key: string, value: string) { this.value = value; } }; }
function canonicalIntent(value: SolanaSwapIntent): string { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key as keyof SolanaSwapIntent]]))); }
async function sha256(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer as ArrayBuffer); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
