const { expect } = require("chai");
const { ethers } = require("hardhat");

// Both contracts argue their safety from what a transfer actually delivered,
// never from what it was asked to send: the pool compares its own balance before
// and after, and the router checks the same plus that it holds no leftover
// allowance. Every "exact approval, nothing left behind" claim rests on those
// comparisons — and until now nothing in this suite made one of them fail, so
// the branches were carried by reading alone.
//
// A token that keeps a cut of every transfer is the ordinary way this happens.
// It reports success, so a caller that trusts the return value learns nothing.
const FEE = 1;
const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;
const one = (value) => ethers.parseEther(value);

describe("a token that delivers less than it says", () => {
  async function fixture () {
    const [depositor] = await ethers.getSigners();
    const honest = await (await ethers.getContractFactory("MockERC20")).deploy("Demo Amber", "AMBR", 18);
    // One percent withheld on every transfer.
    const lossy = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy("Lossy", "LOSS", 18, 100);
    await honest.mint(depositor.address, one("100000"));
    await lossy.mint(depositor.address, one("100000"));

    const factory = await (await ethers.getContractFactory("LocalSwapFactory")).deploy();
    await factory.createPool(honest.target, lossy.target, FEE);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(honest.target, lossy.target, FEE));
    const router = await (await ethers.getContractFactory("LocalSwapRouter")).deploy();
    const ordered = async (forHonest, forLossy) => ((await pool.token0()) === honest.target ? [forHonest, forLossy] : [forLossy, forHonest]);
    return { depositor, honest, lossy, pool, router, ordered };
  }

  it("cannot be deposited into a pool, because the pool receives less than it was promised", async () => {
    const { depositor, honest, lossy, pool, ordered } = await fixture();
    await honest.approve(pool.target, one("10000"));
    await lossy.approve(pool.target, one("10000"));
    const [amount0, amount1] = await ordered(one("10000"), one("10000"));
    await expect(pool.addLiquidity(amount0, amount1, 1, depositor.address, await DEADLINE()))
      .to.be.revertedWithCustomError(pool, "UnsupportedTokenBehavior");
  });

  it("cannot be deposited through the router either", async () => {
    const { depositor, honest, lossy, pool, router, ordered } = await fixture();
    await honest.approve(router.target, one("10000"));
    await lossy.approve(router.target, one("10000"));
    const [amount0, amount1] = await ordered(one("10000"), one("10000"));
    await expect(router.addLiquidity(pool.target, amount0, amount1, 1, 1, 1, depositor.address, await DEADLINE()))
      .to.be.reverted;
  });

  it("leaves the depositor's balance and approvals untouched when it is refused", async () => {
    // A refusal that had already moved something would be worse than the loss it
    // is refusing, so the whole attempt has to come back.
    const { depositor, honest, lossy, pool, ordered } = await fixture();
    const before = { honest: await honest.balanceOf(depositor.address), lossy: await lossy.balanceOf(depositor.address) };
    await honest.approve(pool.target, one("10000"));
    await lossy.approve(pool.target, one("10000"));
    const [amount0, amount1] = await ordered(one("10000"), one("10000"));
    await expect(pool.addLiquidity(amount0, amount1, 1, depositor.address, await DEADLINE())).to.be.reverted;

    expect(await honest.balanceOf(depositor.address)).to.equal(before.honest);
    expect(await lossy.balanceOf(depositor.address)).to.equal(before.lossy);
    expect(await honest.balanceOf(pool.target)).to.equal(0n);
    expect(await lossy.balanceOf(pool.target)).to.equal(0n);
    // The approval the caller made is still theirs to revoke; the pool took none of it.
    expect(await honest.allowance(depositor.address, pool.target)).to.equal(one("10000"));
    expect(await lossy.allowance(depositor.address, pool.target)).to.equal(one("10000"));
  });

  it("is refused by the honest token's own pool as well, so the check is not about which side is lossy", async () => {
    // Same pair, deposit driven from the other side: the comparison is per token,
    // so the refusal must not depend on which of the two is the lossy one.
    const { depositor, honest, lossy, pool, ordered } = await fixture();
    await honest.approve(pool.target, one("500"));
    await lossy.approve(pool.target, one("500"));
    const [amount0, amount1] = await ordered(one("500"), one("500"));
    await expect(pool.addLiquidity(amount0, amount1, 1, depositor.address, await DEADLINE()))
      .to.be.revertedWithCustomError(pool, "UnsupportedTokenBehavior");
  });
});
