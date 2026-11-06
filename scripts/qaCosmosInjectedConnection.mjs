import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { ripemd160, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { secp256k1 } from "@noble/curves/secp256k1";

const [modules, browserPath, outputDirectory] = process.argv.slice(2);
if (!modules || !browserPath || !outputDirectory) throw new Error("Usage: node scripts/qaCosmosInjectedConnection.mjs <runtime-node_modules> <browser-executable> <output-directory>");
const { chromium } = createRequire(join(resolve(modules), "package.json"))("playwright");
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
const privateKey = new Uint8Array(32);
privateKey[31] = 9;
const pubKey = secp256k1.getPublicKey(privateKey, true);
const address = ripemd160(sha256(pubKey));
const key = { name: "Synthetic QA account", algo: "secp256k1", pubKey: [...pubKey], address: [...address], bech32Address: toBech32("osmo", address), isNanoLedger: false };
const browser = await chromium.launch({ headless: true, executablePath: browserPath });
const measurements = [];
const errors = [];
const assert = (value, message) => { if (!value) throw new Error(message); };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await context.addInitScript(input => {
    const counters = { enable: 0, getKey: 0, forbidden: 0 };
    window.__cosmosConnectionCounters = counters;
    const walletKey = { ...input, pubKey: new Uint8Array(input.pubKey), address: new Uint8Array(input.address) };
    const provider = {
      enable: async chainId => {
        counters.enable += 1;
        if (chainId !== "osmo-test-5") throw new Error("Unexpected chain");
      },
      getKey: async chainId => {
        counters.getKey += 1;
        if (chainId !== "osmo-test-5") throw new Error("Unexpected chain");
        return walletKey;
      }
    };
    Object.defineProperty(provider, "signDirect", { get: () => { counters.forbidden += 1; throw new Error("Forbidden signing access"); } });
    Object.defineProperty(provider, "sendTx", { get: () => { counters.forbidden += 1; throw new Error("Forbidden broadcast access"); } });
    window.keplr = provider;
  }, key);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("button", { name: "Universe", exact: true }).click();
  await page.getByRole("button", { name: "Wallets", exact: true }).click();
  const panel = page.locator(".cosmos-injected-discovery");
  await panel.getByRole("heading", { name: "Cosmos injected wallet", exact: true }).waitFor();
  await panel.locator("summary").click();
  await page.getByLabel("Cosmos wallet provider", { exact: true }).selectOption("injected:keplr");
  await page.getByLabel("Cosmos connection network", { exact: true }).selectOption("cosmos:osmo-test-5");
  assert(await page.evaluate(() => window.__cosmosConnectionCounters.enable === 0 && window.__cosmosConnectionCounters.getKey === 0), "Automatic provider access");
  await panel.getByRole("button", { name: "Request account access", exact: true }).click();
  await panel.getByText(`Account to select: ${key.bech32Address}`, { exact: true }).waitFor();
  assert(await panel.getByText("Selected account:", { exact: false }).count() === 0, "Automatic account selection");
  await panel.getByRole("button", { name: "Keep this account selection", exact: true }).click();
  await panel.getByText(`Selected account: ${key.bech32Address}`, { exact: true }).waitFor();

  for (const [name, width, height, scale] of [["desktop", 1280, 900, 1], ["tablet", 768, 900, 1], ["mobile", 375, 812, 1], ["narrow", 320, 740, 1], ["text-200", 375, 812, 2]]) {
    await page.setViewportSize({ width, height });
    await panel.evaluate((element, textScale) => {
      for (const item of [element, ...element.querySelectorAll("*")]) {
        if (!item.dataset.baseFontSize) item.dataset.baseFontSize = String(parseFloat(getComputedStyle(item).fontSize));
        item.style.fontSize = `${Number(item.dataset.baseFontSize) * textScale}px`;
      }
    }, scale);
    await page.getByLabel("Cosmos wallet provider", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const result = await panel.evaluate(element => {
      const root = document.documentElement;
      const active = document.activeElement;
      const rect = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll("select,button")];
      const badContent = [...element.querySelectorAll("p,label,button")].some(item => item.scrollWidth > item.clientWidth + 1);
      return {
        width: innerWidth,
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        left: rect.left,
        right: rect.right,
        minControlHeight: Math.min(...controls.map(item => item.getBoundingClientRect().height)),
        focusInside: element.contains(active),
        outline: getComputedStyle(active).outlineStyle,
        badContent,
        counters: window.__cosmosConnectionCounters
      };
    });
    measurements.push({ name, ...result });
    await panel.screenshot({ path: join(output, `${name}.png`) });
    assert(result.scrollWidth <= result.clientWidth && result.left >= 0 && result.right <= result.clientWidth + 1, `Overflow: ${JSON.stringify(result)}`);
    assert(result.minControlHeight >= 44 && result.focusInside && result.outline !== "none" && !result.badContent, `Interaction/layout failed: ${JSON.stringify(result)}`);
    assert(result.counters.enable === 1 && result.counters.getKey >= 3 && result.counters.forbidden === 0, "Unexpected provider access");
  }

  await page.evaluate(() => window.dispatchEvent(new Event("keplr_keystorechange")));
  await panel.getByText("Local connection expired or changed.", { exact: false }).waitFor({ timeout: 3_000 });
  assert(await panel.getByText("Selected account:", { exact: false }).count() === 0, "Stale binding after keystore change");
  const counters = await page.evaluate(() => window.__cosmosConnectionCounters);
  assert(counters.enable === 1 && counters.forbidden === 0 && errors.length === 0, "Provider or runtime regression");
  console.log(JSON.stringify({ measurements, counters, runtimeExceptions: errors.length, externalRequestsAllowed: false, realWalletsUsed: false, keystoreInvalidationVerified: true }, null, 2));
} finally {
  await browser.close();
}
