const { expect } = require("chai");
const { ethers } = require("hardhat");

// Covers the 2026-09-04 audit fixes: the swap fee (M-1), off-ratio deposits
// (M-2) and the refusal of an unprotected swap (L-2), plus the fee tiers the
// factory now supports.
//
// The expected outputs here are computed independently, not read back from
// `quoteExactIn`. A test that asks the contract what the answer should be passes
// whatever the contract does, including doing nothing — the existing swap test
// in LocalSwap.cjs has that shape and cannot see a fee at all.
describe("swap fee, deposits and tiers", function () {
  const V01_FEE_BASIS_POINTS = 1; // 0.01%, the tier the v0.1 deployment uses
  const BASIS_POINTS = 10_000n;

  function expectedOut(amountIn, reserveIn, reserveOut, feeBasisPoints) {
    const afterFee = amountIn * (BASIS_POINTS - BigInt(feeBasisPoints));
    return (afterFee * reserveOut) / (reserveIn * BASIS_POINTS + afterFee);
  }

  async function time() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  async function seeded(feeBasisPoints = V01_FEE_BASIS_POINTS, reserve0 = "10000", reserve1 = "20000") {
    const [owner, trader] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
    const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
    const Factory = await ethers.getContractFactory("LocalSwapFactory");
    const factory = await Factory.deploy();
    await factory.createPool(tokenA.target, tokenB.target, feeBasisPoints);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenB.target, feeBasisPoints));

    const token0 = await pool.token0();
    const first = token0 === tokenA.target ? tokenA : tokenB;
    const second = token0 === tokenA.target ? tokenB : tokenA;
    const amount0 = ethers.parseEther(reserve0);
    const amount1 = ethers.parseEther(reserve1);
    await first.mint(owner.address, amount0 * 10n);
    await second.mint(owner.address, amount1 * 10n);
    await first.approve(pool.target, amount0 * 10n);
    await second.approve(pool.target, amount1 * 10n);
    await pool.addLiquidity(amount0, amount1, 0, owner.address, (await time()) + 600);
    return { owner, trader, factory, pool, first, second, amount0, amount1 };
  }

  it("withholds the fee and leaves it in the pool", async function () {
    const { owner, pool, first, second, amount0, amount1 } = await seeded();
    const amountIn = ethers.parseEther("100");

    const predicted = expectedOut(amountIn, amount0, amount1, V01_FEE_BASIS_POINTS);
    const withoutFee = expectedOut(amountIn, amount0, amount1, 0);
    // The whole point: a fee must change the answer, or it is not being taken.
    expect(predicted).to.be.lessThan(withoutFee);
    expect(await pool.quoteExactIn(first.target, amountIn)).to.equal(predicted);

    const kBefore = amount0 * amount1;
    await first.approve(pool.target, amountIn);
    await pool.swapExactIn(first.target, amountIn, predicted, owner.address, (await time()) + 600);

    const [reserve0After, reserve1After] = await pool.getReserves();
    expect(reserve0After).to.equal(amount0 + amountIn);
    expect(reserve1After).to.equal(amount1 - predicted);
    // The withheld amount stays in the pool, so the invariant rises. That rise is
    // the providers' entire compensation; without it they only ever lose.
    expect(reserve0After * reserve1After).to.be.greaterThan(kBefore);
    expect(await second.balanceOf(pool.target)).to.equal(reserve1After);
  });

  it("pays the fee to the providers, not to any recipient", async function () {
    const { owner, pool, first, amount0, amount1 } = await seeded();
    const shares = await pool.balanceOf(owner.address);
    const amountIn = ethers.parseEther("500");
    await first.approve(pool.target, amountIn);
    const quote = await pool.quoteExactIn(first.target, amountIn);
    await pool.swapExactIn(first.target, amountIn, quote, owner.address, (await time()) + 600);

    // Nothing was minted to anyone and no address holds a fee balance: the only
    // way the fee leaves is by redeeming shares, which is the providers' claim.
    expect(await pool.balanceOf(owner.address)).to.equal(shares);
    const [reserve0After, reserve1After] = await pool.getReserves();
    expect(reserve0After * reserve1After).to.be.greaterThan(amount0 * amount1);
  });

  it("refuses a pool that could never pay its providers, or that charges too much", async function () {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("A", "A", 18);
    const tokenB = await Token.deploy("B", "B", 18);
    const Factory = await ethers.getContractFactory("LocalSwapFactory");
    const factory = await Factory.deploy();
    const Pool = await ethers.getContractFactory("LocalSwapPool");

    await expect(factory.createPool(tokenA.target, tokenB.target, 0)).to.be.revertedWithCustomError(Pool, "InvalidFee");
    await expect(factory.createPool(tokenA.target, tokenB.target, 101)).to.be.revertedWithCustomError(Pool, "InvalidFee");
    await expect(factory.createPool(tokenA.target, tokenB.target, 1)).to.not.be.reverted;
    await expect(factory.createPool(tokenA.target, tokenB.target, 100)).to.not.be.reverted;
    expect(owner).to.not.equal(undefined);
  });

  it("puts each tier in its own pool, at its own address", async function () {
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("A", "A", 18);
    const tokenB = await Token.deploy("B", "B", 18);
    const Factory = await ethers.getContractFactory("LocalSwapFactory");
    const factory = await Factory.deploy();

    await factory.createPool(tokenA.target, tokenB.target, 1);
    await factory.createPool(tokenA.target, tokenB.target, 30);
    const low = await factory.getPool(tokenA.target, tokenB.target, 1);
    const high = await factory.getPool(tokenA.target, tokenB.target, 30);

    expect(low).to.not.equal(high);
    expect(low).to.not.equal(ethers.ZeroAddress);
    expect(await factory.allPoolsLength()).to.equal(2n);
    // The fee is part of the pool's identity, so one address never changes tier.
    expect(await (await ethers.getContractAt("LocalSwapPool", low)).feeBasisPoints()).to.equal(1n);
    expect(await (await ethers.getContractAt("LocalSwapPool", high)).feeBasisPoints()).to.equal(30n);
    // Asking for a tier that was never created must not resolve to another one.
    expect(await factory.getPool(tokenA.target, tokenB.target, 5)).to.equal(ethers.ZeroAddress);
  });

  it("collects only what the ratio can credit when a deposit is off-ratio", async function () {
    const { owner, pool, first, second, amount0, amount1 } = await seeded();
    const held0Before = await first.balanceOf(owner.address);
    const held1Before = await second.balanceOf(owner.address);

    // Offer twice as much of token1 as the pool ratio can use.
    const offer0 = ethers.parseEther("100");
    const offer1 = (offer0 * amount1) / amount0 * 2n;
    await pool.addLiquidity(offer0, offer1, 0, owner.address, (await time()) + 600);

    const taken0 = held0Before - (await first.balanceOf(owner.address));
    const taken1 = held1Before - (await second.balanceOf(owner.address));
    expect(taken0).to.equal(offer0);
    // The surplus is never collected, so it cannot be silently forfeited.
    expect(taken1).to.equal((offer0 * amount1) / amount0);
    expect(taken1).to.be.lessThan(offer1);
  });

  it("refuses a swap with no minimum at all", async function () {
    const { owner, pool, first } = await seeded();
    const amountIn = ethers.parseEther("1");
    await first.approve(pool.target, amountIn);
    await expect(pool.swapExactIn(first.target, amountIn, 0, owner.address, (await time()) + 600))
      .to.be.revertedWithCustomError(pool, "SlippageExceeded");
  });
});
