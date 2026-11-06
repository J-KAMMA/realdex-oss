import { Interface, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { normalizePublicRpcEndpoint } from "../release/evm-json-rpc-reader";
import {
  assertExternalEvmV2Calldata, externalEvmV2VenueFingerprint, validateExternalEvmV2VenueIdentity,
  type ExternalEvmV2Quote, type ExternalEvmV2VenueIdentity, type VerifiedExternalEvmV2Venue
} from "./external-evm-v2";

const STORAGE_KEY = "realdex:external-evm-v2-recovery:v1";
const MAX_RECORDS = 16;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_HEAD_DIVERGENCE = 12;
const REQUIRED_CONFIRMATIONS = 2;
const APPROVAL_INTERFACE = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);
const STATES = ["submitted", "included", "confirmed", "reverted", "replacement-unresolved"] as const;
const STAGES = ["approval-submitted", "approval-included", "approval-confirmed", "approval-reverted", "approval-replacement-unresolved", "swap-submitted", "swap-included", "swap-confirmed", "swap-reverted", "swap-replacement-unresolved"] as const;

export const EXTERNAL_EVM_V2_RECOVERY_ID = "external-evm-v2-recovery-v1";
export type ExternalEvmV2RecoveryOperation = "approval" | "swap";
export type ExternalEvmV2RecoveryTransactionState = typeof STATES[number];
export type ExternalEvmV2RecoveryStage = typeof STAGES[number];

export type ExternalEvmV2SubmittedTransaction = {
  operation: ExternalEvmV2RecoveryOperation;
  hash: string;
  from: string;
  to: string;
  nonce: number;
  data: string;
  valueBaseUnits: string;
  chainId: string;
  observedBeforeBlock: number;
};

export type ExternalEvmV2RecoveryTransaction = ExternalEvmV2SubmittedTransaction & {
  state: ExternalEvmV2RecoveryTransactionState;
  blockNumber: number | null;
  blockHash: string | null;
  confirmations: number;
};

export type ExternalEvmV2ObservedTransaction = {
  hash: string; from: string; to: string; nonce: number; data: string; valueBaseUnits: string;
  chainId: string; blockNumber: number | null; blockHash: string | null;
};
export type ExternalEvmV2ObservedReceipt = {
  transactionHash: string; from: string; to: string; status: 0 | 1; blockNumber: number; blockHash: string;
};
export type ExternalEvmV2RecoveryReader = {
  readonly id: string;
  chainId(): Promise<bigint>;
  blockNumber(): Promise<number>;
  transaction(hash: string): Promise<ExternalEvmV2ObservedTransaction | null>;
  receipt(hash: string): Promise<ExternalEvmV2ObservedReceipt | null>;
  transactionCount(account: string): Promise<number>;
};

type SerializedVenue = Omit<ExternalEvmV2VenueIdentity, "chainId"> & { chainId: string };
type SerializedQuote = Omit<ExternalEvmV2Quote, "amountIn" | "amounts" | "minimumOut"> & { amountIn: string; amounts: string[]; minimumOut: string };
export type ExternalEvmV2RecoveryObservation = {
  readerId: string;
  blockNumber: number;
  transactions: Array<{ operation: ExternalEvmV2RecoveryOperation; transactionSeen: boolean; receiptSeen: boolean; transactionCount: number }>;
};
export type ExternalEvmV2RecoveryRecord = {
  schema: "realdex.external-evm-v2-recovery.v1";
  revision: number;
  recoveryId: string;
  venueFingerprint: string;
  venue: SerializedVenue;
  quote: SerializedQuote;
  account: string;
  stage: ExternalEvmV2RecoveryStage;
  resendBlocked: true;
  transactions: ExternalEvmV2RecoveryTransaction[];
  observations: ExternalEvmV2RecoveryObservation[];
  createdAt: number;
  updatedAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function recordExternalEvmV2Submission(input: {
  venue: VerifiedExternalEvmV2Venue;
  quote: ExternalEvmV2Quote;
  account: string;
  transactions: ExternalEvmV2SubmittedTransaction[];
  previous?: ExternalEvmV2RecoveryRecord;
  now?: number;
}): ExternalEvmV2RecoveryRecord {
  const now = input.now ?? Date.now();
  const venueIdentity = validateExternalEvmV2VenueIdentity(input.venue.identity);
  const fingerprint = externalEvmV2VenueFingerprint(venueIdentity);
  if (input.venue.status !== "verified" || input.venue.fingerprint !== fingerprint) throw new Error("EXTERNAL_V2_RECOVERY_VENUE_INVALID");
  assertExternalEvmV2Calldata(input.venue, input.quote);
  const account = normalizedAddress(input.account, "EXTERNAL_V2_RECOVERY_ACCOUNT_INVALID");
  const transactions = validateSubmittedTransactions(input.transactions, venueIdentity, input.quote, account);
  const recoveryId = keccak256(toUtf8Bytes(`${fingerprint}|${input.quote.quoteId}|${account}`));
  let revision = 1, createdAt = now;
  if (input.previous) {
    const previous = assertExternalEvmV2RecoveryRecord(input.previous);
    if (previous.recoveryId !== recoveryId || previous.venueFingerprint !== fingerprint || previous.quote.quoteId !== input.quote.quoteId || previous.account !== account) throw new Error("EXTERNAL_V2_RECOVERY_IDENTITY_CHANGED");
    if (transactions.length < previous.transactions.length) throw new Error("EXTERNAL_V2_RECOVERY_TRANSACTION_REMOVED");
    previous.transactions.forEach((prior) => {
      const next = transactions.find((item) => item.operation === prior.operation);
      if (!next || submittedFingerprint(next) !== submittedFingerprint(prior)) throw new Error("EXTERNAL_V2_RECOVERY_TRANSACTION_CHANGED");
    });
    if (transactions.length > previous.transactions.length && previous.transactions[0].operation === "approval" && previous.transactions[0].state !== "confirmed") throw new Error("EXTERNAL_V2_RECOVERY_APPROVAL_NOT_CONFIRMED");
    revision = previous.revision + 1; createdAt = previous.createdAt;
  }
  const preserved = transactions.map((transaction) => {
    const prior = input.previous?.transactions.find((item) => item.operation === transaction.operation);
    return prior ? { ...prior } : { ...transaction, state: "submitted" as const, blockNumber: null, blockHash: null, confirmations: 0 };
  });
  return assertExternalEvmV2RecoveryRecord({
    schema: "realdex.external-evm-v2-recovery.v1", revision, recoveryId, venueFingerprint: fingerprint,
    venue: serializeVenue(venueIdentity), quote: serializeQuote(input.quote), account,
    stage: stageFor(preserved), resendBlocked: true, transactions: preserved, observations: [], createdAt, updatedAt: now
  });
}

export async function refreshExternalEvmV2Recovery(recordValue: ExternalEvmV2RecoveryRecord, readers: readonly ExternalEvmV2RecoveryReader[], now = Date.now()): Promise<ExternalEvmV2RecoveryRecord> {
  const record = assertExternalEvmV2RecoveryRecord(recordValue);
  assertReaderQuorum(readers);
  const chainId = BigInt(record.venue.chainId);
  const results = await Promise.all(readers.map(async (reader) => {
    const [observedChainId, head] = await Promise.all([reader.chainId(), reader.blockNumber()]);
    if (observedChainId !== chainId) throw new Error("EXTERNAL_V2_RECOVERY_CHAIN_MISMATCH");
    if (!Number.isSafeInteger(head) || head < 0) throw new Error("EXTERNAL_V2_RECOVERY_HEAD_INVALID");
    const transactionResults = await Promise.all(record.transactions.map(async (submitted) => {
        const [transaction, receipt, transactionCount] = await Promise.all([reader.transaction(submitted.hash), reader.receipt(submitted.hash), reader.transactionCount(record.account)]);
        assertObservedTransaction(transaction, submitted); assertObservedReceipt(receipt, submitted);
        if (receipt && (!transaction || transaction.blockNumber !== receipt.blockNumber || transaction.blockHash !== receipt.blockHash)) throw new Error("EXTERNAL_V2_RECOVERY_RECEIPT_TRANSACTION_MISMATCH");
        if (transaction?.blockNumber !== null && transaction?.blockNumber !== undefined && transaction.blockNumber > head) throw new Error("EXTERNAL_V2_RECOVERY_HEAD_INVALID");
        if (receipt && receipt.blockNumber > head) throw new Error("EXTERNAL_V2_RECOVERY_HEAD_INVALID");
        return { submitted, transaction, receipt, transactionCount };
      }));
    const prior = record.observations.find((item) => item.readerId.toLowerCase() === reader.id.toLowerCase());
    if (prior && head < prior.blockNumber) throw new Error("EXTERNAL_V2_RECOVERY_HEAD_REGRESSION");
    return { readerId: reader.id, head, transactionResults };
  }));
  const heads = results.map((item) => item.head);
  if (Math.max(...heads) - Math.min(...heads) > MAX_HEAD_DIVERGENCE) throw new Error("EXTERNAL_V2_RECOVERY_HEAD_DIVERGENCE");

  const transactions = record.transactions.map((previous, index) => {
    const left = results[0].transactionResults[index], right = results[1].transactionResults[index];
    if ((left.transaction === null) !== (right.transaction === null) || (left.receipt === null) !== (right.receipt === null)) throw new Error("EXTERNAL_V2_RECOVERY_QUORUM_MISMATCH");
    if (left.transaction && right.transaction && observedTransactionFingerprint(left.transaction) !== observedTransactionFingerprint(right.transaction)) throw new Error("EXTERNAL_V2_RECOVERY_QUORUM_MISMATCH");
    if (left.receipt && right.receipt && observedReceiptFingerprint(left.receipt) !== observedReceiptFingerprint(right.receipt)) throw new Error("EXTERNAL_V2_RECOVERY_QUORUM_MISMATCH");
    const consumed = [left, right].map((item) => item.transactionCount > previous.nonce);
    if (consumed[0] !== consumed[1]) throw new Error("EXTERNAL_V2_RECOVERY_QUORUM_MISMATCH");
    let state: ExternalEvmV2RecoveryTransactionState, blockNumber: number | null = null, blockHash: string | null = null, confirmations = 0;
    if (left.receipt && right.receipt) {
      blockNumber = left.receipt.blockNumber; blockHash = left.receipt.blockHash;
      confirmations = Math.min(...heads.map((head) => head - blockNumber! + 1));
      state = left.receipt.status === 0 ? "reverted" : confirmations >= REQUIRED_CONFIRMATIONS ? "confirmed" : "included";
    } else if (!left.transaction && consumed[0]) state = "replacement-unresolved";
    else state = "submitted";
    assertTransactionTransition(previous, state, blockNumber, blockHash);
    return { ...previous, state, blockNumber, blockHash, confirmations };
  });
  const stage = stageFor(transactions);
  assertStageTransition(record.stage, stage);
  const observations = results.map((result) => ({
    readerId: result.readerId, blockNumber: result.head,
    transactions: result.transactionResults.map((item) => ({ operation: item.submitted.operation, transactionSeen: item.transaction !== null, receiptSeen: item.receipt !== null, transactionCount: item.transactionCount }))
  }));
  return assertExternalEvmV2RecoveryRecord({ ...record, revision: record.revision + 1, stage, transactions, observations, updatedAt: now });
}

export function createExternalEvmV2RecoveryReader(endpointValue: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): ExternalEvmV2RecoveryReader {
  const endpoint = normalizeEndpoint(endpointValue), request = createRequester(endpoint, fetchImpl, timeoutMs);
  return {
    id: new URL(endpoint).hostname.toLowerCase(),
    chainId: async () => quantityBigInt(await request("eth_chainId", [])),
    blockNumber: async () => quantityNumber(await request("eth_blockNumber", [])),
    transaction: async (hash) => {
      assertHash(hash); const value = await request("eth_getTransactionByHash", [hash]); if (value === null) return null;
      const tx = rpcRecord(value);
      return {
        hash: requiredHash(tx.hash), from: requiredAddress(tx.from), to: requiredAddress(tx.to), nonce: quantityNumber(tx.nonce),
        data: requiredData(tx.input), valueBaseUnits: quantityBigInt(tx.value).toString(), chainId: quantityBigInt(tx.chainId).toString(),
        blockNumber: tx.blockNumber === null ? null : quantityNumber(tx.blockNumber), blockHash: tx.blockHash === null ? null : requiredHash(tx.blockHash)
      };
    },
    receipt: async (hash) => {
      assertHash(hash); const value = await request("eth_getTransactionReceipt", [hash]); if (value === null) return null;
      const receipt = rpcRecord(value), status = quantityNumber(receipt.status);
      if (status !== 0 && status !== 1) throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID");
      if (receipt.contractAddress !== null) throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID");
      return { transactionHash: requiredHash(receipt.transactionHash), from: requiredAddress(receipt.from), to: requiredAddress(receipt.to), status, blockNumber: quantityNumber(receipt.blockNumber), blockHash: requiredHash(receipt.blockHash) };
    },
    transactionCount: async (account) => { normalizedAddress(account, "EXTERNAL_V2_RECOVERY_ACCOUNT_INVALID"); return quantityNumber(await request("eth_getTransactionCount", [account, "latest"])); }
  };
}

export function createExternalEvmV2RecoveryReaderQuorum(endpoints: readonly string[], fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): ExternalEvmV2RecoveryReader[] {
  if (endpoints.length !== 2 || endpoints.some((value) => !value.trim())) throw new Error("EXTERNAL_V2_RECOVERY_READER_QUORUM_REQUIRED");
  const normalized = endpoints.map(normalizeEndpoint), hosts = normalized.map((value) => new URL(value).hostname.toLowerCase());
  if (new Set(normalized).size !== 2 || new Set(hosts).size !== 2) throw new Error("EXTERNAL_V2_RECOVERY_READER_QUORUM_NOT_INDEPENDENT");
  return normalized.map((value) => createExternalEvmV2RecoveryReader(value, fetchImpl, timeoutMs));
}

export function readExternalEvmV2RecoveryJournal(storage: StorageLike = localStorage): ExternalEvmV2RecoveryRecord[] {
  const raw = storage.getItem(STORAGE_KEY); if (raw === null) return [];
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error("EXTERNAL_V2_RECOVERY_JOURNAL_INVALID"); }
  if (!isRecord(value) || !exactKeys(value, ["schema", "records"]) || value.schema !== "realdex.external-evm-v2-recovery-journal.v1" || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error("EXTERNAL_V2_RECOVERY_JOURNAL_INVALID");
  const records = value.records.map(assertExternalEvmV2RecoveryRecord);
  if (new Set(records.map((item) => item.recoveryId)).size !== records.length) throw new Error("EXTERNAL_V2_RECOVERY_JOURNAL_INVALID");
  return records;
}

export function writeExternalEvmV2RecoveryRecord(recordValue: ExternalEvmV2RecoveryRecord, storage: StorageLike = localStorage): ExternalEvmV2RecoveryRecord[] {
  const record = assertExternalEvmV2RecoveryRecord(recordValue), existing = readExternalEvmV2RecoveryJournal(storage), prior = existing.find((item) => item.recoveryId === record.recoveryId);
  if (prior && record.revision <= prior.revision) throw new Error("EXTERNAL_V2_RECOVERY_REVISION_NOT_ADVANCED");
  const records = [record, ...existing.filter((item) => item.recoveryId !== record.recoveryId)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECORDS);
  storage.setItem(STORAGE_KEY, JSON.stringify({ schema: "realdex.external-evm-v2-recovery-journal.v1", records })); return records;
}

export function assertExternalEvmV2RecoveryRecord(value: unknown): ExternalEvmV2RecoveryRecord {
  const keys = ["schema", "revision", "recoveryId", "venueFingerprint", "venue", "quote", "account", "stage", "resendBlocked", "transactions", "observations", "createdAt", "updatedAt"];
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.external-evm-v2-recovery.v1" || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0 || !isHash(value.recoveryId) || !isHash(value.venueFingerprint) || !isAddress(value.account) || !STAGES.includes(value.stage as ExternalEvmV2RecoveryStage) || value.resendBlocked !== true || !Array.isArray(value.transactions) || value.transactions.length < 1 || value.transactions.length > 2 || !Array.isArray(value.observations) || ![0, 2].includes(value.observations.length) || !validTime(value.createdAt) || !validTime(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  const venue = deserializeVenue(value.venue);
  if (externalEvmV2VenueFingerprint(venue) !== value.venueFingerprint) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  const quote = deserializeQuote(value.quote);
  assertExternalEvmV2Calldata({ status: "verified", identity: venue, fingerprint: String(value.venueFingerprint), observedCodeHashes: { router: venue.router.runtimeCodeHash, factory: venue.factory.runtimeCodeHash, pairs: venue.pairs.map((pair) => pair.runtimeCodeHash) } }, quote);
  const transactions = value.transactions.map(assertRecoveryTransaction);
  validateSubmittedTransactions(transactions, venue, quote, String(value.account));
  if (stageFor(transactions) !== value.stage) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  value.observations.forEach((item) => assertObservation(item, transactions));
  if (value.observations.length === 2 && new Set(value.observations.map((item: ExternalEvmV2RecoveryObservation) => item.readerId.toLowerCase())).size !== 2) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  return value as unknown as ExternalEvmV2RecoveryRecord;
}

function validateSubmittedTransactions(values: ExternalEvmV2SubmittedTransaction[], venue: ExternalEvmV2VenueIdentity, quote: ExternalEvmV2Quote, account: string): ExternalEvmV2SubmittedTransaction[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 2 || new Set(values.map((item) => item.operation)).size !== values.length) throw new Error("EXTERNAL_V2_RECOVERY_TRANSACTION_SET_INVALID");
  const ordered = [...values].sort((a, b) => operationRank(a.operation) - operationRank(b.operation)).map((item) => {
    const transaction = assertSubmittedTransaction(item);
    if (transaction.from !== account || transaction.chainId !== venue.chainId.toString() || transaction.valueBaseUnits !== "0") throw new Error("EXTERNAL_V2_RECOVERY_TRANSACTION_BINDING_INVALID");
    const expectedTo = transaction.operation === "approval" ? venue.path[0] : venue.router.address;
    const expectedData = transaction.operation === "approval" ? APPROVAL_INTERFACE.encodeFunctionData("approve", [venue.router.address, quote.amountIn]) : quote.calldata;
    if (transaction.to !== expectedTo || transaction.data.toLowerCase() !== expectedData.toLowerCase()) throw new Error("EXTERNAL_V2_RECOVERY_TRANSACTION_BINDING_INVALID");
    return transaction;
  });
  if (ordered.length === 2 && (ordered[0].operation !== "approval" || ordered[1].operation !== "swap" || ordered[1].nonce <= ordered[0].nonce || ordered[0].hash === ordered[1].hash)) throw new Error("EXTERNAL_V2_RECOVERY_TRANSACTION_SET_INVALID");
  return ordered;
}

function assertSubmittedTransaction(value: unknown): ExternalEvmV2SubmittedTransaction {
  const keys = ["operation", "hash", "from", "to", "nonce", "data", "valueBaseUnits", "chainId", "observedBeforeBlock"];
  if (!isRecord(value) || Object.keys(value).some((key) => ![...keys, "state", "blockNumber", "blockHash", "confirmations"].includes(key)) || !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) || !["approval", "swap"].includes(String(value.operation)) || !isHash(value.hash) || !isAddress(value.from) || !isAddress(value.to) || !Number.isSafeInteger(value.nonce) || Number(value.nonce) < 0 || !isData(value.data) || !uintString(value.valueBaseUnits) || !positiveUintString(value.chainId) || !Number.isSafeInteger(value.observedBeforeBlock) || Number(value.observedBeforeBlock) < 0) throw new Error("EXTERNAL_V2_RECOVERY_TRANSACTION_INVALID");
  return { operation: value.operation as ExternalEvmV2RecoveryOperation, hash: String(value.hash).toLowerCase(), from: getAddress(String(value.from)), to: getAddress(String(value.to)), nonce: Number(value.nonce), data: String(value.data).toLowerCase(), valueBaseUnits: String(value.valueBaseUnits), chainId: String(value.chainId), observedBeforeBlock: Number(value.observedBeforeBlock) };
}

function assertRecoveryTransaction(value: unknown): ExternalEvmV2RecoveryTransaction {
  if (!isRecord(value) || !exactKeys(value, ["operation", "hash", "from", "to", "nonce", "data", "valueBaseUnits", "chainId", "observedBeforeBlock", "state", "blockNumber", "blockHash", "confirmations"])) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  const submitted = assertSubmittedTransaction(value);
  if (!STATES.includes(value.state as ExternalEvmV2RecoveryTransactionState) || !(value.blockNumber === null || (Number.isSafeInteger(value.blockNumber) && Number(value.blockNumber) >= 0)) || !(value.blockHash === null || isHash(value.blockHash)) || !Number.isSafeInteger(value.confirmations) || Number(value.confirmations) < 0) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  if (["included", "confirmed", "reverted"].includes(String(value.state)) ? value.blockNumber === null || value.blockHash === null : value.blockNumber !== null || value.blockHash !== null || Number(value.confirmations) !== 0) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  if (value.state === "included" && Number(value.confirmations) !== 1 || value.state === "confirmed" && Number(value.confirmations) < REQUIRED_CONFIRMATIONS || value.state === "reverted" && Number(value.confirmations) < 1) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  return { ...submitted, state: value.state as ExternalEvmV2RecoveryTransactionState, blockNumber: value.blockNumber as number | null, blockHash: value.blockHash as string | null, confirmations: Number(value.confirmations) };
}

function assertObservedTransaction(value: ExternalEvmV2ObservedTransaction | null, submitted: ExternalEvmV2SubmittedTransaction): void {
  if (value === null) return;
  if (!isHash(value.hash) || value.hash.toLowerCase() !== submitted.hash || normalizedAddress(value.from, "EXTERNAL_V2_RECOVERY_TRANSACTION_INVALID") !== submitted.from || normalizedAddress(value.to, "EXTERNAL_V2_RECOVERY_TRANSACTION_INVALID") !== submitted.to || value.nonce !== submitted.nonce || value.data.toLowerCase() !== submitted.data || value.valueBaseUnits !== submitted.valueBaseUnits || value.chainId !== submitted.chainId || !(value.blockNumber === null || (Number.isSafeInteger(value.blockNumber) && value.blockNumber >= 0)) || !(value.blockHash === null || isHash(value.blockHash)) || (value.blockNumber === null) !== (value.blockHash === null)) throw new Error("EXTERNAL_V2_RECOVERY_TRANSACTION_MISMATCH");
}
function assertObservedReceipt(value: ExternalEvmV2ObservedReceipt | null, submitted: ExternalEvmV2SubmittedTransaction): void { if (value === null) return; if (value.transactionHash.toLowerCase() !== submitted.hash || normalizedAddress(value.from, "EXTERNAL_V2_RECOVERY_RECEIPT_INVALID") !== submitted.from || normalizedAddress(value.to, "EXTERNAL_V2_RECOVERY_RECEIPT_INVALID") !== submitted.to || ![0, 1].includes(value.status) || !Number.isSafeInteger(value.blockNumber) || value.blockNumber < 0 || !isHash(value.blockHash)) throw new Error("EXTERNAL_V2_RECOVERY_RECEIPT_INVALID"); }

function assertTransactionTransition(previous: ExternalEvmV2RecoveryTransaction, next: ExternalEvmV2RecoveryTransactionState, blockNumber: number | null, blockHash: string | null): void {
  if (["confirmed", "reverted"].includes(previous.state) && previous.state !== next) throw new Error("EXTERNAL_V2_RECOVERY_STATE_REGRESSION");
  if (previous.state === "included" && !["included", "confirmed", "reverted"].includes(next)) throw new Error("EXTERNAL_V2_RECOVERY_RECEIPT_REGRESSION");
  if (previous.state === "replacement-unresolved" && next === "submitted") throw new Error("EXTERNAL_V2_RECOVERY_STATE_REGRESSION");
  if (previous.blockNumber !== null && (blockNumber !== previous.blockNumber || blockHash !== previous.blockHash)) throw new Error("EXTERNAL_V2_RECOVERY_RECEIPT_REGRESSION");
}
function assertStageTransition(previous: ExternalEvmV2RecoveryStage, next: ExternalEvmV2RecoveryStage): void { const terminal = ["approval-confirmed", "approval-reverted", "swap-confirmed", "swap-reverted"]; if (terminal.includes(previous) && previous !== next && !(previous === "approval-confirmed" && next.startsWith("swap-"))) throw new Error("EXTERNAL_V2_RECOVERY_STAGE_REGRESSION"); if (previous.endsWith("replacement-unresolved") && next.endsWith("submitted")) throw new Error("EXTERNAL_V2_RECOVERY_STAGE_REGRESSION"); }
function stageFor(transactions: ExternalEvmV2RecoveryTransaction[]): ExternalEvmV2RecoveryStage { const transaction = transactions.find((item) => item.operation === "swap") ?? transactions[0]; return `${transaction.operation}-${transaction.state}` as ExternalEvmV2RecoveryStage; }

function serializeVenue(value: ExternalEvmV2VenueIdentity): SerializedVenue { return { ...value, chainId: value.chainId.toString(), router: { ...value.router }, factory: { ...value.factory }, path: [...value.path], pairs: value.pairs.map((pair) => ({ ...pair })), evidenceUrls: [...value.evidenceUrls] }; }
function deserializeVenue(value: unknown): ExternalEvmV2VenueIdentity {
  if (!isRecord(value) || !exactKeys(value, ["schema", "venueId", "chainId", "router", "factory", "path", "pairs", "feeBps", "evidenceUrls"]) || !positiveUintString(value.chainId)) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  try { return validateExternalEvmV2VenueIdentity({ ...(value as unknown as Omit<ExternalEvmV2VenueIdentity, "chainId">), chainId: BigInt(String(value.chainId)) }); } catch { throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID"); }
}
function serializeQuote(value: ExternalEvmV2Quote): SerializedQuote { return { ...value, amountIn: value.amountIn.toString(), amounts: value.amounts.map(String), minimumOut: value.minimumOut.toString() }; }
function deserializeQuote(value: unknown): ExternalEvmV2Quote {
  if (!isRecord(value) || !exactKeys(value, ["quoteId", "venueFingerprint", "amountIn", "amounts", "minimumOut", "recipient", "deadline", "calldata"]) || !isHash(value.quoteId) || !isHash(value.venueFingerprint) || !positiveUintString(value.amountIn) || !Array.isArray(value.amounts) || value.amounts.some((item) => !positiveUintString(item)) || !positiveUintString(value.minimumOut) || !isAddress(value.recipient) || !Number.isSafeInteger(value.deadline) || Number(value.deadline) <= 0 || !isData(value.calldata)) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID");
  return { quoteId: String(value.quoteId), venueFingerprint: String(value.venueFingerprint), amountIn: BigInt(String(value.amountIn)), amounts: value.amounts.map((item) => BigInt(String(item))), minimumOut: BigInt(String(value.minimumOut)), recipient: getAddress(String(value.recipient)), deadline: Number(value.deadline), calldata: String(value.calldata) };
}
function assertObservation(value: unknown, transactions: ExternalEvmV2RecoveryTransaction[]): void { if (!isRecord(value) || !exactKeys(value, ["readerId", "blockNumber", "transactions"]) || !bounded(value.readerId, 255) || !Number.isSafeInteger(value.blockNumber) || Number(value.blockNumber) < 0 || !Array.isArray(value.transactions) || value.transactions.length !== transactions.length) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID"); value.transactions.forEach((item, index) => { if (!isRecord(item) || !exactKeys(item, ["operation", "transactionSeen", "receiptSeen", "transactionCount"]) || item.operation !== transactions[index].operation || typeof item.transactionSeen !== "boolean" || typeof item.receiptSeen !== "boolean" || (item.receiptSeen && !item.transactionSeen) || !Number.isSafeInteger(item.transactionCount) || Number(item.transactionCount) < 0) throw new Error("EXTERNAL_V2_RECOVERY_RECORD_INVALID"); }); }
function assertReaderQuorum(readers: readonly ExternalEvmV2RecoveryReader[]): void { if (readers.length !== 2 || readers.some((reader) => !bounded(reader.id, 255)) || new Set(readers.map((reader) => reader.id.toLowerCase())).size !== 2) throw new Error("EXTERNAL_V2_RECOVERY_READER_QUORUM_REQUIRED"); }
function submittedFingerprint(value: ExternalEvmV2SubmittedTransaction): string { return JSON.stringify([value.operation, value.hash, value.from, value.to, value.nonce, value.data, value.valueBaseUnits, value.chainId, value.observedBeforeBlock]); }
function observedTransactionFingerprint(value: ExternalEvmV2ObservedTransaction): string { return JSON.stringify([value.hash.toLowerCase(), getAddress(value.from), getAddress(value.to), value.nonce, value.data.toLowerCase(), value.valueBaseUnits, value.chainId, value.blockNumber, value.blockHash?.toLowerCase() ?? null]); }
function observedReceiptFingerprint(value: ExternalEvmV2ObservedReceipt): string { return JSON.stringify([value.transactionHash.toLowerCase(), getAddress(value.from), getAddress(value.to), value.status, value.blockNumber, value.blockHash.toLowerCase()]); }
function operationRank(value: ExternalEvmV2RecoveryOperation): number { return value === "approval" ? 0 : 1; }
function normalizedAddress(value: unknown, error: string): string { try { if (typeof value !== "string") throw new Error(); return getAddress(value); } catch { throw new Error(error); } }
function isAddress(value: unknown): value is string { try { return typeof value === "string" && getAddress(value) === value; } catch { return false; } }
function isHash(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value); }
function assertHash(value: unknown): asserts value is string { if (!isHash(value)) throw new Error("EXTERNAL_V2_RECOVERY_HASH_INVALID"); }
function isData(value: unknown): value is string { return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value) && value.length <= 65_538; }
function uintString(value: unknown): value is string { return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) && value.length <= 78; }
function positiveUintString(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d*$/.test(value) && value.length <= 78; }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function rpcRecord(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID"); return value; }
function requiredAddress(value: unknown): string { try { if (typeof value !== "string") throw new Error(); return getAddress(value); } catch { throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID"); } }
function requiredHash(value: unknown): string { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID"); return value.toLowerCase(); }
function requiredData(value: unknown): string { if (!isData(value)) throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID"); return value.toLowerCase(); }
function quantityBigInt(value: unknown): bigint { if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID"); return BigInt(value); }
function quantityNumber(value: unknown): number { const result = quantityBigInt(value); if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID"); return Number(result); }
function normalizeEndpoint(value: string): string { try { return normalizePublicRpcEndpoint(value); } catch { throw new Error("EXTERNAL_V2_RECOVERY_ENDPOINT_NOT_PUBLIC"); } }

function createRequester(endpoint: string, fetchImpl: typeof fetch, timeoutMs: number) {
  let id = 0;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs), requestId = ++id;
    try {
      const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("EXTERNAL_V2_RECOVERY_RPC_FAILED");
      const payload = JSON.parse(await readBounded(response));
      if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.id !== requestId || payload.error !== undefined || !("result" in payload)) throw new Error("EXTERNAL_V2_RECOVERY_RPC_RESPONSE_INVALID");
      return payload.result;
    } finally { clearTimeout(timeout); }
  };
}
async function readBounded(response: Response): Promise<string> { const length = Number(response.headers.get("content-length")); if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("EXTERNAL_V2_RECOVERY_RESPONSE_TOO_LARGE"); if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("EXTERNAL_V2_RECOVERY_RESPONSE_TOO_LARGE"); return text; } const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = ""; while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("EXTERNAL_V2_RECOVERY_RESPONSE_TOO_LARGE"); } text += decoder.decode(value, { stream: true }); } return text + decoder.decode(); }
