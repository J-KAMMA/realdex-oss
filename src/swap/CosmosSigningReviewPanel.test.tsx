/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import CosmosSigningReviewPanel from "./CosmosSigningReviewPanel";
import { cosmosSigningReviewFixture } from "./cosmos-signing-review.test-fixtures";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), reserve: vi.fn(), read: vi.fn(), sign: vi.fn() }));
vi.mock("./cosmos-injected-signing-preparation", () => ({ prepareCosmosInjectedSigning: mocks.prepare }));
vi.mock("./cosmos-signed-swap-journal", () => ({ reserveCosmosInjectedSigning: mocks.reserve, readCosmosSigningSlot: mocks.read }));
vi.mock("./cosmos-injected-direct-signing", () => ({ requestCosmosInjectedSwapSignature: mocks.sign }));
let root: Root, container: HTMLDivElement;
let fixture: ReturnType<typeof cosmosSigningReviewFixture>;
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  fixture = cosmosSigningReviewFixture();
  mocks.prepare.mockResolvedValue(fixture.preparation); mocks.reserve.mockResolvedValue({ preparation: fixture.preparation }); mocks.read.mockReturnValue(null);
  mocks.sign.mockResolvedValue({ evidence: { transactionHash: "B".repeat(64) }, signedTransactionBase64: "synthetic-signed-bytes" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });
async function render(props = fixture.props) { await act(async () => root.render(<CosmosSigningReviewPanel {...props} />)); }
function button(text: string): HTMLButtonElement { const item = [...container.querySelectorAll("button")].find(b => b.textContent === text); if (!item) throw new Error(`Missing button ${text}`); return item; }
async function click(item: HTMLElement) { await act(async () => item.click()); }
async function ready() { await render(); await click(button("Prepare signing review")); }
async function acknowledge() { await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!); }
const signLabel = "Request swap signature — no broadcast";

describe("Cosmos signing review UI", () => {
  it("does nothing on mount and displays exact base units only after explicit preparation", async () => {
    await render(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
    await click(button("Prepare signing review"));
    expect(container.textContent).toContain(fixture.preparation.amountInBaseUnits);
    expect(container.textContent).toContain(fixture.preparation.minimumOutBaseUnits);
    expect(container.textContent).toContain(fixture.preparation.destinationDenom);
    expect(container.textContent).toContain("2500 uosmo");
    expect(container.textContent).toContain("18446744073709554115 uosmo");
    expect(container.textContent).toContain("Token decimal places and display symbols are not verified");
    expect(document.activeElement?.textContent).toBe("Review swap transaction");
    expect(button(signLabel).disabled).toBe(true); expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("requires acknowledgement and sends the displayed confirmation exactly once", async () => {
    await ready(); await acknowledge();
    await act(async () => { button(signLabel).click(); button(signLabel).click(); });
    expect(mocks.reserve).toHaveBeenCalledTimes(1); expect(mocks.sign).toHaveBeenCalledTimes(1);
    expect(mocks.sign.mock.calls[0][0].confirmation).toEqual({ action: "request-cosmos-direct-signature-only", preparationId: fixture.preparation.preparationId, transactionSha256: fixture.preparation.transactionSha256 });
    expect(container.textContent).toContain("Signed · not submitted");
    expect(container.textContent).toContain("B".repeat(64));
    expect(container.textContent).not.toContain("synthetic-signed-bytes");
    expect(container.textContent).toContain("No submission action is available");
  });

  it("does not request a signature after stopping while reservation is still pending", async () => {
    let release!: (value: unknown) => void;
    mocks.reserve.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await ready(); await acknowledge(); await click(button(signLabel));
    await click(button("Stop waiting locally"));
    await act(async () => release({ preparation: fixture.preparation }));
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Any reservation stays blocked");
    expect(button(signLabel).disabled).toBe(true);
  });

  it("hands the byte-free signing result to a blocked read-only recovery view without a policy", async () => {
    const transactionHash = "C".repeat(64);
    mocks.sign.mockResolvedValueOnce({
      evidence: { transactionHash, readPolicySourceFingerprint: "f".repeat(64) },
      recoveryRecord: { chainId: "cosmos:osmosis-1", transactionHash, updatedAt: Date.now(), observations: [], stage: "signed-not-submitted" },
      signedTransactionBase64: "never-render-these-bytes"
    });
    await ready(); await acknowledge(); await click(button(signLabel));
    expect(container.textContent).toContain("Transaction status · read only");
    expect(container.textContent).toContain("recovery read policy missing");
    expect(container.textContent).toContain(transactionHash);
    expect(container.textContent).toContain("local signing receipt, not a live chain status");
    expect(button("Check transaction status").disabled).toBe(true);
    expect(container.textContent).not.toContain("never-render-these-bytes");
    await render({ ...fixture.props, intent: { ...fixture.props.intent } });
    expect(container.textContent).not.toContain("Transaction status · read only");
  });

  it("aborts local observation and ignores late signed results after cancellation", async () => {
    let release!: (value: unknown) => void;
    mocks.sign.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await ready(); await acknowledge(); await click(button(signLabel));
    const signal = mocks.sign.mock.calls[0][1].signal as AbortSignal;
    await click(button("Stop waiting locally")); expect(signal.aborted).toBe(true);
    await act(async () => release({ evidence: { transactionHash: "LATE" }, signedTransactionBase64: "late" }));
    expect(container.textContent).not.toContain("LATE"); expect(container.textContent).not.toContain("Signed · not submitted");
  });

  it("discards a delayed preparation when account or intent identity changes", async () => {
    let release!: (value: unknown) => void;
    mocks.prepare.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await render(); await click(button("Prepare signing review"));
    await render({ ...fixture.props, intent: { ...fixture.props.intent, sequence: "8" } });
    await act(async () => release(fixture.preparation));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain(fixture.preparation.amountInBaseUnits);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("resets acknowledgement and aborts signing when source context changes", async () => {
    mocks.sign.mockImplementationOnce((_input, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancel")))));
    await ready(); await acknowledge(); await click(button(signLabel));
    const signal = mocks.sign.mock.calls[0][1].signal as AbortSignal;
    await render({ ...fixture.props, verified: { ...fixture.props.verified } });
    expect(signal.aborted).toBe(true);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("Signed · not submitted");
  });

  it("expires the review and prevents an old checked confirmation from signing", async () => {
    vi.useFakeTimers(); vi.setSystemTime(fixture.preparation.preparedAt);
    await ready(); await acknowledge();
    await act(async () => { vi.advanceTimersByTime(60_001); });
    expect(container.textContent).toContain("This review has expired");
    expect(button(signLabel).disabled).toBe(true); await click(button(signLabel)); expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it.each(["occupied", "unavailable", "hardware"])("blocks signing for %s without touching reservation state", async reason => {
    if (reason === "occupied") mocks.read.mockReturnValue({ stage: "signing-requested" });
    if (reason === "unavailable") mocks.read.mockImplementation(() => { throw new Error("storage"); });
    if (reason === "hardware") mocks.prepare.mockResolvedValue({ ...fixture.preparation, hardware: "ledger" });
    await ready(); expect(button(signLabel).disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("rejects mismatched accounts before preparation", async () => {
    await render({ ...fixture.props, binding: { ...fixture.props.binding, address: "different" } });
    expect(button("Prepare signing review").disabled).toBe(true); expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("does not sign when the fresh reservation differs from the reviewed preparation", async () => {
    mocks.reserve.mockResolvedValueOnce({ preparation: { ...fixture.preparation, preparationId: "different" } });
    await ready(); await acknowledge(); await click(button(signLabel));
    expect(mocks.sign).not.toHaveBeenCalled(); expect(container.textContent).toContain("Any reservation remains blocked");
  });

  it("does not show raw errors or report a failed request as signed", async () => {
    mocks.sign.mockRejectedValueOnce(new Error("private diagnostic"));
    await ready(); await acknowledge(); await click(button(signLabel));
    expect(container.textContent).not.toContain("private diagnostic"); expect(container.textContent).not.toContain("Signed · not submitted");
    expect(button(signLabel).disabled).toBe(true); expect(container.textContent).toContain("No broadcast was requested");
  });
});
