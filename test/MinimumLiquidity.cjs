const { expect } = require("chai");
const { ethers } = require("hardhat");

// The first deposit mints a fixed amount of shares to an address nobody holds.
// The existing suite checks the depositor received the supply less that amount;
// what it does not check is the point of doing it — that those shares can never
// be burnt, so the pool can never return to a supply of zero while still holding
// reserves. A pool that could would let the next "first" depositor set the share
// price against a book someone else paid for.
const FEE = 1;
const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;
const one = (value) => ethers.parseEther(value);
const BURN = "0x0000000000000000000000000000000000000001";

describe("the minimum liquidity the first deposit gives up", () => {
  async function fixture () {
    const [first, second] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
    const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
    for (const account of [first, second]) {
      await tokenA.mint(account.address, one("100000"));
      await tokenB.mint(account.address, one("100000"));
    }
    const factory = await (await ethers.getContractFactory("LocalSwapFactory")).deploy();
    await factory.createPool(tokenA.target, tokenB.target, FEE);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenB.target, FEE));
    const ordered = async (a, b) => ((await pool.token0()) === tokenA.target ? [a, b] : [b, a]);

    await tokenA.connect(first).approve(pool.target, one("10000"));
    await tokenB.connect(first).approve(pool.target, one("20000"));
    const [amount0, amount1] = await ordered(one("10000"), one("20000"));
    await pool.connect(first).addLiquidity(amount0, amount1, 1, first.address, await DEADLINE());
    return { first, second, tokenA, tokenB, pool, ordered };
  }

  it("mints it to an address with no key behind it", async () => {
    const { pool } = await fixture();
    const minimum = await pool.MINIMUM_LIQUIDITY();
    expect(await pool.balanceOf(BURN)).to.equal(minimum);
    // Nowhere else: the pool did not keep them, and the factory has no claim.
    expect(await pool.balanceOf(pool.target)).to.equal(0n);
    expect(await pool.balanceOf(ethers.ZeroAddress)).to.equal(0n);
  });

  it("survives the first provider withdrawing everything they hold", async () => {
    const { first, tokenA, tokenB, pool } = await fixture();
    const minimum = await pool.MINIMUM_LIQUIDITY();
    await pool.connect(first).removeLiquidity(await pool.balanceOf(first.address), 1, 1, first.address, await DEADLINE());

    expect(await pool.balanceOf(first.address)).to.equal(0n);
    expect(await pool.totalSupply()).to.equal(minimum);
    // Reserves are tiny but not zero, and still match what the pool holds.
    const [reserve0, reserve1] = await pool.getReserves();
    expect(reserve0).to.be.greaterThan(0n);
    expect(reserve1).to.be.greaterThan(0n);
    expect(reserve0).to.equal(await (((await pool.token0()) === tokenA.target) ? tokenA : tokenB).balanceOf(pool.target));
    expect(reserve1).to.equal(await (((await pool.token0()) === tokenA.target) ? tokenB : tokenA).balanceOf(pool.target));
  });

  it("cannot be burnt by anyone else, because a burn only spends the caller's own shares", async () => {
    const { first, second, pool } = await fixture();
    const minimum = await pool.MINIMUM_LIQUIDITY();
    await pool.connect(first).removeLiquidity(await pool.balanceOf(first.address), 1, 1, first.address, await DEADLINE());

    // Neither the emptied first provider nor a stranger can reach them.
    await expect(pool.connect(first).removeLiquidity(minimum, 1, 1, first.address, await DEADLINE())).to.be.reverted;
    await expect(pool.connect(second).removeLiquidity(minimum, 1, 1, second.address, await DEADLINE())).to.be.reverted;
    expect(await pool.balanceOf(BURN)).to.equal(minimum);
    expect(await pool.totalSupply()).to.equal(minimum);
  });

  it("keeps the next provider priced against what is left, not against an empty pool", async () => {
    // Without the locked minimum the supply would be zero here, and the next
    // deposit would take the first-deposit branch — setting the share price
    // itself, over reserves someone else paid for.
    const { first, second, tokenA, tokenB, pool, ordered } = await fixture();
    await pool.connect(first).removeLiquidity(await pool.balanceOf(first.address), 1, 1, first.address, await DEADLINE());
    const supplyBefore = await pool.totalSupply();
    const [reserve0Before, reserve1Before] = await pool.getReserves();

    await tokenA.connect(second).approve(pool.target, one("100"));
    await tokenB.connect(second).approve(pool.target, one("200"));
    const [amount0, amount1] = await ordered(one("100"), one("200"));
    await pool.connect(second).addLiquidity(amount0, amount1, 1, second.address, await DEADLINE());

    // Pro-rata against the surviving book, which is the ordinary branch.
    const [taken0, taken1] = [
      (await pool.getReserves())[0] - reserve0Before,
      (await pool.getReserves())[1] - reserve1Before
    ];
    const expected0 = (taken0 * supplyBefore) / reserve0Before;
    const expected1 = (taken1 * supplyBefore) / reserve1Before;
    expect(await pool.balanceOf(second.address)).to.equal(expected0 < expected1 ? expected0 : expected1);
    expect(await pool.balanceOf(BURN)).to.equal(supplyBefore);
  });
});
