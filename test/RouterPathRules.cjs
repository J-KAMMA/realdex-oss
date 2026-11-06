const { expect } = require("chai");
const { ethers } = require("hardhat");

// The router validates a route twice, in two functions that do not share the
// loop: once in the read-only `quoteExactIn`, and again in `swapExactIn`, where
// the money moves. Every existing rejection test pushes on the quote. That is
// the half that cannot lose anything, and a rule that drifted out of the other
// half would still look covered.
//
// One branch had never run at all: a route that comes back to a token it has
// already held through two *different* pools over the same pair, which fee tiers
// now make possible. Measured while writing this: it is the only route the token
// rule alone refuses. Every route with a repeated pool is caught by that same
// token rule, because re-entering a two-token pool always hands back a token the
// route already held — so the pool rule never stands alone, and the older tests
// that named these routes "duplicate" were exercising the token rule.
const FEE = 1;
const OTHER_FEE = 30;
const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;
const one = (value) => ethers.parseEther(value);

describe("the router's route rules, on the swap and not only on the quote", () => {
  async function fixture () {
    const [depositor, trader] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
    const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
    const tokenC = await Token.deploy("Demo Onyx", "ONYX", 18);
    for (const account of [depositor, trader]) {
      for (const token of [tokenA, tokenB, tokenC]) await token.mint(account.address, one("100000"));
    }
    const factory = await (await ethers.getContractFactory("LocalSwapFactory")).deploy();
    const router = await (await ethers.getContractFactory("LocalSwapRouter")).deploy();

    const seed = async (first, second, fee) => {
      await factory.createPool(first.target, second.target, fee);
      const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(first.target, second.target, fee));
      await first.connect(depositor).approve(pool.target, one("10000"));
      await second.connect(depositor).approve(pool.target, one("10000"));
      await pool.connect(depositor).addLiquidity(one("10000"), one("10000"), 1, depositor.address, await DEADLINE());
      return pool;
    };
    // Same pair, two tiers: two addresses that both accept A and B.
    const poolAB = await seed(tokenA, tokenB, FEE);
    const poolBA = await seed(tokenA, tokenB, OTHER_FEE);
    const poolBC = await seed(tokenB, tokenC, FEE);
    return { trader, tokenA, tokenB, tokenC, poolAB, poolBA, poolBC, router };
  }

  // Each entry is a route the router must refuse, named by why.
  async function badRoutes (f) {
    const { tokenA, poolAB, poolBA, poolBC } = f;
    return [
      ["an empty route", []],
      ["a route longer than the hop ceiling", [poolAB.target, poolBC.target, poolAB.target, poolBC.target, poolAB.target]],
      ["the same pool twice in a row", [poolAB.target, poolAB.target]],
      ["the same pool again later in the route", [poolAB.target, poolBC.target, poolBC.target]],
      ["a first pool that does not hold the input token", [poolBC.target]],
      ["a pool address of zero", [ethers.ZeroAddress]],
      // Two distinct pools, both over A/B: the second hop hands back a token the
      // route already held. Nothing before this point objects.
      ["a route that returns to a token it already held", [poolAB.target, poolBA.target]]
    ].map(([why, pools]) => ({ why, pools, tokenIn: tokenA.target }));
  }

  it("refuses the same routes on the quote", async () => {
    const f = await fixture();
    for (const { why, pools, tokenIn } of await badRoutes(f)) {
      await expect(f.router.quoteExactIn(pools, tokenIn, one("1")), why)
        .to.be.revertedWithCustomError(f.router, "InvalidPath");
    }
  });

  it("refuses the same routes on the swap, where the money moves", async () => {
    const f = await fixture();
    const { trader, tokenA, router } = f;
    const amountIn = one("1");
    const before = await tokenA.balanceOf(trader.address);
    await tokenA.connect(trader).approve(router.target, amountIn * 20n);

    for (const { why, pools, tokenIn } of await badRoutes(f)) {
      await expect(
        router.connect(trader).swapExactIn(pools, tokenIn, amountIn, 1, trader.address, await DEADLINE()),
        why
      ).to.be.revertedWithCustomError(router, "InvalidPath");
    }
    // Nothing was taken and nothing was stranded in the router.
    expect(await tokenA.balanceOf(trader.address)).to.equal(before);
    expect(await tokenA.balanceOf(router.target)).to.equal(0n);
    expect(await tokenA.allowance(trader.address, router.target)).to.equal(amountIn * 20n);
  });

  it("refuses a zero input token or a zero amount on both entry points", async () => {
    const { trader, tokenA, poolAB, router } = await fixture();
    const pools = [poolAB.target];
    await expect(router.quoteExactIn(pools, ethers.ZeroAddress, one("1")))
      .to.be.revertedWithCustomError(router, "InvalidAmount");
    await expect(router.quoteExactIn(pools, tokenA.target, 0))
      .to.be.revertedWithCustomError(router, "InvalidAmount");

    await tokenA.connect(trader).approve(router.target, one("1"));
    await expect(router.connect(trader).swapExactIn(pools, ethers.ZeroAddress, one("1"), 1, trader.address, await DEADLINE()))
      .to.be.revertedWithCustomError(router, "InvalidAmount");
    await expect(router.connect(trader).swapExactIn(pools, tokenA.target, 0, 1, trader.address, await DEADLINE()))
      .to.be.revertedWithCustomError(router, "InvalidAmount");
    // A swap with no floor at all is the shape the pool refuses too.
    await expect(router.connect(trader).swapExactIn(pools, tokenA.target, one("1"), 0, trader.address, await DEADLINE()))
      .to.be.revertedWithCustomError(router, "InvalidAmount");
  });

  it("still routes the two-hop path that all of this is protecting", async () => {
    const { trader, tokenA, tokenC, poolAB, poolBC, router } = await fixture();
    const pools = [poolAB.target, poolBC.target];
    const amountIn = one("100");
    const [quote, tokenOut] = await router.quoteExactIn(pools, tokenA.target, amountIn);
    expect(tokenOut).to.equal(tokenC.target);

    await tokenA.connect(trader).approve(router.target, amountIn);
    const before = await tokenC.balanceOf(trader.address);
    await router.connect(trader).swapExactIn(pools, tokenA.target, amountIn, quote, trader.address, await DEADLINE());
    expect(await tokenC.balanceOf(trader.address) - before).to.equal(quote);
    expect(await tokenA.balanceOf(router.target)).to.equal(0n);
  });
});
