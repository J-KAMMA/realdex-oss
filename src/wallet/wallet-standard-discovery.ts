import { connectSolanaWalletStandard, createGenuineSolanaStandardConnectionFacade, type SolanaStandardConnection } from "./solana-standard-session";

// Discovery metadata is self-reported, never a wallet grant or execution capability.
export type WalletStandardEntry = {
  id: string;
  name: string;
  chains: string[];
  features: string[];
  changes: "subscribed" | "unavailable";
  executionEnabled: false;
};

export type WalletStandardDiscoverySnapshot = {
  status: "listening" | "unavailable";
  revision: number;
  rejected: number;
  wallets: WalletStandardEntry[];
};

type RecordEntry = {
  wallet: object;
  entry: WalletStandardEntry;
  events: unknown;
  eventOn?: unknown;
  unsubscribe?: () => void;
  requests: Set<AbortController>;
  connections: Set<SolanaStandardConnection>;
};

export type WalletStandardDiscoveryController = (() => void) & {
  connectSolana(id: string, chainId: string, options?: { signal?: AbortSignal }): Promise<SolanaStandardConnection>;
};

/** Page-local registry. No provider, account, icon, or transaction is exposed. */
export function startWalletStandardDiscovery(target: Window, onChange: (snapshot: WalletStandardDiscoverySnapshot) => void): WalletStandardDiscoveryController {
  let active = true;
  let status: WalletStandardDiscoverySnapshot["status"] = "listening";
  let revision = 0;
  let rejected = 0;
  let nextId = 0;
  const ids = new WeakMap<object, string>();
  const records = new Map<object, RecordEntry>();
  const publish = () => {
    if (!active) return;
    onChange({ status, revision: ++revision, rejected, wallets: [...records.values()].map(({ entry }) => ({ ...entry, chains: [...entry.chains], features: [...entry.features] })) });
  };
  const reject = () => { rejected = Math.min(10_000, rejected + 1); };
  const detach = (record: RecordEntry) => {
    for (const request of record.requests) request.abort();
    record.requests.clear();
    for (const connection of record.connections) connection.dispose();
    record.connections.clear();
    const unsubscribe = record.unsubscribe;
    record.unsubscribe = undefined;
    try { unsubscribe?.(); } catch { /* Untrusted cleanup cannot interrupt registry cleanup. */ }
  };
  const remove = (record: RecordEntry) => {
    if (records.get(record.wallet) !== record) return;
    records.delete(record.wallet);
    detach(record);
  };

  const register = (...wallets: unknown[]) => {
    const added: RecordEntry[] = [];
    if (!active || status !== "listening") return () => {};
    for (const wallet of wallets.slice(0, 32)) {
      if (typeof wallet === "object" && wallet !== null && records.has(wallet)) continue;
      if (records.size >= 32) { reject(); continue; }
      try {
        const metadata = readMetadata(wallet);
        const object = wallet as object;
        const id = ids.get(object) ?? `standard-wallet-${++nextId}`;
        ids.set(object, id);
        const record: RecordEntry = { wallet: object, events: metadata.events, requests: new Set(), connections: new Set(), entry: { id, ...metadata.entry, changes: "unavailable", executionEnabled: false } };
        records.set(object, record);
        added.push(record);
        const events = metadata.events;
        try {
          if (isObject(events) && events.version === "1.0.0" && typeof events.on === "function") {
            const on = events.on;
            record.eventOn = on;
            const unsubscribe: unknown = on.call(events, "change", () => {
              if (!active || records.get(object) !== record) return;
              try {
                const current = readMetadata(object);
                // A replaced event interface needs a new registration, not stale liveness.
                if (!isObject(current.events) || current.events.version !== "1.0.0" || current.events.on !== record.eventOn) throw new Error("EVENT_INTERFACE_CHANGED");
                record.entry = { ...record.entry, ...current.entry };
              } catch { remove(record); reject(); }
              publish();
            });
            if (typeof unsubscribe === "function") {
              if (records.get(object) === record && active) {
                record.unsubscribe = unsubscribe as () => void;
                record.entry.changes = "subscribed";
              } else {
                try { unsubscribe(); } catch { /* Registration was invalidated synchronously. */ }
              }
            }
          }
        } catch { record.entry.changes = "unavailable"; }
      } catch { reject(); }
    }
    if (wallets.length > 32) reject();
    publish();
    let unregistered = false;
    return () => {
      if (!active || unregistered) return;
      unregistered = true;
      for (const record of added) remove(record);
      publish();
    };
  };

  const api = Object.freeze({ register });
  const announced = (event: Event) => {
    if (!active || status !== "listening") return;
    try {
      const callback: unknown = (event as CustomEvent).detail;
      if (typeof callback !== "function") throw new Error("INVALID_REGISTRATION");
      callback(api);
    } catch { reject(); publish(); }
  };
  const stop = () => {
    if (!active) return;
    active = false;
    try { target.removeEventListener("wallet-standard:register-wallet", announced); } catch { /* Best-effort host cleanup. */ }
    const previous = [...records.values()];
    records.clear();
    for (const record of previous) detach(record);
  };
  try {
    target.addEventListener("wallet-standard:register-wallet", announced);
    // Listener first supports wallets loaded before or after the application.
    target.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } catch {
    status = "unavailable";
    try { target.removeEventListener("wallet-standard:register-wallet", announced); } catch { /* Host unavailable. */ }
    const previous = [...records.values()];
    records.clear();
    for (const record of previous) detach(record);
  }
  publish();
  return Object.assign(stop, {
    async connectSolana(id: string, chainId: string, options: { signal?: AbortSignal } = {}): Promise<SolanaStandardConnection> {
      const record = [...records.values()].find(item => item.entry.id === id);
      if (!active || !record || status !== "listening") throw new Error("SOLANA_STANDARD_REGISTRATION_UNAVAILABLE");
      const abort = new AbortController();
      const cancel = () => abort.abort();
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      record.requests.add(abort);
      const current = () => active && records.get(record.wallet) === record;
      try {
        // Keep a cancellation boundary before any untrusted provider getter or method.
        await Promise.resolve();
        if (!current() || abort.signal.aborted) throw new Error("SOLANA_STANDARD_CONNECTION_CANCELLED");
        const connection = await connectSolanaWalletStandard(record.wallet, { walletId: id, chainId }, { signal: abort.signal });
        if (!current() || abort.signal.aborted) { connection.dispose(); throw new Error("SOLANA_STANDARD_CONNECTION_CANCELLED"); }
        let facade!: SolanaStandardConnection;
        facade = createGenuineSolanaStandardConnectionFacade(connection, () => record.connections.delete(facade));
        record.connections.add(facade);
        return facade;
      } finally {
        record.requests.delete(abort);
        options.signal?.removeEventListener("abort", cancel);
      }
    }
  });
}

function readMetadata(wallet: unknown): { entry: Pick<WalletStandardEntry, "name" | "chains" | "features">; events: unknown } {
  if (!isObject(wallet) || wallet.version !== "1.0.0") throw new Error("WALLET_VERSION_INVALID");
  const name = wallet.name;
  if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new Error("WALLET_NAME_INVALID");
  const chains = identifiers(wallet.chains);
  const features = wallet.features;
  if (!isObject(features)) throw new Error("WALLET_FEATURES_INVALID");
  const names = identifiers(Object.keys(features));
  // Do not inspect feature implementations except the non-authorizing change subscription.
  const events = Object.prototype.hasOwnProperty.call(features, "standard:events") ? features["standard:events"] : undefined;
  return { entry: { name: name.trim(), chains, features: names }, events };
}

function identifiers(value: unknown): string[] {
  // Wallet Standard identifiers are NOT necessarily CAIP-2 chain identities.
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string" || item.length > 160 || !/^[^\s:]+:[^\s]+$/u.test(item) || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(item)) || new Set(value).size !== value.length) throw new Error("WALLET_IDENTIFIERS_INVALID");
  return value.slice().sort();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
