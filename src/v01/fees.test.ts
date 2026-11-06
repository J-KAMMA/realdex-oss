import { Interface, Transaction, getBytes } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  V01_GAS_ORACLE,
  V01_GAS_ORACLE_ABI,
  checkV01FeeStep,
  estimateV01FeePlan,
  v01AllowanceOverride,
  v01FeeTransaction,
  type V01FeeCall,
} from "./fees";

const OWNER = "0x1000000000000000000000000000000000000001";
const TOKEN = "0x2000000000000000000000000000000000000002";
const SWAP = "0x3000000000000000000000000000000000000003";
const CHAIN = "0x14a34";
const ORACLE = new Interface(V01_GAS_ORACLE_ABI);

type FakeOptions = {
  base?: bigint;
  tip?: bigint;
  approvalGas?: bigint;
  swapGas?: bigint;
  l1Fee?: bigint;
  operatorFee?: bigint;
  balance?: bigint;
  nonce?: bigint;
  oracleMode?: "normal" | "missing" | "error";
  balanceGate?: Promise<void>;
  onBalanceStart?: () => void;
};

class FakeRpc {
  readonly calls: Array<{ method: string; params: unknown[] }> = [];
  base = 7n;
  tip = 3n;
  approvalGas = 101n;
  swapGas = 97n;
  l1Fee = 11n;
  operatorFee = 13n;
  balance = 2_122n;
  nonceValue = 5n;
  chainId = CHAIN;
  oracleMode: FakeOptions["oracleMode"] = "normal";
  balanceGate?: Promise<void>;
  onBalanceStart?: () => void;
  balanceStarted = false;

  constructor(options: FakeOptions = {}) {
    Object.assign(this, options);
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case "eth_chainId":
        return this.chainId;
      case "eth_getBlockByNumber":
        return { baseFeePerGas: toQuantity(this.base) };
      case "eth_maxPriorityFeePerGas":
        return toQuantity(this.tip);
      case "eth_getTransactionCount":
        return toQuantity(this.nonceValue);
      case "eth_estimateGas": {
        const tx = params[0] as { to?: string };
        return toQuantity(tx.to?.toLowerCase() === TOKEN.toLowerCase() ? this.approvalGas : this.swapGas);
      }
      case "eth_call": {
        if (this.oracleMode === "error") throw new Error("oracle unavailable");
        if (this.oracleMode === "missing") return "0x";
        const tx = params[0] as { to?: string; data?: string };
        if (typeof tx.to !== "string" || typeof tx.data !== "string") throw new Error("oracle calldata missing");
        expect(tx.to.toLowerCase()).toBe(V01_GAS_ORACLE.toLowerCase());
        const parsed = ORACLE.parseTransaction({ data: tx.data });
        if (!parsed) throw new Error("oracle calldata missing");
        const value = parsed.name === "getL1FeeUpperBound" ? this.l1Fee : this.operatorFee;
        return ORACLE.encodeFunctionResult(parsed.name, [value]);
      }
      case "eth_getBalance":
        this.balanceStarted = true;
        this.onBalanceStart?.();
        if (this.balanceGate) await this.balanceGate;
        return toQuantity(this.balance);
      default:
        throw new Error(`mutating or unexpected RPC method: ${method}`);
    }
  }
}

function toQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function callsWithApproval(): V01FeeCall[] {
  return [
    { role: "approval", from: OWNER, to: TOKEN, data: "0x1234" },
    { role: "swap", from: OWNER, to: SWAP, data: "0xabcd00" },
  ];
}

function swapOnly(): V01FeeCall[] {
  return [{ role: "swap", from: OWNER, to: SWAP, data: "0xabcd00" }];
}

function expiry(): number {
  return Date.now() + 60_000;
}

async function waitForBalanceRead(rpc: FakeRpc): Promise<void> {
  for (let i = 0; i < 100 && !rpc.balanceStarted; i += 1) await Promise.resolve();
  expect(rpc.balanceStarted).toBe(true);
}

function oracleCalls(rpc: FakeRpc, method: string) {
  return rpc.calls.filter((call) => {
    if (call.method !== "eth_call") return false;
    const tx = call.params[0] as { data: string };
    return ORACLE.parseTransaction({ data: tx.data })?.name === method;
  });
}

function expectedUnsignedSize(step: { nonce: number; to: string; data: string; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): bigint {
  const tx = {
    type: 2,
    chainId: 84532,
    nonce: step.nonce,
    to: step.to,
    data: step.data,
    value: 0n,
    gasLimit: step.gasLimit,
    maxFeePerGas: step.maxFeePerGas,
    maxPriorityFeePerGas: step.maxPriorityFeePerGas,
    accessList: [],
  };
  return BigInt(getBytes(Transaction.from(tx).unsignedSerialized).length);
}

afterEach(() => vi.useRealTimers());

describe("v0.1 fee budget", () => {
  it("requires renewed review when L1 or operator costs rise beyond their budgets", async () => {
    for (const field of ["l1Fee", "operatorFee"] as const) {
      const rpc = new FakeRpc({ balance: 100_000n });
      const plan = await estimateV01FeePlan(rpc, swapOnly(), expiry());
      rpc[field] *= 3n;
      await expect(checkV01FeeStep(rpc, plan, "swap")).rejects.toThrow("V01_FEE_REVIEW_REQUIRED");
    }
  });

  it("times out an unavailable fee source without retrying or manufacturing a zero fee", async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc({ balance: 100_000n });
    vi.spyOn(rpc, "send").mockImplementation(async (method, params) => {
      if (method === "eth_call") return new Promise(() => {});
      return FakeRpc.prototype.send.call(rpc, method, params);
    });
    const pending = estimateV01FeePlan(rpc, swapOnly(), expiry());
    const rejected = expect(pending).rejects.toThrow("V01_FEE_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(8_001); await rejected;
    expect(vi.mocked(rpc.send).mock.calls.filter(([method]) => method === "eth_call")).toHaveLength(2);
  });

  it("rounds gas upward, sequences approval/swap nonces, and decodes exact oracle inputs", async () => {
    const rpc = new FakeRpc({ balance: 4_159n });
    const plan = await estimateV01FeePlan(rpc, callsWithApproval(), expiry(), { token: TOKEN, spender: SWAP, amount: 500n });

    expect(plan.steps.map((step) => step.nonce)).toEqual([5, 6]);
    expect(plan.steps.map((step) => step.gasLimit)).toEqual([122n, 117n]);
    expect(plan.steps[0]).toMatchObject({ l2Budget: 2_074n, l1Budget: 22n, operatorBudget: 26n, totalBudget: 2_122n });
    expect(plan.steps[1]).toMatchObject({ l2Budget: 1_989n, l1Budget: 22n, operatorBudget: 26n, totalBudget: 2_037n });
    expect(plan.totalBudget).toBe(4_159n);
    expect(rpc.balance).toBe(plan.totalBudget);
  });

  it("uses allowance stateDiff only for swap simulation and verifies unsigned size/oracle arguments", async () => {
    const rpc = new FakeRpc({ balance: 4_159n });
    const amount = 500n;
    const plan = await estimateV01FeePlan(rpc, callsWithApproval(), expiry(), { token: TOKEN, spender: SWAP, amount });
    const estimates = rpc.calls.filter((call) => call.method === "eth_estimateGas");
    expect(estimates).toHaveLength(2);
    expect(estimates[0].params).toHaveLength(2);
    expect(estimates[1].params).toHaveLength(3);
    expect(estimates[1].params[2]).toEqual(v01AllowanceOverride(TOKEN, OWNER, SWAP, amount));
    expect((estimates[0].params[1] as unknown)).toBe("latest");
    expect((estimates[1].params[1] as unknown)).toBe("latest");

    for (const step of plan.steps) {
      const l1 = oracleCalls(rpc, "getL1FeeUpperBound").find((call) => {
        const parsed = ORACLE.parseTransaction({ data: (call.params[0] as { data: string }).data });
        return Number(parsed?.args[0]) === Number(expectedUnsignedSize(step));
      });
      expect(l1).toBeDefined();
      const decodedL1 = ORACLE.parseTransaction({ data: (l1!.params[0] as { data: string }).data });
      expect(decodedL1?.args[0]).toBe(expectedUnsignedSize(step));
    }
    expect(oracleCalls(rpc, "getOperatorFee").map((call) => ORACLE.parseTransaction({ data: (call.params[0] as { data: string }).data })?.args[0])).toEqual([122n, 117n]);
  });

  it("estimates a single swap without an approval or simulation override", async () => {
    const rpc = new FakeRpc({ balance: 2_037n });
    const plan = await estimateV01FeePlan(rpc, swapOnly(), expiry());
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].role).toBe("swap");
    expect(plan.steps[0].nonce).toBe(5);
    expect(plan.approvalSimulation).toBe(false);
    expect(rpc.calls.filter((call) => call.method === "eth_estimateGas")[0].params).toHaveLength(2);
  });

  it("accepts the exact positive balance boundary and rejects one wei below it", async () => {
    const exact = new FakeRpc({ balance: 2_037n });
    await expect(estimateV01FeePlan(exact, swapOnly(), expiry())).resolves.toMatchObject({ totalBudget: 2_037n });
    const insufficient = new FakeRpc({ balance: 2_036n });
    await expect(estimateV01FeePlan(insufficient, swapOnly(), expiry())).rejects.toThrow("V01_GAS_BALANCE_INSUFFICIENT");
  });

  it.each([
    ["malformed block quantity", new FakeRpc(), "V01_FEE_RESPONSE_INVALID", (rpc: FakeRpc) => rpc.calls],
    ["estimate error", new FakeRpc(), "V01_FEE_UNAVAILABLE", (rpc: FakeRpc) => rpc.calls],
    ["missing oracle result", new FakeRpc({ oracleMode: "missing" }), "V01_FEE_RESPONSE_INVALID", (rpc: FakeRpc) => rpc.calls],
    ["oracle error", new FakeRpc({ oracleMode: "error" }), "V01_FEE_UNAVAILABLE", (rpc: FakeRpc) => rpc.calls],
  ])("fails closed for %s", async (_label, rpc, error, calls) => {
    if (_label === "malformed block quantity") {
      vi.spyOn(rpc, "send").mockImplementation(async (method, params) => {
        if (method === "eth_getBlockByNumber") {
          rpc.calls.push({ method, params });
          return { baseFeePerGas: "0x" };
        }
        return FakeRpc.prototype.send.call(rpc, method, params);
      });
    }
    if (_label === "estimate error") {
      vi.spyOn(rpc, "send").mockImplementation(async (method, params) => {
        if (method === "eth_estimateGas") {
          rpc.calls.push({ method, params });
          throw new Error("estimate failed");
        }
        return FakeRpc.prototype.send.call(rpc, method, params);
      });
    }
    await expect(estimateV01FeePlan(rpc, swapOnly(), expiry())).rejects.toThrow(error);
    expect(calls(rpc).some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  it("rejects higher fee, higher gas, and changed nonce during preflight", async () => {
    const feeRpc = new FakeRpc({ balance: 10_000n });
    const feePlan = await estimateV01FeePlan(feeRpc, swapOnly(), expiry());
    feeRpc.base = 15n;
    await expect(checkV01FeeStep(feeRpc, feePlan, "swap")).rejects.toThrow("V01_FEE_REVIEW_REQUIRED");

    const gasRpc = new FakeRpc({ balance: 10_000n });
    const gasPlan = await estimateV01FeePlan(gasRpc, swapOnly(), expiry());
    gasRpc.swapGas = gasPlan.steps[0].gasLimit + 1n;
    await expect(checkV01FeeStep(gasRpc, gasPlan, "swap")).rejects.toThrow("V01_FEE_REVIEW_REQUIRED");

    const nonceRpc = new FakeRpc({ balance: 10_000n });
    const noncePlan = await estimateV01FeePlan(nonceRpc, swapOnly(), expiry());
    nonceRpc.nonceValue += 1n;
    await expect(checkV01FeeStep(nonceRpc, noncePlan, "swap")).rejects.toThrow("V01_FEE_NONCE_CHANGED");
  });

  it("does not use a state override during the immediate preflight recheck", async () => {
    const rpc = new FakeRpc({ balance: 10_000n });
    const plan = await estimateV01FeePlan(rpc, callsWithApproval(), expiry(), { token: TOKEN, spender: SWAP, amount: 500n });
    rpc.nonceValue = BigInt(plan.steps[1].nonce);
    const before = rpc.calls.length;
    await expect(checkV01FeeStep(rpc, plan, "swap")).resolves.toMatchObject({ role: "swap" });
    const checkEstimates = rpc.calls.slice(before).filter((call) => call.method === "eth_estimateGas");
    expect(checkEstimates).toHaveLength(1);
    expect(checkEstimates[0].params).toHaveLength(2);
    expect(checkEstimates[0].params[0]).toEqual(v01FeeTransaction(plan.steps[1]));
    expect(checkEstimates[0].params.some((param) => typeof param === "object" && param !== null && "stateDiff" in param)).toBe(false);
  });

  it("fails when expiration or chain changes after an asynchronous read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const expiredRpc = new FakeRpc({ balance: 10_000n, balanceGate: gate });
    const expired = estimateV01FeePlan(expiredRpc, swapOnly(), 2_000_000);
    await waitForBalanceRead(expiredRpc);
    vi.setSystemTime(3_000_000);
    release();
    await expect(expired).rejects.toThrow("V01_FEE_EXPIRED");

    let releaseChain!: () => void;
    const chainGate = new Promise<void>((resolve) => { releaseChain = resolve; });
    const chainRpc = new FakeRpc({ balance: 10_000n, balanceGate: chainGate, onBalanceStart: () => { chainRpc.chainId = "0x1"; } });
    const changed = estimateV01FeePlan(chainRpc, swapOnly(), 4_000_000);
    await waitForBalanceRead(chainRpc);
    releaseChain();
    await expect(changed).rejects.toThrow("WALLET_NETWORK_CHANGED");
  });

  it("performs no mutating RPC calls while estimating and checking", async () => {
    const rpc = new FakeRpc({ balance: 10_000n });
    const plan = await estimateV01FeePlan(rpc, swapOnly(), expiry());
    await checkV01FeeStep(rpc, plan, "swap");
    expect(rpc.calls.every(({ method }) => [
      "eth_chainId", "eth_getBlockByNumber", "eth_maxPriorityFeePerGas", "eth_getTransactionCount",
      "eth_estimateGas", "eth_call", "eth_getBalance",
    ].includes(method))).toBe(true);
    expect(rpc.calls.some(({ method }) => ["eth_sendTransaction", "eth_sign", "personal_sign", "eth_sendRawTransaction"].includes(method))).toBe(false);
  });
});
