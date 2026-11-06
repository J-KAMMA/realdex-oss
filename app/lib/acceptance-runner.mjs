import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './parallel-process.mjs';
import { processEvidence } from './acceptance.mjs';
import { frameworkEvidence } from './framework-evidence.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function processReason(result, evidence) {
  if (result.reason) return result.reason;
  if (result.error) return 'PROCESS_NOT_COMPLETED';
  if (result.signal) return 'PROCESS_SIGNALLED';
  if (result.status !== 0) return 'PROCESS_EXIT_NONZERO';
  return evidence.reason;
}

export async function runAcceptanceGate({
  name,
  command,
  args = [],
  cwd,
  output,
  env,
  sourceDigest,
  scope = 'unit-and-synthetic-http',
  timeout = 240000,
  requireTap = false,
  frameworkReport,
  frameworkFormat,
  signal,
}) {
  const log = path.join(output, `${name}.log`);
  const result = await runProcess({ command, args, cwd, log, env, timeoutMs: timeout, signal });
  const logBytes = fs.readFileSync(log);
  const evidence = processEvidence(result, logBytes.toString('utf8'), { requireTap });
  const gate = {
    name,
    scope,
    ...evidence,
    ...(evidence.status === 'failed' ? { reason: processReason(result, evidence) } : {}),
    durationMs: result.durationMs,
    sourceDigest,
    log: path.basename(log),
    logSha256: sha256(logBytes),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    processTreeTermination: result.processTreeTermination,
    processExitCode: result.status ?? null,
    processSignal: result.signal ?? null,
  };

  if (frameworkReport !== undefined) {
    let report;
    let reportReason;
    let reportBytes;
    try {
      if (typeof frameworkReport !== 'string') throw new Error('FRAMEWORK_REPORT_INVALID');
      reportBytes = fs.readFileSync(frameworkReport);
      report = frameworkEvidence(frameworkFormat, JSON.parse(reportBytes.toString('utf8')));
    } catch (error) {
      reportReason = typeof frameworkReport === 'string' && fs.existsSync(frameworkReport) ? 'FRAMEWORK_REPORT_INVALID' : 'FRAMEWORK_REPORT_MISSING';
    }
    if (reportBytes) {
      gate.frameworkReport = path.basename(frameworkReport);
      gate.frameworkReportSha256 = sha256(reportBytes);
      gate.framework = frameworkFormat;
      if (report) {
        gate.counts = report.counts;
        if (report.status !== 'passed') reportReason = report.reason;
      }
    }
    if (reportReason) {
      if (gate.status === 'failed') gate.frameworkReason = reportReason;
      else {
        gate.status = 'failed';
        gate.reason = reportReason;
      }
    }
  }
  return gate;
}
