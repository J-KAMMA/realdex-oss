const { expect } = require("chai");
const { ethers } = require("hardhat");

// The contract surface the frontend needs, checked before a deployment rather
// than after one.
//
// Three deployments have already been replaced because something was missing:
// H-1 needed `skim`, the fee needed a constructor argument, and the deposit
// residue needed a router-side `addLiquidity`. Each replacement invalidated every
// row of public evidence. These tests are the list of things a release must be
// able to do, so the gap is found here instead of at the next redeploy.
const FEE = 1;
const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;
const one = (value) => ethers.parseEther(value);

describe("the surface a release has to expose", () => {
  async function deployed () {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
    const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
    await tokenA.mint(owner.address, one("100000"));
    await tokenB.mint(owner.address, one("100000"));
    const factory = await (await ethers.getContractFactory("LocalSwapFactory")).deploy();
    const router = await (await ethers.getContractFactory("LocalSwapRouter")).deploy();
    return { owner, tokenA, tokenB, factory, router };
  }

  it("lets a caller enumerate every pool without knowing the count in advance", async () => {
    const { tokenA, tokenB, factory } = await deployed();
    expect(await factory.allPoolsLength()).to.equal(0n);
    await factory.createPool(tokenA.target, tokenB.target, 1);
    await factory.createPool(tokenA.target, tokenB.target, 30);
    expect(await factory.allPoolsLength()).to.equal(2n);

    // Walking the registry is what fee-tier discovery needs: a caller that was
    // told no tiers can still find both.
    const found = [];
    for (let index = 0n; index < (await factory.allPoolsLength()); index++) {
      const pool = await ethers.getContractAt("LocalSwapPool", await factory.allPools(index));
      found.push({ address: pool.target, fee: Number(await pool.feeBasisPoints()) });
    }
    expect(found.map(item => item.fee).sort((a, b) => a - b)).to.deep.equal([1, 30]);
    expect(new Set(found.map(item => item.address)).size).to.equal(2);
  });

  it("answers what a deposit will actually take, from the code that will take it", async () => {
    const { owner, tokenA, tokenB, factory, router } = await deployed();
    await factory.createPool(tokenA.target, tokenB.target, FEE);
    const pool = await ethers.getContractAt("LocalSwapPool", await factory.getPool(tokenA.target, tokenB.target, FEE));
    const ordered = async (a, b) => ((await pool.token0()) === tokenA.target ? [a, b] : [b, a]);

    await tokenA.approve(pool.target, one("10000"));
    await tokenB.approve(pool.target, one("20000"));
    const [seed0, seed1] = await ordered(one("10000"), one("20000"));
    await pool.addLiquidity(seed0, seed1, 1, owner.address, await DEADLINE());

    // 1 : 2, so 100 / 500 settles to 100 / 200.
    const [desired0, desired1] = await ordered(one("100"), one("500"));
    const quoted = await router.quoteAddLiquidity(pool.target, desired0, desired1);
    const [expected0, expected1] = await ordered(one("100"), one("200"));
    expect(quoted[0]).to.equal(expected0);
    expect(quoted[1]).to.equal(expected1);

    // And the deposit takes exactly what the quote said.
    await tokenA.approve(router.target, one("100"));
    await tokenB.approve(router.target, one("500"));
    const beforeA = await tokenA.balanceOf(owner.address);
    const beforeB = await tokenB.balanceOf(owner.address);
    const [min0, min1] = await ordered(one("99"), one("199"));
    await router.addLiquidity(pool.target, desired0, desired1, min0, min1, 1, owner.address, await DEADLINE());
    const takenA = beforeA - (await tokenA.balanceOf(owner.address));
    const takenB = beforeB - (await tokenB.balanceOf(owner.address));
    const [taken0, taken1] = await ordered(takenA, takenB);
    expect(taken0).to.equal(quoted[0]);
    expect(taken1).to.equal(quoted[1]);
  });

  it("refuses to quote a deposit it would refuse to perform", async () => {
    const { router } = await deployed();
    await expect(router.quoteAddLiquidity(ethers.ZeroAddress, one("1"), one("1")))
      .to.be.revertedWithCustomError(router, "InvalidPath");
  });

  it("still has no owner, pause, seizure or upgrade path", async () => {
    const { factory, router } = await deployed();
    // The claim the participant guide makes rests on this. If a privileged entry
    // point ever appears, that guide becomes false.
    for (const contract of [factory, router]) {
      const names = contract.interface.fragments.filter(f => f.type === "function").map(f => f.name);
      for (const forbidden of ["owner", "transferOwnership", "pause", "unpause", "upgradeTo", "setFee", "setOwner", "withdraw", "rescue"]) {
        expect(names).to.not.include(forbidden);
      }
    }
  });
});
