import { describe, expect, it } from "vitest";
import type { RouteDescriptor } from "../routing/types";
import { assertWalletGrant, assertWalletGrantSupportsRoute, createProviderBindingGrant, parseCaip25SessionGrant, walletGrantFingerprint } from "./capabilities";

const now = Date.now();
const account = "eip155:84532:0x1111111111111111111111111111111111111111";
const route: RouteDescriptor = {
  id: "scope-test", revision: 1, operation: "swap", adapterId: "test", sourceAsset: "eip155:84532/erc20:0x2222222222222222222222222222222222222222",
  destinationAsset: "eip155:84532/erc20:0x3333333333333333333333333333333333333333", state: "ready", walletCapabilityIds: ["eip1193"],
  sourceExecutionTarget: "0x4444444444444444444444444444444444444444", executionMethod: "swapExactIn", maximumQuoteTtlMs: 120_000,
  finalityTracking: "tracked", trustBoundary: "test", evidenceUrls: ["https://example.invalid"]
};

describe("wallet execution capability grants", () => {
  it("binds a local provider to one chain, account, method, notification set, and revision", () => {
    const grant = createProviderBindingGrant({ transportId: "eip6963:wallet-a", accountId: account, walletCapabilityId: "eip1193", sessionRevision: 7, expiresAt: now + 60_000 });
    expect(() => assertWalletGrantSupportsRoute(grant, route, account, "eip1193", 7, now)).not.toThrow();
    expect(() => assertWalletGrantSupportsRoute(grant, route, account.replace("1111", "9999"), "eip1193", 7, now)).toThrow("WALLET_GRANT_ACCOUNT_NOT_AUTHORIZED");
    expect(() => assertWalletGrantSupportsRoute(grant, route, account, "eip1193", 8, now)).toThrow("WALLET_GRANT_REVISION_CHANGED");
  });

  it("strictly accepts an exact chain-specific CAIP-25 granted scope", () => {
    const grant = parseCaip25SessionGrant({ sessionId: "session-1", scopes: { "eip155:84532": { accounts: [account], methods: ["eth_sendTransaction"], notifications: ["accountsChanged", "chainChanged"], capabilities: {} } }, properties: {} }, "caip25:topic", 3, now + 60_000);
    expect(grant.authority).toBe("caip25-session");
    expect(() => assertWalletGrantSupportsRoute(grant, route, account, "eip1193", 3, now)).not.toThrow();
  });

  it("rejects missing methods, notifications, expiry, unknown fields, and mismatched scopes", () => {
    const base = createProviderBindingGrant({ transportId: "eip6963:wallet-a", accountId: account, walletCapabilityId: "eip1193", sessionRevision: 1, expiresAt: now + 60_000 });
    expect(() => assertWalletGrantSupportsRoute({ ...base, scopes: [{ ...base.scopes[0], methods: ["personal_sign"] }] }, route, account, "eip1193", 1, now)).toThrow("WALLET_GRANT_METHOD_NOT_AUTHORIZED");
    expect(() => assertWalletGrantSupportsRoute({ ...base, scopes: [{ ...base.scopes[0], notifications: ["accountsChanged"] }] }, route, account, "eip1193", 1, now)).toThrow("WALLET_GRANT_NOTIFICATION_NOT_AUTHORIZED");
    expect(() => assertWalletGrant(base, now + 60_001)).toThrow("WALLET_GRANT_EXPIRED_OR_TOO_LONG");
    expect(() => parseCaip25SessionGrant({ sessionId: "x", scopes: { "eip155:84532": { accounts: [account], methods: ["eth_sendTransaction"], notifications: [], surprise: true } } }, "wc:x", 1, now + 60_000)).toThrow("WALLET_GRANT_UNKNOWN_FIELD");
    expect(() => parseCaip25SessionGrant({ sessionId: "x", scopes: { "eip155:1": { accounts: [account], methods: ["eth_sendTransaction"], notifications: [] } } }, "wc:x", 1, now + 60_000)).toThrow("WALLET_GRANT_ACCOUNT_SCOPE_MISMATCH");
  });

  it("changes the fingerprint when the selected provider changes", () => {
    const left = createProviderBindingGrant({ transportId: "eip6963:wallet-a", accountId: account, walletCapabilityId: "eip1193", sessionRevision: 1, expiresAt: now + 60_000 });
    const right = createProviderBindingGrant({ transportId: "eip6963:wallet-b", accountId: account, walletCapabilityId: "eip1193", sessionRevision: 1, expiresAt: now + 60_000 });
    expect(walletGrantFingerprint(left)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(walletGrantFingerprint(left)).not.toBe(walletGrantFingerprint(right));
    expect(walletGrantFingerprint({ ...left, scopes: [{ ...left.scopes[0], methods: [...left.scopes[0].methods].reverse(), notifications: [...left.scopes[0].notifications].reverse() }] })).toBe(walletGrantFingerprint(left));
  });
});
