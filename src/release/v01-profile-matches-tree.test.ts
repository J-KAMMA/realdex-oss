import { describe, expect, it } from "vitest";
import { REVIEWED_V01_CONFIGURATION } from "../v01/reviewed-profile";
import { createEvmTestnetReleasePlan } from "../../scripts/createEvmTestnetReleasePlan.mjs";

// The pinned profile names a release. Nothing else in the suite checks that the
// release it names is the one this tree actually builds: the other assertions all
// compare the pin against itself, so a profile left over from an earlier release
// stays internally consistent and every test passes.
//
// That is not hypothetical. Fixing L-3 changed pnpm-workspace.yaml, which is one of
// the pinned release sources, so the tree moved from base-sepolia-c67ce7648726 to a
// new release while the committed profile still pointed at the old one — and the
// whole suite passed. Shipping that build would put a page in front of a participant
// claiming to be a release it is not.
//
// Regenerate with: node scripts/createV01Profile.mjs --write-source
//
// 2026-11-06: package.json, pnpm-workspace.yaml and pnpm-lock.yaml changed (WalletConnect
// removed, licence field changed to AGPL-3.0-only), so this tree no longer builds the
// release that was deployed to the public testnet. Re-pinning now would make the page
// claim a release that was never deployed, so the pin is left as is and this check is
// suspended until the next release is built, deployed and re-pinned
// (see docs/LICENSING.md). Set to false at that re-pin.
const PIN_PREDATES_RELICENSE = true;

describe.skipIf(REVIEWED_V01_CONFIGURATION === null || PIN_PREDATES_RELICENSE)("the pinned profile belongs to this tree", () => {
  it("names the release this tree builds", async () => {
    const { profile, pin } = REVIEWED_V01_CONFIGURATION!;
    const plan = await createEvmTestnetReleasePlan();
    expect(profile.deployment.releaseId).toBe(plan.releaseId);
    expect(profile.deployment.source.bundleSha256).toBe(plan.source.bundleSha256);
    // The pin is what the runtime compares against, so it has to move too.
    expect(pin.releaseId).toBe(plan.releaseId);
    expect(pin.bundleSha256).toBe(plan.source.bundleSha256);
  });
});
