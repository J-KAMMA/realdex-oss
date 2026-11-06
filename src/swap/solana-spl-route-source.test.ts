import { ed25519 } from "@noble/curves/ed25519";
import { base58, base64 } from "@scure/base";
import { AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getTransactionDecoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { SOLANA_SWAP_BOUNDARY_ID, type SolanaSwapIntent, type SolanaSwapReader } from "./solana-swap-boundary";
import type { SplTokenSwapExactInRouteDescriptor } from "./spl-token-swap-exact-in-decoder";
import { SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID, type SplTokenSwapQuoteReader } from "./spl-token-swap-quote-boundary";
import {
  canonicalSignedSolanaSplRouteManifestPayload,
  solanaSplRouteFingerprint,
  verifySignedSolanaSplRouteManifest,
  verifySourceBoundSplTokenSwap,
  type SignedSolanaSplRouteManifest
} from "./solana-spl-route-source";
import { solanaVenueSourceFingerprint, type SolanaVenueSourceDescriptor } from "./solana-venue-source";
import { canonicalSignedSolanaReadPolicyPayload, solanaReadPolicySourceFingerprint, verifySignedSolanaReadPolicy, type SignedSolanaReadPolicy, type SolanaReadPolicySourceDescriptor } from "./solana-read-policy";

const now = 1_800_000_000_000;
const key = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 3) % 256));
const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = base58.encode(ed25519.getPublicKey(privateKey));
const genesis = key(1), program = key(2), loader = key(3), programData = key(4), swapState = key(5), swapAuthority = "4KcPqwnbZXJ8Bqg9twqjrbSn6NZs7KpoJzenXTHejCaJ";
const poolSource = key(7), poolDestination = key(8), poolMint = key(9), poolFee = key(10), sourceMint = key(11), destinationMint = key(12);
const authority = key(13), sourceAccount = key(14), destinationAccount = key(15), destinationOwner = key(16), recentBlockhash = key(18);
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const programDataBytes = Uint8Array.from([9, 8, 7, 6]);
const chainId = `solana:${genesis.slice(0, 32)}` as const;

const source: SolanaVenueSourceDescriptor = {
  schema: "realdex.solana-venue-source.v1", id: "reviewed.solana.spl-routes", name: "Reviewed SPL Token Swap routes",
  signerPublicKey: publicKey, allowedChainIds: [chainId], evidenceUrls: ["https://policy.example.org/solana/spl-routes"]
};
const readPolicyPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 71);
const readPolicySource: SolanaReadPolicySourceDescriptor = {
  schema: "realdex.solana-read-policy-source.v1", id: "independent.solana.rpc-policy", name: "Independent Solana RPC policy",
  signerPublicKey: base58.encode(ed25519.getPublicKey(readPolicyPrivateKey)), allowedChainIds: [chainId], evidenceUrls: ["https://policy.example.org/solana/rpc-source"]
};

describe("signed Solana SPL Token Swap route source", () => {
  it("accepts an exact signed account topology while keeping execution and submission disabled", async () => {
    const route = await fixtureRoute();
    const manifest = await signedManifest([route]);
    const verified = await verifySignedSolanaSplRouteManifest(manifest, source, { now });
    expect(verified).toMatchObject({ status: "verified-design-gate", executionEnabled: false, submissionEnabled: false, routes: [route] });
    expect(verified.sourceFingerprint).toBe(await solanaVenueSourceFingerprint(source));
    expect(verified.routeFingerprints).toEqual([await solanaSplRouteFingerprint(route)]);
    expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects signature mutation, source substitution, unknown fields, route substitution, and duplicate routes", async () => {
    const route = await fixtureRoute();
    const manifest = await signedManifest([route]);
    await expect(verifySignedSolanaSplRouteManifest({ ...manifest, revision: 2 }, source, { now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_SIGNER_NOT_PINNED");
    await expect(verifySignedSolanaSplRouteManifest(manifest, { ...source, id: "another.solana.source" }, { now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_SOURCE_MISMATCH");
    await expect(verifySignedSolanaSplRouteManifest({ ...manifest, extra: true }, source, { now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_INVALID");
    await expect(verifySignedSolanaSplRouteManifest({ ...manifest, routes: [{ ...route, extra: true }] }, source, { now })).rejects.toThrow("SPL_TOKEN_SWAP_ROUTE_INVALID");
    await expect(verifySignedSolanaSplRouteManifest({ ...manifest, routes: [{ ...route, poolFeeAccount: poolMint }] }, source, { now })).rejects.toThrow("SPL_TOKEN_SWAP_ROUTE_INVALID");
    await expect(verifySignedSolanaSplRouteManifest(await signedManifest([route, route]), source, { now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_ROUTE_DUPLICATE");
    await expect(verifySignedSolanaSplRouteManifest(await signedManifest([{ ...route, chainId: `solana:${key(40).slice(0, 32)}` }]), source, { now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_CHAIN_NOT_ALLOWED");
  });

  it("rejects expiry, excessive validity, rollback, equivocation, and malformed heads", async () => {
    const route = await fixtureRoute();
    const expired = await signedManifest([route], { issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now).toISOString() });
    await expect(verifySignedSolanaSplRouteManifest(expired, source, { now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_EXPIRED");
    const long = await signedManifest([route], { issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 31 * 24 * 60 * 60 * 1_000).toISOString() });
    await expect(verifySignedSolanaSplRouteManifest(long, source, { now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_VALIDITY_INVALID");
    const revisionTwo = await signedManifest([route], { revision: 2 });
    const accepted = await verifySignedSolanaSplRouteManifest(revisionTwo, source, { now });
    await expect(verifySignedSolanaSplRouteManifest(await signedManifest([route], { revision: 1 }), source, { now, previousHead: { revision: 2, payloadHash: accepted.payloadHash } })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_ROLLBACK_BLOCKED");
    await expect(verifySignedSolanaSplRouteManifest(await signedManifest([{ ...route, revision: 2 }], { revision: 2 }), source, { now, previousHead: { revision: 2, payloadHash: accepted.payloadHash } })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_REVISION_CONFLICT");
    await expect(verifySignedSolanaSplRouteManifest(revisionTwo, source, { now, previousHead: { revision: 0, payloadHash: "bad" } })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_HEAD_INVALID");
  });

  it("freshly derives venue, decoder, quote readers, and simulation readers from signed route and read policy", async () => {
    const route = await fixtureRoute();
    const manifest = await signedManifest([route]);
    const intent = fixtureIntent(route);
    const readPolicy = await verifySignedSolanaReadPolicy(await signedReadPolicy(), readPolicySource, { now });
    const fetchMock = rpcFetch(intent);
    const result = await verifySourceBoundSplTokenSwap({ source, signedManifest: manifest, venueId: route.venueId, intent, readPolicy, fetchImpl: fetchMock, now });
    expect(result).toMatchObject({ execution: "design-gate", executionEnabled: false, submissionEnabled: false, sourceDebitBaseUnits: "1000", destinationCreditBaseUnits: "900" });
    expect(result.quote).toMatchObject({ expectedOutBaseUnits: "900", sourceReserveBaseUnits: "9000", destinationReserveBaseUnits: "9000" });
    expect(result.routeFingerprint).toBe(await solanaSplRouteFingerprint(route));
    expect(result.readPolicySourceFingerprint).toBe(readPolicy.sourceFingerprint);
    expect(result.readPolicyPayloadHash).toBe(readPolicy.payloadHash);
    await expect(verifySourceBoundSplTokenSwap({ source, signedManifest: { ...manifest, revision: 2 }, venueId: route.venueId, intent, readPolicy, fetchImpl: fetchMock, now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_SIGNER_NOT_PINNED");
    await expect(verifySourceBoundSplTokenSwap({ source, signedManifest: manifest, venueId: "missing", intent, readPolicy, fetchImpl: fetchMock, now })).rejects.toThrow("SOLANA_SPL_ROUTE_MANIFEST_ROUTE_NOT_FOUND");
    await expect(verifySourceBoundSplTokenSwap({ source, signedManifest: manifest, venueId: route.venueId, intent: { ...intent, executionTarget: key(44) }, readPolicy, fetchImpl: fetchMock, now })).rejects.toThrow("SPL_TOKEN_SWAP_QUOTE_INTENT_IDENTITY_INVALID");
    const otherChainSource = { ...readPolicySource, allowedChainIds: [chainId, `solana:${key(40).slice(0, 32)}`] };
    const otherChainPolicy = await verifySignedSolanaReadPolicy(await signedReadPolicy({ chainId: `solana:${key(40).slice(0, 32)}` }, otherChainSource), otherChainSource, { now });
    await expect(verifySourceBoundSplTokenSwap({ source, signedManifest: manifest, venueId: route.venueId, intent, readPolicy: otherChainPolicy, fetchImpl: fetchMock, now })).rejects.toThrow("SOLANA_READ_POLICY_ROUTE_CHAIN_MISMATCH");
    const sameKeySource = { ...readPolicySource, id: "same-key.solana.rpc-policy", signerPublicKey: source.signerPublicKey };
    const sameKeyPolicy = await verifySignedSolanaReadPolicy(await signedReadPolicy({}, sameKeySource, privateKey), sameKeySource, { now });
    await expect(verifySourceBoundSplTokenSwap({ source, signedManifest: manifest, venueId: route.venueId, intent, readPolicy: sameKeyPolicy, fetchImpl: fetchMock, now })).rejects.toThrow("SOLANA_READ_POLICY_REVIEWER_NOT_INDEPENDENT");
  });
});

async function fixtureRoute(): Promise<SplTokenSwapExactInRouteDescriptor> {
  const digest = await crypto.subtle.digest("SHA-256", programDataBytes);
  return {
    schema: "realdex.spl-token-swap-exact-in-route.v1", venueId: "reviewed-spl-token-swap-pool", revision: 1, chainId,
    programAddress: program, programOwner: loader, programDataAddress: programData, programDataSha256: hex(new Uint8Array(digest)), tokenProgramAddress: tokenProgram,
    swapState, swapAuthority, poolSourceTokenAccount: poolSource, poolDestinationTokenAccount: poolDestination, poolMint, poolFeeAccount: poolFee,
    sourceMint, destinationMint, hostFeeAccount: null,
    evidenceUrls: ["https://github.com/solana-labs/solana-program-library/blob/master/token-swap/program/src/instruction.rs", "https://github.com/solana-labs/solana-program-library/blob/master/docs/src/token-swap.md"]
  };
}

async function signedManifest(routes: SplTokenSwapExactInRouteDescriptor[], changes: Partial<Omit<SignedSolanaSplRouteManifest, "signature" | "routes">> = {}): Promise<SignedSolanaSplRouteManifest> {
  const unsigned: Omit<SignedSolanaSplRouteManifest, "signature"> = {
    schema: "realdex.signed-solana-spl-routes.v1" as const, sourceId: source.id, sourceFingerprint: await solanaVenueSourceFingerprint(source), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), routes,
    evidenceUrls: ["https://manifest.example.org/solana/spl-routes"], ...changes
  };
  return { ...unsigned, signature: base58.encode(ed25519.sign(new TextEncoder().encode(canonicalSignedSolanaSplRouteManifestPayload(unsigned)), privateKey)) };
}

async function signedReadPolicy(changes: Partial<Omit<SignedSolanaReadPolicy, "signature">> = {}, sourceValue: SolanaReadPolicySourceDescriptor = readPolicySource, signerKey: Uint8Array = readPolicyPrivateKey): Promise<SignedSolanaReadPolicy> {
  const unsigned: Omit<SignedSolanaReadPolicy, "signature"> = {
    schema: "realdex.signed-solana-read-policy.v1" as const, sourceId: sourceValue.id, sourceFingerprint: await solanaReadPolicySourceFingerprint(sourceValue), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), chainId,
    rpcEndpoints: ["https://rpc-a.example.org", "https://rpc-b.example.net"] as [string, string],
    quoteBoundaryId: SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID, simulationBoundaryId: SOLANA_SWAP_BOUNDARY_ID,
    evidenceUrls: ["https://policy.example.org/solana/rpc-policy"], ...changes
  };
  return { ...unsigned, signature: base58.encode(ed25519.sign(new TextEncoder().encode(canonicalSignedSolanaReadPolicyPayload(unsigned)), signerKey)) };
}

function rpcFetch(intent: SolanaSwapIntent): typeof fetch {
  const transaction = getTransactionDecoder().decode(base64.decode(intent.transactionBase64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const sourceIndex = compiled.staticAccounts.indexOf(sourceAccount as never), destinationIndex = compiled.staticAccounts.indexOf(destinationAccount as never);
  const pointer = new Uint8Array(36); new DataView(pointer.buffer).setUint32(0, 2, true); pointer.set(base58.decode(programData), 4);
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { jsonrpc: string; id: number; method: string; params: unknown[] };
    let result: unknown;
    if (request.method === "getGenesisHash") result = genesis;
    else if (request.method === "getSlot") result = 1_000;
    else if (request.method === "getBlockHeight") result = 150;
    else if (request.method === "isBlockhashValid") result = { context: { slot: 999 }, value: true };
    else if (request.method === "getMultipleAccounts") result = { context: { slot: 1_000 }, value: [
      rpcAccount(program, false, swapStateBytes()), rpcAccount(tokenProgram, false, tokenAccountBytes(sourceMint, 9_000n)), rpcAccount(tokenProgram, false, tokenAccountBytes(destinationMint, 9_000n))
    ] };
    else if (request.method === "getAccountInfo") {
      const requested = request.params[0];
      result = { context: { slot: 999 }, value: requested === program ? rpcAccount(loader, true, pointer) : requested === programData ? rpcAccount(loader, false, programDataBytes) : null };
    } else if (request.method === "simulateTransaction") result = { context: { slot: 1_000 }, value: {
      err: null, unitsConsumed: 120_000, fee: 5_000,
      preTokenBalances: [rpcTokenBalance(sourceIndex, sourceMint, authority, "5000"), rpcTokenBalance(destinationIndex, destinationMint, destinationOwner, "100")],
      postTokenBalances: [rpcTokenBalance(sourceIndex, sourceMint, authority, "4000"), rpcTokenBalance(destinationIndex, destinationMint, destinationOwner, "1000")]
    } };
    else throw new Error(`unexpected Solana method ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function rpcAccount(owner: string, executable: boolean, data: Uint8Array) { return { owner, executable, data: [base64.encode(data), "base64"] }; }
function rpcTokenBalance(accountIndex: number, mint: string, owner: string, amount: string) { return { accountIndex, mint, owner, uiTokenAmount: { amount, decimals: 0, uiAmount: Number(amount), uiAmountString: amount } }; }

function fixtureIntent(route: SplTokenSwapExactInRouteDescriptor): SolanaSwapIntent {
  return {
    schema: "realdex.solana-swap-intent.v1", venueId: route.venueId, venueRevision: route.revision, chainId: route.chainId,
    authority, sourceMint, destinationMint, sourceTokenAccount: sourceAccount, destinationTokenAccount: destinationAccount, destinationTokenOwner: destinationOwner,
    tokenProgramAddress: tokenProgram, executionTarget: swapState, amountInBaseUnits: "1000", expectedOutBaseUnits: "900", minimumOutBaseUnits: "890", slippageBps: 111,
    quoteExpiresAt: now + 60_000, lastValidBlockHeight: 200, transactionBase64: wire()
  };
}

function instruction(): Uint8Array { const bytes = new Uint8Array(17), view = new DataView(bytes.buffer); bytes[0] = 1; view.setBigUint64(1, 1_000n, true); view.setBigUint64(9, 890n, true); return bytes; }
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

function reader(id: string): SolanaSwapReader {
  const pointer = new Uint8Array(36); new DataView(pointer.buffer).setUint32(0, 2, true); pointer.set(base58.decode(programData), 4);
  return {
    id, genesisHash: async () => genesis, blockHeight: async () => 150, blockhashValid: async () => true,
    account: async (accountAddress) => accountAddress === program ? { owner: loader, executable: true, dataBase64: base64.encode(pointer) } : accountAddress === programData ? { owner: loader, executable: false, dataBase64: base64.encode(programDataBytes) } : null,
    simulate: async () => ({ slot: 1_000, error: null, unitsConsumed: 120_000, feeLamports: 5_000, source: { mint: sourceMint, owner: authority, preAmount: "5000", postAmount: "4000" }, destination: { mint: destinationMint, owner: destinationOwner, preAmount: "100", postAmount: "1000" } })
  };
}

function quoteReader(id: string): SplTokenSwapQuoteReader {
  return { id, genesisHash: async () => genesis, currentSlot: async () => 1_000, accounts: async () => ({ slot: 1_000, accounts: [
    { owner: program, executable: false, dataBase64: base64.encode(swapStateBytes()) },
    { owner: tokenProgram, executable: false, dataBase64: base64.encode(tokenAccountBytes(sourceMint, 9_000n)) },
    { owner: tokenProgram, executable: false, dataBase64: base64.encode(tokenAccountBytes(destinationMint, 9_000n)) }
  ] }) };
}

function swapStateBytes(): Uint8Array {
  const bytes = new Uint8Array(324); bytes[0] = 1; bytes[1] = 1; bytes[2] = 255;
  setAddress(bytes, 3, tokenProgram); setAddress(bytes, 35, poolSource); setAddress(bytes, 67, poolDestination); setAddress(bytes, 99, poolMint);
  setAddress(bytes, 131, sourceMint); setAddress(bytes, 163, destinationMint); setAddress(bytes, 195, poolFee); return bytes;
}
function tokenAccountBytes(mint: string, amount: bigint): Uint8Array { const bytes = new Uint8Array(165); setAddress(bytes, 0, mint); setAddress(bytes, 32, swapAuthority); new DataView(bytes.buffer).setBigUint64(64, amount, true); bytes[108] = 1; return bytes; }
function setAddress(bytes: Uint8Array, offset: number, value: string): void { bytes.set(base58.decode(value), offset); }

function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
