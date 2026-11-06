import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { Interface, parseUnits } from "ethers";
import { createV01BrowserFixture } from "./v01BrowserFixture.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";
import { focusSettled } from "./v01FocusSettled.mjs";

// Test-only local browser flow. Every user action below is keyboard input; DOM
// queries/evaluate are read-only observations and assertions only.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIR");
const output = resolve(outputDirectory);
await beginReport(output);
// playwright-core is CommonJS, so Node does not expose `chromium` as a named export
// and destructuring it yields undefined — a failure that only surfaces much later as
// "Cannot read properties of undefined (reading 'launch')". Accept either shape.
const playwrightModuleExports = await import(pathToFileURL(resolve(playwrightModule)).href);
const chromium = playwrightModuleExports.chromium ?? playwrightModuleExports.default?.chromium;
if (!chromium) throw new Error("PLAYWRIGHT_MODULE_HAS_NO_CHROMIUM: " + playwrightModule);
const shippedProfile = await readFile("src/v01/reviewed-profile.ts", "utf8");
const fixture = await createV01BrowserFixture();
let configuration;
const qaPath = "/qa-keyboard.html";
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, open: false }, optimizeDeps: { entries: ["index.html"] }, clearScreen: false,
  plugins: [{ name: "test-only-v01-keyboard-entry", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== qaPath) return next();
      try {
        const html = await vite.transformIndexHtml(qaPath, `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RealDEX LOCAL SYNTHETIC KEYBOARD QA ONLY</title></head><body><div id="root"></div><script type="module">
          import React from 'react'; import { createRoot } from 'react-dom/client';
          import V01App from '/src/v01/V01App.tsx'; import '/src/styles.css';
          createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(V01App, { configuration: ${JSON.stringify(configuration)} })));
        </script></body></html>`);
        res.statusCode = 200; res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
      } catch (error) { next(error); }
    });
  } }]
});

let browser, context;
const errors = [], blockedExternal = [], keyboardSteps = [];
let interceptedRpc = 0;
const rpcUrls = ["https://hardhat-a.example/", "https://hardhat-b.example/"];
const log = message => process.stdout.write(`${message}\n`);
const journal = page => page.evaluate(async () => (await import("/src/swap/evm-swap-recovery.ts")).readEvmSwapRecoveryJournal());
const active = page => page.evaluate(async () => (await import("/src/v01/active-operation.ts")).readActiveV01Operation());
async function idle(page) {
  await page.waitForFunction(() => !document.querySelector(".v01-notice")?.textContent?.includes("処理中"));
  assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
}
async function focusDetails(page) {
  await focusSettled(page);
  return page.evaluate(() => { const e = document.activeElement, rect = e?.getBoundingClientRect(), css = e && getComputedStyle(e); return { tag: e?.tagName, type: e?.getAttribute("type"), label: e?.getAttribute("aria-label"), name: e?.getAttribute("name"), text: (e?.textContent ?? "").trim().slice(0, 80), visible: !!rect && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth, outline: css && { style: css.outlineStyle, width: css.outlineWidth }, rect: rect && { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } }; });
}
async function tabTo(page, locator, name, limit = 180) {
  assert.equal(await locator.count(), 1, `${name}: target count`);
  for (let index = 0; index < limit; index++) {
    if (await locator.evaluate(element => document.activeElement === element)) {
      const focus = await focusDetails(page);
      assert.ok(focus.visible && focus.outline.style !== "none" && parseFloat(focus.outline.width) >= 2, `${name}: keyboard focus not visibly outlined: ${JSON.stringify(focus)}`);
      keyboardSteps.push({ action: "focus", name, tabs: index, active: focus });
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`QA_KEYBOARD_TAB_BOUND:${name}`);
}
async function typeInto(page, locator, value, name) {
  await tabTo(page, locator, name);
  await page.keyboard.press("Control+A"); await page.keyboard.type(value);
  assert.equal(await locator.inputValue(), value, `${name}: typed value`);
  keyboardSteps.push({ action: "type", name, value, active: await focusDetails(page) });
}
async function pressButton(page, locator, name, key = "Enter") {
  await tabTo(page, locator, name); assert.equal(await locator.isDisabled(), false, `${name}: disabled`);
  await page.keyboard.press(key); keyboardSteps.push({ action: key, name, active: await focusDetails(page) });
}
async function choose(page, locator, moves, name, expectedValue = undefined) {
  await tabTo(page, locator, name); await page.keyboard.press("Home");
  for (let i = 0; i < moves; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter"); keyboardSteps.push({ action: "select", name, moves, active: await focusDetails(page) });
  if (expectedValue !== undefined) assert.equal(await locator.inputValue(), expectedValue, `${name}: selected value`);
}
async function verify(page) {
  await typeInto(page, page.getByLabel("公開RPC A", { exact: true }), rpcUrls[0], "RPC A");
  await typeInto(page, page.getByLabel("公開RPC B（別ホスト）", { exact: true }), rpcUrls[1], "RPC B");
  await pressButton(page, page.getByRole("button", { name: "配置記録とトークンを照合", exact: true }), "verify");
  await page.getByText("照合済み（短時間のみ有効）", { exact: true }).waitFor(); await idle(page);
}
async function connect(page) {
  await choose(page, page.getByLabel(/^MetaMask候補/), 1, "wallet candidate", "00000000-0000-4000-8000-000000000911");
  await pressButton(page, page.getByRole("button", { name: "選択したウォレットに接続", exact: true }), "connect");
  const observedAddress = page.locator(".v01-address"); assert.ok(await observedAddress.count() > 0, "observed source selector .v01-address missing");
  await observedAddress.filter({ hasText: fixture.account }).waitFor(); await idle(page);
}
async function quote(page, reverse = false) {
  await choose(page, page.getByLabel(/^交換方向/), reverse ? 1 : 0, reverse ? "reverse direction" : "forward direction", reverse ? "reverse" : "forward");
  await typeInto(page, page.getByLabel(/^支払数量/), "5", reverse ? "JADE amount" : "AMBR amount");
  await pressButton(page, page.getByRole("button", { name: "見積りを取得", exact: true }), "quote");
  await page.locator(".v01-review").waitFor(); await idle(page);
}
async function reviewValues(page) {
  return page.locator(".v01-review").evaluate(element => {
    const fields = list => Object.fromEntries([...list.querySelectorAll("dt")].map(term => [term.textContent, term.nextElementSibling.textContent]));
    return { summary: fields(element.querySelector("dl")), fees: [...element.querySelectorAll("details dl")].map(fields) };
  });
}
function assertSends(sends, review, token) {
  assert.equal(sends.length, 2); const approval = new Interface(["function approve(address spender,uint256 amount)"]);
  const swap = new Interface(["function swapExactIn(address tokenIn,uint256 amountIn,uint256 minAmountOut,address to,uint256 deadline)"]);
  const a = sends[0].transaction, s = sends[1].transaction;
  const ap = approval.parseTransaction({ data: a.data }), sw = swap.parseTransaction({ data: s.data });
  const amount = parseUnits(review.summary["支払"].split(" ")[0], 18), minimum = parseUnits(review.summary["最低受取"].split(" ")[0], 18);
  assert.equal(a.to.toLowerCase(), token.toLowerCase()); assert.equal(ap.args[0].toLowerCase(), review.summary["承認先・交換先"].toLowerCase()); assert.equal(ap.args[1], amount);
  assert.equal(s.to.toLowerCase(), review.summary["承認先・交換先"].toLowerCase()); assert.equal(sw.args[0].toLowerCase(), token.toLowerCase()); assert.equal(sw.args[1], amount); assert.equal(sw.args[2], minimum); assert.equal(sw.args[3].toLowerCase(), review.summary["受取先"].toLowerCase());
  for (const tx of [a, s]) { assert.equal(tx.from.toLowerCase(), fixture.account.toLowerCase()); assert.equal(BigInt(tx.chainId), 84532n); assert.equal(BigInt(tx.value ?? 0), 0n); }
}
async function recoverAndClose(page, expectedRecords) {
  const saved = await journal(page), held = await active(page), sends = fixture.stats.sends.length, connections = fixture.stats.connectionRequests, balancesBefore = await fixture.balances();
  assert.equal(saved.length, expectedRecords); assert.ok(held?.recoveryId);
  await fixture.mine(); await fixture.mine(); await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByText("未解決または確認待ちの操作があります", { exact: false }).waitFor();
  assert.deepEqual(await journal(page), saved); assert.deepEqual(await active(page), held); assert.equal(fixture.stats.sends.length, sends); assert.equal(fixture.stats.connectionRequests, connections);
  await verify(page);
  await pressButton(page, page.getByRole("button", { name: "設定済みRPCで取引状況を照会（読み取りのみ）" }), "unsigned refresh"); await idle(page);
  await waitUntil(async () => (await journal(page)).find(record => record.recoveryId === held.recoveryId)?.stage === "swap-confirmed", "unsigned refresh journal stage");
  const current = (await journal(page)).find(record => record.recoveryId === held.recoveryId);
  assert.equal(current.stage, "swap-confirmed"); assert.ok(current.transactions.find(tx => tx.role === "swap").confirmations >= 2);
  await pressButton(page, page.getByRole("button", { name: "照会済みの操作を終了し、新しい見積りへ" }), "deliberate close"); await idle(page);
  await waitUntil(async () => (await active(page)) === null, "deliberate close active operation clear");
  await waitUntil(async () => (await journal(page)).length === expectedRecords, "deliberate close journal durable");
  assert.deepEqual(await fixture.balances(), balancesBefore, "unsigned recovery/close changed balances");
  assert.equal(fixture.stats.sends.length, sends); assert.equal(fixture.stats.connectionRequests, connections); return { record: current, sends, balancesBefore };
}

async function waitUntil(predicate, description, timeout = 30_000) {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > timeout) throw new Error(`QA timeout: ${description}`); await new Promise(resolveWait => setTimeout(resolveWait, 50)); }
}

async function openReviewDetails(page, direction) {
  const review = page.locator(".v01-review"), summaries = review.locator("details summary");
  for (let index = 0; index < await summaries.count(); index++) {
    const summary = summaries.nth(index);
    await tabTo(page, summary, `${direction} fee details ${index + 1}`);
    if (!await summary.evaluate(element => element.parentElement.open)) await page.keyboard.press("Enter");
    assert.equal(await summary.evaluate(element => element.parentElement.open), true);
  }
  await review.screenshot({ path: resolve(output, `${direction}-review.png`) });
}

try {
  const { v01ProfileFingerprint } = await server.ssrLoadModule("/src/release/v01-profile.ts");
  configuration = { profile: fixture.profile, pin: { releaseId: fixture.profile.deployment.releaseId, bundleSha256: fixture.profile.deployment.source.bundleSha256, profileFingerprint: v01ProfileFingerprint(fixture.profile) } };
  await server.listen(); const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
  await context.exposeBinding("qaWalletRequest", async (_source, request) => { try { return { ok: true, value: await fixture.wallet(request.method, request.params ?? []) }; } catch (error) { return { ok: false, message: error.message, code: error.code }; } });
  await context.addInitScript(() => { const listeners = new Map(); const provider = { request: async request => { const result = await window.qaWalletRequest(request); if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code }); return result.value; }, on: (event, handler) => { const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); }, removeListener: (event, handler) => listeners.get(event)?.delete(handler) }; window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "00000000-0000-4000-8000-000000000911", name: "LOCAL TEST TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" }, provider } }))); });
  await context.route("**/*", async route => { const request = route.request(), url = new URL(request.url()); if (url.origin === new URL(origin).origin) return route.continue(); if (!rpcUrls.includes(url.href)) { blockedExternal.push(url.origin); return route.abort(); } const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" }; if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers }); assert.equal(request.method(), "POST"); interceptedRpc++; const payload = request.postDataJSON(); const respond = async item => { try { return { jsonrpc: "2.0", id: item.id, result: await fixture.rpc(item.method, item.params ?? []) }; } catch (error) { return { jsonrpc: "2.0", id: item.id, error: { code: -32000, message: error.message } }; } }; const body = Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload); return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(body) }); });
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const page = await context.newPage(); await page.goto(new URL(qaPath, origin).href, { waitUntil: "domcontentloaded", timeout: 60_000 }); await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 60_000 });
  assert.equal(fixture.stats.connectionRequests, 0); assert.equal(fixture.stats.sends.length, 0); await verify(page); await connect(page); await quote(page);
  const forwardReview = await reviewValues(page);
  await openReviewDetails(page, "forward");
  const forwardBalancesBefore = await fixture.balances();
  await pressButton(page, page.getByRole("button", { name: /承認して交換/ }), "forward send");
  await waitUntil(() => fixture.stats.sends.length === 2, "forward approval and swap sends"); await idle(page);
  assertSends(fixture.stats.sends.slice(0, 2), forwardReview, fixture.addresses.ambr);
  const forward = await recoverAndClose(page, 1);
  await page.locator(".swap-recovery").screenshot({ path: resolve(output, "forward-recovered.png") });
  const forwardBalancesAfter = await fixture.balances();
  assert.equal(BigInt(forwardBalancesBefore.ambr) - BigInt(forwardBalancesAfter.ambr), 5n * 10n ** 18n); assert.ok(BigInt(forwardBalancesAfter.jade) > BigInt(forwardBalancesBefore.jade));
  await connect(page);
  await quote(page, true); const reverseReview = await reviewValues(page);
  await openReviewDetails(page, "reverse");
  const reverseBalancesBefore = await fixture.balances();
  await pressButton(page, page.getByRole("button", { name: /承認して交換/ }), "reverse send");
  await waitUntil(() => fixture.stats.sends.length === 4, "reverse approval and swap sends"); await idle(page);
  assertSends(fixture.stats.sends.slice(2, 4), reverseReview, fixture.addresses.jade);
  const reverse = await recoverAndClose(page, 2);
  await page.locator(".swap-recovery").screenshot({ path: resolve(output, "reverse-recovered.png") });
  const reverseBalancesAfter = await fixture.balances();
  assert.equal(BigInt(reverseBalancesBefore.jade) - BigInt(reverseBalancesAfter.jade), 5n * 10n ** 18n); assert.ok(BigInt(reverseBalancesAfter.ambr) > BigInt(reverseBalancesBefore.ambr));
  // This run renders V01App with a configuration prop built from the local fixture, so
  // the committed one is never read by the page. The rule worth asserting is that this
  // harness leaves it alone and never leaks its fixture into it. It used to assert the
  // committed value was `= null` as well, which held only while the build shipped no
  // profile — a statement of the circumstances rather than of the rule, and it made the
  // harness unrunnable the moment a real deployment was pinned.
  assert.equal(shippedProfile, await readFile("src/v01/reviewed-profile.ts", "utf8"));
  assert.ok(!shippedProfile.includes(fixture.profile.deployment.releaseId), "the committed configuration must never carry this fixture's release"); assert.deepEqual(blockedExternal, []); assert.deepEqual(errors, []);
  const report = { result: "PASS", scope: "local synthetic Hardhat fixture, fresh Chrome, keyboard-only normal flow", viewport: { width: 1280, height: 1000 }, directions: { forward: forward.record, reverse: reverse.record }, broadcasts: fixture.stats.sends, keyboardSteps, rawBroadcastCount: fixture.stats.sends.length, connectionRequests: fixture.stats.connectionRequests, interceptedRpc, publicRequests: 0, shippedReviewedProfileUnchanged: true, noExternalTraffic: true, noAutomaticConnectOrSendAfterReload: true, journalPreservedAcrossReload: true, unsignedRefreshAndDeliberateClose: true };
  await finishReport(output, report); log(JSON.stringify({ result: "PASS", directions: 2, keyboardSteps: keyboardSteps.length, rawBroadcastCount: report.rawBroadcastCount, interceptedRpc, publicRequests: 0 }));
} catch (error) {
  const page = context?.pages()[0];
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  await writeFile(resolve(output, "failure.json"), JSON.stringify({ message: error.message, errors, blockedExternal, keyboardSteps }, null, 2)); throw error;
} finally { await context?.close(); await browser?.close(); await server.close(); await fixture.dispose?.(); }
