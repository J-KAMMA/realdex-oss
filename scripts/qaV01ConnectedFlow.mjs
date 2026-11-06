import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { Interface, parseUnits } from "ethers";
import { createV01BrowserFixture } from "./v01BrowserFixture.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";
import { focusSettled } from "./v01FocusSettled.mjs";

// Test-only entry, isolated Hardhat and fresh Chrome. No shipped configuration override,
// user profile, actual extension, secret, external RPC or public broadcast is used.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");
const output = resolve(outputDirectory);
await beginReport(output);
// playwright-core is CommonJS, so Node does not expose `chromium` as a named export
// and destructuring it yields undefined — a failure that only surfaces much later as
// "Cannot read properties of undefined (reading 'launch')". Accept either shape.
const playwrightModuleExports = await import(pathToFileURL(resolve(playwrightModule)).href);
const chromium = playwrightModuleExports.chromium ?? playwrightModuleExports.default?.chromium;
if (!chromium) throw new Error("PLAYWRIGHT_MODULE_HAS_NO_CHROMIUM: " + playwrightModule);
const originalConfiguration = await readFile("src/v01/reviewed-profile.ts", "utf8");
const fixture = await createV01BrowserFixture();
let configuration;
const qaPath = "/qa-connected.html";
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, open: false },
  optimizeDeps: { entries: ["index.html"] },
  clearScreen: false,
  plugins: [{
    name: "test-only-v01-connected-entry",
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== qaPath) return next();
        try {
          const html = await vite.transformIndexHtml(qaPath, `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RealDEX LOCAL SYNTHETIC QA ONLY</title></head><body><div id="root"></div><script type="module">
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import V01App from '/src/v01/V01App.tsx';
            import '/src/styles.css';
            createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(V01App, { configuration: ${JSON.stringify(configuration)} })));
          </script></body></html>`);
          res.statusCode = 200; res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
        } catch (error) { next(error); }
      });
    }
  }]
});
let browser, context;
const errors = [], blockedExternal = [], observations = [];
let interceptedRpc = 0;
const rpcUrls = ["https://hardhat-a.example/", "https://hardhat-b.example/"];
const log = message => process.stdout.write(`${message}\n`);

async function waitUntil(predicate, description, timeout = 30_000) {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeout) throw new Error(`QA timeout: ${description}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
}

async function idle(page, allowExpectedError = false) {
  await page.waitForFunction(() => !document.querySelector(".v01-notice")?.textContent?.includes("処理中"));
  const alerts = await page.getByRole("alert").allTextContents();
  if (!allowExpectedError) assert.deepEqual(alerts, [], `Unexpected application error: ${alerts.join(" ")}`);
}

async function verify(page) {
  await page.getByLabel("公開RPC A", { exact: true }).fill(rpcUrls[0]);
  await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(rpcUrls[1]);
  await page.getByRole("button", { name: "配置記録とトークンを照合", exact: true }).click();
  await page.getByText("照合済み（短時間のみ有効）", { exact: true }).waitFor();
  await idle(page);
}

async function connect(page) {
  await page.getByLabel(/^MetaMask候補/).selectOption("00000000-0000-4000-8000-000000000911");
  await page.getByRole("button", { name: "選択したウォレットに接続", exact: true }).click();
  await page.locator(".v01-address").filter({ hasText: fixture.account }).waitFor();
  await idle(page);
}

async function quote(page, direction = "forward") {
  await page.getByLabel(/^交換方向/).selectOption(direction);
  await page.getByLabel(/^支払数量/).fill("5");
  await page.getByRole("button", { name: "見積りを取得", exact: true }).click();
  await page.locator(".v01-review").waitFor();
  await idle(page);
}

async function journal(page) {
  return page.evaluate(async () => (await import("/src/swap/evm-swap-recovery.ts")).readEvmSwapRecoveryJournal());
}

async function active(page) {
  return page.evaluate(async () => (await import("/src/v01/active-operation.ts")).readActiveV01Operation());
}

async function reviewValues(page) {
  return page.locator(".v01-review").evaluate(element => {
    const fields = list => Object.fromEntries([...list.querySelectorAll("dt")].map(term => [term.textContent, term.nextElementSibling.textContent]));
    return { summary: fields(element.querySelector("dl")), fees: [...element.querySelectorAll("details dl")].map(fields) };
  });
}

function assertReviewedSends(sends, review, token) {
  assert.equal(sends.length, 2);
  const approvalAbi = new Interface(["function approve(address spender,uint256 amount)"]);
  const swapAbi = new Interface(["function swapExactIn(address tokenIn,uint256 amountIn,uint256 minAmountOut,address to,uint256 deadline)"]);
  const approveTx = sends[0].transaction, swapTx = sends[1].transaction;
  const approved = approvalAbi.parseTransaction({ data: approveTx.data });
  const swapped = swapAbi.parseTransaction({ data: swapTx.data });
  const amount = parseUnits(review.summary["支払"].split(" ")[0], 18);
  const minimum = parseUnits(review.summary["最低受取"].split(" ")[0], 18);
  assert.equal(approveTx.to.toLowerCase(), token.toLowerCase());
  assert.equal(approved.args[0].toLowerCase(), review.summary["承認先・交換先"].toLowerCase());
  assert.equal(approved.args[1], amount);
  assert.equal(swapTx.to.toLowerCase(), review.summary["承認先・交換先"].toLowerCase());
  assert.equal(swapped.args[0].toLowerCase(), token.toLowerCase());
  assert.equal(swapped.args[1], amount); assert.equal(swapped.args[2], minimum);
  assert.equal(swapped.args[3].toLowerCase(), review.summary["受取先"].toLowerCase());
  for (const [index, tx] of [approveTx, swapTx].entries()) {
    assert.equal(tx.from.toLowerCase(), fixture.account.toLowerCase());
    assert.equal(BigInt(tx.chainId), 84532n); assert.equal(BigInt(tx.value ?? 0), 0n);
    assert.equal(BigInt(tx.gas), BigInt(review.fees[index]["Gas limit"]));
    assert.equal(BigInt(tx.nonce), BigInt(review.fees[index].Nonce));
    assert.equal(BigInt(tx.maxFeePerGas), parseUnits(review.fees[index]["Max fee / gas"].split(" ")[0], 9));
    assert.equal(BigInt(tx.maxPriorityFeePerGas), parseUnits(review.fees[index]["Priority fee / gas"].split(" ")[0], 9));
  }
  return { amount: amount.toString(), minimum: minimum.toString() };
}

async function captureMatrix(page, state) {
  for (const [width, textScale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, textScale);
    await page.evaluate(() => document.fonts.ready);
    // Full-page screenshots temporarily change Chromium's emulated viewport. Wait for
    // resize/text reflow to settle across rendered frames before testing navigation.
    const layoutFrames = await page.evaluate(async () => {
      let previous = "", stable = 0;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
        const element = document.querySelector(".v01-review") ?? document.querySelector(".swap-recovery");
        const key = JSON.stringify([innerWidth, innerHeight, document.documentElement.scrollHeight, element?.getBoundingClientRect().height, element ? element.getBoundingClientRect().top + scrollY : null]);
        stable = key === previous ? stable + 1 : 0; previous = key;
        if (stable >= 4) return frame + 1;
      }
      throw new Error("QA_LAYOUT_DID_NOT_SETTLE");
    });
    const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(bounds.document <= width && bounds.body <= width, `${state}: ${JSON.stringify(bounds)}`);
    const target = state === "review" ? page.locator(".v01-review summary").first() : state === "retention" ? page.getByRole("button", { name: "控えを確認した1件をブラウザ履歴から削除", exact: true }) : page.getByRole("button", { name: "設定済みRPCで取引状況を照会（読み取りのみ）" });
    // Use actual Tab navigation, not programmatic focus after mouse input; the latter
    // does not require Chrome to enter :focus-visible keyboard modality.
    if (state === "review") {
      await page.getByLabel(/^スリッページ許容値/).focus();
      await page.keyboard.press("Tab"); // quote action
      await page.keyboard.press("Tab"); // first fee summary
    } else if (state === "retention") {
      await page.getByRole("checkbox", { name: "控えファイルを保存して開き、選択した履歴の内容を確認しました", exact: true }).focus();
      await page.keyboard.press("Tab");
    } else {
      await page.getByLabel(/^取引履歴/).focus();
      await page.keyboard.press("Tab"); // refresh action
    }
    const focusPhases = [];
    const inspectFocus = async phase => focusPhases.push(await target.evaluate((element, label) => ({ phase: label, top: element.getBoundingClientRect().top, scrollY, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, behavior: getComputedStyle(document.documentElement).scrollBehavior }), phase));
    await inspectFocus("focused");
    if (state === "review") {
      await page.keyboard.press("Enter");
      await inspectFocus("opened");
      assert.ok(await target.evaluate(element => element.parentElement.open));
      await page.keyboard.press("Enter");
      await inspectFocus("closed");
      assert.equal(await target.evaluate(element => element.parentElement.open), false);
    }
    await page.waitForFunction(element => {
      const rect = element.getBoundingClientRect();
      return document.activeElement === element && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
    }, await target.elementHandle(), { timeout: 3000 }).catch(async () => {
      const actual = await target.evaluate(element => ({ active: document.activeElement?.outerHTML, target: element.outerHTML, top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, scrollY }));
      throw new Error(JSON.stringify({ state, width, textScale, focusPhases, actual }));
    });
    await focusSettled(page);
    const focus = await target.evaluate(element => {
      const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
      return { active: document.activeElement === element, visible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth, rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, fontSize: css.fontSize, outline: css.outlineStyle, outlineWidth: css.outlineWidth };
    });
    assert.ok(focus.active && focus.visible && focus.outline !== "none" && parseFloat(focus.outlineWidth) >= 2, JSON.stringify({ focus, focusPhases }));
    // Capture the focused viewport first. Chromium full-page capture can change the
    // scroll position; a later viewport image would no longer depict this measurement.
    await page.screenshot({ path: resolve(output, `${state}-${width}-text${textScale}-focus.png`), animations: "disabled" });
    await page.screenshot({ path: resolve(output, `${state}-${width}-text${textScale}.png`), fullPage: true, animations: "disabled" });
    observations.push({ state, width, textScale, layoutFrames, bounds, focus, focusPhases });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
}

async function refreshAndCloseAfterReload(page, expectedRecords) {
  const sendsBefore = fixture.stats.sends.length, connectsBefore = fixture.stats.connectionRequests;
  const saved = await journal(page), reserved = await active(page);
  assert.equal(saved.length, expectedRecords);
  assert.ok(reserved?.recoveryId);
  await fixture.mine(); await fixture.mine();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByText("未解決または確認待ちの操作があります", { exact: false }).waitFor();
  assert.deepEqual(await journal(page), saved);
  assert.deepEqual(await active(page), reserved);
  assert.equal(fixture.stats.connectionRequests, connectsBefore);
  await verify(page); // Read-only recovery; do not connect the synthetic wallet.
  await page.getByRole("button", { name: "設定済みRPCで取引状況を照会（読み取りのみ）" }).click();
  await idle(page);
  const records = await journal(page);
  const current = records.find(record => record.recoveryId === reserved.recoveryId);
  assert.equal(current.stage, "swap-confirmed");
  assert.ok(current.transactions.find(transaction => transaction.role === "swap").confirmations >= 2);
  assert.equal(await page.getByRole("button", { name: "控えを確認した1件をブラウザ履歴から削除", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "照会済みの操作を終了し、新しい見積りへ", exact: true }).click();
  await idle(page);
  assert.equal(await active(page), null);
  assert.equal((await journal(page)).length, expectedRecords);
  assert.equal(fixture.stats.sends.length, sendsBefore);
  assert.equal(fixture.stats.connectionRequests, connectsBefore);
  return current;
}

try {
  const { v01ProfileFingerprint } = await server.ssrLoadModule("/src/release/v01-profile.ts");
  configuration = { profile: fixture.profile, pin: { releaseId: fixture.profile.deployment.releaseId, bundleSha256: fixture.profile.deployment.source.bundleSha256, profileFingerprint: v01ProfileFingerprint(fixture.profile) } };
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
  await context.exposeBinding("qaWalletRequest", async (_source, request) => {
    try { return { ok: true, value: await fixture.wallet(request.method, request.params ?? []) }; }
    catch (error) { return { ok: false, message: error.message, code: typeof error.code === "number" ? error.code : undefined }; }
  });
  await context.addInitScript(() => {
    const listeners = new Map();
    const provider = {
      request: async request => {
        const result = await window.qaWalletRequest(request);
        if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
        return result.value;
      },
      on: (event, handler) => { const handlers = listeners.get(event) ?? new Set(); handlers.add(handler); listeners.set(event, handlers); },
      removeListener: (event, handler) => listeners.get(event)?.delete(handler)
    };
    window.__qaEmit = event => { for (const handler of listeners.get(event) ?? []) handler(); };
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
      info: { uuid: "00000000-0000-4000-8000-000000000911", name: "LOCAL TEST TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" }, provider
    } })));
  });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === new URL(origin).origin) return route.continue();
    if (!rpcUrls.includes(url.href)) { blockedExternal.push(url.origin); return route.abort(); }
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    assert.equal(request.method(), "POST");
    interceptedRpc++;
    const payload = request.postDataJSON();
    const respond = async item => {
      try { return { jsonrpc: "2.0", id: item.id, result: await fixture.rpc(item.method, item.params ?? []) }; }
      catch (error) { return { jsonrpc: "2.0", id: item.id, error: { code: -32000, message: error.message } }; }
    };
    const body = Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload);
    return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const first = await context.newPage(), second = await context.newPage();
  await first.goto(new URL(qaPath, origin).href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await first.getByRole("heading", { level: 1 }).waitFor({ timeout: 60_000 });
  assert.equal(fixture.stats.connectionRequests, 0); assert.equal(fixture.stats.sends.length, 0);
  await verify(first); await connect(first); await quote(first);
  assert.equal(fixture.stats.sends.length, 0);
  await captureMatrix(first, "review");
  log("Live connected review width/text/keyboard matrix passed");
  // Freshly review after screenshots; never extend or bypass the real profile/quote TTL.
  await verify(first); await connect(first); await quote(first);
  await second.goto(new URL(qaPath, origin).href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await verify(second); await connect(second); await quote(second);
  const forwardReview = await reviewValues(first);
  const beforeForward = await fixture.balances();
  fixture.setSwapHold(true);
  await first.locator(".v01-primary").evaluate(button => { button.click(); button.click(); });
  await waitUntil(() => fixture.stats.waitingSwaps === 1, "held synthetic swap request");
  assert.equal(fixture.stats.sends.length, 1, "only the approval may have been broadcast");
  await second.getByText("未解決または確認待ちの操作があります", { exact: false }).waitFor();
  assert.equal(await first.locator(".v01-primary").isDisabled(), true);
  assert.equal(await second.locator(".v01-primary").isDisabled(), true);
  assert.equal(await second.getByRole("button", { name: "見積りを取得", exact: true }).isDisabled(), true);
  const contention = await second.evaluate(async () => {
    const { withV01OperationLock } = await import("/src/v01/active-operation.ts");
    try { await withV01OperationLock(async () => { throw new Error("QA_ENTERED_LOCK"); }); return null; }
    catch (error) { return error.message; }
  });
  assert.equal(contention, "DUPLICATE_ROUTE_EXECUTION");
  const partial = await journal(first);
  assert.equal(partial[0].stage, "approval-confirmed");
  assert.equal(partial[0].transactions.some(transaction => transaction.role === "swap"), false);
  assert.deepEqual(await fixture.balances(), beforeForward);
  fixture.releaseSwap();
  await waitUntil(() => fixture.stats.sends.length === 2, "forward swap broadcast");
  await idle(first);
  await waitUntil(async () => (await journal(first))[0]?.transactions.some(transaction => transaction.role === "swap"), "forward swap journal");
  const afterForward = await fixture.balances();
  const forwardBinding = assertReviewedSends(fixture.stats.sends.slice(0, 2), forwardReview, fixture.addresses.ambr);
  assert.equal(BigInt(beforeForward.ambr) - BigInt(afterForward.ambr), 5n * 10n ** 18n);
  assert.ok(BigInt(afterForward.jade) > BigInt(beforeForward.jade));
  assert.ok(BigInt(afterForward.jade) - BigInt(beforeForward.jade) >= BigInt(forwardBinding.minimum));
  const forward = await refreshAndCloseAfterReload(first, 1);
  log("Forward actual local swap, competing tab, reload and unsigned recovery passed");
  await verify(first); await connect(first);
  await captureMatrix(first, "history");
  await verify(second); await connect(second); await quote(second, "reverse");
  const reverseReview = await reviewValues(second);
  const beforeReverse = await fixture.balances();
  await second.locator(".v01-primary").click();
  await waitUntil(() => fixture.stats.sends.length === 4, "reverse approval and swap");
  await idle(second);
  const afterReverse = await fixture.balances();
  const reverseBinding = assertReviewedSends(fixture.stats.sends.slice(2, 4), reverseReview, fixture.addresses.jade);
  assert.equal(BigInt(beforeReverse.jade) - BigInt(afterReverse.jade), 5n * 10n ** 18n);
  assert.ok(BigInt(afterReverse.ambr) > BigInt(beforeReverse.ambr));
  assert.ok(BigInt(afterReverse.ambr) - BigInt(beforeReverse.ambr) >= BigInt(reverseBinding.minimum));
  const reverse = await refreshAndCloseAfterReload(second, 2);
  const retentionSends = fixture.stats.sends.length, retentionConnections = fixture.stats.connectionRequests;
  const retainedBefore = await journal(second);
  const selectedForRemoval = retainedBefore.find(item => item.recoveryId === reverse.recoveryId);
  const exportButton = second.getByRole("button", { name: "選択した履歴の控えをダウンロード", exact: true });
  const removeButton = second.getByRole("button", { name: "控えを確認した1件をブラウザ履歴から削除", exact: true });
  const copyCheckbox = second.getByRole("checkbox", { name: "控えファイルを保存して開き、選択した履歴の内容を確認しました", exact: true });
  const downloadCopy = async suffix => {
    const event = second.waitForEvent("download"); await exportButton.click();
    const download = await event, savedPath = resolve(output, `history-copy-${suffix}.json`);
    await download.saveAs(savedPath); await idle(second);
    const copy = JSON.parse(await readFile(savedPath, "utf8"));
    assert.equal(copy.schema, "realdex.v01-history-export.v1");
    assert.deepEqual(copy.record, selectedForRemoval);
    assert.equal(Object.keys(copy).sort().join(), "exportedAt,record,recordFingerprint,schema");
    assert.equal(download.suggestedFilename(), `realdex-history-${copy.recordFingerprint.slice(2, 18)}.json`);
    assert.equal(await removeButton.isDisabled(), true);
    return copy;
  };
  const exportedCopy = await downloadCopy("initial");
  await copyCheckbox.check();
  await captureMatrix(second, "retention");
  // Selection changes invalidate the previous copy acknowledgement.
  await second.getByLabel(/^取引履歴/).selectOption(forward.recoveryId);
  assert.equal(await copyCheckbox.count(), 0);
  await second.getByLabel(/^取引履歴/).selectOption(reverse.recoveryId);
  assert.equal(await copyCheckbox.count(), 0);
  await verify(second);
  await downloadCopy("before-fault"); await copyCheckbox.check();
  // A one-shot write failure must not remove anything or automatically retry.
  await second.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.__qaRetentionFailures = 0;
    Storage.prototype.setItem = function(key, value) {
      if (key === "localswap:evm-swap-recovery-journal:v1" && window.__qaRetentionFailures === 0) {
        window.__qaRetentionFailures++; throw new Error("QA_RETENTION_WRITE_FAILED");
      }
      return original.call(this, key, value);
    };
  });
  await removeButton.click(); await idle(second, true);
  assert.match(await second.getByRole("alert").innerText(), /削除完了を確認できません/);
  assert.deepEqual(await journal(second), retainedBefore);
  assert.equal(await second.evaluate(() => window.__qaRetentionFailures), 1);
  assert.equal(await copyCheckbox.count(), 0);
  await downloadCopy("retry");
  await copyCheckbox.focus(); await second.keyboard.press("Space"); await second.keyboard.press("Tab");
  assert.equal(await removeButton.evaluate(element => document.activeElement === element), true);
  await second.keyboard.press("Enter"); await idle(second);
  const retainedAfter = await journal(second);
  assert.deepEqual(retainedAfter, retainedBefore.filter(item => item.recoveryId !== reverse.recoveryId));
  assert.equal(await active(second), null);
  await second.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await second.getByRole("heading", { name: "履歴の控えと整理", exact: true }).waitFor();
  assert.deepEqual(await journal(second), retainedAfter);
  assert.equal(fixture.stats.sends.length, retentionSends);
  assert.equal(fixture.stats.connectionRequests, retentionConnections);
  assert.deepEqual(await fixture.balances(), afterReverse);
  // Provider change invalidates the connected screen and reviewed quote without a send.
  await verify(second); await connect(second); await quote(second);
  const sendsBeforeChange = fixture.stats.sends.length;
  await second.evaluate(() => window.__qaEmit("accountsChanged"));
  await second.locator(".v01-address").filter({ hasText: "未接続" }).waitFor();
  assert.equal(await second.locator(".v01-review").count(), 0);
  assert.equal(fixture.stats.sends.length, sendsBeforeChange);
  assert.deepEqual(errors, []); assert.deepEqual(blockedExternal, []);
  assert.equal(await readFile("src/v01/reviewed-profile.ts", "utf8"), originalConfiguration);
  const report = {
    scope: "Live production React V01App/profile/runtime/adapter/journal in fresh Chrome with actual isolated Hardhat contracts. Test-only entry/config pin, synthetic EIP-1193 transport, two intercepted HTTPS reader IDs sharing one backend, synthetic fee oracle and allowance override shim. NOT real MetaMask, public Base Sepolia, independent-RPC or shipped-build acceptance.",
    browser: browser.version(), observations, interceptedRpc, pageErrors: errors, unexpectedExternalRequests: blockedExternal,
    doubleClickProducesOneApprovalAndSwap: true, competingConnectedTabBlocked: true, approvalIsNotSwap: true,
    reloadPreservesExactJournalAndActiveOperation: true, recoveryWithoutConnectOrSend: true, manualClosePreservesHistory: true,
    accountEventInvalidatesQuote: true, productionConfigurationUnchanged: true,
    forward: { stage: forward.stage, review: forwardReview, binding: forwardBinding, transactions: forward.transactions, before: beforeForward, after: afterForward },
    reverse: { stage: reverse.stage, review: reverseReview, binding: reverseBinding, transactions: reverse.transactions, before: beforeReverse, after: afterReverse },
    retention: { exportedCopy, retainedAfter, activeGuardBlockedRemoval: true, explicitSavedCopyConfirmation: true, changedSelectionClearsConfirmation: true, writeFailurePreservesRecords: true, keyboardRetry: true, reloadPersistsRemoval: true, noSendOrConnection: true },
    rawBroadcastCount: fixture.stats.sends.length, connectionRequests: fixture.stats.connectionRequests
  };
  await finishReport(output, report);
  log(JSON.stringify({ result: "PASS", browser: report.browser, matrixCases: observations.length, rawBroadcastCount: report.rawBroadcastCount, interceptedRpc, publicRequests: 0 }));
} catch (error) {
  const pages = context?.pages() ?? [];
  const screens = [];
  for (const [index, page] of pages.entries()) {
    if (page.isClosed()) continue;
    await page.screenshot({ path: resolve(output, `failure-${index}.png`), fullPage: true }).catch(() => undefined);
    await page.screenshot({ path: resolve(output, `failure-${index}-viewport.png`) }).catch(() => undefined);
    screens.push((await page.locator("body").innerText().catch(() => "unavailable")).slice(0, 12_000));
  }
  await writeFile(resolve(output, "failure.json"), JSON.stringify({ message: error.message, errors, blockedExternal, screens }, null, 2));
  throw error;
} finally {
  fixture.releaseSwap();
  await context?.close(); await browser?.close(); await server.close(); await fixture.dispose?.();
}
