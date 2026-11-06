/** @vitest-environment jsdom */
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import CosmosRecoveryPanel from "./CosmosRecoveryPanel";
import type { CosmosInjectedSignedSwapEvidence } from "./cosmos-injected-signed-swap-evidence";
import type { CosmosReadPolicyHead, VerifiedCosmosReadPolicy } from "./cosmos-read-policy";
import type { CosmosSwapRecoveryRecord } from "./cosmos-swap-recovery";

const mocks = vi.hoisted(() => ({
  revalidate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("./cosmos-read-policy", async () => {
  const actual = await vi.importActual<typeof import("./cosmos-read-policy")>("./cosmos-read-policy");
  return { ...actual, revalidateCosmosReadPolicy: mocks.revalidate };
});
vi.mock("./cosmos-policy-bound-recovery", () => ({ refreshPolicyBoundCosmosRecovery: mocks.refresh }));

// Keep the synthetic receipt in the present so the panel's local clock gate
// does not reject it merely because a fixture was authored before this run.
const NOW = Date.now() - 60_000;
const CHAIN = "cosmos:osmosis-1";
const HASH = "a".repeat(64);
const LATE_HASH = "c".repeat(64);
const SOURCE_FINGERPRINT = "f".repeat(64);
const POLICY_HASH = "e".repeat(64);
const ACCOUNT = "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function makeRecord(overrides: Partial<CosmosSwapRecoveryRecord> = {}): CosmosSwapRecoveryRecord {
  return {
    schema: "realdex.cosmos-swap-recovery.v1",
    revision: 1,
    recoveryId: "r".repeat(64),
    venueId: "osmosis-test-venue",
    venueRevision: 1,
    chainId: CHAIN,
    bech32Prefix: "osmo",
    executionTarget: "osmo1target0000000000000000000000000000000000",
    authority: ACCOUNT,
    recipient: ACCOUNT,
    sourceDenom: "uosmo",
    destinationDenom: "uion",
    amountInBaseUnits: "2500",
    expectedOutBaseUnits: "2000",
    minimumOutBaseUnits: "1900",
    accountNumber: "7",
    sequence: "3",
    feeDenom: "uosmo",
    feeAmountBaseUnits: "25",
    gasLimit: "200000",
    timeoutHeight: "1000",
    transactionHash: HASH,
    signedTransactionSha256: "1".repeat(64),
    unsignedTransactionSha256: "2".repeat(64),
    signDocSha256: "3".repeat(64),
    intentSha256: "4".repeat(64),
    publicKeyBase64: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg==",
    signatureSha256: "5".repeat(64),
    stage: "signed-not-submitted",
    resendBlocked: true,
    observations: [],
    refreshCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<CosmosInjectedSignedSwapEvidence> = {}): CosmosInjectedSignedSwapEvidence {
  return {
    schema: "realdex.cosmos-injected-signed-swap-evidence.v1",
    evidenceId: "6".repeat(64),
    preparationId: "preparation-1",
    walletId: "wallet-1",
    sessionId: "session-1",
    accountId: `${CHAIN}:${ACCOUNT}`,
    authority: ACCOUNT,
    chainId: CHAIN,
    walletChainId: "cosmos:osmosis-1",
    publicKeyHex: "02" + "11".repeat(32),
    sourceDenom: "uosmo",
    destinationDenom: "uion",
    amountInBaseUnits: "2500",
    expectedOutBaseUnits: "2000",
    minimumOutBaseUnits: "1900",
    feeDenom: "uosmo",
    feeAmountBaseUnits: "25",
    gasLimit: "200000",
    timeoutHeight: "1000",
    recipient: ACCOUNT,
    executionTarget: "osmo1target0000000000000000000000000000000000",
    venueId: "osmosis-test-venue",
    venueRevision: 1,
    transactionHash: HASH,
    signedTransactionSha256: "1".repeat(64),
    unsignedTransactionSha256: "2".repeat(64),
    signDocSha256: "3".repeat(64),
    intentSha256: "4".repeat(64),
    publicKeyBase64: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg==",
    signatureSha256: "5".repeat(64),
    accountNumber: "7",
    sequence: "3",
    readPolicySourceFingerprint: SOURCE_FINGERPRINT,
    readPolicyPayloadHash: POLICY_HASH,
    routeFingerprint: "7".repeat(64),
    manifestPayloadHash: "8".repeat(64),
    acceptedAt: NOW,
    stage: "signed-not-submitted",
    signedTransactionBytesStored: false,
    automaticResendBlocked: true,
    requiresExplicitSubmissionAuthorization: true,
    submissionEnabled: false,
    ...overrides,
  } as CosmosInjectedSignedSwapEvidence;
}

function makePolicy(overrides: Partial<VerifiedCosmosReadPolicy> = {}): VerifiedCosmosReadPolicy {
  return {
    schema: "realdex.verified-cosmos-read-policy.v1",
    status: "verified-design-gate",
    executionEnabled: false,
    signingEnabled: false,
    broadcastEnabled: false,
    source: {
      schema: "realdex.cosmos-read-policy-source.v1",
      id: "osmosis-policy-source",
      name: "Pinned Osmosis read reviewer",
      signerPublicKeyBase64: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg==",
      allowedChainIds: [CHAIN],
      evidenceUrls: ["https://policy.example.org/cosmos/osmosis"],
    },
    sourceFingerprint: SOURCE_FINGERPRINT,
    policy: {
      schema: "realdex.signed-cosmos-read-policy.v1",
      sourceId: "osmosis-policy-source",
      sourceFingerprint: SOURCE_FINGERPRINT,
      revision: 7,
      issuedAt: new Date(NOW - 60_000).toISOString(),
      expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
      chainId: CHAIN,
      restEndpoints: ["https://rest-a.example.org", "https://rest-b.example.net"],
      simulationBoundaryId: "cosmos-swap-boundary",
      recoveryBoundaryId: "cosmos-swap-recovery-v1",
      evidenceUrls: ["https://policy.example.org/cosmos/osmosis"],
      signatureBase64: "AA==",
    },
    payloadHash: POLICY_HASH,
    verifiedAt: NOW - 60_000,
    ...overrides,
  } as VerifiedCosmosReadPolicy;
}

const evidence = makeEvidence();
const record = makeRecord();
const policy = makePolicy();
const head: CosmosReadPolicyHead = { revision: policy.policy.revision, payloadHash: policy.payloadHash };

function acceptedResult(nextRecord: CosmosSwapRecoveryRecord = record) {
  return {
    record: nextRecord,
    checkedAt: NOW + 1,
    policySourceFingerprint: SOURCE_FINGERPRINT,
    policyPayloadHash: POLICY_HASH,
    policyRevision: policy.policy.revision,
    executionEnabled: false as const,
    broadcastEnabled: false as const,
    resendBlocked: true as const,
  };
}

function props(overrides: Partial<ComponentProps<typeof CosmosRecoveryPanel>> = {}) {
  return {
    evidence,
    initialRecord: record,
    policy,
    readHead: () => head,
    ...overrides,
  } as ComponentProps<typeof CosmosRecoveryPanel>;
}

async function render(value = props()) {
  await act(async () => root.render(<StrictMode><CosmosRecoveryPanel {...value} /></StrictMode>));
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.revalidate.mockImplementation((value: VerifiedCosmosReadPolicy) => value);
  mocks.refresh.mockResolvedValue(acceptedResult());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("Cosmos recovery panel", () => {
  it("is read-only on mount, shows complete evidence, and requires the explicit lookup action", async () => {
    await render();
    expect(container.textContent).toContain("Transaction status · read only");
    expect(container.textContent).toContain(CHAIN);
    expect(container.textContent).toContain(HASH);
    expect(container.textContent).toContain("https://rest-a.example.org");
    expect(container.textContent).toContain("https://rest-b.example.net");
    expect(container.textContent).toContain("Not checked");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(button("Check transaction status").disabled).toBe(false);
  });

  it("calls the refresh service exactly once, exposes pending/cancel controls, and never signs or broadcasts", async () => {
    let release!: (value: ReturnType<typeof acceptedResult>) => void;
    mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await render();
    await act(async () => { button("Check transaction status").click(); button("Check transaction status").click(); });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Checking transaction status…");
    expect(container.textContent).toContain("Stop lookup");
    expect(container.querySelector('button:not([disabled])')?.textContent).not.toMatch(/sign|broadcast|delete|resend/i);
    const input = mocks.refresh.mock.calls[0][0];
    expect(input).toMatchObject({ evidence, record, policy });
    expect(mocks.refresh.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await act(async () => release(acceptedResult(makeRecord({ stage: "committed-success", transactionHash: HASH }))));
    expect(container.textContent).toContain("Transaction committed · success reported");
    expect(container.textContent).toContain(`Observed under policy revision ${policy.policy.revision}`);
    expect(container.textContent).toContain(POLICY_HASH);
    expect(container.textContent).toContain(SOURCE_FINGERPRINT);
    expect(button("Refresh transaction status")).toBeTruthy();
  });

  it("starts at Not checked, then renders each accepted lifecycle title without inventing a receipt", async () => {
    await render();
    expect(container.textContent).toContain("Not checked");
    for (const [stage, title] of [
      ["submitted", "No transaction found · unresolved"],
      ["committed-success", "Transaction committed · success reported"],
      ["committed-failed", "Transaction committed · failure reported"],
      ["expired-unresolved", "Timeout height passed · unresolved"],
    ] as const) {
      mocks.refresh.mockResolvedValueOnce(acceptedResult(makeRecord({ stage })));
      await click(container.querySelector<HTMLButtonElement>('button')?.textContent ?? "Check transaction status");
      expect(container.textContent).toContain(title);
      await render();
    }
  });

  const invalidPolicies: Array<[string, VerifiedCosmosReadPolicy | undefined, () => CosmosReadPolicyHead | undefined]> = [
    ["missing policy", undefined, () => head],
    ["simulation-only policy", makePolicy({ policy: { ...policy.policy, recoveryBoundaryId: undefined } }), () => head],
    ["chain mismatch", makePolicy({ policy: { ...policy.policy, chainId: "cosmos:other-chain" } }), () => head],
    ["reviewer mismatch", makePolicy({ sourceFingerprint: "d".repeat(64) }), () => head],
    ["missing head", policy, () => undefined],
    ["malformed head", policy, () => ({ revision: 7, payloadHash: "not-a-hash" })],
    ["throwing head", policy, () => { throw new Error("private head diagnostic"); }],
    ["head mismatch", policy, () => ({ revision: 8, payloadHash: POLICY_HASH })],
  ];
  it.each(invalidPolicies)("blocks lookup for %s without contacting the service", async (_name, invalidPolicy, readHead) => {
    await render(props({ policy: invalidPolicy, readHead }));
    const action = container.querySelector<HTMLButtonElement>('button');
    expect(action?.disabled).toBe(true);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("private head diagnostic");
  });

  it("blocks an expired policy after local revalidation and never performs a network lookup", async () => {
    mocks.revalidate.mockImplementation(() => { throw new Error("COSMOS_READ_POLICY_EXPIRED"); });
    await render();
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("uses the prior accepted record for refresh and retains it as historical after an error", async () => {
    const committed = makeRecord({ stage: "committed-success", refreshCount: 1, transactionHash: HASH });
    mocks.refresh.mockResolvedValueOnce(acceptedResult(committed)).mockRejectedValueOnce(new Error("private diagnostic"));
    await render();
    await click("Check transaction status");
    expect(container.textContent).toContain("Transaction committed · success reported");
    await click("Refresh transaction status");
    expect(mocks.refresh.mock.calls[1][0].record).toBe(committed);
    expect(container.textContent).toMatch(/historical/i);
    expect(container.textContent).not.toContain("private diagnostic");
    expect(container.textContent).toContain("Transaction committed · success reported");
    expect(container.textContent).toContain(new Date(NOW + 1).toISOString());

    // A policy context change invalidates a new lookup, but does not erase the
    // last accepted observation from this page-local historical view.
    await render(props({ policy: makePolicy({ policy: { ...policy.policy, evidenceUrls: ["https://policy.example.org/cosmos/osmosis-v2"] } }) }));
    expect(container.textContent).toContain("Transaction committed · success reported");
    expect(container.textContent).toMatch(/historical/i);
  });

  it("aborts cancellation and discards a late result", async () => {
    let release!: (value: ReturnType<typeof acceptedResult>) => void;
    mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await render();
    await click("Check transaction status");
    const signal = mocks.refresh.mock.calls[0][1].signal as AbortSignal;
    await click("Stop lookup");
    expect(signal.aborted).toBe(true);
    await act(async () => release(acceptedResult(makeRecord({ transactionHash: LATE_HASH, stage: "committed-success" }))));
    expect(container.textContent).not.toContain(LATE_HASH);
    expect(container.textContent).not.toContain("Transaction committed · success reported");
  });

  it("discards late results after unmount, scope changes, and policy changes", async () => {
    let release!: (value: ReturnType<typeof acceptedResult>) => void;
    mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await render();
    await click("Check transaction status");
    const signal = mocks.refresh.mock.calls[0][1].signal as AbortSignal;
    await render(props({ evidence: makeEvidence({ transactionHash: LATE_HASH }), initialRecord: makeRecord({ transactionHash: LATE_HASH }), policy }));
    expect(signal.aborted).toBe(true);
    await act(async () => release(acceptedResult(makeRecord({ transactionHash: LATE_HASH, stage: "committed-success" }))));
    expect(container.textContent).not.toContain("Transaction committed · success reported");

    let secondRelease!: (value: ReturnType<typeof acceptedResult>) => void;
    mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { secondRelease = resolve; }));
    await click("Check transaction status");
    const secondSignal = mocks.refresh.mock.calls[1][1].signal as AbortSignal;
    await act(async () => root.unmount());
    expect(secondSignal.aborted).toBe(true);
    await act(async () => secondRelease(acceptedResult(makeRecord({ transactionHash: LATE_HASH, stage: "committed-success" }))));
  });

  it("cancels a pending lookup on a policy-only change and permits a fresh lookup", async () => {
    let release!: (value: ReturnType<typeof acceptedResult>) => void;
    mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await render();
    await click("Check transaction status");
    const signal = mocks.refresh.mock.calls[0][1].signal as AbortSignal;
    const changedPolicy = makePolicy({ policy: { ...policy.policy, evidenceUrls: ["https://policy.example.org/cosmos/osmosis-v2"] } });
    await render(props({ policy: changedPolicy }));
    expect(signal.aborted).toBe(true);
    expect(container.textContent).not.toContain("Checking transaction status…");

    mocks.refresh.mockImplementationOnce(() => Promise.resolve(acceptedResult(makeRecord({ stage: "committed-success" }))));
    await click("Check transaction status");
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh.mock.calls[1][0].policy).toBe(changedPolicy);
    expect(container.textContent).toContain("Transaction committed · success reported");
    await act(async () => release(acceptedResult()));
  });

  it("stops a pending lookup when the local expiry/head check changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let currentHead: CosmosReadPolicyHead | undefined = head;
    mocks.refresh.mockImplementationOnce(() => new Promise(() => undefined));
    await render(props({ readHead: () => currentHead }));
    await click("Check transaction status");
    currentHead = { revision: 8, payloadHash: POLICY_HASH };
    await act(async () => { vi.advanceTimersByTime(1_100); });
    expect(container.textContent).toMatch(/policy|head|blocked|expired/i);
    expect((mocks.refresh.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("stops a pending lookup when the local policy expiry passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const expiringPolicy = makePolicy({ policy: { ...policy.policy, expiresAt: new Date(NOW + 500).toISOString() } });
    mocks.refresh.mockImplementationOnce(() => new Promise(() => undefined));
    await render(props({ policy: expiringPolicy }));
    await click("Check transaction status");
    const signal = mocks.refresh.mock.calls[0][1].signal as AbortSignal;
    await act(async () => { vi.advanceTimersByTime(1_100); });
    expect(container.textContent).toMatch(/policy|expired|blocked/i);
    expect(signal.aborted).toBe(true);
  });
});
