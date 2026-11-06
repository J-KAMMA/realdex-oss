import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

// Run against the local dev app with a fresh, extension-free browser profile.
const [modules, browserPath, outputDirectory] = process.argv.slice(2);
if (!modules || !browserPath || !outputDirectory) throw new Error("Usage: node scripts/qaCctpReviewPanel.mjs <runtime-node_modules> <browser-executable> <output-directory>");
const { chromium } = createRequire(join(resolve(modules), "package.json"))("playwright");
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: browserPath });
const measurements = [];
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") return route.abort();
    return route.continue();
  });
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("button", { name: "Bridge", exact: true }).click();
  await page.locator(".cctp-review-panel > summary").click();
  const pin = page.getByLabel("Trusted reviewer fingerprint", { exact: true });
  const upload = page.getByLabel("Signed review bundle JSON", { exact: true });
  const verify = page.getByRole("button", { name: "Verify review evidence", exact: true });
  if (!(await verify.isDisabled())) throw new Error("Verification enabled without fresh evidence");
  await pin.fill("0x" + "a".repeat(64));
  await upload.setInputFiles({ name: "invalid-review.json", mimeType: "application/json", buffer: Buffer.from('{"not":"a review bundle"}') });
  await page.getByRole("alert").filter({ hasText: "Review rejected." }).waitFor();
  for (const [name, width, height, scale] of [["desktop", 1280, 900, 1], ["mobile", 390, 844, 1], ["narrow", 320, 740, 1], ["text-200", 390, 844, 2]]) {
    await page.setViewportSize({ width, height });
    await pin.fill("0x" + "f".repeat(2048));
    await upload.setInputFiles({ name: "invalid-review.json", mimeType: "application/json", buffer: Buffer.from('{"not":"a review bundle"}') });
    await page.getByRole("alert").filter({ hasText: "Review rejected." }).waitFor();
    await page.evaluate(scale => {
      for (const element of document.querySelectorAll(".cctp-review-panel, .cctp-review-panel *")) {
        if (!element.dataset.baseFontSize) element.dataset.baseFontSize = String(parseFloat(getComputedStyle(element).fontSize));
        element.style.fontSize = `${Number(element.dataset.baseFontSize) * scale}px`;
      }
    }, scale);
    await pin.focus();
    await page.keyboard.press("Tab");
    const result = await page.locator(".cctp-review-panel").evaluate(element => {
      const rect = element.getBoundingClientRect();
      const root = document.documentElement;
      const action = element.querySelector("button");
      const active = document.activeElement;
      return { width: innerWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, panelLeft: rect.left, panelRight: rect.right,
        buttonHeight: action.getBoundingClientRect().height, disabled: action.disabled,
        focusInside: element.contains(active), focusOutline: getComputedStyle(active).outlineStyle,
        primaryDisabled: document.querySelector("button.primary-button")?.disabled };
    });
    measurements.push({ name, ...result });
    if (result.scrollWidth > result.clientWidth || result.panelLeft < 0 || result.panelRight > result.clientWidth + 1 || result.buttonHeight < 44 || !result.disabled || !result.primaryDisabled || !result.focusInside || result.focusOutline === "none") throw new Error(`Review panel visual/accessibility failure: ${name}`);
    await page.locator(".cctp-review-panel").screenshot({ path: join(output, `${name}.png`) });
  }
  if (errors.length) throw new Error(`Runtime exceptions: ${errors.length}`);
  console.log(JSON.stringify({ measurements, runtimeExceptions: errors.length, externalRequestsAllowed: false, walletActions: false }, null, 2));
} finally { await browser.close(); }
