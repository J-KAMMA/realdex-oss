import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pinnedPnpmStatus} from '../lib/root-package-manager.mjs';

function fixture(t, version = '11.25.0', body = "console.log('11.25.0');") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex-pnpm-status-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'pnpm', version}));
  const cli = path.join(root, 'bin/pnpm.cjs');
  fs.writeFileSync(cli, body);
  return cli;
}

test('pnpm status requires an explicit absolute CLI and exact version pin', () => {
  assert.equal(pinnedPnpmStatus(undefined, '11.25.0').reason, 'PINNED_PNPM_CLI_NOT_CONFIGURED');
  assert.equal(pinnedPnpmStatus('pnpm', '11.25.0').available, false);
});
test('pnpm status records both package identity and the executed version', t => {
  const result = pinnedPnpmStatus(fixture(t), '11.25.0');
  assert.equal(result.available, true);
  assert.equal(result.version, '11.25.0');
  assert.match(result.cliSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.autoInstallPerformed, false);
});
test('an old pnpm package is rejected before its entrypoint runs', t => {
  const cli = fixture(t, '11.19.0', "throw Error('must not run');");
  assert.equal(pinnedPnpmStatus(cli, '11.25.0').reason, 'PNPM_PACKAGE_VERSION_MISMATCH');
});
test('matching package metadata cannot hide a different executed version', t => {
  assert.equal(pinnedPnpmStatus(fixture(t, '11.25.0', "console.log('11.19.0');"), '11.25.0').reason, 'PNPM_EXECUTED_VERSION_MISMATCH');
});
test('failed pnpm process cannot supply valid version evidence', t => {
  assert.equal(pinnedPnpmStatus(fixture(t, '11.25.0', "console.log('11.25.0');process.exitCode=1;"), '11.25.0').reason, 'PNPM_VERSION_PROCESS_FAILED');
});
test('pnpm version probe does not inherit Node options or arbitrary environment', t => {
  const cli = fixture(t, '11.25.0', "if(process.env.NODE_OPTIONS||process.env.REALDEX_TEST_PRIVATE)process.exit(1);console.log('11.25.0');");
  const result = pinnedPnpmStatus(cli, '11.25.0', {...process.env, NODE_OPTIONS: '--definitely-not-a-node-option', REALDEX_TEST_PRIVATE: 'fixture-only'});
  assert.equal(result.available, true);
});
