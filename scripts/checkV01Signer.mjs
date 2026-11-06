#!/usr/bin/env node
// RealDEX v0.1 signer preflight.
//
// Reads the configured Base Sepolia test-only account from two independent public
// RPC readers and reports the facts required by the approved v0.1 account gate:
// chain identity, absence of contract code (non-delegated EOA), nonce and balance.
//
// Read-only. It sends no transaction, needs no secret and never reads the private
// key. Pass the public address as an argument or set REALDEX_V01_SIGNER_ADDRESS.

const EXPECTED_CHAIN_ID = '0x14a34' // eip155:84532, Base Sepolia

const READERS = [
  { name: 'base-official', url: 'https://sepolia.base.org' },
  { name: 'publicnode', url: 'https://base-sepolia-rpc.publicnode.com' }
]

const address = process.argv[2] ?? process.env.REALDEX_V01_SIGNER_ADDRESS
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) {
  console.error('usage: node scripts/checkV01Signer.mjs <0x address>')
  process.exit(2)
}

async function rpc (url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  if (!response.ok) throw new Error(`${url} ${method}: HTTP ${response.status}`)
  const body = await response.json()
  if (body.error) throw new Error(`${url} ${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

async function read (reader) {
  const chainId = await rpc(reader.url, 'eth_chainId', [])
  const blockNumber = await rpc(reader.url, 'eth_blockNumber', [])
  const block = await rpc(reader.url, 'eth_getBlockByNumber', [blockNumber, false])
  const code = await rpc(reader.url, 'eth_getCode', [address, blockNumber])
  const balanceWei = await rpc(reader.url, 'eth_getBalance', [address, blockNumber])
  const nonce = await rpc(reader.url, 'eth_getTransactionCount', [address, blockNumber])
  return {
    ...reader,
    chainId,
    blockNumber,
    blockHash: block.hash,
    code,
    balanceWei: BigInt(balanceWei).toString(),
    nonce: Number(BigInt(nonce))
  }
}

const readers = []
for (const reader of READERS) readers.push(await read(reader))
const [a, b] = readers

const report = {
  address,
  checkedAt: new Date().toISOString(),
  readers,
  agreement: {
    // Readers observe independent heads; only the account facts must agree.
    chainId: a.chainId === b.chainId && a.chainId === EXPECTED_CHAIN_ID,
    code: a.code === b.code,
    nonce: a.nonce === b.nonce,
    balance: a.balanceWei === b.balanceWei
  },
  nonDelegatedEoa: a.code === '0x' && b.code === '0x',
  fundedForGas: BigInt(a.balanceWei) > 0n
}

console.log(JSON.stringify(report, null, 2))

// Point-in-time observation only. It proves neither key possession nor that the
// account stays non-delegated later; re-run immediately before any public step.
process.exit(report.agreement.chainId && report.agreement.code && report.nonDelegatedEoa ? 0 : 1)
