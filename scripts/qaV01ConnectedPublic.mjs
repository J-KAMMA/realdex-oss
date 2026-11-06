import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { assertServedBuildIsCurrent } from "./v01ServedBuild.mjs";
import { beginReport, finishReport } from "./v01Report.mjs";

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
// P0-03 against the public deployment: explicit wallet selection, the account and
// chain the app acted on, and invalidation when either changes.
//
// The built app with its shipped configuration is served, and it reads the real
// Base Sepolia deployment through the two public RPC hosts. The wallet is a
// synthetic EIP-6963 provider: it answers account and chain questions and records
// every request, but it holds no key. The run asserts that no signing or sending
// method is ever reached, so nothing can be broadcast from here.
//
// This is not extension evidence. Under the 2026-09-03 scope split the extension
// is P0-13, out of v0.1.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01ConnectedPublic.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const ALLOWED = new Set([new URL(RPC_A).origin, new URL(RPC_B).origin]);
const ACCOUNT = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";
const OTHER_ACCOUNT = "0x000000000000000000000000000000000000dEaD";
const BASE_SEPOLIA = "0x14a34";
const OTHER_CHAIN = "0xaa36a7"; // Ethereum Sepolia
const FORBIDDEN = ["eth_sendTransaction", "eth_sign", "eth_signTypedData_v4", "personal_sign", "eth_sendRawTransaction"];

const playwright = await import(pathToFileURL(resolve(playwrightModule)).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("playwright module exposes no chromium");
const output = resolve(outputDirectory);
await beginReport(output);

const injectWallet = (account, chainId) => `(() => {
  const state = { account: ${JSON.stringify(account)}, chainId: ${JSON.stringify(chainId)} };
  const listeners = {};
  window.__qaWalletCalls = [];
  const provider = {
    isMetaMask: true,
    on: (event, handler) => { (listeners[event] ??= []).push(handler); },
    removeListener: (event, handler) => { listeners[event] = (listeners[event] ?? []).filter(h => h !== handler); },
    request: async ({ method }) => {
      window.__qaWalletCalls.push(method);
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [state.account];
      if (method === "eth_chainId") return state.chainId;
      if (method === "net_version") return String(parseInt(state.chainId, 16));
      throw Object.assign(new Error("QA_WALLET_METHOD_NOT_ALLOWED: " + method), { code: 4200 });
    }
  };
  window.__qaSetChain = id => { state.chainId = id; (listeners.chainChanged ?? []).forEach(h => h(id)); };
  window.__qaSetAccount = address => { state.account = address; (listeners.accountsChanged ?? []).forEach(h => h([address])); };
  const detail = Object.freeze({
    info: { uuid: "00000000-0000-4000-8000-000000000912", name: "QA SYNTHETIC TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
    provider
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})()`;

const servedRelease = await assertServedBuildIsCurrent();
const server = await preview({ configFile: false, preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
const report = { servedRelease, scope: "built configured app against the real Base Sepolia deployment with a synthetic keyless EIP-6963 wallet; no extension, no signing, no send", cases: []  };
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  const origin = server.resolvedUrls.local[0];

  const openConnectedPage = async context => {
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    // Connecting must be closed before the fixed target is verified.
    assert.ok(await page.getByRole("button", { name: "選択したウォレットに接続" }).isDisabled());
    await page.getByLabel("公開RPC A", { exact: true }).fill(RPC_A);
    await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(RPC_B);
    await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
    await verifiedOrRetry(page);
    // Still closed: a verified target alone is not an explicit wallet choice.
    assert.ok(await page.getByRole("button", { name: "選択したウォレットに接続" }).isDisabled());
    // The label wraps the select, so its accessible name includes every option.
    // Address the control structurally instead.
    await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: "QA SYNTHETIC TRANSPORT（自己申告）" });
    await page.getByRole("button", { name: "選択したウォレットに接続" }).click();
    await page.getByText(ACCOUNT, { exact: true }).waitFor({ timeout: 30_000 });
    return page;
  };

  const takeQuote = async page => {
    await page.locator('label:has-text("支払数量") input').fill("1");
    await page.getByRole("button", { name: "見積りを取得" }).click();
    await page.getByText("見積りを取得しました。", { exact: false }).waitFor({ timeout: 40_000 });
    const executeButton = page.getByRole("button", { name: /交換/ }).last();
    assert.ok(await executeButton.isEnabled(), "quote did not enable execution");
    return executeButton;
  };

  for (const change of ["chain", "account"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
    const disallowed = [], errors = [];
    await context.addInitScript(injectWallet(ACCOUNT, BASE_SEPOLIA));
    await context.route("**/*", route => {
      const requestOrigin = new URL(route.request().url()).origin;
      if (requestOrigin === new URL(origin).origin || ALLOWED.has(requestOrigin)) return route.continue();
      disallowed.push(requestOrigin); return route.abort();
    });
    const page = await openConnectedPage(context);
    page.on("pageerror", error => errors.push(error.message));
    const executeButton = await takeQuote(page);

    // The change the user did not make in the app must invalidate what it holds.
    if (change === "chain") await page.evaluate(id => window.__qaSetChain(id), OTHER_CHAIN);
    else await page.evaluate(address => window.__qaSetAccount(address), OTHER_ACCOUNT);

    await page.getByText("ウォレットの状態が変わりました。", { exact: false }).waitFor({ timeout: 15_000 });
    assert.ok(await executeButton.isDisabled(), `execution stayed enabled after ${change} change`);
    assert.ok(await page.getByRole("button", { name: "見積りを取得" }).isDisabled(), `quoting stayed enabled after ${change} change`);

    const walletCalls = await page.evaluate(() => window.__qaWalletCalls);
    const forbidden = walletCalls.filter(method => FORBIDDEN.includes(method));
    assert.deepEqual(forbidden, [], JSON.stringify(walletCalls));
    assert.deepEqual(disallowed, [], JSON.stringify(disallowed));
    assert.deepEqual(errors, [], JSON.stringify(errors));

    await page.screenshot({ path: resolve(output, `invalidated-by-${change}.png`), fullPage: true, animations: "disabled" });
    report.cases.push({ change, walletMethods: [...new Set(walletCalls)], forbiddenMethodsReached: forbidden.length, executionDisabledAfterChange: true, quotingDisabledAfterChange: true, pageErrors: errors.length, disallowedOrigins: disallowed.length });
    await context.close();
  }

  await finishReport(output, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
