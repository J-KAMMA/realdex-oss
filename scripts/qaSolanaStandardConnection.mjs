import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { base58 } from "@scure/base";

const [modules, browserPath, outputDirectory] = process.argv.slice(2);
if (!modules || !browserPath || !outputDirectory) throw new Error("Usage: node scripts/qaSolanaStandardConnection.mjs <runtime-node_modules> <browser-executable> <output-directory>");
const { chromium } = createRequire(join(resolve(modules), "package.json"))("playwright");
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: browserPath });
const measurements = [], errors = [];
const addresses = [1, 2].map(seed => base58.encode(new Uint8Array(32).fill(seed)));
const assert = (value, message) => { if (!value) throw new Error(message); };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("button", { name: "Universe", exact: true }).click();
  await page.getByRole("button", { name: "Wallets", exact: true }).click();
  await page.evaluate(addresses => {
    const counters = { connect: 0, forbidden: 0, earlyAccountReads: 0 };
    window.__standardConnectionCounters = counters;
    let allowed = false;
    const listeners = new Set();
    const accounts = addresses.map((address, i) => ({ address, publicKey: new Uint8Array(32).fill(i + 1), chains: ["solana:devnet"], features: ["solana:signTransaction"] }));
    const forbidden = () => { counters.forbidden++; throw new Error("Forbidden wallet operation"); };
    const wallet = { version: "1.0.0", name: "Synthetic wallet " + "W".repeat(60), chains: ["solana:devnet"],
      get accounts() { if (!allowed) { counters.earlyAccountReads++; throw new Error("Premature account read"); } return accounts; },
      get icon() { return forbidden(); },
      features: {
        "standard:events": { version: "1.0.0", on: (_event, listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
        "standard:connect": { version: "1.0.0", connect: async ({ silent }) => { if (silent !== false) forbidden(); counters.connect++; allowed = true; return { accounts }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: forbidden },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: forbidden },
        "solana:signAndSendTransaction": { version: "1.0.0", signAndSendTransaction: forbidden }
      }
    };
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: api => { window.__removeStandardConnection = api.register(wallet); } }));
    window.__changeStandardConnection = () => [...listeners].forEach(listener => listener({}));
  }, addresses);
  const panel = page.locator(".solana-standard-connection");
  await panel.locator("summary").click();
  await page.getByLabel("Solana wallet registration", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Solana connection network", { exact: true }).selectOption("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  assert(await page.evaluate(() => window.__standardConnectionCounters.connect === 0), "Automatic connection");
  await panel.getByRole("button", { name: "Request account access", exact: true }).click();
  await page.getByLabel("Solana account", { exact: true }).waitFor();
  await panel.getByText("Account access received.", { exact: false }).waitFor();
  assert(await page.getByLabel("Solana account", { exact: true }).inputValue() === "", "Automatic account selection");
  assert(await page.getByLabel("Transaction format", { exact: true }).inputValue() === "", "Automatic format selection");
  await page.getByLabel("Solana account", { exact: true }).selectOption(addresses[1]);
  await page.getByLabel("Transaction format", { exact: true }).selectOption("0");
  await panel.getByRole("button", { name: "Keep account selection", exact: true }).click();
  await panel.getByText(`Selected account: ${addresses[1]}`, { exact: true }).waitFor();
  for (const [name, width, height, scale] of [["desktop", 1280, 900, 1], ["mobile", 390, 844, 1], ["narrow", 320, 740, 1], ["text-200", 390, 844, 2]]) {
    await page.setViewportSize({ width, height });
    await panel.evaluate((element, scale) => {
      for (const item of [element, ...element.querySelectorAll("*")]) {
        if (!item.dataset.baseFontSize) item.dataset.baseFontSize = String(parseFloat(getComputedStyle(item).fontSize));
        item.style.fontSize = `${Number(item.dataset.baseFontSize) * scale}px`;
      }
    }, scale);
    await page.getByLabel("Solana wallet registration", { exact: true }).focus();
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    const result = await panel.evaluate(element => {
      const root = document.documentElement, active = document.activeElement;
      const rect = element.getBoundingClientRect();
      const badContent = [...element.querySelectorAll("p,label,button")].some(item => item.scrollWidth > item.clientWidth + 1);
      return { width: innerWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, left: rect.left, right: rect.right,
        minControlHeight: Math.min(...[...element.querySelectorAll("select,button")].map(item => item.getBoundingClientRect().height)),
        focusInside: element.contains(active), outline: getComputedStyle(active).outlineStyle, badContent, counters: window.__standardConnectionCounters };
    });
    measurements.push({ name, ...result });
    await panel.screenshot({ path: join(output, `${name}.png`) });
    assert(result.scrollWidth <= result.clientWidth && result.left >= 0 && result.right <= result.clientWidth + 1 && result.minControlHeight >= 44 && result.focusInside && result.outline !== "none" && !result.badContent, `Layout failed: ${JSON.stringify(result)}`);
    assert(result.counters.connect === 1 && result.counters.forbidden === 0 && result.counters.earlyAccountReads === 0, "Unexpected wallet access");
  }
  await page.evaluate(() => window.__changeStandardConnection());
  await panel.getByText("Local connection expired or changed.", { exact: false }).waitFor();
  assert(await panel.locator(".standard-account-selection").count() === 0, "Stale selection after event");
  await panel.getByRole("button", { name: "Request account access", exact: true }).click();
  await panel.getByText("Account access received.", { exact: false }).waitFor();
  await page.evaluate(() => window.__removeStandardConnection());
  await page.getByText("No Wallet Standard wallets detected.", { exact: false }).waitFor();
  assert(await page.getByLabel("Solana account", { exact: true }).inputValue() === "", "Stale account after removal");
  const counters = await page.evaluate(() => window.__standardConnectionCounters);
  assert(counters.connect === 2 && !counters.forbidden && !counters.earlyAccountReads && !errors.length, "Wallet or runtime regression");
  console.log(JSON.stringify({ measurements, counters, runtimeExceptions: errors.length, externalRequestsAllowed: false, realWalletsUsed: false, changeAndUnregisterVerified: true }, null, 2));
} finally { await browser.close(); }
