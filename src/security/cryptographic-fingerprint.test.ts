import { describe, expect, it } from "vitest";
import { cryptographicFingerprint } from "./cryptographic-fingerprint";

describe("domain-separated cryptographic fingerprints", () => {
  it("returns a deterministic Keccak-256 identity independent of object key order", () => {
    const left = cryptographicFingerprint("realdex.test.v1", { beta: 2, alpha: 1n, nested: { y: true, x: "value" } });
    const right = cryptographicFingerprint("realdex.test.v1", { nested: { x: "value", y: true }, alpha: 1n, beta: 2 });
    expect(left).toMatch(/^0x[0-9a-f]{64}$/);
    expect(right).toBe(left);
  });

  it("separates domains, primitive types, and array order", () => {
    expect(cryptographicFingerprint("realdex.route.v2", { value: 1 })).not.toBe(cryptographicFingerprint("realdex.request.v2", { value: 1 }));
    expect(cryptographicFingerprint("realdex.test.v1", 1)).not.toBe(cryptographicFingerprint("realdex.test.v1", 1n));
    expect(cryptographicFingerprint("realdex.test.v1", ["a", "b"])).not.toBe(cryptographicFingerprint("realdex.test.v1", ["b", "a"]));
  });

  it("rejects ambiguous or non-canonical inputs", () => {
    expect(() => cryptographicFingerprint("bad domain", {})).toThrow("CRYPTOGRAPHIC_FINGERPRINT_DOMAIN_INVALID");
    expect(() => cryptographicFingerprint("realdex.test.v1", 1.5)).toThrow("CRYPTOGRAPHIC_FINGERPRINT_NUMBER_INVALID");
    expect(() => cryptographicFingerprint("realdex.test.v1", { value: undefined })).toThrow("CRYPTOGRAPHIC_FINGERPRINT_VALUE_INVALID");
    expect(() => cryptographicFingerprint("realdex.test.v1", new Date())).toThrow("CRYPTOGRAPHIC_FINGERPRINT_VALUE_INVALID");
  });
});
