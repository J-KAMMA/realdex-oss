import { Interface } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ERC20_ABI, POOL_ABI } from "../abi";
import type { VerifiedV01Profile } from "../release/v01-profile";
import type { ActiveV01Operation } from "./active-operation";

// The profile's membership assertion is covered by v01-profile.test.ts.  These
// tests deliberately isolate the candidate reconciliation boundary so that every
// JSON-RPC observation below is a raw, read-only fixture.
vi.mock("../release/v01-profile", async () => ({
  ...await vi.importActual<typeof import("../release/v01-profile")>("../release/v01-profile"),
  assertCurrentV01Profile: vi.fn()
}));

import { verifyV01Candidate } from "./candidate-reconciliation";

const CHAIN_HEX = "0x14a34";
const POOL = "0x1000000000000000000000000000000000000001";
const AMBR = "0x2000000000000000000000000000000000000002";
const JADE = "0x3000000000000000000000000000000000000003";
const ACCOUNT = "0x4000000000000000000000000000000000000004";
const FACTORY = "0x5000000000000000000000000000000000000005";
const ROUTER = "0x6000000000000000000000000000000000000006";
const INTENT = "realdex-intent:v1:00000000-0000-4000-8000-000000000901";
const QUOTE = "candidate-quote-901";
const PROFILE_FINGERPRINT = `0x${"a".repeat(64)}`;
const APPROVAL_HASH = `0x${"1".repeat(64)}`;
const SWAP_HASH = `0x${"2".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const PARENT_BLOCK_HASH = `0x${"c".repeat(64)}`;
const OBSERVED_BEFORE_BLOCK = 100;
const INCLUDED_BLOCK = 101;
const HEAD = INCLUDED_BLOCK;
const AMOUNT = 5n * 10n ** 18n;
const MINIMUM = 4n * 10n ** 18n;
const DEADLINE = 2_000_000_000n;

type RawTransaction = {
  hash: string;
  from: string;
  to: string;
  input: string;
  value: string;
  chainId: string;
  type: string;
  nonce: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  accessList: unknown[];
  blockNumber: string;
  blockHash: string;
};

type RawReceipt = {
  transactionHash: string;
  from: string;
  to: string;
  blockNumber: string;
  blockHash: string;
  status: string | number;
  transactionIndex: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  logs: unknown[];
};

type RpcReader = { id: string; send(method: string, params: unknown[]): Promise<unknown> };
type V2Operation = Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v2" }>;
type ReaderOptions = {
  chainId?: unknown;
  chainIdAfterFirst?: unknown;
  head?: number;
  tx?: Partial<RawTransaction> | null;
  receipt?: Partial<RawReceipt> | null;
  block?: Partial<{ number: string; hash: string; parentHash: string; transactions: unknown[] }> | null;
  reorgOnCanonicalReread?: boolean;
  mutateInputsOnFirstCall?: () => void;
};

const approvalInterface = new Interface(ERC20_ABI);
const poolInterface = new Interface(POOL_ABI);

function hex(value: number | bigint): string {
  return `0x${BigInt(value).toString(16)}`;
}

function profile(): VerifiedV01Profile {
  return {
    status: "verified-profile",
    profile: {
      schema: "realdex.v01-profile.v1",
      deployment: {
        releaseId: "candidate-fixture",
        contracts: { factory: { address: FACTORY }, router: { address: ROUTER } },
        source: { bundleSha256: `0x${"d".repeat(64)}` }
      },
      pool: { address: POOL, runtimeCodeHash: `0x${"e".repeat(64)}` },
      tokens: { ambr: AMBR, jade: JADE }
    },
    fingerprint: PROFILE_FINGERPRINT,
    verifiedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    readerIds: ["rpc-a", "rpc-b"],
    routes: []
  } as unknown as VerifiedV01Profile;
}

function transactionFor(role: "approval" | "swap"): RawTransaction {
  const input = role === "approval"
    ? approvalInterface.encodeFunctionData("approve", [POOL, AMOUNT])
    : poolInterface.encodeFunctionData("swapExactIn", [AMBR, AMOUNT, MINIMUM, ACCOUNT, DEADLINE]);
  return {
    hash: role === "approval" ? APPROVAL_HASH : SWAP_HASH,
    from: ACCOUNT,
    to: role === "approval" ? AMBR : POOL,
    input,
    value: "0x0",
    chainId: CHAIN_HEX,
    type: "0x2",
    nonce: role === "approval" ? "0x7" : "0x8",
    gas: role === "approval" ? "0x186a0" : "0x249f0",
    maxFeePerGas: "0x64",
    maxPriorityFeePerGas: "0x1",
    accessList: [],
    blockNumber: hex(INCLUDED_BLOCK),
    blockHash: BLOCK_HASH
  };
}

function operation(role: "approval" | "swap" = "approval", overrides: Record<string, unknown> = {}): V2Operation {
  const approval = transactionFor("approval");
  const swap = transactionFor("swap");
  return {
    schema: "realdex.v01-active-operation.v2",
    intentId: INTENT,
    quoteId: QUOTE,
    profileFingerprint: PROFILE_FINGERPRINT,
    recoveryId: null,
    attempts: [
      { intentId: INTENT, quoteId: QUOTE, profileFingerprint: PROFILE_FINGERPRINT, role: "approval", observedBeforeBlock: OBSERVED_BEFORE_BLOCK, transaction: {
        from: approval.from, to: approval.to, data: approval.input, value: approval.value, chainId: approval.chainId, type: approval.type,
        nonce: approval.nonce, gas: approval.gas, maxFeePerGas: approval.maxFeePerGas, maxPriorityFeePerGas: approval.maxPriorityFeePerGas
      } },
      { intentId: INTENT, quoteId: QUOTE, profileFingerprint: PROFILE_FINGERPRINT, role: "swap", observedBeforeBlock: OBSERVED_BEFORE_BLOCK, transaction: {
        from: swap.from, to: swap.to, data: swap.input, value: swap.value, chainId: swap.chainId, type: swap.type,
        nonce: swap.nonce, gas: swap.gas, maxFeePerGas: swap.maxFeePerGas, maxPriorityFeePerGas: swap.maxPriorityFeePerGas
      } }
    ],
    ...overrides
  } as V2Operation;
}

function legacyOperation(): ActiveV01Operation {
  const { attempts: _attempts, ...binding } = operation();
  return { ...binding, schema: "realdex.v01-active-operation.v1" } as ActiveV01Operation;
}

function rawReceipt(role: "approval" | "swap", status: 0 | 1): RawReceipt {
  return {
    transactionHash: role === "approval" ? APPROVAL_HASH : SWAP_HASH,
    from: ACCOUNT,
    to: role === "approval" ? AMBR : POOL,
    blockNumber: hex(INCLUDED_BLOCK),
    blockHash: BLOCK_HASH,
    status: hex(status),
    transactionIndex: "0x0",
    cumulativeGasUsed: "0x186a0",
    gasUsed: "0x186a0",
    logs: []
  };
}

function readerFor(role: "approval" | "swap", options: ReaderOptions = {}, id = "rpc-a"): RpcReader {
  const expectedTx = transactionFor(role);
  const expectedReceipt = rawReceipt(role, 1);
  const expectedBlock = {
    number: hex(INCLUDED_BLOCK), hash: BLOCK_HASH, parentHash: PARENT_BLOCK_HASH, transactions: [expectedTx.hash]
  };
  let blockReads = 0;
  let chainReads = 0;
  let mutated = false;
  return {
    id,
    send: vi.fn(async (method: string, _params: unknown[]) => {
      if (!mutated && options.mutateInputsOnFirstCall) {
        mutated = true;
        options.mutateInputsOnFirstCall();
      }
      switch (method) {
        case "eth_chainId":
          chainReads += 1;
          return chainReads > 1 ? (options.chainIdAfterFirst ?? options.chainId ?? CHAIN_HEX) : (options.chainId ?? CHAIN_HEX);
        case "eth_blockNumber": return hex(options.head ?? HEAD);
        case "eth_getTransactionByHash": return options.tx === null ? null : { ...expectedTx, ...options.tx };
        case "eth_getTransactionReceipt": return options.receipt === null ? null : { ...expectedReceipt, ...options.receipt };
        case "eth_getBlockByNumber":
        case "eth_getBlockByHash": {
          blockReads += 1;
          if (options.block === null) return null;
          const requested = Number(BigInt(String(_params[0] ?? hex(INCLUDED_BLOCK))));
          const blockAtHead = requested !== INCLUDED_BLOCK;
          const block = { ...(blockAtHead ? { number: hex(requested), hash: `0x${"d".repeat(64)}`, parentHash: BLOCK_HASH, transactions: [] } : expectedBlock), ...options.block };
          if (options.reorgOnCanonicalReread && blockReads > 2) return { ...block, hash: `0x${"f".repeat(64)}` };
          return block;
        }
        default: throw new Error(`UNEXPECTED_RPC_METHOD:${method}`);
      }
    })
  };
}

function callFixture(options: ReaderOptions = {}, role: "approval" | "swap" = "approval", operationValue: ActiveV01Operation = operation(role)) {
  const p = profile();
  const readers = [readerFor(role, options, "rpc-a"), readerFor(role, options, "rpc-b")];
  return { p, readers, operationValue, verify: () => verifyV01Candidate({
    operation: operationValue,
    role,
    hash: role === "approval" ? APPROVAL_HASH : SWAP_HASH,
    profile: p,
    readers,
    readOperation: () => operationValue,
    isCurrent: () => true
  }) };
}

describe("v0.1 candidate reconciliation", () => {
  beforeEach(() => vi.useRealTimers());

  const candidateCases: Array<["approval" | "swap", 0 | 1]> = [["approval", 1], ["swap", 1], ["swap", 0]];
  it.each(candidateCases)("accepts a canonical %s candidate with receipt status %s", async (role, status) => {
    const fixture = callFixture({ receipt: { status: hex(status) } }, role);
    const result = await fixture.verify();
    expect(result).toMatchObject({
      status: "candidate-matched", intentId: INTENT, quoteId: QUOTE, profileFingerprint: PROFILE_FINGERPRINT,
      role, hash: role === "approval" ? APPROVAL_HASH : SWAP_HASH, blockNumber: INCLUDED_BLOCK,
      blockHash: BLOCK_HASH, receiptStatus: status, confirmations: 1,
      commonHead: { number: HEAD, hash: BLOCK_HASH }, readerIds: ["rpc-a", "rpc-b"]
    });
    expect(result.attemptFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.checkedAt).toBeGreaterThan(0);
  });

  it("accepts more than one confirmation when every reader agrees on the common head", async () => {
    const result = await callFixture({ head: INCLUDED_BLOCK + 1 }).verify();
    expect(result.confirmations).toBe(2);
    expect(result.commonHead).toEqual({ number: INCLUDED_BLOCK + 1, hash: `0x${"d".repeat(64)}` });
  });

  it("requires a genuine v2 operation, selected attempt, exact profile binding, and distinct readers", async () => {
    for (const bad of [
      legacyOperation(),
      operation("approval", { profileFingerprint: `0x${"9".repeat(64)}` }),
      operation("approval", { attempts: [{ ...operation().attempts[0], profileFingerprint: `0x${"9".repeat(64)}` }, operation().attempts[1]] })
    ]) {
      const fixture = callFixture({}, "approval", bad);
      await expect(fixture.verify()).rejects.toThrow();
    }
    const missingSwap = callFixture({}, "swap", operation("swap", { attempts: [operation().attempts[0]] }));
    await expect(missingSwap.verify()).rejects.toThrow();
    const wrongProfile = callFixture(); wrongProfile.p.fingerprint = `0x${"f".repeat(64)}`;
    await expect(wrongProfile.verify()).rejects.toThrow();
    const duplicate = callFixture();
    duplicate.readers[1] = readerFor("approval", {}, "rpc-a");
    await expect(verifyV01Candidate({ operation: duplicate.operationValue, role: "approval", hash: APPROVAL_HASH, profile: duplicate.p, readers: duplicate.readers, readOperation: () => duplicate.operationValue, isCurrent: () => true })).rejects.toThrow();
  });

  it.each([
    ["transaction hash", { tx: { hash: `0x${"9".repeat(64)}` } }],
    ["wrong nonce", { tx: { nonce: "0x9" } }],
    ["wrong sender", { tx: { from: JADE } }],
    ["wrong target", { tx: { to: JADE } }],
    ["nonzero value", { tx: { value: "0x1" } }],
    ["wrong type", { tx: { type: "0x0" } }],
    ["wrong gas", { tx: { gas: "0x186a1" } }],
    ["wrong calldata", { tx: { input: `0x${"0".repeat(136)}` } }],
    ["malformed calldata", { tx: { input: "0x" } }],
    ["wrong max fee", { tx: { maxFeePerGas: "0x65" } }],
    ["wrong priority fee", { tx: { maxPriorityFeePerGas: "0x2" } }],
    ["non-canonical access list", { tx: { accessList: [{ address: POOL, storageKeys: [] }] } }],
    ["wrong transaction chain", { tx: { chainId: "0x1" } }],
    ["missing transaction", { tx: null }]
  ])("rejects %s evidence", async (_label, options) => {
    await expect(callFixture(options).verify()).rejects.toThrow();
  });

  it.each([
    ["wrong receipt hash", { receipt: { transactionHash: `0x${"9".repeat(64)}` } }],
    ["wrong receipt sender", { receipt: { from: `0x${"9".repeat(40)}` } }],
    ["wrong receipt block", { receipt: { blockHash: `0x${"9".repeat(64)}` } }],
    ["wrong receipt number", { receipt: { blockNumber: hex(INCLUDED_BLOCK + 1) } }],
    ["malformed receipt status", { receipt: { status: "not-a-quantity" } }],
    ["out-of-range receipt status", { receipt: { status: "0x2" } }],
    ["null receipt", { receipt: null }],
    ["missing canonical block", { block: null }],
    ["old inclusion", { block: { number: hex(OBSERVED_BEFORE_BLOCK) } }],
    ["duplicate canonical hash", { block: { transactions: [APPROVAL_HASH, APPROVAL_HASH] } }]
  ])("rejects %s", async (_label, options) => {
    await expect(callFixture(options).verify()).rejects.toThrow();
  });

  it("rejects chain changes, context changes, current-operation replacement, and cross-reader disagreement", async () => {
    await expect(callFixture({ chainId: "0x1" }).verify()).rejects.toThrow();
    const lateChain = callFixture({ chainIdAfterFirst: "0x1" });
    await expect(lateChain.verify()).rejects.toThrow();
    const changed = callFixture();
    await expect(verifyV01Candidate({ operation: changed.operationValue, role: "approval", hash: APPROVAL_HASH, profile: changed.p, readers: changed.readers, readOperation: () => ({ ...changed.operationValue, quoteId: "changed" }), isCurrent: () => true })).rejects.toThrow();
    const context = callFixture();
    await expect(verifyV01Candidate({ operation: context.operationValue, role: "approval", hash: APPROVAL_HASH, profile: context.p, readers: context.readers, readOperation: () => context.operationValue, isCurrent: () => false })).rejects.toThrow();
    const disagreement = callFixture();
    disagreement.readers[1] = readerFor("approval", { head: HEAD + 1, block: { hash: `0x${"8".repeat(64)}` } }, "rpc-b");
    await expect(verifyV01Candidate({ operation: disagreement.operationValue, role: "approval", hash: APPROVAL_HASH, profile: disagreement.p, readers: disagreement.readers, readOperation: () => disagreement.operationValue, isCurrent: () => true })).rejects.toThrow();
    const statusDisagreement = callFixture();
    statusDisagreement.readers[1] = readerFor("approval", { receipt: { status: "0x0" } }, "rpc-b");
    await expect(verifyV01Candidate({ operation: statusDisagreement.operationValue, role: "approval", hash: APPROVAL_HASH, profile: statusDisagreement.p, readers: statusDisagreement.readers, readOperation: () => statusDisagreement.operationValue, isCurrent: () => true })).rejects.toThrow();
  });

  it("rejects the legacy v1 operation schema even when an otherwise matching candidate exists", async () => {
    const legacy = legacyOperation();
    await expect(callFixture({}, "approval", legacy).verify()).rejects.toThrow();
  });

  it("rejects internally consistent evidence included before the saved request", async () => {
    await expect(callFixture({ tx: { blockNumber: hex(OBSERVED_BEFORE_BLOCK) }, receipt: { blockNumber: hex(OBSERVED_BEFORE_BLOCK) }, block: { number: hex(OBSERVED_BEFORE_BLOCK) } }).verify()).rejects.toThrow();
  });

  it("rejects agreement on inclusion but disagreement on the common head", async () => {
    const fixture = callFixture({ head: INCLUDED_BLOCK + 1 });
    const original = fixture.readers[1].send;
    fixture.readers[1].send = async (method, params) => {
      const result = await original(method, params);
      return method === "eth_getBlockByNumber" && params[0] === hex(INCLUDED_BLOCK + 1) ? { ...result as object, hash: `0x${"9".repeat(64)}` } : result;
    };
    await expect(fixture.verify()).rejects.toThrow();
  });

  it("validates saved ABI calls against the fixed profile before any RPC read", async () => {
    for (const [role, data] of [
      ["approval", approvalInterface.encodeFunctionData("approve", [JADE, AMOUNT])],
      ["approval", approvalInterface.encodeFunctionData("approve", [POOL, 0])],
      ["swap", poolInterface.encodeFunctionData("swapExactIn", [AMBR, AMOUNT, MINIMUM, JADE, DEADLINE])],
      ["swap", poolInterface.encodeFunctionData("swapExactIn", [FACTORY, AMOUNT, MINIMUM, ACCOUNT, DEADLINE])],
      ["swap", poolInterface.encodeFunctionData("swapExactIn", [AMBR, AMOUNT, 0, ACCOUNT, DEADLINE])]
    ] as const) {
      const op = operation(); op.attempts.find(item => item.role === role)!.transaction.data = data;
      const fixture = callFixture({}, role, op);
      await expect(fixture.verify()).rejects.toThrow();
      expect(fixture.readers.every(reader => vi.mocked(reader.send).mock.calls.length === 0)).toBe(true);
    }
  });

  it("does not expose arbitrary provider error text", async () => {
    const fixture = callFixture();
    fixture.readers[0].send = async () => { throw new Error("V01_CANDIDATE_UNTRUSTED_LONG_PROVIDER_PAYLOAD"); };
    await expect(fixture.verify()).rejects.toThrow("V01_CANDIDATE_READ_FAILED");
  });

  it("re-reads the included canonical block and rejects a reorg", async () => {
    await expect(callFixture({ reorgOnCanonicalReread: true }).verify()).rejects.toThrow();
  });

  it("fails closed when caller-owned operation/profile inputs mutate during asynchronous reads", async () => {
    const fixture = callFixture();
    const originalData = (fixture.operationValue as Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v2" }>).attempts[0].transaction.data;
    fixture.readers[0] = readerFor("approval", {
      mutateInputsOnFirstCall: () => {
        const current = fixture.operationValue as Extract<ActiveV01Operation, { schema: "realdex.v01-active-operation.v2" }>;
        current.attempts[0].transaction.data = `0x${"0".repeat(136)}`;
        fixture.p.readerIds.push("evil-reader");
        fixture.readers.reverse();
      }
    }, "rpc-a");
    await expect(fixture.verify()).rejects.toThrow("V01_CANDIDATE_CONTEXT_CHANGED");
    expect(originalData).toMatch(/^0x/);
  });

  it("times out an unresponsive read-only quorum at the neutral v0.1 budget", async () => {
    vi.useFakeTimers();
    const p = profile();
    const pendingReader = (id: string): RpcReader => ({ id, send: vi.fn(() => new Promise<unknown>(() => undefined)) });
    const readers = [pendingReader("rpc-a"), pendingReader("rpc-b")];
    const pending = verifyV01Candidate({ operation: operation(), role: "approval", hash: APPROVAL_HASH, profile: p, readers, readOperation: () => operation(), isCurrent: () => true });
    const failure = expect(pending).rejects.toThrow("V01_CANDIDATE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(15_001);
    await failure;
  }, 20_000);
});
