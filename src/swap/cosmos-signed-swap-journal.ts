import { fromBech32 } from "@cosmjs/encoding";
import { browserCrossTabExecutionLockManager, type CrossTabExecutionLockManager } from "../routing/cross-tab-execution-lock";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertGenuineCosmosInjectedSignedSwapEvidence, type CosmosInjectedSignedSwapEvidence } from "./cosmos-injected-signed-swap-evidence";
import { assertGenuineCosmosInjectedSigningPreparation, prepareCosmosInjectedSigning, type CosmosInjectedSigningPreparation } from "./cosmos-injected-signing-preparation";
import { validateCosmosSwapIntent } from "./cosmos-swap-boundary";
import { assertGenuineCosmosInjectedBinding } from "../wallet/cosmos-injected-session";
import { assertVerifiedSourceBoundOsmosisSwap } from "./cosmos-venue-source";

const DOMAIN = "realdex.cosmos-signed-swap-journal.v1";
const RESERVATION_DOMAIN = "realdex.cosmos-signing-reservation.v1";
const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^0x[0-9a-f]{64}$/;
const MAX_BYTES = 4096;

export type CosmosSignedSwapSlot = Readonly<{ chainId: string; authority: string; sequence: string }>;
export type CosmosSignedSwapJournalRecord = Readonly<CosmosSignedSwapSlot & {
  schema: typeof DOMAIN;
  accountNumber: string;
  evidenceId: string;
  acceptedAt: number;
  transactionHash: string;
  unsignedTransactionSha256: string;
  signDocSha256: string;
  intentSha256: string;
  stage: "signed-observed";
  submissionStatus: "unknown";
  executionEnabled: false;
  automaticResendBlocked: true;
  recordHash: string;
}>;

export type CosmosSigningReservation = Readonly<CosmosSignedSwapSlot & {
  schema: typeof RESERVATION_DOMAIN;
  accountNumber: string;
  preparationId: string;
  preparedAt: number;
  expiresAt: number;
  unsignedTransactionSha256: string;
  signDocSha256: string;
  intentSha256: string;
  stage: "signing-reserved";
  signingStatus: "unknown";
  executionEnabled: false;
  automaticResendBlocked: true;
  recordHash: string;
}>;
export type CosmosSigningRequestedRecord = Readonly<Omit<CosmosSigningReservation, "stage"> & {
  stage: "signing-requested";
  requestedAt: number;
}>;
export type CosmosSigningSlotRecord = CosmosSigningReservation | CosmosSigningRequestedRecord | CosmosSignedSwapJournalRecord;

export interface CosmosSignedSwapJournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type CosmosSigningJournalOptions = { storage?: CosmosSignedSwapJournalStorage; locks?: CrossTabExecutionLockManager };
type Options = CosmosSigningJournalOptions;

/** Wallet, session, venue and quote are deliberately NOT part of this key. */
export function cosmosSignedSwapSlotKey(value: CosmosSignedSwapSlot): string {
  const slot = snapshotSlot(value);
  return `realdex:cosmos-signed-swap:${cryptographicFingerprint(`${DOMAIN}.slot`, slot)}`;
}

/** Consumes a reservation before a provider can be invoked. This state never resets
 * on rejection, cancellation, timeout or reload. It is not evidence of a signature.
 */
export async function claimCosmosSigningReservation(preparation: CosmosInjectedSigningPreparation, options: Options = {}, now = Date.now()): Promise<CosmosSigningRequestedRecord> {
  assertGenuineCosmosInjectedSigningPreparation(preparation);
  if (!Number.isSafeInteger(now) || now < preparation.preparedAt || now >= preparation.expiresAt) throw new Error("COSMOS_SIGNING_RESERVATION_EXPIRED");
  const key = cosmosSignedSwapSlotKey(preparation);
  const storage = options.storage ?? browserStorage();
  const locks = options.locks ?? browserCrossTabExecutionLockManager();
  return withSlotLock(locks, key, () => {
    const current = readCosmosSigningSlot(preparation, storage);
    if (!current || current.stage !== "signing-reserved") throw new Error("COSMOS_SIGNING_RESERVATION_NOT_AVAILABLE");
    if (current.preparationId !== preparation.preparationId || current.preparedAt > now || current.expiresAt !== preparation.expiresAt || current.accountNumber !== preparation.accountNumber || current.unsignedTransactionSha256 !== preparation.transactionSha256 || current.signDocSha256 !== preparation.signDocSha256 || current.intentSha256 !== preparation.intentSha256) throw new Error("COSMOS_SIGNING_RESERVATION_MISMATCH");
    const { recordHash: _hash, ...previous } = current;
    const payload = { ...previous, stage: "signing-requested", requestedAt: now } as const;
    const record = Object.freeze({ ...payload, recordHash: cryptographicFingerprint(RESERVATION_DOMAIN, payload) });
    const serialized = JSON.stringify(record);
    parseSlotRecord(serialized, key);
    persistExact(storage, key, serialized);
    return record;
  });
}

/** Reserve exactly once before any future signing request. This does NOT request a
 * signature or authorize one. Expiry, reload and wallet rejection never free a slot.
 */
export async function reserveCosmosInjectedSigning(
  inputValue: Parameters<typeof prepareCosmosInjectedSigning>[0], options: Options = {}
): Promise<Readonly<{ preparation: CosmosInjectedSigningPreparation; reservation: CosmosSigningReservation }>> {
  const input = { ...inputValue, intent: validateCosmosSwapIntent(inputValue.intent) };
  const slot = snapshotSlot(input.intent);
  const key = cosmosSignedSwapSlotKey(slot);
  const storage = options.storage ?? browserStorage();
  const locks = options.locks ?? browserCrossTabExecutionLockManager();
  return withSlotLock(locks, key, async () => {
    if (readCosmosSigningSlot(slot, storage)) throw new Error("COSMOS_SIGNED_JOURNAL_SLOT_OCCUPIED");
    const preparation = await prepareCosmosInjectedSigning(input);
    if (cosmosSignedSwapSlotKey(preparation) !== key) throw new Error("COSMOS_SIGNED_JOURNAL_SLOT_INVALID");
    const payload = {
      schema: RESERVATION_DOMAIN, ...slot, accountNumber: preparation.accountNumber,
      preparationId: preparation.preparationId, preparedAt: preparation.preparedAt,
      expiresAt: preparation.expiresAt, unsignedTransactionSha256: preparation.transactionSha256,
      signDocSha256: preparation.signDocSha256, intentSha256: preparation.intentSha256,
      stage: "signing-reserved", signingStatus: "unknown",
      executionEnabled: false, automaticResendBlocked: true
    } as const;
    const reservation = Object.freeze({ ...payload, recordHash: cryptographicFingerprint(RESERVATION_DOMAIN, payload) });
    const serialized = JSON.stringify(reservation);
    parseSlotRecord(serialized, key);
    // The browser lock only coordinates cooperating writers. Detect any changed
    // history during async account checks instead of overwriting it.
    if (readCosmosSigningSlot(slot, storage)) throw new Error("COSMOS_SIGNED_JOURNAL_SLOT_OCCUPIED");
    persistExact(storage, key, serialized);
    // Failure after persistence intentionally leaves the slot blocked.
    await assertGenuineCosmosInjectedBinding(input.connection, input.binding, input.now ?? Date.now());
    assertVerifiedSourceBoundOsmosisSwap(input.verified);
    const completedAt = input.now ?? Date.now();
    if (!Number.isSafeInteger(completedAt) || completedAt < preparation.preparedAt || completedAt >= preparation.expiresAt) throw new Error("COSMOS_SIGNING_RESERVATION_EXPIRED");
    if (readCosmosSigningSlot(slot, storage)?.recordHash !== reservation.recordHash) throw new Error("COSMOS_SIGNING_RESERVATION_CHANGED");
    return Object.freeze({ preparation, reservation });
  });
}

/**
 * Records existing signature evidence, not permission to sign/send. Cooperating tabs
 * in the same storage bucket serialize the read/check/write/readback under Web Locks.
 * No delete/expiry/retry API: missing local history is not proof of non-execution.
 */
export async function persistCosmosSignedSwapEvidence(
  evidence: CosmosInjectedSignedSwapEvidence, options: Options = {}
): Promise<CosmosSignedSwapJournalRecord> {
  assertGenuineCosmosInjectedSignedSwapEvidence(evidence);
  const slot = snapshotSlot(evidence);
  const key = cosmosSignedSwapSlotKey(slot);
  const storage = options.storage ?? browserStorage();
  const locks = options.locks ?? browserCrossTabExecutionLockManager();
  const payload = {
    schema: DOMAIN, ...slot, accountNumber: evidence.accountNumber,
    evidenceId: evidence.evidenceId, acceptedAt: evidence.acceptedAt,
    transactionHash: evidence.transactionHash,
    unsignedTransactionSha256: evidence.unsignedTransactionSha256,
    signDocSha256: evidence.signDocSha256, intentSha256: evidence.intentSha256,
    stage: "signed-observed", submissionStatus: "unknown",
    executionEnabled: false, automaticResendBlocked: true
  } as const;
  const record = Object.freeze({ ...payload, recordHash: cryptographicFingerprint(DOMAIN, payload) });
  const serialized = JSON.stringify(record);
  parseSlotRecord(serialized, key);
  return withSlotLock(locks, key, () => {
    assertGenuineCosmosInjectedSignedSwapEvidence(evidence);
    const previous = readCosmosSigningSlot(slot, storage);
    if (previous && previous.stage !== "signed-observed") {
      if (previous.preparationId !== evidence.preparationId || previous.preparedAt > evidence.acceptedAt || previous.expiresAt <= evidence.acceptedAt) throw new Error("COSMOS_SIGNING_RESERVATION_MISMATCH");
      if (previous.stage === "signing-requested" && previous.requestedAt > evidence.acceptedAt) throw new Error("COSMOS_SIGNING_RESERVATION_MISMATCH");
      for (const field of ["accountNumber", "unsignedTransactionSha256", "signDocSha256", "intentSha256"] as const) {
        if (previous[field] !== record[field]) throw new Error("COSMOS_SIGNING_RESERVATION_MISMATCH");
      }
      persistExact(storage, key, serialized);
      return record;
    }
    if (previous) {
      // Accept a re-observation in another session only for the exact same signed
      // transaction AND review intent. Keep the original receipt, never overwrite.
      for (const field of ["accountNumber", "transactionHash", "unsignedTransactionSha256", "signDocSha256", "intentSha256"] as const) {
        if (previous[field] !== record[field]) throw new Error("COSMOS_SIGNED_JOURNAL_SEQUENCE_CONFLICT");
      }
      return previous;
    }
    persistExact(storage, key, serialized);
    return record;
  });
}

/** Recovery hint only. Null must NEVER authorize a signature, broadcast or retry. */
export function readCosmosSignedSwapSlot(
  slot: CosmosSignedSwapSlot, storage: CosmosSignedSwapJournalStorage = browserStorage()
): CosmosSignedSwapJournalRecord | null {
  const value = readCosmosSigningSlot(slot, storage);
  if (value && value.stage !== "signed-observed") throw new Error("COSMOS_SIGNED_JOURNAL_SLOT_RESERVED");
  return value;
}

/** Both phases are blocking hints, never restored execution capabilities. */
export function readCosmosSigningSlot(
  slot: CosmosSignedSwapSlot, storage: CosmosSignedSwapJournalStorage = browserStorage()
): CosmosSigningSlotRecord | null {
  const key = cosmosSignedSwapSlotKey(slot);
  let raw: string | null;
  try { raw = storage.getItem(key); }
  catch { throw new Error("COSMOS_SIGNED_JOURNAL_READ_UNAVAILABLE"); }
  return raw === null ? null : parseSlotRecord(raw, key);
}

function parseSlotRecord(raw: string, expectedKey: string): CosmosSigningSlotRecord {
  try {
    if (typeof raw !== "string" || raw.length > MAX_BYTES) throw new Error();
    const value = JSON.parse(raw) as CosmosSigningSlotRecord;
    if (value?.schema === RESERVATION_DOMAIN) return parseReservation(value, expectedKey);
    const fields = ["schema", "chainId", "authority", "sequence", "accountNumber", "evidenceId", "acceptedAt", "transactionHash", "unsignedTransactionSha256", "signDocSha256", "intentSha256", "stage", "submissionStatus", "executionEnabled", "automaticResendBlocked", "recordHash"];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) throw new Error();
    if (value.schema !== DOMAIN || value.stage !== "signed-observed" || value.submissionStatus !== "unknown" || value.executionEnabled !== false || value.automaticResendBlocked !== true) throw new Error();
    if (cosmosSignedSwapSlotKey(value) !== expectedKey || !uint64(value.accountNumber) || !Number.isSafeInteger(value.acceptedAt) || value.acceptedAt <= 0) throw new Error();
    if (![value.evidenceId, value.recordHash].every(v => typeof v === "string" && FINGERPRINT.test(v))) throw new Error();
    if (typeof value.transactionHash !== "string" || !/^[0-9A-F]{64}$/.test(value.transactionHash)) throw new Error();
    if (![value.unsignedTransactionSha256, value.signDocSha256, value.intentSha256].every(v => typeof v === "string" && SHA256.test(v))) throw new Error();
    const { recordHash, ...payload } = value;
    if (recordHash !== cryptographicFingerprint(DOMAIN, payload)) throw new Error();
    return Object.freeze(value);
  } catch { throw new Error("COSMOS_SIGNED_JOURNAL_RECORD_INVALID"); }
}

function parseReservation(value: CosmosSigningReservation | CosmosSigningRequestedRecord, key: string): CosmosSigningReservation | CosmosSigningRequestedRecord {
  const fields = ["schema", "chainId", "authority", "sequence", "accountNumber", "preparationId", "preparedAt", "expiresAt", "unsignedTransactionSha256", "signDocSha256", "intentSha256", "stage", "signingStatus", "executionEnabled", "automaticResendBlocked", "recordHash"];
  if (value.stage === "signing-requested") {
    fields.push("requestedAt");
    if (!Number.isSafeInteger(value.requestedAt) || value.requestedAt < value.preparedAt || value.requestedAt >= value.expiresAt) throw new Error();
  }
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) throw new Error();
  if ((value.stage !== "signing-reserved" && value.stage !== "signing-requested") || value.signingStatus !== "unknown" || value.executionEnabled !== false || value.automaticResendBlocked !== true || cosmosSignedSwapSlotKey(value) !== key || !uint64(value.accountNumber)) throw new Error();
  if (!Number.isSafeInteger(value.preparedAt) || value.preparedAt <= 0 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.preparedAt) throw new Error();
  if (![value.preparationId, value.recordHash].every(v => typeof v === "string" && FINGERPRINT.test(v)) || ![value.unsignedTransactionSha256, value.signDocSha256, value.intentSha256].every(v => typeof v === "string" && SHA256.test(v))) throw new Error();
  const { recordHash, ...payload } = value;
  if (recordHash !== cryptographicFingerprint(RESERVATION_DOMAIN, payload)) throw new Error();
  return Object.freeze(value);
}

function persistExact(storage: CosmosSignedSwapJournalStorage, key: string, serialized: string): void {
  try {
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error();
  } catch { throw new Error("COSMOS_SIGNED_JOURNAL_PERSISTENCE_UNAVAILABLE"); }
}

async function withSlotLock<T>(locks: CrossTabExecutionLockManager | undefined, key: string, action: () => T | Promise<T>): Promise<T> {
  if (!locks) throw new Error("COSMOS_SIGNED_JOURNAL_LOCK_UNAVAILABLE");
  let entered = false;
  try {
    return await locks.request(key, { mode: "exclusive", ifAvailable: true }, lock => {
      if (entered) throw new Error("COSMOS_SIGNED_JOURNAL_LOCK_INVALID");
      entered = true;
      if (!lock) throw new Error("COSMOS_SIGNED_JOURNAL_BUSY");
      return action();
    });
  } catch (error) {
    if (entered) throw error;
    throw new Error("COSMOS_SIGNED_JOURNAL_LOCK_UNAVAILABLE");
  }
}

function snapshotSlot(value: CosmosSignedSwapSlot): CosmosSignedSwapSlot {
  const { chainId, authority, sequence } = value;
  if (typeof chainId !== "string" || !/^cosmos:[a-zA-Z0-9_-]{1,32}$/.test(chainId) || typeof authority !== "string" || authority.length > 100 || authority !== authority.toLowerCase() || !uint64(sequence)) throw new Error("COSMOS_SIGNED_JOURNAL_SLOT_INVALID");
  try { if (fromBech32(authority).data.length !== 20) throw new Error(); }
  catch { throw new Error("COSMOS_SIGNED_JOURNAL_SLOT_INVALID"); }
  return Object.freeze({ chainId, authority, sequence });
}

function uint64(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

function browserStorage(): CosmosSignedSwapJournalStorage {
  try { if (typeof localStorage !== "undefined") return localStorage; }
  catch { /* Normalize browser policy/privacy errors without exposing raw data. */ }
  throw new Error("COSMOS_SIGNED_JOURNAL_STORAGE_UNAVAILABLE");
}
