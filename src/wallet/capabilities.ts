import type { RouteDescriptor } from "../routing/types";
import { isCaip2 } from "../universe/registry";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";

export type WalletGrantAuthority = "local-provider-binding" | "caip25-session";

export type WalletScopeGrant = {
  scope: string;
  accounts: string[];
  methods: string[];
  notifications: string[];
};

export type WalletExecutionGrant = {
  schema: "localswap.wallet-grant.v1";
  authority: WalletGrantAuthority;
  transportId: string;
  sessionId: string;
  revision: number;
  expiresAt: number;
  scopes: WalletScopeGrant[];
};

type ProviderBindingInput = {
  transportId: string;
  accountId: string;
  walletCapabilityId: string;
  sessionRevision: number;
  expiresAt: number;
};

const REQUIRED_METHOD: Record<string, string> = {
  eip1193: "eth_sendTransaction",
  "solana-wallet-standard": "solana_signAndSendTransaction",
  "cosmos-injected": "cosmos_signDirect"
};

const REQUIRED_NOTIFICATIONS: Record<string, string[]> = {
  eip1193: ["accountsChanged", "chainChanged"],
  "solana-wallet-standard": [],
  "cosmos-injected": []
};

export function createProviderBindingGrant(input: ProviderBindingInput): WalletExecutionGrant {
  const scope = chainOfAccount(input.accountId);
  const method = REQUIRED_METHOD[input.walletCapabilityId];
  if (!method) throw new Error("WALLET_GRANT_CAPABILITY_UNSUPPORTED");
  const grant: WalletExecutionGrant = {
    schema: "localswap.wallet-grant.v1",
    authority: "local-provider-binding",
    transportId: input.transportId,
    sessionId: `local:${input.transportId}:${input.sessionRevision}`,
    revision: input.sessionRevision,
    expiresAt: input.expiresAt,
    scopes: [{ scope, accounts: [input.accountId], methods: [method], notifications: REQUIRED_NOTIFICATIONS[input.walletCapabilityId] }]
  };
  assertWalletGrant(grant);
  return grant;
}

export function parseCaip25SessionGrant(value: unknown, transportId: string, revision: number, expiresAt: number): WalletExecutionGrant {
  if (!isPlainObject(value)) throw new Error("CAIP25_RESPONSE_INVALID");
  assertExactKeys(value, ["sessionId", "scopes", "properties"]);
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !value.sessionId.trim())) throw new Error("CAIP25_SESSION_ID_INVALID");
  if (!isPlainObject(value.scopes) || Object.keys(value.scopes).length === 0 || Object.keys(value.scopes).length > 32) throw new Error("CAIP25_SCOPES_INVALID");
  const scopes: WalletScopeGrant[] = [];
  for (const [scope, raw] of Object.entries(value.scopes)) {
    if (!isCaip2(scope) || !isPlainObject(raw)) throw new Error("CAIP25_SCOPE_INVALID");
    assertExactKeys(raw, ["accounts", "methods", "notifications", "capabilities"]);
    scopes.push({
      scope,
      accounts: strictStrings(raw.accounts, "CAIP25_ACCOUNTS_INVALID"),
      methods: strictStrings(raw.methods, "CAIP25_METHODS_INVALID"),
      notifications: strictStrings(raw.notifications, "CAIP25_NOTIFICATIONS_INVALID", true)
    });
  }
  const grant: WalletExecutionGrant = {
    schema: "localswap.wallet-grant.v1", authority: "caip25-session", transportId,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : `caip25:${transportId}:${revision}`, revision, expiresAt, scopes
  };
  assertWalletGrant(grant);
  return grant;
}

export function assertWalletGrant(grant: WalletExecutionGrant, now = Date.now()): void {
  if (!isPlainObject(grant)) throw new Error("WALLET_GRANT_INVALID");
  assertExactKeys(grant, ["schema", "authority", "transportId", "sessionId", "revision", "expiresAt", "scopes"]);
  if (grant.schema !== "localswap.wallet-grant.v1") throw new Error("WALLET_GRANT_SCHEMA_INVALID");
  if (grant.authority !== "local-provider-binding" && grant.authority !== "caip25-session") throw new Error("WALLET_GRANT_AUTHORITY_INVALID");
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(grant.transportId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(grant.sessionId)) throw new Error("WALLET_GRANT_SESSION_INVALID");
  if (!Number.isInteger(grant.revision) || grant.revision < 0) throw new Error("WALLET_GRANT_REVISION_INVALID");
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now || grant.expiresAt > now + 10 * 60_000) throw new Error("WALLET_GRANT_EXPIRED_OR_TOO_LONG");
  if (!Array.isArray(grant.scopes) || grant.scopes.length === 0 || grant.scopes.length > 32) throw new Error("WALLET_GRANT_SCOPES_INVALID");
  const seen = new Set<string>();
  for (const scope of grant.scopes) {
    if (!isPlainObject(scope)) throw new Error("WALLET_GRANT_SCOPE_INVALID");
    assertExactKeys(scope, ["scope", "accounts", "methods", "notifications"]);
    if (!isCaip2(scope.scope) || seen.has(scope.scope)) throw new Error("WALLET_GRANT_SCOPE_INVALID");
    seen.add(scope.scope);
    strictStrings(scope.accounts, "WALLET_GRANT_ACCOUNTS_INVALID");
    strictStrings(scope.methods, "WALLET_GRANT_METHODS_INVALID");
    strictStrings(scope.notifications, "WALLET_GRANT_NOTIFICATIONS_INVALID", true);
    if (scope.accounts.some((account) => !isCaip10(account) || chainOfAccount(account) !== scope.scope)) throw new Error("WALLET_GRANT_ACCOUNT_SCOPE_MISMATCH");
  }
}

export function assertWalletGrantSupportsRoute(grant: WalletExecutionGrant, route: RouteDescriptor, accountId: string, walletCapabilityId: string, sessionRevision: number, now = Date.now()): void {
  assertWalletGrant(grant, now);
  if (grant.revision !== sessionRevision) throw new Error("WALLET_GRANT_REVISION_CHANGED");
  if (!route.walletCapabilityIds.includes(walletCapabilityId)) throw new Error("WALLET_CAPABILITY_UNSUPPORTED");
  const requiredMethod = REQUIRED_METHOD[walletCapabilityId];
  if (!requiredMethod) throw new Error("WALLET_GRANT_CAPABILITY_UNSUPPORTED");
  const chain = chainOfAccount(accountId);
  const scope = grant.scopes.find((candidate) => candidate.scope === chain);
  if (!scope) throw new Error("WALLET_GRANT_CHAIN_NOT_AUTHORIZED");
  const evm = chain.startsWith("eip155:");
  if (!scope.accounts.some((candidate) => evm ? candidate.toLowerCase() === accountId.toLowerCase() : candidate === accountId)) throw new Error("WALLET_GRANT_ACCOUNT_NOT_AUTHORIZED");
  if (!scope.methods.includes(requiredMethod)) throw new Error("WALLET_GRANT_METHOD_NOT_AUTHORIZED");
  if (REQUIRED_NOTIFICATIONS[walletCapabilityId].some((notification) => !scope.notifications.includes(notification))) throw new Error("WALLET_GRANT_NOTIFICATION_NOT_AUTHORIZED");
}

export function walletGrantFingerprint(grant: WalletExecutionGrant): string {
  return cryptographicFingerprint("realdex.wallet-execution-grant.v2", {
    schema: grant.schema, authority: grant.authority, transportId: grant.transportId, sessionId: grant.sessionId,
    revision: grant.revision, expiresAt: grant.expiresAt,
    scopes: grant.scopes.slice().sort((a, b) => a.scope.localeCompare(b.scope)).map((scope) => ({
      scope: scope.scope, accounts: scope.accounts.slice().sort(), methods: scope.methods.slice().sort(), notifications: scope.notifications.slice().sort()
    }))
  });
}

function isCaip10(value: string): boolean {
  const split = value.lastIndexOf(":");
  return split > 0 && isCaip2(value.slice(0, split)) && /^[-.%a-zA-Z0-9]{1,128}$/.test(value.slice(split + 1));
}

function chainOfAccount(accountId: string): string {
  const split = accountId.lastIndexOf(":");
  const chain = split > 0 ? accountId.slice(0, split) : "";
  if (!isCaip2(chain) || !isCaip10(accountId)) throw new Error("WALLET_GRANT_ACCOUNT_INVALID");
  return chain;
}

function strictStrings(value: unknown, code: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 64 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200) || new Set(value).size !== value.length) throw new Error(code);
  return value.slice();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key) || key === "__proto__" || key === "constructor" || key === "prototype")) throw new Error("WALLET_GRANT_UNKNOWN_FIELD");
}
