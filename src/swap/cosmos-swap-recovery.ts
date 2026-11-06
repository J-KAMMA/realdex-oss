import { ripemd160, Secp256k1, Secp256k1Signature, sha256 } from "@cosmjs/crypto";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { makeSignBytes, makeSignDoc } from "@cosmjs/proto-signing";
import { base64 } from "@scure/base";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import { canonicalProtoFields } from "./canonical-protobuf";
import { validateCosmosSwapIntent, validateCosmosVenueDescriptor, type CosmosSwapIntent, type CosmosVenueDescriptor, type VerifiedCosmosSwap } from "./cosmos-swap-boundary";

const STORAGE_KEY = "realdex:cosmos-swap-recovery:v1";
const MAX_RECORDS = 16;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TRANSACTION_BYTES = 20_000;
const MAX_READER_HEIGHT_DIVERGENCE = 300n;
const SECP256K1_HALF_ORDER = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
const STAGES = ["signed-not-submitted", "submitted", "committed-success", "committed-failed", "expired-unresolved"] as const;

export const COSMOS_SWAP_RECOVERY_ID = "cosmos-swap-recovery-v1";
export type CosmosSwapRecoveryStage = typeof STAGES[number];

export type CosmosSwapRecoveryStatus = {
  transactionHash: string;
  height: string;
  code: number;
  codespace: string;
  gasWanted: string;
  gasUsed: string;
};

export type CosmosSwapRecoveryObservation = {
  readerId: string;
  blockHeight: string;
  transactionHeight: string | null;
  code: number | null;
  codespace: string | null;
  gasWanted: string | null;
  gasUsed: string | null;
};

export type CosmosSwapRecoveryRecord = {
  schema: "realdex.cosmos-swap-recovery.v1";
  revision: 1;
  recoveryId: string;
  venueId: string;
  venueRevision: number;
  chainId: string;
  bech32Prefix: string;
  executionTarget: string;
  authority: string;
  recipient: string;
  sourceDenom: string;
  destinationDenom: string;
  amountInBaseUnits: string;
  expectedOutBaseUnits: string;
  minimumOutBaseUnits: string;
  accountNumber: string;
  sequence: string;
  feeDenom: string;
  feeAmountBaseUnits: string;
  gasLimit: string;
  timeoutHeight: string;
  transactionHash: string;
  signedTransactionSha256: string;
  unsignedTransactionSha256: string;
  signDocSha256: string;
  intentSha256: string;
  publicKeyBase64: string;
  signatureSha256: string;
  stage: CosmosSwapRecoveryStage;
  resendBlocked: true;
  observations: CosmosSwapRecoveryObservation[];
  refreshCount: number;
  createdAt: number;
  updatedAt: number;
};

export type CosmosSwapRecoveryReader = {
  readonly id: string;
  chainId(): Promise<string>;
  blockHeight(): Promise<string>;
  transaction(transactionHash: string): Promise<CosmosSwapRecoveryStatus | null>;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Structural snapshot only, never evidence of authorization or storage authenticity. */
export function snapshotCosmosSwapRecoveryRecord(value: CosmosSwapRecoveryRecord): CosmosSwapRecoveryRecord {
  return assertRecord(value);
}

export type VerifiedSignedCosmosSwapTransaction = Pick<CosmosSwapRecoveryRecord,
  "transactionHash" | "signedTransactionSha256" | "unsignedTransactionSha256" | "signDocSha256" | "intentSha256" | "publicKeyBase64" | "signatureSha256">;

/** Verifies already-signed bytes only; does not imply submission or retain bytes. */
export async function verifySignedCosmosSwapTransaction(input: {
  venue: CosmosVenueDescriptor;
  intent: CosmosSwapIntent;
  verified: VerifiedCosmosSwap;
  signedTransactionBase64: string;
  transactionHash: string;
  now?: number;
}): Promise<VerifiedSignedCosmosSwapTransaction> {
  input = { ...input, venue: validateCosmosVenueDescriptor(input.venue), intent: validateCosmosSwapIntent(input.intent), verified: { ...input.verified } };
  assertStaticBinding(input.venue, input.intent, input.verified);
  const unsigned = parseTxRaw(input.intent.transactionBase64, false);
  const signed = parseTxRaw(input.signedTransactionBase64, true);
  if (!sameBytes(unsigned.bodyBytes, signed.bodyBytes) || !sameBytes(unsigned.authInfoBytes, signed.authInfoBytes)) throw new Error("COSMOS_SWAP_RECOVERY_SIGNED_CONTENT_MISMATCH");

  const publicKey = extractPublicKey(unsigned.authInfoBytes, input.venue.publicKeyTypeUrl);
  const derivedAuthority = toBech32(input.venue.bech32Prefix, ripemd160(sha256(publicKey)));
  if (derivedAuthority !== input.intent.authority) throw new Error("COSMOS_SWAP_RECOVERY_AUTHORITY_MISMATCH");
  const signBytes = makeSignBytes(makeSignDoc(unsigned.bodyBytes, unsigned.authInfoBytes, chainReference(input.intent.chainId), uint(input.intent.accountNumber, "COSMOS_SWAP_RECOVERY_ACCOUNT_INVALID")));
  const signHash = sha256(signBytes);
  let validSignature = false;
  try {
    const signature = Secp256k1Signature.fromFixedLength(signed.signature);
    validSignature = bytesToBigInt(signature.s()) <= SECP256K1_HALF_ORDER && Secp256k1.verifySignature(signature, signHash, publicKey);
  } catch { /* Never expose underlying cryptographic-library error details. */ }
  if (!validSignature) throw new Error("COSMOS_SWAP_RECOVERY_SIGNATURE_INVALID");

  const unsignedTransactionSha256 = await sha256Hex(unsigned.transactionBytes);
  const signedTransactionSha256 = await sha256Hex(signed.transactionBytes);
  const signDocSha256 = await sha256Hex(signBytes);
  const intentSha256 = await sha256Hex(new TextEncoder().encode(canonicalIntent(input.intent)));
  const transactionHash = signedTransactionSha256.toUpperCase();
  if (input.transactionHash !== transactionHash || input.verified.transactionSha256 !== unsignedTransactionSha256 || input.verified.signDocSha256 !== signDocSha256 || input.verified.intentSha256 !== intentSha256) throw new Error("COSMOS_SWAP_RECOVERY_VERIFIED_EVIDENCE_MISMATCH");
  return Object.freeze({ transactionHash, signedTransactionSha256, unsignedTransactionSha256, signDocSha256, intentSha256,
    publicKeyBase64: base64.encode(publicKey), signatureSha256: await sha256Hex(signed.signature) });
}

type RecoveryInput = {
  venue: CosmosVenueDescriptor;
  intent: CosmosSwapIntent;
  verified: VerifiedCosmosSwap;
  signedTransactionBase64: string;
  transactionHash: string;
  now?: number;
};

/** Legacy post-broadcast receipt. The caller must have observed a broadcast result;
 * a matching hash alone is not proof that this transaction was submitted. */
export function createCosmosSwapRecoveryRecord(input: RecoveryInput): Promise<CosmosSwapRecoveryRecord> {
  return createRecoveryRecord(input, "submitted");
}

/** Track an already verified signature without inventing a broadcast event. */
export function createCosmosSignedSwapRecoveryRecord(input: RecoveryInput): Promise<CosmosSwapRecoveryRecord> {
  return createRecoveryRecord(input, "signed-not-submitted");
}

async function createRecoveryRecord(input: RecoveryInput, stage: "submitted" | "signed-not-submitted"): Promise<CosmosSwapRecoveryRecord> {
  input = { ...input, venue: validateCosmosVenueDescriptor(input.venue), intent: validateCosmosSwapIntent(input.intent), verified: { ...input.verified } };
  const now = input.now ?? Date.now();
  const { transactionHash, signedTransactionSha256, unsignedTransactionSha256, signDocSha256, intentSha256, publicKeyBase64, signatureSha256 } = await verifySignedCosmosSwapTransaction(input);
  const recoveryId = await sha256Hex(new TextEncoder().encode(`${input.intent.chainId}|${input.venue.venueId}|${intentSha256}|${transactionHash}`));
  return assertRecord({
    schema: "realdex.cosmos-swap-recovery.v1", revision: 1, recoveryId,
    venueId: input.venue.venueId, venueRevision: input.venue.revision, chainId: input.intent.chainId,
    bech32Prefix: input.venue.bech32Prefix, executionTarget: input.venue.executionTarget,
    authority: input.intent.authority, recipient: input.intent.recipient,
    sourceDenom: input.intent.sourceDenom, destinationDenom: input.intent.destinationDenom,
    amountInBaseUnits: input.intent.amountInBaseUnits, expectedOutBaseUnits: input.intent.expectedOutBaseUnits,
    minimumOutBaseUnits: input.intent.minimumOutBaseUnits, accountNumber: input.intent.accountNumber,
    sequence: input.intent.sequence, feeDenom: input.intent.feeDenom,
    feeAmountBaseUnits: input.intent.feeAmountBaseUnits, gasLimit: input.intent.gasLimit,
    timeoutHeight: input.intent.timeoutHeight, transactionHash, signedTransactionSha256,
    unsignedTransactionSha256, signDocSha256, intentSha256, publicKeyBase64,
    signatureSha256, stage, resendBlocked: true,
    observations: [], refreshCount: 0, createdAt: now, updatedAt: now
  });
}

export async function refreshCosmosSwapRecovery(recordValue: CosmosSwapRecoveryRecord, readers: readonly CosmosSwapRecoveryReader[], now = Date.now()): Promise<CosmosSwapRecoveryRecord> {
  const record = assertRecord(recordValue);
  if (!validTime(now) || now < record.updatedAt) throw new Error("COSMOS_SWAP_RECOVERY_TIME_INVALID");
  assertReaderQuorum(readers);
  // Capture selectors and methods before any injected reader can yield or mutate
  // another reader. Neither caller edits nor late results may rewrite our receipt.
  const selected = readers.map(reader => ({ id: reader.id, chainId: reader.chainId.bind(reader), blockHeight: reader.blockHeight.bind(reader), transaction: reader.transaction.bind(reader) }));
  const results = await Promise.all(selected.map(async (reader) => {
    const [chainId, blockHeightValue, statusValue] = await Promise.all([reader.chainId(), reader.blockHeight(), reader.transaction(record.transactionHash).then(value => value === null ? null : { ...value })]);
    const status = statusValue;
    if (chainId !== chainReference(record.chainId)) throw new Error("COSMOS_SWAP_RECOVERY_CHAIN_MISMATCH");
    const blockHeight = uint(blockHeightValue, "COSMOS_SWAP_RECOVERY_HEIGHT_INVALID");
    assertStatus(status, record.transactionHash);
    const prior = record.observations.find((item) => item.readerId.toLowerCase() === reader.id.toLowerCase());
    if (prior && blockHeight < BigInt(prior.blockHeight)) throw new Error("COSMOS_SWAP_RECOVERY_HEIGHT_REGRESSION");
    if (status && BigInt(status.height) > blockHeight) throw new Error("COSMOS_SWAP_RECOVERY_STATUS_INVALID");
    return { readerId: reader.id, blockHeight, status };
  }));
  const heights = results.map((result) => result.blockHeight);
  if (maxBigInt(heights) - minBigInt(heights) > MAX_READER_HEIGHT_DIVERGENCE) throw new Error("COSMOS_SWAP_RECOVERY_HEIGHT_DIVERGENCE");
  const statuses = results.map((result) => result.status);
  if ((statuses[0] === null) !== (statuses[1] === null)) throw new Error("COSMOS_SWAP_RECOVERY_QUORUM_MISMATCH");
  let stage: CosmosSwapRecoveryStage;
  if (statuses[0] && statuses[1]) {
    if (statusFingerprint(statuses[0]) !== statusFingerprint(statuses[1])) throw new Error("COSMOS_SWAP_RECOVERY_QUORUM_MISMATCH");
    // SDK timeout height is inclusive. A committed nonzero timeout failure may
    // itself appear after that height; it must not be mistaken for missing history.
    if (statuses[0].code === 0 && BigInt(statuses[0].height) > BigInt(record.timeoutHeight)) throw new Error("COSMOS_SWAP_RECOVERY_STATUS_INVALID");
    if (record.stage === "committed-success" || record.stage === "committed-failed") {
      const previous = record.observations[0];
      const { height, code, codespace, gasWanted, gasUsed } = statuses[0];
      if (observationResultFingerprint(previous) !== observationResultFingerprint({ transactionHeight: height, code, codespace, gasWanted, gasUsed })) throw new Error("COSMOS_SWAP_RECOVERY_TERMINAL_CONFLICT");
    }
    stage = statuses[0].code === 0 ? "committed-success" : "committed-failed";
  } else {
    stage = heights.every((height) => height > BigInt(record.timeoutHeight)) ? "expired-unresolved" : record.stage === "signed-not-submitted" ? "signed-not-submitted" : "submitted";
  }
  assertTransition(record.stage, stage);
  const observations = results.map(({ readerId, blockHeight, status }) => ({
    readerId, blockHeight: blockHeight.toString(), transactionHeight: status?.height ?? null,
    code: status?.code ?? null, codespace: status?.codespace ?? null,
    gasWanted: status?.gasWanted ?? null, gasUsed: status?.gasUsed ?? null
  }));
  return assertRecord({ ...record, stage, observations, refreshCount: record.refreshCount + 1, updatedAt: now });
}

export function createCosmosSwapRecoveryReader(endpointValue: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000, signal?: AbortSignal): CosmosSwapRecoveryReader {
  const endpoint = normalizeEndpoint(endpointValue);
  const request = createRestRequester(endpoint, fetchImpl, timeoutMs, signal);
  return {
    id: new URL(endpoint).hostname.toLowerCase(),
    chainId: async () => {
      const body = record(await request("cosmos/base/tendermint/v1beta1/node_info"));
      return requiredString(record(body.default_node_info).network);
    },
    blockHeight: async () => {
      const body = record(await request("cosmos/base/tendermint/v1beta1/blocks/latest"));
      return requiredUint(record(record(body.block).header).height);
    },
    transaction: async (transactionHash) => {
      if (!isTransactionHash(transactionHash)) throw new Error("COSMOS_SWAP_RECOVERY_HASH_INVALID");
      const result = await request(`cosmos/tx/v1beta1/txs/${transactionHash}`, true);
      if (result === null) return null;
      const response = record(record(result).tx_response);
      return {
        transactionHash: requiredTransactionHash(response.txhash), height: requiredPositiveUint(response.height),
        code: requiredCode(response.code), codespace: optionalString(response.codespace),
        gasWanted: requiredUint(response.gas_wanted), gasUsed: requiredUint(response.gas_used)
      };
    }
  };
}

export function createCosmosSwapRecoveryReaderQuorum(endpoints: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 8_000, signal?: AbortSignal): CosmosSwapRecoveryReader[] {
  if (endpoints.length !== 2 || endpoints.some((value) => !value.trim())) throw new Error("COSMOS_SWAP_RECOVERY_READER_QUORUM_REQUIRED");
  const normalized = endpoints.map(normalizeEndpoint), hosts = normalized.map((value) => new URL(value).hostname.toLowerCase());
  if (new Set(normalized).size !== 2 || new Set(hosts).size !== 2) throw new Error("COSMOS_SWAP_RECOVERY_READER_QUORUM_NOT_INDEPENDENT");
  return normalized.map((value) => createCosmosSwapRecoveryReader(value, fetchImpl, timeoutMs, signal));
}

export function readCosmosSwapRecoveryJournal(storage: StorageLike = localStorage): CosmosSwapRecoveryRecord[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("COSMOS_SWAP_RECOVERY_JOURNAL_INVALID"); }
  if (!isRecord(value) || !exactKeys(value, ["schema", "records"]) || value.schema !== "realdex.cosmos-swap-recovery-journal.v1" || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error("COSMOS_SWAP_RECOVERY_JOURNAL_INVALID");
  const records = value.records.map(assertRecord);
  if (new Set(records.map((item) => item.recoveryId)).size !== records.length) throw new Error("COSMOS_SWAP_RECOVERY_JOURNAL_INVALID");
  return records;
}

export function writeCosmosSwapRecoveryRecord(recordValue: CosmosSwapRecoveryRecord, storage: StorageLike = localStorage): void {
  const next = assertRecord(recordValue);
  const records = readCosmosSwapRecoveryJournal(storage).filter((item) => item.recoveryId !== next.recoveryId);
  records.unshift(next);
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  storage.setItem(STORAGE_KEY, JSON.stringify({ schema: "realdex.cosmos-swap-recovery-journal.v1", records: records.slice(0, MAX_RECORDS) }));
}

function assertStaticBinding(venue: CosmosVenueDescriptor, intent: CosmosSwapIntent, verified: VerifiedCosmosSwap): void {
  if (venue.schema !== "realdex.cosmos-venue.v1" || intent.schema !== "realdex.cosmos-swap-intent.v1" || verified.schema !== "realdex.verified-cosmos-swap.v1" || verified.execution !== "design-gate" || venue.venueId !== intent.venueId || venue.venueId !== verified.venueId || venue.revision !== intent.venueRevision || venue.chainId !== intent.chainId || venue.chainId !== verified.chainId || verified.sourceDebitBaseUnits !== intent.amountInBaseUnits || verified.destinationCreditBaseUnits !== intent.expectedOutBaseUnits || verified.feeAmountBaseUnits !== intent.feeAmountBaseUnits || ![verified.transactionSha256, verified.signDocSha256, verified.intentSha256].every(isHash) || verified.observations.length !== 2 || new Set(verified.observations.map((item) => item.readerId.toLowerCase())).size !== 2) throw new Error("COSMOS_SWAP_RECOVERY_BINDING_INVALID");
}

function parseTxRaw(value: string, signed: boolean): { transactionBytes: Uint8Array; bodyBytes: Uint8Array; authInfoBytes: Uint8Array; signature: Uint8Array } {
  let transactionBytes: Uint8Array;
  try { transactionBytes = base64.decode(value); } catch { throw new Error("COSMOS_SWAP_RECOVERY_TRANSACTION_ENCODING_INVALID"); }
  if (!transactionBytes.length || transactionBytes.length > MAX_TRANSACTION_BYTES) throw new Error("COSMOS_SWAP_RECOVERY_TRANSACTION_SIZE_INVALID");
  const tx = canonicalProtoFields(transactionBytes, { 1: [2, 1], 2: [2, 1], 3: [2, 1] }, "COSMOS_SWAP_RECOVERY_TXRAW_INVALID");
  const signature = tx.get(3)![0].bytes!;
  if (signed ? signature.length !== 64 : signature.length !== 0) throw new Error(signed ? "COSMOS_SWAP_RECOVERY_SIGNATURE_INVALID" : "COSMOS_SWAP_RECOVERY_UNSIGNED_TRANSACTION_INVALID");
  return { transactionBytes, bodyBytes: tx.get(1)![0].bytes!, authInfoBytes: tx.get(2)![0].bytes!, signature };
}

function extractPublicKey(authInfoBytes: Uint8Array, expectedTypeUrl: string): Uint8Array {
  const auth = canonicalProtoFields(authInfoBytes, { 1: [2, 1], 2: [2, 1] }, "COSMOS_SWAP_RECOVERY_AUTH_INFO_INVALID");
  const signer = canonicalProtoFields(auth.get(1)![0].bytes!, { 1: [2, 1], 2: [2, 1], 3: [0, -1] }, "COSMOS_SWAP_RECOVERY_SIGNER_INFO_INVALID");
  const any = canonicalProtoFields(signer.get(1)![0].bytes!, { 1: [2, 1], 2: [2, 1] }, "COSMOS_SWAP_RECOVERY_PUBLIC_KEY_INVALID");
  if (new TextDecoder("utf-8", { fatal: true }).decode(any.get(1)![0].bytes!) !== expectedTypeUrl) throw new Error("COSMOS_SWAP_RECOVERY_PUBLIC_KEY_INVALID");
  const key = canonicalProtoFields(any.get(2)![0].bytes!, { 1: [2, 1] }, "COSMOS_SWAP_RECOVERY_PUBLIC_KEY_INVALID").get(1)![0].bytes!;
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) throw new Error("COSMOS_SWAP_RECOVERY_PUBLIC_KEY_INVALID");
  return key;
}

function assertRecord(value: unknown): CosmosSwapRecoveryRecord {
  const keys = ["schema", "revision", "recoveryId", "venueId", "venueRevision", "chainId", "bech32Prefix", "executionTarget", "authority", "recipient", "sourceDenom", "destinationDenom", "amountInBaseUnits", "expectedOutBaseUnits", "minimumOutBaseUnits", "accountNumber", "sequence", "feeDenom", "feeAmountBaseUnits", "gasLimit", "timeoutHeight", "transactionHash", "signedTransactionSha256", "unsignedTransactionSha256", "signDocSha256", "intentSha256", "publicKeyBase64", "signatureSha256", "stage", "resendBlocked", "observations", "refreshCount", "createdAt", "updatedAt"];
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.cosmos-swap-recovery.v1" || value.revision !== 1 || !isHash(value.recoveryId) || !bounded(value.venueId, 100) || !Number.isInteger(value.venueRevision) || Number(value.venueRevision) <= 0 || !/^cosmos:[-_a-zA-Z0-9]{1,32}$/.test(String(value.chainId)) || !/^[a-z][a-z0-9]{1,30}$/.test(String(value.bech32Prefix)) || !bounded(value.executionTarget, 256)) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
  assertAddress(value.authority, String(value.bech32Prefix)); assertAddress(value.recipient, String(value.bech32Prefix));
  [value.sourceDenom, value.destinationDenom, value.feeDenom].forEach(assertDenom);
  if (value.sourceDenom === value.destinationDenom || !positiveAmount(value.amountInBaseUnits) || !positiveAmount(value.expectedOutBaseUnits) || !positiveAmount(value.minimumOutBaseUnits) || BigInt(String(value.expectedOutBaseUnits)) < BigInt(String(value.minimumOutBaseUnits)) || !uintString(value.accountNumber) || !uintString(value.sequence) || !positiveAmount(value.feeAmountBaseUnits) || !positiveAmount(value.gasLimit) || !positiveAmount(value.timeoutHeight)) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
  if (!isTransactionHash(value.transactionHash) || String(value.transactionHash).toLowerCase() !== value.signedTransactionSha256 || ![value.signedTransactionSha256, value.unsignedTransactionSha256, value.signDocSha256, value.intentSha256, value.signatureSha256].every(isHash) || !validBase64Key(value.publicKeyBase64) || !STAGES.includes(value.stage as CosmosSwapRecoveryStage) || value.resendBlocked !== true || !Array.isArray(value.observations) || ![0, 2].includes(value.observations.length) || !Number.isSafeInteger(value.refreshCount) || Number(value.refreshCount) < 0 || (Number(value.refreshCount) === 0 ? value.observations.length !== 0 : value.observations.length !== 2) || !validTime(value.createdAt) || !validTime(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
  value.observations.forEach(assertObservation);
  if (value.observations.length === 2 && new Set(value.observations.map((item: CosmosSwapRecoveryObservation) => item.readerId.toLowerCase())).size !== 2) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
  const observations = value.observations as CosmosSwapRecoveryObservation[];
  const terminal = value.stage === "committed-success" || value.stage === "committed-failed";
  if (!observations.length) {
    if (terminal || value.stage === "expired-unresolved") throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
  } else {
    const heights = observations.map(item => BigInt(item.blockHeight));
    if (maxBigInt(heights) - minBigInt(heights) > MAX_READER_HEIGHT_DIVERGENCE) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
    if (terminal) {
      if (observations.some(item => item.transactionHeight === null || BigInt(item.transactionHeight) > BigInt(item.blockHeight) || (value.stage === "committed-success" ? item.code !== 0 || BigInt(item.transactionHeight) > BigInt(value.timeoutHeight) : item.code === 0))) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
      if (observationResultFingerprint(observations[0]) !== observationResultFingerprint(observations[1])) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
    } else {
      if (observations.some(item => item.transactionHeight !== null)) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
      const beyondTimeout = heights.every(height => height > BigInt(value.timeoutHeight));
      if ((value.stage === "expired-unresolved") !== beyondTimeout) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
    }
  }
  // A validated record is still caller-owned. Take an isolated primitive snapshot
  // for asynchronous refresh and for restoration; this is not authenticity proof.
  return { ...value, observations: observations.map(item => ({ ...item })) } as CosmosSwapRecoveryRecord;
}

function assertObservation(value: unknown): void {
  if (!isRecord(value) || !exactKeys(value, ["readerId", "blockHeight", "transactionHeight", "code", "codespace", "gasWanted", "gasUsed"]) || !bounded(value.readerId, 255) || !uintString(value.blockHeight) || !(value.transactionHeight === null || positiveAmount(value.transactionHeight)) || !(value.code === null || (Number.isSafeInteger(value.code) && Number(value.code) >= 0)) || !(value.codespace === null || (typeof value.codespace === "string" && value.codespace.length <= 128)) || !(value.gasWanted === null || uintString(value.gasWanted)) || !(value.gasUsed === null || uintString(value.gasUsed))) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
  const nulls = [value.transactionHeight, value.code, value.codespace, value.gasWanted, value.gasUsed].filter((item) => item === null).length;
  if (nulls !== 0 && nulls !== 5) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID");
}

function assertStatus(value: CosmosSwapRecoveryStatus | null, expectedHash: string): void {
  if (value === null) return;
  if (!isTransactionHash(value.transactionHash) || value.transactionHash !== expectedHash || !positiveAmount(value.height) || !Number.isSafeInteger(value.code) || value.code < 0 || typeof value.codespace !== "string" || value.codespace.length > 128 || !uintString(value.gasWanted) || !uintString(value.gasUsed)) throw new Error("COSMOS_SWAP_RECOVERY_STATUS_INVALID");
}

function assertReaderQuorum(readers: readonly CosmosSwapRecoveryReader[]): void { if (readers.length !== 2 || readers.some((reader) => !bounded(reader.id, 255) || [reader.chainId, reader.blockHeight, reader.transaction].some(method => typeof method !== "function")) || new Set(readers.map((reader) => reader.id.toLowerCase())).size !== 2) throw new Error("COSMOS_SWAP_RECOVERY_READER_QUORUM_REQUIRED"); }
function assertTransition(previous: CosmosSwapRecoveryStage, next: CosmosSwapRecoveryStage): void { if (previous === next) return; if (previous === "committed-success" || previous === "committed-failed" || (previous === "expired-unresolved" && (next === "submitted" || next === "signed-not-submitted"))) throw new Error("COSMOS_SWAP_RECOVERY_STAGE_REGRESSION"); }
function observationResultFingerprint(value: Pick<CosmosSwapRecoveryObservation, "transactionHeight" | "code" | "codespace" | "gasWanted" | "gasUsed">): string { return JSON.stringify([value.transactionHeight, value.code, value.codespace, value.gasWanted, value.gasUsed]); }
function statusFingerprint(value: CosmosSwapRecoveryStatus): string { return JSON.stringify([value.transactionHash, value.height, value.code, value.codespace, value.gasWanted, value.gasUsed]); }
function chainReference(value: string): string { return value.slice(value.indexOf(":") + 1); }
function canonicalIntent(value: CosmosSwapIntent): string { return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key as keyof CosmosSwapIntent]]))); }
function bytesToBigInt(value: Uint8Array): bigint { return BigInt(`0x${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("") || "0"}`); }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function minBigInt(values: bigint[]): bigint { return values.reduce((a, b) => a < b ? a : b); }
function maxBigInt(values: bigint[]): bigint { return values.reduce((a, b) => a > b ? a : b); }
function uint(value: unknown, error: string): bigint { if (!uintString(value)) throw new Error(error); return BigInt(value); }
function uintString(value: unknown): value is string { return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) && value.length <= 78; }
function positiveAmount(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d*$/.test(value) && value.length <= 78; }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function isTransactionHash(value: unknown): value is string { return typeof value === "string" && /^[0-9A-F]{64}$/.test(value); }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown): Record<string, any> { if (!isRecord(value)) throw new Error("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID"); return value; }
function assertDenom(value: unknown): void { if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/.test(value)) throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID"); }
function assertAddress(value: unknown, prefix: string): void { try { const decoded = fromBech32(String(value)); if (decoded.prefix !== prefix || decoded.data.length !== 20) throw new Error(); } catch { throw new Error("COSMOS_SWAP_RECOVERY_RECORD_INVALID"); } }
function validBase64Key(value: unknown): boolean { try { return typeof value === "string" && base64.decode(value).length === 33; } catch { return false; } }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID"); return value; }
function optionalString(value: unknown): string { if (value === undefined || value === null) return ""; if (typeof value !== "string" || value.length > 128) throw new Error("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID"); return value; }
function requiredUint(value: unknown): string { if (!uintString(value)) throw new Error("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID"); return value; }
function requiredPositiveUint(value: unknown): string { if (!positiveAmount(value)) throw new Error("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID"); return value; }
function requiredCode(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID"); return Number(value); }
function requiredTransactionHash(value: unknown): string { if (!isTransactionHash(value)) throw new Error("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID"); return value; }
function normalizeEndpoint(value: string): string { try { return normalizePublicRpcEndpoint(value); } catch { throw new Error("COSMOS_SWAP_RECOVERY_ENDPOINT_NOT_PUBLIC"); } }
async function sha256Hex(bytes: Uint8Array): Promise<string> { return [...sha256(bytes)].map((value) => value.toString(16).padStart(2, "0")).join(""); }

function createRestRequester(endpoint: string, fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("COSMOS_SWAP_RECOVERY_TIMEOUT_INVALID");
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return async (path: string, allowNotFound = false): Promise<unknown | null> => {
    if (signal?.aborted) throw new Error("COSMOS_SWAP_RECOVERY_CANCELLED");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("COSMOS_SWAP_RECOVERY_REST_TIMEOUT")); controller.abort(); }, timeoutMs); });
    let removeCancel = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      const abort = () => { reject(new Error("COSMOS_SWAP_RECOVERY_CANCELLED")); controller.abort(); };
      signal?.addEventListener("abort", abort, { once: true });
      removeCancel = () => signal?.removeEventListener("abort", abort);
      if (signal?.aborted) abort();
    });
    try {
      const operation = (async () => {
        let response: Response;
        try { response = await fetchImpl(new URL(path, base), { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal }); }
        catch { throw new Error("COSMOS_SWAP_RECOVERY_REST_FAILED"); }
        if (response.redirected || controller.signal.aborted) { await response.body?.cancel(); throw new Error("COSMOS_SWAP_RECOVERY_REST_FAILED"); }
        if (allowNotFound && response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new Error("COSMOS_SWAP_RECOVERY_REST_FAILED"); }
        const text = await readBounded(response, controller.signal);
        try { return JSON.parse(text); } catch { throw new Error("COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID"); }
      })();
      return await Promise.race([operation, deadline, cancelled]);
    } catch (error) {
      const known = ["COSMOS_SWAP_RECOVERY_CANCELLED", "COSMOS_SWAP_RECOVERY_REST_FAILED", "COSMOS_SWAP_RECOVERY_REST_TIMEOUT", "COSMOS_SWAP_RECOVERY_REST_RESPONSE_INVALID", "COSMOS_SWAP_RECOVERY_RESPONSE_TOO_LARGE"];
      throw new Error(error instanceof Error && known.includes(error.message) ? error.message : "COSMOS_SWAP_RECOVERY_REST_FAILED");
    } finally { clearTimeout(timer); removeCancel(); }
  };
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const length = Number(response.headers.get("content-length")); if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error("COSMOS_SWAP_RECOVERY_RESPONSE_TOO_LARGE"); }
  if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("COSMOS_SWAP_RECOVERY_RESPONSE_TOO_LARGE"); return text; }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = "";
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("COSMOS_SWAP_RECOVERY_REST_TIMEOUT");
    while (true) { const { done, value } = await reader.read(); if (signal.aborted) throw new Error("COSMOS_SWAP_RECOVERY_REST_TIMEOUT"); if (done) break; size += value.length; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("COSMOS_SWAP_RECOVERY_RESPONSE_TOO_LARGE"); } text += decoder.decode(value, { stream: true }); }
    return text + decoder.decode();
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
