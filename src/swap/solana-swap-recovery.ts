import { base58, base64 } from "@scure/base";
import { decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import type { SolanaSwapIntent, SolanaVenueDescriptor, VerifiedSolanaSwap } from "./solana-swap-boundary";

const STORAGE_KEY = "realdex:solana-swap-recovery:v1";
const MAX_RECORDS = 16;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TRANSACTION_BYTES = 1_232;
const MAX_HEIGHT_DIVERGENCE = 300;
const STAGES = ["submitted", "processed", "confirmed", "finalized", "failed", "expired-unresolved"] as const;
export const SOLANA_SWAP_RECOVERY_ID = "solana-swap-recovery-v1";

export type SolanaSwapRecoveryStage = typeof STAGES[number];
export type SolanaSwapRecoveryObservation = {
  readerId: string;
  blockHeight: number;
  contextSlot: number;
  transactionSlot: number | null;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  confirmations: number | null;
  failed: boolean | null;
};

export type SolanaSwapRecoveryRecord = {
  schema: "realdex.solana-swap-recovery.v1";
  revision: 1;
  recoveryId: string;
  venueId: string;
  venueRevision: number;
  chainId: string;
  executionTarget: string;
  authority: string;
  sourceMint: string;
  destinationMint: string;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  destinationTokenOwner: string;
  amountInBaseUnits: string;
  expectedOutBaseUnits: string;
  minimumOutBaseUnits: string;
  transactionSignature: string;
  signedTransactionSha256: string;
  unsignedTransactionSha256: string;
  messageSha256: string;
  intentSha256: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  stage: SolanaSwapRecoveryStage;
  resendBlocked: true;
  observations: SolanaSwapRecoveryObservation[];
  refreshCount: number;
  createdAt: number;
  updatedAt: number;
};

export type SolanaSwapRecoveryStatus = {
  contextSlot: number;
  slot: number;
  confirmations: number | null;
  confirmationStatus: "processed" | "confirmed" | "finalized";
  failed: boolean;
};

export type SolanaSwapRecoveryReader = {
  readonly id: string;
  genesisHash(): Promise<string>;
  blockHeight(): Promise<number>;
  signatureStatus(signature: string): Promise<SolanaSwapRecoveryStatus | null>;
};

export type VerifiedSignedSolanaSwapTransaction = Readonly<{
  schema: "realdex.verified-signed-solana-swap-transaction.v1";
  chainId: string;
  authority: string;
  transactionSignature: string;
  signedTransactionSha256: string;
  unsignedTransactionSha256: string;
  messageSha256: string;
  intentSha256: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export async function createSolanaSwapRecoveryRecord(input: {
  venue: SolanaVenueDescriptor;
  intent: SolanaSwapIntent;
  verified: VerifiedSolanaSwap;
  signedTransactionBase64: string;
  transactionSignature: string;
  now?: number;
}): Promise<SolanaSwapRecoveryRecord> {
  const now = input.now ?? Date.now();
  assertStaticBinding(input.venue, input.intent, input.verified);
  if (!validTime(now)) throw new Error("SOLANA_SWAP_RECOVERY_INPUT_INVALID");
  const signed = await verifySignedSolanaSwapTransaction(input);
  const recoveryId = await sha256Hex(new TextEncoder().encode(`${input.intent.chainId}|${input.venue.venueId}|${signed.intentSha256}|${signed.transactionSignature}`));
  const record: SolanaSwapRecoveryRecord = {
    schema: "realdex.solana-swap-recovery.v1", revision: 1, recoveryId,
    venueId: input.venue.venueId, venueRevision: input.venue.revision, chainId: input.intent.chainId,
    executionTarget: input.intent.executionTarget, authority: input.intent.authority,
    sourceMint: input.intent.sourceMint, destinationMint: input.intent.destinationMint,
    sourceTokenAccount: input.intent.sourceTokenAccount, destinationTokenAccount: input.intent.destinationTokenAccount,
    destinationTokenOwner: input.intent.destinationTokenOwner, amountInBaseUnits: input.intent.amountInBaseUnits,
    expectedOutBaseUnits: input.intent.expectedOutBaseUnits, minimumOutBaseUnits: input.intent.minimumOutBaseUnits,
    transactionSignature: signed.transactionSignature, signedTransactionSha256: signed.signedTransactionSha256,
    unsignedTransactionSha256: signed.unsignedTransactionSha256, messageSha256: signed.messageSha256,
    intentSha256: signed.intentSha256, recentBlockhash: signed.recentBlockhash,
    lastValidBlockHeight: signed.lastValidBlockHeight, stage: "submitted", resendBlocked: true,
    observations: [], refreshCount: 0, createdAt: now, updatedAt: now
  };
  assertRecord(record);
  return record;
}

/** Verifies wallet-returned bytes without storing, submitting, or broadcasting them. */
export async function verifySignedSolanaSwapTransaction(input: {
  intent: SolanaSwapIntent;
  verified: VerifiedSolanaSwap;
  signedTransactionBase64: string;
  transactionSignature: string;
}): Promise<VerifiedSignedSolanaSwapTransaction> {
  assertIntentBinding(input.intent, input.verified);
  if (!isSignature(input.transactionSignature)) throw new Error("SOLANA_SWAP_RECOVERY_INPUT_INVALID");
  let unsignedBytes: Uint8Array, signedBytes: Uint8Array;
  try { unsignedBytes = base64.decode(input.intent.transactionBase64); signedBytes = base64.decode(input.signedTransactionBase64); }
  catch { throw new Error("SOLANA_SWAP_RECOVERY_TRANSACTION_INVALID"); }
  if (!unsignedBytes.length || !signedBytes.length || unsignedBytes.length > MAX_TRANSACTION_BYTES || signedBytes.length > MAX_TRANSACTION_BYTES) throw new Error("SOLANA_SWAP_RECOVERY_TRANSACTION_INVALID");
  let unsigned, signed;
  try { unsigned = getTransactionDecoder().decode(unsignedBytes); signed = getTransactionDecoder().decode(signedBytes); }
  catch { throw new Error("SOLANA_SWAP_RECOVERY_TRANSACTION_INVALID"); }
  if (Object.values(unsigned.signatures).some((signature) => signature !== null)) throw new Error("SOLANA_SWAP_RECOVERY_UNSIGNED_TRANSACTION_INVALID");
  const signatures = Object.values(signed.signatures);
  if (signatures.length !== 1 || signatures[0] === null || !sameBytes(unsigned.messageBytes, signed.messageBytes)) throw new Error("SOLANA_SWAP_RECOVERY_TRANSACTION_INVALID");
  const signatureBytes = Uint8Array.from(signatures[0]);
  if (signatureBytes.length !== 64 || base58.encode(signatureBytes) !== input.transactionSignature) throw new Error("SOLANA_SWAP_RECOVERY_SIGNATURE_MISMATCH");
  await verifyEd25519(input.intent.authority, signatureBytes, Uint8Array.from(signed.messageBytes));
  const unsignedTransactionSha256 = await sha256Hex(unsignedBytes);
  const intentSha256 = await sha256Hex(new TextEncoder().encode(canonicalIntent(input.intent)));
  if (unsignedTransactionSha256 !== input.verified.transactionSha256 || intentSha256 !== input.verified.intentSha256) throw new Error("SOLANA_SWAP_RECOVERY_VERIFIED_EVIDENCE_MISMATCH");
  const compiled = getCompiledTransactionMessageDecoder().decode(signed.messageBytes);
  const message = decompileTransactionMessage(compiled, { lastValidBlockHeight: BigInt(input.intent.lastValidBlockHeight) });
  if (!("blockhash" in message.lifetimeConstraint) || message.lifetimeConstraint.lastValidBlockHeight !== BigInt(input.intent.lastValidBlockHeight)) throw new Error("SOLANA_SWAP_RECOVERY_LIFETIME_INVALID");
  return Object.freeze({
    schema: "realdex.verified-signed-solana-swap-transaction.v1",
    chainId: input.intent.chainId, authority: input.intent.authority,
    transactionSignature: input.transactionSignature,
    signedTransactionSha256: await sha256Hex(signedBytes), unsignedTransactionSha256,
    messageSha256: await sha256Hex(Uint8Array.from(signed.messageBytes)), intentSha256,
    recentBlockhash: message.lifetimeConstraint.blockhash,
    lastValidBlockHeight: input.intent.lastValidBlockHeight
  });
}

export async function refreshSolanaSwapRecovery(recordValue: SolanaSwapRecoveryRecord, readers: readonly SolanaSwapRecoveryReader[], now = Date.now()): Promise<SolanaSwapRecoveryRecord> {
  const record = assertRecord(recordValue);
  assertReaderQuorum(readers);
  if (!validTime(now) || now < record.updatedAt) throw new Error("SOLANA_SWAP_RECOVERY_TIME_INVALID");
  const results = await Promise.all(readers.map(async (reader) => {
    const [genesisHash, blockHeight, status] = await Promise.all([reader.genesisHash(), reader.blockHeight(), reader.signatureStatus(record.transactionSignature)]);
    if (!isAddress(genesisHash) || genesisHash.slice(0, 32) !== chainReference(record.chainId)) throw new Error("SOLANA_SWAP_RECOVERY_CHAIN_MISMATCH");
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) throw new Error("SOLANA_SWAP_RECOVERY_HEIGHT_INVALID");
    assertStatus(status);
    return { readerId: reader.id, blockHeight, status };
  }));
  const heights = results.map((result) => result.blockHeight);
  if (Math.max(...heights) - Math.min(...heights) > MAX_HEIGHT_DIVERGENCE) throw new Error("SOLANA_SWAP_RECOVERY_HEIGHT_QUORUM_MISMATCH");
  for (const result of results) {
    const previous = record.observations.find((observation) => observation.readerId.toLowerCase() === result.readerId.toLowerCase());
    if (previous && result.blockHeight < previous.blockHeight) throw new Error("SOLANA_SWAP_RECOVERY_EVIDENCE_REGRESSION");
  }
  const statuses = results.map((result) => result.status);
  if ((statuses[0] === null) !== (statuses[1] === null)) throw new Error("SOLANA_SWAP_RECOVERY_STATUS_QUORUM_MISMATCH");
  let stage: SolanaSwapRecoveryStage;
  if (statuses[0] === null || statuses[1] === null) {
    const expiration = heights.map((height) => height > record.lastValidBlockHeight);
    if (expiration[0] !== expiration[1]) throw new Error("SOLANA_SWAP_RECOVERY_EXPIRY_QUORUM_MISMATCH");
    stage = expiration[0] ? "expired-unresolved" : "submitted";
  } else {
    if (statuses[0].slot !== statuses[1].slot || statuses[0].failed !== statuses[1].failed) throw new Error("SOLANA_SWAP_RECOVERY_STATUS_QUORUM_MISMATCH");
    stage = statuses[0].failed ? "failed" : weakerStatus(statuses[0].confirmationStatus, statuses[1].confirmationStatus);
  }
  assertTransition(record.stage, stage);
  const observations = results.map(({ readerId, blockHeight, status }) => ({
    readerId, blockHeight, contextSlot: status?.contextSlot ?? 0, transactionSlot: status?.slot ?? null,
    confirmationStatus: status?.confirmationStatus ?? null, confirmations: status?.confirmations ?? null, failed: status?.failed ?? null
  }));
  return assertRecord({ ...record, stage, observations, refreshCount: record.refreshCount + 1, updatedAt: now });
}

export function createSolanaSwapRecoveryReader(endpointValue: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): SolanaSwapRecoveryReader {
  const endpoint = normalizeEndpoint(endpointValue), request = createRequester(endpoint, fetchImpl, timeoutMs);
  return {
    id: new URL(endpoint).hostname.toLowerCase(),
    genesisHash: async () => requiredString(await request("getGenesisHash", [])),
    blockHeight: async () => requiredInteger(await request("getBlockHeight", [{ commitment: "confirmed" }])),
    signatureStatus: async (signature) => {
      if (!isSignature(signature)) throw new Error("SOLANA_SWAP_RECOVERY_SIGNATURE_INVALID");
      const result = await request("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      if (!isRecord(result) || !isRecord(result.context) || !Array.isArray(result.value) || result.value.length !== 1) throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_INVALID");
      const contextSlot = requiredInteger(result.context.slot), value = result.value[0];
      if (value === null) return null;
      if (!isRecord(value) || !("err" in value) || !["processed", "confirmed", "finalized"].includes(String(value.confirmationStatus))) throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_INVALID");
      const slot = requiredInteger(value.slot), confirmations = value.confirmations === null ? null : requiredInteger(value.confirmations);
      if (slot > contextSlot) throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_INVALID");
      return { contextSlot, slot, confirmations, confirmationStatus: value.confirmationStatus as SolanaSwapRecoveryStatus["confirmationStatus"], failed: value.err !== null };
    }
  };
}

export function createSolanaSwapRecoveryReaderQuorum(endpoints: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): SolanaSwapRecoveryReader[] {
  if (endpoints.length !== 2 || endpoints.some((value) => typeof value !== "string" || !value.trim())) throw new Error("SOLANA_SWAP_RECOVERY_READER_QUORUM_REQUIRED");
  const normalized = endpoints.map(normalizeEndpoint), hosts = normalized.map((value) => new URL(value).hostname.toLowerCase());
  if (new Set(normalized).size !== 2 || new Set(hosts).size !== 2) throw new Error("SOLANA_SWAP_RECOVERY_READER_QUORUM_NOT_INDEPENDENT");
  return normalized.map((endpoint) => createSolanaSwapRecoveryReader(endpoint, fetchImpl, timeoutMs));
}

export function readSolanaSwapRecoveryJournal(storage: StorageLike = localStorage): SolanaSwapRecoveryRecord[] {
  const raw = storage.getItem(STORAGE_KEY); if (raw === null) return [];
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error("SOLANA_SWAP_RECOVERY_JOURNAL_INVALID"); }
  if (!isRecord(value) || !exactKeys(value, ["schema", "records"]) || value.schema !== "realdex.solana-swap-recovery-journal.v1" || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error("SOLANA_SWAP_RECOVERY_JOURNAL_INVALID");
  const records = value.records.map(assertRecord);
  if (new Set(records.map((record) => record.recoveryId)).size !== records.length) throw new Error("SOLANA_SWAP_RECOVERY_JOURNAL_INVALID");
  return records;
}

export function writeSolanaSwapRecoveryRecord(recordValue: SolanaSwapRecoveryRecord, storage: StorageLike = localStorage): void {
  const record = assertRecord(recordValue), records = readSolanaSwapRecoveryJournal(storage).filter((item) => item.recoveryId !== record.recoveryId);
  records.push(record); records.sort((a, b) => b.updatedAt - a.updatedAt);
  storage.setItem(STORAGE_KEY, JSON.stringify({ schema: "realdex.solana-swap-recovery-journal.v1", records: records.slice(0, MAX_RECORDS) }));
}

function assertStaticBinding(venue: SolanaVenueDescriptor, intent: SolanaSwapIntent, verified: VerifiedSolanaSwap): void {
  assertIntentBinding(intent, verified);
  if (venue.schema !== "realdex.solana-venue.v1" || venue.venueId !== intent.venueId || venue.venueId !== verified.venueId || venue.revision !== intent.venueRevision || venue.chainId !== intent.chainId || venue.executionTarget !== intent.executionTarget || venue.tokenProgramAddress !== intent.tokenProgramAddress) throw new Error("SOLANA_SWAP_RECOVERY_BINDING_INVALID");
}

function assertIntentBinding(intent: SolanaSwapIntent, verified: VerifiedSolanaSwap): void {
  if (intent.schema !== "realdex.solana-swap-intent.v1" || verified.schema !== "realdex.verified-solana-swap.v1" || verified.execution !== "design-gate" || verified.venueId !== intent.venueId || verified.chainId !== intent.chainId || verified.sourceDebitBaseUnits !== intent.amountInBaseUnits || verified.destinationCreditBaseUnits !== intent.expectedOutBaseUnits || !isHash(verified.transactionSha256) || !isHash(verified.intentSha256) || verified.observations.length !== 2 || new Set(verified.observations.map((item) => item.readerId.toLowerCase())).size !== 2) throw new Error("SOLANA_SWAP_RECOVERY_BINDING_INVALID");
}

function assertRecord(value: unknown): SolanaSwapRecoveryRecord {
  const keys = ["schema", "revision", "recoveryId", "venueId", "venueRevision", "chainId", "executionTarget", "authority", "sourceMint", "destinationMint", "sourceTokenAccount", "destinationTokenAccount", "destinationTokenOwner", "amountInBaseUnits", "expectedOutBaseUnits", "minimumOutBaseUnits", "transactionSignature", "signedTransactionSha256", "unsignedTransactionSha256", "messageSha256", "intentSha256", "recentBlockhash", "lastValidBlockHeight", "stage", "resendBlocked", "observations", "refreshCount", "createdAt", "updatedAt"];
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.solana-swap-recovery.v1" || value.revision !== 1 || !isHash(value.recoveryId) || !bounded(value.venueId, 100) || !Number.isInteger(value.venueRevision) || Number(value.venueRevision) <= 0 || !/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(String(value.chainId))) throw new Error("SOLANA_SWAP_RECOVERY_RECORD_INVALID");
  [value.executionTarget, value.authority, value.sourceMint, value.destinationMint, value.sourceTokenAccount, value.destinationTokenAccount, value.destinationTokenOwner, value.recentBlockhash].forEach((item) => { if (!isAddress(item)) throw new Error("SOLANA_SWAP_RECOVERY_RECORD_INVALID"); });
  if (new Set([value.executionTarget, value.authority, value.sourceMint, value.destinationMint, value.sourceTokenAccount, value.destinationTokenAccount]).size !== 6 || !positiveAmount(value.amountInBaseUnits) || !positiveAmount(value.expectedOutBaseUnits) || !positiveAmount(value.minimumOutBaseUnits) || BigInt(String(value.expectedOutBaseUnits)) < BigInt(String(value.minimumOutBaseUnits)) || !isSignature(value.transactionSignature)) throw new Error("SOLANA_SWAP_RECOVERY_RECORD_INVALID");
  if (![value.signedTransactionSha256, value.unsignedTransactionSha256, value.messageSha256, value.intentSha256].every(isHash) || !Number.isSafeInteger(value.lastValidBlockHeight) || Number(value.lastValidBlockHeight) <= 0 || !STAGES.includes(value.stage as SolanaSwapRecoveryStage) || value.resendBlocked !== true || !Array.isArray(value.observations) || ![0, 2].includes(value.observations.length) || !Number.isSafeInteger(value.refreshCount) || Number(value.refreshCount) < 0 || (Number(value.refreshCount) === 0 ? value.observations.length !== 0 : value.observations.length !== 2) || !validTime(value.createdAt) || !validTime(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)) throw new Error("SOLANA_SWAP_RECOVERY_RECORD_INVALID");
  value.observations.forEach(assertObservation);
  if (value.observations.length === 2 && new Set(value.observations.map((item: SolanaSwapRecoveryObservation) => item.readerId.toLowerCase())).size !== 2) throw new Error("SOLANA_SWAP_RECOVERY_RECORD_INVALID");
  return value as unknown as SolanaSwapRecoveryRecord;
}

function assertObservation(value: unknown): void {
  if (!isRecord(value) || !exactKeys(value, ["readerId", "blockHeight", "contextSlot", "transactionSlot", "confirmationStatus", "confirmations", "failed"]) || !bounded(value.readerId, 255) || !Number.isSafeInteger(value.blockHeight) || Number(value.blockHeight) < 0 || !Number.isSafeInteger(value.contextSlot) || Number(value.contextSlot) < 0 || !(value.transactionSlot === null || (Number.isSafeInteger(value.transactionSlot) && Number(value.transactionSlot) >= 0)) || !(value.confirmationStatus === null || ["processed", "confirmed", "finalized"].includes(String(value.confirmationStatus))) || !(value.confirmations === null || (Number.isSafeInteger(value.confirmations) && Number(value.confirmations) >= 0)) || !(value.failed === null || typeof value.failed === "boolean")) throw new Error("SOLANA_SWAP_RECOVERY_RECORD_INVALID");
}

function assertStatus(value: SolanaSwapRecoveryStatus | null): void {
  if (value === null) return;
  if (!Number.isSafeInteger(value.contextSlot) || value.contextSlot < 0 || !Number.isSafeInteger(value.slot) || value.slot < 0 || value.slot > value.contextSlot || !(value.confirmations === null || (Number.isSafeInteger(value.confirmations) && value.confirmations >= 0)) || !["processed", "confirmed", "finalized"].includes(value.confirmationStatus) || typeof value.failed !== "boolean") throw new Error("SOLANA_SWAP_RECOVERY_STATUS_INVALID");
}

function assertReaderQuorum(readers: readonly SolanaSwapRecoveryReader[]): void { if (readers.length !== 2 || readers.some((reader) => !bounded(reader.id, 255)) || new Set(readers.map((reader) => reader.id.toLowerCase())).size !== 2) throw new Error("SOLANA_SWAP_RECOVERY_READER_QUORUM_REQUIRED"); }
function assertTransition(previous: SolanaSwapRecoveryStage, next: SolanaSwapRecoveryStage): void {
  if (previous === next) return;
  if (previous === "finalized" || previous === "failed") throw new Error("SOLANA_SWAP_RECOVERY_STAGE_REGRESSION");
  if (previous === "expired-unresolved" && next === "submitted") throw new Error("SOLANA_SWAP_RECOVERY_STAGE_REGRESSION");
  if (next === "failed" && previous !== "submitted" && previous !== "expired-unresolved") throw new Error("SOLANA_SWAP_RECOVERY_STAGE_REGRESSION");
  const rank: Record<SolanaSwapRecoveryStage, number> = { submitted: 0, "expired-unresolved": 0, processed: 1, confirmed: 2, finalized: 3, failed: 3 };
  if (rank[next] < rank[previous] || (previous !== "submitted" && previous !== "expired-unresolved" && next === "expired-unresolved")) throw new Error("SOLANA_SWAP_RECOVERY_STAGE_REGRESSION");
}
function weakerStatus(a: "processed" | "confirmed" | "finalized", b: "processed" | "confirmed" | "finalized"): SolanaSwapRecoveryStage { const values = ["processed", "confirmed", "finalized"] as const; return values[Math.min(values.indexOf(a), values.indexOf(b))]; }
function canonicalIntent(value: SolanaSwapIntent): string { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key as keyof SolanaSwapIntent]]))); }
function chainReference(value: string): string { return value.slice(value.indexOf(":") + 1); }
function isAddress(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 32; } catch { return false; } }
function isSignature(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 64; } catch { return false; } }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function positiveAmount(value: unknown): boolean { return typeof value === "string" && /^[1-9]\d*$/.test(value) && value.length <= 78; }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_INVALID"); return value; }
function requiredInteger(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_INVALID"); return Number(value); }
function normalizeEndpoint(value: string): string { try { return normalizePublicRpcEndpoint(value); } catch { throw new Error("SOLANA_SWAP_RECOVERY_ENDPOINT_NOT_PUBLIC"); } }
function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean { if (a.length !== b.length) return false; for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false; return true; }
async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
async function verifyEd25519(authority: string, signature: Uint8Array, message: Uint8Array): Promise<void> { try { const publicKey = Uint8Array.from(base58.decode(authority)).buffer as ArrayBuffer, signatureBytes = Uint8Array.from(signature).buffer as ArrayBuffer, messageBytes = Uint8Array.from(message).buffer as ArrayBuffer; const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]); if (!await crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, messageBytes)) throw new Error(); } catch { throw new Error("SOLANA_SWAP_RECOVERY_SIGNATURE_INVALID"); } }

function createRequester(endpoint: string, fetchImpl: typeof fetch, timeoutMs: number) {
  let id = 0;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs), requestId = ++id;
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("SOLANA_SWAP_RECOVERY_RPC_FAILED");
      const payload = JSON.parse(await readBounded(response));
      if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.id !== requestId || payload.error !== undefined || !("result" in payload)) throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_INVALID");
      return payload.result;
    } finally { clearTimeout(timeout); }
  };
}
async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length")); if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_TOO_LARGE");
  if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_TOO_LARGE"); return text; }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = "";
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("SOLANA_SWAP_RECOVERY_RPC_RESPONSE_TOO_LARGE"); } text += decoder.decode(value, { stream: true }); }
  return text + decoder.decode();
}
