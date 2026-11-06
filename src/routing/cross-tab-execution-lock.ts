import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";

export interface CrossTabExecutionLockManager {
  request<T>(name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown | null) => T | Promise<T>): Promise<T>;
}

export function crossTabExecutionLockName(guardKey: string): string {
  if (!guardKey.startsWith("localswap:route-intent-execution:") || guardKey.length > 400 || /[\u0000-\u001f\u007f]/.test(guardKey)) throw new Error("EXECUTION_GUARD_KEY_INVALID");
  return `realdex:route-execution:${cryptographicFingerprint("realdex.cross-tab-execution-lock.v1", { guardKey })}`;
}

export async function withCrossTabExecutionLock<T>(manager: CrossTabExecutionLockManager, guardKey: string, action: () => Promise<T>): Promise<T> {
  const name = crossTabExecutionLockName(guardKey);
  let callbackEntered = false;
  try {
    return await manager.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      callbackEntered = true;
      if (!lock) throw new Error("DUPLICATE_ROUTE_EXECUTION");
      return action();
    });
  } catch (reason) {
    if (callbackEntered) throw reason;
    throw new Error("EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE");
  }
}

export function browserCrossTabExecutionLockManager(): CrossTabExecutionLockManager | undefined {
  try {
    if (typeof navigator === "undefined" || !navigator.locks || typeof navigator.locks.request !== "function") return undefined;
    return navigator.locks as unknown as CrossTabExecutionLockManager;
  } catch {
    return undefined;
  }
}
