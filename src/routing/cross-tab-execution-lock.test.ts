import { describe, expect, it, vi } from "vitest";
import { crossTabExecutionLockName, withCrossTabExecutionLock, type CrossTabExecutionLockManager } from "./cross-tab-execution-lock";

const guardKey = `localswap:route-intent-execution:0x${"1".repeat(64)}:realdex-intent:v1:00000000-0000-4000-8000-000000000001`;

class TestLockManager implements CrossTabExecutionLockManager {
  private readonly held = new Set<string>();
  async request<T>(name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown | null) => T | Promise<T>): Promise<T> {
    expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name, mode: "exclusive" }); }
    finally { this.held.delete(name); }
  }
}

describe("cross-tab route execution lock", () => {
  it("uses one bounded origin-wide name for the exact durable guard", () => {
    expect(crossTabExecutionLockName(guardKey)).toMatch(/^realdex:route-execution:0x[0-9a-f]{64}$/);
    expect(crossTabExecutionLockName(guardKey)).toBe(crossTabExecutionLockName(guardKey));
    expect(() => crossTabExecutionLockName("untrusted-key")).toThrow("EXECUTION_GUARD_KEY_INVALID");
  });

  it("allows only one concurrent tab to enter the critical execution section", async () => {
    const manager = new TestLockManager();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstAction = vi.fn(async () => { await held; return "first"; });
    const secondAction = vi.fn(async () => "second");
    const first = withCrossTabExecutionLock(manager, guardKey, firstAction);
    await vi.waitFor(() => expect(firstAction).toHaveBeenCalledTimes(1));
    await expect(withCrossTabExecutionLock(manager, guardKey, secondAction)).rejects.toThrow("DUPLICATE_ROUTE_EXECUTION");
    expect(secondAction).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toBe("first");
  });

  it("fails closed when the browser lock service fails before entering", async () => {
    const manager: CrossTabExecutionLockManager = { request: async () => { throw new Error("service unavailable"); } };
    const action = vi.fn(async () => "never");
    await expect(withCrossTabExecutionLock(manager, guardKey, action)).rejects.toThrow("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE");
    expect(action).not.toHaveBeenCalled();
  });
});
