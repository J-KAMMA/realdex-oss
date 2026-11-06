import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const [modules, browserPath, outputDirectory] = process.argv.slice(2);
if (!modules || !browserPath || !outputDirectory) throw new Error("Usage: node scripts/qaWalletStandardDiscovery.mjs <runtime-node_modules> <browser-executable> <output-directory>");
const { chromium } = createRequire(join(resolve(modules), "package.json"))("playwright");
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: browserPath });
const measurements = [];
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("button", { name: "Universe", exact: true }).click();
  await page.getByRole("button", { name: "Wallets", exact: true }).click();
  const panel = page.locator(".wallet-standard-discovery");
  await panel.getByText("No Wallet Standard wallets detected.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(output, "empty.png") });
  await page.evaluate(() => {
    window.__discoveryForbiddenCalls = 0;
    const forbidden = () => { window.__discoveryForbiddenCalls++; throw new Error("Forbidden wallet access"); };
    let changed;
    const wallet = {
      version: "1.0.0", name: "Wallet Standard test fixture — " + "W".repeat(45),
      chains: ["solana:devnet", "sui:testnet", "experimental:" + "x".repeat(140)],
      features: {
        "standard:events": { version: "1.0.0", on: (_name, listener) => { changed = listener; return () => {}; } },
        "standard:connect": { version: "1.0.0", connect: forbidden },
        "solana:signTransaction": { version: "1.0.0", signTransaction: forbidden },
        "sui:signTransaction": { version: "2.0.0", signTransaction: forbidden }
      }
    };
    Object.defineProperties(wallet, { accounts: { get: forbidden }, icon: { get: forbidden } });
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: api => {
      window.__unregisterDiscoveryFixture = api.register(wallet, { version: "1.0.0", name: wallet.name, chains: ["solana:devnet"], features: {} });
    } }));
    window.__changeDiscoveryFixture = () => { wallet.chains = ["solana:testnet"]; changed({ accounts: "must not be used" }); };
  });
  await panel.getByText("2 wallet registrations detected.", { exact: true }).waitFor();
  for (const [name, width, height, scale] of [["desktop", 1280, 900, 1], ["mobile", 390, 844, 1], ["narrow", 320, 740, 1], ["text-200", 390, 844, 2]]) {
    await page.setViewportSize({ width, height });
    await panel.locator("details").evaluateAll(elements => elements.forEach(element => { element.open = true; }));
    await panel.evaluate((element, scale) => {
      for (const item of [element, ...element.querySelectorAll("*")]) {
        if (!item.dataset.baseFontSize) item.dataset.baseFontSize = String(parseFloat(getComputedStyle(item).fontSize));
        item.style.fontSize = `${Number(item.dataset.baseFontSize) * scale}px`;
      }
    }, scale);
    await panel.locator("summary").first().focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const result = await panel.evaluate(element => {
      const root = document.documentElement;
      const rect = element.getBoundingClientRect();
      const active = document.activeElement;
      return { width: innerWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, panelLeft: rect.left, panelRight: rect.right,
        targetHeight: active.getBoundingClientRect().height, focusInside: element.contains(active), focusOutline: getComputedStyle(active).outlineStyle,
        accountRequestDisabled: [...element.querySelectorAll("button")].find(button => button.textContent === "Request account access")?.disabled,
        forbiddenCalls: window.__discoveryForbiddenCalls };
    });
    measurements.push({ name, ...result });
    await panel.screenshot({ path: join(output, `${name}.png`) });
    if (result.scrollWidth > result.clientWidth || result.panelLeft < 0 || result.panelRight > result.clientWidth + 1 || result.targetHeight < 44 || !result.focusInside || result.focusOutline === "none" || !result.accountRequestDisabled || result.forbiddenCalls) throw new Error(`Discovery QA failed: ${name}: ${JSON.stringify(result)}`);
  }
  await page.evaluate(() => window.__changeDiscoveryFixture());
  await panel.getByText("solana:testnet", { exact: true }).waitFor();
  await page.evaluate(() => window.__unregisterDiscoveryFixture());
  await panel.getByText("No Wallet Standard wallets detected.", { exact: false }).waitFor();
  if (errors.length) throw new Error(`Runtime exceptions: ${errors.length}`);
  console.log(JSON.stringify({ measurements, runtimeExceptions: errors.length, externalRequestsAllowed: false, realWalletsUsed: false, changeAndUnregisterVerified: true }, null, 2));
} finally { await browser.close(); }
