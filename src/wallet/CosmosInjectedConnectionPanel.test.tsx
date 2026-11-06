/** @vitest-environment jsdom */
import { ripemd160, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { secp256k1 } from "@noble/curves/secp256k1";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import CosmosInjectedConnectionPanel, { type CosmosInjectedProviderRegistration } from "./CosmosInjectedConnectionPanel";

type SyntheticKey = ReturnType<typeof key>;
type SyntheticProvider = {
  enable: ReturnType<typeof vi.fn>;
  getKey: ReturnType<typeof vi.fn>;
  currentKey: SyntheticKey;
  signReads: number;
  sendReads: number;
};

let root: Root | undefined;
let container: HTMLDivElement;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render(provider: SyntheticProvider, events = new EventTarget(), renderSelectedAccount?: Parameters<typeof CosmosInjectedConnectionPanel>[0]["renderSelectedAccount"]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const providers: CosmosInjectedProviderRegistration[] = [{ id: "synthetic:cosmos", name: "Synthetic Cosmos wallet", provider }];
  await act(async () => root?.render(<CosmosInjectedConnectionPanel providers={providers} eventTarget={events} renderSelectedAccount={renderSelectedAccount} />));
  return events;
}

function makeProvider(seed = 1): SyntheticProvider {
  const provider: SyntheticProvider = {
    currentKey: key(seed),
    enable: vi.fn(async () => undefined),
    getKey: vi.fn(async () => provider.currentKey),
    signReads: 0,
    sendReads: 0
  };
  Object.defineProperty(provider, "signDirect", { get: () => { provider.signReads += 1; throw new Error("signing must not be read"); } });
  Object.defineProperty(provider, "sendTx", { get: () => { provider.sendReads += 1; throw new Error("broadcast must not be read"); } });
  return provider;
}

function key(seed: number) {
  const privateKey = new Uint8Array(32);
  privateKey[31] = seed;
  const pubKey = secp256k1.getPublicKey(privateKey, true);
  const address = ripemd160(sha256(pubKey));
  return { name: `Account ${seed}`, algo: "secp256k1", pubKey, address, bech32Address: toBech32("osmo", address), isNanoLedger: false };
}

function button(name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === name);
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return result;
}

function select(label: string): HTMLSelectElement {
  const result = container.querySelector(`select[aria-label="${label}"]`);
  if (!(result instanceof HTMLSelectElement)) throw new Error(`Missing select: ${label}`);
  return result;
}

async function choose(control: HTMLSelectElement, value: string) {
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(control: HTMLButtonElement) {
  await act(async () => { control.click(); });
}

async function chooseWalletAndOsmosis() {
  await choose(select("Cosmos wallet provider"), "synthetic:cosmos");
  await choose(select("Cosmos connection network"), "cosmos:osmo-test-5");
}

describe("Cosmos injected connection panel", () => {
  it("provides review context only after explicit selection and removes it when forgotten", async () => {
    const provider = makeProvider(2);
    const review = vi.fn(({ binding }: { binding: { address: string } }) => <p data-review-context>{binding.address}</p>);
    await render(provider, new EventTarget(), review);
    await chooseWalletAndOsmosis(); await click(button("Request account access"));
    expect(review).not.toHaveBeenCalled();
    await click(button("Keep this account selection"));
    expect(container.querySelector("[data-review-context]")?.textContent).toBe(provider.currentKey.bech32Address);
    await click(button("Forget local connection"));
    expect(container.querySelector("[data-review-context]")).toBeNull();
    expect(provider.signReads).toBe(0); expect(provider.sendReads).toBe(0);
  });
  it("does not touch provider APIs before the explicit request", async () => {
    const provider = makeProvider();
    await render(provider);
    expect(provider.enable).not.toHaveBeenCalled();
    expect(provider.getKey).not.toHaveBeenCalled();
    expect(button("Request account access").disabled).toBe(true);
    await chooseWalletAndOsmosis();
    expect(button("Request account access").disabled).toBe(false);
    expect(provider.enable).not.toHaveBeenCalled();
    expect(provider.getKey).not.toHaveBeenCalled();
    expect(provider.signReads).toBe(0);
    expect(provider.sendReads).toBe(0);
  });

  it("requires a second explicit action to keep the validated account and never reads signing methods", async () => {
    const provider = makeProvider(2);
    await render(provider);
    await chooseWalletAndOsmosis();
    await click(button("Request account access"));
    await vi.waitFor(() => expect(provider.getKey).toHaveBeenCalledTimes(2));
    expect(provider.enable).toHaveBeenCalledWith("osmo-test-5");
    expect(container.textContent).toContain(`Account to select: ${provider.currentKey.bech32Address}`);
    expect(container.textContent).not.toContain("Selected account:");
    await click(button("Keep this account selection"));
    await vi.waitFor(() => expect(container.textContent).toContain(`Selected account: ${provider.currentKey.bech32Address}`));
    expect(container.textContent).toContain("Signing, submission and execution disabled");
    expect(provider.signReads).toBe(0);
    expect(provider.sendReads).toBe(0);
  });

  it("clears local state on network changes, keystore events and explicit forgetting", async () => {
    const provider = makeProvider(3);
    const events = await render(provider);
    await chooseWalletAndOsmosis();
    await click(button("Request account access"));
    await vi.waitFor(() => expect(container.textContent).toContain("Account to select:"));
    await choose(select("Cosmos connection network"), "cosmos:grand-1");
    expect(container.textContent).not.toContain("Account to select:");

    provider.currentKey = { ...key(4), bech32Address: toBech32("osmo", key(4).address) };
    await choose(select("Cosmos connection network"), "cosmos:osmo-test-5");
    await click(button("Request account access"));
    await vi.waitFor(() => expect(container.textContent).toContain("Account to select:"));
    events.dispatchEvent(new Event("keplr_keystorechange"));
    await click(button("Keep this account selection"));
    expect(container.textContent).toContain("Local connection expired or changed");
    expect(container.textContent).not.toContain("Selected account:");

    await click(button("Request account access"));
    await vi.waitFor(() => expect(container.textContent).toContain("Account to select:"));
    await click(button("Forget local connection"));
    expect(container.textContent).toContain("Wallet permissions were not revoked");
    expect(container.textContent).not.toContain("Account to select:");
  });

  it("stops waiting locally, ignores late success and keeps the raw request excluded until it settles", async () => {
    const provider = makeProvider(5);
    let release!: () => void;
    const raw = new Promise<void>(resolve => { release = resolve; });
    provider.enable = vi.fn(() => raw);
    await render(provider);
    await chooseWalletAndOsmosis();
    await click(button("Request account access"));
    await vi.waitFor(() => expect(provider.enable).toHaveBeenCalledOnce());
    await click(button("Stop waiting"));
    expect(container.textContent).toContain("does not cancel or revoke");
    await click(button("Request account access"));
    await vi.waitFor(() => expect(container.textContent).toContain("earlier wallet request is still pending"));
    expect(provider.enable).toHaveBeenCalledOnce();
    release();
    await raw;
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain("Account to select:");
  });

  it("maps a raw provider failure to safe copy without exposing the error", async () => {
    const provider = makeProvider(6);
    provider.enable = vi.fn(async () => { throw new Error("SECRET_PROVIDER_INTERNAL_DETAIL"); });
    await render(provider);
    await chooseWalletAndOsmosis();
    await click(button("Request account access"));
    await vi.waitFor(() => expect(container.textContent).toContain("Account access was not established"));
    expect(container.textContent).not.toContain("SECRET_PROVIDER_INTERNAL_DETAIL");
  });
});
