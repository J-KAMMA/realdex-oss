#!/usr/bin/env node
// Reproduces a release from a clone and compares it against this working tree.
//
// Every earlier clean-room run copied the working tree. That skips `git checkout`,
// which is exactly where the bytes can change: Git for Windows ships
// core.autocrlf=true in its system config, so before `.gitattributes` existed a
// fresh checkout wrote CRLF and produced a different release id than the profile
// committed alongside it. Measured on 2026-09-04: b801d02 checked out that way
// builds base-sepolia-396006ecbddb while pinning base-sepolia-103a7c9413c5.
// Copying never showed it. Cloning does.
//
// The clone is deliberately made with core.autocrlf=true. That is the hostile
// setting, and a reproduction that only holds under a friendly one is not a
// reproduction. Use --no-checkout then checkout, because cloning and *then*
// switching commits leaves files whose content did not change between them
// untouched — which reports a false match.
//
// Usage:
//   node scripts/verifyCleanRoomReproduction.mjs [--ref <commit>] [--out <file>] [--keep] [--skip-install]
// Exits non-zero on any mismatch or failed step.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const ref = valueOf("--ref") ?? "HEAD";
const keep = args.includes("--keep");
const skipInstall = args.includes("--skip-install");

const report = { schema: "realdex.clean-room-reproduction.v1", ref, startedAt: new Date().toISOString(), steps: [], mismatches: [] };
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "realdex-cleanroom-"));
const clone = path.join(workspace, "clone");

try {
  const resolved = run("git", ["rev-parse", ref], root).trim();
  report.commit = resolved;

  step("clone", () => {
    // file:// keeps git from treating a Windows path as a remote spec.
    run("git", ["clone", "--quiet", "--no-checkout", "-c", "core.autocrlf=true", pathToFileUrl(root), clone], workspace);
    run("git", ["checkout", "--quiet", resolved], clone);
  });

  step("line endings", () => {
    // The setting is hostile on purpose; the attributes are what must neutralise it.
    const offenders = trackedTextFiles(clone).filter(file => fs.readFileSync(path.join(clone, file)).includes("\r\n"));
    report.crlfFiles = offenders.length;
    if (offenders.length) fail(`the clone wrote CRLF into ${offenders.length} tracked text file(s), starting with ${offenders[0]}`);
  });

  if (!skipInstall) step("install", () => run("corepack", ["pnpm", "install", "--frozen-lockfile"], clone));

  step("release identity", () => {
    const mine = identity(root);
    const theirs = identity(clone);
    report.releaseId = theirs.releaseId;
    report.bundleSha256 = theirs.bundleSha256;
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      if (key === "tree" || key === "capturedAt") continue;
      if (JSON.stringify(mine[key]) !== JSON.stringify(theirs[key])) fail(`${key} differs between the working tree and the clone`);
    }
  });

  step("tests", () => run("npm", ["test"], clone));
  step("typecheck", () => run("npx", ["tsc", "-b"], clone));
  step("build", () => run("npm", ["run", "build"], clone));

  step("distribution", () => {
    const mine = distribution(root);
    const theirs = distribution(clone);
    report.distribution = theirs;
    const names = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
    for (const name of names) {
      if (mine[name] !== theirs[name]) fail(`${name}: working tree ${mine[name] ?? "absent"} vs clone ${theirs[name] ?? "absent"}`);
    }
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  report.reproduced = report.mismatches.length === 0;
  if (keep) report.workspace = workspace;
  else fs.rmSync(workspace, { recursive: true, force: true });
  const serialised = `${JSON.stringify(report, null, 2)}\n`;
  const out = valueOf("--out");
  if (out) fs.writeFileSync(path.resolve(out), serialised);
  console.log(serialised.trimEnd());
  process.exitCode = report.reproduced ? 0 : 1;
}

function step (name, body) {
  const startedAt = Date.now();
  const before = report.mismatches.length;
  try {
    body();
    report.steps.push({ name, ok: report.mismatches.length === before, seconds: Math.round((Date.now() - startedAt) / 1000) });
  } catch (error) {
    report.steps.push({ name, ok: false, seconds: Math.round((Date.now() - startedAt) / 1000) });
    fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function fail (message) {
  if (!report.mismatches.includes(message)) report.mismatches.push(message);
}

function run (command, commandArgs, cwd) {
  // Only the package-manager wrappers are shell scripts on Windows. Kept inside
  // the function because `run` is called during module evaluation, before a
  // module-level const would be initialised.
  const needsShell = ["npm", "npx", "corepack", "pnpm"].includes(command);
  const shell = process.platform === "win32" && needsShell;
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", shell, maxBuffer: 1 << 28 });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
    throw new Error(`${command} ${commandArgs.join(" ")} exited ${result.status}\n${detail}`);
  }
  return result.stdout ?? "";
}

function identity (tree) {
  return JSON.parse(run("node", ["scripts/captureV01ReleaseIdentity.mjs"], tree));
}

function distribution (tree) {
  const dist = path.join(tree, "dist");
  if (!fs.existsSync(dist)) return {};
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, name);
      else out[name] = `sha256:${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`;
    }
  };
  walk(dist, "");
  return out;
}

function trackedTextFiles (tree) {
  const binary = /\.(png|jpg|jpeg|gif|ico|pdf|woff2?|exe|dll)$/i;
  return execFileSync("git", ["ls-files", "-z"], { cwd: tree, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter(Boolean).filter(file => !binary.test(file))
    .filter(file => { try { return !fs.readFileSync(path.join(tree, file)).includes(0); } catch { return false; } });
}

function pathToFileUrl (value) {
  return `file:///${value.replace(/\\/g, "/")}`;
}

function valueOf (flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
