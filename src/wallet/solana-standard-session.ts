import { base58 } from "@scure/base";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";

import { SOLANA_STANDARD_CLUSTERS as CLUSTERS } from "./solana-standard-clusters";
export const SOLANA_STANDARD_CLUSTERS = CLUSTERS;
const SIGN = "solana:signTransaction";
const pending = new WeakMap<object, symbol>();
const activeConnections = new WeakMap<object, () => void>();
const genuineConnections = new WeakSet<object>();
const genuineFacades = new WeakMap<object, SolanaStandardConnection>();
type TransactionVersion = "legacy" | 0;
type AnyMethod = (...args: any[]) => any;
type Profile = {
  chains: string[];
  features: string[];
  versions: TransactionVersion[];
  connectOwner: Record<string, unknown>;
  connect: AnyMethod;
  eventsOwner: Record<string, unknown>;
  on: AnyMethod;
  sign: AnyMethod;
};
type Account = { address: string; publicKey: string; chains: string[]; features: string[] };

export type SolanaStandardAccountBinding = {
  schema: "realdex.solana-standard-account-binding.v1";
  walletId: string;
  sessionId: string;
  chainId: string;
  walletChain: string;
  accountId: string;
  address: string;
  transactionVersion: TransactionVersion;
  revision: number;
  expiresAt: number;
  executionEnabled: false;
  signingEnabled: false;
  submissionEnabled: false;
};

export type SolanaStandardConnection = {
  snapshot(): {
    status: "connected" | "invalidated" | "disposed";
    revision: number;
    accounts: string[];
    chainId: string;
    walletChain: string;
    transactionVersions: TransactionVersion[];
    expiresAt: number;
    executionEnabled: false;
  };
  clearSelection(): void;
  selectAccount(address: string, version: TransactionVersion): SolanaStandardAccountBinding;
  assertCurrent(binding: SolanaStandardAccountBinding): void;
  /** Local cleanup only: does not revoke permission or call wallet disconnect. */
  dispose(): void;
};

/** Rejects structural imitations before consuming a selected account binding. */
export function assertGenuineSolanaStandardBinding(connection: SolanaStandardConnection, binding: SolanaStandardAccountBinding): void {
  const inner = genuineConnections.has(connection) ? connection : genuineFacades.get(connection);
  if (!inner) throw failure("CONNECTION_NOT_AUTHENTIC");
  inner.assertCurrent(binding);
}

/** Registration lifetimes can wrap cleanup without losing authenticity. */
export function createGenuineSolanaStandardConnectionFacade(connection: SolanaStandardConnection, onDispose: () => void): SolanaStandardConnection {
  if (!genuineConnections.has(connection) || typeof onDispose !== "function") throw failure("CONNECTION_NOT_AUTHENTIC");
  const facade: SolanaStandardConnection = Object.freeze({
    snapshot: () => connection.snapshot(),
    clearSelection: () => connection.clearSelection(),
    selectAccount: (address, version) => connection.selectAccount(address, version),
    assertCurrent: (binding) => connection.assertCurrent(binding),
    dispose: () => { try { onDispose(); } finally { connection.dispose(); } }
  });
  genuineFacades.set(facade, connection);
  return facade;
}

/** Only call after an explicit connection action. No silent restore or signing API. */
export async function connectSolanaWalletStandard(
  value: unknown,
  request: { walletId: string; chainId: string },
  options: { signal?: AbortSignal; now?: () => number; timeoutMs?: number } = {}
): Promise<SolanaStandardConnection> {
  // Capture caller input before asynchronous wallet code can change it.
  const walletId = request?.walletId;
  const chainId = request?.chainId;
  const walletChain = Object.prototype.hasOwnProperty.call(CLUSTERS, chainId) ? CLUSTERS[chainId] : undefined;
  if (!walletChain || typeof walletId !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(walletId)) throw failure("REQUEST_INVALID");
  if (!isObject(value)) throw failure("WALLET_INVALID");
  if (pending.has(value)) throw failure("CONNECTION_PENDING");
  if (options.signal?.aborted) throw failure("CONNECTION_CANCELLED");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw failure("TIMEOUT_INVALID");
  const clock = options.now ?? Date.now;
  const startTime = validTime(clock());
  let lastTime = startTime;
  const now = () => {
    const time = validTime(clock());
    if (time < lastTime) throw failure("CLOCK_CHANGED");
    lastTime = time;
    return time;
  };
  const sessionId = crypto.randomUUID();
  const pendingToken = Symbol();
  const releasePending = () => { if (pending.get(value) === pendingToken) pending.delete(value); };
  pending.set(value, pendingToken);
  activeConnections.get(value)?.();
  let profile: Profile;
  try { profile = readProfile(value, walletChain); } catch { releasePending(); throw failure("CAPABILITY_UNSUPPORTED"); }
  let state: "connecting" | "connected" | "invalidated" | "disposed" = "connecting";
  let revision = 0;
  let accounts: Account[] = [];
  let accountsDigest = "";
  let changeRevision = 0;
  let operationStarted = false;
  let operationSettled = false;
  let observationFinished = false;
  let expiresAt = 0;
  let unsubscribe: (() => void) | undefined;
  let selected: SolanaStandardAccountBinding | undefined;
  let selectedDigest = "";
  const detach = () => {
    const off = unsubscribe; unsubscribe = undefined;
    try { off?.(); } catch { /* Provider cleanup cannot restore a local session. */ }
  };
  const invalidate = () => {
    if (state === "invalidated" || state === "disposed") return;
    state = "invalidated"; revision++; accounts = []; selected = undefined; selectedDigest = "";
    if (activeConnections.get(value) === invalidate) activeConnections.delete(value);
    detach();
  };
  const changed = () => {
    // Connecting wallets normally emit accounts before resolving connect().
    // Final connect/current snapshots must agree; later events always invalidate.
    changeRevision++;
    if (state === "connected") invalidate();
  };
  try {
    const off: unknown = profile.on.call(profile.eventsOwner, "change", changed);
    if (typeof off !== "function") throw failure("EVENT_SUBSCRIPTION_REQUIRED");
    unsubscribe = off as () => void;
    if (options.signal?.aborted) throw failure("CONNECTION_CANCELLED");
    const before = readProfile(value, walletChain);
    if (!sameProfile(profile, before)) throw failure("CAPABILITY_CHANGED");
    if (now() - startTime >= timeoutMs) throw failure("CONNECTION_TIMEOUT");
    // Reading untrusted feature getters may synchronously remove registration.
    // Observe cancellation again at the boundary immediately before connect.
    if (options.signal?.aborted) throw failure("CONNECTION_CANCELLED");
    let operation: Promise<unknown>;
    try { operation = Promise.resolve(profile.connect.call(profile.connectOwner, { silent: false })); }
    catch { throw failure("CONNECTION_FAILED"); }
    operationStarted = true;
    // Timeout/cancellation cannot cancel the wallet prompt. Exclusion ends only
    // when the original call settles, not when our observation deadline passes.
    const settled = () => {
      operationSettled = true;
      if (observationFinished) releasePending();
    };
    operation.then(settled, settled);
    const output = await boundedConnection(operation, timeoutMs, options.signal);
    if (options.signal?.aborted) throw failure("CONNECTION_CANCELLED");
    if (now() - startTime >= timeoutMs) throw failure("CONNECTION_TIMEOUT");
    const observedRevision = changeRevision;
    const currentProfile = readProfile(value, walletChain);
    if (!sameProfile(profile, currentProfile)) throw failure("CAPABILITY_CHANGED");
    if (!isObject(output)) throw failure("ACCOUNTS_INVALID");
    const returned = readAccounts(output.accounts, profile);
    const current = readAccounts(value.accounts, currentProfile);
    if (digest(returned) !== digest(current)) throw failure("ACCOUNTS_CHANGED");
    accountsDigest = digest(current);
    accounts = current.filter(account => account.chains.includes(walletChain) && account.features.includes(SIGN));
    if (!accounts.length) throw failure("ACCOUNT_UNSUPPORTED");
    expiresAt = now() + 5 * 60_000;
    if (!Number.isSafeInteger(expiresAt) || observedRevision !== changeRevision) throw failure("SESSION_CHANGED");
    state = "connected"; revision++;
    activeConnections.set(value, invalidate);
  } catch (error) {
    invalidate();
    throw normalizeFailure(error);
  } finally {
    observationFinished = true;
    if (!operationStarted || operationSettled) releasePending();
  }

  const check = () => {
    if (state !== "connected") throw failure("SESSION_INVALIDATED");
    try {
      if (now() >= expiresAt) throw failure("SESSION_EXPIRED");
      const currentProfile = readProfile(value, walletChain);
      const current = readAccounts(value.accounts, currentProfile);
      if (!sameProfile(profile, currentProfile) || digest(current) !== accountsDigest) throw failure("SESSION_CHANGED");
      // Getters and event callbacks can run synchronously while checking metadata.
      if (state !== "connected") throw failure("SESSION_INVALIDATED");
    } catch (error) { invalidate(); throw normalizeFailure(error); }
  };
  const connection: SolanaStandardConnection = {
    snapshot() {
      if (state === "connected") { try { check(); } catch { /* Snapshot exposes no stale accounts. */ } }
      return { status: state as "connected" | "invalidated" | "disposed", revision, accounts: accounts.map(account => account.address), chainId, walletChain,
        transactionVersions: state === "connected" ? [...profile.versions] : [], expiresAt, executionEnabled: false };
    },
    clearSelection() { selected = undefined; selectedDigest = ""; revision++; },
    selectAccount(address, transactionVersion) {
      check();
      // Clear the old selection even when a new explicit selection is rejected.
      selected = undefined; selectedDigest = ""; revision++;
      if (!accounts.some(account => account.address === address) || !profile.versions.includes(transactionVersion)) throw failure("ACCOUNT_SELECTION_INVALID");
      selected = { schema: "realdex.solana-standard-account-binding.v1", walletId, sessionId, chainId, walletChain,
        address, accountId: `${chainId}:${address}`, transactionVersion, revision, expiresAt,
        executionEnabled: false, signingEnabled: false, submissionEnabled: false };
      selectedDigest = digest(selected);
      return selected;
    },
    assertCurrent(binding) {
      check();
      if (!selected || binding !== selected) throw failure("BINDING_NOT_CURRENT");
      try { if (digest(binding) !== selectedDigest) throw failure("BINDING_CHANGED"); }
      catch { invalidate(); throw failure("BINDING_CHANGED"); }
    },
    dispose() {
      if (state === "disposed") return;
      state = "disposed"; revision++; accounts = []; selected = undefined; selectedDigest = ""; detach();
      if (activeConnections.get(value) === invalidate) activeConnections.delete(value);
    }
  };
  genuineConnections.add(connection);
  return Object.freeze(connection);
}

function readProfile(wallet: Record<string, unknown>, chain: string): Profile {
  if (wallet.version !== "1.0.0") throw failure("WALLET_INVALID");
  const chains = strings(wallet.chains);
  if (!chains.includes(chain)) throw failure("CHAIN_UNSUPPORTED");
  const features = wallet.features;
  if (!isObject(features)) throw failure("CAPABILITY_UNSUPPORTED");
  const featureNames = strings(Object.keys(features));
  const connectOwner = feature(features, "standard:connect");
  const eventsOwner = feature(features, "standard:events");
  const signing = feature(features, SIGN);
  const connect = connectOwner.connect, on = eventsOwner.on, sign = signing.signTransaction;
  if (typeof connect !== "function" || typeof on !== "function" || typeof sign !== "function") throw failure("CAPABILITY_UNSUPPORTED");
  const versions = signing.supportedTransactionVersions;
  if (!Array.isArray(versions) || !versions.length || versions.length > 2 || versions.some(version => version !== "legacy" && version !== 0) || new Set(versions).size !== versions.length) throw failure("VERSION_UNSUPPORTED");
  return { chains, features: featureNames, versions: versions.slice().sort(), connectOwner, connect: connect as AnyMethod, eventsOwner, on: on as AnyMethod, sign: sign as AnyMethod };
}

function readAccounts(value: unknown, profile: Profile): Account[] {
  if (!Array.isArray(value) || value.length > 64 || !value.length) throw failure("ACCOUNTS_INVALID");
  const accounts = value.map(raw => {
    if (!isObject(raw)) throw failure("ACCOUNT_INVALID");
    const address = raw.address, publicKey = raw.publicKey;
    if (typeof address !== "string" || !(publicKey instanceof Uint8Array) || publicKey.byteLength !== 32 || base58.encode(publicKey) !== address) throw failure("ACCOUNT_INVALID");
    const chains = strings(raw.chains), features = strings(raw.features);
    if (chains.some(chain => !profile.chains.includes(chain)) || features.some(name => !profile.features.includes(name))) throw failure("ACCOUNT_SCOPE_INVALID");
    return { address, publicKey: base58.encode(publicKey), chains, features };
  }).sort((left, right) => left.address.localeCompare(right.address));
  if (new Set(accounts.map(account => account.address)).size !== accounts.length) throw failure("ACCOUNTS_INVALID");
  return accounts;
}

function feature(features: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(features, name)) throw failure("CAPABILITY_UNSUPPORTED");
  const value = features[name];
  if (!isObject(value) || value.version !== "1.0.0") throw failure("CAPABILITY_UNSUPPORTED");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string" || item.length > 160 || !/^[^\s:]+:[^\s]+$/u.test(item) || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(item)) || new Set(value).size !== value.length) throw failure("SCOPE_INVALID");
  return value.slice().sort();
}
function sameProfile(left: Profile, right: Profile): boolean {
  return left.connect === right.connect && left.on === right.on && left.sign === right.sign && digest({ chains: left.chains, features: left.features, versions: left.versions }) === digest({ chains: right.chains, features: right.features, versions: right.versions });
}
function digest(value: unknown) { return cryptographicFingerprint("realdex.solana-standard-session.v1", value); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validTime(value: number) { if (!Number.isSafeInteger(value) || value <= 0) throw failure("CLOCK_INVALID"); return value; }
class SessionFailure extends Error {}
function failure(code: string) { return new SessionFailure(`SOLANA_STANDARD_${code}`); }
function normalizeFailure(error: unknown) { return error instanceof SessionFailure ? error : failure("CONNECTION_FAILED"); }

function boundedConnection(operation: Promise<unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(failure("CONNECTION_CANCELLED"));
    const timer = setTimeout(() => finish(failure("CONNECTION_TIMEOUT")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    operation.then(value => finish(undefined, value), () => finish(failure("CONNECTION_FAILED")));
  });
}
