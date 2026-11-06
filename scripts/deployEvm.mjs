#!/usr/bin/env node
// Deploy your own RealDEX LocalSwap Factory and Router.
//
// You run this yourself, with your own key and your own RPC. Nothing in the project
// runs it, funds it or holds a key for it. Contracts have no owner, admin key, proxy
// or fee recipient; the deployer keeps no special rights after deployment.
//
//   npx hardhat compile
//   REALDEX_DEPLOYER_PRIVATE_KEY=0x... node scripts/deployEvm.mjs --network eip155:8453 --dry-run
//   REALDEX_DEPLOYER_PRIVATE_KEY=0x... node scripts/deployEvm.mjs --network eip155:8453
//
// Options: --network <caip2>   one of the networks in src/release/evm-networks.json
//          --rpc <https url>   use this endpoint instead of the first well-known one
//          --out <directory>   where the deployment file is written (default ./deployments)
//          --dry-run           check chain, signer and price the creations; send nothing
//
// The key is read from REALDEX_DEPLOYER_PRIVATE_KEY, or from the JSON file
// ({"privateKey": "0x..."}) named by REALDEX_DEPLOYER_KEY_FILE. It is never printed.
// The file written to --out is a deployment manifest: load it in the app's Release
// view and copy the two addresses into Setup. It contains no secret.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, NonceManager, Wallet, getAddress, keccak256 } from "ethers";
import { createEvmTestnetReleasePlan } from "./createEvmTestnetReleasePlan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const DRY_RUN = args.includes("--dry-run");

export function loadNetworks() {
  return JSON.parse(fs.readFileSync(path.join(root, "src/release/evm-networks.json"), "utf8")).networks;
}

export function deployerKey(env = process.env) {
  if (env.REALDEX_DEPLOYER_PRIVATE_KEY) return env.REALDEX_DEPLOYER_PRIVATE_KEY;
  const file = env.REALDEX_DEPLOYER_KEY_FILE;
  if (!file || !fs.existsSync(file)) throw new Error("DEPLOYER_KEY_MISSING: set REALDEX_DEPLOYER_PRIVATE_KEY, or REALDEX_DEPLOYER_KEY_FILE to a JSON file with a privateKey field");
  const { privateKey } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!privateKey) throw new Error("DEPLOYER_KEY_MISSING: the key file has no privateKey field");
  return privateKey;
}

const artifact = (name) => {
  const file = path.join(root, "artifacts/contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no artifact for ${name}; run npx hardhat compile first`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

function runtimeHash(code) {
  if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(code)) throw new Error("RUNTIME_CODE_EMPTY");
  return keccak256(code);
}

async function settled(read, label, attempts = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label}: not visible after ${attempts} reads`);
}

async function main() {
  const networks = loadNetworks();
  const id = flag("--network");
  if (!id || !Object.hasOwn(networks, id)) throw new Error(`--network must be one of: ${Object.keys(networks).join(", ")}`);
  const network = networks[id];
  const rpcUrl = flag("--rpc") ?? network.rpcUrls[0];
  const outDir = path.resolve(flag("--out") ?? "deployments");
  const identities = JSON.parse(fs.readFileSync(path.join(root, "src/swap/local-amm-code-identities.json"), "utf8"));

  const factoryArtifact = artifact("LocalSwapFactory");
  const routerArtifact = artifact("LocalSwapRouter");
  // The app only accepts a Factory/Router whose runtime hashes to these values, so a
  // build that differs is refused here rather than after gas has been spent.
  if (runtimeHash(factoryArtifact.deployedBytecode) !== identities.factoryRuntimeCodeHash || runtimeHash(routerArtifact.deployedBytecode) !== identities.routerRuntimeCodeHash) {
    throw new Error("BUILD_DOES_NOT_MATCH_PINNED_CODE_IDENTITY: compile with the pinned compiler settings (npx hardhat compile) and do not edit contracts/");
  }

  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
  const wallet = new Wallet(deployerKey(), provider);
  const chain = await provider.getNetwork();
  if (chain.chainId !== BigInt(network.chainId)) throw new Error(`DEPLOY_CHAIN_MISMATCH: the RPC answered chain ${chain.chainId}, expected ${network.chainId} (${network.name})`);
  if ((await provider.getCode(wallet.address)) !== "0x") throw new Error(`DEPLOY_SIGNER_NOT_ORDINARY_EOA: ${wallet.address} has code`);
  const balance = await provider.getBalance(wallet.address);
  if (balance === 0n) throw new Error(`DEPLOY_SIGNER_UNFUNDED: ${wallet.address} has no ${network.nativeSymbol} on ${network.name}`);
  const feeData = await provider.getFeeData();
  console.error(`${network.name} (${id}) | deployer ${wallet.address} | balance ${balance} wei | rpc ${new URL(rpcUrl).hostname}`);

  const creations = [["factory", factoryArtifact], ["router", routerArtifact]];
  if (DRY_RUN) {
    const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const estimates = [];
    for (const [label, compiled] of creations) {
      const tx = await new ContractFactory(compiled.abi, compiled.bytecode).getDeployTransaction();
      const gas = await provider.estimateGas({ from: wallet.address, data: tx.data });
      estimates.push({ label, gas: gas.toString(), feeWei: (gas * price).toString() });
    }
    console.log(JSON.stringify({ mode: "dry-run", network: id, deployer: wallet.address, balanceWei: balance.toString(), gasPriceWei: price.toString(), creations: estimates }, null, 2));
    return;
  }

  const manifestFile = path.join(outDir, `deployment-${network.chainId}.json`);
  if (fs.existsSync(manifestFile)) throw new Error(`REFUSING_TO_DEPLOY: ${manifestFile} already exists; move it aside first`);
  const signer = new NonceManager(wallet);
  const deployed = {};
  for (const [label, compiled] of creations) {
    const contract = await new ContractFactory(compiled.abi, compiled.bytecode, signer).deploy();
    const receipt = await contract.deploymentTransaction().wait();
    if (receipt.status !== 1) throw new Error(`${label} deployment reverted: ${receipt.hash}`);
    const address = getAddress(await contract.getAddress());
    const code = await settled(async () => { const value = await provider.getCode(address); return value === "0x" ? null : value; }, `${label.toUpperCase()}_CODE_NOT_VISIBLE`);
    deployed[label] = { address, deploymentTxHash: receipt.hash, blockNumber: receipt.blockNumber, runtimeCodeHash: runtimeHash(code) };
  }
  if (deployed.factory.runtimeCodeHash !== identities.factoryRuntimeCodeHash || deployed.router.runtimeCodeHash !== identities.routerRuntimeCodeHash) throw new Error("DEPLOYED_CODE_DOES_NOT_MATCH_PINNED_IDENTITY");

  const plan = await createEvmTestnetReleasePlan();
  const manifest = {
    schema: "realdex.evm-deployment.v1",
    releaseId: `${network.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${plan.source.bundleSha256.slice("sha256:".length, "sha256:".length + 12)}`,
    environment: network.environment,
    network: { caip2: id, name: network.name },
    source: { bundleSha256: plan.source.bundleSha256, solidity: identities.solidity, optimizerRuns: identities.optimizerRuns, factoryRuntimeCodeHash: identities.factoryRuntimeCodeHash, routerRuntimeCodeHash: identities.routerRuntimeCodeHash },
    deployer: wallet.address,
    contracts: { factory: deployed.factory, router: deployed.router },
    createdAt: Date.now(),
    evidenceUrls: [`${network.explorerAddressUrl}${deployed.factory.address}`, `${network.explorerAddressUrl}${deployed.router.address}`]
  };
  fs.mkdirSync(outDir, { recursive: true });
  const file = manifestFile;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
  console.error(`\nwrote ${file}\nFactory ${deployed.factory.address}\nRouter  ${deployed.router.address}\nLoad the file in the Release view, then enter both addresses in Setup.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message ?? error); process.exitCode = 1; });
}