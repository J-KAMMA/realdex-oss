import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MIGRATION_CASES} from '../../integration/protected/migration-cases.mjs';
import {runMigrationCases, validateMigrationCaseResult} from '../../integration/protected/migration-run.mjs';

const tap = name => `TAP version 13\n# Subtest: ${name}\n    ok 1 - ${name}\nok 1 - ${name}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
const processPass = {status: 0, signal: null, error: null};
const processFail = {status: 1, signal: null, error: null};
const dir = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex-up03-runner-unit-')); t.after(() => fs.rmSync(p, {recursive: true, force: true})); return path.join(p, 'run'); };

test('UP03 validator rejects missing TAP result', () => {
  const result = validateMigrationCaseResult(MIGRATION_CASES[0], processPass, '');
  assert.equal(result.status, 'failed');
  assert.equal(result.classification, 'incomplete');
});

test('UP03 validator rejects duplicate TAP subtest names', () => {
  const name = MIGRATION_CASES[0].name;
  const result = validateMigrationCaseResult(MIGRATION_CASES[0], processPass, tap(name) + tap(name));
  assert.equal(result.status, 'failed');
  assert.equal(result.classification, 'incomplete');
});

test('UP03 validator rejects a wrong TAP test name', () => {
  const result = validateMigrationCaseResult(MIGRATION_CASES[0], processPass, tap('wrong name'));
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'UP03_TAP_NAME_MISMATCH');
});

test('UP03 validator rejects a contradictory top-level outcome with forged passing counts', () => {
  const name = MIGRATION_CASES[0].name;
  const forged = tap(name).replace(`\nok 1 - ${name}\n1..1`, `\nnot ok 1 - ${name}\n1..1`);
  const result = validateMigrationCaseResult(MIGRATION_CASES[0], processPass, forged);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'UP03_TAP_OUTCOME_MISMATCH');
});

test('UP03 validator rejects zero or skipped TAP', () => {
  const name = MIGRATION_CASES[0].name;
  const zero = tap(name).replaceAll('# tests 1', '# tests 0').replaceAll('# pass 1', '# pass 0');
  const two = tap(name).replaceAll('# tests 1', '# tests 2').replaceAll('# pass 1', '# pass 2');
  const skipped = tap(name).replace('# skipped 0', '# skipped 1');
  assert.equal(validateMigrationCaseResult(MIGRATION_CASES[0], processPass, zero).status, 'failed');
  assert.equal(validateMigrationCaseResult(MIGRATION_CASES[0], processPass, two).status, 'failed');
  assert.equal(validateMigrationCaseResult(MIGRATION_CASES[0], processPass, skipped).status, 'failed');
});

test('UP03 validator keeps a nonzero child failure distinct from incomplete TAP', () => {
  const result = validateMigrationCaseResult(MIGRATION_CASES[0], processFail, tap(MIGRATION_CASES[0].name));
  assert.equal(result.status, 'failed');
  assert.equal(result.classification, 'failed');
});

test('UP03 runner accepts only the canonical registry IDs, names, and ordering', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex-up03-registry-unit-'));
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
  await assert.rejects(
    runMigrationCases({output: path.join(parent, 'shortened'), cases: MIGRATION_CASES.slice(0, -1)}),
    /UP03_CASE_REGISTRY_INVALID/,
  );
  const reordered = [...MIGRATION_CASES];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await assert.rejects(
    runMigrationCases({output: path.join(parent, 'reordered'), cases: reordered}),
    /UP03_CASE_REGISTRY_MISMATCH/,
  );
  const replaced = [...MIGRATION_CASES];
  replaced[0] = {id: 'UP03-M01', name: 'replacement'};
  await assert.rejects(
    runMigrationCases({output: path.join(parent, 'replaced'), cases: replaced}),
    /UP03_CASE_REGISTRY_MISMATCH/,
  );
});

test('UP03 runner invokes cases once and preserves registry ordering', async t => {
  const output = dir(t), calls = [];
  const result = await runMigrationCases({
    output,
    processExecutor: async ({args, log}) => {
      const pattern = args.find(arg => arg.startsWith('--test-name-pattern='));
      const name = pattern.slice('--test-name-pattern=^'.length, -1).replaceAll('\\\\', '\\');
      calls.push(name);
      fs.writeFileSync(log, tap(name), {flag: 'wx', mode: 0o600});
      return processPass;
    },
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, MIGRATION_CASES.map(item => item.name));
  assert.deepEqual(result.results.map(item => item.id), MIGRATION_CASES.map(item => item.id));
});

test('UP03 cancellation preserves blocked receipts without launching queued cases', async t => {
  const output = dir(t), controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runMigrationCases({
    output,
    signal: controller.signal,
    processExecutor: async () => { calls += 1; throw new Error('must not launch'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.complete, false);
  assert.equal(result.interrupted, true);
  assert.equal(result.passed, false);
  assert.equal(result.results.length, MIGRATION_CASES.length);
  assert.ok(result.results.every(item => item.status === 'failed' && item.classification === 'blocked'));
  assert.ok(result.results.every(item => fs.statSync(path.join(output, item.tap.path)).size === 0));
});

test('UP03 cancellation at the last child cannot produce a passing summary', async t => {
  const output = dir(t), controller = new AbortController();
  let index = 0;
  const result = await runMigrationCases({output, signal: controller.signal, processExecutor: async ({log}) => {
    fs.writeFileSync(log, tap(MIGRATION_CASES[index++].name), {flag: 'wx', mode: 0o600});
    if (index === MIGRATION_CASES.length) controller.abort();
    return processPass;
  }});
  assert.equal(index, MIGRATION_CASES.length);
  assert.equal(result.complete, false);
  assert.equal(result.passed, false);
  assert.equal(result.executionMode, 'injected-test-fixture');
});
