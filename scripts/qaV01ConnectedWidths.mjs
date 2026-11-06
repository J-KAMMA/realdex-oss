import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { JsonRpcProvider } from "ethers";
import { assertServedBuildIsCurrent } from "./v01ServedBuild.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";
import { focusSettled } from "./v01FocusSettled.mjs";

// P0-11, the part qaV01ConfiguredSurface.mjs does not reach: the screens that
// only exist once a wallet is connected and a quote is on screen — the review
// panel, the fee breakdown, the execute control and the history card.
//
// The harness answers account and chain questions and refuses every signing or
// sending method, so the run reaches those screens without spending gas and
// without the possibility of a send.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01ConnectedWidths.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const ACCOUNT = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";
const CHAIN_ID = "0x14a34";

const provider = new JsonRpcProvider(RPC_A);
let refusedSigningAttempts = 0;
const helper = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", async () => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") { response.statusCode = 204; return response.end(); }
    const reply = payload => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(payload)); };
    try {
      const { method, params = [] } = JSON.parse(body || "{}");
      if (method === "eth_accounts" || method === "eth_requestAccounts") return reply({ result: [ACCOUNT] });
      if (method === "eth_chainId") return reply({ result: CHAIN_ID });
      if (/^(eth_sendTransaction|eth_sendRawTransaction|eth_sign|personal_sign|eth_signTypedData)/.test(method)) {
        refusedSigningAttempts += 1;
        return reply({ error: { message: `refused by the harness: ${method}`, code: -32601 } });
      }
      return reply({ result: await provider.send(method, params) });
    } catch (error) {
      reply({ error: { message: error.shortMessage ?? error.message ?? String(error), code: -32603 } });
    }
  });
});
await new Promise(done => helper.listen(0, "127.0.0.1", done));
const helperUrl = `http://127.0.0.1:${helper.address().port}/`;

const injectWallet = url => `(() => {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    on: (event, handler) => { (listeners[event] ??= []).push(handler); },
    removeListener: (event, handler) => { listeners[event] = (listeners[event] ?? []).filter(h => h !== handler); },
    request: async ({ method, params }) => {
      const response = await fetch(${JSON.stringify(url)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
      const body = await response.json();
      if (body.error) throw Object.assign(new Error(body.error.message), body.error.code === undefined ? {} : { code: body.error.code });
      return body.result;
    }
  };
  const detail = Object.freeze({
    info: { uuid: "00000000-0000-4000-8000-00000000091a", name: "QA SIGNING TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
    provider
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})()`;

const playwright = await import(pathToFileURL(resolve(playwrightModule)).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
const output = resolve(outputDirectory);
await beginReport(output);
const servedRelease = await assertServedBuildIsCurrent();
const server = await preview({ configFile: false, preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
const report = { servedRelease, scope: "built configured app on public Base Sepolia; connected screens measured at every required width, signing refused so nothing can be sent", cases: []  };
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  const origin = server.resolvedUrls.local[0];

  for (const [width, textScale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
    await context.addInitScript(injectWallet(helperUrl));
    const errors = [];
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin, { waitUntil: "networkidle" });

    await page.getByLabel("公開RPC A", { exact: true }).fill(RPC_A);
    await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(RPC_B);
    const verified = page.getByText("照合済み（短時間のみ有効）", { exact: true });
    await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
    try {
      await verified.waitFor({ timeout: 45_000 });
    } catch {
      // A throttled public endpoint is not a layout defect. Try once more before
      // calling it a failure, and let the second attempt speak for itself.
      await page.waitForTimeout(15_000);
      await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
      await verified.waitFor({ timeout: 60_000 });
    }
    await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: "QA SIGNING TRANSPORT（自己申告）" });
    await page.getByRole("button", { name: "選択したウォレットに接続" }).click();
    await page.locator(".v01-address", { hasText: ACCOUNT }).waitFor({ timeout: 40_000 });

    // Text scaling is applied before the quote so the panel lays out scaled.
    if (textScale === 2) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.locator('label:has-text("支払数量") input').fill("0.25");
    await page.getByRole("button", { name: "見積りを取得" }).click();
    await page.locator(".v01-review").waitFor({ timeout: 40_000 });
    // The fee breakdown is collapsed by default; a collapsed box cannot overflow.
    const detailCount = await page.locator(".v01-review details").count();
    for (let index = 0; index < detailCount; index++) await page.locator(".v01-review details").nth(index).evaluate(node => { node.open = true; });
    await page.evaluate(() => document.fonts.ready);

    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    const clipped = await page.evaluate(() => [...document.querySelectorAll("main button, main input, main select, main dd, main dt, main h1, main h2, main summary")]
      .map(el => ({ tag: el.tagName, text: (el.textContent ?? "").slice(0, 40), right: Math.round(el.getBoundingClientRect().right) }))
      .filter(item => item.right > innerWidth + 0.5));
    const measured = await page.evaluate(() => document.querySelectorAll("main button, main input, main select, main dd, main dt, main h1, main h2, main summary").length);
    const truncated = await page.evaluate(() => [...document.querySelectorAll("main button, main label, main dd, main dt, main summary, main p, main h1, main h2")]
      .filter(el => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
      .map(el => ({ tag: el.tagName, text: (el.textContent ?? "").slice(0, 60), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth })));

    // The execute control is the one that matters most: it must be reachable and
    // visibly focused, not merely present somewhere below the fold.
    // Reach it with the keyboard: a scripted focus() does not always set
    // :focus-visible, so measuring after focus() would test the harness.
    const execute = page.getByRole("button", { name: /交換/ }).last();
    await page.locator('label:has-text("支払数量") input').focus();
    let reachedExecute = false;
    for (let press = 0; press < 30 && !reachedExecute; press++) {
      await page.keyboard.press("Tab");
      reachedExecute = await execute.evaluate(node => node === document.activeElement);
    }
    assert.ok(reachedExecute, "the execute control was not reachable with the keyboard");
    await focusSettled(page);
    const focus = await page.evaluate(() => {
      const el = document.activeElement, rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { text: (el.textContent ?? "").trim().slice(0, 40), outline: style.outlineStyle, outlineWidth: style.outlineWidth, insideViewport: rect.left >= 0 && rect.right <= innerWidth };
    });
    const reviewFields = await page.evaluate(() => {
      const list = document.querySelector(".v01-review dl");
      return list ? [...list.querySelectorAll("dt")].map(term => term.textContent.trim()) : [];
    });

    await page.screenshot({ path: resolve(output, `connected-${width}-text${textScale}.png`), fullPage: true, animations: "disabled" });
    report.cases.push({ width, textScale, dimensions, measuredElements: measured, keyboardReachedExecute: reachedExecute, feeDetailsOpened: detailCount, reviewFields, clippedElements: clipped, truncatedElements: truncated, executeFocus: focus, pageErrors: errors.length });

    assert.ok(measured > 0, "no element was measured, so 'nothing was clipped' says nothing");
    assert.ok(dimensions.document <= width && dimensions.body <= width, JSON.stringify({ width, ...dimensions }));
    assert.deepEqual(clipped, [], JSON.stringify(clipped));
    assert.deepEqual(truncated, [], JSON.stringify(truncated));
    assert.ok(focus.insideViewport && focus.outline !== "none" && parseFloat(focus.outlineWidth) >= 2, JSON.stringify(focus));
    assert.ok(reviewFields.includes("最低受取") && reviewFields.includes("受取先") && reviewFields.includes("期限") && reviewFields.includes("交換手数料"), JSON.stringify(reviewFields));
    assert.ok(detailCount > 0, "the fee breakdown was not present");
    assert.deepEqual(errors, [], JSON.stringify(errors));
    await context.close();
    // Space the cases out so the public endpoint is not asked to serve six full
    // verifications in a row with no gap.
    await new Promise(done => setTimeout(done, 8000));
  }

  report.refusedSigningAttempts = refusedSigningAttempts;
  assert.equal(refusedSigningAttempts, 0, "the app tried to sign during a layout check");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await finishReport(output, report);
  await browser?.close();
  helper.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
