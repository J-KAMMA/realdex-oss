#!/usr/bin/env node
// Freezes the identity of the release being reproduced: the toolchain, the
// dependency lock, every pinned release source file, and the resulting bundle
// digest. Running it in two trees and comparing the output is what makes a
// clean-room reproduction a reproduction rather than a second, similar build.
//
// Read-only. It runs no install, build or test; it only hashes what is there.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvmTestnetReleasePlan, RELEASE_SOURCE_PATHS } from './createEvmTestnetReleasePlan.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = buffer => `sha256:${createHash('sha256').update(buffer).digest('hex')}`

const plan = await createEvmTestnetReleasePlan()
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const sources = {}
for (const relative of RELEASE_SOURCE_PATHS) {
  // Hash the bytes on disk, not a normalized read, so a line-ending change shows.
  sources[relative] = sha256(fs.readFileSync(path.join(root, relative)))
}

const identity = {
  schema: 'realdex.v01-release-identity.v1',
  tree: root,
  capturedAt: new Date().toISOString(),
  toolchain: {
    node: process.version,
    declaredNode: packageJson.engines?.node ?? null,
    declaredPackageManager: packageJson.packageManager ?? null,
    nodeVersionFile: fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim()
  },
  lockfileSha256: sha256(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'))),
  releaseId: plan.releaseId,
  bundleSha256: plan.source.bundleSha256,
  sourceFileCount: RELEASE_SOURCE_PATHS.length,
  sources
}

console.log(JSON.stringify(identity, null, 2))
