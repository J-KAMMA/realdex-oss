import hre from "hardhat";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
  const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
  const Factory = await hre.ethers.getContractFactory("LocalSwapFactory");
  const factory = await Factory.deploy();
  await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment(), factory.waitForDeployment()]);

  // The fee is a constructor argument now, and part of the pool address.
  const FEE_BASIS_POINTS = 1;
  await factory.createPool(await tokenA.getAddress(), await tokenB.getAddress(), FEE_BASIS_POINTS);
  const poolAddress = await factory.getPool(await tokenA.getAddress(), await tokenB.getAddress(), FEE_BASIS_POINTS);
  const pool = await hre.ethers.getContractAt("LocalSwapPool", poolAddress);
  const amountA = hre.ethers.parseEther("10000");
  const amountB = hre.ethers.parseEther("20000");
  await tokenA.mint(deployer.address, hre.ethers.parseEther("100000"));
  await tokenB.mint(deployer.address, hre.ethers.parseEther("100000"));
  await tokenA.approve(poolAddress, amountA);
  await tokenB.approve(poolAddress, amountB);
  const token0 = await pool.token0();
  const [amount0, amount1] = token0 === (await tokenA.getAddress()) ? [amountA, amountB] : [amountB, amountA];
  await pool.addLiquidity(amount0, amount1, 0, deployer.address, Math.floor(Date.now() / 1000) + 600);

  console.log(JSON.stringify({
    chainId: 31337,
    deployer: deployer.address,
    factory: await factory.getAddress(),
    pool: poolAddress,
    tokenA: await tokenA.getAddress(),
    tokenB: await tokenB.getAddress()
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
