import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// A run that dies before it writes leaves the previous run's report on disk, and
// the next reader takes it for this run's evidence. That is not hypothetical: a
// report from an earlier release was read as evidence for a new one in this
// project. Several of these scripts also swallow the write failure, because the
// write sits in a `finally` and must not mask the original error — which is a
// good reason that makes the silence worse.
//
// Removing the stale file first turns the whole class into a loud failure: if the
// run does not finish, there is no report to misread.
const REPORT = "report.json";

/** Prepares the output directory and removes any report left by an earlier run. */
export async function beginReport (outputDirectory) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  await rm(resolve(output, REPORT), { force: true });
  return output;
}

/**
 * Writes the report, stamped with when the run finished.
 *
 * Callers in a `finally` should not let a write failure mask the error that got
 * them there, so this reports the failure on stderr and returns false rather than
 * throwing. With the stale file already gone, a false here means no report exists,
 * which is exactly what a reader should trip over.
 */
export async function finishReport (outputDirectory, report) {
  const output = resolve(outputDirectory);
  try {
    await writeFile(resolve(output, REPORT), `${JSON.stringify({ ...report, ranAt: new Date().toISOString() }, null, 2)}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`REPORT_WRITE_FAILED: ${resolve(output, REPORT)}: ${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
}
