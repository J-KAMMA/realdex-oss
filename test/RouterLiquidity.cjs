const { expect } = require("chai");
const { ethers } = require("hardhat");

// The router settles the deposit ratio at execution time and pulls exactly that.
//
// Depositing straight into the pool leaves an allowance behind whenever the amounts
// are off ratio: the pool credits only what the ratio allows, and the difference
// stays approved. test/LiquidityAllowance.cjs pins that behaviour with the measured
// numbers — 100 / 500 into a 1 : 2 pool is taken as 100 / 200 and leaves 300. These
// tests use the same numbers so the two files can be read against each other.
const FEE = 1;
const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;
const one = (value) => ethers.parseEther(value);

describe("depositing through the router leaves nothing approved", () => {
  async function fixture () {
    const [depositor, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
    const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
    await tokenA.mint(depositor.address, one("100000"));
    await tokenB.mint(depositor.address, one("100000"));

    const factory = await (await ethers.getContractFactory("LocalSwapFactory")).deploy();
    await factory.createPool(tokenA.target, tokenB.target, FEE);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenB.target, FEE));
    const router = await (await ethers.getContractFactory("LocalSwapRouter")).deploy();

    const ordered = async (a, b) => ((await pool.token0()) === tokenA.target ? [a, b] : [b, a]);

    // Seed 1 : 2 straight into the pool, the way a first provider must.
    await tokenA.approve(pool.target, one("10000"));
    await tokenB.approve(pool.target, one("20000"));
    const [seed0, seed1] = await ordered(one("10000"), one("20000"));
    await pool.addLiquidity(seed0, seed1, 1, depositor.address, await DEADLINE());

    return { depositor, other, tokenA, tokenB, pool, router, ordered };
  }

  it("pulls only the ratio and leaves no allowance anywhere", async () => {
    const { depositor, tokenA, tokenB, pool, router, ordered } = await fixture();
    // Approve the router for what was typed, off ratio on purpose.
    await tokenA.approve(router.target, one("100"));
    await tokenB.approve(router.target, one("500"));

    const beforeA = await tokenA.balanceOf(depositor.address);
    const beforeB = await tokenB.balanceOf(depositor.address);
    const [desired0, desired1] = await ordered(one("100"), one("500"));
    const [min0, min1] = await ordered(one("99"), one("199"));
    await router.addLiquidity(pool.target, desired0, desired1, min0, min1, 1, depositor.address, await DEADLINE());

    // 100 / 200, not 100 / 500.
    expect(beforeA - (await tokenA.balanceOf(depositor.address))).to.equal(one("100"));
    expect(beforeB - (await tokenB.balanceOf(depositor.address))).to.equal(one("200"));

    // This is the point: nothing is left approved to anyone, on either token.
    expect(await tokenA.allowance(depositor.address, router.target)).to.equal(0n);
    expect(await tokenB.allowance(depositor.address, router.target)).to.equal(one("300"));
    expect(await tokenA.allowance(router.target, pool.target)).to.equal(0n);
    expect(await tokenB.allowance(router.target, pool.target)).to.equal(0n);
    expect(await tokenA.allowance(depositor.address, pool.target)).to.equal(0n);
    expect(await tokenB.allowance(depositor.address, pool.target)).to.equal(0n);
  });

  it("keeps no balance of its own", async () => {
    const { depositor, tokenA, tokenB, pool, router, ordered } = await fixture();
    await tokenA.approve(router.target, one("400"));
    await tokenB.approve(router.target, one("200"));
    const [desired0, desired1] = await ordered(one("400"), one("200"));
    const [min0, min1] = await ordered(one("99"), one("199"));
    await router.addLiquidity(pool.target, desired0, desired1, min0, min1, 1, depositor.address, await DEADLINE());

    expect(await tokenA.balanceOf(router.target)).to.equal(0n);
    expect(await tokenB.balanceOf(router.target)).to.equal(0n);
    expect(await pool.balanceOf(router.target)).to.equal(0n);
  });

  it("mints the shares to the recipient, not to itself", async () => {
    const { depositor, other, tokenA, tokenB, pool, router, ordered } = await fixture();
    await tokenA.approve(router.target, one("100"));
    await tokenB.approve(router.target, one("200"));
    const [desired0, desired1] = await ordered(one("100"), one("200"));
    const [min0, min1] = await ordered(one("99"), one("199"));
    const before = await pool.balanceOf(other.address);
    await router.addLiquidity(pool.target, desired0, desired1, min0, min1, 1, other.address, await DEADLINE());
    expect(await pool.balanceOf(other.address)).to.be.greaterThan(before);
    expect(await pool.balanceOf(router.target)).to.equal(0n);
  });

  it("refuses a deposit whose settled amounts fall under the floor", async () => {
    const { depositor, tokenA, tokenB, pool, router, ordered } = await fixture();
    await tokenA.approve(router.target, one("100"));
    await tokenB.approve(router.target, one("500"));
    const [desired0, desired1] = await ordered(one("100"), one("500"));
    // Demanding the full 500 of the second token cannot hold at a 1 : 2 ratio.
    const [min0, min1] = await ordered(one("100"), one("500"));
    await expect(router.addLiquidity(pool.target, desired0, desired1, min0, min1, 1, depositor.address, await DEADLINE()))
      .to.be.revertedWithCustomError(router, "SlippageExceeded");
  });

  it("refuses a floor of zero, the same way a swap does", async () => {
    const { depositor, tokenA, tokenB, pool, router, ordered } = await fixture();
    await tokenA.approve(router.target, one("100"));
    await tokenB.approve(router.target, one("200"));
    const [desired0, desired1] = await ordered(one("100"), one("200"));
    const [min0, min1] = await ordered(one("99"), one("199"));
    for (const args of [[0, min1, 1], [min0, 0, 1], [min0, min1, 0]]) {
      await expect(router.addLiquidity(pool.target, desired0, desired1, args[0], args[1], args[2], depositor.address, await DEADLINE()))
        .to.be.revertedWithCustomError(router, "SlippageExceeded");
    }
  });

  it("refuses an expired deadline and a recipient of the router itself", async () => {
    const { depositor, tokenA, tokenB, pool, router, ordered } = await fixture();
    await tokenA.approve(router.target, one("100"));
    await tokenB.approve(router.target, one("200"));
    const [desired0, desired1] = await ordered(one("100"), one("200"));
    const [min0, min1] = await ordered(one("99"), one("199"));
    await expect(router.addLiquidity(pool.target, desired0, desired1, min0, min1, 1, depositor.address, 1))
      .to.be.revertedWithCustomError(router, "Expired");
    await expect(router.addLiquidity(pool.target, desired0, desired1, min0, min1, 1, router.target, await DEADLINE()))
      .to.be.revertedWithCustomError(router, "InvalidRecipient");
  });

  it("stops when the shares would come out under the floor", async () => {
    const { depositor, tokenA, tokenB, pool, router, ordered } = await fixture();
    await tokenA.approve(router.target, one("100"));
    await tokenB.approve(router.target, one("200"));
    const [desired0, desired1] = await ordered(one("100"), one("200"));
    const [min0, min1] = await ordered(one("99"), one("199"));
    const impossible = one("1000000");
    await expect(router.addLiquidity(pool.target, desired0, desired1, min0, min1, impossible, depositor.address, await DEADLINE()))
      .to.be.revertedWithCustomError(pool, "SlippageExceeded");
  });
});
