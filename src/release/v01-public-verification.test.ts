import { describe, expect, it } from "vitest";
import { REVIEWED_V01_CONFIGURATION } from "../v01/reviewed-profile";
import { createV01ProfileReaders } from "./v01-profile-reader";
import { verifyV01Profile } from "./v01-profile";

// Live public-network check for the P0-01 requirement that two independent readers
// observe the deployment. It talks to real endpoints, so it is skipped unless
// REALDEX_LIVE=1 and never runs in the ordinary suite:
//
//   REALDEX_LIVE=1 npx vitest run src/release/v01-public-verification.test.ts
//
// It is read-only. No key is loaded, nothing is signed and nothing is sent.
const ENDPOINTS = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com"
];

describe.skipIf(!process.env.REALDEX_LIVE)("v0.1 public deployment verification", () => {
  it("verifies the committed profile against two independent readers", async () => {
    const configuration = REVIEWED_V01_CONFIGURATION;
    expect(configuration).not.toBeNull();
    const readers = createV01ProfileReaders(ENDPOINTS);
    expect(readers).toHaveLength(2);

    const verified = await verifyV01Profile(configuration!.profile, configuration!.pin, readers);

    expect(verified.status).toBe("verified-profile");
    expect(verified.fingerprint).toBe(configuration!.pin.profileFingerprint);
    expect(verified.readerIds).toHaveLength(2);
    expect(new Set(verified.readerIds).size).toBe(2);
    // Both directions of the fixed pair must be present, and they must differ.
    expect(verified.routes).toHaveLength(2);
    const pairs = verified.routes.map(route => `${route.sourceAsset}->${route.destinationAsset}`);
    expect(new Set(pairs).size).toBe(2);
    expect(pairs[0].split("->").reverse().join("->")).toBe(pairs[1]);
  }, 60_000);
});
