/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./cctp-asset-release-policy", async () => ({
  ...(await vi.importActual<typeof import("./cctp-asset-release-policy")>("./cctp-asset-release-policy")),
  verifySignedCctpAssetReleaseManifest: vi.fn()
}));
vi.mock("./cctp-deployment-metadata-review", async () => ({
  ...(await vi.importActual<typeof import("./cctp-deployment-metadata-review")>("./cctp-deployment-metadata-review")),
  verifyCctpDeploymentMetadataReview: vi.fn()
}));

import CctpReleaseReviewPanel from "./CctpReleaseReviewPanel";
import * as assetReleasePolicy from "./cctp-asset-release-policy";
import * as deploymentMetadataReview from "./cctp-deployment-metadata-review";
import { BASE_SEPOLIA_CCTP_ASSET, type CctpAssetReleaseEvidence } from "./cctp-asset-release";

const NOW = Date.parse("2026-09-02T00:00:00.000Z");
const FINGERPRINT = `0x${"f".repeat(64)}`;
const PARENT_PAYLOAD_HASH = `0x${"a".repeat(64)}`;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).mockReset();
  vi.mocked(deploymentMetadataReview.verifyCctpDeploymentMetadataReview).mockReset();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.useRealTimers();
});

describe("CctpReleaseReviewPanel", () => {
  it("stays idle without wallet or network state and explains why missing evidence cannot verify", async () => {
    mount();
    const verify = button("Verify review evidence");
    const fingerprint = input("Trusted reviewer fingerprint");

    expect(fingerprint.value).toBe("");
    expect(verify.disabled).toBe(true);
    expect(container?.textContent).toContain("Review signed evidence");
    expect(container?.textContent).toContain("recheck current USDC identity");
    expect(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).not.toHaveBeenCalled();
    expect(deploymentMetadataReview.verifyCctpDeploymentMetadataReview).not.toHaveBeenCalled();
  });

  it("wires the external fingerprint and fresh evidence through both verification policies", async () => {
    const evidence = freshEvidence(NOW - 60 * 60 * 1_000);
    const bundle = reviewBundle();
    const parent = { payloadHash: PARENT_PAYLOAD_HASH, manifest: { revision: 1 }, sourceFingerprint: FINGERPRINT };
    const releaseExpiresAt = new Date(NOW + 7 * 24 * 60 * 60 * 1_000).toISOString();
    const supplementExpiresAt = new Date(NOW + 3 * 24 * 60 * 60 * 1_000).toISOString();
    const reportObservedAt = new Date(NOW - 2 * 60 * 60 * 1_000).toISOString();
    const release = { ...parent, manifest: { revision: 1, expiresAt: releaseExpiresAt } };
    const supplement = {
      reportSha256: `sha256:${"b".repeat(64)}`,
      releasePayloadHash: PARENT_PAYLOAD_HASH,
      manifest: { expiresAt: supplementExpiresAt },
      report: { observedAt: reportObservedAt }
    };
    vi.mocked(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).mockReturnValue(release as never);
    vi.mocked(deploymentMetadataReview.verifyCctpDeploymentMetadataReview).mockReturnValue(supplement as never);

    mount(evidence);
    await upload(bundle);
    const fingerprintInput = input("Trusted reviewer fingerprint");
    await act(async () => {
      setTextInput(fingerprintInput, FINGERPRINT);
      await Promise.resolve();
    });
    await click(button("Verify review evidence"));

    expect(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).toHaveBeenCalledTimes(1);
    expect(deploymentMetadataReview.verifyCctpDeploymentMetadataReview).toHaveBeenCalledTimes(1);
    const releaseCall = vi.mocked(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).mock.calls[0];
    expect(releaseCall[0]).toEqual(bundle.releaseManifest);
    expect(releaseCall[1]).toEqual(bundle.source);
    expect(releaseCall[2]).toBe(FINGERPRINT);
    expect(releaseCall[3]).toBe(evidence);
    expect(releaseCall[4]).toEqual(bundle.verificationArtifact);
    expect(releaseCall[5]).toEqual({ now: NOW, previousHead: undefined });
    const supplementCall = vi.mocked(deploymentMetadataReview.verifyCctpDeploymentMetadataReview).mock.calls[0];
    expect(supplementCall).toEqual([bundle.metadataReview, bundle.deploymentReport, release, FINGERPRINT, evidence, NOW]);
    expect(container?.textContent).toContain("Evidence reviewed — CCTP remains disabled");
    expect(container?.textContent).toContain(new Date(Math.min(
      Date.parse(releaseExpiresAt),
      Date.parse(reportObservedAt) + 24 * 60 * 60 * 1_000,
      evidence.observedAt + 24 * 60 * 60 * 1_000,
      Date.parse(supplementExpiresAt)
    )).toISOString());
  });

  it("clears a successful result when the fingerprint, uploaded bundle, or evidence changes", async () => {
    const evidence = freshEvidence(NOW - 60 * 60 * 1_000);
    const bundle = reviewBundle();
    configureSuccessfulVerification();
    mount(evidence);
    await verifyBundle(bundle, FINGERPRINT);
    expect(container?.textContent).toContain("Evidence reviewed — CCTP remains disabled");

    const fingerprintInput = input("Trusted reviewer fingerprint");
    await act(async () => {
      setTextInput(fingerprintInput, `0x${"e".repeat(64)}`);
      await Promise.resolve();
    });
    expect(container?.textContent).not.toContain("Evidence reviewed — CCTP remains disabled");

    await verifyBundle(bundle, FINGERPRINT);
    expect(container?.textContent).toContain("Evidence reviewed — CCTP remains disabled");
    await upload({ ...bundle, metadataReview: { changed: true } });
    expect(container?.textContent).not.toContain("Evidence reviewed — CCTP remains disabled");

    await verifyBundle(bundle, FINGERPRINT);
    const changedEvidence = freshEvidence(NOW - 30 * 60 * 1_000);
    await act(async () => { root?.render(<CctpReleaseReviewPanel evidence={changedEvidence} />); await Promise.resolve(); });
    expect(container?.textContent).not.toContain("Evidence reviewed — CCTP remains disabled");
  });

  it("rejects malformed and oversized bundles without exposing verifier errors", async () => {
    const evidence = freshEvidence(NOW - 60 * 60 * 1_000);
    mount(evidence);
    const fingerprintInput = input("Trusted reviewer fingerprint");
    await act(async () => {
      setTextInput(fingerprintInput, FINGERPRINT);
      await Promise.resolve();
    });

    const malformed = { ...reviewBundle(), unexpected: true };
    await upload(malformed);
    expect(container?.textContent).toContain("Review rejected");
    expect(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).not.toHaveBeenCalled();

    const oversized = new File([new Uint8Array(256_001)], "oversized.json", { type: "application/json" });
    await chooseFile(input("Signed review bundle JSON"), oversized);
    expect(container?.textContent).toContain("Review rejected");
    expect(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).not.toHaveBeenCalled();
    expect(container?.textContent).not.toContain("unexpected");
  });

  it("does not let a late File.text result overwrite a newer upload", async () => {
    const evidence = freshEvidence(NOW - 60 * 60 * 1_000);
    const bundle = reviewBundle();
    configureSuccessfulVerification();
    mount(evidence);
    const fileInput = input("Signed review bundle JSON");
    let resolveStale!: (value: string) => void;
    const stale = new File(["stale"], "stale.json", { type: "application/json" });
    Object.defineProperty(stale, "text", { value: () => new Promise<string>((resolve) => { resolveStale = resolve; }) });
    await chooseFile(fileInput, stale);
    await upload(bundle);
    await verifyBundle(bundle, FINGERPRINT);
    expect(container?.textContent).toContain("Evidence reviewed — CCTP remains disabled");

    await act(async () => { resolveStale("{\"unexpected\":true}"); await Promise.resolve(); });
    expect(container?.textContent).toContain("Evidence reviewed — CCTP remains disabled");
    expect(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).toHaveBeenCalledTimes(1);
  });

  it("expires the validation result at the calculated deadline", async () => {
    const evidence = freshEvidence(NOW - 60 * 60 * 1_000);
    const bundle = reviewBundle();
    const expiry = new Date(NOW + 30 * 60 * 1_000).toISOString();
    vi.mocked(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).mockReturnValue({ payloadHash: PARENT_PAYLOAD_HASH, manifest: { revision: 1, expiresAt: expiry } } as never);
    vi.mocked(deploymentMetadataReview.verifyCctpDeploymentMetadataReview).mockReturnValue({
      reportSha256: `sha256:${"c".repeat(64)}`,
      releasePayloadHash: PARENT_PAYLOAD_HASH,
      manifest: { expiresAt: new Date(NOW + 2 * 60 * 60 * 1_000).toISOString() },
      report: { observedAt: new Date(NOW - 2 * 60 * 60 * 1_000).toISOString() }
    } as never);
    mount(evidence);
    await verifyBundle(bundle, FINGERPRINT);
    expect(container?.textContent).toContain("Evidence reviewed — CCTP remains disabled");

    await act(async () => { vi.advanceTimersByTime(30 * 60 * 1_000 + 1); await Promise.resolve(); });
    expect(container?.textContent).toContain("Evidence expired — verify again");
    expect(container?.textContent).not.toContain("Evidence reviewed — CCTP remains disabled");
  });

  it("retains an authenticated parent revision even when its supplement is rejected", async () => {
    configureSuccessfulVerification();
    vi.mocked(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).mockReturnValue({ payloadHash: PARENT_PAYLOAD_HASH, manifest: { revision: 7, expiresAt: new Date(NOW + 60_000).toISOString() } } as never);
    vi.mocked(deploymentMetadataReview.verifyCctpDeploymentMetadataReview).mockImplementation(() => { throw new Error("invalid supplement"); });
    mount(freshEvidence(NOW - 1_000));
    await verifyBundle(reviewBundle(), FINGERPRINT);
    expect(container?.textContent).toContain("Review rejected");
    await click(button("Verify review evidence"));
    expect(vi.mocked(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).mock.calls[1][5]).toEqual({ now: NOW, previousHead: { revision: 7, payloadHash: PARENT_PAYLOAD_HASH } });
  });

  it("shows only a generic rejection when either policy fails", async () => {
    const evidence = freshEvidence(NOW - 60 * 60 * 1_000);
    vi.mocked(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).mockImplementation(() => { throw new Error("secret verifier detail"); });
    mount(evidence);
    await verifyBundle(reviewBundle(), FINGERPRINT);
    expect(container?.textContent).toContain("Review rejected");
    expect(container?.textContent).not.toContain("secret verifier detail");
  });
});

function mount(evidence?: CctpAssetReleaseEvidence): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => { root?.render(<CctpReleaseReviewPanel evidence={evidence} />); });
}

function button(label: string): HTMLButtonElement {
  return [...(container?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent?.includes(label)) as HTMLButtonElement;
}

function input(label: string): HTMLInputElement {
  const fieldLabel = [...(container?.querySelectorAll("label") ?? [])].find((candidate) => candidate.textContent?.trim() === label);
  return document.getElementById(fieldLabel?.htmlFor ?? "") as HTMLInputElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
}

async function upload(bundle: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(bundle);
  const file = new File([serialized], "review-bundle.json", { type: "application/json" });
  Object.defineProperty(file, "text", { configurable: true, value: () => Promise.resolve(serialized) });
  await chooseFile(input("Signed review bundle JSON"), file);
}

async function chooseFile(fileInput: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
  await act(async () => { fileInput.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
}

async function verifyBundle(bundle: Record<string, unknown>, fingerprint: string): Promise<void> {
  await upload(bundle);
  const fingerprintInput = input("Trusted reviewer fingerprint");
  await act(async () => {
    setTextInput(fingerprintInput, fingerprint);
    await Promise.resolve();
  });
  await click(button("Verify review evidence"));
}

function setTextInput(target: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("HTML input value setter unavailable");
  setter.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

function reviewBundle(): Record<string, unknown> {
  return {
    source: { id: "externally-pinned-reviewer" },
    releaseManifest: { revision: 1 },
    verificationArtifact: { schema: "test-artifact" },
    metadataReview: { schema: "test-metadata-review" },
    deploymentReport: { schema: "test-report", observedAt: new Date(NOW - 2 * 60 * 60 * 1_000).toISOString() }
  };
}

function freshEvidence(observedAt: number): CctpAssetReleaseEvidence {
  return {
    status: "quorum-observed",
    asset: BASE_SEPOLIA_CCTP_ASSET,
    observations: ["reader-a", "reader-b"].map((readerId) => ({
      readerId,
      observedBlock: 100,
      proxyCodeHash: `0x${"1".repeat(64)}`,
      implementationAddress: "0x1111111111111111111111111111111111111111",
      implementationCodeHash: `0x${"2".repeat(64)}`,
      name: "USDC",
      symbol: "USDC",
      decimals: 6
    })) as CctpAssetReleaseEvidence["observations"],
    observedAt,
    executionEnabled: false,
    releaseApprovalRequired: true
  };
}

function configureSuccessfulVerification(): void {
  vi.mocked(assetReleasePolicy.verifySignedCctpAssetReleaseManifest).mockReturnValue({
    payloadHash: PARENT_PAYLOAD_HASH,
    manifest: { revision: 1, expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1_000).toISOString() }
  } as never);
  vi.mocked(deploymentMetadataReview.verifyCctpDeploymentMetadataReview).mockReturnValue({
    reportSha256: `sha256:${"b".repeat(64)}`,
    releasePayloadHash: PARENT_PAYLOAD_HASH,
    manifest: { expiresAt: new Date(NOW + 3 * 24 * 60 * 60 * 1_000).toISOString() },
    report: { observedAt: new Date(NOW - 2 * 60 * 60 * 1_000).toISOString() }
  } as never);
}
