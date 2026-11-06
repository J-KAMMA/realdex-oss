import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { createV01BrowserFixture } from "./v01BrowserFixture.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";
import { focusSettled } from "./v01FocusSettled.mjs";

// Fresh synthetic wallet + isolated Hardhat only. No public RPC, actual extension,
// private profile or shipped configuration override. Two IDs share one local backend.
const [playwrightPath, chromePath, outputPath, selectedMode] = process.argv.slice(2);
const modes = ["repriced", "cancelled", "replaced", "approval-cancelled", "approval-replaced", "approval-repriced"];
if (selectedMode && !modes.includes(selectedMode)) throw new Error("Unknown replacement QA mode");
const traceExceptions = process.env.REALDEX_QA_TRACE_EXCEPTIONS === "1";
const captureErrors = process.env.REALDEX_QA_CAPTURE_ERRORS === "1";
const diagnosticOnly = traceExceptions || captureErrors;
if (!playwrightPath || !chromePath || !outputPath) throw new Error("Usage: PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");
const output = resolve(outputPath);
await beginReport(output);
const originalConfiguration = await readFile("src/v01/reviewed-profile.ts", "utf8");
// This run supplies its own configuration to the page, so the committed one is never
// read here. What must hold is that the harness leaves it alone — asserted at the end,
// against these bytes — and that a local fixture is never what is committed. It used to
// require the committed value to be `= null` as well, which described the circumstances
// of shipping no profile rather than any rule, and made the harness unrunnable the
// moment a real deployment was pinned.
assert.ok(!originalConfiguration.includes("realdex-v01-local-test"), "a development fixture must not be committed as the public configuration");
// playwright-core is CommonJS, so Node does not expose `chromium` as a named export
// and destructuring it yields undefined — a failure that only surfaces much later as
// "Cannot read properties of undefined (reading 'launch')". Accept either shape.
const playwrightModuleExports = await import(pathToFileURL(resolve(playwrightPath)).href);
const chromium = playwrightModuleExports.chromium ?? playwrightModuleExports.default?.chromium;
if (!chromium) throw new Error("PLAYWRIGHT_MODULE_HAS_NO_CHROMIUM: " + playwrightPath);
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const rpcUrls = ["https://hardhat-a.example/", "https://hardhat-b.example/"];
const closeName = "照会済みの操作を終了し、新しい見積りへ";
const recoveryKey = "localswap:evm-swap-recovery-journal:v1";
const activeKey = "realdex:v01-active-operation:v1";
const journal = page => page.evaluate(async () => (await import("/src/swap/evm-swap-recovery.ts")).readEvmSwapRecoveryJournal());
const active = page => page.evaluate(async () => (await import("/src/v01/active-operation.ts")).readActiveV01Operation());
const idle = page => page.waitForFunction(() => !document.querySelector(".v01-notice")?.textContent?.includes("処理中"));
async function until(predicate) {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > 30_000) throw new Error("QA_WAIT_TIMEOUT"); await new Promise(done => setTimeout(done, 100)); }
}
async function failNextStorageCall(page, method, key) {
  await page.evaluate(({ method: name, key: target }) => {
    window.__qaStorageFaultHits = 0;
    const prototype = Storage.prototype;
    const original = prototype[name];
    prototype[name] = function (...args) {
      if (args[0] === target) { prototype[name] = original; window.__qaStorageFaultHits++; throw new Error(`QA_ONE_SHOT_${name.toUpperCase()}_FAILURE`); }
      return original.apply(this, args);
    };
  }, { method, key });
}
async function resetKeyboardFocus(page, button) {
  await button.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  assert.equal(await button.evaluate(element => document.activeElement === element && !element.disabled), true);
}
async function verify(page) {
  await page.getByLabel("公開RPC A", { exact: true }).fill(rpcUrls[0]);
  await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(rpcUrls[1]);
  await page.getByRole("button", { name: "配置記録とトークンを照合", exact: true }).click();
  await page.getByText("照合済み（短時間のみ有効）", { exact: true }).waitFor(); await idle(page);
  assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
}
async function runCase(mode) {
  process.stdout.write(`START ${mode}\n`);
  const folder = resolve(output, mode); await mkdir(folder, { recursive: true });
  const fixture = await createV01BrowserFixture();
  const role = mode.startsWith("approval-") ? "approval" : "swap";
  const replacementMode = role === "approval" ? mode.slice("approval-".length) : mode;
  const expectedStage = role === "approval"
    ? (replacementMode === "repriced" ? "approval-confirmed" : "approval-replaced")
    : (replacementMode === "repriced" ? "swap-confirmed" : "swap-replaced");
  const closeEligible = role === "swap" || replacementMode !== "repriced";
  let configuration;
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false }, optimizeDeps: { entries: ["index.html"] }, clearScreen: false,
    plugins: [{ name: "replacement-local-test-entry", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/qa-replacement.html") return next();
        try {
          const html = await vite.transformIndexHtml(req.url, `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LOCAL REPLACEMENT QA</title></head><body><div id="root"></div><script type="module">
            import React from 'react'; import {createRoot} from 'react-dom/client'; import V01App from '/src/v01/V01App.tsx'; import '/src/styles.css';
            createRoot(document.getElementById('root')).render(React.createElement(V01App, {configuration:${JSON.stringify(configuration)}}));
          </script></body></html>`);
          res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
        } catch (error) { next(error); }
      });
    } }] });
  const { v01ProfileFingerprint } = await server.ssrLoadModule("/src/release/v01-profile.ts");
  configuration = { profile: fixture.profile, pin: { releaseId: fixture.profile.deployment.releaseId, bundleSha256: fixture.profile.deployment.source.bundleSha256, profileFingerprint: v01ProfileFingerprint(fixture.profile) } };
  await server.listen(); const origin = server.resolvedUrls.local[0];
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
  context.setDefaultTimeout(30_000); context.setDefaultNavigationTimeout(60_000);
  if (captureErrors) await context.addInitScript(() => {
    // Diagnostic-only constructor observer: no debugger pauses or app source
    // transform. Do not use this instrumented run as acceptance evidence.
    window.__qaRecoveryErrors = [];
    const NativeError = window.Error;
    window.Error = new Proxy(NativeError, { construct(target, args, newTarget) {
      const result = Reflect.construct(target, args, newTarget);
      if (typeof args[0] === "string" && args[0].startsWith("V01_REPLACEMENT_RECOVERY_") && window.__qaRecoveryErrors.length < 50) window.__qaRecoveryErrors.push({ at: Date.now(), message: args[0], stack: result.stack });
      return result;
    } });
  });
  let replacement, corruptReader = false, reads = 0, corruptedResponses = 0;
  const errors = [], external = [], readerIds = new Set();
  await context.exposeBinding("qaWalletRequest", async (_source, request) => fixture.wallet(request.method, request.params ?? []));
  await context.addInitScript(() => {
    const listeners = new Map();
    const provider = { request: request => window.qaWalletRequest(request), on: (event, handler) => { const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); }, removeListener: (event, handler) => listeners.get(event)?.delete(handler) };
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
      info: { uuid: "00000000-0000-4000-8000-000000000911", name: "LOCAL TEST TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" }, provider
    } })));
  });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(origin).origin) return route.continue();
    if (!rpcUrls.includes(url.href)) { external.push(url.origin); return route.abort(); }
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    assert.equal(request.method(), "POST"); reads++; readerIds.add(url.href);
    const reply = async item => {
      const result = structuredClone(await fixture.rpc(item.method, item.params ?? []));
      if (corruptReader && url.href === rpcUrls[1] && item.method === "eth_getTransactionByHash" && item.params[0] === replacement?.hash) { result.nonce = "0xffff"; corruptedResponses++; }
      return { jsonrpc: "2.0", id: item.id, result };
    };
    const payload = request.postDataJSON(), body = Array.isArray(payload) ? await Promise.all(payload.map(reply)) : await reply(payload);
    return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const page = await context.newPage();
  const exceptions = [];
  if (traceExceptions) {
    // Diagnostic only: pausing can affect deadlines, so never label this run PASS.
    const cdp = await context.newCDPSession(page);
    cdp.on("Debugger.paused", async event => {
      exceptions.push({ reason: event.reason, description: event.data?.description, frames: event.callFrames.slice(0, 4).map(frame => ({ name: frame.functionName, location: frame.location })) });
      await cdp.send("Debugger.resume");
    });
    await cdp.send("Debugger.enable"); await cdp.send("Debugger.setPauseOnExceptions", { state: "all" });
  }
  try {
    await page.goto(new URL("qa-replacement.html", origin).href, { waitUntil: "domcontentloaded" });
    await verify(page);
    await page.getByLabel(/^MetaMask候補/).selectOption("00000000-0000-4000-8000-000000000911");
    await page.getByRole("button", { name: "選択したウォレットに接続", exact: true }).click(); await idle(page);
    const before = await fixture.balances();
    await page.getByLabel(/^支払数量/).fill("5");
    await page.getByRole("button", { name: "見積りを取得", exact: true }).click(); await page.locator(".v01-review").waitFor(); await idle(page);
    if (role === "approval") fixture.setPendingApproval(true); else fixture.setPendingSwap(true);
    await page.locator("button.v01-primary").click();
    await until(async () => (await journal(page))[0]?.transactions.some(tx => tx.role === role));
    const pending = (await journal(page))[0], savedActive = await active(page);
    for (const transaction of pending.transactions) {
      const attempt = savedActive.attempts.find(item => item.role === transaction.role);
      assert.ok(attempt, "Every new journal transaction must have its write-ahead attempt");
      assert.equal(transaction.envelope.observedBeforeBlock, attempt.observedBeforeBlock, "Recovery start must match the persisted pre-wallet observation");
    }
    assert.equal(fixture.stats.sends.length, role === "approval" ? 1 : 2);
    assert.equal(pending.stage, role === "approval" ? "approval-submitted" : "swap-submitted");
    assert.equal(pending.transactions.length, role === "approval" ? 1 : 2);
    if (role === "approval") {
      assert.ok(pending.transactions.every(tx => tx.role === "approval"));
      assert.deepEqual(savedActive.attempts.map(attempt => attempt.role), ["approval"]);
      assert.equal(fixture.stats.sends.some(send => send.transaction.to.toLowerCase() === fixture.addresses.pool.toLowerCase()), false);
      assert.equal(await fixture.allowance(), "0");
    }
    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { level: 1 }).waitFor();
    // The reload above is deliberate: the durable write-ahead approval journal
    // must exist before the same-nonce replacement is introduced.
    replacement = await (role === "approval" ? fixture.replacePendingApproval(replacementMode) : fixture.replacePendingSwap(replacementMode));
    assert.equal(replacement.receipt.status, "0x1");
    assert.equal(await fixture.rpc("eth_getTransactionReceipt", [pending.transactions.at(-1).hash]), null);
    const after = await fixture.balances();
    if (role === "approval") {
      assert.deepEqual(after, before);
      assert.equal(await fixture.allowance(), replacementMode === "repriced" ? (5n * 10n ** 18n).toString() : "0");
      assert.equal(fixture.stats.sends.length, 1);
      assert.equal(fixture.stats.sends.some(send => send.transaction.to.toLowerCase() === fixture.addresses.pool.toLowerCase()), false);
    } else if (replacementMode === "repriced") {
      assert.equal(BigInt(before.ambr) - BigInt(after.ambr), 5n * 10n ** 18n); assert.ok(BigInt(after.jade) > BigInt(before.jade));
    } else assert.deepEqual(after, before);
    assert.deepEqual(await active(page), savedActive);
    if (role === "approval") {
      // A fresh page/profile must still discover the durable approval outcome;
      // it must never resume execution and submit the swap automatically.
      await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { level: 1 }).waitFor();
      await verify(page);
      assert.equal(fixture.stats.sends.length, 1);
      assert.equal(fixture.stats.sends.some(send => send.transaction.to.toLowerCase() === fixture.addresses.pool.toLowerCase()), false);
    }
    await verify(page);
    await page.getByRole("button", { name: "設定済みRPCで取引状況を照会（読み取りのみ）", exact: true }).click(); await idle(page);
    const recovered = (await journal(page))[0];
    assert.equal(recovered.transactions.at(-1).hash, pending.transactions.at(-1).hash);
    assert.equal(recovered.transactions.at(-1).envelope.replacement.hash, replacement.hash);
    assert.equal(recovered.transactions.at(-1).envelope.replacement.reason, replacementMode);
    assert.equal(recovered.stage, expectedStage);
    assert.equal(recovered.transactions.length, role === "approval" ? 1 : 2);
    assert.notEqual(recovered.transactions.at(-1).hash.toLowerCase(), replacement.hash.toLowerCase());
    if (role === "approval") {
      assert.ok(recovered.transactions.every(tx => tx.role === "approval"));
      assert.equal(fixture.stats.sends.length, 1);
      assert.equal(fixture.stats.sends.some(send => send.transaction.to.toLowerCase() === fixture.addresses.pool.toLowerCase()), false);
    }
    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { level: 1 }).waitFor();
    assert.deepEqual((await journal(page))[0], recovered); await verify(page);
    const matrix = [];
    let final = recovered, storageFaultEvidence = null;
    if (closeEligible) {
      readerIds.clear();
      corruptReader = true;
      await page.getByRole("button", { name: closeName, exact: true }).click(); await idle(page);
      await page.getByRole("alert").filter({ hasText: "V01_REPLACEMENT_RECOVERY_MISMATCH" }).waitFor();
      assert.equal(readerIds.size, 2);
      assert.equal(corruptedResponses, 1, "The intended bad-reader response must actually reach verification");
      assert.deepEqual(await active(page), savedActive); assert.deepEqual((await journal(page))[0], recovered);
      corruptReader = false;
      for (const [width, scale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => { document.documentElement.style.fontSize = `${value * 100}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(async () => {
          let previous = "", stable = 0;
          for (let frame = 0; frame < 120; frame++) {
            await new Promise(done => requestAnimationFrame(done));
            const next = JSON.stringify([innerWidth, document.documentElement.scrollHeight]);
            stable = next === previous ? stable + 1 : 0; previous = next;
            if (stable >= 4) return;
          }
          throw new Error("QA_LAYOUT_UNSTABLE");
        });
        const target = page.getByRole("button", { name: closeName, exact: true });
        await resetKeyboardFocus(page, target);
        await page.waitForFunction(element => { const rect = element.getBoundingClientRect(); return document.activeElement === element && rect.top >= 0 && rect.bottom <= innerHeight; }, await target.elementHandle());
        await focusSettled(page);
        const focus = await target.evaluate(element => { const rect = element.getBoundingClientRect(), css = getComputedStyle(element); return { active: document.activeElement === element, visible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth, outline: css.outlineStyle, outlineWidth: css.outlineWidth, overflow: document.documentElement.scrollWidth > innerWidth }; });
        assert.ok(focus.active && focus.visible && !focus.overflow && focus.outline !== "none" && parseFloat(focus.outlineWidth) >= 2, JSON.stringify(focus));
        await page.screenshot({ path: resolve(folder, `close-${width}-text${scale}.png`), animations: "disabled" }); matrix.push({ width, scale, focus });
      }
      // The error exercise and screenshot matrix are separate from the user retry.
      // Renew the short-lived profile, clearing the previous alert before testing
      // persistence. Do not let an old error satisfy the new attempt's wait.
      await verify(page);
      assert.equal((await fixture.rpc("eth_getTransactionByHash", [replacement.hash])).nonce, replacement.transaction.nonce);
      readerIds.clear();
      const closeFailure = mode === "repriced" ? "journal" : mode === "cancelled" && role === "swap" ? "active" : null;
      const failureJournal = (await journal(page))[0], failureActive = await active(page);
      if (closeFailure === "journal") await failNextStorageCall(page, "setItem", recoveryKey);
      if (closeFailure === "active") await failNextStorageCall(page, "removeItem", activeKey);
      // Re-establish keyboard position after screenshot capture; capture may change
      // browser focus. Never infer that a prior focus observation means Enter ran.
      const closeButton = page.getByRole("button", { name: closeName, exact: true });
      await resetKeyboardFocus(page, closeButton);
      await page.keyboard.press("Enter");
      // Requests having started is not a completed close. Wait for its actual
      // storage boundary (fault) or durable cleared state (success), not stale UI.
      await until(async () => {
        const reached = closeFailure ? await page.evaluate(() => window.__qaStorageFaultHits === 1) : await active(page) === null;
        if (!reached) {
          const alert = await page.getByRole("alert").allTextContents();
          // verify() cleared the previous alert. Do not wait for a storage fault
          // after this distinct attempt has already failed its read-only check.
          if (alert.length) throw new Error(`QA_CLOSE_STOPPED_BEFORE_STORAGE: ${alert.join(" ")}`);
        }
        return reached;
      });
      await idle(page);
      if (closeFailure) {
        assert.equal(await page.evaluate(() => window.__qaStorageFaultHits), 1);
        await page.getByRole("alert").waitFor();
        assert.deepEqual(await active(page), failureActive);
        const failedJournal = (await journal(page))[0];
        if (closeFailure === "journal") assert.deepEqual(failedJournal, failureJournal);
        else assert.ok(failedJournal.revision > failureJournal.revision);
        storageFaultEvidence = { kind: closeFailure, hits: 1, beforeRevision: failureJournal.revision, afterRevision: failedJournal.revision, guardRetained: true };
        await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { level: 1 }).waitFor();
        await verify(page); readerIds.clear();
        const retryButton = page.getByRole("button", { name: closeName, exact: true });
        await resetKeyboardFocus(page, retryButton); await page.keyboard.press("Enter");
        await until(async () => await active(page) === null); await idle(page);
        assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
        await until(async () => await active(page) === null);
      } else {
        assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
        await until(async () => await active(page) === null);
      }
      assert.equal(readerIds.size, 2); assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
      if ((role === "swap" && replacementMode !== "repriced") || role === "approval") assert.match(await page.locator(".v01-notice").innerText(), /元の交換の成功を意味しません/);
      final = (await journal(page))[0];
      assert.equal(final.stage, recovered.stage); assert.equal(final.transactions.at(-1).hash.toLowerCase(), pending.transactions.at(-1).hash.toLowerCase()); assert.equal(final.transactions.at(-1).envelope.replacement.hash, replacement.hash);
    } else {
      assert.equal(await page.getByRole("button", { name: closeName, exact: true }).count(), 0);
      assert.deepEqual(await active(page), savedActive);
      assert.equal(fixture.stats.sends.length, 1);
      assert.equal(fixture.stats.sends.some(send => send.transaction.to.toLowerCase() === fixture.addresses.pool.toLowerCase()), false);
    }
    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { level: 1 }).waitFor();
    assert.deepEqual(await active(page), closeEligible ? null : savedActive); assert.deepEqual((await journal(page))[0], final);
    assert.equal(fixture.stats.sends.length, role === "approval" ? 1 : 2); assert.equal(fixture.stats.connectionRequests, 1); assert.deepEqual(await fixture.balances(), after);
    if (role === "approval") assert.equal(await fixture.allowance(), replacementMode === "repriced" ? (5n * 10n ** 18n).toString() : "0");
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(await readFile("src/v01/reviewed-profile.ts", "utf8"), originalConfiguration);
    const report = { mode, role, browser: await browser.version(), scope: "Synthetic wallet/local contracts/shared reader backend only; not public MetaMask acceptance", appRawSends: role === "approval" ? 1 : 2, explicitLocalReplacementSends: 1, reads, before, after, approvalAllowance: role === "approval" ? await fixture.allowance() : null, replacement, recovered, final, matrix, storageFaultEvidence, readerDisagreementBlocked: closeEligible, noAutomaticResendOrConnect: true, pageErrors: errors, externalRequests: external, reviewedConfigurationUnchanged: true };
    await writeFile(resolve(folder, "report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${diagnosticOnly ? "DIAGNOSTIC_ONLY" : "PASS"} ${mode}: ${reads} reads, ${role === "approval" ? 1 : 2} app sends + 1 deliberate local replacement, ${matrix.length} layouts\n`);
    return report;
  } catch (error) { const state = await page.evaluate(() => ({ storageFaultHits: window.__qaStorageFaultHits, focus: document.activeElement?.tagName, rootChildren: document.getElementById("root")?.children.length })); await page.screenshot({ path: resolve(folder, "failure.png") }).catch(() => {}); await writeFile(resolve(folder, "failure.txt"), `${error.stack}\n${JSON.stringify(state)}\n${await page.locator("body").innerText()}`); throw error; }
  finally {
    if (traceExceptions) await writeFile(resolve(folder, "diagnostic-exceptions.json"), JSON.stringify(exceptions, null, 2));
    if (captureErrors) await writeFile(resolve(folder, "diagnostic-errors.json"), JSON.stringify(await page.evaluate(() => window.__qaRecoveryErrors), null, 2));
    await context.close(); await server.close(); await fixture.dispose();
  }
}
try { const reports = []; for (const mode of selectedMode ? [selectedMode] : modes) reports.push(await runCase(mode)); await finishReport(output, { status: diagnosticOnly ? "DIAGNOSTIC_ONLY" : "PASS", reports }); }
finally { await browser.close(); }
