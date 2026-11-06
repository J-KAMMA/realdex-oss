import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { assertServedBuildIsCurrent } from "./v01ServedBuild.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";
import { focusSettled } from "./v01FocusSettled.mjs";

// Built default surface only. Fresh context, no wallet, no external requests.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01Surface.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");
// playwright-core is CommonJS, so Node does not expose `chromium` as a named export
// and destructuring it yields undefined — a failure that only surfaces much later as
// "Cannot read properties of undefined (reading 'launch')". Accept either shape.
const playwrightModuleExports = await import(pathToFileURL(resolve(playwrightModule)).href);
const chromium = playwrightModuleExports.chromium ?? playwrightModuleExports.default?.chromium;
if (!chromium) throw new Error("PLAYWRIGHT_MODULE_HAS_NO_CHROMIUM: " + playwrightModule);
const output = resolve(outputDirectory);
await beginReport(output);
// This harness measures the surface of a build that ships no approved configuration: the
// "not set" warning, and that nothing can be operated. A build with a pinned deployment
// has no such surface, so running it against one fails on an assertion deep inside and
// reads like a defect in the page. Say it here instead, and name the harness that does
// describe such a build. It refuses rather than exiting quietly, because a harness that
// passes without testing anything is worse than one that stops.
const shippedConfiguration = await readFile(resolve("src/v01/reviewed-profile.ts"), "utf8");
if (!/REVIEWED_V01_CONFIGURATION[^=]*=\s*null/.test(shippedConfiguration)) {
  throw new Error("V01_SURFACE_HARNESS_SUPERSEDED: this build ships an approved configuration, so it has no unconfigured surface to measure. Run scripts/qaV01ConfiguredSurface.mjs instead.");
}
const servedRelease = await assertServedBuildIsCurrent();
const server = await preview({ configFile: false, preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  const origin = server.resolvedUrls.local[0];
  const report = { servedRelease, browser: browser.version(), scope: "built default unconfigured surface; no extension or connected-state certification", cases: []  };
  for (const [width, textScale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
    const external = [], errors = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
      external.push(new URL(route.request().url()).origin); return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin, { waitUntil: "networkidle" });
    assert.ok(await page.getByText("承認済みの配置記録が未設定です。", { exact: false }).isVisible());
    assert.ok(await page.getByRole("button", { name: "配置記録とトークンを照合" }).isDisabled());
    if (textScale === 2) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.getByLabel("公開RPC A", { exact: true }).fill(`https://example.invalid/${"a".repeat(220)}`);
    await page.getByText("初版の対応範囲", { exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(dimensions.document <= width && dimensions.body <= width, JSON.stringify(dimensions));
    await page.getByLabel("公開RPC A", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await focusSettled(page);
    const focus = await page.evaluate(() => {
      const el = document.activeElement, rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { label: el.closest("label")?.textContent, outline: style.outlineStyle, outlineWidth: style.outlineWidth, visible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth };
    });
    assert.ok(focus.label?.startsWith("公開RPC B"));
    assert.ok(focus.visible && focus.outline !== "none" && parseFloat(focus.outlineWidth) >= 2, JSON.stringify(focus));
    await page.screenshot({ path: resolve(output, `${width}-text${textScale}.png`), fullPage: true, animations: "disabled" });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    report.cases.push({ width, textScale, dimensions, keyboardFocus: focus, pageErrors: errors.length, externalRequests: external.length });
    await context.close();
  }
  await finishReport(output, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
