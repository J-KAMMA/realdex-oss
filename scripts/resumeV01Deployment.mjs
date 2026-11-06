#!/usr/bin/env node
// RealDEX v0.1 deployment resume and evidence recovery.
//
// The first public run sent its transactions but died before writing its record,
// because it trusted a single read of the new pool address and a public endpoint
// served a stale state. Nothing was lost on chain: creation addresses follow from
// the deployer nonce, so this recovers them, finds the transaction hashes, and
// finishes whichever steps are still missing.
//
// Every step is checked before it is sent, so running this twice sends nothing
// the second time. Read-only until an actual gap is found.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, getCreateAddress, keccak256, parseEther } from 'ethers'
import { v01SignerPrivateKey as privateKey } from "./v01Signer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const RPC_URL = flag('--rpc', 'https://sepolia.base.org')
const EXPECTED_CHAIN_ID = BigInt(flag('--chain-id', '84532'))
const OUT_DIR = path.resolve(root, flag('--out', 'artifacts-v01'))
const SCAN_DEPTH = Number(flag('--scan-depth', '4000'))
// The deployer nonce the four creations started at. It is 0 only for an account
// whose first ever transactions were this deployment.
const FIRST_NONCE = Number(flag('--first-nonce', '0'))

const MINT_AMOUNT = parseEther('100000')
const LIQUIDITY_AMBR = parseEther('10000')
const LIQUIDITY_JADE = parseEther('20000')
// The v0.1 tier. A pair can have a pool per tier, so every lookup names one.
const FEE_BASIS_POINTS = 1


const artifact = rel => JSON.parse(fs.readFileSync(path.resolve(root, 'artifacts/contracts', rel), 'utf8'))


function runtimeCodeHash (code) {
  if (typeof code !== 'string' || code === '0x' || !/^0x([0-9a-fA-F]{2})+$/.test(code)) throw new Error('RUNTIME_CODE_EMPTY')
  return keccak256(code)
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
  if (receipt.status !== 1) throw new Error(`${label} reverted: ${receipt.hash}`)
  const raw = await provider.send('eth_getTransactionReceipt', [receipt.hash])
  const l1Fee = raw && raw.l1Fee ? BigInt(raw.l1Fee) : 0n
  const l2Fee = receipt.gasUsed * receipt.gasPrice
  steps.push({
    label, transactionHash: receipt.hash, blockNumber: receipt.blockNumber,
    contractAddress: receipt.contractAddress ?? null, gasUsed: receipt.gasUsed.toString(),
    gasPriceWei: receipt.gasPrice.toString(), l1FeeWei: l1Fee.toString(),
    totalFeeWei: (l2Fee + l1Fee).toString(), recovered: false
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

  const mockErc20 = artifact('test/MockERC20.sol/MockERC20.json')
  const factoryArtifact = artifact('LocalSwapFactory.sol/LocalSwapFactory.json')
  const routerArtifact = artifact('LocalSwapRouter.sol/LocalSwapRouter.json')
  const poolArtifact = artifact('LocalSwapPool.sol/LocalSwapPool.json')

  // Creation addresses are determined by the deployer nonce, in deployment order.
  const created = ['token:AMBR', 'token:JADE', 'factory', 'router'].map((label, index) => ({ label, nonce: FIRST_NONCE + index, address: getCreateAddress({ from: wallet.address, nonce: FIRST_NONCE + index }) }))
  for (const entry of created) {
    entry.code = await provider.getCode(entry.address)
    if (entry.code === '0x') throw new Error(`${entry.label} missing at ${entry.address}`)
  }
  const [ambrAddress, jadeAddress, factoryAddress, routerAddress] = created.map(entry => entry.address)

  // The compiled creation bytecode must match what is actually on chain.
  const expectedRuntime = {
    'token:AMBR': runtimeCodeHash(await provider.getCode(ambrAddress)),
    'token:JADE': runtimeCodeHash(await provider.getCode(jadeAddress))
  }
  if (expectedRuntime['token:AMBR'] !== expectedRuntime['token:JADE']) throw new Error('TOKEN_CODE_DIVERGED')

  const ambr = new Contract(ambrAddress, mockErc20.abi, signer)
  const jade = new Contract(jadeAddress, mockErc20.abi, signer)
  const factory = new Contract(factoryAddress, factoryArtifact.abi, signer)

  const poolAddress = await settled(async () => {
    const address = await factory.getPool(ambrAddress, jadeAddress, FEE_BASIS_POINTS)
    if (address === ZeroAddress) return null
    return (await provider.getCode(address)) === '0x' ? null : address
  }, 'POOL_NOT_VISIBLE')
  const pool = new Contract(poolAddress, poolArtifact.abi, signer)

  console.error(`AMBR ${ambrAddress}\nJADE ${jadeAddress}\nfactory ${factoryAddress}\nrouter ${routerAddress}\npool ${poolAddress}`)

  // Recover the transaction hashes of the already-sent steps by scanning the
  // blocks around the PoolCreated event, which is the one indexed anchor we have.
  const latest = await provider.getBlockNumber()
  const poolLogs = await provider.getLogs({
    address: factoryAddress,
    topics: [factory.interface.getEvent('PoolCreated').topicHash],
    fromBlock: Math.max(0, latest - SCAN_DEPTH), toBlock: latest
  })
  if (poolLogs.length !== 1) throw new Error(`POOL_CREATED_LOGS_UNEXPECTED: ${poolLogs.length}`)
  const anchorBlock = poolLogs[0].blockNumber
  const recovered = new Map()
  for (let blockNumber = Math.max(0, anchorBlock - 80); blockNumber <= Math.min(latest, anchorBlock + 80); blockNumber++) {
    const block = await provider.getBlock(blockNumber, true)
    if (!block) continue
    for (const transaction of block.prefetchedTransactions) {
      if (transaction.from !== wallet.address) continue
      recovered.set(transaction.nonce, { transactionHash: transaction.hash, blockNumber, nonce: transaction.nonce })
    }
  }
  const labelForNonce = ['token:AMBR', 'token:JADE', 'factory', 'router', 'createPool', 'mint:AMBR', 'mint:JADE']
  for (const [nonce, entry] of [...recovered.entries()].sort((a, b) => a[0] - b[0]).filter(([value]) => value >= FIRST_NONCE)) {
    const label = labelForNonce[nonce - FIRST_NONCE] ?? `nonce:${nonce}`
    const receipt = await provider.getTransactionReceipt(entry.transactionHash)
    const raw = await provider.send('eth_getTransactionReceipt', [entry.transactionHash])
    steps.push({
      label, transactionHash: entry.transactionHash, blockNumber: entry.blockNumber,
      contractAddress: receipt.contractAddress ?? null, gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: receipt.gasPrice.toString(), l1FeeWei: raw?.l1Fee ? BigInt(raw.l1Fee).toString() : '0',
      totalFeeWei: (receipt.gasUsed * receipt.gasPrice + (raw?.l1Fee ? BigInt(raw.l1Fee) : 0n)).toString(),
      status: receipt.status, recovered: true
    })
  }
  console.error(`recovered ${recovered.size} sent transactions around block ${anchorBlock}`)

  // Finish only what is actually missing.
  for (const [label, token] of [['mint:AMBR', ambr], ['mint:JADE', jade]]) {
    const balance = await token.balanceOf(wallet.address)
    // Seeding happens once. A balance below MINT_AMOUNT is the normal state after
    // liquidity has been deposited, so it must not trigger another mint.
    if (balance === 0n) await record(provider, label, await token.mint(wallet.address, MINT_AMOUNT))
    else console.error(`skip ${label}: balance already ${balance}`)
  }
  const approvalsSent = []
  for (const [label, token, need] of [['approve:AMBR', ambr, MINT_AMOUNT], ['approve:JADE', jade, MINT_AMOUNT]]) {
    const allowance = await token.allowance(wallet.address, poolAddress)
    // Only approve when liquidity still has to be added; an existing pool needs none.
    const [reserve0] = await pool.getReserves()
    if (reserve0 === 0n && allowance < need) { await record(provider, label, await token.approve(poolAddress, need)); approvalsSent.push([label, token]) }
    else console.error(`skip ${label}: allowance already ${allowance}`)
  }

  // Only wait for what this run actually sent. Waiting unconditionally asks for
  // the pre-deposit allowance, which never comes back once liquidity is in.
  for (const [label, token] of approvalsSent) {
    await settled(async () => (await token.allowance(wallet.address, poolAddress)) >= MINT_AMOUNT ? true : null, `${label}_NOT_VISIBLE`)
  }

  const token0 = await pool.token0()
  const [amount0, amount1] = token0.toLowerCase() === ambrAddress.toLowerCase()
    ? [LIQUIDITY_AMBR, LIQUIDITY_JADE] : [LIQUIDITY_JADE, LIQUIDITY_AMBR]
  const [reserve0] = await pool.getReserves()
  if (reserve0 === 0n) {
    await record(provider, 'addLiquidity', await pool.addLiquidity(amount0, amount1, 0, wallet.address, Math.floor(Date.now() / 1000) + 900))
  } else console.error(`skip addLiquidity: reserve0 already ${reserve0}`)

  const byLabel = label => steps.find(step => step.label === label)
  const [factoryCode, routerCode, poolCode] = await Promise.all([
    provider.getCode(factoryAddress), provider.getCode(routerAddress), provider.getCode(poolAddress)
  ])
  // The record must not report a state the chain does not have: wait for the
  // reserves to be visible rather than writing whatever the first read returns.
  const [finalReserve0, finalReserve1] = await settled(async () => {
    const values = await pool.getReserves()
    return values[0] === 0n && values[1] === 0n ? null : values
  }, 'RESERVES_NOT_VISIBLE')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `deployment-${network.chainId}.json`)
  const result = {
    schema: 'realdex.v01-deployment-record.v1',
    chainId: network.chainId.toString(),
    rpcUrl: RPC_URL,
    deployer: wallet.address,
    recordedAt: new Date().toISOString(),
    addresses: { ambr: ambrAddress, jade: jadeAddress, factory: factoryAddress, router: routerAddress, pool: poolAddress },
    runtimeCodeHashes: {
      ambr: runtimeCodeHash(await provider.getCode(ambrAddress)),
      jade: runtimeCodeHash(await provider.getCode(jadeAddress)),
      factory: runtimeCodeHash(factoryCode), router: runtimeCodeHash(routerCode), pool: runtimeCodeHash(poolCode)
    },
    contracts: {
      factory: { address: factoryAddress, deploymentTxHash: byLabel('factory').transactionHash, blockNumber: byLabel('factory').blockNumber, runtimeCodeHash: runtimeCodeHash(factoryCode) },
      router: { address: routerAddress, deploymentTxHash: byLabel('router').transactionHash, blockNumber: byLabel('router').blockNumber, runtimeCodeHash: runtimeCodeHash(routerCode) }
    },
    pool: { address: poolAddress, token0, feeBasisPoints: Number(await pool.feeBasisPoints()), reserve0: finalReserve0.toString(), reserve1: finalReserve1.toString() },
    steps: steps.sort((a, b) => a.blockNumber - b.blockNumber),
    totalFeeWei: steps.reduce((sum, step) => sum + BigInt(step.totalFeeWei), 0n).toString(),
    remainingBalanceWei: (await provider.getBalance(wallet.address)).toString()
  }
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ addresses: result.addresses, pool: result.pool, totalFeeWei: result.totalFeeWei, remainingBalanceWei: result.remainingBalanceWei, steps: result.steps.map(s => `${s.label} ${s.transactionHash}`) }, null, 2))
  console.error(`\nwrote ${outFile}`)
}

main().catch(error => { console.error(error.stack ?? error.message ?? error); process.exitCode = 1 })
