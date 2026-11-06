import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Interface, keccak256, parseEther } from "ethers";

// This module is a test-only local harness for browser QA. It deliberately loads the
// dedicated Hardhat config before requiring Hardhat, so this file cannot accidentally
// attach the browser test to a localhost process or a public RPC endpoint.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testConfig = resolve(projectRoot, "hardhat.v01-test.config.cjs");
process.env.HARDHAT_CONFIG = testConfig;
process.env.HARDHAT_NETWORK = "hardhat";
const hre = createRequire(import.meta.url)("hardhat");

// Read the pinned identities rather than keeping a copy of them.
//
// This file used to hard-code the factory and router runtime code hashes below, with a
// comment saying they intentionally match the pinned ones. They stopped matching, and
// nothing said so: every harness built on this fixture died at
// DEPLOYMENT_SOURCE_IDENTITY_MISMATCH, an error that names the check and neither of the
// two values, so the drift had to be found by comparing them by hand. A copy of a pinned
// value goes stale; the pin is one file away.
const CODE_IDENTITIES = createRequire(import.meta.url)("../src/swap/local-amm-code-identities.json");
const POOL_FEE_BASIS_POINTS = 1;

const CHAIN_ID = 84532n;
const CHAIN_ID_HEX = "0x14a34";
const ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE_ABI = [
  "function getL1FeeUpperBound(uint256) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)"
];
const oracleInterface = new Interface(ORACLE_ABI);
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_getCode", "eth_call", "eth_estimateGas",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getTransactionCount",
  "eth_getBalance"
]);

function isOracleCall(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof value.to === "string" && value.to.toLowerCase() === ORACLE.toLowerCase()
    && typeof value.data === "string";
}

function cloneForEvidence(value) {
  return value && typeof value === "object" ? structuredClone(value) : value;
}

function deploymentEvidence(contract, receipt, runtimeCodeHash) {
  return {
    address: contract.target,
    deploymentTxHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    runtimeCodeHash
  };
}

/**
 * Make the one shared lock used by read RPC shims and wallet broadcasts. A held swap
 * intentionally never enters this lock until the synthetic user releases it; this
 * preserves the browser QA assertion that reads remain observable while confirmation
 * is pending. The lock is local process state and supplies no production concurrency
 * or wallet-safety guarantee.
 */
function createSerializer() {
  let tail = Promise.resolve();
  return task => {
    const run = tail.then(task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

async function rawSend(method, params = []) {
  return hre.network.provider.send(method, params);
}

function assertHardhatChain() {
  if (hre.network.name !== "hardhat") throw new Error("V01_BROWSER_FIXTURE_NETWORK_INVALID");
}

/**
 * Create a fully local RealDEX v0.1 browser fixture. The profile keeps the same
 * synthetic release labels as local-integration.test.ts; it is fixture data only and
 * must be fingerprinted and reviewed by the caller. The fake HTTPS reader endpoints
 * in that profile are intercepted by the browser QA runner and never fetched here.
 */
export async function createV01BrowserFixture() {
  assertHardhatChain();
  if (BigInt(await rawSend("eth_chainId")) !== CHAIN_ID) throw new Error("V01_BROWSER_FIXTURE_CHAIN_INVALID");

  // hardhat_reset is deliberately the only reset: no localhost server, public RPC,
  // wallet extension, secret, public deployment, or external state is involved.
  await rawSend("hardhat_reset", []);
  if (hre.network.name !== "hardhat" || BigInt(await rawSend("eth_chainId")) !== CHAIN_ID) {
    throw new Error("V01_BROWSER_FIXTURE_RESET_INVALID");
  }
  await hre.run("compile");

  const [owner, trader] = await hre.ethers.getSigners();
  const Token = await hre.ethers.getContractFactory("MockERC20");
  const ambr = await Token.deploy("Demo Amber", "AMBR", 18);
  const jade = await Token.deploy("Demo Jade", "JADE", 18);
  await ambr.waitForDeployment();
  await jade.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("LocalSwapFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const poolTx = await factory.createPool(ambr.target, jade.target, POOL_FEE_BASIS_POINTS);
  const poolReceipt = await poolTx.wait();
  const poolAddress = await factory.getPool(ambr.target, jade.target, 1);
  const pool = await hre.ethers.getContractAt("LocalSwapPool", poolAddress);

  const Router = await hre.ethers.getContractFactory("LocalSwapRouter");
  const router = await Router.deploy();
  await router.waitForDeployment();

  const supply = parseEther("1000000");
  await (await ambr.mint(owner.address, supply)).wait();
  await (await jade.mint(owner.address, supply)).wait();
  await (await ambr.mint(trader.address, parseEther("1000"))).wait();
  await (await jade.mint(trader.address, parseEther("1000"))).wait();

  const amount0 = parseEther("100000");
  const amount1 = parseEther("200000");
  const token0 = (await pool.token0()).toLowerCase() === ambr.target.toLowerCase() ? ambr : jade;
  const token1 = token0.target.toLowerCase() === ambr.target.toLowerCase() ? jade : ambr;
  await (await token0.connect(owner).approve(pool.target, amount0)).wait();
  await (await token1.connect(owner).approve(pool.target, amount1)).wait();
  const latest = await hre.ethers.provider.getBlock("latest");
  assert.ok(latest, "latest block unavailable in local Hardhat fixture");
  await (await pool.connect(owner).addLiquidity(amount0, amount1, 1n, owner.address, Number(latest.timestamp) + 3600)).wait();

  const factoryReceipt = await hre.ethers.provider.getTransactionReceipt(factory.deploymentTransaction().hash);
  const routerReceipt = await hre.ethers.provider.getTransactionReceipt(router.deploymentTransaction().hash);
  if (!factoryReceipt || !routerReceipt || !poolReceipt) throw new Error("V01_BROWSER_FIXTURE_RECEIPT_MISSING");
  const factoryCode = await hre.ethers.provider.getCode(factory.target);
  const routerCode = await hre.ethers.provider.getCode(router.target);
  const poolCode = await hre.ethers.provider.getCode(pool.target);

  const profile = {
    schema: "realdex.v01-profile.v1",
    deployment: {
      schema: "realdex.evm-public-testnet-deployment.v1",
      releaseId: "realdex-v01-local-test",
      environment: "public-testnet",
      network: { caip2: "eip155:84532", name: "Base Sepolia" },
      source: {
        // Taken from the pin, not copied from it. These do not approve a release or
        // identify public bytecode — the browser runner computes its own pin — but the
        // profile validator requires them to equal the pinned identities, so a copy here
        // only decides how long it takes to notice that they no longer do.
        bundleSha256: `sha256:${"0".repeat(64)}`,
        solidity: CODE_IDENTITIES.solidity,
        optimizerRuns: CODE_IDENTITIES.optimizerRuns,
        factoryRuntimeCodeHash: CODE_IDENTITIES.factoryRuntimeCodeHash,
        routerRuntimeCodeHash: CODE_IDENTITIES.routerRuntimeCodeHash
      },
      deployer: owner.address,
      contracts: {
        factory: deploymentEvidence(factory, factoryReceipt, keccak256(factoryCode)),
        router: deploymentEvidence(router, routerReceipt, keccak256(routerCode))
      },
      createdAt: Date.now(),
      evidenceUrls: ["https://example.com/realdex-v01-local-test", "https://example.org/realdex-v01-local-test"]
    },
    // feeBasisPoints joined the profile shape and this fixture did not follow, so
    // parseV01Profile rejected it with V01_PROFILE_SHAPE_INVALID — an error that says a
    // key set is wrong without saying which key. It is taken from the same constant the
    // pool is actually created with, so the two cannot disagree.
    pool: { address: pool.target, runtimeCodeHash: keccak256(poolCode), feeBasisPoints: POOL_FEE_BASIS_POINTS },
    tokens: { ambr: ambr.target, jade: jade.target }
  };

  const serialize = createSerializer();
  const stats = {
    connectionRequests: 0,
    sends: [],
    attemptedSends: 0,
    waitingSwaps: 0
  };
  let holdSwaps = false;
  let pendingRole = null;
  const waitingSwapResolvers = new Set();
  const approvalTargets = new Set([ambr.target.toLowerCase(), jade.target.toLowerCase()]);

  async function readOne(method, params) {
    if (method === "eth_call" && isOracleCall(params[0])) {
      // Synthetic local fee observations only. These constants are not public gas
      // evidence and must never be used to claim production fee availability.
      const parsed = oracleInterface.parseTransaction({ data: params[0].data });
      if (!parsed || (parsed.name !== "getL1FeeUpperBound" && parsed.name !== "getOperatorFee")) {
        throw new Error("V01_BROWSER_FIXTURE_ORACLE_CALL_INVALID");
      }
      const output = parsed.name === "getL1FeeUpperBound" ? 100_000n : 25_000n;
      return oracleInterface.encodeFunctionResult(parsed.name, [output]);
    }

    if (method === "eth_estimateGas" && params.length === 3) {
      const override = params[2];
      if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("V01_BROWSER_FIXTURE_OVERRIDE_INVALID");
      const snapshot = await rawSend("evm_snapshot", []);
      try {
        for (const [token, value] of Object.entries(override)) {
          if (!value || typeof value !== "object" || Array.isArray(value) || !value.stateDiff || typeof value.stateDiff !== "object") {
            throw new Error("V01_BROWSER_FIXTURE_STATE_DIFF_INVALID");
          }
          for (const [slot, word] of Object.entries(value.stateDiff)) {
            if (typeof word !== "string") throw new Error("V01_BROWSER_FIXTURE_STORAGE_WORD_INVALID");
            // Snapshot -> setStorageAt -> plain estimate -> revert is a test-only shim
            // for the third eth_estimateGas argument; no override survives this call.
            await rawSend("hardhat_setStorageAt", [token, slot, word]);
          }
        }
        return await rawSend("eth_estimateGas", [params[0], params[1]]);
      } finally {
        if (await rawSend("evm_revert", [snapshot]) !== true) throw new Error("V01_BROWSER_FIXTURE_REVERT_FAILED");
      }
    }
    if (!READ_METHODS.has(method)) throw new Error(`unexpected synthetic rpc method ${method}`);
    return rawSend(method, params);
  }

  // Read transport is intentionally serialized with raw wallet broadcasts and with
  // the temporary allowance state override above. It is not an HTTP/public transport.
  const rpc = (method, params = []) => {
    if (!READ_METHODS.has(method)) throw new Error(`unexpected synthetic rpc method ${method}`);
    return serialize(() => readOne(method, [...params]));
  };

  function assertWalletTransaction(transaction) {
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) throw new Error("V01_BROWSER_FIXTURE_TRANSACTION_INVALID");
    if (typeof transaction.from !== "string" || transaction.from.toLowerCase() !== trader.address.toLowerCase()) throw new Error("V01_BROWSER_FIXTURE_WALLET_FROM_INVALID");
    if (typeof transaction.to !== "string") throw new Error("V01_BROWSER_FIXTURE_WALLET_TO_INVALID");
    const knownTargets = new Set([ambr.target, jade.target, pool.target].map(value => value.toLowerCase()));
    if (!knownTargets.has(transaction.to.toLowerCase())) throw new Error("V01_BROWSER_FIXTURE_WALLET_TARGET_INVALID");
  }

  async function waitForSwapRelease() {
    if (!holdSwaps) return;
    stats.waitingSwaps += 1;
    await new Promise(resolveWait => waitingSwapResolvers.add(resolveWait));
    stats.waitingSwaps -= 1;
  }

  async function wallet(method, params = []) {
    const normalized = [...params];
    if (method === "eth_chainId") return CHAIN_ID_HEX;
    if (method === "eth_accounts") return [trader.address];
    if (method === "eth_requestAccounts") {
      stats.connectionRequests += 1;
      return [trader.address];
    }
    if (method === "eth_sendTransaction") {
      if (normalized.length !== 1) throw new Error("V01_BROWSER_FIXTURE_SEND_PARAMS_INVALID");
      const transaction = normalized[0];
      assertWalletTransaction(transaction);
      stats.attemptedSends += 1;
      const isSwap = transaction.to.toLowerCase() === pool.target.toLowerCase();
      const role = isSwap ? "swap" : approvalTargets.has(transaction.to.toLowerCase()) ? "approval" : null;
      // Wait before entering the serializer/raw provider. Reads therefore remain live
      // while the browser test simulates a wallet confirmation screen.
      if (isSwap) await waitForSwapRelease();
      const hash = await serialize(async () => {
        if (role && pendingRole === role) await rawSend("evm_setAutomine", [false]);
        return rawSend(method, normalized);
      });
      stats.sends.push({ hash, transaction: cloneForEvidence(transaction) });
      return hash;
    }
    if (READ_METHODS.has(method)) return rpc(method, normalized);
    throw new Error(`unexpected synthetic wallet method ${method}`);
  }

  const balances = () => serialize(async () => ({
    ambr: String(await ambr.balanceOf(trader.address)),
    jade: String(await jade.balanceOf(trader.address))
  }));
  const allowance = () => serialize(async () => String(await ambr.allowance(trader.address, pool.target)));

  const mine = async () => serialize(() => rawSend("evm_mine", []));
  // Test-only same-nonce replacement. It is never exposed as a browser wallet RPC.
  // The role-aware control is used for both the approval and swap phases; the
  // swap-specific names below remain compatibility shims for older harnesses.
  const replacePending = (role, mode) => serialize(async () => {
    assertHardhatChain();
    assert.ok(pendingRole === role && ["repriced", "cancelled", "replaced"].includes(mode));
    const original = stats.sends.at(-1);
    if (role === "swap") assert.equal(original?.transaction.to.toLowerCase(), pool.target.toLowerCase());
    else assert.ok(approvalTargets.has(original?.transaction.to.toLowerCase()));
    assert.equal(await rawSend("eth_getTransactionReceipt", [original.hash]), null);
    const transaction = { ...original.transaction,
      maxFeePerGas: `0x${(BigInt(original.transaction.maxFeePerGas) * 2n).toString(16)}`,
      maxPriorityFeePerGas: `0x${(BigInt(original.transaction.maxPriorityFeePerGas) * 2n).toString(16)}` };
    if (mode === "cancelled") Object.assign(transaction, { to: trader.address, data: "0x", value: "0x0" });
    if (mode === "replaced") Object.assign(transaction, role === "swap"
      ? { to: jade.target, data: jade.interface.encodeFunctionData("approve", [pool.target, 0n]) }
      : { to: (transaction.to.toLowerCase() === ambr.target.toLowerCase() ? jade.target : ambr.target), data: jade.interface.encodeFunctionData("approve", [pool.target, 0n]) });
    const hash = await rawSend("eth_sendTransaction", [transaction]);
    await rawSend("evm_mine", []); await rawSend("evm_mine", []);
    await rawSend("evm_setAutomine", [true]); pendingRole = null;
    return { hash, transaction, receipt: await rawSend("eth_getTransactionReceipt", [hash]) };
  });
  const replacePendingSwap = mode => replacePending("swap", mode);
  const replacePendingApproval = mode => replacePending("approval", mode);
  const setPendingRole = (role, value) => {
    assert.ok(role === "approval" || role === "swap");
    pendingRole = value ? role : null;
  };
  const setSwapHold = hold => { holdSwaps = Boolean(hold); };
  const releaseSwap = () => {
    holdSwaps = false;
    for (const resolveWait of waitingSwapResolvers) resolveWait();
    waitingSwapResolvers.clear();
  };

  return {
    profile,
    account: trader.address,
    addresses: { ambr: ambr.target, jade: jade.target, pool: pool.target },
    rpc,
    wallet,
    balances,
    allowance,
    mine,
    setPendingRole,
    setPendingSwap: value => setPendingRole("swap", value),
    setPendingApproval: value => setPendingRole("approval", value),
    replacePending,
    replacePendingSwap,
    replacePendingApproval,
    stats,
    setSwapHold,
    releaseSwap,
    // Browser QA owns no external resources, but this gives callers a safe way to
    // unblock a held synthetic confirmation when a test aborts.
    dispose: async () => { releaseSwap(); await serialize(() => rawSend("evm_setAutomine", [true])); }
  };
}
