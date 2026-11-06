const { expect } = require("chai");
const { ethers } = require("hardhat");

// `lock` is what stands between "the reserves are stale for one instruction" and
// a pool anyone can drain. ERC-20 has no recipient hook, so the way back in is
// the token itself: the pool hands over the output token, and that token's
// `transfer` calls the pool again before `_sync` has recorded anything.
//
// Nothing in this suite had ever made that modifier fire, so its behaviour was
// carried by reading. These tests make the call and read the refusal.
const FEE = 1;
const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;
const one = (value) => ethers.parseEther(value);
const REENTRANCY = ethers.id("Reentrancy()").slice(0, 10);

describe("re-entering the pool through its own output token", () => {
  async function fixture () {
    const [trader] = await ethers.getSigners();
    const honest = await (await ethers.getContractFactory("MockERC20")).deploy("Demo Amber", "AMBR", 18);
    const hostile = await (await ethers.getContractFactory("ReentrantERC20")).deploy("Hostile", "EVIL", 18);
    await honest.mint(trader.address, one("100000"));
    await hostile.mint(trader.address, one("100000"));

    const factory = await (await ethers.getContractFactory("LocalSwapFactory")).deploy();
    await factory.createPool(honest.target, hostile.target, FEE);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(honest.target, hostile.target, FEE));

    // Seeded while the token is still honest: arming it is a separate step.
    await honest.approve(pool.target, one("10000"));
    await hostile.approve(pool.target, one("10000"));
    const token0 = await pool.token0();
    const [seed0, seed1] = token0 === honest.target ? [one("10000"), one("10000")] : [one("10000"), one("10000")];
    await pool.addLiquidity(seed0, seed1, 1, trader.address, await DEADLINE());

    return { trader, honest, hostile, pool };
  }

  it("refuses the re-entrant swap and still settles the outer one", async () => {
    const { trader, honest, hostile, pool } = await fixture();
    const reentrant = pool.interface.encodeFunctionData("swapExactIn", [honest.target, one("1"), 1, trader.address, await DEADLINE()]);
    await hostile.arm(pool.target, reentrant);

    await honest.approve(pool.target, one("100"));
    await pool.swapExactIn(honest.target, one("100"), 1, trader.address, await DEADLINE());

    // The callback ran — otherwise this proves nothing — and was refused by name.
    expect(await hostile.attempted()).to.equal(true);
    expect(await hostile.succeeded()).to.equal(false);
    expect(await hostile.result()).to.equal(REENTRANCY);

    // And the outer swap still recorded exactly one trade: reserves match the
    // balances the pool actually holds.
    const [reserve0, reserve1] = await pool.getReserves();
    const token0 = await pool.token0();
    const balance0 = await (token0 === honest.target ? honest : hostile).balanceOf(pool.target);
    const balance1 = await (token0 === honest.target ? hostile : honest).balanceOf(pool.target);
    expect(reserve0).to.equal(balance0);
    expect(reserve1).to.equal(balance1);
  });

  it("refuses a re-entrant withdrawal during a swap", async () => {
    // A different door into the same instant: reserves still stale, shares still
    // priced against them.
    const { trader, honest, hostile, pool } = await fixture();
    const reentrant = pool.interface.encodeFunctionData("removeLiquidity", [one("1"), 1, 1, trader.address, await DEADLINE()]);
    await hostile.arm(pool.target, reentrant);

    await honest.approve(pool.target, one("100"));
    await pool.swapExactIn(honest.target, one("100"), 1, trader.address, await DEADLINE());

    expect(await hostile.attempted()).to.equal(true);
    expect(await hostile.succeeded()).to.equal(false);
    expect(await hostile.result()).to.equal(REENTRANCY);
  });

  it("refuses a re-entrant sync, which would record the half-finished state", async () => {
    // sync() is the one call that writes reserves from balances. Letting it run
    // mid-swap would record a state the swap has not finished making.
    const { trader, honest, hostile, pool } = await fixture();
    await hostile.arm(pool.target, pool.interface.encodeFunctionData("sync", []));

    await honest.approve(pool.target, one("100"));
    await pool.swapExactIn(honest.target, one("100"), 1, trader.address, await DEADLINE());

    expect(await hostile.attempted()).to.equal(true);
    expect(await hostile.succeeded()).to.equal(false);
    expect(await hostile.result()).to.equal(REENTRANCY);
  });

  it("lets the same call through once the first one has finished", async () => {
    // The lock releases; it does not wedge the pool. Without this the tests above
    // would also pass against a pool that simply refused everything.
    const { trader, honest, hostile, pool } = await fixture();
    await hostile.arm(pool.target, pool.interface.encodeFunctionData("sync", []));
    await honest.approve(pool.target, one("100"));
    await pool.swapExactIn(honest.target, one("100"), 1, trader.address, await DEADLINE());
    expect(await hostile.succeeded()).to.equal(false);

    await expect(pool.sync()).to.not.be.reverted;
  });
});
