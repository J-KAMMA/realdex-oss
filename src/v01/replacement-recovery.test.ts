/** @vitest-environment jsdom */
import { Interface, getAddress } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { routeDescriptorFingerprint } from "../routing/engine";
import { createLocalAmmRouteDescriptor } from "../swap/evm-local-amm";
import { evmSwapRecoveryIdentity, type EvmSwapRecoveryRecord, type EvmSwapRecoveryTransaction } from "../swap/evm-swap-recovery";
import type { VerifiedV01Profile } from "../release/v01-profile";
import type { ActiveV01Operation } from "./active-operation";
import { canCloseV01Operation } from "./active-operation";
import type { V01RecoveryIntent } from "./recovery-intent";
import type { V01CandidateReader } from "./candidate-reconciliation";

// Keep the real recovery-intent, active-operation, and recovery-record
// validators. Only the profile's identity assertion is a genuine boundary
// mock: this suite uses a reviewed-profile-shaped fixture without performing
// deployment verification or network discovery.
vi.mock("../release/v01-profile", async () => ({
  ...await vi.importActual<typeof import("../release/v01-profile")>("../release/v01-profile"),
  assertCurrentV01Profile: vi.fn(), assertV01Route: vi.fn()
}));

import { verifyV01ReplacementRecovery } from "./replacement-recovery";

const POOL = getAddress("0x1000000000000000000000000000000000000001");
const AMBR = getAddress("0x2000000000000000000000000000000000000002");
const JADE = getAddress("0x3000000000000000000000000000000000000003");
const ACCOUNT = getAddress("0x4000000000000000000000000000000000000004");
const FACTORY = getAddress("0x5000000000000000000000000000000000000005");
const INTENT_ID = "realdex-intent:v1:00000000-0000-4000-8000-000000000901";
const QUOTE_ID = "replacement-recovery-901";
const PROFILE_FINGERPRINT = `0x${"a".repeat(64)}`;
const REQUEST_FINGERPRINT = `0x${"f".repeat(64)}`;
const ORIGINAL_APPROVAL_HASH = `0x${"1".repeat(64)}`;
const ORIGINAL_SWAP_HASH = `0x${"2".repeat(64)}`;
const REPLACEMENT_HASH = `0x${"3".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const HEAD_HASH = `0x${"c".repeat(64)}`;
const BAD_HASH = `0x${"d".repeat(64)}`;
const OBSERVED_BEFORE_BLOCK = 100;
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
      deployment: {
        releaseId: "replacement-recovery-fixture",
        contracts: { factory: { address: FACTORY }, router: { address: getAddress("0x6000000000000000000000000000000000000006") } },
        source: { bundleSha256: `0x${"d".repeat(64)}` }
      },
      pool: { address: POOL, runtimeCodeHash: `0x${"e".repeat(64)}` },
      tokens: { ambr: AMBR, jade: JADE }
    },
    fingerprint: PROFILE_FINGERPRINT, verifiedAt: now - 1_000, expiresAt: now + 60_000,
    readerIds: ["rpc-a", "rpc-b"], routes: [route]
  } as unknown as VerifiedV01Profile;
}

function intent(value: VerifiedV01Profile, approvalRequired: boolean): V01RecoveryIntent {
  const capturedAt = Date.now() - 1_000;
  const routeFingerprint = routeDescriptorFingerprint(route);
  return {
    schema: "realdex.v01-recovery-intent.v1", intentId: INTENT_ID, profileFingerprint: value.fingerprint,
    recoveryId: evmSwapRecoveryIdentity(routeFingerprint, REQUEST_FINGERPRINT, QUOTE_ID), routeId: route.id,
    routeFingerprint, quoteId: QUOTE_ID, requestFingerprint: REQUEST_FINGERPRINT,
    accountId: `eip155:84532:${ACCOUNT}`, recipient: ACCOUNT,
    sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset,
    amountInBaseUnits: "1000", minimumOutBaseUnits: "890", poolAddress: POOL,
    quoteExpiresAt: capturedAt + 30_000, approvalRequired, capturedAt
  };
}

function attempt(value: V01RecoveryIntent, role: "approval" | "swap", nonce: number) {
  const data = role === "approval"
    ? new Interface(ERC20_ABI).encodeFunctionData("approve", [value.poolAddress, value.amountInBaseUnits])
    : new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [AMBR, value.amountInBaseUnits, value.minimumOutBaseUnits, value.recipient, Math.floor(value.quoteExpiresAt / 1000)]);
  return {
    intentId: value.intentId, quoteId: value.quoteId, profileFingerprint: value.profileFingerprint,
    role, observedBeforeBlock: OBSERVED_BEFORE_BLOCK,
    transaction: {
      from: ACCOUNT, to: role === "approval" ? AMBR : POOL, data, value: "0x0", chainId: "0x14a34", type: "0x2",
      nonce: `0x${nonce.toString(16)}`, gas: "0x186a0", maxFeePerGas: "0x64", maxPriorityFeePerGas: "0x1"
    }
  };
}

function operation(approvalRequired = true, roles: ("approval" | "swap")[] = approvalRequired ? ["approval", "swap"] : ["swap"]): Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v3" }> {
  const value = intent(profile(), approvalRequired);
  return {
    schema: "realdex.v01-active-operation.v3", intentId: value.intentId, quoteId: value.quoteId,
    profileFingerprint: value.profileFingerprint, recoveryId: value.recoveryId,
    attempts: roles.map((role, index) => attempt(value, role, approvalRequired ? index + 1 : 1)), recovery: value
  };
}

type ReplacementReason = "repriced" | "cancelled" | "replaced";
type FixtureOptions = {
  approvalRequired?: boolean;
  roles?: ("approval" | "swap")[];
  replacement?: { role?: "approval" | "swap"; from?: string; to?: string; nonce?: number; chainId?: string; data?: string; valueBaseUnits?: string; reason?: ReplacementReason; hash?: string } | null;
  savedBlock?: { blockNumber: number; blockHash: string; confirmations: number } | null;
  status?: 0 | 1;
  head?: number;
  readerBBlockHash?: string;
  readerBHeadHash?: string;
  reorgOnCanonicalReread?: boolean;
  readOperation?: () => ActiveV01Operation | null;
  readRecord?: () => EvmSwapRecoveryRecord | undefined;
  isCurrent?: () => boolean;
};

type RawTx = {
  hash: string; from: string; to: string; input: string; value: string; chainId: string; type: string;
  nonce: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; accessList: unknown[];
  blockNumber: string; blockHash: string;
};

function hex(value: number | bigint): string { return `0x${BigInt(value).toString(16)}`; }

function fixture(options: FixtureOptions = {}) {
  const p = profile();
  const approvalRequired = options.approvalRequired ?? true;
  const roles = options.roles ?? (approvalRequired ? ["approval", "swap"] : ["swap"]);
  const op = operation(approvalRequired, roles);
  const savedBlock = options.savedBlock === undefined ? null : options.savedBlock;
  const savedTransactions: EvmSwapRecoveryTransaction[] = roles.map(role => {
    const tx = op.attempts.find(item => item.role === role)!.transaction;
    const hash = role === "approval" ? ORIGINAL_APPROVAL_HASH : ORIGINAL_SWAP_HASH;
    const replacement = options.replacement && (options.replacement.role ?? roles[roles.length - 1]) === role
      ? {
          from: options.replacement.from ?? ACCOUNT, to: options.replacement.to ?? tx.to, nonce: options.replacement.nonce ?? Number(BigInt(tx.nonce)),
          data: (options.replacement.data ?? tx.data).toLowerCase(), valueBaseUnits: options.replacement.valueBaseUnits ?? "0",
          chainId: options.replacement.chainId ?? "84532", hash: options.replacement.hash ?? REPLACEMENT_HASH,
          reason: options.replacement.reason ?? (options.replacement.to?.toLowerCase() === ACCOUNT.toLowerCase() ? "cancelled" : "replaced")
        } as const : undefined;
    return {
      role, hash, state: "submitted", blockNumber: savedBlock?.blockNumber ?? null,
      blockHash: savedBlock?.blockHash ?? null, confirmations: savedBlock?.confirmations ?? 0,
      envelope: {
        from: ACCOUNT, to: tx.to, nonce: Number(BigInt(tx.nonce)), data: tx.data.toLowerCase(), valueBaseUnits: "0", chainId: "84532",
        observedBeforeBlock: OBSERVED_BEFORE_BLOCK, ...(replacement ? { replacement } : {})
      }, nextSearchBlock: OBSERVED_BEFORE_BLOCK + 1
    };
  });
  const record: EvmSwapRecoveryRecord = {
    schema: "realdex.evm-swap-recovery.v3", recoveryId: op.recovery.recoveryId, executionId: "execution-replacement-901",
    routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), quoteId: op.quoteId,
    requestFingerprint: op.recovery.requestFingerprint, chainId: "eip155:84532", accountId: op.recovery.accountId,
    recipient: ACCOUNT,
    source: { assetType: route.sourceAsset, symbol: "AMBR", decimals: 18, amountBaseUnits: "1000" },
    destination: { assetType: route.destinationAsset, symbol: "JADE", decimals: 18, minimumOutBaseUnits: "890" },
    executionTarget: POOL, executionMethod: route.executionMethod, provider: "raw-rpc-fixture",
    stage: roles.includes("swap") ? "swap-included" : "approval-submitted", transactions: savedTransactions,
    requiredConfirmations: 2, revision: 7, createdAt: Date.now() - 5_000, updatedAt: Date.now() - 1_000
  };
  const replacement = options.replacement;
  const readers = ["rpc-a", "rpc-b"].map((id, index) => readerFor(id, op, record, index === 1 ? {
    blockHash: options.readerBBlockHash, headHash: options.readerBHeadHash
  } : {}, options));
  return { p, op, record, readers, verify: () => verifyV01ReplacementRecovery({
    operation: op, record, profile: p, readers, readOperation: options.readOperation ?? (() => op),
    readRecord: options.readRecord ?? (() => record), isCurrent: options.isCurrent ?? (() => true)
  }), replacement };
}

function readerFor(id: string, op: Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v3" }>, record: EvmSwapRecoveryRecord, readerOptions: { blockHash?: string; headHash?: string }, options: FixtureOptions): V01CandidateReader {
  let canonicalReads = 0;
  const configuredHead = options.head ?? HEAD;
  return {
    id,
    send: vi.fn(async (method: string, params: unknown[]) => {
      const requested = String(params[0] ?? "");
      const transaction = record.transactions.find(item => (item.envelope?.replacement?.hash ?? item.hash).toLowerCase() === String(params[0] ?? "").toLowerCase());
      const saved = transaction ?? record.transactions[0];
      const attempt = op.attempts.find(item => item.role === saved.role)!;
      const original = saved.envelope!;
      const replacement = original.replacement;
      const effectiveHash = replacement?.hash ?? saved.hash;
      const effective = replacement ?? original;
      const blockHash = readerOptions.blockHash ?? BLOCK_HASH;
      const headHash = readerOptions.headHash ?? HEAD_HASH;
      const rawTx: RawTx = {
        hash: effectiveHash, from: effective.from, to: effective.to, input: effective.data, value: hex(BigInt(effective.valueBaseUnits)), chainId: hex(BigInt(effective.chainId)),
        type: attempt.transaction.type, nonce: hex(effective.nonce), gas: attempt.transaction.gas, maxFeePerGas: attempt.transaction.maxFeePerGas,
        maxPriorityFeePerGas: attempt.transaction.maxPriorityFeePerGas, accessList: [], blockNumber: hex(INCLUDED_BLOCK), blockHash
      };
      switch (method) {
        case "eth_chainId": return "0x14a34";
        case "eth_getTransactionByHash": return rawTx;
        case "eth_getTransactionReceipt": return {
          transactionHash: effectiveHash, from: effective.from, to: effective.to, blockNumber: hex(INCLUDED_BLOCK), blockHash,
          status: hex(saved.role === "swap" ? (options.status ?? 1) : 1)
        };
        case "eth_blockNumber": return hex(configuredHead);
        case "eth_getBlockByNumber": {
          const number = Number(BigInt(requested));
          if (number === INCLUDED_BLOCK) {
            canonicalReads += 1;
            const reorged = options.reorgOnCanonicalReread && canonicalReads > record.transactions.length;
            return { number: hex(number), hash: reorged ? BAD_HASH : blockHash, transactions: record.transactions.map(item => item.envelope?.replacement?.hash ?? item.hash) };
          }
          return { number: hex(number), hash: headHash, transactions: [] };
        }
        default: throw new Error(`UNEXPECTED_RPC_METHOD:${method}`);
      }
    })
  };
}

function expectInputsUnchanged(fixtureValue: ReturnType<typeof fixture>, beforeOperation: ActiveV01Operation, beforeRecord: EvmSwapRecoveryRecord) {
  expect(fixtureValue.op).toEqual(beforeOperation);
  expect(fixtureValue.record).toEqual(beforeRecord);
}

describe("v0.1 replacement recovery", () => {
  beforeEach(() => vi.useRealTimers());

  it("accepts same-content repricing and advances the record without mutating inputs", async () => {
    const f = fixture({ replacement: { role: "swap", reason: "repriced" } });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    const result = await f.verify();
    expect(result.stage).toBe("swap-confirmed");
    expect(result.transactions.find(tx => tx.role === "swap")).toMatchObject({ state: "confirmed", hash: ORIGINAL_SWAP_HASH, confirmations: 2, blockNumber: INCLUDED_BLOCK });
    expect(result.transactions.find(tx => tx.role === "swap")?.envelope?.replacement?.reason).toBe("repriced");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("accepts a same-content repricing whose receipt reverted", async () => {
    const f = fixture({ replacement: { role: "swap", reason: "repriced" }, status: 0 });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    const result = await f.verify();
    expect(result.stage).toBe("swap-reverted");
    expect(result.transactions.find(tx => tx.role === "swap")?.state).toBe("reverted");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it.each([
    ["cancelled", { to: ACCOUNT, data: "0x", valueBaseUnits: "0", reason: "cancelled" as const }],
    ["different-content", { to: POOL, data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [JADE, 1000n, 890n, ACCOUNT, 2_000_000_100n]), reason: "replaced" as const }]
  ])("classifies a swap %s replacement as replaced", async (_label, replacement) => {
    const f = fixture({ replacement: { role: "swap", ...replacement } });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    const result = await f.verify();
    expect(result.stage).toBe("swap-replaced");
    expect(result.transactions.find(tx => tx.role === "swap")?.state).toBe("replaced");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("accepts replacement recovery for an approval-only operation", async () => {
    const f = fixture({ roles: ["approval"], replacement: { role: "approval", to: ACCOUNT, data: "0x", reason: "cancelled" } });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    const result = await f.verify();
    expect(result.stage).toBe("approval-replaced");
    expect(result.transactions[0]).toMatchObject({ role: "approval", state: "replaced", confirmations: 2 });
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("does not turn successful approval repricing into swap completion or close authority", async () => {
    const f = fixture({ roles: ["approval"], replacement: { role: "approval", reason: "repriced" } });
    const result = await f.verify();
    expect(result.stage).toBe("approval-confirmed");
    expect(canCloseV01Operation(f.op, result)).toBe(false);
    expect(result.transactions.map(tx => tx.role)).toEqual(["approval"]);
  });

  it("retains explicit stopped-before-swap evidence after approval repricing", async () => {
    const f = fixture({ roles: ["approval"], replacement: { role: "approval", reason: "repriced" } });
    f.op.attempts.push(attempt(f.op.recovery, "swap", 2));
    f.record.stage = "stopped-after-approval";
    const result = await f.verify();
    expect(result.stage).toBe("stopped-after-approval");
    expect(canCloseV01Operation(f.op, result)).toBe(true);
  });

  it.each(["type", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "accessList"])("rechecks the non-replaced approval's saved %s", async field => {
    const f = fixture({ replacement: { role: "swap", reason: "repriced" } });
    const send = f.readers[1].send;
    f.readers[1].send = async (method, params) => {
      const result = await send(method, params);
      if (method === "eth_getTransactionByHash" && params[0] === ORIGINAL_APPROVAL_HASH) (result as Record<string, unknown>)[field] = field === "accessList" ? [{ address: ACCOUNT, storageKeys: [] }] : "0x3";
      return result;
    };
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
  });

  it("rejects a journal mutation after receipt IO instead of returning an observation for new state", async () => {
    let durable: EvmSwapRecoveryRecord;
    const f = fixture({ replacement: { role: "swap", reason: "repriced" }, readRecord: () => durable });
    durable = structuredClone(f.record);
    const original = structuredClone(f.record);
    const send = f.readers[1].send;
    let changed = false;
    f.readers[1].send = async (method, params) => {
      const result = await send(method, params);
      if (method === "eth_getTransactionReceipt") { durable.revision++; changed = true; }
      return result;
    };
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_CONTEXT_CHANGED");
    expect(changed).toBe(true);
    expect(f.record).toEqual(original);
  });

  it("bounds stalled readers without waiting forever or releasing an operation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ replacement: { role: "swap", reason: "repriced" } });
      const original = structuredClone(f.op), record = structuredClone(f.record);
      f.readers[1].send = () => new Promise(() => {});
      const check = expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_TIMEOUT");
      await vi.advanceTimersByTimeAsync(15_000); await check;
      expectInputsUnchanged(f, original, record);
    } finally { vi.useRealTimers(); }
  });

  it("rejects a stored terminal replacement whose receipt later claims another outcome", async () => {
    const f = fixture({ replacement: { role: "swap", reason: "repriced" }, status: 0, savedBlock: { blockNumber: INCLUDED_BLOCK, blockHash: BLOCK_HASH, confirmations: 2 } });
    f.record.transactions.at(-1)!.state = "confirmed";
    f.record.stage = "swap-confirmed";
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
  });

  it("blocks an approval replacement when a saved operation still contains a missing swap", async () => {
    const f = fixture({ roles: ["approval"], replacement: { role: "approval", to: ACCOUNT, data: "0x", reason: "cancelled" } });
    f.op.attempts.push(attempt(f.op.recovery, "swap", 2));
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
    expect(f.readers.every(reader => vi.mocked(reader.send).mock.calls.length === 0)).toBe(true);
  });

  it.each([
    ["nonce", { nonce: 99 }], ["from", { from: JADE }], ["chain", { chainId: "1" }], ["reason", { reason: "replaced" as const }]
  ])("rejects a replacement with the wrong %s", async (_label, change) => {
    const f = fixture({ replacement: { role: "swap", to: ACCOUNT, data: "0x", reason: "cancelled", ...change } });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("rejects when the saved original envelope no longer matches the active attempt", async () => {
    const f = fixture({ replacement: { role: "swap", to: ACCOUNT, data: "0x", reason: "cancelled" } });
    f.record.transactions.find(tx => tx.role === "swap")!.envelope!.nonce = 99;
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("rejects disagreement between readers on the included canonical block", async () => {
    const f = fixture({ replacement: { role: "swap", reason: "repriced" }, readerBBlockHash: BAD_HASH });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("rejects a canonical block that changes during the final re-read", async () => {
    const f = fixture({ replacement: { role: "swap", reason: "repriced" }, reorgOnCanonicalReread: true });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("rejects disagreement on the common head even when inclusion agrees", async () => {
    const f = fixture({ replacement: { role: "swap", reason: "repriced" }, readerBHeadHash: BAD_HASH });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("requires at least two confirmations from every reader", async () => {
    const f = fixture({ replacement: { role: "swap", reason: "repriced" }, head: INCLUDED_BLOCK });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_CONFIRMATIONS_REQUIRED");
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("fails closed when the active operation context changes during reads", async () => {
    let changed = false;
    const f = fixture({ replacement: { role: "swap", reason: "repriced" }, readOperation: () => changed ? { ...f.op, quoteId: "changed" } : f.op });
    const original = f.readers[0].send;
    f.readers[0].send = vi.fn(async (method, params) => { const result = await original(method, params); if (method === "eth_getTransactionReceipt") changed = true; return result; });
    const beforeOperation = structuredClone(f.op), beforeRecord = structuredClone(f.record);
    await expect(f.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_CONTEXT_CHANGED");
    expect(changed).toBe(true);
    expectInputsUnchanged(f, beforeOperation, beforeRecord);
  });

  it("retains real legacy-schema and recovery-profile guards", async () => {
    const legacy = fixture({ replacement: { role: "swap", reason: "repriced" } });
    const legacyInput = legacy.op as unknown as Record<string, unknown>;
    delete legacyInput.recovery;
    legacyInput.schema = "realdex.v01-active-operation.v2";
    const beforeOperation = structuredClone(legacy.op), beforeRecord = structuredClone(legacy.record);
    await expect(legacy.verify()).rejects.toThrow("V01_REPLACEMENT_RECOVERY_MISMATCH");
    expectInputsUnchanged(legacy, beforeOperation as ActiveV01Operation, beforeRecord);

    const profileMismatch = fixture({ replacement: { role: "swap", reason: "repriced" } });
    profileMismatch.op.recovery.profileFingerprint = `0x${"9".repeat(64)}`;
    profileMismatch.op.profileFingerprint = profileMismatch.op.recovery.profileFingerprint;
    profileMismatch.op.attempts.forEach(item => { item.profileFingerprint = profileMismatch.op.profileFingerprint; });
    await expect(profileMismatch.verify()).rejects.toThrow("V01_RECOVERY_INTENT_INVALID");
  });
});
