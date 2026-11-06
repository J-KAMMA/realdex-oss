import { Interface, getAddress } from "ethers";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { assertBoundQuote, routeDescriptorFingerprint, routeRequestFingerprint } from "../routing/engine";
import type { RouteDescriptor, RouteQuote, RouteQuoteRequest } from "../routing/types";
import { assertCurrentV01Profile, assertV01Route, type VerifiedV01Profile } from "../release/v01-profile";
import { evmSwapRecoveryIdentity } from "../swap/evm-swap-recovery";
import { assertV01SendAttempt, type V01SendAttempt } from "./send-attempt";

/** Original recovery metadata captured before wallet IO, never an executable grant.
 * No wallet grant, key, RPC credential, receipt or submission claim is persisted here.
 * Local storage is not a signed audit log; restoring this does not authenticate it.
 */
export type V01RecoveryIntent = {
  schema: "realdex.v01-recovery-intent.v1";
  intentId: string; profileFingerprint: string;
  recoveryId: string; routeId: string; routeFingerprint: string; quoteId: string; requestFingerprint: string;
  accountId: string; recipient: string; sourceAsset: string; destinationAsset: string;
  amountInBaseUnits: string; minimumOutBaseUnits: string; poolAddress: string;
  quoteExpiresAt: number; approvalRequired: boolean; capturedAt: number;
};
const KEYS = ["schema", "intentId", "profileFingerprint", "recoveryId", "routeId", "routeFingerprint", "quoteId", "requestFingerprint", "accountId", "recipient", "sourceAsset", "destinationAsset", "amountInBaseUnits", "minimumOutBaseUnits", "poolAddress", "quoteExpiresAt", "approvalRequired", "capturedAt"];
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const fingerprint = (value: unknown) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const address = (value: unknown): value is string => { try { return typeof value === "string" && getAddress(value) === value; } catch { return false; } };
const positive = (value: unknown) => typeof value === "string" && /^[1-9]\d{0,77}$/.test(value) && BigInt(value) < 1n << 256n;
const token = (asset: string) => asset.slice("eip155:84532/erc20:".length);
function fail(): never { throw new Error("V01_RECOVERY_INTENT_INVALID"); }

export function assertV01RecoveryIntent(value: unknown): asserts value is V01RecoveryIntent {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(value, key))) fail();
  const item = value as V01RecoveryIntent;
  if (item.schema !== "realdex.v01-recovery-intent.v1" || !/^realdex-intent:v1:[0-9a-f-]{36}$/.test(item.intentId) || !bounded(item.intentId, 64) ||
      ![item.profileFingerprint, item.recoveryId, item.routeFingerprint, item.requestFingerprint].every(fingerprint) || !bounded(item.routeId, 800) || !bounded(item.quoteId, 800) ||
      !address(item.recipient) || item.accountId !== `eip155:84532:${item.recipient}` || !address(item.poolAddress) ||
      ![item.sourceAsset, item.destinationAsset].every(asset => typeof asset === "string" && /^eip155:84532\/erc20:0x[0-9a-f]{40}$/i.test(asset) && address(token(asset))) ||
      item.sourceAsset === item.destinationAsset || !positive(item.amountInBaseUnits) || !positive(item.minimumOutBaseUnits) || typeof item.approvalRequired !== "boolean" ||
      !Number.isSafeInteger(item.capturedAt) || item.capturedAt <= 0 || !Number.isSafeInteger(item.quoteExpiresAt) || item.quoteExpiresAt <= item.capturedAt || item.quoteExpiresAt - item.capturedAt > 600_000 ||
      item.recoveryId !== evmSwapRecoveryIdentity(item.routeFingerprint, item.requestFingerprint, item.quoteId)) fail();
}

export function createV01RecoveryIntent(profile: VerifiedV01Profile, route: RouteDescriptor, request: RouteQuoteRequest, quote: RouteQuote, now = Date.now()): V01RecoveryIntent {
  assertCurrentV01Profile(profile); assertV01Route(profile, route); assertBoundQuote(route, request, quote, now);
  if (request.sourceAsset !== route.sourceAsset || request.destinationAsset !== route.destinationAsset ||
      quote.expiresAt > profile.expiresAt ||
      request.accountId !== `eip155:84532:${request.recipient}` || quote.executionPreview.valueBaseUnits !== 0n ||
      (quote.authorization.type !== "none" && (quote.authorization.type !== "approval" || getAddress(quote.authorization.spender) !== getAddress(route.sourceExecutionTarget) || quote.authorization.amountBaseUnits !== request.amountInBaseUnits))) fail();
  const routeFingerprint = routeDescriptorFingerprint(route), requestFingerprint = routeRequestFingerprint(request);
  const result: V01RecoveryIntent = {
    schema: "realdex.v01-recovery-intent.v1", intentId: request.executionIntentId, profileFingerprint: profile.fingerprint,
    recoveryId: evmSwapRecoveryIdentity(routeFingerprint, requestFingerprint, quote.quoteId), routeId: route.id, routeFingerprint, quoteId: quote.quoteId, requestFingerprint,
    accountId: request.accountId, recipient: request.recipient, sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset,
    amountInBaseUnits: request.amountInBaseUnits.toString(), minimumOutBaseUnits: quote.minimumOutBaseUnits.toString(), poolAddress: getAddress(route.sourceExecutionTarget),
    quoteExpiresAt: quote.expiresAt, approvalRequired: quote.authorization.type === "approval", capturedAt: now
  };
  assertV01RecoveryIntent(result); return Object.freeze(result);
}

/** Historical metadata is allowed after quote expiry, but is not submission authority. */
export function assertV01RecoveryIntentProfile(intent: V01RecoveryIntent, profile: VerifiedV01Profile): void {
  assertV01RecoveryIntent(intent); assertCurrentV01Profile(profile);
  const route = profile.routes.find(item => item.id === intent.routeId);
  if (!route || intent.profileFingerprint !== profile.fingerprint || routeDescriptorFingerprint(route) !== intent.routeFingerprint ||
      route.sourceAsset !== intent.sourceAsset || route.destinationAsset !== intent.destinationAsset || getAddress(route.sourceExecutionTarget) !== intent.poolAddress) fail();
  assertV01Route(profile, route);
}

export function assertV01AttemptMatchesRecoveryIntent(attempt: V01SendAttempt, intent: V01RecoveryIntent): void {
  assertV01SendAttempt(attempt); assertV01RecoveryIntent(intent);
  const approval = attempt.role === "approval";
  const data = approval ? new Interface(ERC20_ABI).encodeFunctionData("approve", [intent.poolAddress, intent.amountInBaseUnits])
    : new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [token(intent.sourceAsset), intent.amountInBaseUnits, intent.minimumOutBaseUnits, intent.recipient, Math.floor(intent.quoteExpiresAt / 1000)]);
  if (attempt.intentId !== intent.intentId || attempt.quoteId !== intent.quoteId || attempt.profileFingerprint !== intent.profileFingerprint ||
      getAddress(attempt.transaction.from) !== intent.recipient || getAddress(attempt.transaction.to) !== (approval ? token(intent.sourceAsset) : intent.poolAddress) ||
      attempt.transaction.data.toLowerCase() !== data.toLowerCase() || (approval && !intent.approvalRequired)) throw new Error("V01_RECOVERY_ATTEMPT_MISMATCH");
}
