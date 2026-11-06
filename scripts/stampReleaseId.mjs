#!/usr/bin/env node
// Writes the release this build came from into dist, so a browser check can tell
// whether the bundle it is about to serve belongs to the tree it claims to test.
// Wired to npm's postbuild, so it cannot be forgotten by anyone who runs the build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEvmTestnetReleasePlan } from "./createEvmTestnetReleasePlan.mjs";
import { SERVED_RELEASE_STAMP } from "./v01ServedBuild.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(root, "dist");
if (!fs.existsSync(dist)) {
  console.error("no dist to stamp");
  process.exitCode = 1;
} else {
  const { releaseId } = await createEvmTestnetReleasePlan();
  fs.writeFileSync(path.join(dist, SERVED_RELEASE_STAMP), `${releaseId}\n`);
  console.log(`stamped dist with ${releaseId}`);
}
