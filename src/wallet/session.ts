import type { RouteQuoteRequest } from "../routing/types";

export type WalletSessionState =
  | { status: "unavailable"; revision: number; reason: "provider-missing" }
  | { status: "disconnected"; revision: number; reason: "initial" | "account-removed" | "provider-disconnected" | "provider-changed" }
  | { status: "connected"; revision: number; account: string; chainId: bigint };

export type WalletSessionEvent =
  | { type: "providerDetected" }
  | { type: "providerChanged"; available: boolean }
  | { type: "connectionSucceeded"; account: string; chainId: bigint }
  | { type: "accountsChanged"; accounts: string[] }
  | { type: "chainChanged"; chainId: bigint }
  | { type: "authorizationChanged" }
  | { type: "providerDisconnected" };

export function initialWalletSession(providerAvailable: boolean): WalletSessionState {
  return providerAvailable
    ? { status: "disconnected", revision: 0, reason: "initial" }
    : { status: "unavailable", revision: 0, reason: "provider-missing" };
}

export function walletSessionReducer(state: WalletSessionState, event: WalletSessionEvent): WalletSessionState {
  switch (event.type) {
    case "providerDetected":
      return state.status === "unavailable" ? { status: "disconnected", revision: state.revision + 1, reason: "initial" } : state;
    case "providerChanged":
      return event.available
        ? { status: "disconnected", revision: state.revision + 1, reason: state.status === "unavailable" ? "initial" : "provider-changed" }
        : { status: "unavailable", revision: state.revision + 1, reason: "provider-missing" };
    case "connectionSucceeded":
      if (!event.account.trim()) return { status: "disconnected", revision: state.revision + 1, reason: "account-removed" };
      if (state.status === "connected" && sameAddress(state.account, event.account) && state.chainId === event.chainId) return state;
      return { status: "connected", revision: state.revision + 1, account: event.account, chainId: event.chainId };
    case "accountsChanged": {
      const account = event.accounts[0];
      if (!account) return state.status === "disconnected" && state.reason === "account-removed" ? state : { status: "disconnected", revision: state.revision + 1, reason: "account-removed" };
      if (state.status !== "connected") return state;
      if (sameAddress(state.account, account)) return state;
      return { ...state, account, revision: state.revision + 1 };
    }
    case "chainChanged":
      if (state.status !== "connected" || state.chainId === event.chainId) return state;
      return { ...state, chainId: event.chainId, revision: state.revision + 1 };
    case "authorizationChanged":
      return state.status === "connected" ? { ...state, revision: state.revision + 1 } : state;
    case "providerDisconnected":
      return state.status === "disconnected" && state.reason === "provider-disconnected" ? state : { status: "disconnected", revision: state.revision + 1, reason: "provider-disconnected" };
  }
}

export function walletAccountId(state: WalletSessionState): string | null {
  return state.status === "connected" ? `eip155:${state.chainId}:${state.account}` : null;
}

export function quoteRequestMatchesWallet(request: RouteQuoteRequest, state: WalletSessionState): boolean {
  const accountId = walletAccountId(state);
  return Boolean(accountId && accountId.toLowerCase() === request.accountId.toLowerCase() && request.sessionRevision === state.revision);
}

export function parseEip1193ChainId(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("WALLET_CHAIN_ID_INVALID");
  return BigInt(value);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
