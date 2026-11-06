/** @vitest-environment jsdom */
import { Interface } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { routeDescriptorFingerprint, routeRequestFingerprint } from "../routing/engine";
import type { RouteExecutionReceipt, RouteQuote, RouteQuoteRequest } from "../routing/types";
import { createLocalAmmRouteDescriptor } from "../swap/evm-local-amm";
import { recordEvmSwapReceipt } from "../swap/evm-swap-recovery";
import { createProviderBindingGrant } from "../wallet/capabilities";
import type { VerifiedV01Profile } from "../release/v01-profile";
import type { V01SendAttempt } from "./send-attempt";

// The profile verifier's accepted WeakMap is intentionally private. These two
// assertions are the only mocked boundary; route, quote and grant checks remain real.
vi.mock("../release/v01-profile", () => ({
  assertCurrentV01Profile: vi.fn(),
  assertV01Route: vi.fn()
}));

import {
  assertV01AttemptMatchesRecoveryIntent,
  assertV01RecoveryIntent,
  assertV01RecoveryIntentProfile,
  createV01RecoveryIntent
} from "./recovery-intent";

const NOW = Date.now() + 1_000;
const POOL = "0x1000000000000000000000000000000000000001";
const AMBR = "0x2000000000000000000000000000000000000002";
const JADE = "0x3000000000000000000000000000000000000003";
const ACCOUNT = "0x4000000000000000000000000000000000000004";
const FACTORY = "0x5000000000000000000000000000000000000005";

const route = createLocalAmmRouteDescriptor({ chainId: 84532n, poolAddress: POOL, tokenIn: AMBR, tokenOut: JADE, factoryAddress: FACTORY, venueId: "v01", venueLabel: "RealDEX v0.1 test tokens" });
const profile = {
  status: "verified-profile", profile: {}, fingerprint: `0x${"a".repeat(64)}`,
  verifiedAt: NOW - 1000, expiresAt: NOW + 60_000, readerIds: ["rpc-a", "rpc-b"], routes: [route]
} as unknown as VerifiedV01Profile;

function request(overrides: Partial<RouteQuoteRequest> = {}): RouteQuoteRequest {
  const accountId = `eip155:84532:${ACCOUNT}`;
  return {
    executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000201",
    sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset, amountInBaseUnits: 1_000n,
    accountId, recipient: ACCOUNT, walletCapabilityId: "eip1193", sessionRevision: 7,
    walletGrant: createProviderBindingGrant({ transportId: "test:v01", accountId, walletCapabilityId: "eip1193", sessionRevision: 7, expiresAt: NOW + 300_000 }),
    slippageBps: 50, ...overrides
  };
}

function quoteFor(input: RouteQuoteRequest, overrides: Partial<RouteQuote> = {}): RouteQuote {
  return {
    quoteId: "quote:v01:201", routeId: route.id, routeFingerprint: routeDescriptorFingerprint(route), requestFingerprint: routeRequestFingerprint(input), adapterId: route.adapterId,
    amountInBaseUnits: input.amountInBaseUnits, expectedOutBaseUnits: 900n, minimumOutBaseUnits: 890n, fees: [], unpricedCosts: [], expiresAt: NOW + 30_000, estimatedSeconds: null,
    authorization: { type: "approval", spender: POOL, amountBaseUnits: input.amountInBaseUnits, expiresAt: null },
    executionPreview: { chainId: "eip155:84532", target: POOL, method: "swapExactIn", valueBaseUnits: 0n },
    adapterData: { format: "evm-local-amm.swap.v1", value: { pool: POOL, tokenIn: AMBR, tokenOut: JADE, deadline: Math.floor((NOW + 30_000) / 1000) } }, ...overrides
  };
}

function intent() {
  return createV01RecoveryIntent(profile, route, request(), quoteFor(request()), NOW);
}

function envelope(role: "approval" | "swap", nonce: number): V01SendAttempt["transaction"] {
  const data = role === "approval"
    ? new Interface(ERC20_ABI).encodeFunctionData("approve", [POOL, 1_000n])
    : new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [AMBR, 1_000n, 890n, ACCOUNT, Math.floor((NOW + 30_000) / 1000)]);
  return { from: ACCOUNT, to: role === "approval" ? AMBR : POOL, data, value: "0x0", chainId: "0x14a34", type: "0x2", nonce: `0x${nonce.toString(16)}`, gas: "0x186a0", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1" };
}

function attempt(value: ReturnType<typeof intent>, role: "approval" | "swap", nonce: number): V01SendAttempt {
  return { intentId: value.intentId, quoteId: value.quoteId, profileFingerprint: value.profileFingerprint, role, observedBeforeBlock: 10, transaction: envelope(role, nonce) };
}

describe("v0.1 recovery intent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures immutable JSON-safe metadata without storing a wallet grant", () => {
    const value = intent();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(value)).not.toContain("walletGrant");
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    expect(value).toMatchObject({ schema: "realdex.v01-recovery-intent.v1", amountInBaseUnits: "1000", minimumOutBaseUnits: "890", approvalRequired: true, capturedAt: NOW });
  });

  it("uses the same recovery identity as the EVM receipt journal", () => {
    const value = intent();
    const evidence = (role: "approval" | "swap", nonce: number, block: number) => {
      const tx = envelope(role, nonce);
      return { from: tx.from, to: tx.to, nonce, data: tx.data, valueBaseUnits: "0", chainId: "84532", observedBeforeBlock: block };
    };
    const receipt: RouteExecutionReceipt = {
      executionId: "evm-swap:receipt-201", quoteId: value.quoteId, state: "pending", provider: "fixture", steps: [
        { name: "approval", kind: "approval", state: "submitted", txHash: `0x${"a".repeat(64)}`, evmTransaction: evidence("approval", 1, 10) },
        { name: "swap", kind: "swap", state: "submitted", txHash: `0x${"b".repeat(64)}`, evmTransaction: evidence("swap", 2, 11) }
      ]
    };
    const record = recordEvmSwapReceipt(route, request(), quoteFor(request()), receipt, { sourceSymbol: "AMBR", sourceDecimals: 18, destinationSymbol: "JADE", destinationDecimals: 18 }, undefined, NOW);
    expect(record?.recoveryId).toBe(value.recoveryId);
  });

  it("rejects malformed shape, extra keys, uint256, time and identity mutations", () => {
    const base = intent();
    const invalid: unknown[] = [
      { ...base, extra: true },
      { ...base, amountInBaseUnits: "0" },
      { ...base, amountInBaseUnits: "01" },
      { ...base, amountInBaseUnits: (1n << 256n).toString() },
      { ...base, minimumOutBaseUnits: "0" },
      { ...base, capturedAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, quoteExpiresAt: base.capturedAt + 600_001 },
      { ...base, recoveryId: `0x${"b".repeat(64)}` }
    ];
    for (const value of invalid) expect(() => assertV01RecoveryIntent(value)).toThrow("V01_RECOVERY_INTENT_INVALID");
  });

  it("rejects wrong approval route/amount and a fixed-profile mismatch", () => {
    const input = request();
    expect(() => createV01RecoveryIntent(profile, route, input, quoteFor(input, { authorization: { type: "approval", spender: JADE, amountBaseUnits: input.amountInBaseUnits, expiresAt: null } }), NOW)).toThrow("V01_RECOVERY_INTENT_INVALID");
    expect(() => createV01RecoveryIntent(profile, route, input, quoteFor(input, { authorization: { type: "approval", spender: POOL, amountBaseUnits: input.amountInBaseUnits + 1n, expiresAt: null } }), NOW)).toThrow("V01_RECOVERY_INTENT_INVALID");
    expect(() => createV01RecoveryIntent(profile, route, input, quoteFor(input, { expiresAt: NOW + 70_000 }), NOW)).toThrow("V01_RECOVERY_INTENT_INVALID");
    const changed = { ...profile, fingerprint: `0x${"b".repeat(64)}` } as VerifiedV01Profile;
    expect(() => assertV01RecoveryIntentProfile(intent(), changed)).toThrow("V01_RECOVERY_INTENT_INVALID");
  });

  it("requires exact approval and swap calldata, target, sender, amount, minimum and deadline", () => {
    const value = intent();
    expect(() => assertV01AttemptMatchesRecoveryIntent(attempt(value, "approval", 1), value)).not.toThrow();
    expect(() => assertV01AttemptMatchesRecoveryIntent(attempt(value, "swap", 2), value)).not.toThrow();
    const cases = [
      { role: "approval" as const, patch: { to: POOL } },
      { role: "approval" as const, patch: { data: new Interface(ERC20_ABI).encodeFunctionData("approve", [JADE, 1_000n]) } },
      { role: "approval" as const, patch: { data: new Interface(ERC20_ABI).encodeFunctionData("approve", [POOL, 999n]) } },
      { role: "swap" as const, patch: { from: JADE } },
      { role: "swap" as const, patch: { to: AMBR } },
      { role: "swap" as const, patch: { data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [JADE, 1_000n, 890n, ACCOUNT, Math.floor((NOW + 30_000) / 1000)]) } },
      { role: "swap" as const, patch: { data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [AMBR, 1_000n, 890n, JADE, Math.floor((NOW + 30_000) / 1000)]) } },
      { role: "swap" as const, patch: { data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [AMBR, 999n, 890n, ACCOUNT, Math.floor((NOW + 30_000) / 1000)]) } },
      { role: "swap" as const, patch: { data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [AMBR, 1_000n, 889n, ACCOUNT, Math.floor((NOW + 30_000) / 1000)]) } },
      { role: "swap" as const, patch: { data: new Interface(POOL_ABI).encodeFunctionData("swapExactIn", [AMBR, 1_000n, 890n, ACCOUNT, Math.floor((NOW + 121_000) / 1000)]) } }
    ];
    for (const item of cases) {
      const original = attempt(value, item.role, item.role === "approval" ? 1 : 2);
      expect(() => assertV01AttemptMatchesRecoveryIntent({ ...original, transaction: { ...original.transaction, ...item.patch } }, value)).toThrow("V01_RECOVERY_ATTEMPT_MISMATCH");
    }
  });
});
