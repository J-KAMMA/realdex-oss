import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MIGRATION_CASES} from '../../integration/protected/migration-cases.mjs';
import {runMigrationCases} from '../../integration/protected/migration-run.mjs';

test('UP03 official protected migration runner verifies every registered scenario', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex-up03-official-'));
  const output = path.join(parent, 'run');
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
  const result = await runMigrationCases({output});
  assert.equal(result.status, 'passed');
  assert.equal(result.classification, 'passed');
  assert.equal(result.complete, true);
  assert.equal(result.sourceUnchanged, true);
  assert.deepEqual(result.requestedCases, MIGRATION_CASES);
  assert.equal(result.results.length, MIGRATION_CASES.length);
  for (const [index, item] of MIGRATION_CASES.entries()) {
    await t.test(item.name, () => {
      const receipt = result.results[index];
      assert.equal(receipt.id, item.id);
      assert.equal(receipt.name, item.name);
      assert.equal(receipt.ordinal, index + 1);
      assert.equal(receipt.status, 'passed');
      assert.equal(receipt.classification, 'passed');
      assert.equal(receipt.testName, item.name);
      assert.deepEqual(receipt.testNames, [item.name]);
      assert.deepEqual(receipt.topLevelOutcomes, [{ok: true, number: 1, name: item.name}]);
      assert.equal(receipt.evidence.counts.tests, 1);
      assert.equal(receipt.evidence.counts.pass, 1);
      assert.equal(receipt.evidence.counts.fail, 0);
      assert.equal(receipt.evidence.counts.cancelled, 0);
      assert.equal(receipt.evidence.counts.skipped, 0);
      assert.equal(receipt.evidence.counts.todo, 0);
      assert.equal(fs.existsSync(path.join(output, receipt.tap.path)), true);
      assert.equal(fs.existsSync(path.join(output, `${item.id.toLowerCase()}.json`)), true);
    });
  }
});
