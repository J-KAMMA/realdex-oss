import assert from 'node:assert/strict';
import test from 'node:test';
import { frameworkEvidence } from '../lib/framework-evidence.mjs';

const mochaTest = (file, fullTitle, err = {}) => ({ file, fullTitle, title: fullTitle.split(' ').at(-1), err });
const mochaReport = ({ tests, passes = tests, failures = [], pending = [] } = {}) => ({
  stats: { tests: tests.length, passes: passes.length, failures: failures.length, pending: pending.length },
  tests, passes, failures, pending,
});
const vitestReport = (assertionResults, overrides = {}) => ({
  success: true,
  numTotalTests: assertionResults.length,
  numPassedTests: assertionResults.filter(result => result.status === 'passed').length,
  numFailedTests: assertionResults.filter(result => result.status === 'failed').length,
  numPendingTests: assertionResults.filter(result => ['pending', 'skipped'].includes(result.status)).length,
  numTodoTests: assertionResults.filter(result => result.status === 'todo').length,
  testResults: [{ status: 'passed', assertionResults }],
  ...overrides,
});
const assertion = status => ({ fullName: `suite ${status}`, title: status, status });

test('accepts a complete honest Mocha pass and returns normalized counts', () => {
  const first = mochaTest('a.test.mjs', 'suite first');
  const second = mochaTest('a.test.mjs', 'suite second');
  assert.deepEqual(frameworkEvidence('mocha', mochaReport({ tests: [first, second] })), {
    status: 'passed', counts: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  });
});

test('rejects Mocha pending and failure outcomes even with structurally valid reports', () => {
  const pending = mochaTest('a.test.mjs', 'suite pending');
  const pendingReport = mochaReport({ tests: [pending], passes: [], pending: [pending] });
  assert.equal(frameworkEvidence('mocha', pendingReport).reason, 'MOCHA_PENDING_PRESENT');

  const failure = mochaTest('a.test.mjs', 'suite failure', { message: 'assertion failed' });
  const failureReport = mochaReport({ tests: [failure], passes: [], failures: [failure] });
  assert.equal(frameworkEvidence('mocha', failureReport).reason, 'MOCHA_FAILURES_PRESENT');
});

test('rejects missing Mocha counters and counter-array mismatches', () => {
  const item = mochaTest('a.test.mjs', 'suite item');
  const missing = mochaReport({ tests: [item] });
  delete missing.stats.passes;
  assert.equal(frameworkEvidence('mocha', missing).reason, 'MOCHA_COUNTS_INVALID');

  const mismatch = mochaReport({ tests: [item] });
  mismatch.stats.passes = 2;
  assert.equal(frameworkEvidence('mocha', mismatch).reason, 'MOCHA_COUNTS_MISMATCH');
});

test('rejects duplicate and inconsistent Mocha category membership', () => {
  const item = mochaTest('a.test.mjs', 'suite item');
  const duplicate = mochaReport({ tests: [item], passes: [item, item] });
  duplicate.stats.passes = 2;
  assert.equal(frameworkEvidence('mocha', duplicate).reason, 'MOCHA_COUNTS_MISMATCH');

  const crossCategory = mochaReport({ tests: [item], passes: [item], pending: [item] });
  crossCategory.stats.pending = 1;
  crossCategory.stats.tests = 2;
  crossCategory.tests.push(mochaTest('a.test.mjs', 'suite other'));
  assert.equal(frameworkEvidence('mocha', crossCategory).reason, 'MOCHA_MEMBERSHIP_INVALID');
});

test('rejects Mocha tests carrying a nonempty error object', () => {
  const item = mochaTest('a.test.mjs', 'suite item', { stack: 'unexpected' });
  assert.equal(frameworkEvidence('mocha', mochaReport({ tests: [item] })).reason, 'MOCHA_TEST_ERROR');
});

test('rejects a nonempty error on a Mocha passes entry even when tests is empty', () => {
  const testEntry = mochaTest('a.test.mjs', 'suite item');
  const passEntry = mochaTest('a.test.mjs', 'suite item', { stack: 'unexpected' });
  assert.equal(frameworkEvidence('mocha', mochaReport({ tests: [testEntry], passes: [passEntry] })).reason, 'MOCHA_TEST_ERROR');
});

test('accepts a complete honest Vitest pass', () => {
  const result = frameworkEvidence('vitest', vitestReport([assertion('passed'), assertion('passed')]));
  assert.deepEqual(result, { status: 'passed', counts: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 } });
});

test('rejects Vitest failure, pending, and todo outcomes', () => {
  assert.equal(frameworkEvidence('vitest', vitestReport([assertion('failed')])).reason, 'VITEST_FAILURES_PRESENT');
  assert.equal(frameworkEvidence('vitest', vitestReport([assertion('pending')])).reason, 'VITEST_PENDING_PRESENT');
  assert.equal(frameworkEvidence('vitest', vitestReport([assertion('todo')])).reason, 'VITEST_TODO_PRESENT');
});

test('rejects a Vitest failed file even when all assertions claim passed', () => {
  const report = vitestReport([assertion('passed')]);
  report.testResults[0].status = 'failed';
  assert.equal(frameworkEvidence('vitest', report).reason, 'VITEST_FILE_FAILED');
});

test('rejects missing or contradictory Vitest counters', () => {
  const missing = vitestReport([assertion('passed')]);
  delete missing.numTodoTests;
  assert.equal(frameworkEvidence('vitest', missing).reason, 'VITEST_COUNTS_INVALID');

  const contradictory = vitestReport([assertion('passed')], { numPassedTests: 0 });
  assert.equal(frameworkEvidence('vitest', contradictory).reason, 'VITEST_COUNTS_MISMATCH');
});

test('preserves valid Vitest counters when the report is unsuccessful', () => {
  const report = vitestReport([assertion('passed')], { success: false });
  assert.deepEqual(frameworkEvidence('vitest', report), {
    status: 'failed',
    counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    reason: 'VITEST_REPORT_UNSUCCESSFUL',
  });
});

test('rejects unknown assertion statuses and empty reports', () => {
  assert.equal(frameworkEvidence('vitest', vitestReport([assertion('unknown')])).reason, 'VITEST_ASSERTION_STATUS_INVALID');
  assert.equal(frameworkEvidence('vitest', {
    success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [],
  }).reason, 'VITEST_REPORT_EMPTY');
});

test('fails closed for unsupported formats and malformed Mocha reports', () => {
  assert.equal(frameworkEvidence('jest', {}).reason, 'FRAMEWORK_FORMAT_UNSUPPORTED');
  assert.equal(frameworkEvidence('mocha', { stats: {} }).reason, 'MOCHA_COUNTS_INVALID');
});
