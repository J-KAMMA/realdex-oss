import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runProcess, testEnvironment} from '../../app/lib/parallel-process.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CHECKER = path.join(ROOT, 'integration/protected/migration-cli-check.py');
const SCHEMA = 'realdex.up03-migration-cli.v1';
const CHECK_NAMES = [
  'fresh-owner-only-fixtures',
  'test-launch-watch-only-source',
  'test-launch-current-backup-verified',
  'production-target-json-status',
  'production-export-pty-hidden-password',
  'production-export-status-source-frozen',
  'source-normal-open-rejected-while-pending',
  'production-import-pty-hidden-password',
  'production-import-status-target-id',
  'receipt-generation-one',
  'production-finalize-status-source-retired',
  'destination-normal-open-preserves-watch-account',
  'destination-provenance-binds-source-and-target',
];

test('UP03 production migration CLI smoke checker is strict and bounded', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex-up03-cli-wrapper-'));
  const log = path.join(parent, 'checker.log');
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
  const result = await runProcess({
    command: 'python3',
    args: ['-I', '-S', CHECKER],
    cwd: ROOT,
    log,
    timeoutMs: 30000,
    env: testEnvironment(),
  });
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);
  const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.deepEqual(summary.schema, SCHEMA);
  assert.equal(summary.status, 'passed');
  assert.equal(summary.passed, true);
  assert.deepEqual(summary.checks.map(item => item.name), CHECK_NAMES);
  assert.equal(summary.checks.every(item => item.passed === true), true);
  assert.equal(summary.networkUsed, false);
  assert.equal(summary.userFunds, false);
  assert.equal(summary.publicTestnet, false);
  assert.equal(summary.browserTested, false);
  assert.equal(summary.signerUsed, false);
  assert.equal(summary.productionReady, false);
  assert.equal(summary.timeoutMs, 30000);
});
