import hre from "hardhat";

// Seeds a local chain with the case fee tiers exist for: one factory, one pair,
// two tiers at two addresses, and the dearer tier holding the deeper book.
//
// The 1 bp pool is thin and the 30 bp pool is deep, so a trade of any size the
// thin pool cannot absorb comes out ahead at 30 bp. That is the whole reason the
// screen shows what each tier would pay instead of just naming the tier: reading
// "1 bp" and stopping there gets you the worse price.
//
// The separate second factory and the A→C→B path are kept, because tiers must not
// quietly break multi-venue or multi-hop discovery.
const THIN_TIER = 1;
const DEEP_TIER = 30;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Demo Amber", "AMBR", 18);
  const tokenB = await Token.deploy("Demo Jade", "JADE", 18);
  const tokenC = await Token.deploy("Demo Sapphire", "SAPH", 18);
  await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment(), tokenC.waitForDeployment()]);
  await tokenA.mint(deployer.address, hre.ethers.parseEther("2000000"));
  await tokenB.mint(deployer.address, hre.ethers.parseEther("2000000"));
  await tokenC.mint(deployer.address, hre.ethers.parseEther("2000000"));

  // One factory, two tiers, two pools.
  const tieredFactory = await (await hre.ethers.getContractFactory("LocalSwapFactory")).deploy();
  await tieredFactory.waitForDeployment();
  const thinPool = await createAndSeedPool(tieredFactory, tokenA, tokenB, THIN_TIER, "10000", "20000");
  const deepPool = await createAndSeedPool(tieredFactory, tokenA, tokenB, DEEP_TIER, "200000", "400000");

  // A second factory on the same pair, so venue discovery still has more than one.
  const venueB = await deployVenue(tokenA, tokenB, THIN_TIER, "20000", "50000");

  const routeFactory = await (await hre.ethers.getContractFactory("LocalSwapFactory")).deploy();
  await routeFactory.waitForDeployment();
  const poolAC = await createAndSeedPool(routeFactory, tokenA, tokenC, THIN_TIER, "10000", "40000");
  const poolCB = await createAndSeedPool(routeFactory, tokenC, tokenB, THIN_TIER, "40000", "140000");
  const router = await (await hre.ethers.getContractFactory("LocalSwapRouter")).deploy();
  await router.waitForDeployment();

  // Quote both tiers for a trade the thin pool cannot absorb, so the seed itself
  // says which one wins rather than leaving it to be assumed.
  const probe = hre.ethers.parseEther("1000");
  const tokenAAddress = await tokenA.getAddress();
  const thin = await hre.ethers.getContractAt("LocalSwapPool", thinPool);
  const deep = await hre.ethers.getContractAt("LocalSwapPool", deepPool);
  const thinOut = await thin.quoteExactIn(tokenAAddress, probe);
  const deepOut = await deep.quoteExactIn(tokenAAddress, probe);

  console.log(JSON.stringify({
    chainId: 31337,
    deployer: deployer.address,
    tokenA: tokenAAddress,
    tokenB: await tokenB.getAddress(),
    intermediateToken: await tokenC.getAddress(),
    router: await router.getAddress(),
    tieredFactory: await tieredFactory.getAddress(),
    feeTiers: `${THIN_TIER}, ${DEEP_TIER}`,
    tiers: [
      { feeBasisPoints: THIN_TIER, pool: thinPool, reserveA: "10000", reserveB: "20000", quoteFor1000A: hre.ethers.formatEther(thinOut) },
      { feeBasisPoints: DEEP_TIER, pool: deepPool, reserveA: "200000", reserveB: "400000", quoteFor1000A: hre.ethers.formatEther(deepOut) }
    ],
    betterTierFor1000A: deepOut > thinOut ? DEEP_TIER : THIN_TIER,
    venues: [venueB, { factory: await routeFactory.getAddress(), pools: [poolAC, poolCB] }]
  }, null, 2));
}

async function deployVenue(tokenA: any, tokenB: any, feeBasisPoints: number, amountAText: string, amountBText: string) {
  const Factory = await hre.ethers.getContractFactory("LocalSwapFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const poolAddress = await createAndSeedPool(factory, tokenA, tokenB, feeBasisPoints, amountAText, amountBText);
  return { factory: await factory.getAddress(), pool: poolAddress, feeBasisPoints, reserveA: amountAText, reserveB: amountBText };
}

async function createAndSeedPool(factory: any, tokenA: any, tokenB: any, feeBasisPoints: number, amountAText: string, amountBText: string) {
  const tokenAAddress = await tokenA.getAddress();
  const tokenBAddress = await tokenB.getAddress();
  // The fee is part of the pool's identity: it goes into the salt, so the same
  // pair at another tier is another address, not the same pool behaving differently.
  await factory.createPool(tokenAAddress, tokenBAddress, feeBasisPoints);
  const poolAddress = await factory.getPool(tokenAAddress, tokenBAddress, feeBasisPoints);
  const pool = await hre.ethers.getContractAt("LocalSwapPool", poolAddress);
  const amountA = hre.ethers.parseEther(amountAText);
  const amountB = hre.ethers.parseEther(amountBText);
  await tokenA.approve(poolAddress, amountA);
  await tokenB.approve(poolAddress, amountB);
  const token0 = await pool.token0();
  const [amount0, amount1] = token0 === tokenAAddress ? [amountA, amountB] : [amountB, amountA];
  await pool.addLiquidity(amount0, amount1, 0, (await hre.ethers.getSigners())[0].address, Math.floor(Date.now() / 1000) + 600);
  return poolAddress;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
