import { Secp256k1, ripemd160, sha256 } from "@cosmjs/crypto";
import { fromBech32 } from "@cosmjs/encoding";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";

const MAX_SESSION_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const pendingProviders = new WeakMap<object, Promise<void>>();
const activeProviders = new WeakMap<object, InternalConnection>();
const genuineConnections = new WeakMap<object, InternalConnection>();
const genuineBindings = new WeakMap<object, { connection: InternalConnection; fingerprint: string }>();
let revision = 0;

export type CosmosInjectedChainProfile = Readonly<{
  schema: "realdex.cosmos-injected-chain-profile.v1";
  chainId: string;
  walletChainId: string;
  bech32Prefix: string;
}>;

export type CosmosInjectedKey = Readonly<{
  name: string;
  algorithm: "secp256k1";
  publicKeyHex: string;
  addressHex: string;
  bech32Address: string;
  hardware: "ledger" | "keystone" | "none";
}>;

export type CosmosInjectedAccountBinding = Readonly<{
  schema: "realdex.cosmos-injected-account-binding.v1";
  walletId: string;
  sessionId: string;
  revision: number;
  chainId: string;
  walletChainId: string;
  accountId: string;
  address: string;
  publicKeyHex: string;
  hardware: "ledger" | "keystone" | "none";
  selectedAt: number;
  expiresAt: number;
  signingEnabled: false;
  submissionEnabled: false;
  executionEnabled: false;
}>;

export type CosmosInjectedProvider = {
  enable(chainIds: string | string[]): Promise<void>;
  getKey(chainId: string): Promise<unknown>;
};

export type CosmosInjectedConnection = Readonly<{
  schema: "realdex.cosmos-injected-connection.v1";
  walletId: string;
  sessionId: string;
  revision: number;
  chain: CosmosInjectedChainProfile;
  account: CosmosInjectedKey;
  connectedAt: number;
  selectAccount(now?: number): CosmosInjectedAccountBinding;
  assertCurrent(binding: CosmosInjectedAccountBinding, now?: number): Promise<void>;
  dispose(): void;
}>;

type InternalConnection = {
  provider: CosmosInjectedProvider;
  enableMethod: CosmosInjectedProvider["enable"];
  getKeyMethod: CosmosInjectedProvider["getKey"];
  walletId: string;
  sessionId: string;
  revision: number;
  chain: CosmosInjectedChainProfile;
  account: CosmosInjectedKey;
  connectedAt: number;
  invalidated: boolean;
  lastCheckedAt: number;
  removeListener: () => void;
  connection?: CosmosInjectedConnection;
};

export async function connectCosmosInjectedWallet(
  providerValue: unknown,
  profileValue: unknown,
  options: { walletId: string; eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">; signal?: AbortSignal; timeoutMs?: number; now?: () => number } 
): Promise<CosmosInjectedConnection> {
  const provider = validateProvider(providerValue);
  const profile = validateProfile(profileValue);
  const walletId = validateWalletId(options.walletId);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new Error("COSMOS_INJECTED_TIMEOUT_INVALID");
  if (pendingProviders.has(provider)) throw new Error("COSMOS_INJECTED_CONNECTION_PENDING");

  let abandoned = false;
  const eventTarget = options.eventTarget;
  let eventRevision = 0;
  let committed: InternalConnection | undefined;
  const onChange = () => {
    eventRevision += 1;
    if (committed) invalidate(committed);
  };
  eventTarget?.addEventListener("keplr_keystorechange", onChange);
  const removeListener = () => eventTarget?.removeEventListener("keplr_keystorechange", onChange);

  const operation = (async (): Promise<CosmosInjectedConnection> => {
    try {
      const enableMethod = provider.enable;
      const getKeyMethod = provider.getKey;
      await Promise.resolve(enableMethod.call(provider, profile.walletChainId));
      if (abandoned) throw new Error("COSMOS_INJECTED_CONNECTION_CANCELLED");
      const eventBaseline = eventRevision;
      const first = validateKey(await Promise.resolve(getKeyMethod.call(provider, profile.walletChainId)), profile);
      await Promise.resolve();
      const second = validateKey(await Promise.resolve(getKeyMethod.call(provider, profile.walletChainId)), profile);
      if (abandoned) throw new Error("COSMOS_INJECTED_CONNECTION_CANCELLED");
      if (eventRevision !== eventBaseline || keyFingerprint(first) !== keyFingerprint(second)) throw new Error("COSMOS_INJECTED_ACCOUNT_CHANGED");
      if (provider.enable !== enableMethod || provider.getKey !== getKeyMethod) throw new Error("COSMOS_INJECTED_PROVIDER_CHANGED");
      const connectedAt = validNow(now());
      const nextRevision = ++revision;
      const sessionId = cryptographicFingerprint("realdex.cosmos-injected-session.v1", { walletId, chainId: profile.chainId, account: second, connectedAt, revision: nextRevision });
      const internal: InternalConnection = {
        provider, enableMethod, getKeyMethod, walletId, sessionId, revision: nextRevision,
        chain: profile, account: second, connectedAt, invalidated: false, lastCheckedAt: connectedAt,
        removeListener
      };
      const connection = createConnection(internal, now);
      internal.connection = connection;
      const previous = activeProviders.get(provider);
      if (previous) invalidate(previous);
      activeProviders.set(provider, internal);
      genuineConnections.set(connection, internal);
      committed = internal;
      return connection;
    } catch (reason) {
      if (!committed) removeListener();
      throw reason;
    }
  })();

  const settled = operation.then(() => undefined, () => undefined);
  pendingProviders.set(provider, settled);
  void settled.finally(() => { if (pendingProviders.get(provider) === settled) pendingProviders.delete(provider); });
  try {
    return await observe(operation, timeoutMs, options.signal);
  } catch (reason) {
    abandoned = true;
    if (committed) invalidate(committed);
    throw reason;
  }
}

export async function assertGenuineCosmosInjectedBinding(connection: CosmosInjectedConnection, binding: CosmosInjectedAccountBinding, now = Date.now()): Promise<void> {
  const internal = genuineConnections.get(connection);
  const bindingState = genuineBindings.get(binding);
  if (!internal || !bindingState || bindingState.connection !== internal) throw new Error("COSMOS_INJECTED_BINDING_NOT_CURRENT");
  if (bindingState.fingerprint !== bindingFingerprint(binding)) throw new Error("COSMOS_INJECTED_BINDING_CHANGED");
  await assertCurrent(internal, binding, validNow(now));
}

/** Checks identity only; never exposes a provider or grants signing permission. */
export function assertCosmosInjectedProviderIdentity(connection: CosmosInjectedConnection, provider: unknown): void {
  const internal = genuineConnections.get(connection);
  if (!internal || internal.provider !== provider) throw new Error("COSMOS_INJECTED_PROVIDER_MISMATCH");
  assertConnection(internal);
  try {
    if (internal.provider.enable !== internal.enableMethod || internal.provider.getKey !== internal.getKeyMethod) throw new Error();
  } catch { throw new Error("COSMOS_INJECTED_PROVIDER_CHANGED"); }
}

function createConnection(internal: InternalConnection, now: () => number): CosmosInjectedConnection {
  const connection: CosmosInjectedConnection = {
    schema: "realdex.cosmos-injected-connection.v1",
    walletId: internal.walletId,
    sessionId: internal.sessionId,
    revision: internal.revision,
    chain: internal.chain,
    account: internal.account,
    connectedAt: internal.connectedAt,
    selectAccount: (selectedAt = now()) => {
      assertConnection(internal);
      const time = validNow(selectedAt);
      if (time < internal.lastCheckedAt) throw new Error("COSMOS_INJECTED_CLOCK_ROLLBACK");
      const binding: CosmosInjectedAccountBinding = {
        schema: "realdex.cosmos-injected-account-binding.v1",
        walletId: internal.walletId, sessionId: internal.sessionId, revision: internal.revision,
        chainId: internal.chain.chainId, walletChainId: internal.chain.walletChainId,
        accountId: `${internal.chain.chainId}:${internal.account.bech32Address}`,
        address: internal.account.bech32Address, publicKeyHex: internal.account.publicKeyHex,
        hardware: internal.account.hardware, selectedAt: time, expiresAt: time + MAX_SESSION_MS,
        signingEnabled: false, submissionEnabled: false, executionEnabled: false
      };
      genuineBindings.set(binding, { connection: internal, fingerprint: bindingFingerprint(binding) });
      return Object.freeze(binding);
    },
    assertCurrent: (binding, checkedAt = now()) => assertGenuineCosmosInjectedBinding(connection, binding, checkedAt),
    dispose: () => invalidate(internal)
  };
  return Object.freeze(connection);
}

async function assertCurrent(internal: InternalConnection, binding: CosmosInjectedAccountBinding, now: number): Promise<void> {
  assertConnection(internal);
  if (now < internal.lastCheckedAt || now < binding.selectedAt) throw new Error("COSMOS_INJECTED_CLOCK_ROLLBACK");
  if (now >= binding.expiresAt) { invalidate(internal); throw new Error("COSMOS_INJECTED_SESSION_EXPIRED"); }
  if (internal.provider.enable !== internal.enableMethod || internal.provider.getKey !== internal.getKeyMethod) { invalidate(internal); throw new Error("COSMOS_INJECTED_PROVIDER_CHANGED"); }
  const current = validateKey(await Promise.resolve(internal.getKeyMethod.call(internal.provider, internal.chain.walletChainId)), internal.chain);
  if (internal.invalidated || keyFingerprint(current) !== keyFingerprint(internal.account)) { invalidate(internal); throw new Error("COSMOS_INJECTED_ACCOUNT_CHANGED"); }
  if (activeProviders.get(internal.provider) !== internal) { invalidate(internal); throw new Error("COSMOS_INJECTED_SESSION_SUPERSEDED"); }
  internal.lastCheckedAt = now;
}

function assertConnection(internal: InternalConnection): void {
  if (internal.invalidated) throw new Error("COSMOS_INJECTED_SESSION_INVALIDATED");
  if (activeProviders.get(internal.provider) !== internal) throw new Error("COSMOS_INJECTED_SESSION_SUPERSEDED");
}

function invalidate(internal: InternalConnection): void {
  if (internal.invalidated) return;
  internal.invalidated = true;
  internal.removeListener();
  if (activeProviders.get(internal.provider) === internal) activeProviders.delete(internal.provider);
}

function validateProvider(value: unknown): CosmosInjectedProvider {
  if (!isObject(value) || typeof value.enable !== "function" || typeof value.getKey !== "function") throw new Error("COSMOS_INJECTED_PROVIDER_INVALID");
  return value as CosmosInjectedProvider;
}

function validateProfile(value: unknown): CosmosInjectedChainProfile {
  if (!isObject(value) || Object.keys(value).length !== 4 || value.schema !== "realdex.cosmos-injected-chain-profile.v1" || typeof value.chainId !== "string" || typeof value.walletChainId !== "string" || typeof value.bech32Prefix !== "string") throw new Error("COSMOS_INJECTED_CHAIN_PROFILE_INVALID");
  if (!/^cosmos:[-_a-zA-Z0-9]{1,32}$/.test(value.chainId) || value.chainId !== `cosmos:${value.walletChainId}` || !/^[a-z][a-z0-9]{0,31}$/.test(value.bech32Prefix)) throw new Error("COSMOS_INJECTED_CHAIN_PROFILE_INVALID");
  return Object.freeze({ schema: value.schema, chainId: value.chainId, walletChainId: value.walletChainId, bech32Prefix: value.bech32Prefix });
}

function validateKey(value: unknown, profile: CosmosInjectedChainProfile): CosmosInjectedKey {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.algo !== "string" || !(value.pubKey instanceof Uint8Array) || !(value.address instanceof Uint8Array) || typeof value.bech32Address !== "string" || typeof value.isNanoLedger !== "boolean") throw new Error("COSMOS_INJECTED_KEY_INVALID");
  if (!value.name.trim() || value.name.length > 100 || /[\u0000-\u001f\u007f]/.test(value.name) || value.algo !== "secp256k1" || value.pubKey.length !== 33 || ![2, 3].includes(value.pubKey[0]) || value.address.length !== 20) throw new Error("COSMOS_INJECTED_KEY_INVALID");
  try { Secp256k1.uncompressPubkey(value.pubKey); }
  catch { throw new Error("COSMOS_INJECTED_KEY_INVALID"); }
  if (value.isKeystone !== undefined && typeof value.isKeystone !== "boolean") throw new Error("COSMOS_INJECTED_KEY_INVALID");
  let decoded;
  try { decoded = fromBech32(value.bech32Address); } catch { throw new Error("COSMOS_INJECTED_KEY_INVALID"); }
  const derived = ripemd160(sha256(value.pubKey));
  if (decoded.prefix !== profile.bech32Prefix || !sameBytes(decoded.data, value.address) || !sameBytes(derived, value.address)) throw new Error("COSMOS_INJECTED_KEY_MISMATCH");
  return Object.freeze({
    name: value.name, algorithm: "secp256k1", publicKeyHex: hex(value.pubKey), addressHex: hex(value.address),
    bech32Address: value.bech32Address, hardware: value.isNanoLedger ? "ledger" : value.isKeystone === true ? "keystone" : "none"
  });
}

function keyFingerprint(value: CosmosInjectedKey): string { return cryptographicFingerprint("realdex.cosmos-injected-key.v1", value); }
function bindingFingerprint(value: CosmosInjectedAccountBinding): string { return cryptographicFingerprint("realdex.cosmos-injected-binding.v1", value); }
function validateWalletId(value: string): string { if (!/^[A-Za-z0-9._:-]{1,120}$/.test(value)) throw new Error("COSMOS_INJECTED_WALLET_ID_INVALID"); return value; }
function validNow(value: number): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error("COSMOS_INJECTED_TIME_INVALID"); return value; }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function isObject(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function observe<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (action: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); action(); };
    const onAbort = () => finish(() => reject(new Error("COSMOS_INJECTED_CONNECTION_CANCELLED")));
    const timer = setTimeout(() => finish(() => reject(new Error("COSMOS_INJECTED_CONNECTION_TIMEOUT"))), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    promise.then((value) => finish(() => resolve(value)), (reason) => finish(() => reject(reason)));
  });
}
