import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { assertServedBuildIsCurrent } from "./v01ServedBuild.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";
import { focusSettled } from "./v01FocusSettled.mjs";

// Rendering evidence only. React state transitions are asserted by the exporting
// component tests. No runtime, wallet, signature or network compatibility claim.
const [playwrightPath, chromePath, markupDirectory, outputDirectory] = process.argv.slice(2);
assert.ok(outputDirectory, "Usage: PLAYWRIGHT_MODULE CHROME_PATH MARKUP_DIRECTORY OUTPUT_DIRECTORY");
// playwright-core is CommonJS, so Node does not expose `chromium` as a named export
// and destructuring it yields undefined — a failure that only surfaces much later as
// "Cannot read properties of undefined (reading 'launch')". Accept either shape.
const playwrightModuleExports = await import(pathToFileURL(resolve(playwrightPath)).href);
const chromium = playwrightModuleExports.chromium ?? playwrightModuleExports.default?.chromium;
if (!chromium) throw new Error("PLAYWRIGHT_MODULE_HAS_NO_CHROMIUM: " + playwrightPath);
const output = resolve(outputDirectory);
await beginReport(output);
const cssFiles = (await readdir("dist/assets")).filter(name => name.endsWith(".css"));
assert.equal(cssFiles.length, 1, "Expected exactly one built default stylesheet");
const digest = value => createHash("sha256").update(value).digest("hex");
const states = ["verify-loading", "verify-error", "quote-loading", "quote-error"];
const markups = Object.fromEntries(await Promise.all(states.map(async state => [state, await readFile(resolve(markupDirectory, `${state}.html`), "utf8")])));
// Declared before the report that reads it. It used to come after, so the report literal
// hit the temporal dead zone and this harness could not start at all: every run threw
// ReferenceError: Cannot access 'servedRelease' before initialization.
const servedRelease = await assertServedBuildIsCurrent();
const report = {
  servedRelease,
  result: "INCOMPLETE",
  scope: "Actual V01App markup exported by passing deferred-promise component tests, built CSS; static layout and native keyboard only. No React handlers, wallet, RPC or public acceptance.",
  css: { file: cssFiles[0], sha256: digest(await readFile(resolve("dist/assets", cssFiles[0]))) },
  markupSha256: Object.fromEntries(states.map(state => [state, digest(markups[state])])),
  cases: []
};
const server = await preview({ configFile: false, preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  for (const state of states) {
    for (const [width, scale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
      try {
        const page = await context.newPage(), external = [], errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => {
          if (route.request().url() === `${origin}assets/${cssFiles[0]}`) return route.continue();
          external.push(route.request().url()); return route.abort();
        });
        await page.setContent(`<html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="${origin}assets/${cssFiles[0]}"><style>html{font-size:${scale * 100}%}</style></head><body>${markups[state]}</body></html>`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const loading = state.endsWith("loading");
        const notice = loading ? page.locator(".v01-notice") : page.getByRole("alert");
        const action = page.getByRole("button", { name: state.startsWith("verify") ? "配置記録とトークンを照合" : "見積りを取得", exact: true });
        assert.ok(await notice.isVisible());
        const message = await notice.innerText();
        assert.ok(message.includes(loading ? "処理中です。重ねて実行しないでください。" : state.startsWith("verify") ? "DEPLOYMENT_RPC_CHAIN_MISMATCH" : "送信せず停止しました。"), message);
        assert.equal(await action.isDisabled(), loading);
        assert.equal(await page.locator("button.v01-primary").isDisabled(), true);
        if (loading) assert.equal(await page.getByRole("alert").count(), 0);
        else assert.equal(await page.locator(".v01-notice").innerText(), "", "A prior operation's success notice must not survive this failure");
        const geometry = await notice.evaluate(el => {
          const rect = el.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el);
          const text = [...range.getClientRects()].filter(item => item.width && item.height);
          return {
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            fontSize: parseFloat(getComputedStyle(el).fontSize),
            textFits: text.every(item => item.left >= rect.left - 1 && item.right <= rect.right + 1 && item.top >= rect.top - 1 && item.bottom <= rect.bottom + 1),
            clippingAncestors: [...(function* () { for (let node = el; node; node = node.parentElement) yield node; })()].filter(node => {
              const style = getComputedStyle(node);
              return [style.overflowX, style.overflowY].some(value => ["hidden", "clip"].includes(value)) && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1);
            }).map(node => node.className)
          };
        });
        assert.ok(geometry.documentWidth <= width && geometry.bodyWidth <= width, JSON.stringify(geometry));
        assert.ok(geometry.fontSize >= 16 * scale && geometry.textFits, JSON.stringify(geometry));
        assert.deepEqual(geometry.clippingAncestors, []);
        await notice.screenshot({ path: resolve(output, `${state}-${width}-text${scale}-message.png`) });
        // Follow native Tab order from the initial document focus, never DOM focus().
        // In busy states the header brand remains a focusable way to identify the page;
        // in error states the explicit retry action is reachable. Do not invoke it.
        const target = loading ? page.locator(".v01-header a.brand") : action;
        let tabs = 0;
        do { await page.keyboard.press("Tab"); tabs++; }
        while (!(await target.evaluate(el => el === document.activeElement)) && tabs < 40);
        assert.ok(await target.evaluate(el => el === document.activeElement), `${state}: native keyboard target missing`);
        await focusSettled(page);
        const focus = await target.evaluate(el => {
          const r = el.getBoundingClientRect(), style = getComputedStyle(el), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, unobscured: hit === el || el.contains(hit), outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), label: el.textContent };
        });
        assert.ok(focus.visible && focus.unobscured && focus.outline !== "none" && focus.outlineWidth >= 2, JSON.stringify(focus));
        await page.screenshot({ path: resolve(output, `${state}-${width}-text${scale}-focus.png`), animations: "disabled" });
        await page.screenshot({ path: resolve(output, `${state}-${width}-text${scale}.png`), fullPage: true, animations: "disabled" });
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
        report.cases.push({ state, width, textScale: scale, message, geometry, keyboardTabs: tabs, focus, pageErrors: errors, externalRequests: external });
      } finally { await context.close(); }
    }
  }
  report.result = "PASS";
} catch (error) {
  report.result = "FAIL";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await finishReport(output, report);
  process.stdout.write(`${report.result}: ${report.cases.length} layout cases\n`);
  await browser?.close();
  await new Promise((done, reject) => server.httpServer.close(error => error ? reject(error) : done()));
}
