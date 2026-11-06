import hre from "hardhat";

async function main() {
  const Factory = await hre.ethers.getContractFactory("LocalSwapFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  console.log("LocalSwapFactory:", await factory.getAddress());
  console.log("No owner, admin key, proxy, fee recipient, or backend was created.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
