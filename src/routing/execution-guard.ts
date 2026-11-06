export interface ExecutionGuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export interface RouteExecutionGuardRecord {
  schema: "realdex.route-execution-guard.v3";
  state: "execution-attempt-locked";
  guardKey: string;
  routeFingerprint: string;
  executionIntentId: string;
  requestFingerprint: string;
  quoteId: string;
  createdAt: number;
}

const schema = "realdex.route-execution-guard.v3" as const;
const fingerprintPattern = /^0x[0-9a-f]{64}$/;
const intentPattern = /^realdex-intent:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function routeExecutionGuardKey(routeFingerprint: string, executionIntentId: string): string {
  assertFingerprint(routeFingerprint);
  assertIntentId(executionIntentId);
  return `localswap:route-intent-execution:${routeFingerprint}:${executionIntentId}`;
}

export function legacyQuoteExecutionGuardKey(routeFingerprint: string, requestFingerprint: string, quoteId: string): string {
  assertFingerprint(routeFingerprint);
  assertFingerprint(requestFingerprint);
  assertQuoteId(quoteId);
  return `localswap:route-execution:${routeFingerprint}:${requestFingerprint}:${quoteId}`;
}

export function createRouteExecutionGuardRecord(routeFingerprint: string, executionIntentId: string, requestFingerprint: string, quoteId: string, createdAt = Date.now()): RouteExecutionGuardRecord {
  const guardKey = routeExecutionGuardKey(routeFingerprint, executionIntentId);
  assertFingerprint(requestFingerprint);
  assertQuoteId(quoteId);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error("EXECUTION_GUARD_TIMESTAMP_INVALID");
  return { schema, state: "execution-attempt-locked", guardKey, routeFingerprint, executionIntentId, requestFingerprint, quoteId, createdAt };
}

export function assertRouteExecutionGuardRecord(value: unknown, expectedKey?: string): asserts value is RouteExecutionGuardRecord {
  if (!isObject(value) || !exactObjectKeys(value, ["schema", "state", "guardKey", "routeFingerprint", "executionIntentId", "requestFingerprint", "quoteId", "createdAt"])) throw new Error("EXECUTION_GUARD_RECORD_INVALID");
  if (value.schema !== schema || value.state !== "execution-attempt-locked" || typeof value.guardKey !== "string" || typeof value.routeFingerprint !== "string" || typeof value.executionIntentId !== "string" || typeof value.requestFingerprint !== "string" || typeof value.quoteId !== "string" || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) <= 0) throw new Error("EXECUTION_GUARD_RECORD_INVALID");
  assertFingerprint(value.requestFingerprint);
  assertQuoteId(value.quoteId);
  const derivedKey = routeExecutionGuardKey(value.routeFingerprint, value.executionIntentId);
  if (value.guardKey !== derivedKey || (expectedKey !== undefined && value.guardKey !== expectedKey)) throw new Error("EXECUTION_GUARD_RECORD_CHANGED");
}

/** Any value at an exact execution key blocks replay. Legacy expiry is intentionally ignored. */
export function persistentExecutionGuardExists(storage: ExecutionGuardStorage, key: string): boolean {
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { return true; }
  if (raw === null) return false;
  try {
    const value: unknown = JSON.parse(raw);
    assertRouteExecutionGuardRecord(value, key);
  } catch {
    // Malformed and legacy records remain fail-closed. Browser storage is an untrusted recovery hint.
  }
  return true;
}

/** Legacy keys cannot be rebound to a new intent. Any old guard for the exact route blocks migration. */
export function legacyRouteExecutionGuardExists(storage: ExecutionGuardStorage, routeFingerprint: string): boolean {
  if (!/^(?:0x[0-9a-f]{64}|fnv1a:[0-9a-f]{8})$/.test(routeFingerprint)) throw new Error("EXECUTION_GUARD_FINGERPRINT_INVALID");
  if (typeof storage.length !== "number" || typeof storage.key !== "function") return false;
  const prefix = `localswap:route-execution:${routeFingerprint}:`;
  try {
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > 100_000) return true;
    for (let index = 0; index < length; index++) if (storage.key(index)?.startsWith(prefix)) return true;
    return false;
  } catch {
    return true;
  }
}

export function persistRouteExecutionGuard(storage: ExecutionGuardStorage, record: RouteExecutionGuardRecord): void {
  assertRouteExecutionGuardRecord(record);
  const serialized = JSON.stringify(record);
  try {
    storage.setItem(record.guardKey, serialized);
    if (storage.getItem(record.guardKey) !== serialized) throw new Error("readback mismatch");
  } catch {
    throw new Error("EXECUTION_GUARD_PERSISTENCE_UNAVAILABLE");
  }
}

export function clearRouteExecutionGuard(storage: ExecutionGuardStorage, key: string): boolean {
  try {
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

function assertFingerprint(value: string): void {
  if (!fingerprintPattern.test(value)) throw new Error("EXECUTION_GUARD_FINGERPRINT_INVALID");
}

function assertIntentId(value: string): void {
  if (!intentPattern.test(value)) throw new Error("EXECUTION_INTENT_ID_INVALID");
}

function assertQuoteId(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 800 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("QUOTE_ID_INVALID");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
