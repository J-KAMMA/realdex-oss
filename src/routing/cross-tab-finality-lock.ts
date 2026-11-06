import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { routeDescriptorFingerprint } from "./engine";
import type { CrossTabExecutionLockManager } from "./cross-tab-execution-lock";
import type { RouteDescriptor } from "./types";

export function crossTabFinalityLockName(route: RouteDescriptor): string {
  return `realdex:route-finality:${cryptographicFingerprint("realdex.cross-tab-finality-lock.v1", {
    routeId: route.id,
    routeFingerprint: routeDescriptorFingerprint(route)
  })}`;
}

export async function withCrossTabFinalityLock<T>(manager: CrossTabExecutionLockManager, route: RouteDescriptor, action: () => Promise<T>): Promise<T> {
  const name = crossTabFinalityLockName(route);
  let callbackEntered = false;
  try {
    return await manager.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      callbackEntered = true;
      if (!lock) throw new Error("FINALITY_OPERATION_IN_PROGRESS");
      return action();
    });
  } catch (reason) {
    if (callbackEntered) throw reason;
    throw new Error("FINALITY_CROSS_TAB_LOCK_UNAVAILABLE");
  }
}
