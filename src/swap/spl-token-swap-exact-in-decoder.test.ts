import { base58, base64 } from "@scure/base";
import { AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { verifySolanaSwapBoundary, type SolanaSwapIntent, type SolanaSwapReader } from "./solana-swap-boundary";
import { SPL_TOKEN_SWAP_EXACT_IN_DECODER_ID, createSplTokenSwapExactInDecoder, createSplTokenSwapExactInVenue, type SplTokenSwapExactInRouteDescriptor } from "./spl-token-swap-exact-in-decoder";

const key = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 3) % 256));
const genesis = key(1), program = key(2), loader = key(3), programData = key(4), tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const swapState = key(5), swapAuthority = key(6), poolSource = key(7), poolDestination = key(8), poolMint = key(9), poolFee = key(10), sourceMint = key(11), destinationMint = key(12);
const authority = key(13), sourceAccount = key(14), destinationAccount = key(15), destinationOwner = key(16), hostFee = key(17), recentBlockhash = key(18);
const sourceUrl = "https://github.com/solana-labs/solana-program-library/blob/master/token-swap/program/src/instruction.rs";
const docsUrl = "https://github.com/solana-labs/solana-program-library/blob/master/docs/src/token-swap.md";

const route: SplTokenSwapExactInRouteDescriptor = {
  schema: "realdex.spl-token-swap-exact-in-route.v1", venueId: "reviewed-spl-token-swap-pool", revision: 1,
  chainId: `solana:${genesis.slice(0, 32)}`, programAddress: program, programOwner: loader, programDataAddress: programData,
  programDataSha256: "11".repeat(32), tokenProgramAddress: tokenProgram, swapState, swapAuthority,
  poolSourceTokenAccount: poolSource, poolDestinationTokenAccount: poolDestination, poolMint, poolFeeAccount: poolFee,
  sourceMint, destinationMint, hostFeeAccount: null, evidenceUrls: [sourceUrl, docsUrl]
};

describe("SPL Token Swap exact-input decoder", () => {
  it("decodes the exact 17-byte swap instruction and binds every pool account", () => {
    const decoder = createSplTokenSwapExactInDecoder(route);
    expect(decoder({ data: instruction(1_000n, 890n), accounts: accountList() })).toEqual({
      authority, sourceMint, destinationMint, sourceTokenAccount: sourceAccount, destinationTokenAccount: destinationAccount,
      tokenProgramAddress: tokenProgram, executionTarget: swapState, amountInBaseUnits: "1000", minimumOutBaseUnits: "890"
    });
    expect(SPL_TOKEN_SWAP_EXACT_IN_DECODER_ID).toBe("spl-token-swap-exact-in-v1");
    expect(createSplTokenSwapExactInVenue(route)).toMatchObject({ venueId: route.venueId, programAddress: program, tokenProgramAddress: tokenProgram, executionTarget: swapState });
  });

  it("rejects another instruction, trailing bytes, zero amounts, and missing or unexpected host fees", () => {
    const decoder = createSplTokenSwapExactInDecoder(route);
    expect(() => decoder({ data: Uint8Array.from([2, ...instruction().slice(1)]), accounts: accountList() })).toThrow();
    expect(() => decoder({ data: Uint8Array.from([...instruction(), 0]), accounts: accountList() })).toThrow();
    expect(() => decoder({ data: instruction(0n, 1n), accounts: accountList() })).toThrow();
    expect(() => decoder({ data: instruction(1n, 0n), accounts: accountList() })).toThrow();
    expect(() => decoder({ data: instruction(), accounts: [...accountList(), { address: hostFee, role: AccountRole.WRITABLE }] })).toThrow();
    const hostRoute = { ...route, hostFeeAccount: hostFee };
    expect(() => createSplTokenSwapExactInDecoder(hostRoute)({ data: instruction(), accounts: accountList() })).toThrow();
    expect(createSplTokenSwapExactInDecoder(hostRoute)({ data: instruction(), accounts: [...accountList(), { address: hostFee, role: AccountRole.WRITABLE }] }).executionTarget).toBe(swapState);
  });

  it("rejects pool substitution, token-program substitution, and privilege escalation", () => {
    const decoder = createSplTokenSwapExactInDecoder(route);
    const substituted = accountList(); substituted[4] = { address: key(30), role: AccountRole.WRITABLE };
    expect(() => decoder({ data: instruction(), accounts: substituted })).toThrow();
    const wrongProgram = accountList(); wrongProgram[12] = { address: key(31), role: AccountRole.READONLY };
    expect(() => decoder({ data: instruction(), accounts: wrongProgram })).toThrow();
    const signerPool = accountList(); signerPool[0] = { address: swapState, role: AccountRole.READONLY_SIGNER };
    expect(() => decoder({ data: instruction(), accounts: signerPool })).toThrow();
    const readonlySource = accountList(); readonlySource[3] = { address: sourceAccount, role: AccountRole.READONLY };
    expect(() => decoder({ data: instruction(), accounts: readonlySource })).toThrow();
  });

  it("rejects duplicate pool identities, malformed addresses, weak evidence, and wrong route schema", () => {
    const invalid = (change: Partial<SplTokenSwapExactInRouteDescriptor>) => () => createSplTokenSwapExactInDecoder({ ...route, ...change });
    expect(invalid({ poolFeeAccount: poolMint })).toThrow("SPL_TOKEN_SWAP_ROUTE_INVALID");
    expect(invalid({ swapAuthority: "bad" })).toThrow("SPL_TOKEN_SWAP_ROUTE_INVALID");
    expect(invalid({ evidenceUrls: [sourceUrl] })).toThrow("SPL_TOKEN_SWAP_ROUTE_INVALID");
    expect(invalid({ evidenceUrls: [sourceUrl, sourceUrl] })).toThrow("SPL_TOKEN_SWAP_ROUTE_INVALID");
    expect(invalid({ schema: "wrong" as never })).toThrow("SPL_TOKEN_SWAP_ROUTE_INVALID");
  });

  it("composes with the unsigned v0 transaction and two-RPC simulation boundary", async () => {
    const programDataBytes = Uint8Array.from([9, 8, 7, 6]);
    const digest = await crypto.subtle.digest("SHA-256", programDataBytes);
    const exactRoute = { ...route, programDataSha256: hex(new Uint8Array(digest)) };
    const venue = createSplTokenSwapExactInVenue(exactRoute);
    const transactionBase64 = wire();
    const intent: SolanaSwapIntent = {
      schema: "realdex.solana-swap-intent.v1", venueId: route.venueId, venueRevision: route.revision, chainId: route.chainId,
      authority, sourceMint, destinationMint, sourceTokenAccount: sourceAccount, destinationTokenAccount: destinationAccount,
      destinationTokenOwner: destinationOwner, tokenProgramAddress: tokenProgram, executionTarget: swapState,
      amountInBaseUnits: "1000", expectedOutBaseUnits: "900", minimumOutBaseUnits: "890", slippageBps: 111, quoteExpiresAt: 1_800_000_060_000,
      lastValidBlockHeight: 200, transactionBase64
    };
    const reader = (id: string): SolanaSwapReader => ({
      id, genesisHash: async () => genesis, blockHeight: async () => 150, blockhashValid: async () => true,
      account: async (accountAddress) => accountAddress === program ? programPointer() : accountAddress === programData ? { owner: loader, executable: false, dataBase64: base64.encode(programDataBytes) } : null,
      simulate: async () => ({ slot: 1_000, error: null, unitsConsumed: 120_000, feeLamports: 5_000, source: { mint: sourceMint, owner: authority, preAmount: "5000", postAmount: "4000" }, destination: { mint: destinationMint, owner: destinationOwner, preAmount: "100", postAmount: "1000" } })
    });
    const readers = [reader("rpc-a"), reader("rpc-b")];
    const decoder = createSplTokenSwapExactInDecoder(exactRoute);
    await expect(verifySolanaSwapBoundary({ venue, intent, readers, decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).resolves.toMatchObject({ execution: "design-gate", sourceDebitBaseUnits: "1000", destinationCreditBaseUnits: "900" });
    await expect(verifySolanaSwapBoundary({ venue, intent: { ...intent, executionTarget: key(40) }, readers, decodeSwapInstruction: decoder, now: 1_800_000_000_000 })).rejects.toThrow("SOLANA_SWAP_INTENT_IDENTITY_INVALID");
  });
});

function instruction(amountIn = 1_000n, minimumOut = 890n): Uint8Array { const bytes = new Uint8Array(17), view = new DataView(bytes.buffer); bytes[0] = 1; view.setBigUint64(1, amountIn, true); view.setBigUint64(9, minimumOut, true); return bytes; }
function accountList() { return [
  { address: swapState, role: AccountRole.READONLY }, { address: swapAuthority, role: AccountRole.READONLY }, { address: authority, role: AccountRole.WRITABLE_SIGNER },
  { address: sourceAccount, role: AccountRole.WRITABLE }, { address: poolSource, role: AccountRole.WRITABLE }, { address: poolDestination, role: AccountRole.WRITABLE },
  { address: destinationAccount, role: AccountRole.WRITABLE }, { address: poolMint, role: AccountRole.WRITABLE }, { address: poolFee, role: AccountRole.WRITABLE },
  { address: sourceMint, role: AccountRole.READONLY }, { address: destinationMint, role: AccountRole.READONLY },
  { address: tokenProgram, role: AccountRole.READONLY }, { address: tokenProgram, role: AccountRole.READONLY }, { address: tokenProgram, role: AccountRole.READONLY }
]; }
function wire(): string {
  let message: any = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(address(authority), message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight: 200n }, message);
  message = appendTransactionMessageInstruction({ programAddress: address(program), accounts: accountList().map((account) => ({ address: address(account.address), role: account.role })), data: instruction() }, message);
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
function programPointer() { const bytes = new Uint8Array(36); new DataView(bytes.buffer).setUint32(0, 2, true); bytes.set(base58.decode(programData), 4); return { owner: loader, executable: true, dataBase64: base64.encode(bytes) }; }
function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
