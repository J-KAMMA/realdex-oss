import { ed25519 } from "@noble/curves/ed25519";
import { base58, base64 } from "@scure/base";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash
} from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSolanaWalletStandard, type SolanaStandardAccountBinding, type SolanaStandardConnection } from "../wallet/solana-standard-session";
import { SOLANA_SWAP_BOUNDARY_ID, type SolanaSwapIntent } from "./solana-swap-boundary";
import {
  canonicalSignedSolanaSplRouteManifestPayload,
  verifySourceBoundSplTokenSwap,
  type SignedSolanaSplRouteManifest,
  type VerifiedSourceBoundSplTokenSwap
} from "./solana-spl-route-source";
import type { SplTokenSwapExactInRouteDescriptor } from "./spl-token-swap-exact-in-decoder";
import { SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID } from "./spl-token-swap-quote-boundary";
import { canonicalSignedSolanaReadPolicyPayload, solanaReadPolicySourceFingerprint, verifySignedSolanaReadPolicy, type SignedSolanaReadPolicy, type SolanaReadPolicySourceDescriptor } from "./solana-read-policy";
import { solanaVenueSourceFingerprint, type SolanaVenueSourceDescriptor } from "./solana-venue-source";
import { prepareSolanaStandardSigning } from "./solana-standard-signing-preparation";
import { assertGenuineSolanaStandardSignedSwapEvidence, verifySolanaStandardSignedSwap } from "./solana-standard-signed-swap-evidence";

const now = 1_800_000_000_000;
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
// Synthetic 32-byte genesis whose CAIP reference is the pinned 32-char prefix.
const genesis = `${DEVNET.slice("solana:".length)}11111111111`;
const key = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 3) % 256));
const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = base58.encode(ed25519.getPublicKey(privateKey));
const program = key(2), loader = key(3), programData = key(4), swapState = key(5), swapAuthority = "4KcPqwnbZXJ8Bqg9twqjrbSn6NZs7KpoJzenXTHejCaJ";
const poolSource = key(7), poolDestination = key(8), poolMint = key(9), poolFee = key(10), sourceMint = key(11), destinationMint = key(12);
const walletPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 101);
const authority = base58.encode(ed25519.getPublicKey(walletPrivateKey)), sourceAccount = key(14), destinationAccount = key(15), destinationOwner = key(16), recentBlockhash = key(18);
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const programDataBytes = Uint8Array.from([9, 8, 7, 6]);
const chainId = DEVNET;
const readPolicyPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 71);

const source: SolanaVenueSourceDescriptor = {
  schema: "realdex.solana-venue-source.v1", id: "reviewed.solana.spl-routes", name: "Reviewed SPL Token Swap routes",
  signerPublicKey: publicKey, allowedChainIds: [chainId], evidenceUrls: ["https://policy.example.org/solana/spl-routes"]
};
const readPolicySource: SolanaReadPolicySourceDescriptor = {
  schema: "realdex.solana-read-policy-source.v1", id: "independent.solana.rpc-policy", name: "Independent Solana RPC policy",
  signerPublicKey: base58.encode(ed25519.getPublicKey(readPolicyPrivateKey)), allowedChainIds: [chainId], evidenceUrls: ["https://policy.example.org/solana/rpc-source"]
};

type Fixture = {
  intent: SolanaSwapIntent;
  verified: VerifiedSourceBoundSplTokenSwap;
};
type SyntheticAccount = { address: string; publicKey: Uint8Array; chains: string[]; features: string[] };
type SyntheticWallet = {
  version: string;
  name: string;
  chains: string[];
  features: Record<string, any>;
  accounts: SyntheticAccount[];
  signCalls: number;
  emit(payload?: unknown): void;
  setAccounts(accounts: SyntheticAccount[]): void;
};

const liveConnections: SolanaStandardConnection[] = [];

afterEach(() => {
  for (const connection of liveConnections) connection.dispose();
  liveConnections.length = 0;
});

describe("Solana Standard signing preparation", () => {
  it("returns a frozen exact binding package with every authority flag disabled and never signs", async () => {
    const fixture = await makeFixture();
    const session = await makeSession(fixture);
    const preparation = await prepareSolanaStandardSigning({ ...fixture, ...session, now });

    expect(preparation).toMatchObject({
      schema: "realdex.solana-standard-signing-preparation.v1",
      preparedAt: now,
      expiresAt: fixture.intent.quoteExpiresAt,
      walletId: "synthetic-wallet",
      sessionId: session.binding.sessionId,
      accountId: `${chainId}:${authority}`,
      authority,
      chainId,
      walletChain: "solana:devnet",
      transactionVersion: 0,
      venueId: fixture.intent.venueId,
      executionTarget: fixture.intent.executionTarget,
      sourceMint: fixture.intent.sourceMint,
      destinationMint: fixture.intent.destinationMint,
      destinationTokenAccount: fixture.intent.destinationTokenAccount,
      destinationTokenOwner: fixture.intent.destinationTokenOwner,
      amountInBaseUnits: "1000",
      expectedOutBaseUnits: "900",
      minimumOutBaseUnits: "890",
      feeLamports: 5_000,
      transactionBase64: fixture.intent.transactionBase64,
      transactionSha256: fixture.verified.transactionSha256,
      intentSha256: fixture.verified.intentSha256,
      sourceFingerprint: fixture.verified.sourceFingerprint,
      routeFingerprint: fixture.verified.routeFingerprint,
      manifestPayloadHash: fixture.verified.manifestPayloadHash,
      readPolicySourceFingerprint: fixture.verified.readPolicySourceFingerprint,
      readPolicyPayloadHash: fixture.verified.readPolicyPayloadHash,
      requiresFreshVerification: true,
      signingEnabled: false,
      submissionEnabled: false,
      executionEnabled: false
    });
    expect(preparation.preparationId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.isFrozen(preparation)).toBe(true);
    expect(session.wallet.signCalls).toBe(0);
  });

  it("requires the selected transaction version, account, and chain to match the intent exactly", async () => {
    const fixture = await makeFixture();
    const legacySession = await makeSession(fixture, "legacy");
    await expect(prepareSolanaStandardSigning({ ...fixture, ...legacySession, now })).rejects.toThrow("SOLANA_SIGNING_PREPARATION_VERSION_UNSUPPORTED");

    const accountSession = await makeSession(fixture);
    await expect(prepareSolanaStandardSigning({ ...fixture, ...accountSession, intent: { ...fixture.intent, authority: key(44) }, now })).rejects.toThrow("SOLANA_SIGNING_PREPARATION_ACCOUNT_MISMATCH");
    await expect(prepareSolanaStandardSigning({ ...fixture, ...accountSession, intent: { ...fixture.intent, chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, now })).rejects.toThrow("SOLANA_SIGNING_PREPARATION_ACCOUNT_MISMATCH");
  });

  it("accepts only genuine source-bound evidence, rejecting clones, forgeries, and mutation", async () => {
    const fixture = await makeFixture();
    const session = await makeSession(fixture);
    const cloned = structuredClone(fixture.verified);
    await expect(prepareSolanaStandardSigning({ ...fixture, verified: cloned, ...session, now })).rejects.toThrow("SOLANA_SPL_VERIFIED_SWAP_NOT_AUTHENTIC");

    const forged = { ...fixture.verified, routeFingerprint: "00".repeat(32) };
    await expect(prepareSolanaStandardSigning({ ...fixture, verified: forged, ...session, now })).rejects.toThrow("SOLANA_SPL_VERIFIED_SWAP_NOT_AUTHENTIC");

    const changedFixture = await makeFixture();
    const changedSession = await makeSession(changedFixture);
    changedFixture.verified.feeLamports += 1;
    await expect(prepareSolanaStandardSigning({ ...changedFixture, ...changedSession, now })).rejects.toThrow("SOLANA_SPL_VERIFIED_SWAP_CHANGED");
  });

  it("rejects cloned and mutated account bindings before preparing a signing package", async () => {
    const fixture = await makeFixture();
    const session = await makeSession(fixture);
    const cloned = { ...session.binding };
    await expect(prepareSolanaStandardSigning({ ...fixture, binding: cloned, connection: session.connection, now })).rejects.toThrow("SOLANA_STANDARD_BINDING_NOT_CURRENT");

    const changed = await makeFixture();
    const changedSession = await makeSession(changed);
    changedSession.binding.address = key(99);
    await expect(prepareSolanaStandardSigning({ ...changed, ...changedSession, now })).rejects.toThrow("SOLANA_STANDARD_BINDING_CHANGED");
  });

  it("fails closed when either the selected session or the verified quote has expired", async () => {
    const fixture = await makeFixture();
    let clock = now;
    const session = await makeSession(fixture, 0, () => clock);
    clock = session.binding.expiresAt + 1;
    await expect(prepareSolanaStandardSigning({ ...fixture, ...session, now: clock })).rejects.toThrow("SOLANA_STANDARD_SESSION_EXPIRED");

    const quoteFixture = await makeFixture();
    const quoteSession = await makeSession(quoteFixture);
    await expect(prepareSolanaStandardSigning({ ...quoteFixture, ...quoteSession, now: quoteFixture.intent.quoteExpiresAt })).rejects.toThrow("SOLANA_SIGNING_PREPARATION_EXPIRED");
  });

  it("observes provider events and silent account mutation while asynchronous hashes are in flight", async () => {
    const eventFixture = await makeFixture();
    const eventSession = await makeSession(eventFixture);
    queueMicrotask(() => eventSession.wallet.emit({ accounts: [] }));
    await expect(prepareSolanaStandardSigning({ ...eventFixture, ...eventSession, now })).rejects.toThrow("SOLANA_STANDARD_SESSION_INVALIDATED");

    const silentFixture = await makeFixture();
    const silentSession = await makeSession(silentFixture);
    queueMicrotask(() => silentSession.wallet.setAccounts([syntheticAccount(key(77))]));
    await expect(prepareSolanaStandardSigning({ ...silentFixture, ...silentSession, now })).rejects.toThrow("SOLANA_STANDARD_SESSION_CHANGED");
  });

  it("binds the unsigned transaction hash and rejects pre-signed or changed transaction bytes", async () => {
    const fixture = await makeFixture();
    const session = await makeSession(fixture);
    const bytes = base64.decode(fixture.intent.transactionBase64);
    bytes.set(new Uint8Array(64).fill(7), 1);
    const preSigned = { ...fixture.intent, transactionBase64: base64.encode(bytes) };
    await expect(prepareSolanaStandardSigning({ ...fixture, intent: preSigned, ...session, now })).rejects.toThrow("SOLANA_SIGNING_PREPARATION_HASH_MISMATCH");

    const changedBytes = base64.decode(fixture.intent.transactionBase64);
    changedBytes[changedBytes.length - 1] ^= 1;
    await expect(prepareSolanaStandardSigning({ ...fixture, intent: { ...fixture.intent, transactionBase64: base64.encode(changedBytes) }, ...session, now })).rejects.toThrow("SOLANA_SIGNING_PREPARATION_HASH_MISMATCH");
  });
});

describe("Solana Standard signed swap evidence", () => {
  it("classifies verified wallet-returned bytes as signed-not-submitted without retaining rebroadcast material", async () => {
    const fixture = await makeFixture();
    const session = await makeSession(fixture);
    const preparation = await prepareSolanaStandardSigning({ ...fixture, ...session, now });
    const signed = signIntent(fixture.intent);
    const evidence = await verifySolanaStandardSignedSwap({ ...fixture, ...session, preparation, ...signed, now: now + 1 });

    expect(evidence).toMatchObject({
      schema: "realdex.solana-standard-signed-swap-evidence.v1",
      preparationId: preparation.preparationId,
      authority,
      chainId,
      amountInBaseUnits: "1000",
      expectedOutBaseUnits: "900",
      minimumOutBaseUnits: "890",
      transactionSignature: signed.transactionSignature,
      unsignedTransactionSha256: preparation.transactionSha256,
      intentSha256: preparation.intentSha256,
      stage: "signed-not-submitted",
      signedTransactionBytesStored: false,
      automaticResendBlocked: true,
      requiresExplicitSubmissionAuthorization: true,
      submissionEnabled: false,
      executionEnabled: false
    });
    expect(evidence.evidenceId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.keys(evidence)).not.toContain("signedTransactionBase64");
    expect(JSON.stringify(evidence)).not.toContain(signed.signedTransactionBase64);
    expect(session.wallet.signCalls).toBe(0);
    expect(() => assertGenuineSolanaStandardSignedSwapEvidence(evidence)).not.toThrow();
    expect(() => assertGenuineSolanaStandardSignedSwapEvidence(structuredClone(evidence))).toThrow("SOLANA_SIGNED_SWAP_EVIDENCE_NOT_AUTHENTIC");
  });

  it("rejects a cloned preparation even when every visible field matches", async () => {
    const fixture = await makeFixture();
    const session = await makeSession(fixture);
    const preparation = await prepareSolanaStandardSigning({ ...fixture, ...session, now });
    await expect(verifySolanaStandardSignedSwap({ ...fixture, ...session, preparation: structuredClone(preparation), ...signIntent(fixture.intent), now: now + 1 })).rejects.toThrow("SOLANA_SIGNING_PREPARATION_NOT_AUTHENTIC");
  });

  it("rejects changed signed bytes and a signature from another authority", async () => {
    const fixture = await makeFixture();
    const session = await makeSession(fixture);
    const preparation = await prepareSolanaStandardSigning({ ...fixture, ...session, now });
    const signed = signIntent(fixture.intent);
    const changed = base64.decode(signed.signedTransactionBase64);
    changed[changed.length - 1] ^= 1;
    await expect(verifySolanaStandardSignedSwap({ ...fixture, ...session, preparation, signedTransactionBase64: base64.encode(changed), transactionSignature: signed.transactionSignature, now: now + 1 })).rejects.toThrow("SOLANA_SWAP_RECOVERY_TRANSACTION_INVALID");

    const wrongSignature = base58.encode(ed25519.sign(Uint8Array.from(getTransactionDecoder().decode(base64.decode(fixture.intent.transactionBase64)).messageBytes), privateKey));
    const wrongBytes = base64.decode(fixture.intent.transactionBase64); wrongBytes.set(base58.decode(wrongSignature), 1);
    await expect(verifySolanaStandardSignedSwap({ ...fixture, ...session, preparation, signedTransactionBase64: base64.encode(wrongBytes), transactionSignature: wrongSignature, now: now + 1 })).rejects.toThrow("SOLANA_SWAP_RECOVERY_SIGNATURE_INVALID");
  });

  it("rejects expiry and account invalidation while signature verification is in flight", async () => {
    const expiredFixture = await makeFixture();
    const expiredSession = await makeSession(expiredFixture);
    const expiredPreparation = await prepareSolanaStandardSigning({ ...expiredFixture, ...expiredSession, now });
    await expect(verifySolanaStandardSignedSwap({ ...expiredFixture, ...expiredSession, preparation: expiredPreparation, ...signIntent(expiredFixture.intent), now: expiredPreparation.expiresAt })).rejects.toThrow("SOLANA_SIGNED_SWAP_PREPARATION_EXPIRED");

    const changedFixture = await makeFixture();
    const changedSession = await makeSession(changedFixture);
    const changedPreparation = await prepareSolanaStandardSigning({ ...changedFixture, ...changedSession, now });
    queueMicrotask(() => changedSession.wallet.emit({ accounts: [] }));
    await expect(verifySolanaStandardSignedSwap({ ...changedFixture, ...changedSession, preparation: changedPreparation, ...signIntent(changedFixture.intent), now: now + 1 })).rejects.toThrow("SOLANA_STANDARD_SESSION_INVALIDATED");
  });
});

async function makeFixture(): Promise<Fixture> {
  const route = await fixtureRoute();
  const intent = fixtureIntent(route);
  const manifest = await signedManifest([route]);
  const readPolicy = await verifySignedSolanaReadPolicy(await signedReadPolicy(), readPolicySource, { now });
  const verified = await verifySourceBoundSplTokenSwap({ source, signedManifest: manifest, venueId: route.venueId, intent, readPolicy, fetchImpl: rpcFetch(intent), now });
  return { intent, verified };
}

function signIntent(intent: SolanaSwapIntent): { signedTransactionBase64: string; transactionSignature: string } {
  const unsignedBytes = base64.decode(intent.transactionBase64);
  const transaction = getTransactionDecoder().decode(unsignedBytes);
  const signature = ed25519.sign(Uint8Array.from(transaction.messageBytes), walletPrivateKey);
  const signedBytes = Uint8Array.from(unsignedBytes);
  signedBytes.set(signature, 1);
  return { signedTransactionBase64: base64.encode(signedBytes), transactionSignature: base58.encode(signature) };
}

async function makeSession(fixture: Fixture, version: "legacy" | 0 = 0, clock: () => number = () => now) {
  const wallet = makeWallet(fixture.intent.authority);
  const connection = await connectSolanaWalletStandard(wallet, { walletId: "synthetic-wallet", chainId }, { now: clock });
  liveConnections.push(connection);
  const binding = connection.selectAccount(fixture.intent.authority, version);
  return { wallet, connection, binding };
}

function syntheticAccount(value: string): SyntheticAccount {
  const publicKey = base58.decode(value);
  return { address: value, publicKey, chains: ["solana:devnet"], features: ["solana:signTransaction"] };
}

function makeWallet(accountAddress: string): SyntheticWallet {
  let accounts = [syntheticAccount(accountAddress)];
  let listener: ((payload?: unknown) => void) | undefined;
  const wallet: SyntheticWallet = {
    version: "1.0.0", name: "Synthetic Wallet Standard provider", chains: ["solana:devnet"], features: {}, accounts: [], signCalls: 0,
    emit: (payload) => listener?.(payload), setAccounts: (next) => { accounts = next; }
  };
  wallet.features["standard:connect"] = { version: "1.0.0", connect: async ({ silent }: { silent: boolean }) => { expect(silent).toBe(false); return { accounts }; } };
  wallet.features["standard:events"] = { version: "1.0.0", on: (_event: string, callback: (payload?: unknown) => void) => { listener = callback; return () => { listener = undefined; }; } };
  wallet.features["solana:signTransaction"] = { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: vi.fn(() => { wallet.signCalls += 1; }) };
  Object.defineProperty(wallet, "accounts", { configurable: true, get: () => accounts });
  return wallet;
}

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

async function signedManifest(routes: SplTokenSwapExactInRouteDescriptor[]): Promise<SignedSolanaSplRouteManifest> {
  const unsigned: Omit<SignedSolanaSplRouteManifest, "signature"> = {
    schema: "realdex.signed-solana-spl-routes.v1", sourceId: source.id, sourceFingerprint: await solanaVenueSourceFingerprint(source), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), routes,
    evidenceUrls: ["https://manifest.example.org/solana/spl-routes"]
  };
  return { ...unsigned, signature: base58.encode(ed25519.sign(new TextEncoder().encode(canonicalSignedSolanaSplRouteManifestPayload(unsigned)), privateKey)) };
}

async function signedReadPolicy(): Promise<SignedSolanaReadPolicy> {
  const unsigned: Omit<SignedSolanaReadPolicy, "signature"> = {
    schema: "realdex.signed-solana-read-policy.v1", sourceId: readPolicySource.id, sourceFingerprint: await solanaReadPolicySourceFingerprint(readPolicySource), revision: 1,
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), chainId,
    rpcEndpoints: ["https://rpc-a.example.org", "https://rpc-b.example.net"], quoteBoundaryId: SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID,
    simulationBoundaryId: SOLANA_SWAP_BOUNDARY_ID, evidenceUrls: ["https://policy.example.org/solana/rpc-policy"]
  };
  return { ...unsigned, signature: base58.encode(ed25519.sign(new TextEncoder().encode(canonicalSignedSolanaReadPolicyPayload(unsigned)), readPolicyPrivateKey)) };
}

function rpcFetch(intent: SolanaSwapIntent): typeof fetch {
  const transaction = getTransactionDecoder().decode(base64.decode(intent.transactionBase64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const sourceIndex = compiled.staticAccounts.indexOf(sourceAccount as never), destinationIndex = compiled.staticAccounts.indexOf(destinationAccount as never);
  const pointer = new Uint8Array(36); new DataView(pointer.buffer).setUint32(0, 2, true); pointer.set(base58.decode(programData), 4);
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
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
    schema: "realdex.solana-swap-intent.v1", venueId: route.venueId, venueRevision: route.revision, chainId,
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
function swapStateBytes(): Uint8Array {
  const bytes = new Uint8Array(324); bytes[0] = 1; bytes[1] = 1; bytes[2] = 255;
  setAddress(bytes, 3, tokenProgram); setAddress(bytes, 35, poolSource); setAddress(bytes, 67, poolDestination); setAddress(bytes, 99, poolMint);
  setAddress(bytes, 131, sourceMint); setAddress(bytes, 163, destinationMint); setAddress(bytes, 195, poolFee); return bytes;
}
function tokenAccountBytes(mint: string, amount: bigint): Uint8Array { const bytes = new Uint8Array(165); setAddress(bytes, 0, mint); setAddress(bytes, 32, swapAuthority); new DataView(bytes.buffer).setBigUint64(64, amount, true); bytes[108] = 1; return bytes; }
function setAddress(bytes: Uint8Array, offset: number, value: string): void { bytes.set(base58.decode(value), offset); }
function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
