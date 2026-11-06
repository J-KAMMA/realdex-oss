const { expect } = require("chai");
const { ethers } = require("hardhat");

// The tier the v0.1 deployment uses. Tests must describe the real target.
const V01_FEE_BASIS_POINTS = 1;

// Regression guard for the self-audit finding H-1 (2026-09-04).
//
// `_sync()` reverts once a token balance passes the uint112 ceiling, and every
// state-changing entry point ends in `_sync()`. Before `skim()` existed, that
// made the ceiling a one-way door: anyone could transfer a pool past it and
// strand every liquidity provider permanently, at the cost of gas alone.
//
// These tests hold both halves in place. The ceiling still exists — that is the
// storage layout, not a bug — but there is now a path that works while it is
// exceeded, and it restores the pool. Delete `skim()` and the last test fails.
describe("pool reserve ceiling is recoverable", function () {
  const CEILING = (1n << 112n) - 1n;

  async function time() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  async function seededPool() {
    const [owner, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
    const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
    const Factory = await ethers.getContractFactory("LocalSwapFactory");
    const factory = await Factory.deploy();
    await factory.createPool(tokenA.target, tokenB.target, V01_FEE_BASIS_POINTS);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenB.target, V01_FEE_BASIS_POINTS));

    const liquidity = ethers.parseEther("10000");
    await tokenA.mint(owner.address, liquidity);
    await tokenB.mint(owner.address, liquidity);
    await tokenA.approve(pool.target, liquidity);
    await tokenB.approve(pool.target, liquidity);
    await pool.addLiquidity(liquidity, liquidity, 0, owner.address, (await time()) + 600);
    return { owner, outsider, tokenA, tokenB, pool, liquidity };
  }

  it("still lets anyone create the balance, because the demo token mints without control", async function () {
    const [, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Demo Amber", "AMBR", 18);
    await token.connect(outsider).mint(outsider.address, CEILING);
    expect(await token.balanceOf(outsider.address)).to.equal(CEILING);
  });

  it("still refuses to record a reserve above the ceiling", async function () {
    const { tokenA, pool, outsider } = await seededPool();
    await tokenA.connect(outsider).mint(outsider.address, CEILING);
    await tokenA.connect(outsider).transfer(pool.target, CEILING);
    await expect(pool.sync()).to.be.revertedWithCustomError(pool, "Overflow");
  });

  it("recovers through skim, and the provider gets their deposit back", async function () {
    const { owner, outsider, tokenA, tokenB, pool, liquidity } = await seededPool();
    const shares = await pool.balanceOf(owner.address);
    expect(shares).to.be.greaterThan(0n);

    await tokenA.connect(outsider).mint(outsider.address, CEILING);
    await tokenA.connect(outsider).transfer(pool.target, CEILING);

    // The pool is stuck while the balance is over the ceiling.
    const blocked = (await time()) + 600;
    await expect(pool.removeLiquidity(shares, 0, 0, owner.address, blocked)).to.be.revertedWithCustomError(pool, "Overflow");

    // skim works in exactly the state that blocks everything else, because it
    // never writes reserves. Anyone may call it.
    const donatedIsToken0 = (await pool.token0()) === tokenA.target;
    await expect(pool.connect(outsider).skim(outsider.address))
      .to.emit(pool, "Skim")
      .withArgs(outsider.address, outsider.address, donatedIsToken0 ? CEILING : 0n, donatedIsToken0 ? 0n : CEILING);

    // Reserves were untouched, so the recorded state still describes the pool.
    const [reserve0, reserve1] = await pool.getReserves();
    expect(reserve0).to.equal(liquidity);
    expect(reserve1).to.equal(liquidity);

    // And the pool is usable again: the provider can take their deposit out.
    await expect(pool.sync()).to.not.be.reverted;
    const balanceBefore = await tokenA.balanceOf(owner.address);
    await pool.removeLiquidity(shares, 0, 0, owner.address, (await time()) + 600);
    expect(await tokenA.balanceOf(owner.address)).to.be.greaterThan(balanceBefore);
    expect(await pool.balanceOf(owner.address)).to.equal(0n);
    // The donated excess went to the caller of skim, not to the pool.
    expect(await tokenB.balanceOf(pool.target)).to.be.lessThan(liquidity);
    expect(await tokenA.balanceOf(pool.target)).to.be.lessThan(liquidity);
  });

  it("refuses a pointless skim and an unusable recipient", async function () {
    const { pool, owner } = await seededPool();
    await expect(pool.skim(owner.address)).to.be.revertedWithCustomError(pool, "InsufficientAmount");
    await expect(pool.skim(ethers.ZeroAddress)).to.be.revertedWithCustomError(pool, "InvalidRecipient");
    await expect(pool.skim(pool.target)).to.be.revertedWithCustomError(pool, "InvalidRecipient");
  });
});
