import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { beginReport } from "./v01Report.mjs";

const [playwrightPath, chromePath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");
// playwright-core is CommonJS, so Node does not expose `chromium` as a named export
// and destructuring it yields undefined — a failure that only surfaces much later as
// "Cannot read properties of undefined (reading 'launch')". Accept either shape.
const playwrightModuleExports = await import(pathToFileURL(resolve(playwrightPath)).href);
const chromium = playwrightModuleExports.chromium ?? playwrightModuleExports.default?.chromium;
if (!chromium) throw new Error("PLAYWRIGHT_MODULE_HAS_NO_CHROMIUM: " + playwrightPath);
await mkdir(outputPath, { recursive: true });
await beginReport(outputPath);
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false }, optimizeDeps: { entries: ["index.html"] }, clearScreen: false });
await server.listen();
let browser;
try {
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const external = [], errors = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const first = await context.newPage(), second = await context.newPage();
  for (const page of [first, second]) page.on("pageerror", error => errors.push(error.message));
  await Promise.all([first.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 }), second.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 })]);
  const load = async page => page.evaluate(async () => {
    window.operation = await import("/src/v01/active-operation.ts");
    window.recovery = await import("/src/swap/evm-swap-recovery.ts");
  });
  await Promise.all([load(first), load(second)]);
  // Real browser Web Locks: the first tab holds the production origin-wide lock.
  await first.evaluate(async () => {
    window.lockEntered = false;
    window.lockRun = window.operation.withV01OperationLock(async () => {
      window.lockEntered = true;
      await new Promise(resolve => { window.releaseLock = resolve; });
    });
  });
  await first.waitForFunction(() => window.lockEntered === true);
  const contention = await second.evaluate(async () => {
    let entered = false;
    try { await window.operation.withV01OperationLock(async () => { entered = true; }); return { entered, error: null }; }
    catch (error) { return { entered, error: error.message }; }
  });
  assert.deepEqual(contention, { entered: false, error: "DUPLICATE_ROUTE_EXECUTION" });
  await first.evaluate(async () => { window.releaseLock(); await window.lockRun; });

  const attempt = { schema: "realdex.v01-active-operation.v1", intentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000901", quoteId: "browser-test-only", profileFingerprint: `0x${"a".repeat(64)}`, recoveryId: null };
  await first.evaluate(async value => window.operation.withV01OperationLock(async () => window.operation.saveActiveV01Operation(value)), attempt);
  assert.deepEqual(await second.evaluate(() => window.operation.readActiveV01Operation()), attempt);
  await first.reload(); await load(first);
  assert.deepEqual(await first.evaluate(() => window.operation.readActiveV01Operation()), attempt);
  const replacement = await second.evaluate(async value => {
    try { await window.operation.withV01OperationLock(async () => window.operation.saveActiveV01Operation({ ...value, intentId: value.intentId.replace(/901$/, "902") })); return null; }
    catch (error) { return error.message; }
  }, attempt);
  assert.equal(replacement, "V01_UNRESOLVED_OPERATION");
  // A terminated tab releases the browser lock, but must not release durable uncertainty.
  await first.evaluate(async () => {
    window.lockEntered = false;
    window.lockRun = window.operation.withV01OperationLock(async () => { window.lockEntered = true; await new Promise(() => {}); });
  });
  await first.waitForFunction(() => window.lockEntered === true);
  await first.close();
  await second.waitForFunction(async () => {
    try { return await window.operation.withV01OperationLock(async () => !!window.operation.readActiveV01Operation()); }
    catch { return false; }
  });
  assert.deepEqual(await second.evaluate(() => window.operation.readActiveV01Operation()), attempt);
  await second.reload(); await load(second);
  await second.getByText("未解決または確認待ちの操作があります", { exact: false }).waitFor();
  assert.equal(await second.getByRole("button", { name: "見積りを取得" }).isDisabled(), true);
  await second.screenshot({ path: resolve(outputPath, "retained-after-tab-close.png"), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const report = {
    scope: "Production operation-lock/storage modules in two fresh Chrome tabs with synthetic hashless intent; real reload/tab termination and unconfigured React UI. No wallet, chain send, actual quote or receipt/finality proof.",
    browser: browser.version(),
    contentionRejectedBeforeAction: true, hashlessIntentSurvivesReload: true,
    otherIntentRejected: true, tabTerminationReleasesOnlyWebLock: true,
    durableUnknownRetained: true, unconfiguredUiShowsUnresolvedNotice: true,
    pageErrors: errors.length, externalRequests: external.length
  };
  await writeFile(resolve(outputPath, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2));
  await context.close();
} finally { await browser?.close(); await server.close(); }
