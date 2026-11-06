import { base58, base64 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import type { SolanaSwapIntent } from "./solana-swap-boundary";
import type { SplTokenSwapExactInRouteDescriptor } from "./spl-token-swap-exact-in-decoder";
import { createSplTokenSwapQuoteReaderQuorum, verifySplTokenSwapQuote, type SolanaReadonlyAccount, type SplTokenSwapQuoteReader } from "./spl-token-swap-quote-boundary";

const now = 1_800_000_000_000;
const key = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 3) % 256));
const genesis = key(1), program = key(2), loader = key(3), programData = key(4), swapState = key(5);
const swapAuthority = "4KcPqwnbZXJ8Bqg9twqjrbSn6NZs7KpoJzenXTHejCaJ";
const poolSource = key(7), poolDestination = key(8), poolMint = key(9), poolFee = key(10), sourceMint = key(11), destinationMint = key(12);
const authority = key(13), sourceAccount = key(14), destinationAccount = key(15), destinationOwner = key(16);
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const route: SplTokenSwapExactInRouteDescriptor = {
  schema: "realdex.spl-token-swap-exact-in-route.v1", venueId: "quote-pool", revision: 1, chainId: `solana:${genesis.slice(0, 32)}`,
  programAddress: program, programOwner: loader, programDataAddress: programData, programDataSha256: "11".repeat(32), tokenProgramAddress: tokenProgram,
  swapState, swapAuthority, poolSourceTokenAccount: poolSource, poolDestinationTokenAccount: poolDestination, poolMint, poolFeeAccount: poolFee,
  sourceMint, destinationMint, hostFeeAccount: null, evidenceUrls: ["https://source.example.org/program", "https://explorer.example.net/pool"]
};

describe("SPL Token Swap constant-product quote boundary", () => {
  it("derives the exact output and slippage floor from two current pool snapshots", async () => {
    const intent = fixtureIntent();
    const verified = await verifySplTokenSwapQuote({ route, intent, readers: [reader("rpc-a"), reader("rpc-b")], now });
    expect(verified).toMatchObject({
      schema: "realdex.verified-spl-token-swap-quote.v1", venueId: route.venueId, curve: "constant-product", amountInBaseUnits: "1000",
      expectedOutBaseUnits: "900", minimumOutBaseUnits: "890", slippageBps: 111, sourceReserveBaseUnits: "9000", destinationReserveBaseUnits: "9000",
      tradeFeeBaseUnits: "0", ownerTradeFeeBaseUnits: "0", execution: "design-gate"
    });
    expect(verified.observations).toHaveLength(2);
  });

  it("applies both trading fees with the program's minimum-one rounding", async () => {
    const fees: FeeValues = [1n, 10_000n, 1n, 10_000n, 0n, 0n, 0n, 0n];
    const intent = { ...fixtureIntent(), expectedOutBaseUnits: "898", minimumOutBaseUnits: "893", slippageBps: 50 };
    const verified = await verifySplTokenSwapQuote({ route, intent, readers: [reader("a", { fees }), reader("b", { fees })], now });
    expect(verified).toMatchObject({ expectedOutBaseUnits: "898", minimumOutBaseUnits: "893", tradeFeeBaseUnits: "1", ownerTradeFeeBaseUnits: "1" });
  });

  it("rejects self-asserted output, loose minimums, and invalid slippage", async () => {
    const readers = [reader("a"), reader("b")];
    await expect(verifySplTokenSwapQuote({ route, intent: { ...fixtureIntent(), expectedOutBaseUnits: "899", minimumOutBaseUnits: "889" }, readers, now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_OUTPUT_MISMATCH");
    await expect(verifySplTokenSwapQuote({ route, intent: { ...fixtureIntent(), minimumOutBaseUnits: "1" }, readers, now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_SLIPPAGE_MISMATCH");
    await expect(verifySplTokenSwapQuote({ route, intent: { ...fixtureIntent(), slippageBps: 501 }, readers, now })).rejects.toThrow("SOLANA_SWAP_INTENT_INVALID");
  });

  it("rejects route-state, vault, curve, authority, and fee substitution", async () => {
    const intent = fixtureIntent();
    await expect(verifySplTokenSwapQuote({ route, intent, readers: [reader("a", { stateChange: (bytes) => setAddress(bytes, 35, key(40)) }), reader("b")], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_STATE_INVALID");
    await expect(verifySplTokenSwapQuote({ route, intent, readers: [reader("a", { sourceChange: (bytes) => setAddress(bytes, 0, key(41)) }), reader("b")], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_VAULT_INVALID");
    await expect(verifySplTokenSwapQuote({ route, intent, readers: [reader("a", { stateChange: (bytes) => { bytes[291] = 1; } }), reader("b")], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_STATE_INVALID");
    await expect(verifySplTokenSwapQuote({ route: { ...route, swapAuthority: key(42) }, intent, readers: [reader("a"), reader("b")], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_AUTHORITY_MISMATCH");
    const invalidFees: FeeValues = [1n, 1n, 0n, 0n, 0n, 0n, 0n, 0n];
    await expect(verifySplTokenSwapQuote({ route, intent, readers: [reader("a", { fees: invalidFees }), reader("b", { fees: invalidFees })], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_FEE_INVALID");
  });

  it("rejects stale, divergent, disagreeing, and one-reader snapshots", async () => {
    const intent = fixtureIntent();
    await expect(verifySplTokenSwapQuote({ route, intent, readers: [reader("a", { slot: 800 }), reader("b")], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_SNAPSHOT_STALE");
    await expect(verifySplTokenSwapQuote({ route, intent, readers: [reader("a", { currentSlot: 1_000, slot: 1_000 }), reader("b", { currentSlot: 1_200, slot: 1_200 })], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_SNAPSHOT_DIVERGED");
    await expect(verifySplTokenSwapQuote({ route, intent, readers: [reader("a"), reader("b", { sourceAmount: 9_001n })], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_QUORUM_MISMATCH");
    await expect(verifySplTokenSwapQuote({ route, intent, readers: [reader("a")], now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_READER_QUORUM_REQUIRED");
  });

  it("uses only bounded read-only JSON-RPC methods and rejects non-public endpoints", async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { jsonrpc: string; id: number; method: string };
      methods.push(body.method);
      const result = body.method === "getGenesisHash" ? genesis : body.method === "getSlot" ? 1_000 : { context: { slot: 1_000 }, value: snapshotAccounts().map((account) => ({ owner: account.owner, executable: account.executable, data: [account.dataBase64, "base64"] })) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const readers = createSplTokenSwapQuoteReaderQuorum(["https://rpc-a.example.org", "https://rpc-b.example.net"], fetchMock as typeof fetch);
    await expect(verifySplTokenSwapQuote({ route, intent: fixtureIntent(), readers, now })).resolves.toMatchObject({ expectedOutBaseUnits: "900" });
    expect(methods.sort()).toEqual(["getGenesisHash", "getGenesisHash", "getMultipleAccounts", "getMultipleAccounts", "getSlot", "getSlot"].sort());
    expect(() => createSplTokenSwapQuoteReaderQuorum(["http://127.0.0.1:8899", "https://rpc-b.example.net"])).toThrow("SPL_TOKEN_SWAP_QUOTE_ENDPOINT_NOT_PUBLIC");
    expect(() => createSplTokenSwapQuoteReaderQuorum(["https://same.example/a", "https://same.example/b"])).toThrow("SPL_TOKEN_SWAP_QUOTE_READER_NOT_INDEPENDENT");
  });
});

type FeeValues = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
type ReaderChanges = { currentSlot?: number; slot?: number; sourceAmount?: bigint; destinationAmount?: bigint; fees?: FeeValues; stateChange?: (bytes: Uint8Array) => void; sourceChange?: (bytes: Uint8Array) => void };

function fixtureIntent(): SolanaSwapIntent {
  return {
    schema: "realdex.solana-swap-intent.v1", venueId: route.venueId, venueRevision: route.revision, chainId: route.chainId,
    authority, sourceMint, destinationMint, sourceTokenAccount: sourceAccount, destinationTokenAccount: destinationAccount, destinationTokenOwner: destinationOwner,
    tokenProgramAddress: tokenProgram, executionTarget: swapState, amountInBaseUnits: "1000", expectedOutBaseUnits: "900", minimumOutBaseUnits: "890", slippageBps: 111,
    quoteExpiresAt: now + 60_000, lastValidBlockHeight: 2_000, transactionBase64: "AQ=="
  };
}

function reader(id: string, changes: ReaderChanges = {}): SplTokenSwapQuoteReader {
  return {
    id, genesisHash: async () => genesis, currentSlot: async () => changes.currentSlot ?? 1_000,
    accounts: async () => ({ slot: changes.slot ?? 1_000, accounts: snapshotAccounts(changes) })
  };
}

function snapshotAccounts(changes: ReaderChanges = {}): SolanaReadonlyAccount[] {
  const state = swapStateBytes(changes.fees); changes.stateChange?.(state);
  const source = tokenAccountBytes(sourceMint, swapAuthority, changes.sourceAmount ?? 9_000n); changes.sourceChange?.(source);
  return [
    { owner: program, executable: false, dataBase64: base64.encode(state) },
    { owner: tokenProgram, executable: false, dataBase64: base64.encode(source) },
    { owner: tokenProgram, executable: false, dataBase64: base64.encode(tokenAccountBytes(destinationMint, swapAuthority, changes.destinationAmount ?? 9_000n)) }
  ];
}

function swapStateBytes(fees: FeeValues = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]): Uint8Array {
  const bytes = new Uint8Array(324), view = new DataView(bytes.buffer); bytes[0] = 1; bytes[1] = 1; bytes[2] = 255;
  setAddress(bytes, 3, tokenProgram); setAddress(bytes, 35, poolSource); setAddress(bytes, 67, poolDestination); setAddress(bytes, 99, poolMint);
  setAddress(bytes, 131, sourceMint); setAddress(bytes, 163, destinationMint); setAddress(bytes, 195, poolFee);
  fees.forEach((value, index) => view.setBigUint64(227 + index * 8, value, true)); bytes[291] = 0;
  return bytes;
}

function tokenAccountBytes(mint: string, owner: string, amount: bigint): Uint8Array {
  const bytes = new Uint8Array(165), view = new DataView(bytes.buffer); setAddress(bytes, 0, mint); setAddress(bytes, 32, owner); view.setBigUint64(64, amount, true); bytes[108] = 1; return bytes;
}
function setAddress(bytes: Uint8Array, offset: number, value: string): void { bytes.set(base58.decode(value), offset); }
