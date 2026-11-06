import { describe, expect, it, vi } from "vitest";
import { crossTabFinalityLockName, withCrossTabFinalityLock } from "./cross-tab-finality-lock";
import type { CrossTabExecutionLockManager } from "./cross-tab-execution-lock";
import { ROUTE_DESCRIPTORS } from "./registry";

class TestLockManager implements CrossTabExecutionLockManager {
  private readonly held = new Set<string>();
  async request<T>(name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown | null) => T | Promise<T>): Promise<T> {
    expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); }
    finally { this.held.delete(name); }
  }
}

const firstRoute = ROUTE_DESCRIPTORS.find((route) => route.id === "cctp-v2-base-sepolia-solana-devnet-usdc")!;
const secondRoute = ROUTE_DESCRIPTORS.find((route) => route.id === "ibc-grand-1-osmo-test-5-usdc")!;

describe("cross-tab route finality lock", () => {
  it("derives one bounded lock name from the exact current route", () => {
    expect(crossTabFinalityLockName(firstRoute)).toMatch(/^realdex:route-finality:0x[0-9a-f]{64}$/);
    expect(crossTabFinalityLockName(firstRoute)).toBe(crossTabFinalityLockName(firstRoute));
    expect(crossTabFinalityLockName(firstRoute)).not.toBe(crossTabFinalityLockName(secondRoute));
  });

  it("serializes capacity, execution, persistence, and refresh for one route", async () => {
    const manager = new TestLockManager();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = vi.fn(async () => { await held; return "persisted"; });
    const conflicting = vi.fn(async () => "unsafe");
    const pending = withCrossTabFinalityLock(manager, firstRoute, first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    await expect(withCrossTabFinalityLock(manager, firstRoute, conflicting)).rejects.toThrow("FINALITY_OPERATION_IN_PROGRESS");
    expect(conflicting).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toBe("persisted");
  });

  it("fails closed when the origin lock service cannot be reached", async () => {
    const manager: CrossTabExecutionLockManager = { request: async () => { throw new Error("service unavailable"); } };
    const action = vi.fn(async () => "never");
    await expect(withCrossTabFinalityLock(manager, firstRoute, action)).rejects.toThrow("FINALITY_CROSS_TAB_LOCK_UNAVAILABLE");
    expect(action).not.toHaveBeenCalled();
  });
});
