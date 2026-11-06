import { keccak256, toUtf8Bytes } from "ethers";

const DOMAIN = /^[a-z0-9][a-z0-9._-]{2,100}$/;

type CanonicalValue =
  | ["null"]
  | ["boolean", boolean]
  | ["number", string]
  | ["bigint", string]
  | ["string", string]
  | ["array", CanonicalValue[]]
  | ["object", Array<[string, CanonicalValue]>];

export function cryptographicFingerprint(domain: string, value: unknown): string {
  if (!DOMAIN.test(domain)) throw new Error("CRYPTOGRAPHIC_FINGERPRINT_DOMAIN_INVALID");
  const payload = `RealDEX cryptographic fingerprint v1\n${domain}\n${JSON.stringify(canonicalValue(value))}`;
  return keccak256(toUtf8Bytes(payload));
}

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("CRYPTOGRAPHIC_FINGERPRINT_NUMBER_INVALID");
    return ["number", value.toString()];
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (Array.isArray(value)) return ["array", value.map(canonicalValue)];
  if (typeof value !== "object" || value === undefined) throw new Error("CRYPTOGRAPHIC_FINGERPRINT_VALUE_INVALID");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("CRYPTOGRAPHIC_FINGERPRINT_VALUE_INVALID");
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  if (entries.some(([key, entry]) => !key || key === "__proto__" || key === "constructor" || key === "prototype" || entry === undefined)) throw new Error("CRYPTOGRAPHIC_FINGERPRINT_VALUE_INVALID");
  return ["object", entries.map(([key, entry]) => [key, canonicalValue(entry)])];
}
