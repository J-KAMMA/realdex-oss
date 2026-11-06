const { expect } = require("chai");
const { ethers } = require("hardhat");

// Pins what an off-ratio deposit leaves behind.
//
// M-2 made the pool take only what the current ratio credits, so the surplus is
// no longer forfeited. But a depositor who approved the full amount is left with
// an allowance standing on the pool for the difference, and nothing tells them.
// v0.1 held swaps to "approve exactly this trade, end at zero" and proved it on a
// public network (P0-06); liquidity does not meet that bar.
//
// These tests describe today's behaviour, on purpose. When the ratio is settled
// at execution time — see the internal design notes (not published), option A, a router-side
// addLiquidity — the residue assertion here is what has to change, which is how
// the fix leaves a trace instead of quietly passing.
const FEE = 1;
const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;

describe("liquidity leaves an allowance behind when the deposit is off ratio", () => {
  async function pooled() {
    const [depositor] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
    const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
    await tokenA.mint(depositor.address, ethers.parseEther("100000"));
    await tokenB.mint(depositor.address, ethers.parseEther("100000"));

    const factory = await (await ethers.getContractFactory("LocalSwapFactory")).deploy();
    await factory.createPool(tokenA.target, tokenB.target, FEE);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenB.target, FEE));

    // Seed 1 : 2 so an off-ratio deposit has a definite correct answer.
    const ordered = async (a, b) => ((await pool.token0()) === tokenA.target ? [a, b] : [b, a]);
    const seedA = ethers.parseEther("10000");
    const seedB = ethers.parseEther("20000");
    await tokenA.approve(pool.target, seedA);
    await tokenB.approve(pool.target, seedB);
    const [seed0, seed1] = await ordered(seedA, seedB);
    await pool.addLiquidity(seed0, seed1, 0, depositor.address, await DEADLINE());
    return { depositor, tokenA, tokenB, pool, ordered };
  }

  it("takes only the ratio and leaves the rest approved", async () => {
    const { depositor, tokenA, tokenB, pool, ordered } = await pooled();
    const typedA = ethers.parseEther("100");
    const typedB = ethers.parseEther("500");
    await tokenA.approve(pool.target, typedA);
    await tokenB.approve(pool.target, typedB);

    const beforeA = await tokenA.balanceOf(depositor.address);
    const beforeB = await tokenB.balanceOf(depositor.address);
    const [amount0, amount1] = await ordered(typedA, typedB);
    await pool.addLiquidity(amount0, amount1, 0, depositor.address, await DEADLINE());

    // 1 : 2 credits 100 : 200, not 100 : 500.
    expect(beforeA - (await tokenA.balanceOf(depositor.address))).to.equal(typedA);
    expect(beforeB - (await tokenB.balanceOf(depositor.address))).to.equal(ethers.parseEther("200"));

    expect(await tokenA.allowance(depositor.address, pool.target)).to.equal(0n);
    // The residue. 500 approved, 200 taken, 300 still withdrawable by the pool.
    expect(await tokenB.allowance(depositor.address, pool.target)).to.equal(ethers.parseEther("300"));
  });

  it("leaves nothing behind when the deposit is already on ratio", async () => {
    const { depositor, tokenA, tokenB, pool, ordered } = await pooled();
    const typedA = ethers.parseEther("100");
    const typedB = ethers.parseEther("200");
    await tokenA.approve(pool.target, typedA);
    await tokenB.approve(pool.target, typedB);
    const [amount0, amount1] = await ordered(typedA, typedB);
    await pool.addLiquidity(amount0, amount1, 0, depositor.address, await DEADLINE());

    expect(await tokenA.allowance(depositor.address, pool.target)).to.equal(0n);
    expect(await tokenB.allowance(depositor.address, pool.target)).to.equal(0n);
  });

  it("does not take the surplus, whichever side is over", async () => {
    // The other direction: too much of token A instead of token B.
    const { depositor, tokenA, tokenB, pool, ordered } = await pooled();
    const typedA = ethers.parseEther("400");
    const typedB = ethers.parseEther("200");
    await tokenA.approve(pool.target, typedA);
    await tokenB.approve(pool.target, typedB);
    const beforeA = await tokenA.balanceOf(depositor.address);
    const [amount0, amount1] = await ordered(typedA, typedB);
    await pool.addLiquidity(amount0, amount1, 0, depositor.address, await DEADLINE());

    expect(beforeA - (await tokenA.balanceOf(depositor.address))).to.equal(ethers.parseEther("100"));
    expect(await tokenA.allowance(depositor.address, pool.target)).to.equal(ethers.parseEther("300"));
    expect(await tokenB.allowance(depositor.address, pool.target)).to.equal(0n);
  });

  it("credits shares for what was taken, not for what was typed", async () => {
    const { depositor, tokenA, tokenB, pool, ordered } = await pooled();
    const supplyBefore = await pool.totalSupply();
    const typedA = ethers.parseEther("100");
    await tokenA.approve(pool.target, typedA);
    await tokenB.approve(pool.target, ethers.parseEther("500"));
    const [amount0, amount1] = await ordered(typedA, ethers.parseEther("500"));
    await pool.addLiquidity(amount0, amount1, 0, depositor.address, await DEADLINE());

    // 100 into a 10000 side is 1% of the pool, whatever the other side said.
    const minted = (await pool.totalSupply()) - supplyBefore;
    expect(minted).to.equal(supplyBefore / 100n);
  });
});
