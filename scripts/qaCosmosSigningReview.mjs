import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";

const [modules, executablePath, outputPath] = process.argv.slice(2);
if (!modules || !executablePath || !outputPath) throw new Error("Usage: node scripts/qaCosmosSigningReview.mjs <runtime-node_modules> <browser-executable> <output-directory>");
const { chromium } = createRequire(join(resolve(modules), "package.json"))("playwright");
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
// Stubs exist only in this isolated dev server's responses, never production files.
const stubs = {
  "/src/swap/cosmos-injected-signing-preparation.ts": "export async function prepareCosmosInjectedSigning() { window.__reviewQa.prepare++; return window.__reviewFixture.preparation; }",
  "/src/swap/cosmos-signed-swap-journal.ts": "export function readCosmosSigningSlot() { return window.__reviewQa.blocked ? { stage: 'signing-requested' } : null; } export async function reserveCosmosInjectedSigning() { window.__reviewQa.reserve++; return { preparation: window.__reviewFixture.preparation }; }",
  "/src/swap/cosmos-injected-direct-signing.ts": "export async function requestCosmosInjectedSwapSignature() { window.__reviewQa.sign++; return new Promise(resolve => { window.__reviewResolve = resolve; }); }"
};
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false }, plugins: [{
  name: "cosmos-review-ui-only-stubs", enforce: "pre",
  transform(_code, id) { const path = id.replaceAll('\\', '/').split('?')[0]; for (const [suffix, code] of Object.entries(stubs)) if (path.endsWith(suffix)) return { code, map: null }; }
}] });
let browser;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const errors = [], measurements = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext();
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/__review_qa__") return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml("/__review_qa__", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cosmos review synthetic QA</title></head><body><div id="qa-root"></div><script type="module" src="/scripts/qaCosmosSigningReviewPage.tsx"></script></body></html>') });
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const panel = page.locator(".cosmos-signing-review");
  const prepare = () => page.getByRole("button", { name: "Prepare signing review", exact: true });
  const request = () => page.getByRole("button", { name: "Request swap signature — no broadcast", exact: true });
  async function open() { await page.goto(`${origin}/__review_qa__`, { waitUntil: "domcontentloaded", timeout: 60_000 }); await prepare().waitFor({ timeout: 60_000 }); }
  await open();
  assert(await page.evaluate(() => window.__reviewQa.prepare === 0 && window.__reviewQa.sign === 0), "Automatic action on mount");
  await prepare().click();
  await request().waitFor();
  assert(await request().isDisabled(), "Signature enabled without acknowledgement");
  for (const [name, width, scale] of [["desktop", 1280, 1], ["tablet", 768, 1], ["mobile", 375, 1], ["narrow", 320, 1], ["text-200", 375, 2]]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.evaluate((element, scale) => {
      for (const item of [element, ...element.querySelectorAll("*")]) {
        if (!item.dataset.baseFontSize) item.dataset.baseFontSize = String(parseFloat(getComputedStyle(item).fontSize));
        item.style.fontSize = `${Number(item.dataset.baseFontSize) * scale}px`;
      }
    }, scale);
    const measurement = await panel.evaluate(element => {
      const controls = [...element.querySelectorAll("button,summary,label")];
      const root = document.documentElement;
      return { width: innerWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
        minControlHeight: Math.min(...controls.map(item => item.getBoundingClientRect().height)),
        clipped: [...element.querySelectorAll("p,dt,dd,button,label")].some(item => item.clientWidth > 0 && item.scrollWidth > item.clientWidth + 1) };
    });
    measurements.push({ name, ...measurement });
    assert(measurement.scrollWidth <= measurement.clientWidth + 1 && !measurement.clipped, `${name}: overflow or clipped text`);
    assert(measurement.minControlHeight >= 44, `${name}: small action target`);
    await panel.screenshot({ path: join(output, `review-${name}.png`) });
  }
  await panel.locator("summary").click();
  assert(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "Expanded transaction details overflow");
  await panel.locator("summary").click();
  await panel.locator('input[type="checkbox"]').focus();
  await page.keyboard.press("Space");
  assert(await request().isEnabled(), "Keyboard acknowledgement failed");
  await page.keyboard.press("Tab");
  assert(await request().evaluate(el => document.activeElement === el && getComputedStyle(el).outlineStyle !== "none"), "Request action lacks keyboard focus");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Stop waiting locally", exact: true }).waitFor();
  assert(await page.evaluate(() => window.__reviewQa.reserve === 1 && window.__reviewQa.sign === 1), "Signature request count changed");
  await page.getByRole("button", { name: "Stop waiting locally", exact: true }).click();
  await page.evaluate(() => window.__reviewResolve({ evidence: { transactionHash: "LATE-SYNTHETIC" }, signedTransactionBase64: "synthetic-only" }));
  assert(!await panel.getByText("Signed · not submitted by this view", { exact: true }).count(), "Late response adopted after stop");
  await panel.screenshot({ path: join(output, "review-stopped.png") });
  await open(); await prepare().click();
  await panel.locator('input[type="checkbox"]').check(); await request().click();
  await page.getByRole("button", { name: "Stop waiting locally", exact: true }).waitFor();
  await page.evaluate(() => window.__reviewResolve({ evidence: { transactionHash: "B".repeat(64) }, signedTransactionBase64: "synthetic-private-payload" }));
  await panel.getByText("Signed · not submitted by this view", { exact: true }).waitFor();
  assert(!(await panel.textContent()).includes("synthetic-private-payload"), "Signed payload was rendered");
  await panel.screenshot({ path: join(output, "review-signed.png") });
  await open(); await prepare().click();
  await page.evaluate(() => { const expiresAt = window.__reviewFixture.preparation.expiresAt; Date.now = () => expiresAt; });
  await panel.getByText("This review has expired.", { exact: false }).waitFor();
  assert(await request().isDisabled(), "Expired review still enabled");
  await panel.screenshot({ path: join(output, "review-expired.png") });
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({ measurements, keyboardConfirmation: true, noAutomaticSigning: true, lateResponseRejected: true, signedNotSubmitted: true, expiryBlocked: true, browserErrors: errors.length, output }));
} finally { if (errors.length) console.error(JSON.stringify({ browserErrors: errors })); await browser?.close(); await server.close(); }
