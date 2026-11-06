import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { assertServedBuildIsCurrent } from "./v01ServedBuild.mjs";
import { beginReport } from "./v01Report.mjs";

const [playwrightPath, chromePath, markupPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: PLAYWRIGHT_MODULE CHROME_PATH GENERATED_HISTORY_MARKUP OUTPUT_DIRECTORY");
// playwright-core is CommonJS, so Node does not expose `chromium` as a named export
// and destructuring it yields undefined — a failure that only surfaces much later as
// "Cannot read properties of undefined (reading 'launch')". Accept either shape.
const playwrightModuleExports = await import(pathToFileURL(resolve(playwrightPath)).href);
const chromium = playwrightModuleExports.chromium ?? playwrightModuleExports.default?.chromium;
if (!chromium) throw new Error("PLAYWRIGHT_MODULE_HAS_NO_CHROMIUM: " + playwrightPath);
const markup = await readFile(markupPath, "utf8");
const css = (await readdir("dist/assets")).find(name => name.endsWith(".css"));
assert.ok(css);
await mkdir(outputPath, { recursive: true });
await beginReport(outputPath);
const servedRelease = await assertServedBuildIsCurrent();
const server = await preview({ configFile: false, preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const report = { servedRelease, scope: "Actual V01App synthetic 16-record/full-history-error markup plus built CSS; native keyboard only, no React handlers or real wallet", browser: browser.version(), cases: []  };
  for (const [width, scale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const page = await context.newPage(), external = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => { if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
    await page.setContent(`<html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="${origin}assets/${css}"><style>html{font-size:${scale * 100}%}</style></head><body>${markup}</body></html>`, { waitUntil: "networkidle" });
    assert.ok(await page.getByRole("alert").filter({ hasText: "上限の16件" }).isVisible());
    const history = page.getByRole("region", { name: "4. 保存した取引を照会" });
    const select = history.locator("select");
    assert.equal(await select.locator("option").count(), 16);
    assert.ok(await history.getByText("入力数量", { exact: true }).isVisible());
    assert.equal(await history.getByText("You paid", { exact: true }).count(), 0);
    const fontSizes = await history.locator(".swap-recovery").evaluate(el => ({
      status: parseFloat(getComputedStyle(el.querySelector("strong")).fontSize),
      hash: parseFloat(getComputedStyle(el.querySelector("code")).fontSize),
      notice: parseFloat(getComputedStyle(el.querySelector(".swap-recovery-warning")).fontSize)
    }));
    assert.ok(fontSizes.status >= 16 * scale && fontSizes.hash >= 14 * scale && fontSizes.notice >= 16 * scale, JSON.stringify(fontSizes));
    await select.focus();
    await page.keyboard.press("Tab");
    const refresh = history.getByRole("button", { name: "設定済みRPCで取引状況を照会（読み取りのみ）" });
    assert.ok(await refresh.evaluate(el => el === document.activeElement));
    assert.ok(parseFloat(await refresh.evaluate(el => getComputedStyle(el).outlineWidth)) >= 2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth);
    const outside = overflow ? await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth).map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right }))) : [];
    await history.screenshot({ path: resolve(outputPath, `${width}-text${scale}-history.png`) });
    await page.getByRole("alert").screenshot({ path: resolve(outputPath, `${width}-text${scale}-error.png`) });
    assert.equal(overflow, false, JSON.stringify({ width, scale, outside }));
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    report.cases.push({ width, textScale: scale, fontSizes, horizontalOverflow: overflow, historyOptions: 16, keyboardFocus: "passed", errors: errors.length, externalRequests: external.length });
    await context.close();
  }
  await writeFile(resolve(outputPath, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise((done, reject) => server.httpServer.close(error => error ? reject(error) : done())); }
