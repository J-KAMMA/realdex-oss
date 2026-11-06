/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeDescriptorFingerprint, routeRequestFingerprint } from "../routing/engine";
import type { RouteExecutionReceipt, RouteQuote, RouteQuoteRequest } from "../routing/types";
import { createLocalAmmRouteDescriptor } from "../swap/evm-local-amm";
import {
  EVM_SWAP_RECOVERY_STORAGE_KEY,
  assertEvmSwapRecoveryCapacity,
  readEvmSwapRecoveryJournal,
  recordEvmSwapReceipt,
  refreshEvmSwapRecovery,
  writeEvmSwapRecoveryRecord,
  type EvmSwapRecoveryRecord
} from "../swap/evm-swap-recovery";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { readActiveV01Operation, saveActiveV01Operation } from "./active-operation";
import type { VerifiedV01Profile } from "../release/v01-profile";

// Profile acceptance is private by design. Keep that boundary mocked while
// using the real route and EVM recovery validators for every fixture record.
vi.mock("../release/v01-profile", async () => ({
  ...await vi.importActual<typeof import("../release/v01-profile")>("../release/v01-profile"),
  assertCurrentV01Profile: vi.fn()
}));

import { assertCurrentV01Profile } from "../release/v01-profile";
import {
  isV01HistorySettled,
  prepareV01HistoryExport,
  removeV01ExportedHistory,
  type V01HistoryExport
} from "./history-retention";

const POOL = "0x1000000000000000000000000000000000000001";
const AMBR = "0x2000000000000000000000000000000000000002";
const JADE = "0x3000000000000000000000000000000000000003";
const ACCOUNT = "0x4000000000000000000000000000000000000004";
const FACTORY = "0x5000000000000000000000000000000000000005";
const BLOCK_HASH = `0x${"c".repeat(64)}`;
const SWAP_HASH = `0x${"b".repeat(64)}`;
const route = createLocalAmmRouteDescriptor({
  chainId: 84532n, poolAddress: POOL, tokenIn: AMBR, tokenOut: JADE,
  factoryAddress: FACTORY, venueId: "v01", venueLabel: "RealDEX v0.1 test tokens"
});

const profile = {
  status: "verified-profile", fingerprint: `0x${"a".repeat(64)}`,
  verifiedAt: Date.now() - 1_000, expiresAt: Date.now() + 300_000,
  readerIds: ["rpc-a", "rpc-b"], routes: [route],
  profile: { pool: { address: POOL } }
} as unknown as VerifiedV01Profile;
const profileAssertion = vi.mocked(assertCurrentV01Profile);

function request(tag: number): RouteQuoteRequest {
  const accountId = `eip155:84532:${ACCOUNT}`;
  return {
    executionIntentId: `realdex-intent:v1:00000000-0000-4000-8000-${String(tag).padStart(12, "0")}`,
    sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset,
    amountInBaseUnits: 1_000n, accountId, recipient: ACCOUNT,
    walletCapabilityId: "eip1193", sessionRevision: 1,
    walletGrant: createProviderBindingGrant({
      transportId: "test:history", accountId, walletCapabilityId: "eip1193",
      sessionRevision: 1, expiresAt: Date.now() + 300_000
    }), slippageBps: 50
  };
}

function quote(input: RouteQuoteRequest, tag: number): RouteQuote {
  return {
    quoteId: `quote:history:${tag}`, routeId: route.id,
    routeFingerprint: routeDescriptorFingerprint(route), requestFingerprint: routeRequestFingerprint(input),
    adapterId: route.adapterId, amountInBaseUnits: input.amountInBaseUnits,
    expectedOutBaseUnits: 900n, minimumOutBaseUnits: 890n, fees: [], unpricedCosts: [],
    expiresAt: Date.now() + 60_000, estimatedSeconds: null,
    authorization: { type: "approval", spender: POOL, amountBaseUnits: input.amountInBaseUnits, expiresAt: null },
    executionPreview: { chainId: "eip155:84532", target: POOL, method: route.executionMethod, valueBaseUnits: 0n },
    adapterData: { format: "test", value: {} }
  };
}

function submitted(tag: number): EvmSwapRecoveryRecord {
  const input = request(tag), selectedQuote = quote(input, tag);
  const receipt: RouteExecutionReceipt = {
    executionId: `evm-swap:history:${tag}`, quoteId: selectedQuote.quoteId,
    state: "pending", provider: "history-fixture", steps: [{
      name: "Swap", state: "submitted", kind: "swap", txHash: SWAP_HASH,
      evmTransaction: {
        from: ACCOUNT, to: POOL, nonce: tag, data: "0x1234", valueBaseUnits: "0",
        chainId: "84532", observedBeforeBlock: 90
      }
    }]
  };
  return recordEvmSwapReceipt(route, input, selectedQuote, receipt, {
    sourceSymbol: "AMBR", sourceDecimals: 18, destinationSymbol: "JADE", destinationDecimals: 18
  }, undefined, Date.now())!;
}

async function settled(tag: number, status: 0 | 1 = 1): Promise<EvmSwapRecoveryRecord> {
  const record = submitted(tag);
  return refreshEvmSwapRecovery(record, {
    chainId: async () => 84532n, blockNumber: async () => 101,
    receipt: async hash => ({ transactionHash: hash, status, blockNumber: 100, blockHash: BLOCK_HASH }),
    transaction: async () => null, transactionCount: async () => 0,
    block: async number => ({ number, hash: BLOCK_HASH, transactions: [] })
  }, Date.now() + 1);
}

function store(record: EvmSwapRecoveryRecord): void { writeEvmSwapRecoveryRecord(record); }
async function archive(record: EvmSwapRecoveryRecord): Promise<V01HistoryExport> {
  store(record);
  return prepareV01HistoryExport(record);
}
function removeOptions(value: V01HistoryExport, overrides: Partial<Parameters<typeof removeV01ExportedHistory>[0]> = {}) {
  return { archive: value, savedCopyConfirmed: true, profile, isCurrent: () => true, ...overrides };
}

beforeEach(() => {
  localStorage.clear();
  profileAssertion.mockImplementation((value: VerifiedV01Profile | undefined) => {
    if (!value || Date.now() >= value.expiresAt) throw new Error("V01_PROFILE_EXPIRED");
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback({})) }
  });
});

describe("v0.1 history retention", () => {
  it("exports exactly the selected validated record and no other local storage data", async () => {
    const record = await settled(601);
    localStorage.setItem("unrelated-secret", "must-stay-local");
    const value = await archive(record);
    expect(value.record).toEqual(record);
    const parsed = JSON.parse(value.serialized);
    expect(Object.keys(parsed).sort()).toEqual(["exportedAt", "record", "recordFingerprint", "schema"]);
    expect(parsed.record).toEqual(record);
    expect(value.serialized).not.toContain("unrelated-secret");
    expect(localStorage.getItem("unrelated-secret")).toBe("must-stay-local");
  });

  it("settles only terminal confirmed or reverted v3 records", async () => {
    expect(isV01HistorySettled(await settled(602, 1))).toBe(true);
    expect(isV01HistorySettled(await settled(603, 0))).toBe(true);
    const confirmed = await settled(604);
    const invalid = [
      { ...confirmed, stage: "unknown" as const, transactions: confirmed.transactions.map(tx => ({ ...tx, state: "unknown" as const })) },
      { ...confirmed, stage: "swap-submitted" as const, transactions: confirmed.transactions.map(tx => ({ ...tx, state: "submitted" as const })) },
      { ...confirmed, stage: "swap-replaced" as const, transactions: confirmed.transactions.map(tx => ({ ...tx, state: "replaced" as const })) },
      { ...confirmed, transactions: confirmed.transactions.map(tx => ({ ...tx, state: "reverted" as const })) }
    ];
    for (const value of invalid) expect(isV01HistorySettled(value)).toBe(false);
    expect(isV01HistorySettled({ ...confirmed, schema: "localswap.evm-swap-recovery.v2", recoveryId: "fnv1a:12345678", routeFingerprint: "fnv1a:12345678", requestFingerprint: "fnv1a:12345678" })).toBe(false);
    expect(isV01HistorySettled({ ...confirmed, transactions: confirmed.transactions.map(tx => ({ ...tx, confirmations: 1 })) })).toBe(false);
  });

  it("requires an explicitly confirmed saved copy and a genuine prepared archive", async () => {
    const value = await archive(await settled(605));
    await expect(removeV01ExportedHistory(removeOptions(value, { savedCopyConfirmed: false }))).rejects.toThrow("V01_HISTORY_COPY_REQUIRED");
    await expect(removeV01ExportedHistory(removeOptions(structuredClone(value) as V01HistoryExport))).rejects.toThrow("V01_HISTORY_COPY_REQUIRED");
  });

  it("expires the removal preview without deleting the record", async () => {
    const record = await settled(640), value = await archive(record);
    const clock = vi.spyOn(Date, "now").mockReturnValue(value.expiresAt);
    try {
      await expect(removeV01ExportedHistory(removeOptions(value, { profile: { ...profile, expiresAt: value.expiresAt + 60_000 } }))).rejects.toThrow("V01_HISTORY_CHANGED");
      expect(readEvmSwapRecoveryJournal()).toEqual([record]);
    } finally { clock.mockRestore(); }
  });

  it("rechecks explicit confirmation after acquiring the operation lock", async () => {
    const record = await settled(641), value = await archive(record);
    let enter!: () => void;
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => new Promise((resolve, reject) => {
        enter = () => { Promise.resolve(callback({})).then(resolve, reject); };
      })
    } });
    const options = removeOptions(value);
    const pending = removeV01ExportedHistory(options);
    options.savedCopyConfirmed = false;
    enter();
    await expect(pending).rejects.toThrow("V01_HISTORY_COPY_REQUIRED");
    expect(readEvmSwapRecoveryJournal()).toEqual([record]);
  });

  it("blocks changed target, revision, and exported record snapshots", async () => {
    const record = await settled(606), value = await archive(record);
    value.record.executionTarget = JADE;
    await expect(removeV01ExportedHistory(removeOptions(value))).rejects.toThrow("V01_HISTORY_CHANGED");

    const second = await archive(await settled(607));
    second.record.revision += 1;
    await expect(removeV01ExportedHistory(removeOptions(second))).rejects.toThrow("V01_HISTORY_CHANGED");

    const thirdRecord = await settled(608);
    const third = await archive(thirdRecord);
    localStorage.setItem(EVM_SWAP_RECOVERY_STORAGE_KEY, JSON.stringify({
      schema: "localswap.evm-swap-recovery-journal.v1",
      records: [{ ...thirdRecord, revision: thirdRecord.revision + 1 }]
    }));
    await expect(removeV01ExportedHistory(removeOptions(third))).rejects.toThrow("V01_HISTORY_NOT_SETTLED");
  });

  it("blocks any active operation, including a different recovery ID, without mutating it or secrets", async () => {
    const value = await archive(await settled(609));
    const active = {
      schema: "realdex.v01-active-operation.v1" as const,
      intentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000999",
      quoteId: "different-quote", profileFingerprint: `0x${"f".repeat(64)}`, recoveryId: null
    };
    saveActiveV01Operation(active);
    localStorage.setItem("wallet-secret-placeholder", "unchanged");
    const activeRaw = localStorage.getItem("realdex:v01-active-operation:v1");
    await expect(removeV01ExportedHistory(removeOptions(value))).rejects.toThrow("V01_HISTORY_ACTIVE_OPERATION");
    expect(localStorage.getItem("realdex:v01-active-operation:v1")).toBe(activeRaw);
    expect(localStorage.getItem("wallet-secret-placeholder")).toBe("unchanged");
    expect(readActiveV01Operation()).toEqual(active);
  });

  it("rejects profile mismatch, expiry, and a changed current session", async () => {
    const value = await archive(await settled(610));
    const mismatch = { ...profile, routes: [] } as unknown as VerifiedV01Profile;
    await expect(removeV01ExportedHistory(removeOptions(value, { profile: mismatch }))).rejects.toThrow("V01_HISTORY_PROFILE_MISMATCH");
    const expired = { ...profile, expiresAt: Date.now() - 1 } as VerifiedV01Profile;
    await expect(removeV01ExportedHistory(removeOptions(value, { profile: expired }))).rejects.toThrow("V01_PROFILE_EXPIRED");
    await expect(removeV01ExportedHistory(removeOptions(value, { isCurrent: () => false }))).rejects.toThrow("V01_HISTORY_CHANGED");
  });

  it("removes one selected record while retaining unrelated journal entries", async () => {
    const selected = await settled(611), unrelated = await settled(612);
    store(selected); store(unrelated);
    const value = await prepareV01HistoryExport(selected);
    await removeV01ExportedHistory(removeOptions(value));
    expect(readEvmSwapRecoveryJournal().map(record => record.recoveryId)).toEqual([unrelated.recoveryId]);
  });

  it("consumes an archive before an uncertain write and never retries automatically", async () => {
    const value = await archive(await settled(613));
    const original = Storage.prototype.setItem;
    const failed = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, data) {
      if (key === EVM_SWAP_RECOVERY_STORAGE_KEY) return original.call(this, key, `${data} `);
      return original.call(this, key, data);
    });
    await expect(removeV01ExportedHistory(removeOptions(value))).rejects.toThrow("V01_HISTORY_REMOVAL_UNCONFIRMED");
    failed.mockRestore();
    await expect(removeV01ExportedHistory(removeOptions(value))).rejects.toThrow("V01_HISTORY_COPY_REQUIRED");
  });

  it("fails closed when the Web Lock is unavailable or contended", async () => {
    const value = await archive(await settled(614));
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await expect(removeV01ExportedHistory(removeOptions(value))).rejects.toThrow("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback(null)) }
    });
    await expect(removeV01ExportedHistory(removeOptions(value))).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
    expect(readEvmSwapRecoveryJournal()).toHaveLength(1);
  });

  it("returns capacity from 16 to 15 only after explicit removal", async () => {
    const records = [] as EvmSwapRecoveryRecord[];
    for (let tag = 615; tag < 631; tag++) { const record = await settled(tag); records.push(record); store(record); }
    expect(() => assertEvmSwapRecoveryCapacity()).toThrow("EVM_SWAP_RECOVERY_STORAGE_FULL");
    const value = await prepareV01HistoryExport(records[0]);
    await removeV01ExportedHistory(removeOptions(value));
    expect(readEvmSwapRecoveryJournal()).toHaveLength(15);
    expect(() => assertEvmSwapRecoveryCapacity()).not.toThrow();
  });
});
