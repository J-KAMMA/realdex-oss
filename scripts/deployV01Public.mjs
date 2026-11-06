#!/usr/bin/env node
// RealDEX v0.1 deployment for the approved fixed target.
//
// Deploys exactly what V01_SCOPE fixes: the two demo tokens, the factory, the
// router, one pool for the pair, and the initial test liquidity. Nothing else.
// It creates no owner, admin key, proxy, fee recipient or backend.
//
// Guards before any send: exact chain ID, non-delegated signer EOA, a positive
// balance, and (unless --allow-reuse) an empty deployment record for this chain.
// Every step records its transaction hash, gas used and fees, so the run itself
// is the evidence. Use --dry-run to price the run without sending anything.
//
// The private key is read from REALDEX_V01_SIGNER_PRIVATE_KEY or the JSON file
// named by REALDEX_V01_SIGNER_KEY_FILE. It is never printed or written out.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ContractFactory, Contract, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, parseEther, keccak256 } from 'ethers'
import { v01SignerPrivateKey as privateKey } from "./v01Signer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const DRY_RUN = args.includes('--dry-run')
const ALLOW_REUSE = args.includes('--allow-reuse')
const RPC_URL = flag('--rpc', 'https://sepolia.base.org')
const EXPECTED_CHAIN_ID = BigInt(flag('--chain-id', '84532'))
const OUT_DIR = path.resolve(root, flag('--out', 'artifacts-v01'))

// Fixed by the approved scope. Changing any of these changes the target.
const AMBR = { name: 'Demo Amber', symbol: 'AMBR', decimals: 18 }
const JADE = { name: 'Demo Jade', symbol: 'JADE', decimals: 18 }
const MINT_AMOUNT = parseEther('100000')
const LIQUIDITY_A = parseEther('10000')
const LIQUIDITY_B = parseEther('20000')
// The v0.1 tier. A pair can have a pool per tier, so every lookup names one.
const FEE_BASIS_POINTS = 1


function artifact (relative) {
  return JSON.parse(fs.readFileSync(path.resolve(root, 'artifacts/contracts', relative), 'utf8'))
}


// A public endpoint can serve a stale state right after a receipt; read until the
// value is actually there rather than trusting the first answer.
async function settled (read, label, attempts = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const value = await read()
    if (value !== null && value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  throw new Error(`${label}: not visible after ${attempts} reads`)
}

const steps = []

async function record (provider, label, response) {
  const receipt = await response.wait()
  // ethers drops the OP-stack L1 fee fields, so read the raw receipt too.
  const raw = await provider.send('eth_getTransactionReceipt', [receipt.hash])
  const l1Fee = raw && raw.l1Fee ? BigInt(raw.l1Fee) : 0n
  const l2Fee = receipt.gasUsed * receipt.gasPrice
  if (receipt.status !== 1) throw new Error(`${label} reverted: ${receipt.hash}`)
  steps.push({
    label,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    contractAddress: receipt.contractAddress ?? null,
    gasUsed: receipt.gasUsed.toString(),
    gasPriceWei: receipt.gasPrice.toString(),
    l2FeeWei: l2Fee.toString(),
    l1FeeWei: l1Fee.toString(),
    totalFeeWei: (l2Fee + l1Fee).toString()
  })
  return receipt
}

async function deploy (provider, signer, label, compiled, deployArguments = []) {
  const factory = new ContractFactory(compiled.abi, compiled.bytecode, signer)
  const contract = await factory.deploy(...deployArguments)
  await record(provider, label, contract.deploymentTransaction())
  return contract
}

// The runtime hash the profile pins. Empty code must never hash as a match.
function runtimeCodeHash (code) {
  if (typeof code !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(code) || code === '0x') throw new Error('RUNTIME_CODE_EMPTY')
  return keccak256(code)
}

async function main () {
  const provider = new JsonRpcProvider(RPC_URL)
  const wallet = new Wallet(privateKey(), provider)

  const network = await provider.getNetwork()
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`DEPLOY_CHAIN_MISMATCH: got ${network.chainId}, expected ${EXPECTED_CHAIN_ID}`)
  const signerCode = await provider.getCode(wallet.address)
  if (signerCode !== '0x') throw new Error(`DEPLOY_SIGNER_NOT_ORDINARY_EOA: ${wallet.address} has code`)
  const balance = await provider.getBalance(wallet.address)
  if (balance === 0n) throw new Error(`DEPLOY_SIGNER_UNFUNDED: ${wallet.address} has zero balance`)

  const feeData = await provider.getFeeData()
  console.error(`chain ${network.chainId} | signer ${wallet.address} | balance ${balance} wei | maxFeePerGas ${feeData.maxFeePerGas ?? feeData.gasPrice} wei`)

  // The provider caches eth_getTransactionCount briefly, so consecutive sends
  // would reuse a nonce. Track it locally instead.
  const signer = new NonceManager(wallet)

  const mockErc20 = artifact('test/MockERC20.sol/MockERC20.json')
  const factoryArtifact = artifact('LocalSwapFactory.sol/LocalSwapFactory.json')
  const routerArtifact = artifact('LocalSwapRouter.sol/LocalSwapRouter.json')
  const poolArtifact = artifact('LocalSwapPool.sol/LocalSwapPool.json')

  if (DRY_RUN) {
    // Only the four creations can be priced before anything exists on chain.
    const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n
    const creations = [
      ['token:AMBR', new ContractFactory(mockErc20.abi, mockErc20.bytecode).getDeployTransaction(AMBR.name, AMBR.symbol, AMBR.decimals)],
      ['token:JADE', new ContractFactory(mockErc20.abi, mockErc20.bytecode).getDeployTransaction(JADE.name, JADE.symbol, JADE.decimals)],
      ['factory', new ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode).getDeployTransaction()],
      ['router', new ContractFactory(routerArtifact.abi, routerArtifact.bytecode).getDeployTransaction()]
    ]
    const estimates = []
    for (const [label, transaction] of await Promise.all(creations.map(async ([label, tx]) => [label, await tx]))) {
      const gas = await provider.estimateGas({ from: wallet.address, data: transaction.data })
      estimates.push({ label, gas: gas.toString(), l2FeeWei: (gas * price).toString(), calldataBytes: (transaction.data.length - 2) / 2 })
    }
    console.log(JSON.stringify({ mode: 'dry-run', chainId: network.chainId.toString(), signer: wallet.address,
      balanceWei: balance.toString(), gasPriceWei: price.toString(), creations: estimates }, null, 2))
    return
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `deployment-${network.chainId}.json`)

  // Archive the record this deployment replaces, before it is overwritten.
  //
  // The out-of-scope check walks every archived record and asserts that none of
  // those addresses reach the screen, because a retired target looks exactly like
  // a live one. Retiring by hand is how a record goes missing, and a record that
  // goes missing is a set of addresses nothing is checking any more.
  if (fs.existsSync(outFile)) {
    const previous = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    const label = previous.releaseId
      ?? previous.pin?.releaseId
      ?? (previous.recordedAt ?? previous.deployedAt)?.replace(/[^0-9]/g, '').slice(0, 14)
      ?? String(Date.now())
    const archive = path.join(OUT_DIR, `deployment-${network.chainId}-retired-${label}.json`)
    if (fs.existsSync(archive)) throw new Error(`REFUSING_TO_OVERWRITE_ARCHIVE: ${archive}`)
    fs.renameSync(outFile, archive)
    console.log(`archived the replaced deployment as ${path.basename(archive)}`)
  }
  if (fs.existsSync(outFile) && !ALLOW_REUSE) throw new Error(`DEPLOY_RECORD_EXISTS: ${outFile}. Review it before deploying again, or pass --allow-reuse.`)

  const ambr = await deploy(provider, signer, 'token:AMBR', mockErc20, [AMBR.name, AMBR.symbol, AMBR.decimals])
  const jade = await deploy(provider, signer, 'token:JADE', mockErc20, [JADE.name, JADE.symbol, JADE.decimals])
  const factory = await deploy(provider, signer, 'factory', factoryArtifact)
  const router = await deploy(provider, signer, 'router', routerArtifact)

  const ambrAddress = await ambr.getAddress()
  const jadeAddress = await jade.getAddress()
  const factoryAddress = await factory.getAddress()
  const routerAddress = await router.getAddress()

  await record(provider, 'createPool', await factory.createPool(ambrAddress, jadeAddress, FEE_BASIS_POINTS))
  // A public endpoint serves a stale state right after the receipt, so read the
  // new pool until it is actually visible instead of trusting the first answer.
  const poolAddress = await settled(async () => {
    const address = await factory.getPool(ambrAddress, jadeAddress, FEE_BASIS_POINTS)
    if (address === ZeroAddress) return null
    return (await provider.getCode(address)) === '0x' ? null : address
  }, 'POOL_NOT_VISIBLE')
  const pool = new Contract(poolAddress, poolArtifact.abi, signer)

  await record(provider, 'mint:AMBR', await ambr.mint(wallet.address, MINT_AMOUNT))
  await record(provider, 'mint:JADE', await jade.mint(wallet.address, MINT_AMOUNT))

  // token0/token1 ordering is the pool's, not the argument order.
  const token0 = await pool.token0()
  const [amount0, amount1] = token0.toLowerCase() === ambrAddress.toLowerCase()
    ? [LIQUIDITY_A, LIQUIDITY_B]
    : [LIQUIDITY_B, LIQUIDITY_A]

  // Exactly what is about to be deposited, in the pool's own token order.
  const [approveAmbr, approveJade] = token0.toLowerCase() === ambrAddress.toLowerCase()
    ? [amount0, amount1]
    : [amount1, amount0]
  await record(provider, 'approve:AMBR', await ambr.approve(poolAddress, approveAmbr))
  await record(provider, 'approve:JADE', await jade.approve(poolAddress, approveJade))

  for (const [label, token, amount] of [['approve:AMBR', ambr, approveAmbr], ['approve:JADE', jade, approveJade]]) {
    await settled(async () => (await token.allowance(wallet.address, poolAddress)) >= amount ? true : null, `${label}_NOT_VISIBLE`)
  }

  const deadline = Math.floor(Date.now() / 1000) + 900
  await record(provider, 'addLiquidity', await pool.addLiquidity(amount0, amount1, 0, wallet.address, deadline))

  // Nothing may be left approved. A residue here is invisible to every later check
  // except the ones it quietly disables.
  for (const [label, token] of [['AMBR', ambr], ['JADE', jade]]) {
    const left = await settled(async () => {
      const value = await token.allowance(wallet.address, poolAddress)
      return value === 0n ? 0n : null
    }, `${label}_ALLOWANCE_NOT_CONSUMED`)
    if (left !== 0n) throw new Error(`${label}_ALLOWANCE_NOT_CONSUMED`)
  }

  const [factoryStep, routerStep] = ['factory', 'router'].map(label => steps.find(step => step.label === label))
  const [factoryCode, routerCode, poolCode] = await Promise.all([
    provider.getCode(factoryAddress), provider.getCode(routerAddress), provider.getCode(poolAddress)
  ])

  const totalFeeWei = steps.reduce((sum, step) => sum + BigInt(step.totalFeeWei), 0n)
  const record_ = {
    schema: 'realdex.v01-deployment-record.v1',
    chainId: network.chainId.toString(),
    rpcUrl: RPC_URL,
    deployer: wallet.address,
    recordedAt: new Date().toISOString(),
    addresses: { ambr: ambrAddress, jade: jadeAddress, factory: factoryAddress, router: routerAddress, pool: poolAddress },
    runtimeCodeHashes: {
      // The tokens belong here too: the profile pins their identity, and a record
      // that omits them cannot be turned into a profile at all.
      ambr: runtimeCodeHash(await provider.getCode(ambrAddress)),
      jade: runtimeCodeHash(await provider.getCode(jadeAddress)),
      factory: runtimeCodeHash(factoryCode),
      router: runtimeCodeHash(routerCode),
      pool: runtimeCodeHash(poolCode)
    },
    contracts: {
      factory: { address: factoryAddress, deploymentTxHash: factoryStep.transactionHash, blockNumber: factoryStep.blockNumber, runtimeCodeHash: runtimeCodeHash(factoryCode) },
      router: { address: routerAddress, deploymentTxHash: routerStep.transactionHash, blockNumber: routerStep.blockNumber, runtimeCodeHash: runtimeCodeHash(routerCode) }
    },
    pool: { address: poolAddress, token0, feeBasisPoints: Number(await pool.feeBasisPoints()) },
    liquidity: { amount0: amount0.toString(), amount1: amount1.toString(), token0 },
    steps,
    totalFeeWei: totalFeeWei.toString(),
    remainingBalanceWei: (await provider.getBalance(wallet.address)).toString()
  }
  fs.writeFileSync(outFile, JSON.stringify(record_, null, 2) + '\n')
  console.log(JSON.stringify(record_, null, 2))
  console.error(`\nwrote ${outFile}`)
}

main().catch(error => { console.error(error.message ?? error); process.exitCode = 1 })
