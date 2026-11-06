const { expect } = require("chai");
const { ethers } = require("hardhat");
const codeIdentities = require("../src/swap/local-amm-code-identities.json");
const factoryArtifact = require("../artifacts/contracts/LocalSwapFactory.sol/LocalSwapFactory.json");
const routerArtifact = require("../artifacts/contracts/LocalSwapRouter.sol/LocalSwapRouter.json");

// The tier the v0.1 deployment uses. Tests must describe the real target.
const V01_FEE_BASIS_POINTS = 1;

describe("LocalSwap", function () {
  it("keeps the frontend discovery hash bound to the compiled factory runtime", async function () {
    expect(codeIdentities.schema).to.equal("localswap.evm-code-identities.v1");
    expect(ethers.keccak256(factoryArtifact.deployedBytecode)).to.equal(codeIdentities.factoryRuntimeCodeHash);
    expect(ethers.keccak256(routerArtifact.deployedBytecode)).to.equal(codeIdentities.routerRuntimeCodeHash);
  });

  async function deployRouterFixture() {
    const [owner, trader] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Token A", "TKA", 18);
    const tokenB = await Token.deploy("Token B", "TKB", 18);
    const tokenC = await Token.deploy("Token C", "TKC", 18);
    const Factory = await ethers.getContractFactory("LocalSwapFactory");
    const factory = await Factory.deploy();
    await factory.createPool(tokenA.target, tokenB.target, V01_FEE_BASIS_POINTS);
    await factory.createPool(tokenB.target, tokenC.target, V01_FEE_BASIS_POINTS);
    const poolAB = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenB.target, V01_FEE_BASIS_POINTS));
    const poolBC = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenB.target, tokenC.target, V01_FEE_BASIS_POINTS));
    const Router = await ethers.getContractFactory("LocalSwapRouter");
    const router = await Router.deploy();
    for (const token of [tokenA, tokenB, tokenC]) await token.mint(owner.address, ethers.parseEther("100000"));
    await tokenA.mint(trader.address, ethers.parseEther("1000"));
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 300;
    await seedPool(owner, poolAB, tokenA, tokenB, ethers.parseEther("10000"), ethers.parseEther("20000"), deadline);
    await seedPool(owner, poolBC, tokenB, tokenC, ethers.parseEther("20000"), ethers.parseEther("30000"), deadline);
    return { owner, trader, tokenA, tokenB, tokenC, poolAB, poolBC, router, deadline };
  }

  async function seedPool(owner, pool, tokenA, tokenB, amountA, amountB, deadline) {
    await tokenA.connect(owner).approve(pool.target, amountA);
    await tokenB.connect(owner).approve(pool.target, amountB);
    const token0 = await pool.token0();
    await pool.connect(owner).addLiquidity(
      token0 === tokenA.target ? amountA : amountB,
      token0 === tokenA.target ? amountB : amountA,
      0,
      owner.address,
      deadline
    );
  }

  it("quotes and executes a two-hop swap atomically with exact router approval", async function () {
    const { trader, tokenA, tokenB, tokenC, poolAB, poolBC, router, deadline } = await deployRouterFixture();
    const amountIn = ethers.parseEther("100");
    const pools = [poolAB.target, poolBC.target];
    const [quote, tokenOut] = await router.quoteExactIn(pools, tokenA.target, amountIn);
    expect(tokenOut).to.equal(tokenC.target);
    await tokenA.connect(trader).approve(router.target, amountIn);
    const before = await tokenC.balanceOf(trader.address);
    await router.connect(trader).swapExactIn(pools, tokenA.target, amountIn, quote, trader.address, deadline);
    expect(await tokenC.balanceOf(trader.address) - before).to.equal(quote);
    expect(await tokenA.allowance(trader.address, router.target)).to.equal(0);
    expect(await tokenA.balanceOf(router.target)).to.equal(0);
    expect(await tokenB.balanceOf(router.target)).to.equal(0);
  });

  it("rolls back every hop when the final minimum output is not met", async function () {
    const { trader, tokenA, poolAB, poolBC, router, deadline } = await deployRouterFixture();
    const amountIn = ethers.parseEther("100");
    const pools = [poolAB.target, poolBC.target];
    const reservesAB = await poolAB.getReserves();
    const reservesBC = await poolBC.getReserves();
    const traderBefore = await tokenA.balanceOf(trader.address);
    await tokenA.connect(trader).approve(router.target, amountIn);
    await expect(router.connect(trader).swapExactIn(pools, tokenA.target, amountIn, ethers.parseEther("999999"), trader.address, deadline))
      .to.be.revertedWithCustomError(poolBC, "SlippageExceeded");
    expect(await tokenA.balanceOf(trader.address)).to.equal(traderBefore);
    expect((await poolAB.getReserves()).slice(0, 2)).to.deep.equal(reservesAB.slice(0, 2));
    expect((await poolBC.getReserves()).slice(0, 2)).to.deep.equal(reservesBC.slice(0, 2));
  });

  it("rejects discontinuous, cyclic, duplicate, expired, and overlong routes", async function () {
    const { trader, tokenA, poolAB, poolBC, router } = await deployRouterFixture();
    const amountIn = ethers.parseEther("1");
    await expect(router.quoteExactIn([poolBC.target], tokenA.target, amountIn)).to.be.revertedWithCustomError(router, "InvalidPath");
    await expect(router.quoteExactIn([poolAB.target, poolAB.target], tokenA.target, amountIn)).to.be.revertedWithCustomError(router, "InvalidPath");
    await expect(router.quoteExactIn([poolAB.target, poolBC.target, poolBC.target], tokenA.target, amountIn)).to.be.revertedWithCustomError(router, "InvalidPath");
    await tokenA.connect(trader).approve(router.target, amountIn);
    await expect(router.connect(trader).swapExactIn([poolAB.target, poolBC.target], tokenA.target, amountIn, 1, trader.address, 1))
      .to.be.revertedWithCustomError(router, "Expired");
    await expect(router.quoteExactIn([poolAB.target, poolBC.target, poolAB.target, poolBC.target, poolAB.target], tokenA.target, amountIn))
      .to.be.revertedWithCustomError(router, "InvalidPath");
  });

  async function deployFixture() {
    const [owner, trader, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Token A", "TKA", 18);
    const tokenB = await Token.deploy("Token B", "TKB", 18);
    const Factory = await ethers.getContractFactory("LocalSwapFactory");
    const factory = await Factory.deploy();
    await factory.createPool(tokenA.target, tokenB.target, V01_FEE_BASIS_POINTS);
    const poolAddress = await factory.getPool(tokenA.target, tokenB.target, V01_FEE_BASIS_POINTS);
    const pool = await ethers.getContractAt("LocalSwapPool", poolAddress);

    const supply = ethers.parseEther("100000");
    await tokenA.mint(owner.address, supply);
    await tokenB.mint(owner.address, supply);
    await tokenA.mint(trader.address, ethers.parseEther("1000"));
    await tokenB.mint(trader.address, ethers.parseEther("1000"));
    return { owner, trader, other, tokenA, tokenB, factory, pool };
  }

  async function approveAndSeed(fixture) {
    const { owner, tokenA, tokenB, pool } = fixture;
    const token0Address = await pool.token0();
    const token0 = tokenA.target === token0Address ? tokenA : tokenB;
    const token1 = tokenA.target === token0Address ? tokenB : tokenA;
    const amount0 = ethers.parseEther("10000");
    const amount1 = ethers.parseEther("20000");
    await token0.connect(owner).approve(pool.target, amount0);
    await token1.connect(owner).approve(pool.target, amount1);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 300;
    await pool.connect(owner).addLiquidity(amount0, amount1, 0, owner.address, deadline);
    return { token0, token1, amount0, amount1, deadline };
  }

  it("creates one immutable pool per sorted token pair", async function () {
    const { tokenA, tokenB, factory, pool } = await deployFixture();
    expect(await factory.getPool(tokenA.target, tokenB.target, V01_FEE_BASIS_POINTS)).to.equal(pool.target);
    expect(await factory.getPool(tokenB.target, tokenA.target, V01_FEE_BASIS_POINTS)).to.equal(pool.target);
    expect(await pool.factory()).to.equal(factory.target);
    await expect(factory.createPool(tokenB.target, tokenA.target, V01_FEE_BASIS_POINTS)).to.be.revertedWithCustomError(factory, "PoolExists");
  });

  it("adds liquidity, locks minimum shares, and removes pro-rata", async function () {
    const fixture = await deployFixture();
    const { owner, pool } = fixture;
    const { token0, token1, amount0, amount1, deadline } = await approveAndSeed(fixture);
    expect(await pool.totalSupply()).to.equal(ethers.parseEther("14142.135623730950488016"));
    expect(await pool.balanceOf(owner.address)).to.equal((await pool.totalSupply()) - 1000n);

    const shares = (await pool.balanceOf(owner.address)) / 2n;
    const before0 = await token0.balanceOf(owner.address);
    const before1 = await token1.balanceOf(owner.address);
    await pool.connect(owner).removeLiquidity(shares, 1, 1, owner.address, deadline);
    expect(await token0.balanceOf(owner.address)).to.be.greaterThan(before0);
    expect(await token1.balanceOf(owner.address)).to.be.greaterThan(before1);
    const [reserve0, reserve1] = await pool.getReserves();
    expect(reserve0).to.equal(await token0.balanceOf(pool.target));
    expect(reserve1).to.equal(await token1.balanceOf(pool.target));
    expect(reserve0 * reserve1).to.be.greaterThan(0n);
    expect(amount0).to.equal(ethers.parseEther("10000"));
    expect(amount1).to.equal(ethers.parseEther("20000"));
  });

  it("swaps exact input with zero protocol fee and enforces exact approval", async function () {
    const fixture = await deployFixture();
    const { trader, pool } = fixture;
    const { token0, token1, deadline } = await approveAndSeed(fixture);
    const amountIn = ethers.parseEther("100");
    const quote = await pool.quoteExactIn(token0.target, amountIn);
    await token0.connect(trader).approve(pool.target, amountIn);
    await expect(pool.connect(trader).swapExactIn(token0.target, amountIn, quote, trader.address, deadline))
      .to.emit(pool, "Swap")
      .withArgs(trader.address, token0.target, amountIn, quote, trader.address);
    expect(await token0.allowance(trader.address, pool.target)).to.equal(0);
    expect(await token1.balanceOf(trader.address)).to.equal(ethers.parseEther("1000") + quote);
  });

  it("fails closed on expired or changed quotes", async function () {
    const fixture = await deployFixture();
    const { trader, other, pool } = fixture;
    const { token0, deadline } = await approveAndSeed(fixture);
    const amount = ethers.parseEther("10");
    await token0.connect(trader).approve(pool.target, amount);
    await expect(pool.connect(trader).swapExactIn(token0.target, amount, ethers.parseEther("999"), trader.address, deadline))
      .to.be.revertedWithCustomError(pool, "SlippageExceeded");
    await expect(pool.connect(trader).swapExactIn(token0.target, amount, 0, trader.address, 1))
      .to.be.revertedWithCustomError(pool, "Expired");
    await expect(pool.connect(trader).swapExactIn(token0.target, amount, 0, ethers.ZeroAddress, deadline))
      .to.be.revertedWithCustomError(pool, "InvalidRecipient");
    await expect(pool.connect(other).removeLiquidity(1, 0, 0, other.address, deadline)).to.be.reverted;
  });
});
