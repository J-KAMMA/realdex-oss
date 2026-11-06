import { describe, expect, it } from "vitest";
import { assertRouteExecutionIntentId, createRouteExecutionIntentId } from "./execution-intent";

describe("route execution intent identity", () => {
  it("creates a canonical UUIDv4-shaped intent from cryptographic bytes", () => {
    const source = { getRandomValues: (target: Uint8Array) => { target.set(Array.from({ length: 16 }, (_, index) => index)); return target; } };
    const id = createRouteExecutionIntentId(source);
    expect(id).toBe("realdex-intent:v1:00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(() => assertRouteExecutionIntentId(id)).not.toThrow();
  });

  it("rejects caller-chosen, malformed, non-v4, and non-canonical IDs", () => {
    for (const value of ["intent-1", "realdex-intent:v1:00010203-0405-0607-8809-0a0b0c0d0e0f", "REALDEX-INTENT:v1:00010203-0405-4607-8809-0a0b0c0d0e0f", "realdex-intent:v1:00010203-0405-4607-7809-0a0b0c0d0e0f"]) {
      expect(() => assertRouteExecutionIntentId(value)).toThrow("EXECUTION_INTENT_ID_INVALID");
    }
  });
});
