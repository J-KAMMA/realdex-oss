import { base58, base64 } from "@scure/base";
import { AccountRole, decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_QUOTE_TTL_MS = 5 * 60_000;
const MAX_TRANSACTION_BYTES = 1_232;
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_FEE_LAMPORTS = 10_000_000;
export const SOLANA_SWAP_BOUNDARY_ID = "solana-swap-boundary";

export type SolanaVenueDescriptor = {
  schema: "realdex.solana-venue.v1";
  venueId: string;
  revision: number;
  chainId: string;
  programAddress: string;
  programOwner: string;
  programDataAddress: string;
  programDataSha256: string;
  tokenProgramAddress: string;
  executionTarget: string;
  evidenceUrls: string[];
};

export type SolanaSwapIntent = {
  schema: "realdex.solana-swap-intent.v1";
  venueId: string;
  venueRevision: number;
  chainId: string;
  authority: string;
  sourceMint: string;
  destinationMint: string;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  destinationTokenOwner: string;
  tokenProgramAddress: string;
  executionTarget: string;
  amountInBaseUnits: string;
  expectedOutBaseUnits: string;
  minimumOutBaseUnits: string;
  slippageBps: number;
  quoteExpiresAt: number;
  lastValidBlockHeight: number;
  transactionBase64: string;
};

export type DecodedSolanaSwapInstruction = {
  authority: string;
  sourceMint: string;
  destinationMint: string;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  tokenProgramAddress: string;
  executionTarget: string;
  amountInBaseUnits: string;
  minimumOutBaseUnits: string;
};

export type SolanaSwapInstructionDecoder = (input: { data: Uint8Array; accounts: Array<{ address: string; role: number }> }) => DecodedSolanaSwapInstruction;

export type SolanaSwapSimulation = {
  slot: number;
  error: unknown | null;
  unitsConsumed: number;
  feeLamports: number;
  source: { mint: string; owner: string; preAmount: string; postAmount: string };
  destination: { mint: string; owner: string; preAmount: string; postAmount: string };
};

export type SolanaSwapReader = {
  readonly id: string;
  genesisHash(): Promise<string>;
  blockHeight(): Promise<number>;
  blockhashValid(blockhash: string): Promise<boolean>;
  account(address: string): Promise<{ owner: string; executable: boolean; dataBase64: string } | null>;
  simulate(transactionBase64: string, sourceAccountIndex: number, destinationAccountIndex: number): Promise<SolanaSwapSimulation>;
};

export type VerifiedSolanaSwap = {
  schema: "realdex.verified-solana-swap.v1";
  venueId: string;
  chainId: string;
  transactionSha256: string;
  intentSha256: string;
  sourceDebitBaseUnits: string;
  destinationCreditBaseUnits: string;
  feeLamports: number;
  unitsConsumed: number;
  observations: Array<{ readerId: string; slot: number; blockHeight: number }>;
  execution: "design-gate";
};

export function validateSolanaSwapIntent(value: unknown): SolanaSwapIntent {
  const keys = ["schema", "venueId", "venueRevision", "chainId", "authority", "sourceMint", "destinationMint", "sourceTokenAccount", "destinationTokenAccount", "destinationTokenOwner", "tokenProgramAddress", "executionTarget", "amountInBaseUnits", "expectedOutBaseUnits", "minimumOutBaseUnits", "slippageBps", "quoteExpiresAt", "lastValidBlockHeight", "transactionBase64"] as const;
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.solana-swap-intent.v1" || !bounded(value.venueId, 100) || !Number.isSafeInteger(value.venueRevision) || Number(value.venueRevision) <= 0 || typeof value.chainId !== "string" || !/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(value.chainId)) throw new Error("SOLANA_SWAP_INTENT_INVALID");
  for (const address of [value.authority, value.sourceMint, value.destinationMint, value.sourceTokenAccount, value.destinationTokenAccount, value.destinationTokenOwner, value.tokenProgramAddress, value.executionTarget]) if (!isSolanaAddress(address)) throw new Error("SOLANA_SWAP_INTENT_INVALID");
  for (const valueAmount of [value.amountInBaseUnits, value.expectedOutBaseUnits, value.minimumOutBaseUnits]) amount(valueAmount);
  if (!Number.isInteger(value.slippageBps) || Number(value.slippageBps) < 0 || Number(value.slippageBps) > 500 || !Number.isSafeInteger(value.quoteExpiresAt) || !Number.isSafeInteger(value.lastValidBlockHeight) || Number(value.lastValidBlockHeight) <= 0 || !bounded(value.transactionBase64, 2_000)) throw new Error("SOLANA_SWAP_INTENT_INVALID");
  return { ...value } as SolanaSwapIntent;
}

export function validateSolanaVenueDescriptor(value: unknown): SolanaVenueDescriptor {
  const keys = ["schema", "venueId", "revision", "chainId", "programAddress", "programOwner", "programDataAddress", "programDataSha256", "tokenProgramAddress", "executionTarget", "evidenceUrls"] as const;
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.solana-venue.v1" || !bounded(value.venueId, 100) || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0 || typeof value.chainId !== "string" || !/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(value.chainId)) throw new Error("SOLANA_SWAP_VENUE_INVALID");
  const addresses = [value.programAddress, value.programOwner, value.programDataAddress, value.tokenProgramAddress, value.executionTarget];
  if (addresses.some((address) => !isSolanaAddress(address)) || typeof value.programDataSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.programDataSha256)) throw new Error("SOLANA_SWAP_VENUE_INVALID");
  if (!Array.isArray(value.evidenceUrls) || value.evidenceUrls.length < 2 || value.evidenceUrls.length > 8 || value.evidenceUrls.some((url) => typeof url !== "string" || !isHttps(url)) || new Set(value.evidenceUrls).size !== value.evidenceUrls.length) throw new Error("SOLANA_SWAP_VENUE_INVALID");
  return {
    schema: value.schema,
    venueId: value.venueId,
    revision: Number(value.revision),
    chainId: value.chainId,
    programAddress: value.programAddress as string,
    programOwner: value.programOwner as string,
    programDataAddress: value.programDataAddress as string,
    programDataSha256: value.programDataSha256.toLowerCase(),
    tokenProgramAddress: value.tokenProgramAddress as string,
    executionTarget: value.executionTarget as string,
    evidenceUrls: [...value.evidenceUrls] as string[]
  };
}

export async function verifySolanaSwapBoundary(input: {
  venue: SolanaVenueDescriptor;
  intent: SolanaSwapIntent;
  readers: readonly SolanaSwapReader[];
  decodeSwapInstruction: SolanaSwapInstructionDecoder;
  now?: number;
}): Promise<VerifiedSolanaSwap> {
  const now = input.now ?? Date.now();
  assertVenue(input.venue);
  assertIntent(input.intent, input.venue, now);
  assertReaderQuorum(input.readers);
  const decodedTransaction = decodeAndBindTransaction(input.intent, input.venue, input.decodeSwapInstruction);

  const observations = await Promise.all(input.readers.map(async (reader) => {
    const [genesisHash, blockHeight, blockhashValid, program, programData, simulation] = await Promise.all([
      reader.genesisHash(), reader.blockHeight(), reader.blockhashValid(decodedTransaction.blockhash), reader.account(input.venue.programAddress),
      reader.account(input.venue.programDataAddress), reader.simulate(input.intent.transactionBase64, decodedTransaction.sourceAccountIndex, decodedTransaction.destinationAccountIndex)
    ]);
    if (!isSolanaAddress(genesisHash) || genesisHash.slice(0, 32) !== chainReference(input.venue.chainId)) throw new Error("SOLANA_SWAP_CHAIN_MISMATCH");
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0 || blockHeight > input.intent.lastValidBlockHeight || input.intent.lastValidBlockHeight - blockHeight > 300 || blockhashValid !== true) throw new Error("SOLANA_SWAP_BLOCKHASH_EXPIRED");
    await assertProgramIdentity(input.venue, program, programData);
    const normalized = assertSimulation(input.intent, simulation);
    return { readerId: reader.id, slot: simulation.slot, blockHeight, ...normalized };
  }));

  const consensus = observations.map(({ sourceDebitBaseUnits, destinationCreditBaseUnits, feeLamports, unitsConsumed }) => JSON.stringify({ sourceDebitBaseUnits, destinationCreditBaseUnits, feeLamports, unitsConsumed }));
  if (new Set(consensus).size !== 1) throw new Error("SOLANA_SWAP_SIMULATION_QUORUM_MISMATCH");
  const first = observations[0];
  return {
    schema: "realdex.verified-solana-swap.v1", venueId: input.venue.venueId, chainId: input.venue.chainId,
    transactionSha256: await solanaSwapTransactionSha256(input.intent), intentSha256: await solanaSwapIntentSha256(input.intent),
    sourceDebitBaseUnits: first.sourceDebitBaseUnits, destinationCreditBaseUnits: first.destinationCreditBaseUnits,
    feeLamports: first.feeLamports, unitsConsumed: first.unitsConsumed,
    observations: observations.map(({ readerId, slot, blockHeight }) => ({ readerId, slot, blockHeight })), execution: "design-gate"
  };
}

export async function solanaSwapTransactionSha256(value: unknown): Promise<string> {
  const intent = validateSolanaSwapIntent(value);
  let bytes: Uint8Array;
  try { bytes = base64.decode(intent.transactionBase64); } catch { throw new Error("SOLANA_SWAP_TRANSACTION_ENCODING_INVALID"); }
  if (!bytes.length || bytes.length > MAX_TRANSACTION_BYTES) throw new Error("SOLANA_SWAP_TRANSACTION_SIZE_INVALID");
  return sha256Hex(bytes);
}

export async function solanaSwapIntentSha256(value: unknown): Promise<string> {
  const intent = validateSolanaSwapIntent(value);
  return sha256Hex(new TextEncoder().encode(canonicalIntent(intent)));
}

export function createSolanaSwapReader(endpointValue: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): SolanaSwapReader {
  const endpoint = normalizeEndpoint(endpointValue);
  const request = createRequester(endpoint, fetchImpl, timeoutMs);
  const id = new URL(endpoint).hostname.toLowerCase();
  return {
    id,
    genesisHash: async () => requiredString(await request("getGenesisHash", [])),
    blockHeight: async () => requiredInteger(await request("getBlockHeight", [{ commitment: "confirmed" }])),
    blockhashValid: async (blockhashValue) => {
      const result = await request("isBlockhashValid", [blockhashValue, { commitment: "confirmed" }]);
      if (!isRecord(result) || typeof result.value !== "boolean") throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID");
      return result.value;
    },
    account: async (address) => {
      assertAddress(address);
      const result = await request("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]) as { value?: unknown };
      if (!isRecord(result) || result.value === null) return null;
      if (!isRecord(result.value) || typeof result.value.owner !== "string" || typeof result.value.executable !== "boolean" || !Array.isArray(result.value.data) || typeof result.value.data[0] !== "string" || result.value.data[1] !== "base64") throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID");
      return { owner: result.value.owner, executable: result.value.executable, dataBase64: result.value.data[0] };
    },
    simulate: async (transactionBase64, sourceAccountIndex, destinationAccountIndex) => {
      const result = await request("simulateTransaction", [transactionBase64, { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false, innerInstructions: true }]);
      if (!isRecord(result) || !isRecord(result.context) || !isRecord(result.value)) throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID");
      const value = result.value;
      return {
        slot: requiredInteger(result.context.slot), error: value.err ?? null,
        unitsConsumed: requiredInteger(value.unitsConsumed), feeLamports: requiredInteger(value.fee),
        source: tokenBalancePair(value, sourceAccountIndex), destination: tokenBalancePair(value, destinationAccountIndex)
      };
    }
  };
}

export function createSolanaSwapReaderQuorum(endpoints: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): SolanaSwapReader[] {
  if (endpoints.length !== 2 || endpoints.some((value) => !value.trim())) throw new Error("SOLANA_SWAP_READER_QUORUM_REQUIRED");
  const normalized = endpoints.map(normalizeEndpoint), hosts = normalized.map((value) => new URL(value).hostname.toLowerCase());
  if (new Set(normalized).size !== 2 || new Set(hosts).size !== 2) throw new Error("SOLANA_SWAP_READER_QUORUM_NOT_INDEPENDENT");
  return normalized.map((value) => createSolanaSwapReader(value, fetchImpl, timeoutMs));
}

function decodeAndBindTransaction(intent: SolanaSwapIntent, venue: SolanaVenueDescriptor, decoder: SolanaSwapInstructionDecoder): { sourceAccountIndex: number; destinationAccountIndex: number; blockhash: string } {
  let bytes: Uint8Array;
  try { bytes = base64.decode(intent.transactionBase64); } catch { throw new Error("SOLANA_SWAP_TRANSACTION_ENCODING_INVALID"); }
  if (!bytes.length || bytes.length > MAX_TRANSACTION_BYTES) throw new Error("SOLANA_SWAP_TRANSACTION_SIZE_INVALID");
  let transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try { transaction = getTransactionDecoder().decode(bytes); } catch { throw new Error("SOLANA_SWAP_TRANSACTION_INVALID"); }
  if (Object.values(transaction.signatures).some((signature) => signature !== null)) throw new Error("SOLANA_SWAP_PRE_SIGNED_TRANSACTION_BLOCKED");
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.version !== 0 || (compiled.addressTableLookups?.length ?? 0) !== 0 || compiled.header.numSignerAccounts !== 1) throw new Error("SOLANA_SWAP_TRANSACTION_SHAPE_UNSUPPORTED");
  const message = decompileTransactionMessage(compiled, { lastValidBlockHeight: BigInt(intent.lastValidBlockHeight) });
  if (!("blockhash" in message.lifetimeConstraint) || message.feePayer.address !== intent.authority || message.lifetimeConstraint.lastValidBlockHeight !== BigInt(intent.lastValidBlockHeight) || message.instructions.length !== 1) throw new Error("SOLANA_SWAP_TRANSACTION_BINDING_INVALID");
  const instruction = message.instructions[0];
  if (instruction.programAddress !== venue.programAddress || !instruction.data || !instruction.accounts) throw new Error("SOLANA_SWAP_INSTRUCTION_INVALID");
  const accounts = instruction.accounts.map((account) => ({ address: account.address, role: account.role }));
  assertCriticalAccountRoles(accounts, intent);
  let decoded: DecodedSolanaSwapInstruction;
  try { decoded = decoder({ data: Uint8Array.from(instruction.data), accounts }); } catch { throw new Error("SOLANA_SWAP_INSTRUCTION_DECODE_FAILED"); }
  assertDecodedInstruction(decoded, intent);
  const sourceAccountIndex = compiled.staticAccounts.indexOf(intent.sourceTokenAccount as never), destinationAccountIndex = compiled.staticAccounts.indexOf(intent.destinationTokenAccount as never);
  if (sourceAccountIndex < 0 || destinationAccountIndex < 0 || sourceAccountIndex === destinationAccountIndex) throw new Error("SOLANA_SWAP_TOKEN_ACCOUNT_INDEX_INVALID");
  return { sourceAccountIndex, destinationAccountIndex, blockhash: message.lifetimeConstraint.blockhash };
}

async function assertProgramIdentity(venue: SolanaVenueDescriptor, program: Awaited<ReturnType<SolanaSwapReader["account"]>>, programData: Awaited<ReturnType<SolanaSwapReader["account"]>>): Promise<void> {
  if (!program || !program.executable || program.owner !== venue.programOwner || !programData || programData.executable || programData.owner !== venue.programOwner) throw new Error("SOLANA_SWAP_PROGRAM_IDENTITY_MISMATCH");
  let programBytes: Uint8Array, dataBytes: Uint8Array;
  try { programBytes = base64.decode(program.dataBase64); dataBytes = base64.decode(programData.dataBase64); } catch { throw new Error("SOLANA_SWAP_PROGRAM_IDENTITY_MISMATCH"); }
  if (programBytes.length !== 36 || new DataView(programBytes.buffer, programBytes.byteOffset, 4).getUint32(0, true) !== 2 || base58.encode(programBytes.slice(4)) !== venue.programDataAddress || await sha256Hex(dataBytes) !== venue.programDataSha256.toLowerCase()) throw new Error("SOLANA_SWAP_PROGRAM_IDENTITY_MISMATCH");
}

function assertSimulation(intent: SolanaSwapIntent, simulation: SolanaSwapSimulation) {
  if (!Number.isSafeInteger(simulation.slot) || simulation.slot < 0 || simulation.error !== null || !Number.isSafeInteger(simulation.unitsConsumed) || simulation.unitsConsumed <= 0 || simulation.unitsConsumed > MAX_COMPUTE_UNITS || !Number.isSafeInteger(simulation.feeLamports) || simulation.feeLamports < 0 || simulation.feeLamports > MAX_FEE_LAMPORTS) throw new Error("SOLANA_SWAP_SIMULATION_FAILED");
  if (simulation.source.mint !== intent.sourceMint || simulation.source.owner !== intent.authority || simulation.destination.mint !== intent.destinationMint || simulation.destination.owner !== intent.destinationTokenOwner) throw new Error("SOLANA_SWAP_SIMULATION_ACCOUNT_MISMATCH");
  const sourceDebit = amount(simulation.source.preAmount) - amount(simulation.source.postAmount), destinationCredit = amount(simulation.destination.postAmount) - amount(simulation.destination.preAmount);
  if (sourceDebit !== amount(intent.amountInBaseUnits) || destinationCredit !== amount(intent.expectedOutBaseUnits) || destinationCredit < amount(intent.minimumOutBaseUnits)) throw new Error("SOLANA_SWAP_SIMULATION_AMOUNT_MISMATCH");
  return { sourceDebitBaseUnits: sourceDebit.toString(), destinationCreditBaseUnits: destinationCredit.toString(), feeLamports: simulation.feeLamports, unitsConsumed: simulation.unitsConsumed };
}

function assertVenue(value: SolanaVenueDescriptor): void {
  validateSolanaVenueDescriptor(value);
}

function assertIntent(value: SolanaSwapIntent, venue: SolanaVenueDescriptor, now: number): void {
  validateSolanaSwapIntent(value);
  if (value.schema !== "realdex.solana-swap-intent.v1" || value.venueId !== venue.venueId || value.venueRevision !== venue.revision || value.chainId !== venue.chainId || value.tokenProgramAddress !== venue.tokenProgramAddress || value.executionTarget !== venue.executionTarget) throw new Error("SOLANA_SWAP_INTENT_IDENTITY_INVALID");
  [value.authority, value.sourceMint, value.destinationMint, value.sourceTokenAccount, value.destinationTokenAccount, value.destinationTokenOwner, value.tokenProgramAddress, value.executionTarget].forEach(assertAddress);
  const expectedOut = amount(value.expectedOutBaseUnits), minimumOut = amount(value.minimumOutBaseUnits);
  const exactMinimum = expectedOut * BigInt(10_000 - value.slippageBps) / 10_000n;
  if (new Set([value.authority, value.sourceMint, value.destinationMint, value.sourceTokenAccount, value.destinationTokenAccount, value.tokenProgramAddress]).size !== 6 || amount(value.amountInBaseUnits) <= 0n || minimumOut <= 0n || expectedOut < minimumOut || minimumOut !== exactMinimum) throw new Error("SOLANA_SWAP_INTENT_AMOUNT_INVALID");
  if (!Number.isSafeInteger(value.quoteExpiresAt) || value.quoteExpiresAt <= now || value.quoteExpiresAt > now + MAX_QUOTE_TTL_MS || !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight <= 0 || !bounded(value.transactionBase64, 2_000)) throw new Error("SOLANA_SWAP_INTENT_EXPIRY_INVALID");
}

function assertDecodedInstruction(decoded: DecodedSolanaSwapInstruction, intent: SolanaSwapIntent): void {
  const keys: Array<keyof DecodedSolanaSwapInstruction> = ["authority", "sourceMint", "destinationMint", "sourceTokenAccount", "destinationTokenAccount", "tokenProgramAddress", "executionTarget", "amountInBaseUnits", "minimumOutBaseUnits"];
  if (!isRecord(decoded) || Object.keys(decoded).length !== keys.length || keys.some((key) => decoded[key] !== intent[key])) throw new Error("SOLANA_SWAP_INSTRUCTION_BINDING_INVALID");
}

function assertCriticalAccountRoles(accounts: Array<{ address: string; role: number }>, intent: SolanaSwapIntent): void {
  const exactRole = (addressValue: string, roles: readonly number[]) => accounts.filter((account) => account.address === addressValue).length === 1 && roles.includes(accounts.find((account) => account.address === addressValue)!.role);
  const repeatedReadonlyRole = (addressValue: string) => { const matches = accounts.filter((account) => account.address === addressValue); return matches.length >= 1 && matches.length <= 3 && matches.every((account) => account.role === AccountRole.READONLY); };
  if (!exactRole(intent.authority, [AccountRole.READONLY_SIGNER, AccountRole.WRITABLE_SIGNER]) || !exactRole(intent.sourceMint, [AccountRole.READONLY]) || !exactRole(intent.destinationMint, [AccountRole.READONLY]) || !exactRole(intent.sourceTokenAccount, [AccountRole.WRITABLE]) || !exactRole(intent.destinationTokenAccount, [AccountRole.WRITABLE]) || !repeatedReadonlyRole(intent.tokenProgramAddress)) throw new Error("SOLANA_SWAP_ACCOUNT_ROLE_INVALID");
}

function assertReaderQuorum(readers: readonly SolanaSwapReader[]): void {
  if (readers.length !== 2 || readers.some((reader) => !bounded(reader.id, 255)) || new Set(readers.map((reader) => reader.id.toLowerCase())).size !== 2) throw new Error("SOLANA_SWAP_READER_QUORUM_REQUIRED");
}

function tokenBalancePair(value: Record<string, unknown>, accountIndex: number) {
  const pre = tokenBalance(value.preTokenBalances, accountIndex), post = tokenBalance(value.postTokenBalances, accountIndex);
  if (pre.mint !== post.mint || pre.owner !== post.owner) throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID");
  return { mint: pre.mint, owner: pre.owner, preAmount: pre.amount, postAmount: post.amount };
}

function tokenBalance(value: unknown, accountIndex: number): { mint: string; owner: string; amount: string } {
  if (!Array.isArray(value)) throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID");
  const matches = value.filter((item) => isRecord(item) && item.accountIndex === accountIndex);
  if (matches.length !== 1 || !isRecord(matches[0].uiTokenAmount)) throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID");
  return { mint: requiredString(matches[0].mint), owner: requiredString(matches[0].owner), amount: requiredAmount(matches[0].uiTokenAmount.amount) };
}

function canonicalIntent(value: SolanaSwapIntent): string { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key as keyof SolanaSwapIntent]]))); }
function chainReference(chainId: string): string { return chainId.slice(chainId.indexOf(":") + 1); }
function normalizeEndpoint(value: string): string { try { return normalizePublicRpcEndpoint(value); } catch { throw new Error("SOLANA_SWAP_ENDPOINT_NOT_PUBLIC"); } }
function assertAddress(value: string): void { if (!isSolanaAddress(value)) throw new Error("SOLANA_SWAP_ADDRESS_INVALID"); }
function isSolanaAddress(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 32; } catch { return false; } }
function amount(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error("SOLANA_SWAP_AMOUNT_INVALID");
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error("SOLANA_SWAP_AMOUNT_INVALID");
  return parsed;
}
function requiredAmount(value: unknown): string { amount(value); return value as string; }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID"); return value; }
function requiredInteger(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID"); return Number(value); }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function isHttps(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }

async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }

function createRequester(endpoint: string, fetchImpl: typeof fetch, timeoutMs: number) {
  let id = 0;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs), requestId = ++id;
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("SOLANA_SWAP_RPC_FAILED");
      const payload = JSON.parse(await readBounded(response)) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (payload.jsonrpc !== "2.0" || payload.id !== requestId || payload.error !== undefined || !("result" in payload)) throw new Error("SOLANA_SWAP_RPC_RESPONSE_INVALID");
      return payload.result;
    } finally { clearTimeout(timeout); }
  };
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length")); if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("SOLANA_SWAP_RPC_RESPONSE_TOO_LARGE");
  if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("SOLANA_SWAP_RPC_RESPONSE_TOO_LARGE"); return text; }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = "";
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("SOLANA_SWAP_RPC_RESPONSE_TOO_LARGE"); } text += decoder.decode(value, { stream: true }); }
  return text + decoder.decode();
}
