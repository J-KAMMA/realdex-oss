import hre from "hardhat";
import { writeFileSync } from "node:fs";

// Creates and seeds one AMBR/USDC pool on the already deployed Base Sepolia
// factory, so the bridge routes finally have something to join.
//
// Every reviewed bridge carries USDC; the deployed pools hold only AMBR and
// JADE, so nothing joins and the screen correctly says so. The screen's own gap
// search names this exact pool as the one route that would open it.
//
// This sends transactions on a public network. It therefore does nothing at all
// unless it is told to, twice: `--confirm` on the command line, and a network
// that is actually Base Sepolia. It verifies the factory it is about to use is
// the reviewed one before touching it, and writes down what it did.
//
//   npx hardhat run scripts/createBaseSepoliaUsdcPool.ts --network baseSepolia
//
// See the internal design notes (not published) for the whole procedure, and
// the internal design notes (not published) for where the signing key comes from.
const BASE_SEPOLIA_CHAIN_ID = 84532n;
const AMBR = "0xa7aD1A578C2758D761F8DB4D1C8220b3fCcf4996";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FACTORY = "0x1b2B307F1AaE38f029290eD5AD7CC459069851B2";
// Matches the tier the existing pool uses, so the screen's configured tier list
// covers it without any further change.
const FEE_BASIS_POINTS = 1;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const confirmed = process.argv.includes("--confirm");
  const ambrAmount = flag("--ambr") ?? "1000";
  const usdcAmount = flag("--usdc") ?? "10";

  const network = await hre.ethers.provider.getNetwork();
  console.log(`network chainId: ${network.chainId}`);
  if (network.chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error("NOT_BASE_SEPOLIA");

  // The factory is only usable if it is the one that was reviewed. A different
  // contract at this address is not a deployment problem to work around.
  const identities = (await import("../src/swap/local-amm-code-identities.json", { with: { type: "json" } })).default;
  const factoryCode = await hre.ethers.provider.getCode(FACTORY);
  const factoryCodeHash = hre.ethers.keccak256(factoryCode).toLowerCase();
  console.log(`factory runtime code hash: ${factoryCodeHash}`);
  if (factoryCodeHash !== identities.factoryRuntimeCodeHash.toLowerCase()) throw new Error("FACTORY_CODE_IDENTITY_MISMATCH");

  const factory = await hre.ethers.getContractAt("LocalSwapFactory", FACTORY);
  const existing: string = await factory.getPool(AMBR, USDC, FEE_BASIS_POINTS);
  console.log(`existing pool at this tier: ${existing}`);

  // Measured on 2026-09-05: two independent readers agree there is no code at
  // the reviewed USDC address. Say that, rather than failing inside an ABI decode.
  for (const [name, address] of [["AMBR", AMBR], ["USDC", USDC]] as const) {
    const code = await hre.ethers.provider.getCode(address);
    console.log(name + " code length: " + code.length);
    if (code === "0x") throw new Error("NO_CONTRACT_AT_" + name + "_ADDRESS");
  }

  const ambr = await hre.ethers.getContractAt("MockERC20", AMBR);
  const usdc = await hre.ethers.getContractAt("MockERC20", USDC);
  const ambrUnits = hre.ethers.parseUnits(ambrAmount, Number(await ambr.decimals()));
  const usdcUnits = hre.ethers.parseUnits(usdcAmount, Number(await usdc.decimals()));

  // A key is only needed to send. Reading this far without one is the point of
  // the rehearsal, so its absence is reported rather than thrown until the moment
  // something would actually be signed.
  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  console.log(`signer: ${deployer ? deployer.address : "none configured — see the internal design notes (not published)"}`);
  console.log(`would deposit: ${ambrAmount} AMBR and ${usdcAmount} USDC at ${FEE_BASIS_POINTS} bp`);

  if (!confirmed) {
    console.log("\nNothing was sent. Re-run with --confirm to create and seed the pool.");
    return;
  }
  if (!deployer) throw new Error("NO_SIGNER_CONFIGURED");

  // Refuse to start a deposit the balances cannot cover, rather than finding out
  // halfway through with a pool already created.
  const [ambrHeld, usdcHeld] = await Promise.all([ambr.balanceOf(deployer.address), usdc.balanceOf(deployer.address)]);
  if (ambrHeld < ambrUnits) throw new Error("INSUFFICIENT_AMBR");
  if (usdcHeld < usdcUnits) throw new Error("INSUFFICIENT_USDC");

  let poolAddress = existing;
  if (poolAddress === hre.ethers.ZeroAddress) {
    const created = await factory.connect(deployer).createPool(AMBR, USDC, FEE_BASIS_POINTS);
    console.log(`createPool tx: ${created.hash}`);
    await created.wait();
    poolAddress = await factory.getPool(AMBR, USDC, FEE_BASIS_POINTS);
  }
  console.log(`pool: ${poolAddress}`);

  const pool = await hre.ethers.getContractAt("LocalSwapPool", poolAddress);
  const token0: string = await pool.token0();
  const ambrIsToken0 = token0.toLowerCase() === AMBR.toLowerCase();
  const [amount0, amount1] = ambrIsToken0 ? [ambrUnits, usdcUnits] : [usdcUnits, ambrUnits];

  // Approve exactly what is deposited, and check it ends at zero — the same rule
  // a participant is held to.
  await (await ambr.connect(deployer).approve(poolAddress, ambrUnits)).wait();
  await (await usdc.connect(deployer).approve(poolAddress, usdcUnits)).wait();
  const deadline = (await hre.ethers.provider.getBlock("latest"))!.timestamp + 600;
  const added = await pool.connect(deployer).addLiquidity(amount0, amount1, 1, deployer.address, deadline);
  console.log(`addLiquidity tx: ${added.hash}`);
  const receipt = await added.wait();

  const [leftAmbr, leftUsdc] = await Promise.all([
    ambr.allowance(deployer.address, poolAddress),
    usdc.allowance(deployer.address, poolAddress)
  ]);
  if (leftAmbr !== 0n || leftUsdc !== 0n) throw new Error("ALLOWANCE_LEFT_STANDING");

  const [reserve0, reserve1] = await pool.getReserves();
  const evidence = {
    schema: "realdex.base-sepolia-usdc-pool.v1",
    network: "eip155:84532",
    factory: FACTORY,
    factoryRuntimeCodeHash: factoryCodeHash,
    pool: poolAddress,
    poolRuntimeCodeHash: hre.ethers.keccak256(await hre.ethers.provider.getCode(poolAddress)).toLowerCase(),
    feeBasisPoints: FEE_BASIS_POINTS,
    token0, token1: await pool.token1(),
    reserve0: reserve0.toString(), reserve1: reserve1.toString(),
    totalSupply: (await pool.totalSupply()).toString(),
    deployer: deployer.address,
    createPoolBlock: receipt?.blockNumber ?? null,
    addLiquidityTxHash: added.hash,
    capturedAt: new Date().toISOString()
  };
  const out = `artifacts-v01/base-sepolia-usdc-pool.json`;
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
  console.log("Read the pool back through a second independent RPC before trusting this file.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
