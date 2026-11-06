#!/usr/bin/env node
// Builds the reviewed v0.1 profile and its pin from the recorded public
// deployment, then prints the literal to paste into src/v01/reviewed-profile.ts.
//
// It reads only observed evidence: the deployment record written by the actual
// run, the pinned code identities, and the release plan. It invents no address.
// The fingerprint is recomputed by the application's own code in
// src/release/v01-reviewed-profile.test.ts, so a mistake here fails that test
// rather than shipping a profile the runtime would reject.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress, keccak256, toUtf8Bytes } from 'ethers'
import { createEvmTestnetReleasePlan } from './createEvmTestnetReleasePlan.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const CHAIN_ID = flag('--chain-id', '84532')
const OUT_DIR = path.resolve(root, flag('--out', 'artifacts-v01'))

// Mirrors src/security/cryptographic-fingerprint.ts. The test cross-checks it.
function canonicalValue (value) {
  if (value === null) return ['null']
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('FINGERPRINT_NUMBER_INVALID')
    return ['number', value.toString()]
  }
  if (typeof value === 'bigint') return ['bigint', value.toString()]
  if (Array.isArray(value)) return ['array', value.map(canonicalValue)]
  if (typeof value !== 'object') throw new Error('FINGERPRINT_VALUE_INVALID')
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  return ['object', entries.map(([key, entry]) => [key, canonicalValue(entry)])]
}
function cryptographicFingerprint (domain, value) {
  return keccak256(toUtf8Bytes(`RealDEX cryptographic fingerprint v1\n${domain}\n${JSON.stringify(canonicalValue(value))}`))
}

// Older records carry `deployedAt`; current ones carry `recordedAt`. Reading only
// one of them silently produced NaN, which the fingerprint then refused with a
// message that named neither the field nor the file.
function recordedAt (record) {
  const raw = record.recordedAt ?? record.deployedAt
  const parsed = Date.parse(raw ?? '')
  if (!Number.isSafeInteger(parsed)) throw new Error('DEPLOYMENT_RECORD_TIMESTAMP_INVALID: no usable recordedAt or deployedAt')
  return parsed
}

const deployment = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `deployment-${CHAIN_ID}.json`), 'utf8'))
const codeIdentities = JSON.parse(fs.readFileSync(path.resolve(root, 'src/swap/local-amm-code-identities.json'), 'utf8'))
const plan = await createEvmTestnetReleasePlan()

// Observed runtime must equal the pinned identities, or the runtime rejects it.
if (deployment.runtimeCodeHashes.factory !== codeIdentities.factoryRuntimeCodeHash) throw new Error('FACTORY_CODE_IDENTITY_MISMATCH')
if (deployment.runtimeCodeHashes.router !== codeIdentities.routerRuntimeCodeHash) throw new Error('ROUTER_CODE_IDENTITY_MISMATCH')
if (deployment.runtimeCodeHashes.ambr !== codeIdentities.mockErc20Decimals18RuntimeCodeHash) throw new Error('AMBR_CODE_IDENTITY_MISMATCH')
if (deployment.runtimeCodeHashes.jade !== codeIdentities.mockErc20Decimals18RuntimeCodeHash) throw new Error('JADE_CODE_IDENTITY_MISMATCH')

const explorer = address => `https://sepolia.basescan.org/address/${address}`
const profile = {
  schema: 'realdex.v01-profile.v1',
  deployment: {
    schema: 'realdex.evm-public-testnet-deployment.v1',
    releaseId: plan.releaseId,
    environment: 'public-testnet',
    network: { caip2: 'eip155:84532', name: 'Base Sepolia' },
    source: {
      bundleSha256: plan.source.bundleSha256,
      solidity: codeIdentities.solidity,
      optimizerRuns: codeIdentities.optimizerRuns,
      factoryRuntimeCodeHash: codeIdentities.factoryRuntimeCodeHash,
      routerRuntimeCodeHash: codeIdentities.routerRuntimeCodeHash
    },
    deployer: getAddress(deployment.deployer),
    contracts: {
      factory: {
        address: getAddress(deployment.contracts.factory.address),
        deploymentTxHash: deployment.contracts.factory.deploymentTxHash,
        blockNumber: deployment.contracts.factory.blockNumber,
        runtimeCodeHash: deployment.contracts.factory.runtimeCodeHash
      },
      router: {
        address: getAddress(deployment.contracts.router.address),
        deploymentTxHash: deployment.contracts.router.deploymentTxHash,
        blockNumber: deployment.contracts.router.blockNumber,
        runtimeCodeHash: deployment.contracts.router.runtimeCodeHash
      }
    },
    createdAt: recordedAt(deployment),
    evidenceUrls: [
      explorer(getAddress(deployment.addresses.factory)),
      explorer(getAddress(deployment.addresses.router)),
      explorer(getAddress(deployment.addresses.pool))
    ]
  },
  pool: {
    address: getAddress(deployment.addresses.pool),
    runtimeCodeHash: deployment.runtimeCodeHashes.pool,
    feeBasisPoints: deployment.pool.feeBasisPoints
  },
  tokens: { ambr: getAddress(deployment.addresses.ambr), jade: getAddress(deployment.addresses.jade) }
}

const pin = {
  releaseId: profile.deployment.releaseId,
  bundleSha256: profile.deployment.source.bundleSha256,
  profileFingerprint: cryptographicFingerprint('realdex.v01-profile.v1', profile)
}

// Writing over the previous profile erased the retired release's record, leaving it
// only in git history. An evidence artifact has to stay readable beside the current
// one, so the outgoing profile is copied out byte for byte under its own release id
// before anything is overwritten. Copied, not re-serialised: a reformatted archive is
// no longer the bytes that were reviewed.
const profilePath = path.join(OUT_DIR, `reviewed-profile-${CHAIN_ID}.json`)
if (fs.existsSync(profilePath)) {
  const previous = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
  const previousReleaseId = previous?.pin?.releaseId ?? previous?.profile?.deployment?.releaseId
  if (typeof previousReleaseId !== 'string' || previousReleaseId.length === 0) throw new Error('PREVIOUS_PROFILE_RELEASE_ID_MISSING')
  if (previousReleaseId !== profile.deployment.releaseId) {
    const archivePath = path.join(OUT_DIR, `reviewed-profile-${CHAIN_ID}-retired-${previousReleaseId.replace(/^base-sepolia-/, '')}.json`)
    if (!fs.existsSync(archivePath)) fs.copyFileSync(profilePath, archivePath)
    console.error('retired ' + previousReleaseId + ' to ' + path.basename(archivePath))
  }
}
fs.writeFileSync(profilePath, JSON.stringify({ profile, pin }, null, 2) + '\n')
console.log(JSON.stringify({ profile, pin }, null, 2))

// Write src/v01/reviewed-profile.ts directly from the values above. Copying
// thirty-two-byte hashes by hand is how a wrong digest gets committed, so this
// removes the transcription step rather than relying on care.
if (args.includes('--write-source')) {
  const literal = JSON.stringify({ profile, pin }, null, 2).replace(/\n/g, '\n  ')
  const body = [
    'import type { V01Profile, V01ProfilePin } from "../release/v01-profile";',
    '',
    'export type ReviewedV01Configuration = { profile: V01Profile; pin: V01ProfilePin };',
    '',
    '// Set only from separately approved deployment evidence, never localStorage or a URL.',
    '// A development fixture must not be committed as a public-network configuration.',
    '//',
    '// Generated by: node scripts/createV01Profile.mjs --write-source',
    '// Source: artifacts-v01/deployment-' + CHAIN_ID + '.json, every value read back from',
    '// the public chain. Do not edit by hand — regenerate, so nothing is ever retyped.',
    '// The pin is cross-checked against the application\'s own fingerprint in',
    '// ../release/v01-reviewed-profile.test.ts.',
    'export const REVIEWED_V01_CONFIGURATION: ReviewedV01Configuration | null = ' + literal + ';',
    ''
  ].join('\n')
  const sourcePath = path.resolve(root, 'src/v01/reviewed-profile.ts')
  fs.writeFileSync(sourcePath, body)
  console.error('wrote ' + sourcePath)
}
