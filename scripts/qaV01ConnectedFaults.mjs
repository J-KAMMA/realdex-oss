import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { formatUnits, Interface } from "ethers";
import { createV01BrowserFixture } from "./v01BrowserFixture.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";
import { focusSettled } from "./v01FocusSettled.mjs";

// Test-only entry, isolated Hardhat and fresh Chrome. The shipped reviewed profile
// remains null; the fixture configuration is passed only through this HTML entry.
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
const originalReviewedProfile = await readFile("src/v01/reviewed-profile.ts", "utf8");
// This run supplies its own configuration to the page, so the committed one is never
// read here. What must hold is that the harness leaves it alone — asserted at the end,
// against these bytes — and that a local fixture is never what is committed. It used to
// require the committed value to be `= null` as well, which described the circumstances
// of shipping no profile rather than any rule, and made the harness unrunnable the
// moment a real deployment was pinned.
assert.ok(!originalReviewedProfile.includes("realdex-v01-local-test"), "a development fixture must not be committed as the public configuration");

const qaPath = "/qa-connected-faults.html";
const rpcUrls = ["https://hardhat-a.example/", "https://hardhat-b.example/"];
const journalKey = "localswap:evm-swap-recovery-journal:v1";
const log = message => process.stdout.write(`${message}\n`);

async function waitUntil(predicate, description, timeout = 30_000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeout) throw new Error(`QA timeout: ${description}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
}

async function settled(page) {
  await page.waitForFunction(() => !document.querySelector(".v01-notice")?.textContent?.includes("処理中"));
}

async function verify(page) {
  await page.getByLabel("公開RPC A", { exact: true }).fill(rpcUrls[0]);
  await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(rpcUrls[1]);
  await page.getByRole("button", { name: "配置記録とトークンを照合", exact: true }).click();
  await page.getByText("照合済み（短時間のみ有効）", { exact: true }).waitFor();
  await settled(page);
  assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
}

async function connect(page, account) {
  await page.getByLabel(/^MetaMask候補/).selectOption("00000000-0000-4000-8000-000000000911");
  await page.getByRole("button", { name: "選択したウォレットに接続", exact: true }).click();
  await page.locator(".v01-address").filter({ hasText: account }).waitFor();
  await settled(page);
}

async function quote(page) {
  await page.getByLabel(/^交換方向/).selectOption("forward");
  await page.getByLabel(/^支払数量/).fill("5");
  await page.getByRole("button", { name: "見積りを取得", exact: true }).click();
  await page.locator(".v01-review").waitFor();
  await settled(page);
}

async function journal(page) {
  return page.evaluate(async () => (await import("/src/swap/evm-swap-recovery.ts")).readEvmSwapRecoveryJournal());
}

async function active(page) {
  return page.evaluate(async () => (await import("/src/v01/active-operation.ts")).readActiveV01Operation());
}

async function stableUnresolvedScreenshot(page, path) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    let previous = "", stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
      const card = document.querySelector(".swap-recovery");
      const key = JSON.stringify([innerWidth, document.documentElement.scrollHeight, card?.getBoundingClientRect().height, card?.getBoundingClientRect().top + scrollY]);
      stable = key === previous ? stable + 1 : 0;
      previous = key;
      if (stable >= 4) return;
    }
    throw new Error("QA_LAYOUT_DID_NOT_SETTLE");
  });
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

async function assertNoHorizontalOverflow(page, width, label) {
  const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(bounds.document <= width && bounds.body <= width, `${label}: ${JSON.stringify(bounds)}`);
}

async function candidateMatrix(page, caseOutput) {
  const observations = [];
  for (const [width, textScale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, textScale);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => {
      let previous = "", stable = 0;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
        const rect = document.querySelector(".v01-candidate").getBoundingClientRect();
        const key = JSON.stringify([innerWidth, document.documentElement.scrollHeight, rect.height, rect.top + scrollY]);
        stable = key === previous ? stable + 1 : 0; previous = key;
        if (stable >= 4) return;
      }
      throw new Error("QA_CANDIDATE_LAYOUT_DID_NOT_SETTLE");
    });
    await assertNoHorizontalOverflow(page, width, `candidate ${width}/${textScale}`);
    await page.getByLabel("取引ハッシュ（tx hash）", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const target = page.getByRole("button", { name: "再照合して履歴に保存", exact: true });
    await page.waitForFunction(element => {
      const rect = element.getBoundingClientRect();
      return document.activeElement === element && rect.top >= 0 && rect.bottom <= innerHeight;
    }, await target.elementHandle());
    await focusSettled(page);
    const focus = await target.evaluate(element => {
      const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
      return { active: document.activeElement === element, visible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth, outline: css.outlineStyle, outlineWidth: css.outlineWidth, fontSize: css.fontSize };
    });
    assert.ok(focus.active && focus.visible && focus.outline !== "none" && parseFloat(focus.outlineWidth) >= 2, JSON.stringify(focus));
    await page.screenshot({ path: resolve(caseOutput, `candidate-${width}-text${textScale}-focus.png`), animations: "disabled" });
    await page.locator(".v01-candidate").screenshot({ path: resolve(caseOutput, `candidate-${width}-text${textScale}.png`), animations: "disabled" });
    observations.push({ width, textScale, focus });
  }
  return observations;
}

async function rawEvidence(fixture) {
  const evidence = await Promise.all(fixture.stats.sends.map(async send => ({
    hash: send.hash,
    transaction: send.transaction,
    receipt: await fixture.rpc("eth_getTransactionReceipt", [send.hash])
  })));
  for (const item of evidence) {
    assert.equal(item.receipt?.transactionHash?.toLowerCase(), item.hash.toLowerCase());
    assert.equal(item.receipt?.status, "0x1");
  }
  return evidence;
}

async function createQaServer(configuration) {
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, open: false },
    optimizeDeps: { entries: ["index.html"] },
    clearScreen: false,
    plugins: [{
      name: "test-only-v01-connected-fault-entry",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== qaPath) return next();
          try {
            const html = await vite.transformIndexHtml(qaPath, `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RealDEX LOCAL SYNTHETIC FAULT QA ONLY</title></head><body><div id="root"></div><script type="module">
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
  await server.listen();
  return server;
}

async function runCase(browser, mode, caseOutput) {
  await mkdir(caseOutput, { recursive: true });
  const fixture = await createV01BrowserFixture();
  const transformServer = await createServer({ server: { host: "127.0.0.1", port: 0 }, clearScreen: false });
  let v01ProfileFingerprint;
  try { ({ v01ProfileFingerprint } = await transformServer.ssrLoadModule("/src/release/v01-profile.ts")); }
  finally { await transformServer.close(); }
  const configuration = { profile: fixture.profile, pin: { releaseId: fixture.profile.deployment.releaseId, bundleSha256: fixture.profile.deployment.source.bundleSha256, profileFingerprint: v01ProfileFingerprint(fixture.profile) } };
  const server = await createQaServer(configuration);
  const origin = server.resolvedUrls.local[0];
  const errors = [], blockedExternal = [], rpcErrors = [];
  let interceptedRpc = 0;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(60_000);
  await context.exposeBinding("qaWalletRequest", async (_source, request) => {
    const tx = request?.params?.[0];
    const isSwap = request?.method === "eth_sendTransaction" && String(tx?.to ?? "").toLowerCase() === fixture.addresses.pool.toLowerCase();
    try {
      const value = await fixture.wallet(request.method, request.params ?? []);
      if (mode === "lost-swap-response" && isSwap) throw new Error("QA_TRANSPORT_RESPONSE_LOST");
      return { ok: true, value };
    } catch (error) {
      // Deliberately omit a rejected-wallet code: this is a transport error after raw
      // broadcast, not a user rejection and not authority to classify it as no-send.
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  await context.addInitScript(({ pool, faultMode, recoveryKey }) => {
    const listeners = new Map();
    const originalSetItem = Storage.prototype.setItem;
    window.__qaFailSwapPersistence = false;
    window.__qaStorageFailures = 0;
    window.__qaPreSendOperations = [];
    Storage.prototype.setItem = function (key, value) {
      if (window.__qaAdoptionFailKey === key) {
        window.__qaAdoptionFailKey = null;
        window.__qaAdoptionFailures = (window.__qaAdoptionFailures ?? 0) + 1;
        throw new Error("QA_ADOPTION_STORAGE_FAILED");
      }
      if (faultMode === "recovery-intent-storage-failure" && key === "realdex:v01-active-operation:v1" && window.__qaStorageFailures === 0 && JSON.parse(value).recovery) {
        window.__qaStorageFailures += 1;
        throw new Error("QA_RECOVERY_INTENT_STORAGE_WRITE_FAILED");
      }
      if (faultMode === "pre-wallet-storage-failure" && key === "realdex:v01-active-operation:v1" && window.__qaStorageFailures === 0 && JSON.parse(value).attempts?.length > 0) {
        window.__qaStorageFailures += 1;
        throw new Error("QA_PRE_WALLET_STORAGE_WRITE_FAILED");
      }
      if (faultMode === "storage-write-failure" && window.__qaFailSwapPersistence && key === recoveryKey) {
        window.__qaFailSwapPersistence = false;
        window.__qaStorageFailures += 1;
        throw new Error("QA_SWAP_JOURNAL_WRITE_DROPPED");
      }
      return originalSetItem.call(this, key, value);
    };
    const provider = {
      request: async request => {
        if (request.method === "eth_sendTransaction") window.__qaPreSendOperations.push(JSON.parse(localStorage.getItem("realdex:v01-active-operation:v1")));
        const result = await window.qaWalletRequest(request);
        const isSwap = request?.method === "eth_sendTransaction" && String(request?.params?.[0]?.to ?? "").toLowerCase() === pool.toLowerCase();
        // Arm the one-shot storage fault after the binding has returned the raw hash,
        // before ethers/browser code receives it and invokes recovery persistence.
        if (faultMode === "storage-write-failure" && isSwap && result.ok) window.__qaFailSwapPersistence = true;
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
  }, { pool: fixture.addresses.pool, faultMode: mode, recoveryKey: journalKey });
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
      catch (error) { rpcErrors.push(error instanceof Error ? error.message : String(error)); return { jsonrpc: "2.0", id: item.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }; }
    };
    const body = Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload);
    return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const page = await context.newPage();
  try {
    await page.goto(new URL(qaPath, origin).href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 60_000 });
    assert.equal(fixture.stats.connectionRequests, 0);
    assert.equal(fixture.stats.sends.length, 0);
    await verify(page);
    await connect(page, fixture.account);
    await quote(page);
    const reviewedMinimum = await page.locator(".v01-review > dl > dd").nth(2).innerText();
    const before = await fixture.balances();
    await page.locator("button.v01-primary").click();
    if (mode === "pre-wallet-storage-failure" || mode === "recovery-intent-storage-failure") {
      await page.getByRole("alert").waitFor();
      await settled(page);
      assert.equal(await page.evaluate(() => window.__qaStorageFailures), 1);
      assert.equal(fixture.stats.sends.length, 0);
      assert.deepEqual(await fixture.balances(), before);
      assert.deepEqual(await journal(page), []);
      assert.equal(await active(page), null);
      const connectionRequests = fixture.stats.connectionRequests;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("heading", { level: 1 }).waitFor();
      assert.equal(fixture.stats.connectionRequests, connectionRequests);
      assert.equal(fixture.stats.sends.length, 0);
      assert.equal(await active(page), null);
      assert.deepEqual(await journal(page), []);
      assert.deepEqual(errors, []); assert.deepEqual(blockedExternal, []); assert.deepEqual(rpcErrors, []);
      assert.equal(await readFile("src/v01/reviewed-profile.ts", "utf8"), originalReviewedProfile);
      const report = { mode, scope: "Actual production React/runtime with synthetic EIP-1193 and isolated local contracts; pre-wallet active-operation setItem failure. Not public or real-extension acceptance.", browser: await browser.version(), interceptedRpc, rawBroadcastCount: 0, storageFailures: 1, before, after: await fixture.balances(), noAutoConnectOrFollowupSend: true, pageErrors: errors, unexpectedExternalRequests: blockedExternal, rpcErrors, shippedReviewedProfileUnchanged: true };
      await writeFile(resolve(caseOutput, "report.json"), JSON.stringify(report, null, 2));
      return report;
    }
    await waitUntil(() => fixture.stats.sends.length === 2, `${mode} raw approval and swap broadcasts`);
    await page.getByRole("alert").waitFor();
    await settled(page);
    const after = await fixture.balances();
    assert.equal(BigInt(before.ambr) - BigInt(after.ambr), 5n * 10n ** 18n, `${mode}: actual AMBR delta`);
    assert.ok(BigInt(after.jade) > BigInt(before.jade), `${mode}: actual JADE delta`);
    const savedJournal = await journal(page), savedActive = await active(page);
    assert.equal(savedJournal.length, 1);
    assert.equal(savedJournal[0].stage, "approval-confirmed");
    assert.deepEqual(savedJournal[0].transactions.map(transaction => transaction.role), ["approval"]);
    assert.ok(savedJournal[0].transactions[0].hash.startsWith("0x"));
    assert.ok(savedActive?.recoveryId);
    assert.equal(savedActive.recoveryId, savedJournal[0].recoveryId);
    assert.equal(savedActive.schema, "realdex.v01-active-operation.v3");
    assert.equal(savedActive.attempts.length, 2);
    const recovery = savedActive.recovery;
    for (const key of ["recoveryId", "quoteId", "requestFingerprint", "routeFingerprint", "accountId", "recipient"]) assert.equal(recovery[key], savedJournal[0][key]);
    assert.equal(recovery.amountInBaseUnits, savedJournal[0].source.amountBaseUnits);
    assert.equal(recovery.minimumOutBaseUnits, savedJournal[0].destination.minimumOutBaseUnits);
    assert.equal(reviewedMinimum, `${formatUnits(recovery.minimumOutBaseUnits, 18)} JADE`);
    assert.equal(recovery.approvalRequired, true);
    const decoded = new Interface(["function swapExactIn(address tokenIn,uint256 amountIn,uint256 minimumOut,address recipient,uint256 deadline)"]).decodeFunctionData("swapExactIn", savedActive.attempts[1].transaction.data);
    assert.equal(decoded[0], recovery.sourceAsset.split("/erc20:")[1]);
    assert.equal(decoded[1].toString(), recovery.amountInBaseUnits); assert.equal(decoded[2].toString(), recovery.minimumOutBaseUnits);
    assert.equal(decoded[3], recovery.recipient); assert.equal(Number(decoded[4]), Math.floor(recovery.quoteExpiresAt / 1000));
    const preSendOperations = await page.evaluate(() => window.__qaPreSendOperations);
    assert.equal(preSendOperations.length, 2);
    for (const [index, operation] of preSendOperations.entries()) {
      assert.deepEqual(operation.recovery, recovery); assert.equal(operation.attempts.length, index + 1);
    }
    for (const [index, attempt] of savedActive.attempts.entries()) {
      assert.equal(attempt.intentId, savedActive.intentId);
      assert.equal(attempt.quoteId, savedActive.quoteId);
      assert.equal(attempt.profileFingerprint, savedActive.profileFingerprint);
      assert.equal(attempt.role, index === 0 ? "approval" : "swap");
      assert.deepEqual(attempt.transaction, fixture.stats.sends[index].transaction);
      const receipt = await fixture.rpc("eth_getTransactionReceipt", [fixture.stats.sends[index].hash]);
      assert.ok(attempt.observedBeforeBlock < Number(BigInt(receipt.blockNumber)));
    }
    assert.doesNotMatch(await page.locator("body").innerText(), /swap not sent/i);
    const storageFailures = mode === "storage-write-failure" ? await page.evaluate(() => window.__qaStorageFailures) : 0;
    if (mode === "storage-write-failure") assert.equal(storageFailures, 1);

    // Give the approval more than the two-confirmation threshold, then prove reload is
    // read-only and the unresolved operation still disables all new route actions.
    await fixture.mine(); await fixture.mine();
    const connectionRequestsBeforeReload = fixture.stats.connectionRequests;
    const sendsBeforeReload = fixture.stats.sends.length;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("未解決または確認待ちの操作があります", { exact: false }).waitFor();
    assert.deepEqual(await journal(page), savedJournal);
    assert.deepEqual(await active(page), savedActive);
    assert.equal(fixture.stats.connectionRequests, connectionRequestsBeforeReload);
    assert.equal(fixture.stats.sends.length, sendsBeforeReload);
    assert.equal(await page.getByRole("button", { name: "見積りを取得", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("button.v01-primary").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "照会済みの操作を終了し、新しい見積りへ", exact: true }).count(), 0);
    await verify(page);
    await page.getByRole("button", { name: "設定済みRPCで取引状況を照会（読み取りのみ）" }).click();
    await settled(page);
    const refreshed = await journal(page);
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].stage, "approval-confirmed");
    assert.deepEqual(refreshed[0].transactions.map(transaction => transaction.role), ["approval"]);
    assert.equal(refreshed[0].transactions[0].hash, savedJournal[0].transactions[0].hash);
    assert.deepEqual(await active(page), savedActive);
    assert.equal(await page.getByRole("button", { name: "見積りを取得", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("button.v01-primary").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "照会済みの操作を終了し、新しい見積りへ", exact: true }).count(), 0);
    assert.equal(fixture.stats.connectionRequests, connectionRequestsBeforeReload);
    assert.equal(fixture.stats.sends.length, sendsBeforeReload);
    assert.ok((refreshed[0].transactions[0].confirmations ?? 0) >= 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(blockedExternal, []);
    assert.deepEqual(rpcErrors, []);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await assertNoHorizontalOverflow(page, 1280, `${mode}: 1280 unresolved`);
    await page.locator(".swap-recovery > p").screenshot({ path: resolve(caseOutput, "unresolved-status-1280.png") });
    await stableUnresolvedScreenshot(page, resolve(caseOutput, "unresolved-1280.png"));
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await assertNoHorizontalOverflow(page, 375, `${mode}: 375/200% unresolved`);
    await page.locator(".swap-recovery > p").screenshot({ path: resolve(caseOutput, "unresolved-status-375-text2.png") });
    await stableUnresolvedScreenshot(page, resolve(caseOutput, "unresolved-375-text2.png"));

    // Explicitly type oracle hashes as synthetic user input, never inject a result or
    // persistence record. The production UI/verifier use both real intercepted readers.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    const candidateButton = page.getByRole("button", { name: "取引ハッシュを照合（読み取りのみ）", exact: true });
    const hashInput = page.getByLabel("取引ハッシュ（tx hash）", { exact: true });
    assert.equal(await candidateButton.isDisabled(), true);
    // An approval hash must not be accepted for the selected swap request.
    await hashInput.fill(fixture.stats.sends[0].hash);
    await candidateButton.click(); await settled(page);
    assert.match(await page.getByRole("alert").innerText(), /未送信とは判断できません/);
    assert.equal(await page.locator(".v01-candidate-result").count(), 0);
    assert.deepEqual(await journal(page), refreshed); assert.deepEqual(await active(page), savedActive);
    await hashInput.fill(fixture.stats.sends[1].hash);
    await page.keyboard.press("Tab");
    assert.equal(await candidateButton.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "照合結果：保存した要求と一致", exact: true }).waitFor();
    await settled(page);
    assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
    const candidateText = await page.locator(".v01-candidate-result").innerText();
    assert.ok(candidateText.includes(fixture.stats.sends[1].hash));
    assert.match(candidateText, /成功（status 1）/);
    const candidateLayouts = await candidateMatrix(page, caseOutput);
    assert.deepEqual(await journal(page), refreshed); assert.deepEqual(await active(page), savedActive);
    assert.equal(await page.getByRole("button", { name: "照会済みの操作を終了し、新しい見積りへ", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "見積りを取得", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("button.v01-primary").isDisabled(), true);
    assert.equal(fixture.stats.connectionRequests, connectionRequestsBeforeReload);
    assert.equal(fixture.stats.sends.length, sendsBeforeReload);
    // Changing the input clears stale observations; nothing is persisted on reload.
    await hashInput.fill(fixture.stats.sends[0].hash);
    assert.equal(await page.locator(".v01-candidate-result").count(), 0);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("heading", { name: "5. 保存済み送信要求とハッシュを照合", exact: true }).waitFor();
    assert.equal(await hashInput.inputValue(), "");
    assert.equal(await page.locator(".v01-candidate-result").count(), 0);
    assert.deepEqual(await journal(page), refreshed); assert.deepEqual(await active(page), savedActive);
    assert.equal(fixture.stats.connectionRequests, connectionRequestsBeforeReload); assert.equal(fixture.stats.sends.length, sendsBeforeReload);
    // Explicit adoption performs fresh RPC checks and local writes only. Exercise
    // both write boundaries without inventing an on-chain retry or clearing guard.
    await verify(page);
    await hashInput.fill(fixture.stats.sends[1].hash);
    await candidateButton.click(); await settled(page);
    const adoptButton = page.getByRole("button", { name: "再照合して履歴に保存", exact: true });
    await adoptButton.waitFor();
    await page.evaluate(key => { window.__qaAdoptionFailKey = key; }, mode === "lost-swap-response" ? journalKey : "realdex:v01-active-operation:v1");
    await adoptButton.click(); await settled(page);
    assert.match(await page.getByRole("alert").innerText(), /一部が保存されている場合/);
    assert.equal(await page.evaluate(() => window.__qaAdoptionFailures), 1);
    assert.deepEqual(await active(page), savedActive);
    const partiallyAdopted = await journal(page);
    if (mode === "lost-swap-response") assert.deepEqual(partiallyAdopted, refreshed);
    else {
      assert.equal(partiallyAdopted[0].stage, "swap-confirmed");
      assert.equal(partiallyAdopted[0].transactions[1].hash, fixture.stats.sends[1].hash);
    }
    assert.equal(await page.locator("button.v01-primary").isDisabled(), true);
    assert.equal(fixture.stats.sends.length, sendsBeforeReload);
    await candidateButton.click(); await settled(page);
    await adoptButton.focus();
    assert.equal(await adoptButton.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press("Enter"); await settled(page);
    assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
    const adopted = (await journal(page))[0];
    assert.equal(adopted.recoveryId, refreshed[0].recoveryId);
    assert.equal(adopted.createdAt, refreshed[0].createdAt);
    assert.deepEqual(adopted.source, refreshed[0].source);
    assert.deepEqual(adopted.destination, refreshed[0].destination);
    assert.equal(adopted.revision, partiallyAdopted[0].revision + 1);
    assert.equal(adopted.stage, "swap-confirmed");
    assert.deepEqual(adopted.transactions.map(item => item.hash), fixture.stats.sends.map(item => item.hash));
    assert.ok(adopted.transactions.every(item => item.confirmations >= 2));
    assert.deepEqual(await active(page), savedActive);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("heading", { name: "5. 保存済み送信要求とハッシュを照合", exact: true }).waitFor();
    assert.deepEqual(await journal(page), [adopted]);
    assert.deepEqual(await active(page), savedActive);
    await verify(page);
    await page.getByRole("button", { name: "照会済みの操作を終了し、新しい見積りへ", exact: true }).click(); await settled(page);
    assert.equal(await active(page), null);
    assert.equal((await journal(page))[0].transactions[1].hash, fixture.stats.sends[1].hash);
    assert.equal(fixture.stats.connectionRequests, connectionRequestsBeforeReload);
    assert.equal(fixture.stats.sends.length, sendsBeforeReload);
    assert.deepEqual(await fixture.balances(), after);
    assert.deepEqual(errors, []); assert.deepEqual(blockedExternal, []); assert.deepEqual(rpcErrors, []);
    assert.equal(await readFile("src/v01/reviewed-profile.ts", "utf8"), originalReviewedProfile);
    const report = {
      mode,
      scope: "Live production React V01App/profile/runtime/adapter/journal in fresh Chrome with actual isolated Hardhat contracts. Test-only entry/config pin, synthetic EIP-1193 transport, two intercepted HTTPS reader IDs sharing one backend. NOT real MetaMask, public Base Sepolia, independent RPC or shipped-build acceptance.",
      browser: await browser.version(), interceptedRpc, pageErrors: errors, unexpectedExternalRequests: blockedExternal, rpcErrors,
      rawBroadcasts: await rawEvidence(fixture), before, after,
      approvalOnlyJournalAfterRawSwap: savedJournal,
      activeOperationAfterRawSwap: savedActive,
      recoveryMetadataBeforeEachSend: preSendOperations,
      storageFailures,
      afterReloadJournal: refreshed,
      connectionRequests: fixture.stats.connectionRequests,
      rawBroadcastCount: fixture.stats.sends.length,
      noAutoConnectOrFollowupSend: true,
      unresolvedBlocksQuoteSendAndClose: true,
      candidateReadOnlyUi: { wrongRoleHashRejected: true, explicitKeyboardCheck: true, candidateText, candidateLayouts, unchangedHistoryAndActive: true, clearedOnInputAndReload: true },
      explicitAdoption: { partiallyAdopted, adopted, failureBoundary: mode === "lost-swap-response" ? "journal-write" : "active-ID-write", failureKeptGuard: true, keyboardRetry: true, durableReload: true, separateManualClose: true, noAdditionalSend: true },
      shippedReviewedProfileUnchanged: true
    };
    await writeFile(resolve(caseOutput, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    await page.screenshot({ path: resolve(caseOutput, "failure.png"), fullPage: true }).catch(() => undefined);
    await page.screenshot({ path: resolve(caseOutput, "failure-viewport.png") }).catch(() => undefined);
    await writeFile(resolve(caseOutput, "failure.json"), JSON.stringify({ mode, message: error.message, pageErrors: errors, unexpectedExternalRequests: blockedExternal, rpcErrors, body: (await page.locator("body").innerText().catch(() => "unavailable")).slice(0, 12_000) }, null, 2));
    throw error;
  } finally {
    await context.close();
    await server.close();
    await fixture.dispose?.();
  }
}

let browser;
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  const reports = {};
  reports.lostSwapResponse = await runCase(browser, "lost-swap-response", resolve(output, "lost-swap-response"));
  log("Case 1: raw swap succeeded but browser response was lost; approval-only recovery remained blocked");
  reports.storageWriteFailure = await runCase(browser, "storage-write-failure", resolve(output, "storage-write-failure"));
  log("Case 2: recovery journal write failed after raw swap; approval-only recovery remained blocked");
  reports.preWalletStorageFailure = await runCase(browser, "pre-wallet-storage-failure", resolve(output, "pre-wallet-storage-failure"));
  log("Case 3: pre-wallet request persistence failed; zero raw broadcasts and no balance changes");
  reports.recoveryIntentStorageFailure = await runCase(browser, "recovery-intent-storage-failure", resolve(output, "recovery-intent-storage-failure"));
  log("Case 4: original recovery metadata persistence failed; zero raw broadcasts and no balance changes");
  await finishReport(output, { result: "PASS", cases: reports });
  log(JSON.stringify({ result: "PASS", cases: Object.keys(reports).length, rawBroadcasts: Object.values(reports).map(report => report.rawBroadcastCount), publicRequests: 0 }));
} catch (error) {
  await writeFile(resolve(output, "failure.json"), JSON.stringify({ message: error.message }, null, 2));
  throw error;
} finally {
  await browser?.close();
}
