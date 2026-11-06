import { base58 } from "@scure/base";
import { AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { createSolanaSwapReader, createSolanaSwapReaderQuorum, verifySolanaSwapBoundary, type SolanaSwapInstructionDecoder, type SolanaSwapReader, type SolanaVenueDescriptor } from "./solana-swap-boundary";

const key = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256));
const genesisHash = key(1), authority = key(2), program = key(3), programData = key(4), sourceMint = key(5), destinationMint = key(6), sourceAccount = key(7), destinationAccount = key(8), destinationOwner = key(9), tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", loader = "BPFLoaderUpgradeab1e11111111111111111111111", recentBlockhash = key(10);

const decoder: SolanaSwapInstructionDecoder = ({ data, accounts }) => {
  if (data.length !== 16 || accounts.length !== 6) throw new Error("bad instruction");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { authority: accounts[0].address, sourceMint: accounts[1].address, destinationMint: accounts[2].address, sourceTokenAccount: accounts[3].address, destinationTokenAccount: accounts[4].address, tokenProgramAddress: accounts[5].address, executionTarget: program, amountInBaseUnits: view.getBigUint64(0, true).toString(), minimumOutBaseUnits: view.getBigUint64(8, true).toString() };
};

function wire(amountIn = 1_000n, minimumOut = 890n, extraInstruction = false): string {
  const data = new Uint8Array(16), view = new DataView(data.buffer); view.setBigUint64(0, amountIn, true); view.setBigUint64(8, minimumOut, true);
  let message: any = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(address(authority), message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight: 200n }, message);
  message = appendTransactionMessageInstruction({ programAddress: address(program), accounts: [
    { address: address(authority), role: AccountRole.READONLY_SIGNER }, { address: address(sourceMint), role: AccountRole.READONLY }, { address: address(destinationMint), role: AccountRole.READONLY },
    { address: address(sourceAccount), role: AccountRole.WRITABLE }, { address: address(destinationAccount), role: AccountRole.WRITABLE }, { address: address(tokenProgram), role: AccountRole.READONLY }
  ], data }, message);
  if (extraInstruction) message = appendTransactionMessageInstruction({ programAddress: address(tokenProgram), data: new Uint8Array([1]) }, message);
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

async function fixture() {
  const programDataBytes = Uint8Array.from([9, 8, 7, 6, 5]);
  const digest = await crypto.subtle.digest("SHA-256", programDataBytes);
  const venue: SolanaVenueDescriptor = { schema: "realdex.solana-venue.v1", venueId: "test-solana-amm", revision: 1, chainId: `solana:${genesisHash.slice(0, 32)}`, programAddress: program, programOwner: loader, programDataAddress: programData, programDataSha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""), tokenProgramAddress: tokenProgram, executionTarget: program, evidenceUrls: ["https://example.org/source", "https://example.net/deployment"] };
  const intent = { schema: "realdex.solana-swap-intent.v1" as const, venueId: venue.venueId, venueRevision: 1, chainId: venue.chainId, authority, sourceMint, destinationMint, sourceTokenAccount: sourceAccount, destinationTokenAccount: destinationAccount, destinationTokenOwner: destinationOwner, tokenProgramAddress: tokenProgram, executionTarget: program, amountInBaseUnits: "1000", expectedOutBaseUnits: "900", minimumOutBaseUnits: "890", slippageBps: 111, quoteExpiresAt: 1_800_000_060_000, lastValidBlockHeight: 200, transactionBase64: wire() };
  return { venue, intent, programDataBytes };
}

function reader(id: string, venue: SolanaVenueDescriptor, programDataBytes: Uint8Array, overrides: Partial<SolanaSwapReader> = {}): SolanaSwapReader {
  const pointer = new Uint8Array(36); new DataView(pointer.buffer).setUint32(0, 2, true); pointer.set(base58.decode(programData), 4);
  return {
    id, genesisHash: async () => genesisHash, blockHeight: async () => 150,
    blockhashValid: async () => true,
    account: async (accountAddress) => accountAddress === venue.programAddress ? { owner: loader, executable: true, dataBase64: btoa(String.fromCharCode(...pointer)) } : accountAddress === venue.programDataAddress ? { owner: loader, executable: false, dataBase64: btoa(String.fromCharCode(...programDataBytes)) } : null,
    simulate: async () => ({ slot: 1_000, error: null, unitsConsumed: 120_000, feeLamports: 5_000, source: { mint: sourceMint, owner: authority, preAmount: "5000", postAmount: "4000" }, destination: { mint: destinationMint, owner: destinationOwner, preAmount: "100", postAmount: "1000" } }),
    ...overrides
  };
}

describe("Solana swap verification boundary", () => {
  it("binds exact program identity, instruction, quote, lifetime, and two-reader simulation", async () => {
    const { venue, intent, programDataBytes } = await fixture();
    const result = await verifySolanaSwapBoundary({ venue, intent, readers: [reader("rpc-a", venue, programDataBytes), reader("rpc-b", venue, programDataBytes)], decodeSwapInstruction: decoder, now: 1_800_000_000_000 });
    expect(result).toMatchObject({ schema: "realdex.verified-solana-swap.v1", venueId: venue.venueId, sourceDebitBaseUnits: "1000", destinationCreditBaseUnits: "900", feeLamports: 5_000, execution: "design-gate" });
    expect(result.transactionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.observations.map((item) => item.readerId)).toEqual(["rpc-a", "rpc-b"]);
  });

  it("rejects amount mutation and hidden extra instructions", async () => {
    const { venue, intent, programDataBytes } = await fixture(), readers = [reader("a", venue, programDataBytes), reader("b", venue, programDataBytes)];
    await expect(verifySolanaSwapBoundary({ venue, intent: { ...intent, extra: true } as never, readers, decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_INTENT_INVALID");
    await expect(verifySolanaSwapBoundary({ venue, intent: { ...intent, amountInBaseUnits: "1001" }, readers, decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_INSTRUCTION_BINDING_INVALID");
    await expect(verifySolanaSwapBoundary({ venue, intent: { ...intent, transactionBase64: wire(1_000n, 890n, true) }, readers, decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_TRANSACTION_BINDING_INVALID");
  });

  it("rejects changed program bytes and RPC simulation disagreement", async () => {
    const { venue, intent, programDataBytes } = await fixture();
    await expect(verifySolanaSwapBoundary({ venue, intent, readers: [reader("a", venue, Uint8Array.from([1])), reader("b", venue, programDataBytes)], decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_PROGRAM_IDENTITY_MISMATCH");
    const changed = reader("b", venue, programDataBytes, { simulate: async () => ({ slot: 1_001, error: null, unitsConsumed: 120_001, feeLamports: 5_000, source: { mint: sourceMint, owner: authority, preAmount: "5000", postAmount: "4000" }, destination: { mint: destinationMint, owner: destinationOwner, preAmount: "100", postAmount: "1000" } }) });
    await expect(verifySolanaSwapBoundary({ venue, intent, readers: [reader("a", venue, programDataBytes), changed], decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_SIMULATION_QUORUM_MISMATCH");
  });

  it("rejects failed simulation, expired quote, expired blockhash, and one-reader claims", async () => {
    const { venue, intent, programDataBytes } = await fixture();
    await expect(verifySolanaSwapBoundary({ venue, intent, readers: [reader("a", venue, programDataBytes), reader("b", venue, programDataBytes, { simulate: async () => ({ slot: 1, error: { InstructionError: [0, "Custom"] }, unitsConsumed: 1, feeLamports: 5_000, source: { mint: sourceMint, owner: authority, preAmount: "5000", postAmount: "4000" }, destination: { mint: destinationMint, owner: destinationOwner, preAmount: "100", postAmount: "1000" } }) })], decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_SIMULATION_FAILED");
    await expect(verifySolanaSwapBoundary({ venue, intent, readers: [reader("a", venue, programDataBytes), reader("b", venue, programDataBytes)], decodeSwapInstruction: decoder, now: intent.quoteExpiresAt })).rejects.toThrow("SOLANA_SWAP_INTENT_EXPIRY_INVALID");
    await expect(verifySolanaSwapBoundary({ venue, intent, readers: [reader("a", venue, programDataBytes, { blockHeight: async () => 201 }), reader("b", venue, programDataBytes)], decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_BLOCKHASH_EXPIRED");
    await expect(verifySolanaSwapBoundary({ venue, intent, readers: [reader("a", venue, programDataBytes, { blockhashValid: async () => false }), reader("b", venue, programDataBytes)], decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_BLOCKHASH_EXPIRED");
    await expect(verifySolanaSwapBoundary({ venue, intent, readers: [reader("a", venue, programDataBytes)], decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_READER_QUORUM_REQUIRED");
  });

  it("creates only independent public RPC readers and sends read-only simulation options", async () => {
    expect(() => createSolanaSwapReaderQuorum(["https://rpc.example.org/a", "https://rpc.example.org/b"])).toThrow("SOLANA_SWAP_READER_QUORUM_NOT_INDEPENDENT");
    expect(() => createSolanaSwapReader("http://127.0.0.1:8899")).toThrow("SOLANA_SWAP_ENDPOINT_NOT_PUBLIC");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result = body.method === "simulateTransaction" ? { context: { slot: 1 }, value: { err: null, unitsConsumed: 1, fee: 5_000, preTokenBalances: [{ accountIndex: 3, mint: sourceMint, owner: authority, uiTokenAmount: { amount: "5" } }, { accountIndex: 4, mint: destinationMint, owner: destinationOwner, uiTokenAmount: { amount: "1" } }], postTokenBalances: [{ accountIndex: 3, mint: sourceMint, owner: authority, uiTokenAmount: { amount: "4" } }, { accountIndex: 4, mint: destinationMint, owner: destinationOwner, uiTokenAmount: { amount: "2" } }] } } : genesisHash;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const rpc = createSolanaSwapReader("https://rpc.example.org", fetchMock as typeof fetch);
    await rpc.simulate(wire(), 3, 4);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false, innerInstructions: true, commitment: "confirmed" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  });
});
