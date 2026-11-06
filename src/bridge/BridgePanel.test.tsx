/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import BridgePanel from "./BridgePanel";
import { createRouteFinalityRecord, persistRouteFinality, reserveRouteFinality } from "../routing/finality";
import { routeDescriptorFingerprint } from "../routing/engine";
import { ROUTE_DESCRIPTORS } from "../routing/registry";
import type { RouteQuote } from "../routing/types";
import { BASE_SEPOLIA_CCTP_ASSET } from "./cctp-asset-release";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => localStorage.clear());
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; container?.remove(); container = undefined;
});

describe("BridgePanel recipient field", () => {
  // Changing the route keeps whatever was typed. An address for the previous
  // destination then sits in a field labelled "exact" with nothing to say it no
  // longer fits, and the action is refused with a reason about something else.
  const setValue = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const chooseRoute = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  };

  it("says what is wrong when the route changes under a recipient that no longer fits", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<BridgePanel evmProviderId={null} evmWalletCapabilityId="eip1193" />); await Promise.resolve(); });

    const inputs = [...container.querySelectorAll("input")] as HTMLInputElement[];
    const recipient = inputs.find((input) => (input.closest("label")?.textContent ?? "").includes("destination recipient"))!;
    const preset = container.querySelector(".bridge-preset select") as HTMLSelectElement;

    // Nothing typed yet: the field does not complain before it has been used.
    expect(container.querySelector(".field-problem")).toBeNull();

    await act(async () => { setValue(recipient, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"); await Promise.resolve(); });
    await chooseRoute(preset, "base-to-solana");
    expect(container.querySelector(".field-problem")).toBeNull();

    // Same address, EVM destination.
    await chooseRoute(preset, "base-to-arbitrum");
    expect(container.querySelector(".field-problem")?.textContent).toBe("Enter a valid EVM recipient address.");
    expect(recipient.getAttribute("aria-invalid")).toBe("true");

    await act(async () => { setValue(recipient, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"); await Promise.resolve(); });
    expect(container.querySelector(".field-problem")).toBeNull();
    expect(recipient.getAttribute("aria-invalid")).toBeNull();

    // And an EVM address on an IBC route names the prefix it wants.
    await chooseRoute(preset, "noble-to-osmosis");
    expect(container.querySelector(".field-problem")?.textContent).toBe("Enter an exact osmo bech32 recipient address.");
  });
});

describe("BridgePanel finality recovery", () => {
  it("keeps CCTP disabled after a read-only two-RPC asset quorum observation", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<BridgePanel evmProviderId={null} evmWalletCapabilityId="eip1193" cctpAssetVerifier={async () => ({
      status: "quorum-observed", asset: BASE_SEPOLIA_CCTP_ASSET, observedAt: 1234, executionEnabled: false, releaseApprovalRequired: true,
      observations: ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"].map((readerId) => ({ readerId, observedBlock: 100, proxyCodeHash: `0x${"1".repeat(64)}`, implementationAddress: "0xd74Cc5D436923b8bA2C1794bBca2841d8a52c5b5", implementationCodeHash: `0x${"2".repeat(64)}`, name: "USDC", symbol: "USDC", decimals: 6 }))
    })} />); await Promise.resolve(); });
    expect(container.textContent).toContain("CCTP release review required");
    expect(container.textContent).toContain("Automatic re-enabling is forbidden");
    expect(container.textContent).toContain("A matching result cannot enable execution");
    const primary = container.querySelector("button.primary-button") as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    const recheck = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Recheck current USDC identity"))!;
    await act(async () => { recheck.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
    expect(container.textContent).toContain("Current asset quorum observed · execution still disabled");
    expect(container.textContent).toContain("explicit release approval required");
    expect(primary.disabled).toBe(true);
  });

  it("restores only the selected route record and explains that destination submission is not finality", async () => {
    const route = ROUTE_DESCRIPTORS.find((candidate) => candidate.id === "cctp-v2-base-sepolia-solana-devnet-usdc")!;
    const now = Date.now();
    const sourceTx = `0x${"a".repeat(64)}`;
    const record = createRouteFinalityRecord({
      executionId: "test-operation",
      quoteId: "test-quote",
      routeId: route.id,
      routeFingerprint: routeDescriptorFingerprint(route),
      provider: "Circle test",
      stage: "destination-submitted",
      cursor: { protocol: "cctp-v2", sourceDomain: 6, destinationDomain: 5, sourceTxCandidates: [sourceTx] },
      evidence: [{ kind: "destination-tx", id: "B".repeat(64), observedAt: now, url: "https://example.invalid/destination" }]
    }, now);
    expect(persistRouteFinality(record, route)).toBe(true);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<BridgePanel evmProviderId={null} evmWalletCapabilityId="eip1193" />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Destination transaction submitted");
    expect(container.textContent).toContain("a hash alone is not independent finality proof");
    expect(container.textContent).toContain("Check destination status");
    expect(container.textContent).toContain("Created with transaction inputs");

    const routeSelect = container.querySelector(".bridge-preset select") as HTMLSelectElement;
    await act(async () => {
      routeSelect.value = "noble-to-osmosis";
      routeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Destination transaction submitted");
  });

  it("shows provider-reported CCTP completion as pending independent proof", async () => {
    const route = ROUTE_DESCRIPTORS.find((candidate) => candidate.id === "cctp-v2-base-sepolia-solana-devnet-usdc")!;
    const now = Date.now();
    const record = createRouteFinalityRecord({
      executionId: "provider-complete-operation",
      quoteId: "provider-complete-quote",
      routeId: route.id,
      routeFingerprint: routeDescriptorFingerprint(route),
      provider: "Circle test",
      stage: "awaiting-proof",
      cursor: { protocol: "cctp-v2", sourceDomain: 6, destinationDomain: 5, sourceTxCandidates: [`0x${"c".repeat(64)}`] },
      evidence: []
    }, now);
    expect(persistRouteFinality(record, route)).toBe(true);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<BridgePanel evmProviderId={null} evmWalletCapabilityId="eip1193" />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Provider completion reported · independent proof pending");
    expect(container.textContent).toContain("destination finality is not independently confirmed");
    expect(container.textContent).not.toContain("Destination mint confirmed");
  });

  it("lets the user select older transfer evidence without overwriting it", async () => {
    const route = ROUTE_DESCRIPTORS.find((candidate) => candidate.id === "cctp-v2-base-sepolia-solana-devnet-usdc")!;
    const now = Date.now();
    const base = {
      routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), provider: "Circle test",
      cursor: { protocol: "cctp-v2" as const, sourceDomain: 6, destinationDomain: 5, sourceTxCandidates: [`0x${"d".repeat(64)}`] }, evidence: []
    };
    const older = createRouteFinalityRecord({ ...base, executionId: "older-operation", quoteId: "older-quote", stage: "source-submitted" }, now - 1_000);
    const newer = createRouteFinalityRecord({ ...base, executionId: "newer-operation", quoteId: "newer-quote", stage: "awaiting-proof" }, now);
    expect(persistRouteFinality(older, route)).toBe(true);
    expect(persistRouteFinality(newer, route)).toBe(true);

    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<BridgePanel evmProviderId={null} evmWalletCapabilityId="eip1193" />); await Promise.resolve(); });
    expect(container.textContent).toContain("SAVED TRANSFER EVIDENCE · 2");
    expect(container.textContent).toContain("Provider completion reported · independent proof pending");
    const selector = container.querySelector(".bridge-finality-selector select") as HTMLSelectElement;
    await act(async () => {
      selector.value = [...selector.options].find((option) => option.textContent?.includes("older-operation"))!.value;
      selector.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve();
    });
    expect(container.textContent).toContain("Burn submitted");
  });

  it("warns against retry when a pre-execution reservation lacks a durable transaction identity", async () => {
    const route = ROUTE_DESCRIPTORS.find((candidate) => candidate.id === "cctp-v2-base-sepolia-solana-devnet-usdc")!;
    const quote: RouteQuote = {
      quoteId: "reserved-quote", routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), requestFingerprint: `0x${"1".repeat(64)}`, adapterId: route.adapterId,
      amountInBaseUnits: 1_000_000n, expectedOutBaseUnits: 990_000n, minimumOutBaseUnits: 990_000n, fees: [], unpricedCosts: [], expiresAt: Date.now() + 60_000, estimatedSeconds: null,
      authorization: { type: "none" }, executionPreview: { chainId: "eip155:84532", target: route.sourceExecutionTarget, method: route.executionMethod, valueBaseUnits: 0n },
      adapterData: { format: "test", value: {} }
    };
    reserveRouteFinality(route, quote, `cctp:${quote.quoteId}`);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<BridgePanel evmProviderId={null} evmWalletCapabilityId="eip1193" />); await Promise.resolve(); });
    expect(container.textContent).toContain("1 transfer attempt lacks a durable source transaction identity");
    expect(container.textContent).toContain("Do not retry");
  });

  it("shows a single-REST IBC acknowledgement as non-terminal proof-unverified evidence", async () => {
    const route = ROUTE_DESCRIPTORS.find((candidate) => candidate.id === "ibc-grand-1-osmo-test-5-usdc")!;
    const now = Date.now();
    const record = createRouteFinalityRecord({
      executionId: "ibc-observed-operation", quoteId: "ibc-observed-quote", routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), provider: "IBC test",
      stage: "destination-observed",
      cursor: { protocol: "ibc-ics20", sourceTxHash: "B".repeat(64), sequence: "7", sourceChannel: "channel-22", destinationChannel: "channel-4280", timeoutAt: now + 60_000 },
      evidence: [{ kind: "packet-ack", id: "channel-4280/7@123", observedAt: now, url: "https://example.invalid/ack", outcome: "success" }]
    }, now);
    expect(persistRouteFinality(record, route)).toBe(true);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<BridgePanel evmProviderId={null} evmWalletCapabilityId="eip1193" />); await Promise.resolve(); });
    const routeSelect = container.querySelector(".bridge-preset select") as HTMLSelectElement;
    await act(async () => { routeSelect.value = "noble-to-osmosis"; routeSelect.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    expect(container.textContent).toContain("Destination acknowledgement observed · proof unverified");
    expect(container.textContent).toContain("success observed");
    expect(container.textContent).toContain("Check destination status");
    expect(container.textContent).not.toContain("Destination acknowledgement independently verified");
  });
});
