import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { JsonRpcProvider, Wallet } from "ethers";
import { v01SignerPrivateKey as privateKey } from "./v01Signer.mjs";
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


// P0-09 against the public deployment: the app itself sends, then the page is
// reloaded and the record must come back and be re-checkable.
//
// The app only creates a recovery record for a send it made, so the wallet has to
// sign. The key never enters the browser: the injected provider forwards every
// request to a localhost helper in this process, which signs with the test-only
// key and broadcasts through the public RPC. Everything the page can reach is
// therefore either the app, the two public RPC hosts, or that helper.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01RecoveryPublic.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const ACCOUNT = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";
const CHAIN_ID = "0x14a34";
const AMOUNT = "0.5";


const provider = new JsonRpcProvider(RPC_A);
const wallet = new Wallet(privateKey(), provider);
if (wallet.address !== ACCOUNT) throw new Error(`SIGNER_ADDRESS_MISMATCH: ${wallet.address}`);
const sentHashes = [];

// Localhost signing helper. It is the only thing that holds the key.
const helper = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", async () => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") { response.statusCode = 204; return response.end(); }
    try {
      const { method, params = [] } = JSON.parse(body || "{}");
      let result;
      if (method === "eth_sendTransaction") {
        const [tx] = params;
        const sent = await wallet.sendTransaction({
          to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined,
          gasLimit: tx.gas ? BigInt(tx.gas) : undefined
        });
        sentHashes.push({ hash: sent.hash, to: tx.to });
        result = sent.hash;
      } else if (method === "eth_accounts" || method === "eth_requestAccounts") {
        result = [ACCOUNT];
      } else if (method === "eth_chainId") {
        result = CHAIN_ID;
      } else {
        result = await provider.send(method, params);
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: { message: error.shortMessage ?? error.message ?? String(error) } }));
    }
  });
});
await new Promise(done => helper.listen(0, "127.0.0.1", done));
const helperUrl = `http://127.0.0.1:${helper.address().port}/`;

const injectWallet = url => `(() => {
  const listeners = {};
  window.__qaWalletCalls = [];
  const provider = {
    isMetaMask: true,
    on: (event, handler) => { (listeners[event] ??= []).push(handler); },
    removeListener: (event, handler) => { listeners[event] = (listeners[event] ?? []).filter(h => h !== handler); },
    request: async ({ method, params }) => {
      window.__qaWalletCalls.push(method);
      const response = await fetch(${JSON.stringify(url)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
      const body = await response.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: 4001 });
      return body.result;
    }
  };
  const detail = Object.freeze({
    info: { uuid: "00000000-0000-4000-8000-000000000913", name: "QA SIGNING TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
    provider
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})()`;

const playwright = await import(pathToFileURL(resolve(playwrightModule)).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
const output = resolve(outputDirectory);
await beginReport(output);
const servedRelease = await assertServedBuildIsCurrent();
const server = await preview({ configFile: false, preview: { host: "127.0.0.1", port: 0, open: false } });
let browser;
const report = { servedRelease, scope: "built configured app on public Base Sepolia; the app performs the send through a localhost signing helper, then the page is reloaded", cases: []  };
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  const origin = server.resolvedUrls.local[0];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
  await context.addInitScript(injectWallet(helperUrl));
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));

  const prepare = async () => {
    await page.getByLabel("公開RPC A", { exact: true }).fill(RPC_A);
    await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(RPC_B);
    await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
    await verifiedOrRetry(page);
    await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: "QA SIGNING TRANSPORT（自己申告）" });
    await page.getByRole("button", { name: "選択したウォレットに接続" }).click();
    // After a reload the restored candidate panel also prints the address, so
    // scope this to the connection card rather than matching page-wide.
    await page.locator(".v01-address", { hasText: ACCOUNT }).waitFor({ timeout: 30_000 });
  };

  await page.goto(origin, { waitUntil: "networkidle" });
  await prepare();

  // Before any send there is nothing to recover.
  assert.ok(await page.getByText("この固定プールの取引記録はまだありません。", { exact: false }).isVisible());

  await page.locator('label:has-text("支払数量") input').fill(AMOUNT);
  await page.getByRole("button", { name: "見積りを取得" }).click();
  await page.getByText("見積りを取得しました。", { exact: false }).waitFor({ timeout: 40_000 });

  const executeButton = page.getByRole("button", { name: /交換/ }).last();
  const executeLabel = (await executeButton.textContent()) ?? "";
  await executeButton.click();
  // Sends are real public transactions; allow for approval plus swap.
  await page.locator('label:has-text("取引履歴") select').waitFor({ timeout: 180_000 });
  const beforeReload = await page.locator('label:has-text("取引履歴") select option').allTextContents();
  await page.screenshot({ path: resolve(output, "before-reload.png"), fullPage: true, animations: "disabled" });

  // The reload is the point of P0-09: the record must survive it. Its stage may
  // legitimately advance, because a restored record is re-observed rather than
  // replayed from memory — demanding an identical label would forbid exactly the
  // distinction this row asks for. What must not change is which operation it is.
  await page.reload({ waitUntil: "networkidle" });
  const afterReload = await page.locator('label:has-text("取引履歴") select option').allTextContents();
  // Without this, an empty history passes everything below it: 0 === 0, deepEqual
  // of two empty arrays, and a loop over nothing. The row asks whether a record
  // survives a reload, so "there was never a record" has to fail, not pass.
  assert.ok(beforeReload.length > 0, `no history record existed before the reload: ${JSON.stringify({ beforeReload })}`);
  assert.ok(afterReload.length > 0, `the history was empty after the reload: ${JSON.stringify({ beforeReload, afterReload })}`);
  assert.equal(afterReload.length, beforeReload.length, JSON.stringify({ beforeReload, afterReload }));
  const identity = label => label.split("·").slice(0, 2).join("·").trim();
  assert.deepEqual(afterReload.map(identity), beforeReload.map(identity), JSON.stringify({ beforeReload, afterReload }));
  const stage = label => label.split("·").slice(2).join("·").trim();
  const stagesBefore = beforeReload.map(stage), stagesAfter = afterReload.map(stage);
  for (const value of [...stagesBefore, ...stagesAfter]) assert.ok(value.length > 0, JSON.stringify({ beforeReload, afterReload }));

  // A restored record is not a verified one until it is re-checked.
  await prepare();
  const restoredCard = await page.locator(".v01-recovery, [class*='recovery']").first().textContent().catch(() => "");
  await page.screenshot({ path: resolve(output, "after-reload.png"), fullPage: true, animations: "disabled" });

  const walletCalls = await page.evaluate(() => window.__qaWalletCalls);
  report.cases.push({
    executeLabel: executeLabel.trim(),
    publicSends: sentHashes,
    historyBeforeReload: beforeReload,
    historyAfterReload: afterReload,
    stageAdvancedOnReload: JSON.stringify(stagesBefore) !== JSON.stringify(stagesAfter),
    restoredRecordExcerpt: (restoredCard ?? "").replace(/\s+/g, " ").slice(0, 400),
    walletMethods: [...new Set(walletCalls)],
    pageErrors: errors.length
  });
  assert.ok(sentHashes.length > 0, "the app sent nothing");
  assert.deepEqual(errors, [], JSON.stringify(errors));

  await finishReport(output, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  helper.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
