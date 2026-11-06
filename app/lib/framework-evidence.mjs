const ZERO_COUNTS = Object.freeze({ tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
const MOCHA_CATEGORIES = Object.freeze(['passes', 'failures', 'pending']);
const VITEST_ASSERTION_STATUSES = new Set(['passed', 'failed', 'pending', 'skipped', 'todo']);

function failed(reason, counts = ZERO_COUNTS) {
  return { status: 'failed', counts: { ...counts }, reason };
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(value) {
  if (!validRecord(value) || typeof value.file !== 'string' || value.file === '' ||
      typeof value.fullTitle !== 'string' || value.fullTitle === '') return null;
  return `${value.file}\u0000${value.fullTitle}`;
}

function emptyError(value) {
  return value === null || (validRecord(value) && Object.keys(value).length === 0);
}

function mochaEvidence(report) {
  if (!validRecord(report) || !validRecord(report.stats)) return failed('MOCHA_REPORT_INVALID');
  const { stats } = report;
  const countKeys = ['tests', 'passes', 'failures', 'pending'];
  if (!countKeys.every(key => validCount(stats[key]))) return failed('MOCHA_COUNTS_INVALID');
  const counts = { tests: stats.tests, pass: stats.passes, fail: stats.failures, cancelled: 0, skipped: stats.pending, todo: 0 };
  if (stats.tests === 0) return failed('MOCHA_REPORT_EMPTY', counts);
  if (!Array.isArray(report.tests) || !MOCHA_CATEGORIES.every(key => Array.isArray(report[key]))) {
    return failed('MOCHA_ARRAYS_INVALID', counts);
  }
  if (report.tests.length !== stats.tests || report.passes.length !== stats.passes ||
      report.failures.length !== stats.failures || report.pending.length !== stats.pending ||
      stats.passes + stats.failures + stats.pending !== stats.tests) {
    return failed('MOCHA_COUNTS_MISMATCH', counts);
  }

  const tests = new Map();
  for (const test of report.tests) {
    const id = identity(test);
    if (!id || tests.has(id)) return failed('MOCHA_IDENTITY_INVALID', counts);
    tests.set(id, test);
  }
  const memberships = new Map();
  for (const category of MOCHA_CATEGORIES) {
    const seen = new Set();
    for (const entry of report[category]) {
      const id = identity(entry);
      if (!id || seen.has(id) || !tests.has(id) || memberships.has(id)) return failed('MOCHA_MEMBERSHIP_INVALID', counts);
      if (category === 'passes' && (!Object.hasOwn(entry, 'err') || !emptyError(entry.err))) return failed('MOCHA_TEST_ERROR', counts);
      seen.add(id);
      memberships.set(id, category);
    }
  }
  if (memberships.size !== tests.size) return failed('MOCHA_MEMBERSHIP_INVALID', counts);
  if (stats.failures > 0) return failed('MOCHA_FAILURES_PRESENT', counts);
  if (stats.pending > 0) return failed('MOCHA_PENDING_PRESENT', counts);
  for (const test of tests.values()) if (!Object.hasOwn(test, 'err') || !emptyError(test.err)) return failed('MOCHA_TEST_ERROR', counts);
  return { status: 'passed', counts };
}

function vitestEvidence(report) {
  if (!validRecord(report)) return failed('VITEST_REPORT_INVALID');
  const countKeys = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'];
  if (!countKeys.every(key => validCount(report[key]))) return failed('VITEST_COUNTS_INVALID');
  const counts = {
    tests: report.numTotalTests,
    pass: report.numPassedTests,
    fail: report.numFailedTests,
    cancelled: 0,
    skipped: report.numPendingTests,
    todo: report.numTodoTests,
  };
  if (report.success !== true) return failed('VITEST_REPORT_UNSUCCESSFUL', counts);
  if (report.numTotalTests === 0 || !Array.isArray(report.testResults) || report.testResults.length === 0) {
    return failed('VITEST_REPORT_EMPTY', counts);
  }
  const assertions = [];
  for (const file of report.testResults) {
    if (!validRecord(file) || !Array.isArray(file.assertionResults)) return failed('VITEST_FILE_INVALID', counts);
    if (file.status !== 'passed' && file.status !== 'failed') return failed('VITEST_FILE_STATUS_INVALID', counts);
    if (file.status === 'failed') return failed('VITEST_FILE_FAILED', counts);
    assertions.push(...file.assertionResults);
  }
  const actual = { tests: assertions.length, pass: 0, fail: 0, skipped: 0, todo: 0 };
  for (const assertion of assertions) {
    if (!validRecord(assertion) || !VITEST_ASSERTION_STATUSES.has(assertion.status)) return failed('VITEST_ASSERTION_STATUS_INVALID', counts);
    if (assertion.status === 'passed') actual.pass += 1;
    else if (assertion.status === 'failed') actual.fail += 1;
    else if (assertion.status === 'todo') actual.todo += 1;
    else actual.skipped += 1;
  }
  if (actual.tests !== counts.tests || actual.pass !== counts.pass || actual.fail !== counts.fail ||
      actual.skipped !== counts.skipped || actual.todo !== counts.todo ||
      actual.pass + actual.fail + actual.skipped + actual.todo !== actual.tests) {
    return failed('VITEST_COUNTS_MISMATCH', counts);
  }
  if (counts.fail > 0) return failed('VITEST_FAILURES_PRESENT', counts);
  if (counts.skipped > 0) return failed('VITEST_PENDING_PRESENT', counts);
  if (counts.todo > 0) return failed('VITEST_TODO_PRESENT', counts);
  return { status: 'passed', counts };
}

export function frameworkEvidence(format, report) {
  if (format === 'mocha') return mochaEvidence(report);
  if (format === 'vitest') return vitestEvidence(report);
  return failed('FRAMEWORK_FORMAT_UNSUPPORTED');
}
