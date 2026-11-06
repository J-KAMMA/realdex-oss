import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // The public-network reader check cannot run here. It is gated on REALDEX_LIVE, so
    // in this suite it could only ever report as pending — and a pending test is
    // indistinguishable from a passing one in a summary, which is why the acceptance
    // gate refuses a run that contains any. Leaving it in meant root-ui-tests could
    // never pass, no matter what the code did.
    //
    // Excluding it does not make it disappear: it runs as its own named acceptance
    // gate, public-testnet-readers, which blocks with a declared reason when public
    // reads are not enabled. An invisible skip became a visible gate. Run it directly
    // with `npm run test:live`.
    //
    // One file by name, not a *.live.test.ts pattern: read-pool-tiers.live.test.ts
    // also calls itself live but runs against a local pinned Anvil, and a pattern
    // would silently drop that coverage.
    exclude: [...configDefaults.exclude, "src/release/v01-public-verification.test.ts"],
    environment: "node",
    // Bound simultaneous Hardhat/crypto/jsdom workers on shared development PCs.
    // Keep real parallel execution without changing assertions or test timeouts.
    minWorkers: 1,
    maxWorkers: 2,
    // The default is five seconds. The suite now renders whole screens in jsdom,
    // and under load that was enough to time out an unrelated Universe test that
    // passes on its own — a red run that says nothing about the code. Long enough
    // to absorb a busy machine, short enough that a real hang still fails.
    testTimeout: 20_000
  }
});
