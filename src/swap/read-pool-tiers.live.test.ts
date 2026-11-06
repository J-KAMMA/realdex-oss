import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonRpcProvider } from "ethers";
import { createBrowserPoolTierReader, readPoolTiers } from "./read-pool-tiers";
import { describeProviderTiers } from "./provider-tier-choice";

// Walks a real registry through `allPoolsLength`, which only shipped in the fourth
// deployment and had never been called against a chain. The unit tests use a fake
// reader; this one proves the ABI, the ordering and the pair filter hold against
// contracts that were actually compiled and deployed.
//
// The full acceptance runner supplies the existing pinned Anvil. In that mode
// this test deploys its own disposable contracts and reads them over real HTTP.
// Without it, an explicitly seeded local chain remains available for manual runs.
//   npm run node
//   npm run seed:multi-venue          (one factory, 1 bp thin and 30 bp deep)
//   REALDEX_LOCAL_FACTORY=0x… REALDEX_LOCAL_TOKEN_A=0x… REALDEX_LOCAL_TOKEN_B=0x… npx vitest run src/swap/read-pool-tiers.live.test.ts
let factory = process.env.REALDEX_LOCAL_FACTORY;
let tokenA = process.env.REALDEX_LOCAL_TOKEN_A;
let tokenB = process.env.REALDEX_LOCAL_TOKEN_B;
const configuredTargets = [factory, tokenA, tokenB].some(Boolean);
const pinnedAnvil = Boolean(process.env.REALDEX_ANVIL_BINARY);

describe.skipIf(!configuredTargets && !pinnedAnvil)("reading tiers from a real registry", () => {
  let provider: JsonRpcProvider;
  let closeFixture: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (configuredTargets) {
      expect([factory, tokenA, tokenB].every(Boolean), "all three explicit local targets are required").toBe(true);
      provider = new JsonRpcProvider(process.env.REALDEX_LOCAL_RPC ?? "http://127.0.0.1:8545");
      return;
    }
    const require = createRequire(import.meta.url);
    process.env.HARDHAT_CONFIG = fileURLToPath(new URL("../../hardhat.v01-test.config.cjs", import.meta.url));
    process.env.HARDHAT_NETWORK = "hardhat";
    const hre = require("hardhat");
    await hre.run("compile");
    const { openPinnedRootEvm } = require("../../integration/anvil/root-contract-fixture.cjs");
    const fixture = await openPinnedRootEvm(hre);
    closeFixture = () => fixture.close();
    provider = fixture.provider;
    const amber = await fixture.deploy("MockERC20", "Demo Amber", "AMBR", 18);
    const jade = await fixture.deploy("MockERC20", "Demo Jade", "JADE", 18);
    const registry = await fixture.deploy("LocalSwapFactory");
    tokenA = await amber.getAddress();
    tokenB = await jade.getAddress();
    factory = await registry.getAddress();
    await (await amber.mint(fixture.owner.address, hre.ethers.parseEther("300000"))).wait();
    await (await jade.mint(fixture.owner.address, hre.ethers.parseEther("600000"))).wait();
    for (const [fee, a, b] of [[1, "10000", "20000"], [30, "200000", "400000"]] as const) {
      await (await registry.createPool(tokenA, tokenB, fee)).wait();
      const address = await registry.getPool(tokenA, tokenB, fee);
      const pool = await fixture.contractAt("LocalSwapPool", address);
      const amountA = hre.ethers.parseEther(a), amountB = hre.ethers.parseEther(b);
      await (await amber.approve(address, amountA)).wait();
      await (await jade.approve(address, amountB)).wait();
      const amounts = (await pool.token0()) === tokenA ? [amountA, amountB] : [amountB, amountA];
      const latest = await provider.getBlock("latest");
      expect(latest).not.toBeNull();
      await (await pool.addLiquidity(...amounts, 1n, fixture.owner.address, latest!.timestamp + 3600)).wait();
    }
  });

  afterAll(async () => {
    if (closeFixture) await closeFixture();
    else provider?.destroy();
  });

  it("finds both seeded tiers, in registry order, with their real reserves", async () => {
    const tiers = await readPoolTiers(factory!, tokenA!, tokenB!, createBrowserPoolTierReader(provider));

    expect(tiers.map(item => item.feeBasisPoints)).toEqual([1, 30]);
    // The seed makes the 1 bp pool thin and the 30 bp pool deep on purpose.
    expect(tiers[1].reserve0 + tiers[1].reserve1).toBeGreaterThan(tiers[0].reserve0 + tiers[0].reserve1);
    for (const tier of tiers) {
      expect(tier.totalSupply).toBeGreaterThan(0n);
      expect(tier.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }

    // And the description built from those readings says what it should.
    const rows = describeProviderTiers(tiers, 10n ** 20n, 10n ** 20n, tiers[0].pool, 18, 18);
    expect(rows).toHaveLength(2);
    expect(rows[0].selected).toBe(true);
    expect(rows[0].shareBasisPoints).toBeGreaterThan(rows[1].shareBasisPoints);
    for (const row of rows) expect(row.empty).toBe(false);
  });
});
