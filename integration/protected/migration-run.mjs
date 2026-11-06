#!/usr/bin/env node
/** Official UP03 migration runner: one fresh Node test child per case, in order. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {MIGRATION_CASES} from './migration-cases.mjs';
import {runProcess, testEnvironment} from '../../app/lib/parallel-process.mjs';
import {processEvidence, sourceSnapshot} from '../../app/lib/acceptance.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TEST_FILE = 'integration/protected/migration.test.mjs';
export const MIGRATION_TIMEOUT_MS = 30000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

export function escapeTestName(name) {
  return name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function assertCases(cases) {
  requireValue(Array.isArray(cases) && cases.length === MIGRATION_CASES.length, 'UP03_CASE_REGISTRY_INVALID');
  for (const [index, item] of cases.entries()) {
    const expected = MIGRATION_CASES[index];
    requireValue(item && item.id === expected.id && item.name === expected.name, 'UP03_CASE_REGISTRY_MISMATCH');
  }
}

function tapNames(text) {
  return [...text.matchAll(/^# Subtest: ([^\r\n]+)\r?$/gm)].map(match => match[1]);
}

function topLevelOutcomes(text) {
  return [...text.matchAll(/^(not )?ok ([0-9]+) - ([^\r\n]+)\r?$/gm)].map(match => ({
    ok: !match[1], number: Number(match[2]), name: match[3],
  }));
}

/**
 * Validate one child receipt.  This is exported so unit tests can exercise the
 * fail-closed boundary without launching the 21 real migration scenarios.
 */
export function validateMigrationCaseResult(item, processResult, tapText) {
  requireValue(item && typeof item.id === 'string' && typeof item.name === 'string', 'UP03_CASE_INVALID');
  const evidence = processEvidence(processResult ?? {}, tapText ?? '', {requireTap: true});
  const names = tapNames(tapText ?? '');
  const exactName = names.length === 1 && names[0] === item.name;
  const outcomes = topLevelOutcomes(tapText ?? '');
  const exactCounts = evidence.counts?.tests === 1 && evidence.counts.pass === 1 &&
    evidence.counts.fail === 0 && evidence.counts.cancelled === 0 &&
    evidence.counts.skipped === 0 && evidence.counts.todo === 0;
  const exactOutcome = outcomes.length === 1 && outcomes[0].ok && outcomes[0].number === 1 && outcomes[0].name === item.name;
  const processFailure = processResult?.error || processResult?.signal || processResult?.status !== 0;
  let classification = 'passed';
  let reason = null;
  if (processResult?.error || processResult?.signal || processResult?.reason) {
    classification = 'blocked';
    reason = processResult.reason ?? 'PROCESS_NOT_COMPLETED';
  } else if (!exactName || !exactCounts || !exactOutcome || evidence.status !== 'passed') {
    classification = processFailure ? 'failed' : 'incomplete';
    reason = !exactName ? 'UP03_TAP_NAME_MISMATCH' : !exactOutcome ? 'UP03_TAP_OUTCOME_MISMATCH' : evidence.reason ?? 'UP03_TAP_INCOMPLETE';
  }
  const passed = classification === 'passed' && exactName && exactCounts && exactOutcome && evidence.status === 'passed';
  return {
    status: passed ? 'passed' : 'failed',
    classification: passed ? 'passed' : classification,
    reason: passed ? null : reason,
    testName: names.length === 1 ? names[0] : null,
    testNames: names,
    topLevelOutcomes: outcomes,
    evidence,
  };
}

function gitIdentity(root) {
  try {
    const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore']}).trim();
    return {available: true, commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), clean: git(['status', '--porcelain', '--untracked-files=all']) === ''};
  } catch {
    return {available: false, commit: null, tree: null, clean: null};
  }
}

function outputDirectory(directory, root) {
  const output = path.resolve(directory);
  const source = fs.realpathSync(root);
  requireValue(output !== source && !output.startsWith(source + path.sep), 'UP03_OUTPUT_INSIDE_SOURCE');
  requireValue(!fs.existsSync(output), 'UP03_OUTPUT_EXISTS');
  const parent = path.dirname(output);
  requireValue(fs.statSync(parent).isDirectory(), 'UP03_OUTPUT_PARENT');
  fs.mkdirSync(output, {mode: 0o700});
  return output;
}

function writeFresh(file, contents) {
  fs.writeFileSync(file, contents, {flag: 'wx', mode: 0o600});
}

function caseFileName(item, suffix) {
  return `${item.id.toLowerCase()}.${suffix}`;
}

/**
 * Run every official case exactly once, sequentially.  processExecutor is an
 * intentionally injectable seam for lightweight unit tests; production calls
 * use the real runProcess default.
 */
export async function runMigrationCases({
  root = ROOT,
  output,
  cases = MIGRATION_CASES,
  processExecutor = runProcess,
  timeoutMs = MIGRATION_TIMEOUT_MS,
  signal,
} = {}) {
  requireValue(typeof output === 'string' && output.length > 0, 'UP03_OUTPUT_REQUIRED');
  requireValue(processExecutor === runProcess || typeof processExecutor === 'function', 'UP03_PROCESS_EXECUTOR');
  requireValue(timeoutMs === MIGRATION_TIMEOUT_MS, 'UP03_TIMEOUT_FIXED');
  assertCases(cases);
  const sourceRoot = path.resolve(root);
  const outputRoot = outputDirectory(output, sourceRoot);
  const startedAt = new Date().toISOString();
  const before = {...sourceSnapshot(sourceRoot, {exclude: [outputRoot]}), git: gitIdentity(sourceRoot)};
  writeFresh(path.join(outputRoot, 'source-before.json'), JSON.stringify(before, null, 2) + '\n');
  const results = [];
  const executionMode = processExecutor === runProcess ? 'real-process' : 'injected-test-fixture';
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, {once: true});
  if (signal?.aborted) controller.abort();
  process.once('SIGINT', relayAbort);
  process.once('SIGTERM', relayAbort);
  try {
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      const tapPath = path.join(outputRoot, caseFileName(item, 'tap'));
      const args = [
        '--test', '--test-concurrency=1', '--test-reporter=tap',
        `--test-name-pattern=^${escapeTestName(item.name)}$`, TEST_FILE,
      ];
      let processResult;
      if (controller.signal.aborted) {
        processResult = {status: null, signal: null, error: {code: 'CI_ABORTED'}, reason: 'CI_ABORTED'};
      } else {
        try {
          processResult = await processExecutor({
            command: process.execPath, args, cwd: sourceRoot, log: tapPath,
            timeoutMs: MIGRATION_TIMEOUT_MS, env: testEnvironment(), signal: controller.signal,
          });
        } catch (error) {
          processResult = {status: null, signal: null, error: {code: error?.code ?? 'UP03_PROCESS_EXECUTOR'}, reason: error?.message};
        }
      }
      let tapText = '';
      if (fs.existsSync(tapPath)) tapText = fs.readFileSync(tapPath, 'utf8');
      else if (typeof processResult?.stdout === 'string') tapText = processResult.stdout;
      if (!fs.existsSync(tapPath)) writeFresh(tapPath, tapText);
      const validation = validateMigrationCaseResult(item, processResult, tapText);
      const tapBytes = Buffer.from(tapText, 'utf8');
      const receipt = {
        schema: 'realdex.up03-migration-case.v1', id: item.id, name: item.name, ordinal: index + 1,
        requestedPattern: args[3], command: [process.execPath, ...args], timeoutMs: MIGRATION_TIMEOUT_MS,
        nodeVersion: process.versions.node, executionMode, ...processResult, ...validation,
        tap: {path: path.basename(tapPath), bytes: tapBytes.length, sha256: sha256(tapBytes)},
        productionReady: false, publicNetwork: false,
      };
      writeFresh(path.join(outputRoot, caseFileName(item, 'json')), JSON.stringify(receipt, null, 2) + '\n');
      results.push(receipt);
    }
  } finally {
    signal?.removeEventListener('abort', relayAbort);
    process.removeListener('SIGINT', relayAbort);
    process.removeListener('SIGTERM', relayAbort);
  }
  const after = {...sourceSnapshot(sourceRoot, {exclude: [outputRoot]}), git: gitIdentity(sourceRoot)};
  writeFresh(path.join(outputRoot, 'source-after.json'), JSON.stringify(after, null, 2) + '\n');
  const sourceUnchanged = before.digest === after.digest;
  const complete = !controller.signal.aborted && results.length === cases.length;
  const allPassed = complete && sourceUnchanged && results.every(result => result.status === 'passed');
  const hasBlocked = results.some(result => result.classification === 'blocked');
  const hasFailed = results.some(result => result.classification === 'failed');
  const summary = {
    schema: 'realdex.up03-migration.v1', status: allPassed ? 'passed' : 'failed',
    classification: allPassed ? 'passed' : (hasBlocked ? 'blocked' : (hasFailed ? 'failed' : 'incomplete')),
    passed: allPassed, complete, interrupted: controller.signal.aborted, requestedCases: cases.map(({id, name}) => ({id, name})),
    results, nodeVersion: process.versions.node, timeoutMs: MIGRATION_TIMEOUT_MS, executionMode,
    sourceBefore: {path: 'source-before.json', digest: before.digest, git: before.git},
    sourceAfter: {path: 'source-after.json', digest: after.digest, git: after.git},
    sourceUnchanged, startedAt, finishedAt: new Date().toISOString(),
    productionReady: false, publicNetwork: false,
  };
  writeFresh(path.join(outputRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return {...summary, output: outputRoot};
}

function parseOutput(args) {
  requireValue(args.length === 2 && args[0] === '--output' && args[1] && !args[1].startsWith('--'), 'UP03_ARGUMENTS');
  return path.resolve(args[1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summary = await runMigrationCases({output: parseOutput(process.argv.slice(2))});
    console.log(JSON.stringify({passed: summary.passed, status: summary.status, classification: summary.classification, output: summary.output}));
    process.exitCode = summary.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'UP03_MIGRATION_RUN_FAILED');
    process.exitCode = 1;
  }
}
