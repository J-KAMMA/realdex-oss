import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { assertServedBuildIsCurrent } from "./v01ServedBuild.mjs";
import { beginReport } from "./v01Report.mjs";

const [playwrightPath, chromePath, markupPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: PLAYWRIGHT_MODULE CHROME_PATH GENERATED_MARKUP OUTPUT_DIRECTORY");
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
  const report = { servedRelease, scope: "Actual V01App markup with synthetic connected quote/fees, built CSS; native details/keyboard only, no React handlers, no real wallet", browser: browser.version(), cases: []  };
  for (const [width, scale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const page = await context.newPage(), external = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => { if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
    await page.setContent(`<html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="${origin}assets/${css}"><style>html{font-size:${scale * 100}%}</style></head><body>${markup}</body></html>`, { waitUntil: "networkidle" });
    assert.ok(await page.getByText("手数料予算（合計）:", { exact: false }).isVisible());
    const summary = page.locator("summary").filter({ hasText: "承認の費用予算" });
    await summary.focus(); await page.keyboard.press("Enter");
    assert.equal(await summary.evaluate(el => el.parentElement.open), true);
    const outline = await summary.evaluate(el => getComputedStyle(el).outlineWidth);
    assert.ok(parseFloat(outline) >= 2);
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => document.activeElement.textContent.startsWith("交換の費用予算")));
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("details[open]").count(), 2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth);
    await page.locator(".v01-review").screenshot({ path: resolve(outputPath, `${width}-text${scale}-fees.png`) });
    const outside = overflow ? await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth).map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right }))) : [];
    assert.equal(overflow, false, JSON.stringify({ width, scale, outside }));
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    report.cases.push({ width, textScale: scale, horizontalOverflow: overflow, keyboardDetails: "passed", errors: errors.length, externalRequests: external.length });
    await context.close();
  }
  await writeFile(resolve(outputPath, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise((done, reject) => server.httpServer.close(error => error ? reject(error) : done())); }
