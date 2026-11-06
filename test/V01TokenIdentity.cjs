const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { openPinnedRootEvm } = require("../integration/anvil/root-contract-fixture.cjs");
const codeIdentities = require("../src/swap/local-amm-code-identities.json");

// The tier the v0.1 deployment uses. Tests must describe the real target.
const V01_FEE_BASIS_POINTS = 1;

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

function allowanceStorageSlot(owner, spender) {
  const ownerMappingSlot = ethers.keccak256(abiCoder.encode(["address", "uint256"], [owner, 4n]));
  return ethers.keccak256(abiCoder.encode(["address", "bytes32"], [spender, ownerMappingSlot]));
}

async function readStorageWord(address, slot) {
  return ethers.provider.send("eth_getStorageAt", [address, slot, "latest"]);
}

function isUnsupportedStateOverride(error) {
  const message = String(error && error.message ? error.message : error);
  return /trailing characters|too many arguments|method .* not found|not implemented|state override.*(?:unsupported|not supported)|(?:unsupported|not supported).*state override/i.test(message);
}

describe("RealDEX v0.1 token identity", function () {
  it("pins the shared MockERC20 runtime for the two exact demo tokens", async function () {
    const Token = await ethers.getContractFactory("MockERC20");
    const amber = await Token.deploy("Demo Amber", "AMBR", 18);
    const jade = await Token.deploy("Demo Jade", "JADE", 18);
    const sixDecimals = await Token.deploy("Six Decimal Fixture", "SIX", 6);

    const amberRuntimeHash = ethers.keccak256(await ethers.provider.getCode(amber.target));
    const jadeRuntimeHash = ethers.keccak256(await ethers.provider.getCode(jade.target));
    const sixDecimalsRuntimeHash = ethers.keccak256(await ethers.provider.getCode(sixDecimals.target));

    expect(await amber.name()).to.equal("Demo Amber");
    expect(await amber.symbol()).to.equal("AMBR");
    expect(await amber.decimals()).to.equal(18);
    expect(await jade.name()).to.equal("Demo Jade");
    expect(await jade.symbol()).to.equal("JADE");
    expect(await jade.decimals()).to.equal(18);

    expect(amberRuntimeHash).to.equal(jadeRuntimeHash);
    expect(amberRuntimeHash).to.equal(codeIdentities.mockErc20Decimals18RuntimeCodeHash);
    expect(sixDecimalsRuntimeHash).to.not.equal(codeIdentities.mockErc20Decimals18RuntimeCodeHash);
  });

  it("proves the exact MockERC20 allowance storage slot for both token directions", async function () {
    const [owner, wrongOwner, spender, wrongSpender] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const Factory = await ethers.getContractFactory("LocalSwapFactory");
    const amber = await Token.deploy("Demo Amber", "AMBR", 18);
    const jade = await Token.deploy("Demo Jade", "JADE", 18);
    const factory = await Factory.deploy();

    await factory.createPool(amber.target, jade.target, V01_FEE_BASIS_POINTS);
    const poolAddress = await factory.getPool(amber.target, jade.target, V01_FEE_BASIS_POINTS);
    const amberApproval = ethers.parseUnits("123.456789", 18);
    const jadeApproval = ethers.parseUnits("987.654321", 18);

    await amber.connect(owner).approve(poolAddress, amberApproval);
    await jade.connect(owner).approve(poolAddress, jadeApproval);

    expect(await amber.allowance(owner.address, poolAddress)).to.equal(amberApproval);
    expect(await jade.allowance(owner.address, poolAddress)).to.equal(jadeApproval);
    expect(BigInt(await readStorageWord(amber.target, allowanceStorageSlot(owner.address, poolAddress)))).to.equal(amberApproval);
    expect(BigInt(await readStorageWord(jade.target, allowanceStorageSlot(owner.address, poolAddress)))).to.equal(jadeApproval);

    expect(BigInt(await readStorageWord(amber.target, allowanceStorageSlot(owner.address, wrongSpender.address)))).to.equal(0n);
    expect(BigInt(await readStorageWord(jade.target, allowanceStorageSlot(owner.address, wrongSpender.address)))).to.equal(0n);
    expect(BigInt(await readStorageWord(amber.target, allowanceStorageSlot(wrongOwner.address, poolAddress)))).to.equal(0n);
    expect(BigInt(await readStorageWord(jade.target, allowanceStorageSlot(wrongOwner.address, poolAddress)))).to.equal(0n);
    expect(await amber.allowance(owner.address, wrongSpender.address)).to.equal(0n);
    expect(await jade.allowance(owner.address, wrongSpender.address)).to.equal(0n);
    expect(await amber.allowance(wrongOwner.address, poolAddress)).to.equal(0n);
    expect(await jade.allowance(wrongOwner.address, poolAddress)).to.equal(0n);

    await amber.connect(owner).approve(spender.address, 1n);
    expect(BigInt(await readStorageWord(amber.target, allowanceStorageSlot(owner.address, spender.address)))).to.equal(1n);
    expect(BigInt(await readStorageWord(amber.target, allowanceStorageSlot(owner.address, wrongSpender.address)))).to.equal(0n);
  });

  it("uses only a third-parameter allowance override for read-only swap gas estimation", async function () {
    const pinnedAnvil = Boolean(process.env.REALDEX_ANVIL_BINARY);
    const fixture = pinnedAnvil ? await openPinnedRootEvm(hre) : {
      provider: ethers.provider, owner: (await ethers.getSigners())[0],
      async deploy(name, ...args) {
        const contract = await (await ethers.getContractFactory(name)).deploy(...args);
        await contract.waitForDeployment();
        return contract;
      },
      contractAt: (name, address) => ethers.getContractAt(name, address),
      async close() {},
    };
    try {
    const { owner, provider } = fixture;
    const amber = await fixture.deploy("MockERC20", "Demo Amber", "AMBR", 18);
    const jade = await fixture.deploy("MockERC20", "Demo Jade", "JADE", 18);
    const factory = await fixture.deploy("LocalSwapFactory");
    await (await factory.createPool(amber.target, jade.target, V01_FEE_BASIS_POINTS)).wait();
    const poolAddress = await factory.getPool(amber.target, jade.target, V01_FEE_BASIS_POINTS);
    const pool = await fixture.contractAt("LocalSwapPool", poolAddress);

    const liquidity = ethers.parseUnits("1000", 18);
    const amountIn = ethers.parseUnits("10", 18);
    await (await amber.mint(owner.address, liquidity + amountIn)).wait();
    await (await jade.mint(owner.address, liquidity)).wait();
    await (await amber.approve(poolAddress, liquidity)).wait();
    await (await jade.approve(poolAddress, liquidity)).wait();
    await (await pool.addLiquidity(liquidity, liquidity, 1n, owner.address, (await provider.getBlock("latest")).timestamp + 3600)).wait();
    await (await amber.approve(poolAddress, 0n)).wait();
    await (await jade.approve(poolAddress, 0n)).wait();

    expect(await amber.allowance(owner.address, poolAddress)).to.equal(0n);
    const amountOut = await pool.quoteExactIn(amber.target, amountIn);
    const latest = await provider.getBlock("latest");
    const transaction = await pool.swapExactIn.populateTransaction(
      amber.target,
      amountIn,
      amountOut,
      owner.address,
      latest.timestamp + 3600
    );
    transaction.from = owner.address;
    transaction.to = poolAddress;

    const allowanceSlot = allowanceStorageSlot(owner.address, poolAddress);
    const allowanceWord = ethers.zeroPadValue(ethers.toBeHex(amountIn), 32);
    const stateOverride = {
      [amber.target]: { stateDiff: { [allowanceSlot]: allowanceWord } }
    };
    const state = async () => ({
      allowance: await amber.allowance(owner.address, poolAddress),
      storage: await provider.send("eth_getStorageAt", [amber.target, allowanceSlot, "latest"]),
      ownerAmber: await amber.balanceOf(owner.address), ownerJade: await jade.balanceOf(owner.address),
      reserves: Array.from(await pool.getReserves()),
      nonce: await provider.send("eth_getTransactionCount", [owner.address, "latest"]),
      block: await provider.send("eth_blockNumber", []),
    });
    const before = await state();
    await expect(provider.send("eth_estimateGas", [transaction, "latest"])).to.be.rejected;

    try {
      const estimatedGas = await provider.send("eth_estimateGas", [transaction, "latest", stateOverride]);
      expect(BigInt(estimatedGas)).to.be.greaterThan(0n);
      console.log(pinnedAnvil ? "[state override] pinned local Anvil executed the third parameter" : "[state override] Hardhat executed the third parameter");
    } catch (error) {
      if (pinnedAnvil || !isUnsupportedStateOverride(error)) throw error;
      console.log("[state override] eth_estimateGas third parameter unsupported by this Hardhat provider");
      this.skip(); // Unsupported is pending evidence, not a passing simulation test.
    }

    expect(await amber.allowance(owner.address, poolAddress)).to.equal(0n);
    expect(BigInt(await provider.send("eth_getStorageAt", [amber.target, allowanceSlot, "latest"]))).to.equal(0n);
    expect(await state()).to.deep.equal(before);
    } finally { await fixture.close(); }
  });
});
