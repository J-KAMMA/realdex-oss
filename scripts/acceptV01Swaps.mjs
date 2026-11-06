#!/usr/bin/env node
// RealDEX v0.1 public acceptance: one exact-input swap in each direction.
//
// This is the P0-07 evidence run. For each direction it records the balances
// before, the quote it acted on, the exact approval it needed, the swap, and the
// measured balance difference afterwards. A direction only passes when the
// observed difference equals the quoted output; a receipt alone is not a pass.
//
// Approval and swap stay separate steps, and an allowance that already covers
// the input is not re-approved, so the two directions exercise both cases.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, JsonRpcProvider, NonceManager, Wallet, parseEther, formatEther } from 'ethers'
import { v01SignerPrivateKey as privateKey } from "./v01Signer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const RPC_URL = flag('--rpc', 'https://sepolia.base.org')
const EXPECTED_CHAIN_ID = BigInt(flag('--chain-id', '84532'))
const OUT_DIR = path.resolve(root, flag('--out', 'artifacts-v01'))
const AMOUNT_IN = parseEther(flag('--amount', '100'))
const SLIPPAGE_BPS = BigInt(flag('--slippage-bps', '50')) // 0.50%
// P0-06 asks for both allowance cases. With this flag each direction starts from
// a zero allowance, so the exact approval and the swap are two observable sends.
const RESET_ALLOWANCE = args.includes('--reset-allowance')
const RECORD_NAME = flag('--record-name', 'public-acceptance')

const artifact = rel => JSON.parse(fs.readFileSync(path.resolve(root, 'artifacts/contracts', rel), 'utf8'))


// A public endpoint can serve a stale state right after a receipt.
async function settled (read, label, attempts = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const value = await read()
    if (value !== null && value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  throw new Error(`${label}: not visible after ${attempts} reads`)
}

async function sent (provider, label, response) {
  const receipt = await response.wait()
  if (receipt.status !== 1) throw new Error(`${label} reverted: ${receipt.hash}`)
  const raw = await provider.send('eth_getTransactionReceipt', [receipt.hash])
  const l1Fee = raw && raw.l1Fee ? BigInt(raw.l1Fee) : 0n
  console.error(`sent ${label} ${receipt.hash}`)
  return {
    label, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status,
    gasUsed: receipt.gasUsed.toString(), gasPriceWei: receipt.gasPrice.toString(),
    l1FeeWei: l1Fee.toString(), totalFeeWei: (receipt.gasUsed * receipt.gasPrice + l1Fee).toString()
  }
}

async function main () {
  const provider = new JsonRpcProvider(RPC_URL)
  const wallet = new Wallet(privateKey(), provider)
  const signer = new NonceManager(wallet)

  const network = await provider.getNetwork()
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`CHAIN_MISMATCH: ${network.chainId}`)

  const deployment = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `deployment-${network.chainId}.json`), 'utf8'))
  const { ambr: ambrAddress, jade: jadeAddress, pool: poolAddress } = deployment.addresses
  const erc20 = artifact('test/MockERC20.sol/MockERC20.json').abi
  const pool = new Contract(poolAddress, artifact('LocalSwapPool.sol/LocalSwapPool.json').abi, signer)
  const tokens = {
    AMBR: new Contract(ambrAddress, erc20, signer),
    JADE: new Contract(jadeAddress, erc20, signer)
  }

  const directions = [
    { from: 'AMBR', to: 'JADE', tokenIn: ambrAddress, tokenOut: jadeAddress },
    { from: 'JADE', to: 'AMBR', tokenIn: jadeAddress, tokenOut: ambrAddress }
  ]

  const results = []
  for (const direction of directions) {
    const tokenIn = tokens[direction.from]
    const tokenOut = tokens[direction.to]
    const label = `${direction.from}->${direction.to}`

    const steps = []
    if (RESET_ALLOWANCE) {
      const current = await tokenIn.allowance(wallet.address, poolAddress)
      if (current !== 0n) {
        steps.push(await sent(provider, `${label} revoke`, await tokenIn.approve(poolAddress, 0n)))
        await settled(async () => (await tokenIn.allowance(wallet.address, poolAddress)) === 0n ? true : null, `${label} revoked allowance`)
      }
    }

    const balanceInBefore = await tokenIn.balanceOf(wallet.address)
    const balanceOutBefore = await tokenOut.balanceOf(wallet.address)
    if (balanceInBefore < AMOUNT_IN) throw new Error(`${label}: input balance ${balanceInBefore} below ${AMOUNT_IN}`)

    // Quote first, then bind the minimum received to that quote.
    const quoted = await pool.quoteExactIn(direction.tokenIn, AMOUNT_IN)
    const minAmountOut = quoted - (quoted * SLIPPAGE_BPS) / 10_000n
    const [reserve0Before, reserve1Before] = await pool.getReserves()

    const allowanceBefore = await tokenIn.allowance(wallet.address, poolAddress)
    if (allowanceBefore < AMOUNT_IN) {
      steps.push(await sent(provider, `${label} approve`, await tokenIn.approve(poolAddress, AMOUNT_IN)))
      await settled(async () => (await tokenIn.allowance(wallet.address, poolAddress)) >= AMOUNT_IN ? true : null, `${label} allowance`)
    } else {
      console.error(`${label}: allowance already ${formatEther(allowanceBefore)}, no approval sent`)
    }

    const deadline = Math.floor(Date.now() / 1000) + 900
    steps.push(await sent(provider, `${label} swap`, await pool.swapExactIn(direction.tokenIn, AMOUNT_IN, minAmountOut, wallet.address, deadline)))

    // The pass condition is the measured difference, not the receipt.
    const balanceInAfter = await settled(async () => {
      const value = await tokenIn.balanceOf(wallet.address)
      return value === balanceInBefore ? null : value
    }, `${label} input balance`)
    const balanceOutAfter = await tokenOut.balanceOf(wallet.address)
    const spent = balanceInBefore - balanceInAfter
    const received = balanceOutAfter - balanceOutBefore
    const [reserve0After, reserve1After] = await pool.getReserves()

    // An exact approval must be fully consumed by the one swap it authorized.
    const allowanceAfter = await tokenIn.allowance(wallet.address, poolAddress)
    const exactApprovalConsumed = allowanceBefore >= AMOUNT_IN ? null : allowanceAfter === 0n
    // `--reset-allowance` is how P0-06 is taken, and that row is entirely about
    // starting at zero, approving exactly this trade, and ending at zero again.
    // Without this, a standing allowance makes `exactApprovalConsumed` null, and
    // `null !== false` let the run pass while never testing the property it exists
    // to test. The flag now means what it says: no standing allowance, and the
    // approval fully consumed.
    if (RESET_ALLOWANCE) {
      if (allowanceBefore !== 0n) throw new Error(`${label}: --reset-allowance was given but the allowance started at ${formatEther(allowanceBefore)}`)
      if (exactApprovalConsumed !== true) throw new Error(`${label}: the exact approval was not consumed; ${formatEther(allowanceAfter)} still stands`)
    }
    const passed = spent === AMOUNT_IN && received === quoted && received >= minAmountOut && exactApprovalConsumed !== false
    results.push({
      direction: label, tokenIn: direction.tokenIn, tokenOut: direction.tokenOut,
      amountIn: AMOUNT_IN.toString(), quotedOut: quoted.toString(), minAmountOut: minAmountOut.toString(),
      slippageBps: Number(SLIPPAGE_BPS), deadline,
      allowanceBefore: allowanceBefore.toString(), allowanceAfter: allowanceAfter.toString(),
      approvalSent: allowanceBefore < AMOUNT_IN, exactApprovalConsumed,
      balances: {
        inBefore: balanceInBefore.toString(), inAfter: balanceInAfter.toString(),
        outBefore: balanceOutBefore.toString(), outAfter: balanceOutAfter.toString(),
        spent: spent.toString(), received: received.toString()
      },
      reserves: {
        before: [reserve0Before.toString(), reserve1Before.toString()],
        after: [reserve0After.toString(), reserve1After.toString()]
      },
      steps, passed
    })
    console.error(`${label}: spent ${formatEther(spent)} ${direction.from}, received ${formatEther(received)} ${direction.to}, quoted ${formatEther(quoted)} -> ${passed ? 'PASS' : 'FAIL'}`)
    if (!passed) throw new Error(`${label}: measured difference does not match the quote`)
  }

  const record = {
    schema: 'realdex.v01-public-acceptance.v1',
    requirement: RESET_ALLOWANCE ? 'P0-06 (zero allowance, exact approval, separate swap)' : 'P0-07',
    chainId: network.chainId.toString(),
    network: 'Base Sepolia (eip155:84532)',
    rpcUrl: RPC_URL,
    signer: wallet.address,
    signerMode: 'programmatic test-only EOA (V01_SCOPE 2026-09-03 split); not the MetaMask extension',
    pool: poolAddress,
    tokens: { ambr: ambrAddress, jade: jadeAddress },
    ranAt: new Date().toISOString(),
    directions: results,
    totalFeeWei: results.flatMap(r => r.steps).reduce((sum, step) => sum + BigInt(step.totalFeeWei), 0n).toString(),
    remainingBalanceWei: (await provider.getBalance(wallet.address)).toString(),
    passed: results.every(result => result.passed)
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `${RECORD_NAME}-${network.chainId}.json`)
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify(record, null, 2))
  console.error(`\nwrote ${outFile}`)
}

main().catch(error => { console.error(error.stack ?? error.message ?? error); process.exitCode = 1 })
