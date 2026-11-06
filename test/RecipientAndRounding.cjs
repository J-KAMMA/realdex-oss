const { expect } = require("chai");
const { ethers } = require("hardhat");

// Two kinds of door that no test had ever pushed on. The first refuses to send
// tokens or shares somewhere nobody can reach — a deposit, a withdrawal, a swap
// or a share transfer aimed at address(0), or at the pool or router itself. The
// second refuses a book entry that rounds to nothing: a withdrawal so small it
// would burn shares and pay out zero, and a first deposit too small to leave the
// locked minimum behind. Both are the difference between a loss the caller can
// see and one that happens quietly.
const FEE = 1;
const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;
const one = (value) => ethers.parseEther(value);

describe("the doors that refuse an unreachable recipient or an entry that rounds to nothing", () => {
  async function fixture () {
    const [first, second] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
    const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
    const tokenC = await Token.deploy("Demo Onyx", "ONYX", 18);
    for (const account of [first, second]) {
      for (const token of [tokenA, tokenB, tokenC]) await token.mint(account.address, one("100000"));
    }
    const factory = await (await ethers.getContractFactory("LocalSwapFactory")).deploy();
    const router = await (await ethers.getContractFactory("LocalSwapRouter")).deploy();
    await factory.createPool(tokenA.target, tokenB.target, FEE);
    await factory.createPool(tokenA.target, tokenC.target, FEE);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenB.target, FEE));
    // Left unseeded on purpose: the first-deposit and empty-quote branches only
    // exist while the supply is still zero.
    const empty = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenC.target, FEE));
    const ordered = async (a, b) => ((await pool.token0()) === tokenA.target ? [a, b] : [b, a]);

    await tokenA.connect(first).approve(pool.target, one("10000"));
    await tokenB.connect(first).approve(pool.target, one("20000"));
    const [amount0, amount1] = await ordered(one("10000"), one("20000"));
    await pool.connect(first).addLiquidity(amount0, amount1, 1, first.address, await DEADLINE());
    return { first, second, tokenA, tokenB, tokenC, pool, empty, router, ordered };
  }

  it("refuses a deposit credited to an address nobody holds", async () => {
    const { first, tokenA, tokenB, pool, ordered } = await fixture();
    await tokenA.connect(first).approve(pool.target, one("100"));
    await tokenB.connect(first).approve(pool.target, one("200"));
    const [amount0, amount1] = await ordered(one("100"), one("200"));
    await expect(pool.connect(first).addLiquidity(amount0, amount1, 1, ethers.ZeroAddress, await DEADLINE()))
      .to.be.revertedWithCustomError(pool, "InvalidRecipient");
    // Refused before anything moved: the allowance is still standing.
    expect(await tokenA.allowance(first.address, pool.target)).to.equal(one("100"));
  });

  it("refuses a withdrawal paid to an address nobody holds", async () => {
    const { first, pool } = await fixture();
    const held = await pool.balanceOf(first.address);
    await expect(pool.connect(first).removeLiquidity(held, 1, 1, ethers.ZeroAddress, await DEADLINE()))
      .to.be.revertedWithCustomError(pool, "InvalidRecipient");
    expect(await pool.balanceOf(first.address)).to.equal(held);
  });

  it("refuses a swap or a share transfer that would pay the pool itself, or nobody", async () => {
    const { first, second, tokenA, pool } = await fixture();
    const amountIn = one("100");
    await tokenA.connect(second).approve(pool.target, amountIn);
    // The zero case is already covered elsewhere; the pool's own address is not.
    await expect(pool.connect(second).swapExactIn(tokenA.target, amountIn, 1, pool.target, await DEADLINE()))
      .to.be.revertedWithCustomError(pool, "InvalidRecipient");
    // Shares are an ERC-20 of their own, and the same door stands on transfers:
    // burning by sending to address(0) would move the supply without the pool
    // ever paying the reserves out.
    await expect(pool.connect(first).transfer(ethers.ZeroAddress, 1))
      .to.be.revertedWithCustomError(pool, "InvalidRecipient");
    expect(await pool.totalSupply()).to.be.greaterThan(0n);
  });

  it("refuses the same two recipients through the router", async () => {
    const { second, tokenA, pool, router } = await fixture();
    const amountIn = one("100");
    await tokenA.connect(second).approve(router.target, amountIn);
    for (const recipient of [ethers.ZeroAddress, router.target]) {
      await expect(router.connect(second).swapExactIn([pool.target], tokenA.target, amountIn, 1, recipient, await DEADLINE()))
        .to.be.revertedWithCustomError(router, "InvalidRecipient");
    }
    expect(await tokenA.balanceOf(router.target)).to.equal(0n);
  });

  it("refuses a withdrawal small enough to round to nothing, and pays the next one up", async () => {
    const { first, pool } = await fixture();
    const supply = await pool.totalSupply();
    const [reserve0, reserve1] = await pool.getReserves();
    const smallestReserve = reserve0 < reserve1 ? reserve0 : reserve1;
    // Below this the payout truncates to zero on the thinner side, and the
    // shares would be burnt for nothing.
    const floor = (supply + smallestReserve - 1n) / smallestReserve;
    expect(floor).to.be.greaterThan(1n);

    await expect(pool.connect(first).removeLiquidity(floor - 1n, 0, 0, first.address, await DEADLINE()))
      .to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    const held = await pool.balanceOf(first.address);
    await pool.connect(first).removeLiquidity(floor, 0, 0, first.address, await DEADLINE());
    expect(await pool.balanceOf(first.address)).to.equal(held - floor);
  });

  it("refuses a first deposit too small to leave the locked minimum behind, and quotes nothing against an empty pool", async () => {
    const { first, tokenA, tokenC, empty } = await fixture();
    const minimum = await empty.MINIMUM_LIQUIDITY();
    await tokenA.connect(first).approve(empty.target, minimum * 4n);
    await tokenC.connect(first).approve(empty.target, minimum * 4n);

    // sqrt(1000 * 1000) is exactly the minimum, and the first depositor would be
    // left with zero shares over a pool that now holds their tokens.
    await expect(empty.connect(first).addLiquidity(minimum, minimum, 0, first.address, await DEADLINE()))
      .to.be.revertedWithCustomError(empty, "InsufficientLiquidity");
    // A quote has no reserves to work against either, and says so rather than
    // dividing by zero or returning a confident zero.
    await expect(empty.quoteExactIn(tokenA.target, one("1")))
      .to.be.revertedWithCustomError(empty, "InsufficientLiquidity");

    // One wei more on each side clears it, with a single share to show for it.
    await empty.connect(first).addLiquidity(minimum + 1n, minimum + 1n, 1, first.address, await DEADLINE());
    expect(await empty.balanceOf(first.address)).to.equal(1n);
    expect(await empty.totalSupply()).to.equal(minimum + 1n);
  });
});
