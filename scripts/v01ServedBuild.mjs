import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEvmTestnetReleasePlan } from "./createEvmTestnetReleasePlan.mjs";

// Every browser check serves `dist` through vite preview. None of them built it,
// and none of them looked at whether it came from the sources sitting next to it.
// A stale `dist` therefore produces a green report about a release that is not the
// one under test — which already happened once in this project: a report was read
// as evidence for a new release when the bundle was still the previous one.
//
// The build stamps the release it produced into `dist/release-id.txt`
// (scripts/stampReleaseId.mjs, wired to npm's postbuild). This refuses to serve
// anything else.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVED_RELEASE_STAMP = "release-id.txt";

/**
 * Throws unless `dist` was built from the current tree.
 * Returns the release id it is about to serve, so a report can record it.
 */
export async function assertServedBuildIsCurrent (distDir = "dist") {
  const dist = path.resolve(root, distDir);
  if (!fs.existsSync(dist)) throw new Error(`SERVED_BUILD_MISSING: no ${distDir}; run npm run build`);
  const stampPath = path.join(dist, SERVED_RELEASE_STAMP);
  if (!fs.existsSync(stampPath)) {
    throw new Error(`SERVED_BUILD_UNSTAMPED: ${distDir}/${SERVED_RELEASE_STAMP} is missing, so the served bundle cannot be tied to any release; run npm run build`);
  }
  const served = fs.readFileSync(stampPath, "utf8").trim();
  const { releaseId } = await createEvmTestnetReleasePlan();
  if (served !== releaseId) {
    throw new Error(`SERVED_BUILD_STALE: ${distDir} was built from ${served}, the tree is ${releaseId}; run npm run build before checking`);
  }
  return releaseId;
}
