import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAcceptanceGate } from '../lib/acceptance-runner.mjs';

const tap = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const vitestPass = {
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{ status: 'passed', assertionResults: [{ fullName: 'fixture pass', title: 'pass', status: 'passed' }] }],
};
const disposableEnv = { PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'realdex-acceptance-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, output: root };
}
function child(code, ...args) {
  return { command: process.execPath, args: ['-e', code, ...args] };
}
async function run(t, options, extra = {}) {
  const f = fixture(t);
  return runAcceptanceGate({ name: 'fixture', cwd: f.root, output: f.output, sourceDigest: 'source', env: disposableEnv, ...options, ...extra });
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

test('records a successful child and its finalized log lifecycle', async t => {
  const gate = await run(t, child(`process.stdout.write(${JSON.stringify(tap)})`), { requireTap: true });
  assert.equal(gate.status, 'passed');
  assert.deepEqual(gate.counts, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(gate.processExitCode, 0);
  assert.equal(gate.processSignal, null);
  assert.equal(gate.processTreeTermination, process.platform === 'win32' ? 'direct-child-only' : 'owned-process-group');
  assert.match(gate.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(gate.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(gate.sourceDigest, 'source');
  assert.equal(gate.log, 'fixture.log');
  assert.equal(gate.logSha256.length, 64);
});

test('keeps a timeout process failure when its framework report is otherwise passing', async t => {
  const f = fixture(t);
  const report = path.join(f.root, 'report.json');
  writeJson(report, vitestPass);
  const gate = await runAcceptanceGate({
    name: 'fixture', ...child('setInterval(() => {}, 1000)'), cwd: f.root, output: f.output, sourceDigest: 'source', env: disposableEnv,
    timeout: 60, frameworkFormat: 'vitest', frameworkReport: report,
  });
  assert.equal(gate.status, 'failed');
  assert.equal(gate.reason, 'CI_TIMEOUT');
  assert.equal(gate.frameworkReason, undefined);
  assert.equal(gate.processExitCode, null);
  assert.equal(gate.framework, 'vitest');
});

test('records explicit abort cancellation and preserves it over framework pending', async t => {
  const f = fixture(t);
  const report = path.join(f.root, 'report.json');
  writeJson(report, { ...vitestPass, numPendingTests: 1, numPassedTests: 0, testResults: [{ status: 'passed', assertionResults: [{ fullName: 'pending', title: 'pending', status: 'pending' }] }] });
  const controller = new AbortController();
  const job = runAcceptanceGate({
    name: 'fixture', ...child('setInterval(() => {}, 1000)'), cwd: f.root, output: f.output, sourceDigest: 'source', env: disposableEnv,
    timeout: 5000, frameworkFormat: 'vitest', frameworkReport: report, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const gate = await job;
  assert.equal(gate.status, 'failed');
  assert.equal(gate.reason, 'CI_ABORTED');
  assert.equal(gate.frameworkReason, 'VITEST_PENDING_PRESENT');
});

test('does not let a nonzero process become passing because its JSON report passes', async t => {
  const f = fixture(t);
  const report = path.join(f.root, 'report.json');
  writeJson(report, vitestPass);
  const gate = await runAcceptanceGate({
    name: 'fixture', ...child(`process.exitCode = 7; process.stdout.write(${JSON.stringify(tap)})`), cwd: f.root, output: f.output,
    sourceDigest: 'source', env: disposableEnv, requireTap: true, frameworkFormat: 'vitest', frameworkReport: report,
  });
  assert.equal(gate.status, 'failed');
  assert.equal(gate.reason, 'PROCESS_EXIT_NONZERO');
  assert.equal(gate.processExitCode, 7);
});

test('fails when the framework report is missing or malformed', async t => {
  const missingFixture = fixture(t);
  const missing = await runAcceptanceGate({ name: 'fixture', ...child(`process.stdout.write(${JSON.stringify(tap)})`), cwd: missingFixture.root, output: missingFixture.output, sourceDigest: 'source', env: disposableEnv, frameworkFormat: 'vitest', frameworkReport: path.join(missingFixture.root, 'missing-report.json') });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.reason, 'FRAMEWORK_REPORT_MISSING');

  const f = fixture(t);
  const report = path.join(f.root, 'report.json');
  fs.writeFileSync(report, '{not-json');
  const malformed = await runAcceptanceGate({ name: 'fixture', ...child(`process.stdout.write(${JSON.stringify(tap)})`), cwd: f.root, output: f.output, sourceDigest: 'source', env: disposableEnv, frameworkFormat: 'vitest', frameworkReport: report });
  assert.equal(malformed.status, 'failed');
  assert.equal(malformed.reason, 'FRAMEWORK_REPORT_INVALID');
  assert.equal(malformed.frameworkReport, 'report.json');
  assert.equal(malformed.frameworkReportSha256, createHash('sha256').update(fs.readFileSync(report)).digest('hex'));
  assert.equal(malformed.framework, 'vitest');
});

test('retains pending counts and framework reason when the process itself succeeded', async t => {
  const f = fixture(t);
  const report = path.join(f.root, 'report.json');
  writeJson(report, { ...vitestPass, numPendingTests: 1, numPassedTests: 0, testResults: [{ status: 'passed', assertionResults: [{ fullName: 'pending', title: 'pending', status: 'pending' }] }] });
  const gate = await runAcceptanceGate({ name: 'fixture', ...child(`process.stdout.write(${JSON.stringify(tap)})`), cwd: f.root, output: f.output, sourceDigest: 'source', frameworkFormat: 'vitest', frameworkReport: report });
  assert.equal(gate.status, 'failed');
  assert.equal(gate.reason, 'VITEST_PENDING_PRESENT');
  assert.deepEqual(gate.counts, { tests: 1, pass: 0, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
});

test('kills an owned Linux descendant and leaves its log stable after completion', { skip: process.platform !== 'linux' }, async t => {
  const code = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','console.log("descendant"); setInterval(()=>console.log("descendant"),5)'],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000);`;
  const f = fixture(t);
  const gate = await runAcceptanceGate({ name: 'fixture', ...child(code), cwd: f.root, output: f.output, sourceDigest: 'source', env: disposableEnv, timeout: 1000 });
  assert.equal(gate.status, 'failed');
  assert.equal(gate.reason, 'CI_TIMEOUT');
  const log = path.join(f.output, gate.log);
  const content = fs.readFileSync(log, 'utf8');
  assert.match(content, /descendant/);
  const digest = createHash('sha256').update(content).digest('hex');
  assert.equal(digest, gate.logSha256);
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = fs.readFileSync(log, 'utf8');
  assert.equal(after, content);
  assert.equal(createHash('sha256').update(after).digest('hex'), digest);
});
