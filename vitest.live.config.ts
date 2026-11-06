import { defineConfig } from "vitest/config";

// The public-network reader check, on its own.
//
// It is excluded from vitest.config.ts because it cannot run offline, where it could
// only report as pending — and the acceptance gate refuses a run containing any pending
// test, for the good reason that a pending test looks like a passing one in a summary.
// A CLI filename filter does not defeat that exclusion, so the file needs a config that
// includes it rather than a flag that argues with one.
//
// It is read-only: no key is loaded, nothing is signed, nothing is submitted. It still
// talks to two real public endpoints, so it is deliberately not part of any offline run.
// The acceptance gate public-testnet-readers invokes this config when the operator has
// enabled public reads, and blocks with a declared reason when they have not.
//
//   REALDEX_LIVE=1 node node_modules/vitest/vitest.mjs run --config vitest.live.config.ts
export default defineConfig({
  test: {
    include: ["src/release/v01-public-verification.test.ts"],
    environment: "node",
    minWorkers: 1,
    maxWorkers: 1,
    // Two endpoints, several reads each, over the public internet.
    testTimeout: 120_000
  }
});
