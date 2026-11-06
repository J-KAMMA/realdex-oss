import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { rootScriptPlan, ROOT_SCRIPT_GATES } from '../lib/root-script-plan.mjs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const testScripts = ROOT_SCRIPT_GATES.filter(gate => gate.script !== 'build').map(gate => gate.script);
const cloneManifest = () => ({ ...packageJson, scripts: { ...packageJson.scripts } });
const errorCode = (fn) => {
  try {
    fn();
    assert.fail('expected rootScriptPlan to reject the manifest');
  } catch (error) {
    return error.code ?? error.message;
  }
};

test('real package test contract produces build first and the declared test order', () => {
  const declared = packageJson.scripts.test.split(' && ').map(command => command.replace(/^(npm|pnpm) run /, ''));
  assert.deepEqual(new Set(declared), new Set(testScripts));
  assert.deepEqual(rootScriptPlan(packageJson), [
    ROOT_SCRIPT_GATES[0],
    ...declared.map(script => ROOT_SCRIPT_GATES.find(gate => gate.script === script)),
  ]);
});

test('returns immutable gate records and marks only contract tests compiler dependent', () => {
  const plan = rootScriptPlan(packageJson);
  assert.ok(Object.isFrozen(ROOT_SCRIPT_GATES));
  assert.ok(plan.every(Object.isFrozen));
  assert.equal(plan.filter(gate => gate.requiresCompiler).map(gate => gate.script).join(','), 'test:contracts');
});

test('rejects an omitted release-plan test', () => {
  const manifest = cloneManifest();
  manifest.scripts.test = manifest.scripts.test.replace(' && npm run test:release-plan', '');
  assert.equal(errorCode(() => rootScriptPlan(manifest)), 'ROOT_TEST_SCRIPT_OMITTED');
});

test('rejects duplicate mapped tests', () => {
  const manifest = cloneManifest();
  manifest.scripts.test += ' && npm run test:release-plan';
  assert.equal(errorCode(() => rootScriptPlan(manifest)), 'ROOT_TEST_SCRIPT_DUPLICATE');
});

test('rejects unknown scripts even when their command syntax is valid', () => {
  const manifest = cloneManifest();
  manifest.scripts.test = manifest.scripts.test.replace('test:ui', 'test:unknown');
  assert.equal(errorCode(() => rootScriptPlan(manifest)), 'ROOT_TEST_SCRIPT_UNKNOWN');
});

test('rejects shell operators and commands outside the strict run chain', () => {
  for (const command of [
    'npm test && npm run test:contracts',
    'npm run test:contracts; npm run test:call-arity',
    'npm run test:contracts || npm run test:call-arity',
    'node scripts/checkContractCallArity.mjs',
  ]) {
    const manifest = cloneManifest();
    manifest.scripts.test = command;
    assert.equal(errorCode(() => rootScriptPlan(manifest)), 'ROOT_TEST_COMMAND_MALFORMED');
  }
});

test('accepts npm and pnpm run segments in the declared order', () => {
  const manifest = cloneManifest();
  manifest.scripts.test = testScripts.map((script, index) => `${index % 2 ? 'pnpm' : 'npm'} run ${script}`).join(' && ');
  assert.deepEqual(rootScriptPlan(manifest).map(gate => gate.script), ['build', ...testScripts]);
});

test('rejects missing and empty mapped script bodies', () => {
  const missing = cloneManifest();
  delete missing.scripts['test:release-plan'];
  assert.equal(errorCode(() => rootScriptPlan(missing)), 'ROOT_SCRIPT_BODY_MISSING');

  const empty = cloneManifest();
  empty.scripts['test:release-plan'] = '  ';
  assert.equal(errorCode(() => rootScriptPlan(empty)), 'ROOT_SCRIPT_BODY_EMPTY');
});

test('rejects missing or empty build and test bodies', () => {
  const missingBuild = cloneManifest();
  delete missingBuild.scripts.build;
  assert.equal(errorCode(() => rootScriptPlan(missingBuild)), 'ROOT_SCRIPT_BODY_MISSING');

  const emptyTest = cloneManifest();
  emptyTest.scripts.test = '';
  assert.equal(errorCode(() => rootScriptPlan(emptyTest)), 'ROOT_SCRIPT_BODY_EMPTY');
});
