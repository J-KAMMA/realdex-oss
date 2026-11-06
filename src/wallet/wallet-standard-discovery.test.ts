/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { startWalletStandardDiscovery, type WalletStandardDiscoverySnapshot } from "./wallet-standard-discovery";

type RegistrationApi = {
  register: (...wallets: unknown[]) => () => void;
};

type StandardEvents = {
  version: "1.0.0";
  on: (event: "change", callback: (payload: unknown) => void) => () => void;
  callback?: (payload: unknown) => void;
  unsubscribed?: boolean;
};

const stops: Array<() => void> = [];

afterEach(() => {
  while (stops.length) stops.pop()?.();
});

function wallet(name: string, chains: string[] = ["eip155:1"], features: Record<string, unknown> = {}) {
  return { version: "1.0.0", name, chains, features };
}

function startWithAppReadyWallet(wallets: unknown[], snapshots: WalletStandardDiscoverySnapshot[]) {
  const onReady = (event: Event) => {
    const api = (event as CustomEvent<RegistrationApi>).detail;
    api.register(...wallets);
  };
  window.addEventListener("wallet-standard:app-ready", onReady, { once: true });
  const stop = startWalletStandardDiscovery(window, (snapshot) => snapshots.push(snapshot));
  stops.push(stop);
  return stop;
}

function registerLate(...wallets: unknown[]) {
  let register: RegistrationApi["register"] | undefined;
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", {
    detail: (api: RegistrationApi) => { register = api.register; }
  }));
  expect(register).toBeTypeOf("function");
  return register!(...wallets);
}

function latest(snapshots: WalletStandardDiscoverySnapshot[]) {
  return snapshots.at(-1)!;
}

describe("Wallet Standard discovery", () => {
  it("discovers an early app-ready wallet and a later register-wallet wallet", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    const early = wallet("Early", ["eip155:1"], { "solana:signTransaction": {} });
    const late = wallet("Late", ["solana:mainnet"]);

    startWithAppReadyWallet([early], snapshots);
    registerLate(late);

    expect(latest(snapshots)).toMatchObject({
      status: "listening",
      rejected: 0,
      wallets: [
        { name: "Early", chains: ["eip155:1"], features: ["solana:signTransaction"], changes: "unavailable", executionEnabled: false },
        { name: "Late", chains: ["solana:mainnet"], features: [], changes: "unavailable", executionEnabled: false }
      ]
    });
  });

  it("deduplicates the same object but keeps distinct objects with the same name", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    startWithAppReadyWallet([], snapshots);
    const first = wallet("Same name");
    const second = wallet("Same name");
    registerLate(first, first, second);

    const entries = latest(snapshots).wallets;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.name)).toEqual(["Same name", "Same name"]);
    expect(entries[0].id).not.toBe(entries[1].id);
  });

  it("unregisters only its registration and ignores stale callbacks after unregister or stop", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    let staleApi!: RegistrationApi;
    window.addEventListener("wallet-standard:app-ready", (event) => {
      staleApi = (event as CustomEvent<RegistrationApi>).detail;
    }, { once: true });
    startWithAppReadyWallet([], snapshots);
    const first = wallet("First");
    const secondEvents: StandardEvents = {
      version: "1.0.0",
      on: (_event, callback) => {
        secondEvents.callback = callback;
        return () => undefined;
      }
    };
    const second = wallet("Second", ["eip155:1"], { "standard:events": secondEvents });
    let firstUnregister!: () => void;
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", {
      detail: (api: RegistrationApi) => { firstUnregister = api.register(first); }
    }));
    let unregister!: () => void;
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", {
      detail: (api: RegistrationApi) => { unregister = api.register(first, second); }
    }));
    expect(latest(snapshots).wallets).toHaveLength(2);

    unregister();
    expect(latest(snapshots).wallets.map((entry) => entry.name)).toEqual(["First"]);
    const staleChange = secondEvents.callback!;
    const countAfterSecondUnregister = snapshots.length;
    staleChange({ chains: ["eip155:999"] });
    expect(snapshots).toHaveLength(countAfterSecondUnregister);

    const newUnregister = registerLate(second);
    expect(latest(snapshots).wallets.map((entry) => entry.name)).toEqual(["First", "Second"]);
    const countBeforeOldUnregister = snapshots.length;
    unregister();
    expect(snapshots).toHaveLength(countBeforeOldUnregister);
    expect(latest(snapshots).wallets.map((entry) => entry.name)).toEqual(["First", "Second"]);
    newUnregister();
    expect(latest(snapshots).wallets.map((entry) => entry.name)).toEqual(["First"]);

    const countAfterUnregister = snapshots.length;
    unregister();
    expect(snapshots).toHaveLength(countAfterUnregister);
    firstUnregister();
    expect(latest(snapshots).wallets).toEqual([]);

    const stale = wallet("Stale");
    let staleUnregister!: () => void;
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", {
      detail: (api: RegistrationApi) => { staleUnregister = api.register(stale); }
    }));
    const stop = stops[0];
    stop();
    const countAfterStop = snapshots.length;
    staleUnregister();
    staleApi.register(wallet("Also too late"));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", {
      detail: (api: RegistrationApi) => { api.register(wallet("Too late")); }
    }));
    expect(snapshots).toHaveLength(countAfterStop);
    expect(latest(snapshots).wallets.map((entry) => entry.name)).toEqual(["Stale"]);
  });

  it("subscribes to standard:events and rereads public metadata instead of the change payload", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    const events: StandardEvents = {
      version: "1.0.0",
      on: (_event, callback) => {
        events.callback = callback;
        return () => { events.unsubscribed = true; };
      }
    };
    const changing = wallet("Changing", ["eip155:1"], { "standard:events": events, "eip155:sendTransaction": {} });
    startWithAppReadyWallet([changing], snapshots);
    expect(latest(snapshots).wallets[0]).toMatchObject({ chains: ["eip155:1"], changes: "subscribed" });

    changing.chains = ["eip155:10"];
    events.callback!({ chains: ["this payload must be ignored"], name: "Payload name" });
    expect(latest(snapshots).wallets[0]).toMatchObject({ name: "Changing", chains: ["eip155:10"], changes: "subscribed" });

    stops[0]();
    expect(events.unsubscribed).toBe(true);
  });

  it("removes a wallet when its standard:events interface is replaced", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    const events: StandardEvents = {
      version: "1.0.0",
      on: (_event, callback) => {
        events.callback = callback;
        return () => undefined;
      }
    };
    const changing = wallet("Replace events", ["eip155:1"], { "standard:events": events });
    startWithAppReadyWallet([changing], snapshots);
    expect(latest(snapshots).wallets).toHaveLength(1);
    const rejectedBefore = latest(snapshots).rejected;

    const replacement: StandardEvents = {
      version: "1.0.0",
      on: () => () => undefined
    };
    changing.features = { "standard:events": replacement };
    events.callback!({});
    expect(latest(snapshots)).toMatchObject({ wallets: [], rejected: rejectedBefore + 1 });
  });

  it("rejects invalid announcements, including throwing metadata getters, without throwing", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    startWithAppReadyWallet([], snapshots);
    const invalid = [
      null,
      { version: "2.0.0", name: "Wrong version", chains: [], features: {} },
      wallet("", ["eip155:1"]),
      wallet("Bad chain", ["not-a-chain"])
    ];

    expect(() => registerLate(...invalid)).not.toThrow();
    expect(latest(snapshots).wallets).toEqual([]);
    expect(latest(snapshots).rejected).toBe(4);

    const throwing = Object.defineProperties({}, {
      version: { get: () => { throw new Error("version getter"); } },
      name: { value: "Never accepted" },
      chains: { value: ["eip155:1"] },
      features: { value: {} }
    });
    expect(() => registerLate(throwing)).not.toThrow();
    expect(latest(snapshots).rejected).toBe(5);
    expect(latest(snapshots).wallets).toEqual([]);
  });

  it("reads only v1 public metadata and never touches accounts, icons, or execution methods", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    let connectCalls = 0;
    let signCalls = 0;
    const features = {
      "solana:connect": () => { connectCalls += 1; },
      "solana:signTransaction": () => { signCalls += 1; }
    };
    const guarded = Object.defineProperties(wallet("Guarded", ["solana:mainnet"], features), {
      accounts: { get: () => { throw new Error("accounts must not be read"); } },
      icon: { get: () => { throw new Error("icon must not be read"); } }
    });

    startWithAppReadyWallet([guarded], snapshots);
    expect(latest(snapshots)).toMatchObject({ rejected: 0, wallets: [{ name: "Guarded", features: ["solana:connect", "solana:signTransaction"], executionEnabled: false }] });
    expect(connectCalls).toBe(0);
    expect(signCalls).toBe(0);
  });

  it("enforces 32-wallet, 64-chain, and 64-feature-key caps", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    startWithAppReadyWallet([], snapshots);
    const wallets = Array.from({ length: 33 }, (_, index) => wallet(`Wallet ${index}`, [`eip155:${index + 1}`]));
    const fullUnregister = registerLate(...wallets);
    expect(latest(snapshots).wallets).toHaveLength(32);
    expect(latest(snapshots).rejected).toBeGreaterThanOrEqual(1);
    fullUnregister();
    expect(latest(snapshots).wallets).toEqual([]);

    const tooManyChains = wallet("Too many chains", Array.from({ length: 65 }, (_, index) => `eip155:${index + 1}`));
    const tooManyFeatures = wallet("Too many features", [], Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`feature:${index}`, {}])));
    const before = latest(snapshots).rejected;
    expect(() => registerLate(tooManyChains, tooManyFeatures)).not.toThrow();
    expect(latest(snapshots).wallets).toEqual([]);
    expect(latest(snapshots).rejected).toBe(before + 2);

    const exactlyAtCaps = wallet("At caps", Array.from({ length: 64 }, (_, index) => `eip155:${index + 1}`), Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`feature:${index}`, {}])));
    const secondSnapshots: WalletStandardDiscoverySnapshot[] = [];
    startWithAppReadyWallet([exactlyAtCaps], secondSnapshots);
    expect(latest(secondSnapshots).wallets[0]).toMatchObject({ chains: expect.arrayContaining(["eip155:1", "eip155:64"]), features: expect.arrayContaining(["feature:0", "feature:63"]) });
  });

  it("reports unavailable when listener registration fails", () => {
    const snapshots: WalletStandardDiscoverySnapshot[] = [];
    const unavailableTarget = {
      addEventListener: () => { throw new Error("listener unavailable"); },
      removeEventListener: () => undefined,
      dispatchEvent: () => true
    } as unknown as Window;

    const stop = startWalletStandardDiscovery(unavailableTarget, (snapshot) => snapshots.push(snapshot));
    expect(latest(snapshots)).toMatchObject({ status: "unavailable", rejected: 0, wallets: [] });
    stop();
  });
});
