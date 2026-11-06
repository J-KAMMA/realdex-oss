import { describe, expect, it } from "vitest";
import { initialWalletSession, parseEip1193ChainId, quoteRequestMatchesWallet, walletAccountId, walletSessionReducer } from "./session";
import type { RouteQuoteRequest } from "../routing/types";

describe("EIP-1193 wallet session state", () => {
  it("invalidates an existing account when the selected provider changes", () => {
    const connected = walletSessionReducer(initialWalletSession(true), { type: "connectionSucceeded", account: "0xabc", chainId: 31337n });
    const changed = walletSessionReducer(connected, { type: "providerChanged", available: true });
    expect(changed).toEqual({ status: "disconnected", revision: connected.revision + 1, reason: "provider-changed" });
    expect(walletSessionReducer(changed, { type: "providerChanged", available: false })).toEqual({ status: "unavailable", revision: changed.revision + 1, reason: "provider-missing" });
  });

  it("increments revision only when account or chain identity changes", () => {
    const disconnected = initialWalletSession(true);
    const connected = walletSessionReducer(disconnected, { type: "connectionSucceeded", account: "0xAbC", chainId: 31337n });
    expect(connected.revision).toBe(1);
    expect(walletSessionReducer(connected, { type: "accountsChanged", accounts: ["0xabc"] })).toBe(connected);
    const accountChanged = walletSessionReducer(connected, { type: "accountsChanged", accounts: ["0xdef"] });
    expect(accountChanged.revision).toBe(2);
    const chainChanged = walletSessionReducer(accountChanged, { type: "chainChanged", chainId: 1n });
    expect(chainChanged.revision).toBe(3);
  });

  it("disconnects and invalidates when the provider removes all accounts", () => {
    const connected = walletSessionReducer(initialWalletSession(true), { type: "connectionSucceeded", account: "0xabc", chainId: 31337n });
    expect(walletSessionReducer(connected, { type: "accountsChanged", accounts: [] })).toEqual({ status: "disconnected", revision: 2, reason: "account-removed" });
  });

  it("binds executable requests to exact account, chain, and session revision", () => {
    const session = walletSessionReducer(initialWalletSession(true), { type: "connectionSucceeded", account: "0xabc", chainId: 31337n });
    const request = { accountId: walletAccountId(session), sessionRevision: session.revision } as RouteQuoteRequest;
    expect(quoteRequestMatchesWallet(request, session)).toBe(true);
    expect(quoteRequestMatchesWallet({ ...request, sessionRevision: 0 }, session)).toBe(false);
  });

  it("invalidates quotes when negotiated authorization changes without changing account", () => {
    const connected = walletSessionReducer(initialWalletSession(true), { type: "connectionSucceeded", account: "0xabc", chainId: 31337n });
    const changed = walletSessionReducer(connected, { type: "authorizationChanged" });
    expect(changed).toEqual({ ...connected, revision: connected.revision + 1 });
  });

  it("fails closed on malformed chain notifications", () => {
    expect(parseEip1193ChainId("0x7a69")).toBe(31337n);
    expect(() => parseEip1193ChainId("31337")).toThrow("WALLET_CHAIN_ID_INVALID");
  });
});
