import { sha256 } from "@cosmjs/crypto";
import { base64 } from "@scure/base";
import { assertCosmosInjectedProviderIdentity, assertGenuineCosmosInjectedBinding } from "../wallet/cosmos-injected-session";
import { canonicalProtoFields } from "./canonical-protobuf";
import { assertGenuineCosmosInjectedSigningPreparation, prepareCosmosInjectedSigning } from "./cosmos-injected-signing-preparation";
import { assertVerifiedSourceBoundOsmosisSwap } from "./cosmos-venue-source";
import { validateCosmosSwapIntent, validateCosmosVenueDescriptor } from "./cosmos-swap-boundary";
import { verifyCosmosInjectedSignedSwap } from "./cosmos-injected-signed-swap-evidence";
import { claimCosmosSigningReservation, persistCosmosSignedSwapEvidence, readCosmosSigningSlot, type CosmosSigningJournalOptions } from "./cosmos-signed-swap-journal";
import { createCosmosSignedSwapRecoveryRecord } from "./cosmos-swap-recovery";

type EvidenceInput = Parameters<typeof verifyCosmosInjectedSignedSwap>[0];
export type CosmosDirectSigningConfirmation = Readonly<{
  action: "request-cosmos-direct-signature-only";
  preparationId: string;
  transactionSha256: string;
}>;
type Input = Omit<EvidenceInput, "signedTransactionBase64" | "transactionHash"> & {
  provider: object;
  confirmation: CosmosDirectSigningConfirmation;
};
type Options = CosmosSigningJournalOptions & { signal?: AbortSignal; timeoutMs?: number };
const pendingProviders = new WeakMap<object, Promise<void>>();

/** The reviewed UI action must supply exact confirmation; connection is insufficient.
 * Signed bytes are returned only in memory for separate explicit submission; never
 * persisted, logged or broadcast here. A timeout/cancel does not cancel the wallet.
 */
export async function requestCosmosInjectedSwapSignature(inputValue: Input, optionsValue: Options = {}) {
  const input = {
    ...inputValue, confirmation: { ...inputValue.confirmation },
    intent: validateCosmosSwapIntent(inputValue.intent), venue: validateCosmosVenueDescriptor(inputValue.venue)
  };
  const options = { ...optionsValue };
  assertGenuineCosmosInjectedSigningPreparation(input.preparation);
  assertVerifiedSourceBoundOsmosisSwap(input.verified);
  const p = input.preparation, confirmation = input.confirmation;
  if (Object.keys(confirmation).length !== 3 || confirmation.action !== "request-cosmos-direct-signature-only" || confirmation.preparationId !== p.preparationId || confirmation.transactionSha256 !== p.transactionSha256) throw new Error("COSMOS_DIRECT_SIGNING_CONFIRMATION_REQUIRED");
  if (p.hardware !== "none") throw new Error("COSMOS_DIRECT_SIGNING_HARDWARE_UNSUPPORTED");
  assertCosmosInjectedProviderIdentity(input.connection, input.provider);
  if (pendingProviders.has(input.provider)) throw new Error("COSMOS_DIRECT_SIGNING_PROVIDER_PENDING");
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("COSMOS_DIRECT_SIGNING_TIMEOUT_INVALID");
  if (options.signal?.aborted) throw new Error("COSMOS_DIRECT_SIGNING_CANCELLED");
  let abandoned = false;
  const ensureActive = () => { if (abandoned || options.signal?.aborted) throw new Error("COSMOS_DIRECT_SIGNING_CANCELLED"); };
  // Schedule after registering the pending promise, so concurrent callers cannot
  // enter another request while validation or the raw provider operation is pending.
  const operation = Promise.resolve().then(async () => {
    ensureActive();
    const method = directMethod(input.provider);
    const fresh = await prepareCosmosInjectedSigning(input);
    ensureActive();
    if (fresh.preparationId !== p.preparationId || fresh.transactionSha256 !== p.transactionSha256 || p.executionTarget !== input.venue.executionTarget || p.venueId !== input.venue.venueId) throw new Error("COSMOS_DIRECT_SIGNING_PREPARATION_CHANGED");
    const fields = canonicalProtoFields(base64.decode(p.transactionBase64), { 1: [2, 1], 2: [2, 1], 3: [2, 1] }, "COSMOS_DIRECT_SIGNING_TRANSACTION_INVALID");
    const body = fields.get(1)![0].bytes!, auth = fields.get(2)![0].bytes!;
    if (fields.get(3)![0].bytes!.length !== 0) throw new Error("COSMOS_DIRECT_SIGNING_TRANSACTION_INVALID");
    const claimed = await claimCosmosSigningReservation(p, options, input.now ?? Date.now());
    ensureActive();
    await assertGenuineCosmosInjectedBinding(input.connection, input.binding, input.now ?? Date.now());
    ensureActive();
    assertVerifiedSourceBoundOsmosisSwap(input.verified);
    assertCosmosInjectedProviderIdentity(input.connection, input.provider);
    const currentTime = input.now ?? Date.now();
    if (currentTime < claimed.requestedAt || currentTime >= p.expiresAt) throw new Error("COSMOS_DIRECT_SIGNING_EXPIRED");
    if (directMethod(input.provider) !== method) throw new Error("COSMOS_DIRECT_SIGNING_PROVIDER_CHANGED");
    if (readCosmosSigningSlot(p, options.storage)?.recordHash !== claimed.recordHash) throw new Error("COSMOS_DIRECT_SIGNING_RESERVATION_CHANGED");
    let response: unknown;
    try {
      response = await method.call(input.provider, p.walletChainId, p.authority, {
        bodyBytes: body.slice(), authInfoBytes: auth.slice(), chainId: p.walletChainId,
        // Keplr serializes this via .toString(); string also preserves account zero.
        accountNumber: p.accountNumber
      }, { preferNoSetFee: true, preferNoSetMemo: true, disableBalanceCheck: false });
    } catch { throw new Error("COSMOS_DIRECT_SIGNING_REQUEST_FAILED"); }
    ensureActive();
    assertCosmosInjectedProviderIdentity(input.connection, input.provider);
    if (directMethod(input.provider) !== method) throw new Error("COSMOS_DIRECT_SIGNING_PROVIDER_CHANGED");
    const signedTransactionBase64 = decodeResponse(response, p, body, auth);
    const transactionHash = hex(sha256(base64.decode(signedTransactionBase64))).toUpperCase();
    const evidence = await verifyCosmosInjectedSignedSwap({ ...input, signedTransactionBase64, transactionHash });
    ensureActive();
    const record = await persistCosmosSignedSwapEvidence(evidence, options);
    ensureActive();
    // Read-only status tracking starts from a signature, not an invented broadcast.
    // This snapshot holds no resend bytes and grants no execution authority.
    const recoveryRecord = await createCosmosSignedSwapRecoveryRecord({ ...input, signedTransactionBase64, transactionHash, now: evidence.acceptedAt });
    ensureActive();
    await assertGenuineCosmosInjectedBinding(input.connection, input.binding, input.now ?? Date.now());
    ensureActive();
    assertVerifiedSourceBoundOsmosisSwap(input.verified);
    assertCosmosInjectedProviderIdentity(input.connection, input.provider);
    if (directMethod(input.provider) !== method) throw new Error("COSMOS_DIRECT_SIGNING_PROVIDER_CHANGED");
    const completedAt = input.now ?? Date.now();
    if (completedAt < evidence.acceptedAt || completedAt >= p.expiresAt) throw new Error("COSMOS_DIRECT_SIGNING_EXPIRED");
    if (readCosmosSigningSlot(p, options.storage)?.recordHash !== record.recordHash) throw new Error("COSMOS_DIRECT_SIGNING_RESERVATION_CHANGED");
    return Object.freeze({ evidence, record, recoveryRecord, signedTransactionBase64, submissionEnabled: false as const });
  }).catch((error: unknown) => {
    const code = error instanceof Error && /^COSMOS_[A-Z0-9_]+$/.test(error.message) ? error.message : "COSMOS_DIRECT_SIGNING_FAILED";
    throw new Error(code);
  });
  const settled = operation.then(() => undefined, () => undefined);
  pendingProviders.set(input.provider, settled);
  void settled.then(() => { if (pendingProviders.get(input.provider) === settled) pendingProviders.delete(input.provider); });
  try { return await observe(operation, timeout, options.signal); }
  catch (error) { abandoned = true; throw error; }
}

function directMethod(provider: object): (...args: unknown[]) => Promise<unknown> {
  let owner: object | null = provider;
  for (let depth = 0; owner && depth < 5; depth++, owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "signDirect");
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") break;
      return descriptor.value;
    }
  }
  throw new Error("COSMOS_DIRECT_SIGNING_METHOD_UNAVAILABLE");
}

function decodeResponse(value: unknown, p: Input["preparation"], body: Uint8Array, auth: Uint8Array): string {
  const result = ownFields(value, ["signed", "signature"]);
  const signed = ownFields(result.signed, ["bodyBytes", "authInfoBytes", "chainId", "accountNumber"]);
  const signature = ownFields(result.signature, ["pub_key", "signature"]);
  const publicKey = ownFields(signature.pub_key, ["type", "value"]);
  if (!sameBytes(signed.bodyBytes, body) || !sameBytes(signed.authInfoBytes, auth) || signed.chainId !== p.walletChainId || decimalAccount(signed.accountNumber) !== p.accountNumber) throw new Error("COSMOS_DIRECT_SIGNING_DOCUMENT_CHANGED");
  if (publicKey.type !== "tendermint/PubKeySecp256k1" || typeof publicKey.value !== "string" || publicKey.value.length !== 44 || typeof signature.signature !== "string" || signature.signature.length !== 88) throw new Error("COSMOS_DIRECT_SIGNING_RESPONSE_INVALID");
  let bytes: Uint8Array;
  try {
    const key = base64.decode(publicKey.value);
    bytes = base64.decode(signature.signature);
    if (hex(key) !== p.publicKeyHex || base64.encode(key) !== publicKey.value || bytes.length !== 64 || base64.encode(bytes) !== signature.signature) throw new Error();
  } catch { throw new Error("COSMOS_DIRECT_SIGNING_RESPONSE_INVALID"); }
  return base64.encode(concat(byteField(1, body), byteField(2, auth), byteField(3, bytes)));
}

function ownFields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("COSMOS_DIRECT_SIGNING_RESPONSE_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length) throw new Error("COSMOS_DIRECT_SIGNING_RESPONSE_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) throw new Error("COSMOS_DIRECT_SIGNING_RESPONSE_INVALID");
    result[key] = descriptor.value;
  }
  return result;
}

function decimalAccount(value: unknown): string {
  let decimal: string;
  if (typeof value === "bigint" || typeof value === "string") decimal = String(value);
  else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) decimal = String(value);
  else {
    // Keplr returns Long. Read its primitive words; never invoke untrusted toString.
    const words = ownFields(value, ["low", "high", "unsigned"]);
    const { low, high, unsigned } = words;
    if (typeof low !== "number" || typeof high !== "number" || !Number.isInteger(low) || !Number.isInteger(high) || (low | 0) !== low || (high | 0) !== high || typeof unsigned !== "boolean" || (!unsigned && high < 0)) throw new Error("COSMOS_DIRECT_SIGNING_RESPONSE_INVALID");
    decimal = ((BigInt(high >>> 0) << 32n) + BigInt(low >>> 0)).toString();
  }
  if (!/^(0|[1-9][0-9]{0,19})$/.test(decimal) || BigInt(decimal) > 18446744073709551615n) throw new Error("COSMOS_DIRECT_SIGNING_RESPONSE_INVALID");
  return decimal;
}

function sameBytes(value: unknown, expected: Uint8Array): boolean { return value instanceof Uint8Array && value.length === expected.length && value.every((byte, i) => byte === expected[i]); }
function hex(bytes: Uint8Array): string { return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function concat(...parts: Uint8Array[]): Uint8Array { const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes; }
function byteField(field: number, bytes: Uint8Array): Uint8Array { const prefix = [field << 3 | 2]; let n = bytes.length; do { const byte = n & 127; n = Math.floor(n / 128); prefix.push(byte | (n ? 128 : 0)); } while (n); return concat(Uint8Array.from(prefix), bytes); }

function observe<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (action: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); action(); };
    const abort = () => finish(() => reject(new Error("COSMOS_DIRECT_SIGNING_CANCELLED")));
    const timer = setTimeout(() => finish(() => reject(new Error("COSMOS_DIRECT_SIGNING_TIMEOUT"))), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
  });
}
