#!/usr/bin/env node
// Demonstrates that a many-token market needs no new contract: the deployed
// permissionless factory and the existing router already do it.
//
// It adds a third demo token and a second pool, then routes one exact-input trade
// across both pools in a single transaction. The pass condition is the measured
// balance difference, not the receipt.
//
// This is NOT part of the v0.1 acceptance. It touches none of the pinned v0.1
// targets: the factory, router, pool and two tokens named in the reviewed profile
// keep their addresses and runtime code. Creating additional pools through a
// permissionless factory does not change any of them.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, formatEther, parseEther } from 'ethers'
import { v01SignerPrivateKey as privateKey } from "./v01Signer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const RPC_URL = flag('--rpc', 'https://sepolia.base.org')
const EXPECTED_CHAIN_ID = BigInt(flag('--chain-id', '84532'))
const OUT_DIR = path.resolve(root, flag('--out', 'artifacts-v01'))

const ONYX = { name: 'Demo Onyx', symbol: 'ONYX', decimals: 18 }
const ONYX_MINT = parseEther('100000')
const LIQUIDITY_JADE = parseEther('10000')
const LIQUIDITY_ONYX = parseEther('5000')
const ROUTE_AMOUNT_IN = parseEther('100')
const SLIPPAGE_BPS = 50n
// The v0.1 tier. A pair can have a pool per tier, so every lookup names one.
const FEE_BASIS_POINTS = 1


const artifact = rel => JSON.parse(fs.readFileSync(path.resolve(root, 'artifacts/contracts', rel), 'utf8'))


async function settled (read, label, attempts = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const value = await read()
    if (value !== null && value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  throw new Error(`${label}: not visible after ${attempts} reads`)
}

const steps = []
async function sent (provider, label, response) {
  const receipt = await response.wait()
  if (receipt.status !== 1) throw new Error(`${label} reverted: ${receipt.hash}`)
  const raw = await provider.send('eth_getTransactionReceipt', [receipt.hash])
  const l1Fee = raw && raw.l1Fee ? BigInt(raw.l1Fee) : 0n
  steps.push({
    label, transactionHash: receipt.hash, blockNumber: receipt.blockNumber,
    contractAddress: receipt.contractAddress ?? null, gasUsed: receipt.gasUsed.toString(),
    totalFeeWei: (receipt.gasUsed * receipt.gasPrice + l1Fee).toString()
  })
  console.error(`sent ${label} ${receipt.hash}`)
  return receipt
}

async function main () {
  const provider = new JsonRpcProvider(RPC_URL)
  const wallet = new Wallet(privateKey(), provider)
  const signer = new NonceManager(wallet)

  const network = await provider.getNetwork()
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`CHAIN_MISMATCH: ${network.chainId}`)
  if (await provider.getCode(wallet.address) !== '0x') throw new Error('SIGNER_NOT_ORDINARY_EOA')

  const deployment = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `deployment-${network.chainId}.json`), 'utf8'))
  const { ambr: ambrAddress, jade: jadeAddress, factory: factoryAddress, router: routerAddress, pool: ambrJadePool } = deployment.addresses

  const erc20 = artifact('test/MockERC20.sol/MockERC20.json')
  const poolAbi = artifact('LocalSwapPool.sol/LocalSwapPool.json').abi
  const factory = new Contract(factoryAddress, artifact('LocalSwapFactory.sol/LocalSwapFactory.json').abi, signer)
  const router = new Contract(routerAddress, artifact('LocalSwapRouter.sol/LocalSwapRouter.json').abi, signer)
  const ambr = new Contract(ambrAddress, erc20.abi, signer)
  const jade = new Contract(jadeAddress, erc20.abi, signer)

  // 1. A third token, deployed from the same unchanged MockERC20.
  const onyxFactory = new ContractFactory(erc20.abi, erc20.bytecode, signer)
  const onyx = await onyxFactory.deploy(ONYX.name, ONYX.symbol, ONYX.decimals)
  await sent(provider, 'token:ONYX', onyx.deploymentTransaction())
  const onyxAddress = await onyx.getAddress()

  // 2. A second pool from the same permissionless factory. No factory change.
  await sent(provider, 'createPool:JADE/ONYX', await factory.createPool(jadeAddress, onyxAddress, FEE_BASIS_POINTS))
  const jadeOnyxPool = await settled(async () => {
    const address = await factory.getPool(jadeAddress, onyxAddress, FEE_BASIS_POINTS)
    if (address === ZeroAddress) return null
    return (await provider.getCode(address)) === '0x' ? null : address
  }, 'JADE/ONYX pool')
  const pool2 = new Contract(jadeOnyxPool, poolAbi, signer)

  // 3. Seed it.
  await sent(provider, 'mint:ONYX', await onyx.mint(wallet.address, ONYX_MINT))
  await sent(provider, 'approve:JADE->pool2', await jade.approve(jadeOnyxPool, LIQUIDITY_JADE))
  await sent(provider, 'approve:ONYX->pool2', await onyx.approve(jadeOnyxPool, LIQUIDITY_ONYX))
  await settled(async () => (await jade.allowance(wallet.address, jadeOnyxPool)) >= LIQUIDITY_JADE ? true : null, 'JADE allowance')
  await settled(async () => (await onyx.allowance(wallet.address, jadeOnyxPool)) >= LIQUIDITY_ONYX ? true : null, 'ONYX allowance')

  const token0 = await pool2.token0()
  const [amount0, amount1] = token0.toLowerCase() === jadeAddress.toLowerCase()
    ? [LIQUIDITY_JADE, LIQUIDITY_ONYX] : [LIQUIDITY_ONYX, LIQUIDITY_JADE]
  await sent(provider, 'addLiquidity:JADE/ONYX', await pool2.addLiquidity(amount0, amount1, 0, wallet.address, Math.floor(Date.now() / 1000) + 900))

  // 4. One routed trade across both pools: AMBR -> JADE -> ONYX.
  const route = [ambrJadePool, jadeOnyxPool]
  const [quotedOut, quotedTokenOut] = await settled(async () => {
    try {
      const result = await router.quoteExactIn(route, ambrAddress, ROUTE_AMOUNT_IN)
      return result[0] === 0n ? null : result
    } catch { return null }
  }, 'route quote')
  if (quotedTokenOut.toLowerCase() !== onyxAddress.toLowerCase()) throw new Error('ROUTE_OUTPUT_TOKEN_MISMATCH')
  const minAmountOut = quotedOut - (quotedOut * SLIPPAGE_BPS) / 10_000n

  const ambrBefore = await ambr.balanceOf(wallet.address)
  const onyxBefore = await onyx.balanceOf(wallet.address)

  // The router pulls the input itself, so the approval target is the router.
  await sent(provider, 'approve:AMBR->router', await ambr.approve(routerAddress, ROUTE_AMOUNT_IN))
  await settled(async () => (await ambr.allowance(wallet.address, routerAddress)) >= ROUTE_AMOUNT_IN ? true : null, 'router allowance')

  await sent(provider, 'routedTrade:AMBR->JADE->ONYX',
    await router.swapExactIn(route, ambrAddress, ROUTE_AMOUNT_IN, minAmountOut, wallet.address, Math.floor(Date.now() / 1000) + 900))

  const ambrAfter = await settled(async () => {
    const value = await ambr.balanceOf(wallet.address)
    return value === ambrBefore ? null : value
  }, 'AMBR balance')
  const onyxAfter = await onyx.balanceOf(wallet.address)
  const spent = ambrBefore - ambrAfter
  const received = onyxAfter - onyxBefore
  const routerAllowanceAfter = await ambr.allowance(wallet.address, routerAddress)
  const passed = spent === ROUTE_AMOUNT_IN && received === quotedOut && received >= minAmountOut && routerAllowanceAfter === 0n

  console.error(`\nrouted: spent ${formatEther(spent)} AMBR, received ${formatEther(received)} ONYX (quoted ${formatEther(quotedOut)}) -> ${passed ? 'PASS' : 'FAIL'}`)

  const record = {
    schema: 'realdex.multi-token-market-demonstration.v1',
    note: 'Demonstration only. Not part of the v0.1 acceptance and not covered by any P0 row. No pinned v0.1 target changed.',
    chainId: network.chainId.toString(),
    network: 'Base Sepolia (eip155:84532)',
    signer: wallet.address,
    ranAt: new Date().toISOString(),
    unchangedV01Targets: { factory: factoryAddress, router: routerAddress, pool: ambrJadePool, ambr: ambrAddress, jade: jadeAddress },
    added: { onyx: onyxAddress, jadeOnyxPool, liquidity: { jade: LIQUIDITY_JADE.toString(), onyx: LIQUIDITY_ONYX.toString() } },
    route: { pools: route, hops: route.length, tokenIn: ambrAddress, tokenOut: onyxAddress },
    amountIn: ROUTE_AMOUNT_IN.toString(),
    quotedOut: quotedOut.toString(),
    minAmountOut: minAmountOut.toString(),
    measured: { spent: spent.toString(), received: received.toString(), routerAllowanceAfter: routerAllowanceAfter.toString() },
    steps,
    totalFeeWei: steps.reduce((sum, step) => sum + BigInt(step.totalFeeWei), 0n).toString(),
    remainingBalanceWei: (await provider.getBalance(wallet.address)).toString(),
    passed
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `multi-token-market-${network.chainId}.json`)
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify({ added: record.added, route: record.route, quotedOut: record.quotedOut, measured: record.measured, totalFeeWei: record.totalFeeWei, passed }, null, 2))
  console.error(`\nwrote ${outFile}`)
  if (!passed) process.exitCode = 1
}

main().catch(error => { console.error(error.stack ?? error.message ?? error); process.exitCode = 1 })
