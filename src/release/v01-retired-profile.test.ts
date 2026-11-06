import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { REVIEWED_V01_CONFIGURATION } from "../v01/reviewed-profile";
import { parseV01Profile, v01ProfileFingerprint } from "./v01-profile";
import { createEvmTestnetReleasePlan } from "../../scripts/createEvmTestnetReleasePlan.mjs";

const RETIRED_RELEASE_ID = "base-sepolia-5885d029020b";
const RETIRED_BUNDLE = "sha256:5885d029020bd07bfc0de545dd94988d0b0b1e418639ce54ae20fa857de9eea8";
const ARCHIVE = "../../artifacts-v01/reviewed-profile-84532-retired-5885d029020b.json";
const readArchive = async () => JSON.parse(await readFile(new URL(ARCHIVE, import.meta.url), "utf8"));

// Historical integrity, not a fresh observation of the public chain.
//
// This began as "the build ships no profile at all", which was correct while no
// deployed pool had been built from this code. A pool has since been deployed to Base
// Sepolia and approved, so that assertion no longer states the rule — it states one
// release's circumstances. The rule it was always for is narrower and still holds:
// the obsolete release must never come back, and its record must never be relabelled
// as the approval for a later one.
//
// The archive it reads used to be the live profile file, which the generator
// overwrote in place. It is now kept separately, so retiring a release no longer
// leaves its record only in git history.
describe("v0.26 public profile retirement", () => {
  it("never ships the obsolete public-testnet profile", async () => {
    const plan = await createEvmTestnetReleasePlan();
    expect(plan.releaseId).not.toBe(RETIRED_RELEASE_ID);
    expect(plan.source.bundleSha256).not.toBe(RETIRED_BUNDLE);
    if (REVIEWED_V01_CONFIGURATION === null) return;
    expect(REVIEWED_V01_CONFIGURATION.pin.releaseId).not.toBe(RETIRED_RELEASE_ID);
    expect(REVIEWED_V01_CONFIGURATION.pin.bundleSha256).not.toBe(RETIRED_BUNDLE);
    expect(REVIEWED_V01_CONFIGURATION.profile.deployment.releaseId).not.toBe(RETIRED_RELEASE_ID);
  });

  it("retains the original historical fingerprint without relabelling approval", async () => {
    const archived = await readArchive();
    const profile = parseV01Profile(archived.profile);
    expect(profile.deployment.releaseId).toBe(RETIRED_RELEASE_ID);
    expect(archived.pin.bundleSha256).toBe(RETIRED_BUNDLE);
    expect(v01ProfileFingerprint(profile)).toBe(archived.pin.profileFingerprint);
    const plan = await createEvmTestnetReleasePlan();
    expect(plan.source.bundleSha256).not.toBe(archived.pin.bundleSha256);
  });

  // Relabelling would leave the retired deployment's own receipts underneath a newer
  // release name. A shipped profile has to name deployments of its own. If some later
  // release does mean to adopt these exact contracts, that is a decision to review
  // deliberately, and failing here is the right place for it to surface.
  it("does not carry the retired release's receipts under a newer name", async () => {
    if (REVIEWED_V01_CONFIGURATION === null) return;
    const archived = parseV01Profile((await readArchive()).profile);
    const shipped = parseV01Profile(REVIEWED_V01_CONFIGURATION.profile);
    expect(v01ProfileFingerprint(shipped)).not.toBe(v01ProfileFingerprint(archived));
    for (const contract of ["factory", "router"] as const) {
      expect(shipped.deployment.contracts[contract].deploymentTxHash)
        .not.toBe(archived.deployment.contracts[contract].deploymentTxHash);
    }
  });
});
