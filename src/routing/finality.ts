import { ibcFinalityRouteForId } from "../bridge/ibc";
import { assertCctpTransferBinding, cctpMessageMatchesBinding, parseCctpV2BurnMessage } from "../bridge/cctp-message";
import { createCctpEvmSourceReaderQuorum, verifyCctpEvmSourceMessage, type CctpEvmSourceReader } from "../bridge/cctp-evm-source";
import { createCctpEvmDestinationReaderQuorum, verifyCctpEvmDestination, type CctpEvmDestinationReader } from "../bridge/cctp-evm-destination";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { boundedJsonGet } from "../security/bounded-json-get";
import { legacyRouteDescriptorFingerprint, routeDescriptorFingerprint } from "./engine";
import type { RouteDescriptor, RouteFinalityCursor, RouteFinalityEvidence, RouteFinalityRecord, RouteFinalityStage, RouteQuote } from "./types";

export type FinalityObservation = { stage: RouteFinalityStage; evidence: RouteFinalityEvidence[] };
export const MAX_ROUTE_FINALITY_RECORDS = 16;
export type RouteFinalityReservation = {
  schema: "realdex.route-finality-reservation.v1";
  routeId: string;
  routeFingerprint: string;
  requestFingerprint: string;
  quoteId: string;
  executionId: string;
  createdAt: number;
};
export type FinalityTrackingState =
  | { status: "idle"; record: RouteFinalityRecord }
  | { status: "checking"; record: RouteFinalityRecord; attemptId: string }
  | { status: "check-failed"; record: RouteFinalityRecord; code: string };

export type FinalityTrackingEvent =
  | { type: "checkStarted"; attemptId: string }
  | { type: "checkSucceeded"; attemptId: string; observation: FinalityObservation; now?: number }
  | { type: "checkFailed"; attemptId: string; code: string };

const TRANSITIONS: Record<RouteFinalityStage, RouteFinalityStage[]> = {
  "source-submitted": ["source-included", "awaiting-proof", "destination-submitted", "destination-observed", "destination-confirmed", "failed", "unknown"],
  "source-included": ["awaiting-proof", "destination-submitted", "destination-observed", "destination-confirmed", "refundable", "failed", "unknown"],
  "awaiting-proof": ["destination-submitted", "destination-observed", "destination-confirmed", "refundable", "failed", "unknown"],
  "destination-submitted": ["destination-observed", "destination-confirmed", "failed", "unknown"],
  "destination-observed": ["destination-confirmed", "refundable", "failed", "unknown"],
  "destination-confirmed": [],
  refundable: ["awaiting-proof", "destination-submitted", "destination-observed", "destination-confirmed", "failed", "unknown"],
  failed: [],
  unknown: ["source-included", "awaiting-proof", "destination-submitted", "destination-observed", "destination-confirmed", "refundable", "failed"]
};

export function createRouteFinalityRecord(input: Omit<RouteFinalityRecord, "schema" | "revision" | "createdAt" | "updatedAt">, now = Date.now()): RouteFinalityRecord {
  const record: RouteFinalityRecord = { schema: "localswap.finality.v1", ...input, revision: 1, createdAt: now, updatedAt: now };
  assertStandaloneRecord(record, now);
  return record;
}

export function initialFinalityTrackingState(record: RouteFinalityRecord): FinalityTrackingState {
  assertStandaloneRecord(record);
  return { status: "idle", record };
}

export function finalityTrackingReducer(state: FinalityTrackingState, event: FinalityTrackingEvent): FinalityTrackingState {
  switch (event.type) {
    case "checkStarted":
      if (state.status === "checking" || isTerminalFinalityStage(state.record.stage)) return state;
      return { status: "checking", record: state.record, attemptId: event.attemptId };
    case "checkSucceeded":
      if (state.status !== "checking" || state.attemptId !== event.attemptId) return state;
      return { status: "idle", record: applyFinalityObservation(state.record, event.observation, event.now) };
    case "checkFailed":
      if (state.status !== "checking" || state.attemptId !== event.attemptId) return state;
      return { status: "check-failed", record: state.record, code: normalizeCode(event.code) };
  }
}

export function applyFinalityObservation(record: RouteFinalityRecord, observation: FinalityObservation, now = Date.now()): RouteFinalityRecord {
  assertStandaloneRecord(record, now);
  if (record.cursor.protocol === "ibc-ics20" && (observation.stage === "destination-confirmed" || (observation.stage === "failed" && observation.evidence.some((item) => item.kind === "packet-ack")))) throw new Error("IBC_FINALITY_INDEPENDENT_PROOF_REQUIRED");
  if (observation.stage !== record.stage && !TRANSITIONS[record.stage].includes(observation.stage)) throw new Error("FINALITY_TRANSITION_INVALID");
  const evidence = mergeEvidence(record.evidence, observation.evidence, now);
  const changed = observation.stage !== record.stage || evidence.length !== record.evidence.length;
  if (!changed) return record;
  const next = { ...record, stage: observation.stage, evidence, revision: record.revision + 1, updatedAt: now };
  assertStandaloneRecord(next, now);
  return next;
}

export async function checkRouteFinality(record: RouteFinalityRecord, route: RouteDescriptor, request: typeof fetch = fetch, now = Date.now(), cctpSourceReaders?: readonly CctpEvmSourceReader[], cctpDestinationReaders?: readonly CctpEvmDestinationReader[]): Promise<FinalityObservation> {
  assertRouteFinalityRecord(record, route, now);
  return record.cursor.protocol === "cctp-v2"
    ? checkCctpFinality(record.cursor, request, now, cctpSourceReaders, cctpDestinationReaders)
    : checkIbcFinality(record.routeId, record.cursor, request, now);
}

export function persistRouteFinality(record: RouteFinalityRecord, route: RouteDescriptor): boolean {
  assertRouteFinalityRecord(record, route);
  try {
    if (typeof localStorage === "undefined") return false;
    if (record.routeFingerprint !== routeDescriptorFingerprint(route)) return false;
    const loaded = loadRouteFinalities(route);
    if (loaded.error) return false;
    const key = finalityStorageKeyV2(record);
    const previousRaw = localStorage.getItem(key);
    const serialized = JSON.stringify(record);
    if (previousRaw !== null) {
      const previous = JSON.parse(previousRaw) as RouteFinalityRecord | RouteFinalityReservation;
      if (previous.schema === "realdex.route-finality-reservation.v1") {
        assertRouteFinalityReservation(previous, route);
        if (previous.quoteId !== record.quoteId || previous.executionId !== record.executionId || previous.routeFingerprint !== record.routeFingerprint) return false;
        localStorage.setItem(key, serialized);
        return localStorage.getItem(key) === serialized;
      }
      assertRouteFinalityRecord(previous, route);
      if (previousRaw === serialized) return true;
      assertFinalityRecordUpdate(previous, record);
    } else {
      if (loaded.records.length + loaded.reservations.length >= MAX_ROUTE_FINALITY_RECORDS) return false;
      if ([...loaded.records, ...loaded.reservations].some((item) => (item.executionId === record.executionId && item.quoteId !== record.quoteId) || (item.quoteId === record.quoteId && item.executionId !== record.executionId))) return false;
    }
    localStorage.setItem(key, serialized);
    return localStorage.getItem(key) === serialized;
  } catch { return false; }
}

export function loadRouteFinality(route: RouteDescriptor): { record?: RouteFinalityRecord; error?: string } {
  const loaded = loadRouteFinalities(route);
  return loaded.error ? { error: loaded.error } : { record: loaded.records[0] };
}

export function loadRouteFinalities(route: RouteDescriptor): { records: RouteFinalityRecord[]; reservations: RouteFinalityReservation[]; error?: string } {
  try {
    if (typeof localStorage === "undefined") return { records: [], reservations: [] };
    if (localStorage.length > 10_000) throw new Error("FINALITY_STORAGE_SCAN_LIMIT");
    const records = new Map<string, RouteFinalityRecord>();
    const reservations = new Map<string, RouteFinalityReservation>();
    const executionBindings = new Map<string, string>();
    const quoteBindings = new Map<string, string>();
    const prefix = finalityStoragePrefixV2(route.id);
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) throw new Error("FINALITY_STORAGE_INVALID");
      const value = JSON.parse(raw) as RouteFinalityRecord | RouteFinalityReservation;
      if (value.schema === "realdex.route-finality-reservation.v1") {
        assertRouteFinalityReservation(value, route);
        if (key !== finalityStorageKeyV2(value)) throw new Error("FINALITY_STORAGE_KEY_MISMATCH");
        const identity = finalityRecordIdentity(value);
        if (records.has(identity) || reservations.has(identity)) throw new Error("FINALITY_STORAGE_DUPLICATE");
        assertUniqueOperationBindings(value, executionBindings, quoteBindings);
        reservations.set(identity, value);
      } else {
        assertRouteFinalityRecord(value, route);
        if (key !== finalityStorageKeyV2(value)) throw new Error("FINALITY_STORAGE_KEY_MISMATCH");
        const identity = finalityRecordIdentity(value);
        if (records.has(identity) || reservations.has(identity)) throw new Error("FINALITY_STORAGE_DUPLICATE");
        assertUniqueOperationBindings(value, executionBindings, quoteBindings);
        records.set(identity, value);
      }
    }
    const legacyRaw = localStorage.getItem(finalityStorageKeyV1(route.id));
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as RouteFinalityRecord;
      assertRouteFinalityRecord(legacy, route);
      if (!records.has(finalityRecordIdentity(legacy)) && !reservations.has(finalityRecordIdentity(legacy))) {
        assertUniqueOperationBindings(legacy, executionBindings, quoteBindings);
        records.set(finalityRecordIdentity(legacy), legacy);
      }
    }
    if (records.size + reservations.size > MAX_ROUTE_FINALITY_RECORDS) throw new Error("FINALITY_STORAGE_CAPACITY_EXCEEDED");
    return { records: [...records.values()].sort(compareFinalityRecords), reservations: [...reservations.values()].sort((left, right) => right.createdAt - left.createdAt) };
  } catch (reason) {
    return { records: [], reservations: [], error: normalizeCode(reason instanceof Error ? reason.message : "FINALITY_STORAGE_INVALID") };
  }
}

export function routeFinalityStorageHasCapacity(route: RouteDescriptor): boolean {
  const loaded = loadRouteFinalities(route);
  return !loaded.error && loaded.records.length + loaded.reservations.length < MAX_ROUTE_FINALITY_RECORDS;
}

export function reserveRouteFinality(route: RouteDescriptor, quote: RouteQuote, executionId: string, now = Date.now()): RouteFinalityReservation {
  if (quote.routeId !== route.id || quote.routeFingerprint !== routeDescriptorFingerprint(route) || typeof executionId !== "string" || !executionId || executionId.length > 800 || !Number.isSafeInteger(now) || now <= 0) throw new Error("FINALITY_RESERVATION_IDENTITY_INVALID");
  const reservation: RouteFinalityReservation = {
    schema: "realdex.route-finality-reservation.v1", routeId: route.id, routeFingerprint: quote.routeFingerprint,
    requestFingerprint: quote.requestFingerprint, quoteId: quote.quoteId, executionId, createdAt: now
  };
  assertRouteFinalityReservation(reservation, route, now);
  try {
    if (typeof localStorage === "undefined") throw new Error("FINALITY_STORAGE_UNAVAILABLE");
    const loaded = loadRouteFinalities(route);
    if (loaded.error) throw new Error(loaded.error);
    const key = finalityStorageKeyV2(reservation);
    const serialized = JSON.stringify(reservation);
    const previous = localStorage.getItem(key);
    if (previous !== null) {
      if (previous === serialized) return reservation;
      throw new Error("FINALITY_RESERVATION_CONFLICT");
    }
    if (loaded.records.length + loaded.reservations.length >= MAX_ROUTE_FINALITY_RECORDS) throw new Error("FINALITY_STORAGE_CAPACITY_UNAVAILABLE");
    if ([...loaded.records, ...loaded.reservations].some((item) => (item.executionId === reservation.executionId && item.quoteId !== reservation.quoteId) || (item.quoteId === reservation.quoteId && item.executionId !== reservation.executionId))) throw new Error("FINALITY_RESERVATION_CONFLICT");
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw new Error("FINALITY_STORAGE_PERSIST_FAILED");
    return reservation;
  } catch (reason) {
    if (reason instanceof Error && /^FINALITY_[A-Z0-9_]+$/.test(reason.message)) throw reason;
    throw new Error("FINALITY_STORAGE_PERSIST_FAILED");
  }
}

export function clearRouteFinalityReservation(reservation: RouteFinalityReservation, route: RouteDescriptor): boolean {
  assertRouteFinalityReservation(reservation, route);
  try {
    if (typeof localStorage === "undefined") return false;
    const key = finalityStorageKeyV2(reservation);
    if (localStorage.getItem(key) !== JSON.stringify(reservation)) return false;
    localStorage.removeItem(key);
    return localStorage.getItem(key) === null;
  } catch { return false; }
}

export function reconcileRouteFinalityRecord(existing: RouteFinalityRecord | undefined, incoming: RouteFinalityRecord, route: RouteDescriptor, now = Date.now()): RouteFinalityRecord {
  assertRouteFinalityRecord(incoming, route, now);
  if (!existing) return incoming;
  assertRouteFinalityRecord(existing, route, now);
  if (finalityRecordIdentity(existing) !== finalityRecordIdentity(incoming) || existing.provider !== incoming.provider || JSON.stringify(existing.cursor) !== JSON.stringify(incoming.cursor)) throw new Error("FINALITY_RECEIPT_IDENTITY_CHANGED");
  return applyFinalityObservation(existing, { stage: incoming.stage, evidence: incoming.evidence }, now);
}

export function finalityRecordIdentity(record: Pick<RouteFinalityRecord, "routeId" | "executionId" | "quoteId">): string {
  return cryptographicFingerprint("realdex.route-finality-operation.v1", {
    routeId: record.routeId, executionId: record.executionId, quoteId: record.quoteId
  });
}

export function assertRouteFinalityRecord(record: RouteFinalityRecord, route: RouteDescriptor, now = Date.now()): void {
  assertStandaloneRecord(record, now);
  if (record.routeId !== route.id || ![routeDescriptorFingerprint(route), legacyRouteDescriptorFingerprint(route)].includes(record.routeFingerprint)) throw new Error("FINALITY_ROUTE_CHANGED");
  if (record.cursor.protocol !== route.adapterId) throw new Error("FINALITY_PROTOCOL_MISMATCH");
}

export function assertRouteFinalityReservation(reservation: RouteFinalityReservation, route: RouteDescriptor, now = Date.now()): void {
  if (!isPlainObject(reservation) || !exactObjectKeys(reservation, ["schema", "routeId", "routeFingerprint", "requestFingerprint", "quoteId", "executionId", "createdAt"]) || reservation.schema !== "realdex.route-finality-reservation.v1") throw new Error("FINALITY_RESERVATION_INVALID");
  if (reservation.routeId !== route.id || reservation.routeFingerprint !== routeDescriptorFingerprint(route) || !/^0x[0-9a-f]{64}$/.test(reservation.requestFingerprint) || ![reservation.quoteId, reservation.executionId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 800) || !Number.isSafeInteger(reservation.createdAt) || reservation.createdAt <= 0 || reservation.createdAt > now + 5 * 60_000) throw new Error("FINALITY_RESERVATION_IDENTITY_INVALID");
}

export function isTerminalFinalityStage(stage: RouteFinalityStage): boolean {
  return stage === "destination-confirmed" || stage === "failed";
}

async function checkCctpFinality(cursor: Extract<RouteFinalityCursor, { protocol: "cctp-v2" }>, request: typeof fetch, now: number, suppliedReaders?: readonly CctpEvmSourceReader[], suppliedDestinationReaders?: readonly CctpEvmDestinationReader[]): Promise<FinalityObservation> {
  if (!cursor.transferBinding) throw new Error("CCTP_FINALITY_TRANSFER_BINDING_REQUIRED");
  assertCctpTransferBinding(cursor.transferBinding);
  for (const txHash of cursor.sourceTxCandidates) {
    const url = `https://iris-api-sandbox.circle.com/v2/messages/${cursor.sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`;
    const response = await boundedJsonGet(url, request, { errorPrefix: "FINALITY_PROVIDER", bodylessStatuses: [404] });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`FINALITY_PROVIDER_HTTP_${response.status}`);
    const body = response.body;
    if (!isPlainObject(body) || !Array.isArray(body.messages) || body.messages.length > 8) throw new Error("CCTP_FINALITY_RESPONSE_INVALID");
    const parsed = body.messages.map((message) => {
      if (!isPlainObject(message) || message.cctpVersion !== 2 || !["pending", "complete"].includes(String(message.status))) throw new Error("CCTP_FINALITY_MESSAGE_INVALID");
      if (message.forwardTxHash !== undefined && (typeof message.forwardTxHash !== "string" || !validTransactionId(message.forwardTxHash))) throw new Error("CCTP_FINALITY_MESSAGE_INVALID");
      return { response: message, raw: parseCctpV2BurnMessage(message.message) };
    });
    const matching = parsed.filter((message) => cctpMessageMatchesBinding(message.raw, cursor.sourceDomain, cursor.destinationDomain, cursor.transferBinding!));
    if (matching.length > 1) throw new Error("CCTP_FINALITY_MESSAGE_AMBIGUOUS");
    const message = matching[0];
    if (!message) continue;
    const readers = suppliedReaders ?? createCctpEvmSourceReaderQuorum(cursor.sourceDomain, request);
    const evidence: RouteFinalityEvidence[] = [];
    if (readers) {
      const source = await verifyCctpEvmSourceMessage({ sourceDomain: cursor.sourceDomain, transactionHash: txHash, rawMessage: message.response.message as string, readers });
      if (!source) return { stage: "source-submitted", evidence: [] };
      evidence.push(
        { kind: "source-tx", id: source.transactionHash, observedAt: now },
        { kind: "source-log", id: `evm:${source.transactionHash}@${source.blockHash}:${source.logIndex}:${[...source.readerIds].sort().join("+")}`, observedAt: now }
      );
    }
    evidence.push({ kind: "provider-message", id: `cctp:${message.raw.nonce}`, observedAt: now, url });
    if (typeof message.response.forwardTxHash === "string") {
      evidence.push({ kind: "destination-tx", id: message.response.forwardTxHash, observedAt: now });
      const destinationReaders = suppliedDestinationReaders ?? createCctpEvmDestinationReaderQuorum(cursor.destinationDomain, request);
      if (!destinationReaders) return { stage: "destination-submitted", evidence };
      const destination = await verifyCctpEvmDestination({ sourceDomain: cursor.sourceDomain, destinationDomain: cursor.destinationDomain, transactionHash: message.response.forwardTxHash, rawMessage: message.response.message as string, readers: destinationReaders });
      if (!destination) return { stage: "destination-submitted", evidence };
      const readerIds = [...destination.readerIds].sort().join("+");
      evidence.push(
        { kind: "destination-message", id: `evm:${destination.transactionHash}@${destination.blockHash}:${destination.messageLogIndex}:${readerIds}`, observedAt: now },
        { kind: "destination-mint", id: `evm:${destination.transactionHash}@${destination.blockHash}:${destination.mintLogIndex}:${readerIds}`, observedAt: now }
      );
      return { stage: "destination-confirmed", evidence };
    }
    return { stage: message.response.status === "complete" ? "awaiting-proof" : "source-included", evidence };
  }
  return { stage: "source-submitted", evidence: [] };
}

async function checkIbcFinality(routeId: string, cursor: Extract<RouteFinalityCursor, { protocol: "ibc-ics20" }>, request: typeof fetch, now: number): Promise<FinalityObservation> {
  const config = ibcFinalityRouteForId(routeId);
  if (!config || config.sourceChannel !== cursor.sourceChannel || config.destinationChannel !== cursor.destinationChannel) throw new Error("IBC_FINALITY_ROUTE_CHANGED");
  const sourceUrl = `${config.sourceRest}/cosmos/tx/v1beta1/txs/${encodeURIComponent(cursor.sourceTxHash)}`;
  const sourceResponse = await boundedJsonGet(sourceUrl, request, { errorPrefix: "FINALITY_SOURCE" });
  if (!sourceResponse.ok) throw new Error(`FINALITY_SOURCE_HTTP_${sourceResponse.status}`);
  const sourceBody = sourceResponse.body;
  assertIbcSourceTransaction(sourceBody, cursor);
  const sourceEvidence: RouteFinalityEvidence = { kind: "source-tx", id: cursor.sourceTxHash, observedAt: now, url: `${config.explorerTx}${cursor.sourceTxHash}` };
  const ackUrl = `${config.destinationRest}/ibc/core/channel/v1/channels/${cursor.destinationChannel}/ports/transfer/packet_acks/${cursor.sequence}`;
  const ackResponse = await boundedJsonGet(ackUrl, request, { errorPrefix: "FINALITY_DESTINATION", bodylessStatuses: [404] });
  if (ackResponse.status === 404) return { stage: now >= cursor.timeoutAt ? "unknown" : "awaiting-proof", evidence: [sourceEvidence] };
  if (!ackResponse.ok) throw new Error(`FINALITY_DESTINATION_HTTP_${ackResponse.status}`);
  const ackBody = ackResponse.body;
  const acknowledgement = parseIbcAcknowledgement(ackBody);
  const ackEvidence: RouteFinalityEvidence = { kind: "packet-ack", id: `${cursor.destinationChannel}/${cursor.sequence}@${acknowledgement.height}`, observedAt: now, url: ackUrl, outcome: acknowledgement.success ? "success" : "error" };
  return { stage: "destination-observed", evidence: [sourceEvidence, ackEvidence] };
}

function assertStandaloneRecord(record: RouteFinalityRecord, now = Date.now()): void {
  if (!isPlainObject(record) || record.schema !== "localswap.finality.v1") throw new Error("FINALITY_RECORD_INVALID");
  if (![record.executionId, record.quoteId, record.routeId, record.routeFingerprint, record.provider].every((value) => typeof value === "string" && value.length > 0 && value.length <= 500)) throw new Error("FINALITY_IDENTITY_INVALID");
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, record.stage)) throw new Error("FINALITY_STAGE_INVALID");
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt) || record.createdAt <= 0 || record.updatedAt < record.createdAt || record.updatedAt > now + 5 * 60_000) throw new Error("FINALITY_TIME_INVALID");
  assertCursor(record.cursor);
  const evidence = mergeEvidence([], record.evidence, now);
  if (record.cursor.protocol === "ibc-ics20") {
    const acknowledgementEvidence = record.evidence.filter((item) => item.kind === "packet-ack");
    if (record.stage === "destination-confirmed" || (record.stage === "failed" && acknowledgementEvidence.length > 0)) throw new Error("IBC_FINALITY_INDEPENDENT_PROOF_REQUIRED");
    if (record.stage === "destination-observed" && acknowledgementEvidence.length < 1) throw new Error("IBC_ACK_OBSERVATION_REQUIRED");
  } else {
    if (record.stage === "destination-observed") throw new Error("FINALITY_STAGE_PROTOCOL_MISMATCH");
    if (record.cursor.transferBinding && [3, 6].includes(record.cursor.sourceDomain) && ["source-included", "awaiting-proof", "destination-submitted", "destination-confirmed", "refundable"].includes(record.stage) && !hasCctpEvmSourceProof(record.cursor, evidence)) throw new Error("CCTP_SOURCE_PROOF_REQUIRED");
    if (record.cursor.transferBinding && [3, 6].includes(record.cursor.destinationDomain) && record.stage === "destination-confirmed" && !hasCctpEvmDestinationProof(evidence)) throw new Error("CCTP_DESTINATION_PROOF_REQUIRED");
  }
}

function assertCursor(cursor: RouteFinalityCursor): void {
  if (!isPlainObject(cursor)) throw new Error("FINALITY_CURSOR_INVALID");
  if (cursor.protocol === "cctp-v2") {
    const expectedKeys = ["protocol", "sourceDomain", "destinationDomain", "sourceTxCandidates", ...(cursor.transferBinding === undefined ? [] : ["transferBinding"])];
    if (!exactObjectKeys(cursor, expectedKeys)) throw new Error("CCTP_FINALITY_CURSOR_INVALID");
    if (!Number.isInteger(cursor.sourceDomain) || cursor.sourceDomain < 0 || cursor.sourceDomain > 100 || !Number.isInteger(cursor.destinationDomain) || cursor.destinationDomain < 0 || cursor.destinationDomain > 100 || cursor.sourceDomain === cursor.destinationDomain) throw new Error("CCTP_FINALITY_DOMAIN_INVALID");
    if (!Array.isArray(cursor.sourceTxCandidates) || cursor.sourceTxCandidates.length === 0 || cursor.sourceTxCandidates.length > 8 || cursor.sourceTxCandidates.some((value) => typeof value !== "string" || !validTransactionId(value)) || new Set(cursor.sourceTxCandidates).size !== cursor.sourceTxCandidates.length) throw new Error("CCTP_FINALITY_TX_INVALID");
    if (cursor.transferBinding !== undefined) assertCctpTransferBinding(cursor.transferBinding);
    return;
  }
  if (cursor.protocol !== "ibc-ics20" || !exactObjectKeys(cursor, ["protocol", "sourceTxHash", "sequence", "sourceChannel", "destinationChannel", "timeoutAt"]) || typeof cursor.sourceTxHash !== "string" || !/^[0-9A-F]{64}$/i.test(cursor.sourceTxHash) || !/^\d{1,20}$/.test(cursor.sequence) || !/^channel-\d{1,10}$/.test(cursor.sourceChannel) || !/^channel-\d{1,10}$/.test(cursor.destinationChannel) || !Number.isSafeInteger(cursor.timeoutAt) || cursor.timeoutAt <= 0) throw new Error("IBC_FINALITY_CURSOR_INVALID");
}

function mergeEvidence(existing: RouteFinalityEvidence[], incoming: RouteFinalityEvidence[], now: number): RouteFinalityEvidence[] {
  if (!Array.isArray(existing) || !Array.isArray(incoming) || existing.length + incoming.length > 32) throw new Error("FINALITY_EVIDENCE_INVALID");
  const merged = new Map<string, RouteFinalityEvidence>();
  const acknowledgementOutcomes = new Map<string, "success" | "error">();
  for (const item of [...existing, ...incoming]) {
    if (!isPlainObject(item)) throw new Error("FINALITY_EVIDENCE_INVALID");
    const expectedKeys = ["kind", "id", "observedAt", ...(item.url === undefined ? [] : ["url"]), ...(item.outcome === undefined ? [] : ["outcome"])];
    if (!exactObjectKeys(item, expectedKeys) || !["source-tx", "source-log", "provider-message", "destination-tx", "destination-message", "destination-mint", "packet-ack"].includes(item.kind) || typeof item.id !== "string" || !item.id || item.id.length > 500 || !Number.isSafeInteger(item.observedAt) || item.observedAt <= 0 || item.observedAt > now + 5 * 60_000 || (item.url !== undefined && !isHttps(item.url)) || (item.kind === "packet-ack" ? item.outcome !== "success" && item.outcome !== "error" : item.outcome !== undefined)) throw new Error("FINALITY_EVIDENCE_INVALID");
    if (item.kind === "packet-ack") {
      const previousOutcome = acknowledgementOutcomes.get(item.id);
      if (previousOutcome !== undefined && previousOutcome !== item.outcome) throw new Error("IBC_ACK_OBSERVATION_CONFLICT");
      acknowledgementOutcomes.set(item.id, item.outcome as "success" | "error");
    }
    merged.set(`${item.kind}:${item.id}`, { ...item });
  }
  return [...merged.values()].slice(-16);
}

function hasCctpEvmSourceProof(cursor: Extract<RouteFinalityCursor, { protocol: "cctp-v2" }>, evidence: RouteFinalityEvidence[]): boolean {
  return cursor.sourceTxCandidates.some((candidate) => {
    const hash = candidate.toLowerCase();
    return evidence.some((item) => item.kind === "source-tx" && item.id.toLowerCase() === hash)
      && evidence.some((item) => item.kind === "source-log" && item.id.toLowerCase().startsWith(`evm:${hash}@0x`) && /^evm:0x[0-9a-f]{64}@0x[0-9a-f]{64}:\d+:[a-z0-9.-]+\+[a-z0-9.-]+$/.test(item.id.toLowerCase()));
  });
}

function hasCctpEvmDestinationProof(evidence: RouteFinalityEvidence[]): boolean {
  const transactionIds = new Set(evidence.filter((item) => item.kind === "destination-tx" && /^0x[0-9a-f]{64}$/i.test(item.id)).map((item) => item.id.toLowerCase()));
  const parse = (kind: "destination-message" | "destination-mint") => evidence.filter((item) => item.kind === kind).flatMap((item) => {
    const match = /^evm:(0x[0-9a-f]{64})@(0x[0-9a-f]{64}):(\d+):([a-z0-9.-]+\+[a-z0-9.-]+)$/i.exec(item.id);
    return match ? [{ transactionHash: match[1].toLowerCase(), blockHash: match[2].toLowerCase(), readers: match[4].toLowerCase() }] : [];
  });
  const messages = parse("destination-message"), mints = parse("destination-mint");
  return messages.some((message) => transactionIds.has(message.transactionHash) && mints.some((mint) => mint.transactionHash === message.transactionHash && mint.blockHash === message.blockHash && mint.readers === message.readers));
}

function assertIbcSourceTransaction(value: unknown, cursor: Extract<RouteFinalityCursor, { protocol: "ibc-ics20" }>): void {
  if (!isPlainObject(value) || !isPlainObject(value.tx_response)) throw new Error("IBC_SOURCE_TX_RESPONSE_INVALID");
  const tx = value.tx_response;
  if (Number(tx.code) !== 0 || typeof tx.txhash !== "string" || tx.txhash.toUpperCase() !== cursor.sourceTxHash.toUpperCase() || !Array.isArray(tx.events)) throw new Error("IBC_SOURCE_TX_NOT_CONFIRMED");
  const matched = tx.events.some((event) => {
    if (!isPlainObject(event) || event.type !== "send_packet" || !Array.isArray(event.attributes)) return false;
    const attributes = new Map(event.attributes.filter(isPlainObject).map((item) => [String(item.key), String(item.value)]));
    return attributes.get("packet_sequence") === cursor.sequence && attributes.get("packet_src_channel") === cursor.sourceChannel && attributes.get("packet_dst_channel") === cursor.destinationChannel;
  });
  if (!matched) throw new Error("IBC_SOURCE_PACKET_MISMATCH");
}

function parseIbcAcknowledgement(value: unknown): { success: boolean; height: string } {
  if (!isPlainObject(value) || typeof value.acknowledgement !== "string" || !value.acknowledgement || !isPlainObject(value.proof_height) || !/^\d+$/.test(String(value.proof_height.revision_height)) || BigInt(String(value.proof_height.revision_height)) <= 0n) throw new Error("IBC_ACK_RESPONSE_INVALID");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(base64Bytes(value.acknowledgement))); } catch { throw new Error("IBC_ACK_FORMAT_UNSUPPORTED"); }
  if (!isPlainObject(parsed)) throw new Error("IBC_ACK_FORMAT_UNSUPPORTED");
  if (parsed.result === "AQ==" && parsed.error === undefined) return { success: true, height: String(value.proof_height.revision_height) };
  if (typeof parsed.error === "string" && parsed.error.trim()) return { success: false, height: String(value.proof_height.revision_height) };
  throw new Error("IBC_ACK_FORMAT_UNSUPPORTED");
}

function base64Bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("BASE64_INVALID");
  const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assertFinalityRecordUpdate(previous: RouteFinalityRecord, next: RouteFinalityRecord): void {
  if (finalityRecordIdentity(previous) !== finalityRecordIdentity(next)
    || previous.routeFingerprint !== next.routeFingerprint
    || previous.provider !== next.provider
    || JSON.stringify(previous.cursor) !== JSON.stringify(next.cursor)
    || previous.createdAt !== next.createdAt) throw new Error("FINALITY_STORAGE_IDENTITY_CHANGED");
  if (next.revision !== previous.revision + 1 || next.updatedAt < previous.updatedAt) throw new Error("FINALITY_STORAGE_REVISION_INVALID");
  if (next.stage !== previous.stage && !TRANSITIONS[previous.stage].includes(next.stage)) throw new Error("FINALITY_TRANSITION_INVALID");
  const nextEvidence = new Map(next.evidence.map((item) => [`${item.kind}:${item.id}`, JSON.stringify(item)]));
  if (previous.evidence.some((item) => nextEvidence.get(`${item.kind}:${item.id}`) !== JSON.stringify(item))) throw new Error("FINALITY_EVIDENCE_REGRESSION");
}

function assertUniqueOperationBindings(record: Pick<RouteFinalityRecord, "executionId" | "quoteId">, executions: Map<string, string>, quotes: Map<string, string>): void {
  const executionQuote = executions.get(record.executionId);
  const quoteExecution = quotes.get(record.quoteId);
  if ((executionQuote !== undefined && executionQuote !== record.quoteId) || (quoteExecution !== undefined && quoteExecution !== record.executionId)) throw new Error("FINALITY_STORAGE_IDENTITY_COLLISION");
  executions.set(record.executionId, record.quoteId);
  quotes.set(record.quoteId, record.executionId);
}

function compareFinalityRecords(left: RouteFinalityRecord, right: RouteFinalityRecord): number {
  return right.updatedAt - left.updatedAt || finalityRecordIdentity(left).localeCompare(finalityRecordIdentity(right));
}

function finalityStoragePrefixV2(routeId: string): string { return `realdex:route-finality:v2:${routeId}:`; }
function finalityStorageKeyV2(record: Pick<RouteFinalityRecord, "routeId" | "executionId" | "quoteId">): string { return `${finalityStoragePrefixV2(record.routeId)}${finalityRecordIdentity(record)}`; }
function finalityStorageKeyV1(routeId: string): string { return `localswap:finality:v1:${routeId}`; }
function validTransactionId(value: string): boolean { return /^0x[0-9a-f]{64}$/i.test(value) || /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value); }
function normalizeCode(value: string): string { return /^[A-Z][A-Z0-9_]{2,100}$/.test(value) ? value : "FINALITY_CHECK_FAILED"; }
function isHttps(value: string): boolean { try { return new URL(value).protocol === "https:"; } catch { return false; } }
function isPlainObject(value: unknown): value is Record<string, any> { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
