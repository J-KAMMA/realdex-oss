import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const [modules, executablePath, outputPath] = process.argv.slice(2);
if (!modules || !executablePath || !outputPath) throw new Error("Usage: node scripts/qaCosmosRecovery.mjs <runtime-node_modules> <browser-executable> <output-directory>");
const { chromium } = createRequire(join(resolve(modules), "package.json"))("playwright");
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const stubs = {
  "/src/swap/cosmos-swap-recovery.ts": "export const COSMOS_SWAP_RECOVERY_ID = 'cosmos-swap-recovery-v1';",
  "/src/swap/cosmos-read-policy.ts": "export function revalidateCosmosReadPolicy(policy) { return policy; }",
  "/src/swap/cosmos-policy-bound-recovery.ts": `export async function refreshPolicyBoundCosmosRecovery(input, options) {
    const qa = window.__recovery; qa.calls++; qa.signal = options.signal;
    if (qa.mode === 'pending') return new Promise(resolve => { qa.resolve = resolve; });
    if (qa.mode === 'error') throw new Error('synthetic-private-diagnostic');
    return qa.result(qa.mode === 'failed' ? 'committed-failed' : 'committed-success');
  }`
};
const server = await createServer({ configFile: false, cacheDir: "node_modules/.vite-cosmos-recovery-qa", optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-dev-runtime"] }, server: { host: "127.0.0.1", port: 0, open: false }, plugins: [react(), {
  name: "cosmos-recovery-ui-only-stubs", enforce: "pre",
  transform(_code, id) { const path = id.replaceAll("\\", "/").split("?")[0]; for (const [suffix, code] of Object.entries(stubs)) if (path.endsWith(suffix)) return { code, map: null }; }
}] });
const assert = (value, message) => { if (!value) throw new Error(message); };
let browser;
const errors = [], measurements = [], externalRequests = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext();
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { externalRequests.push(url.origin); return route.abort(); }
    if (url.pathname === "/__recovery_qa__") return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml("/__recovery_qa__", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cosmos recovery synthetic QA</title></head><body><div id="qa-root"></div><script type="module" src="/scripts/qaCosmosRecoveryPage.tsx"></script></body></html>') });
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const panel = page.locator(".cosmos-recovery-panel");
  const check = () => page.getByRole("button", { name: "Check transaction status", exact: true });
  const refresh = () => page.getByRole("button", { name: "Refresh transaction status", exact: true });
  async function open() { await page.goto(`${origin}/__recovery_qa__`, { waitUntil: "domcontentloaded", timeout: 60_000 }); await check().waitFor({ timeout: 60_000 }); }
  await open();
  assert(await page.evaluate(() => window.__recovery.calls === 0), "Automatic lookup on mount");
  await check().focus();
  await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  assert(await check().evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== "none"), "Missing keyboard focus");
  await page.keyboard.press("Enter");
  await refresh().waitFor();
  await panel.getByText("Transaction committed · success reported", { exact: true }).waitFor();
  for (const [name, width, scale] of [["desktop", 1280, 1], ["tablet", 768, 1], ["mobile", 375, 1], ["narrow", 320, 1], ["text-200", 375, 2]]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.evaluate((element, scale) => {
      for (const item of [element, ...element.querySelectorAll("*")]) {
        if (!item.dataset.baseFontSize) item.dataset.baseFontSize = String(parseFloat(getComputedStyle(item).fontSize));
        item.style.fontSize = `${Number(item.dataset.baseFontSize) * scale}px`;
      }
    }, scale);
    await panel.locator("details").evaluate(el => { el.open = true; });
    const m = await panel.evaluate(el => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      clipped: [...el.querySelectorAll("p,dt,dd,button,summary")].some(item => item.clientWidth > 0 && item.scrollWidth > item.clientWidth + 1),
      minControlHeight: Math.min(...[...el.querySelectorAll("button,summary")].map(item => item.getBoundingClientRect().height)) }));
    measurements.push({ name, ...m });
    assert(m.scrollWidth <= m.clientWidth + 1 && !m.clipped && m.minControlHeight >= 44, `${name}: layout or target failure`);
    await panel.screenshot({ path: join(output, `recovery-${name}.png`) });
  }
  const previousTime = await panel.locator("time").textContent();
  await page.evaluate(() => { window.__recovery.mode = "error"; });
  await refresh().click();
  await panel.getByText("Lookup failed.", { exact: false }).waitFor();
  assert(await panel.locator("time").textContent() === previousTime, "Failed refresh erased historical time");
  assert(!(await panel.textContent()).includes("synthetic-private-diagnostic"), "Raw error displayed");
  await panel.screenshot({ path: join(output, "recovery-historical-error.png") });
  await page.evaluate(() => { window.__recovery.mode = "pending"; });
  await refresh().click(); await page.getByRole("button", { name: "Stop lookup", exact: true }).click();
  assert(await refresh().evaluate(el => el === document.activeElement), "Cancel lost keyboard focus");
  assert(await page.evaluate(() => window.__recovery.signal.aborted), "Cancel did not abort lookup");
  await page.evaluate(() => window.__recovery.resolve(window.__recovery.result("committed-failed")));
  assert(!await panel.getByText("Transaction committed · failure reported", { exact: true }).count(), "Late cancelled result accepted");
  await page.evaluate(() => { window.__recovery.head = { revision: 3, payloadHash: "c".repeat(64) }; window.dispatchEvent(new Event("storage")); });
  await panel.getByText("Lookup unavailable — current accepted policy head changed.", { exact: true }).waitFor();
  assert(await refresh().isDisabled(), "Stale policy allowed refresh");
  await panel.screenshot({ path: join(output, "recovery-policy-blocked.png") });
  await open();
  await page.evaluate(() => { window.__recovery.mode = "failed"; }); await check().click();
  await panel.getByText("Transaction committed · failure reported", { exact: true }).waitFor();
  await panel.screenshot({ path: join(output, "recovery-committed-failure.png") });
  assert(!errors.length && !externalRequests.length, `Browser errors or external requests: ${JSON.stringify({ errors, externalRequests })}`);
  console.log(JSON.stringify({ measurements, keyboardLookup: true, noAutomaticLookup: true, historicalFailure: true, lateCancelRejected: true, policyHeadBlocked: true, browserErrors: errors.length, externalRequests: externalRequests.length, output }));
} finally { await browser?.close(); await server.close(); }
