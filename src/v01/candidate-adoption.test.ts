/** @vitest-environment jsdom */
import { Interface } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { routeDescriptorFingerprint } from "../routing/engine";
import { createLocalAmmRouteDescriptor } from "../swap/evm-local-amm";
import { EVM_SWAP_RECOVERY_STORAGE_KEY, evmSwapRecoveryIdentity, readEvmSwapRecoveryJournal } from "../swap/evm-swap-recovery";
import { readActiveV01Operation, saveActiveV01Operation, type ActiveV01Operation } from "./active-operation";
import type { V01CandidateObservation, V01CandidateReader } from "./candidate-reconciliation";
import type { VerifiedV01Profile } from "../release/v01-profile";
import type { V01RecoveryIntent } from "./recovery-intent";
import type { V01SendAttempt } from "./send-attempt";

// Profile membership and RPC reconciliation are covered by their own suites.
// This file isolates adoption while retaining real active-operation/journal storage.
vi.mock("../release/v01-profile", async () => ({
  ...await vi.importActual<typeof import("../release/v01-profile")>("../release/v01-profile"),
  assertCurrentV01Profile: vi.fn(), assertV01Route: vi.fn()
}));
vi.mock("./candidate-reconciliation", () => ({ verifyV01Candidate: vi.fn() }));

import { adoptV01Candidate } from "./candidate-adoption";
import { verifyV01Candidate } from "./candidate-reconciliation";

const POOL = "0x1000000000000000000000000000000000000001";
const AMBR = "0x2000000000000000000000000000000000000002";
const JADE = "0x3000000000000000000000000000000000000003";
const ACCOUNT = "0x4000000000000000000000000000000000000004";
const FACTORY = "0x5000000000000000000000000000000000000005";
const INTENT = "realdex-intent:v1:00000000-0000-4000-8000-000000000901";
const QUOTE = "candidate-adoption-901";
const PROFILE_FINGERPRINT = `0x${"a".repeat(64)}`;
const APPROVAL_HASH = `0x${"1".repeat(64)}`;
const SWAP_HASH = `0x${"2".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const HEAD_HASH = `0x${"c".repeat(64)}`;
const INCLUDED_BLOCK = 101;
const HEAD = 102;

const route = createLocalAmmRouteDescriptor({
  chainId: 84532n, poolAddress: POOL, tokenIn: AMBR, tokenOut: JADE,
  factoryAddress: FACTORY, venueId: "v01", venueLabel: "RealDEX v0.1 test tokens"
});

function profile(): VerifiedV01Profile {
  const now = Date.now();
  return {
    status: "verified-profile",
    profile: {
      schema: "realdex.v01-profile.v1",
      deployment: { releaseId: "candidate-adoption-fixture", contracts: { factory: { address: FACTORY }, router: { address: `0x${"6".repeat(40)}` } }, source: { bundleSha256: `0x${"d".repeat(64)}` } },
      pool: { address: POOL, runtimeCodeHash: `0x${"e".repeat(64)}` }, tokens: { ambr: AMBR, jade: JADE }
    }, fingerprint: PROFILE_FINGERPRINT, verifiedAt: now - 1_000, expiresAt: now + 60_000,
    readerIds: ["rpc-a", "rpc-b"], routes: [route]
  } as unknown as VerifiedV01Profile;
}

function intent(value: VerifiedV01Profile, approvalRequired: boolean): V01RecoveryIntent {
  const capturedAt = Date.now() - 1_000;
  const routeFingerprint = routeDescriptorFingerprint(route);
  const requestFingerprint = `0x${"f".repeat(64)}`;
  return {
    schema: "realdex.v01-recovery-intent.v1", intentId: INTENT, profileFingerprint: value.fingerprint,
    recoveryId: evmSwapRecoveryIdentity(routeFingerprint, requestFingerprint, QUOTE), routeId: route.id,
    routeFingerprint, quoteId: QUOTE, requestFingerprint, accountId: `eip155:84532:${ACCOUNT}`,
    recipient: ACCOUNT, sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset,
    amountInBaseUnits: "1000", minimumOutBaseUnits: "890", poolAddress: POOL,
    quoteExpiresAt: capturedAt + 30_000, approvalRequired, capturedAt
  };
}

function attempt(value: V01RecoveryIntent, role: "approval" | "swap", nonce: number): V01SendAttempt {
  const data = role === "approval"
    ? new Interface(ERC20_ABI).encodeFunctionData("approve", [value.poolAddress, value.amountInBaseUnits])
    : new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [AMBR, value.amountInBaseUnits, value.minimumOutBaseUnits, value.recipient, Math.floor(value.quoteExpiresAt / 1000)]);
  return {
    intentId: value.intentId, quoteId: value.quoteId, profileFingerprint: value.profileFingerprint,
    role, observedBeforeBlock: 100,
    transaction: { from: ACCOUNT, to: role === "approval" ? AMBR : POOL, data, value: "0x0", chainId: "0x14a34", type: "0x2", nonce: `0x${nonce.toString(16)}`, gas: "0x186a0", maxFeePerGas: "0x64", maxPriorityFeePerGas: "0x1" }
  };
}

function operation(approvalRequired = true, roles: ("approval" | "swap")[] = approvalRequired ? ["approval"] : ["swap"], recoveryId: string | null = null): Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v3" }> {
  const value = intent(profile(), approvalRequired);
  return { schema: "realdex.v01-active-operation.v3", intentId: value.intentId, quoteId: value.quoteId, profileFingerprint: value.profileFingerprint,
    recoveryId, attempts: roles.map((role, index) => attempt(value, role, approvalRequired ? index + 1 : 1)), recovery: value };
}

function appendSwap(value: Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v3" }>): Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v3" }> {
  return { ...value, recoveryId: value.recovery.recoveryId, attempts: [...value.attempts, attempt(value.recovery, "swap", 2)] };
}

function observation(operationValue: ActiveV01Operation, role: "approval" | "swap", hash: string, receiptStatus: 0 | 1 = 1, confirmations = 2): V01CandidateObservation {
  return { status: "candidate-matched", intentId: operationValue.intentId, quoteId: operationValue.quoteId, profileFingerprint: operationValue.profileFingerprint,
    role, hash: hash.toLowerCase(), attemptFingerprint: `0x${(role === "approval" ? "1" : "2").repeat(64)}`,
    blockNumber: INCLUDED_BLOCK, blockHash: BLOCK_HASH, receiptStatus, confirmations,
    commonHead: { number: HEAD, hash: HEAD_HASH }, readerIds: ["rpc-a", "rpc-b"], checkedAt: Date.now() };
}

const observations = new Map<string, V01CandidateObservation>();
const observer = vi.mocked(verifyV01Candidate);
const readers: readonly V01CandidateReader[] = [
  { id: "rpc-a", send: async () => undefined }, { id: "rpc-b", send: async () => undefined }
];

function setObservations(...values: V01CandidateObservation[]): void {
  observations.clear();
  for (const value of values) observations.set(`${value.role}:${value.hash}`, value);
}

function expected(value: ActiveV01Operation, role: "approval" | "swap", hash: string, receiptStatus: 0 | 1 = 1, confirmations = 2): V01CandidateObservation {
  return observation(value, role, hash, receiptStatus, confirmations);
}

async function adopt(value: ActiveV01Operation, selected: V01CandidateObservation, isCurrent = () => true): Promise<Awaited<ReturnType<typeof adoptV01Candidate>>> {
  const active = readActiveV01Operation();
  if (!active || JSON.stringify(active) !== JSON.stringify(value)) saveActiveV01Operation(value);
  return adoptV01Candidate({ operation: value, expected: selected, profile: currentProfile, readers, isCurrent });
}

let currentProfile: VerifiedV01Profile;

beforeEach(() => {
  localStorage.clear(); observations.clear(); vi.clearAllMocks(); currentProfile = profile();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback({})) } });
  observer.mockImplementation(async ({ role, hash }) => {
    const value = observations.get(`${role}:${hash.toLowerCase()}`);
    if (!value) throw new Error("UNEXPECTED_CANDIDATE");
    return structuredClone(value);
  });
});

describe("v0.1 candidate adoption", () => {
  it("requires the origin lock and does not observe or persist on contention", async () => {
    const value = operation(), matched = expected(value, "approval", APPROVAL_HASH);
    saveActiveV01Operation(value);
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await expect(adopt(value, matched)).rejects.toThrow("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE");
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback(null) } });
    await expect(adopt(value, matched)).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
    expect(observer).not.toHaveBeenCalled();
    expect(readEvmSwapRecoveryJournal()).toEqual([]);
    expect(readActiveV01Operation()).toEqual(value);
  });

  it("requires a missing approval to be adopted first, without inventing its hash", async () => {
    const value = operation(true, ["approval", "swap"]), swap = expected(value, "swap", SWAP_HASH);
    await expect(adopt(value, swap)).rejects.toThrow("V01_ADOPT_APPROVAL_FIRST");
    expect(observer).not.toHaveBeenCalled();
    expect(readEvmSwapRecoveryJournal()).toEqual([]);
    expect(readActiveV01Operation()).toEqual(value);
  });

  it("discards results when journal, operation, preview or session changes during IO", async () => {
    for (const changed of ["journal", "operation", "preview", "session"] as const) {
      localStorage.clear();
      const value = operation(), matched = expected(value, "approval", APPROVAL_HASH);
      saveActiveV01Operation(value);
      let current = true;
      observer.mockImplementationOnce(async () => {
        const result = structuredClone(matched);
        if (changed === "journal") localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, JSON.stringify({ schema: "localswap.evm-swap-recovery-journal.v1", records: [] }));
        if (changed === "operation") saveActiveV01Operation({ ...value, recoveryId: value.recovery.recoveryId });
        if (changed === "preview") matched.hash = `0x${"9".repeat(64)}`;
        if (changed === "session") current = false;
        return result;
      });
      await expect(adoptV01Candidate({ operation: value, expected: matched, profile: currentProfile, readers, isCurrent: () => current })).rejects.toThrow("V01_CANDIDATE_CONTEXT_CHANGED");
      expect(readEvmSwapRecoveryJournal()).toEqual([]);
      expect(readActiveV01Operation()).toEqual(changed === "operation" ? { ...value, recoveryId: value.recovery.recoveryId } : value);
    }
  });

  it("persists a successful approval, then appends the successful swap", async () => {
    const base = operation();
    const approval = expected(base, "approval", APPROVAL_HASH);
    setObservations(approval);
    const first = await adopt(base, approval);
    expect(first).toMatchObject({ stage: "approval-confirmed", revision: 1, transactions: [{ role: "approval", hash: APPROVAL_HASH, confirmations: 2 }] });

    const resumed = appendSwap(base), swap = expected(resumed, "swap", SWAP_HASH);
    setObservations(approval, swap);
    const second = await adopt(resumed, swap);
    expect(second).toMatchObject({ stage: "swap-confirmed", revision: 2, transactions: [{ role: "approval" }, { role: "swap", hash: SWAP_HASH }] });
    expect(readActiveV01Operation()).toMatchObject({ recoveryId: base.recovery.recoveryId, attempts: [{ role: "approval" }, { role: "swap" }] });
    expect(readEvmSwapRecoveryJournal()).toHaveLength(1);
  });

  it("adopts a swap against a preexisting partial approval journal", async () => {
    const base = operation(), approval = expected(base, "approval", APPROVAL_HASH);
    setObservations(approval);
    await adopt(base, approval);
    const resumed = appendSwap(base), swap = expected(resumed, "swap", SWAP_HASH);
    setObservations(approval, swap);
    const record = await adopt(resumed, swap);
    expect(record.stage).toBe("swap-confirmed");
    expect(record.transactions.map(item => item.role)).toEqual(["approval", "swap"]);
  });

  it("supports a swap-only intent without inventing an approval", async () => {
    const value = operation(false), swap = expected(value, "swap", SWAP_HASH);
    setObservations(swap);
    const record = await adopt(value, swap);
    expect(record).toMatchObject({ stage: "swap-confirmed", transactions: [{ role: "swap", hash: SWAP_HASH }] });
    expect(record.transactions).toHaveLength(1);
  });

  it("requires two confirmations and rejects a candidate with only one", async () => {
    const value = operation(), approval = expected(value, "approval", APPROVAL_HASH, 1, 1);
    setObservations(approval);
    await expect(adopt(value, approval)).rejects.toThrow("V01_CANDIDATE_CONFIRMATIONS_REQUIRED");
    expect(readEvmSwapRecoveryJournal()).toEqual([]);
  });

  it("rejects an expected-observation mismatch and a changed adoption context", async () => {
    const value = operation(), matched = expected(value, "approval", APPROVAL_HASH);
    setObservations(matched);
    await expect(adopt(value, { ...matched, blockHash: HEAD_HASH })).rejects.toThrow("V01_CANDIDATE_ADOPTION_MISMATCH");
    await expect(adopt(value, matched, () => false)).rejects.toThrow("V01_CANDIDATE_CONTEXT_CHANGED");
  });

  it("requires the original v3 recovery intent instead of adopting a v2 operation", async () => {
    const value = operation(), { recovery: _recovery, ...v2 } = value;
    const legacy = { ...v2, schema: "realdex.v01-active-operation.v2" as const } as ActiveV01Operation;
    const matched = expected(legacy, "approval", APPROVAL_HASH);
    setObservations(matched);
    await expect(adopt(legacy, matched)).rejects.toThrow("V01_ORIGINAL_RECOVERY_INTENT_REQUIRED");
  });

  it("leaves the journal durable when ID attachment fails, then repairs it on a fresh retry", async () => {
    const value = operation(), matched = expected(value, "approval", APPROVAL_HASH);
    setObservations(matched);
    saveActiveV01Operation(value);
    const original = Storage.prototype.setItem;
    const failed = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, data) {
      if (key === "realdex:v01-active-operation:v1") throw new Error("ACTIVE_ID_ATTACHMENT_FAILED");
      return original.call(this, key, data);
    });
    await expect(adopt(value, matched)).rejects.toThrow("ACTIVE_ID_ATTACHMENT_FAILED");
    expect(readEvmSwapRecoveryJournal()).toMatchObject([{ stage: "approval-confirmed", revision: 1 }]);
    expect(readActiveV01Operation()).toMatchObject({ recoveryId: null });
    failed.mockRestore();
    const retried = await adopt(value, matched);
    expect(retried.revision).toBe(2);
    expect(readActiveV01Operation()).toMatchObject({ recoveryId: value.recovery.recoveryId });
  });

  it("does not attach an operation ID when the journal write fails", async () => {
    const value = operation(), matched = expected(value, "approval", APPROVAL_HASH);
    setObservations(matched);
    const original = Storage.prototype.setItem;
    const failed = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, data) {
      if (key === EVM_SWAP_RECOVERY_STORAGE_KEY) throw new Error("JOURNAL_WRITE_FAILED");
      return original.call(this, key, data);
    });
    await expect(adopt(value, matched)).rejects.toThrow("JOURNAL_WRITE_FAILED");
    failed.mockRestore();
    expect(readEvmSwapRecoveryJournal()).toEqual([]);
    expect(readActiveV01Operation()).toMatchObject({ intentId: value.intentId, recoveryId: null });
  });

  it("rejects existing history with a different hash, fixed field, or envelope", async () => {
    const value = operation(), matched = expected(value, "approval", APPROVAL_HASH);
    setObservations(matched);
    await adopt(value, matched);
    const attached = { ...value, recoveryId: value.recovery.recoveryId };
    const baseline = JSON.parse(localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY)!);
    for (const kind of ["hash", "fixed", "envelope"] as const) {
      const journal = structuredClone(baseline);
      const record = journal.records[0];
      if (kind === "hash") record.transactions[0].hash = `0x${"9".repeat(64)}`;
      if (kind === "fixed") record.routeId = "different-route";
      if (kind === "envelope") record.transactions[0].envelope.data = "0x";
      localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, JSON.stringify(journal));
      await expect(adopt(attached, matched)).rejects.toThrow("V01_CANDIDATE_ADOPTION_MISMATCH");
      expect(localStorage.getItem(EVM_SWAP_RECOVERY_STORAGE_KEY)).toBe(JSON.stringify(journal));
      expect(readActiveV01Operation()).toEqual(attached);
      localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, JSON.stringify(baseline));
    }
  });

  it("does not overwrite a preexisting terminal swap state", async () => {
    const base = operation(), approval = expected(base, "approval", APPROVAL_HASH);
    setObservations(approval);
    await adopt(base, approval);
    const complete = appendSwap(base), swap = expected(complete, "swap", SWAP_HASH);
    setObservations(approval, swap);
    await adopt(complete, swap);
    const conflicting = expected(complete, "swap", SWAP_HASH, 0);
    setObservations(approval, conflicting);
    await expect(adopt(complete, conflicting)).rejects.toThrow("V01_CANDIDATE_ADOPTION_MISMATCH");
    expect(readEvmSwapRecoveryJournal()[0]).toMatchObject({ stage: "swap-confirmed", revision: 2 });
  });
});
