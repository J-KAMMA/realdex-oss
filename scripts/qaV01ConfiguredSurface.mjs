import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { assertServedBuildIsCurrent } from "./v01ServedBuild.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";
import { focusSettled } from "./v01FocusSettled.mjs";

// A throttled public endpoint is not a defect in the page. Give the verification
// one more attempt before calling the run failed.
async function verifiedOrRetry (page, first = 45_000, second = 60_000) {
  const verified = page.getByText("照合済み（短時間のみ有効）", { exact: true });
  try {
    await verified.waitFor({ timeout: first });
  } catch {
    await page.waitForTimeout(15_000);
    await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
    await verified.waitFor({ timeout: second });
  }
}


// P0-11 for the configured surface: the built app with the reviewed public
// profile set, verified against the real Base Sepolia deployment.
//
// The older qaV01Surface.mjs covers the unconfigured surface and asserts the
// "not set" warning; it no longer describes this build. This script is the
// configured counterpart, not a replacement.
//
// Only the two public RPC origins are allowed out; every other external request
// fails the case. Read-only: no wallet, no key, no signing, no send.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01ConfiguredSurface.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const ALLOWED = new Set([new URL(RPC_A).origin, new URL(RPC_B).origin]);

// Playwright ships CommonJS, so the named export may only exist on `default`.
const playwright = await import(pathToFileURL(resolve(playwrightModule)).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("playwright module exposes no chromium");
const output = resolve(outputDirectory);
await beginReport(output);
const servedRelease = await assertServedBuildIsCurrent();
const server = await preview({ configFile: false, preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  const origin = server.resolvedUrls.local[0];
  const report = {
    servedRelease,
    browser: browser.version(),
    scope: "built configured surface verified against the real Base Sepolia deployment; no wallet extension, no signing, no send",
    rpcEndpoints: [RPC_A, RPC_B],
    cases: []
  };
  for (const [width, textScale] of [[320, 1], [375, 1], [768, 1], [1280, 1], [375, 2], [1280, 2]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
    const disallowed = [], rpcCalls = [], errors = [];
    await context.route("**/*", route => {
      const requestOrigin = new URL(route.request().url()).origin;
      if (requestOrigin === new URL(origin).origin) return route.continue();
      if (ALLOWED.has(requestOrigin)) { rpcCalls.push(requestOrigin); return route.continue(); }
      disallowed.push(requestOrigin); return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin, { waitUntil: "networkidle" });

    // Configured: the "not set" warning is gone and verification is offered.
    assert.equal(await page.getByText("承認済みの配置記録が未設定です。", { exact: false }).count(), 0);
    const verifyButton = page.getByRole("button", { name: "配置記録とトークンを照合" });
    assert.ok(await verifyButton.isEnabled());
    // Connecting must stay closed until the fixed target is verified.
    assert.ok(await page.getByRole("button", { name: "選択したウォレットに接続" }).isDisabled());

    if (textScale === 2) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.getByLabel("公開RPC A", { exact: true }).fill(RPC_A);
    await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(RPC_B);
    await verifyButton.click();
    await verifiedOrRetry(page);
    assert.ok(await page.getByText("対象ネットワーク・配置記録・プール・2トークンを照合しました。", { exact: false }).isVisible());

    await page.evaluate(() => document.fonts.ready);
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(dimensions.document <= width && dimensions.body <= width, JSON.stringify({ width, ...dimensions }));

    // Every interactive control must be reachable and visibly focused.
    await page.getByLabel("公開RPC A", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await focusSettled(page);
    const focus = await page.evaluate(() => {
      const el = document.activeElement, rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { label: el.closest("label")?.textContent, outline: style.outlineStyle, outlineWidth: style.outlineWidth, visible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth };
    });
    assert.ok(focus.label?.startsWith("公開RPC B"), JSON.stringify(focus));
    assert.ok(focus.visible && focus.outline !== "none" && parseFloat(focus.outlineWidth) >= 2, JSON.stringify(focus));

    // Nothing important may be clipped by the viewport edge.
    const clipped = await page.evaluate(() => [...document.querySelectorAll("main button, main input, main h1, main h2, main label")]
      .map(el => ({ tag: el.tagName, text: (el.textContent ?? "").slice(0, 40), right: Math.round(el.getBoundingClientRect().right) }))
      .filter(item => item.right > innerWidth + 0.5));
    assert.deepEqual(clipped, [], JSON.stringify(clipped));

    // Read the direction labels rather than judging them from a scaled image.
    const swapDirectionOptions = await page.evaluate(() => [...document.querySelectorAll("main select option")].map(option => option.textContent));
    assert.ok(swapDirectionOptions.some(text => text?.includes("AMBR") && text?.includes("JADE")), JSON.stringify(swapDirectionOptions));

    // Text cut off inside its own box is invisible to the edge check above.
    const truncated = await page.evaluate(() => [...document.querySelectorAll("main button, main label, main select, main option, main h1, main h2, main p")]
      .filter(el => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
      .map(el => ({ tag: el.tagName, text: (el.textContent ?? "").slice(0, 60), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth })));
    assert.deepEqual(truncated, [], JSON.stringify(truncated));

    await page.screenshot({ path: resolve(output, `${width}-text${textScale}.png`), fullPage: true, animations: "disabled" });
    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.deepEqual(disallowed, [], JSON.stringify(disallowed));
    assert.ok(rpcCalls.length > 0, "verification made no RPC request");
    report.cases.push({ width, textScale, dimensions, keyboardFocus: focus, clippedElements: clipped.length, truncatedElements: truncated.length, swapDirectionOptions, rpcRequests: rpcCalls.length, pageErrors: errors.length, disallowedOrigins: disallowed.length });
    await context.close();
  }
  await finishReport(output, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
