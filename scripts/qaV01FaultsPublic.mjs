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


// P0-08 against the public deployment: wallet rejection, a lost response after a
// real send, repeated clicks, a second tab, and a reader on the wrong chain.
//
// Each case runs in a fresh browser context. The key stays out of the browser: a
// localhost helper signs and broadcasts, and it also counts what the page asked
// for, so "nothing was sent" is measured at the point of sending rather than
// inferred from the screen.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01FaultsPublic.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const WRONG_CHAIN_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const ACCOUNT = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";
const CHAIN_ID = "0x14a34";
const AMOUNT = "0.25";


const provider = new JsonRpcProvider(RPC_A);
const wallet = new Wallet(privateKey(), provider);
if (wallet.address !== ACCOUNT) throw new Error(`SIGNER_ADDRESS_MISMATCH: ${wallet.address}`);

// Behaviour switched per case, so one helper serves them all.
let mode = "normal";
let sendRequests = 0;
let broadcast = [];

const helper = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", async () => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") { response.statusCode = 204; return response.end(); }
    const reply = payload => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(payload)); };
    try {
      const { method, params = [] } = JSON.parse(body || "{}");
      if (method === "eth_accounts" || method === "eth_requestAccounts") return reply({ result: [ACCOUNT] });
      if (method === "eth_chainId") return reply({ result: CHAIN_ID });
      if (method !== "eth_sendTransaction") return reply({ result: await provider.send(method, params) });

      sendRequests += 1;
      if (mode === "reject") return reply({ error: { message: "User rejected the request.", code: 4001 } });
      const [tx] = params;
      const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gasLimit: tx.gas ? BigInt(tx.gas) : undefined });
      broadcast.push(sent.hash);
      // The transaction is real and on its way; only the answer is lost.
      if (mode === "lose-response") return reply({ error: { message: "network error: response lost", code: -32603 } });
      return reply({ result: sent.hash });
    } catch (error) {
      reply({ error: { message: error.shortMessage ?? error.message ?? String(error) } });
    }
  });
});
await new Promise(done => helper.listen(0, "127.0.0.1", done));
const helperUrl = `http://127.0.0.1:${helper.address().port}/`;

const injectWallet = url => `(() => {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    on: (event, handler) => { (listeners[event] ??= []).push(handler); },
    removeListener: (event, handler) => { listeners[event] = (listeners[event] ?? []).filter(h => h !== handler); },
    request: async ({ method, params }) => {
      const response = await fetch(${JSON.stringify(url)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
      const body = await response.json();
      if (body.error) throw Object.assign(new Error(body.error.message), body.error.code === undefined ? {} : { code: body.error.code });
      return body.result;
    }
  };
  const detail = Object.freeze({
    info: { uuid: "00000000-0000-4000-8000-000000000915", name: "QA SIGNING TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
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
const report = { servedRelease, scope: "built configured app on public Base Sepolia; faults injected at the wallet and at the reader, sends counted in the helper", cases: []  };
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  const origin = server.resolvedUrls.local[0];

  const newContext = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
    await context.addInitScript(injectWallet(helperUrl));
    return context;
  };
  const verifyAndConnect = async (page, rpcB = RPC_B) => {
    await page.getByLabel("公開RPC A", { exact: true }).fill(RPC_A);
    await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(rpcB);
    await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
  };
  const connectWallet = async page => {
    await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: "QA SIGNING TRANSPORT（自己申告）" });
    await page.getByRole("button", { name: "選択したウォレットに接続" }).click();
    await page.locator(".v01-address", { hasText: ACCOUNT }).waitFor({ timeout: 30_000 });
  };
  // A stop may surface as the error alert or as the live notice. Read both rather
  // than assuming one, and never let the absence of an alert pass as success.
  const stopMessage = async (page, timeoutMs = 90_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const alert = await page.getByRole("alert").first().textContent().catch(() => null);
      const notice = await page.locator(".v01-notice").first().textContent().catch(() => null);
      const text = [alert, notice].filter(Boolean).map(value => value.replace(/\s+/g, " ").trim()).join(" | ");
      if (text && !/^処理中です/.test(text)) return text;
      await page.waitForTimeout(1000);
    }
    return "";
  };

  const quote = async page => {
    await page.locator('label:has-text("支払数量") input').fill(AMOUNT);
    await page.getByRole("button", { name: "見積りを取得" }).click();
    await page.getByText("見積りを取得しました。", { exact: false }).waitFor({ timeout: 40_000 });
  };

  // 1. A reader on the wrong chain must stop verification. No wallet, no send.
  {
    const context = await newContext();
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    await verifyAndConnect(page, WRONG_CHAIN_RPC);
    const message = await stopMessage(page, 60_000);
    const stillUnverified = await page.getByText("未検証", { exact: true }).isVisible().catch(() => false);
    const connectDisabled = await page.getByRole("button", { name: "選択したウォレットに接続" }).isDisabled();
    report.cases.push({ case: "reader on the wrong chain", message, verificationBlocked: connectDisabled, stillUnverified, sendsRequested: sendRequests });
    assert.ok(connectDisabled, "a reader on the wrong chain still allowed the wallet to be connected");
    assert.ok(stillUnverified, "the surface did not stay unverified after the chain mismatch");
    assert.equal(sendRequests, 0, "the wallet was asked to send despite a reader on the wrong chain");
    await page.screenshot({ path: resolve(output, "wrong-chain-reader.png"), fullPage: true, animations: "disabled" });
    await context.close();
  }

  // 2. Wallet rejection: nothing may be broadcast.
  {
    mode = "reject"; sendRequests = 0; broadcast = [];
    const context = await newContext();
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    await verifyAndConnect(page);
    await verifiedOrRetry(page);
    await connectWallet(page);
    await quote(page);
    await page.getByRole("button", { name: /交換/ }).last().click();
    const message = await stopMessage(page);
    assert.equal(broadcast.length, 0, "a rejected request still reached the chain");
    assert.ok(sendRequests > 0, "the app never asked the wallet to send");
    report.cases.push({ case: "wallet rejection", message, sendsRequested: sendRequests, broadcast: broadcast.length });
    await page.screenshot({ path: resolve(output, "wallet-rejection.png"), fullPage: true, animations: "disabled" });
    await context.close();
  }

  // 3. Repeated clicks on the execute control must produce one send.
  {
    mode = "normal"; sendRequests = 0; broadcast = [];
    const context = await newContext();
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    await verifyAndConnect(page);
    await verifiedOrRetry(page);
    await connectWallet(page);
    await quote(page);
    const execute = page.getByRole("button", { name: /交換/ }).last();
    for (let click = 0; click < 6; click++) await execute.click({ force: true, timeout: 2000 }).catch(() => {});
    await page.locator('label:has-text("取引履歴") select').waitFor({ timeout: 180_000 });
    await page.waitForTimeout(4000);
    assert.equal(sendRequests, 1, `six clicks should collapse to exactly one send request, got ${sendRequests}`);
    report.cases.push({ case: "repeated execute clicks", clicks: 6, sendsRequested: sendRequests, broadcast: broadcast.length, hashes: [...broadcast] });
    await page.screenshot({ path: resolve(output, "repeated-clicks.png"), fullPage: true, animations: "disabled" });
    await context.close();
  }

  // 4. A lost answer after a real broadcast must read as unknown, not as not-sent,
  //    and a second tab on the same storage must see the operation.
  {
    mode = "lose-response"; sendRequests = 0; broadcast = [];
    const context = await newContext();
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    await verifyAndConnect(page);
    await verifiedOrRetry(page);
    await connectWallet(page);
    await quote(page);
    await page.getByRole("button", { name: /交換/ }).last().click();
    const message = await stopMessage(page);
    const sentAnyway = broadcast.length;
    // Read the first tab too. Without it, a second tab that shows nothing cannot
    // be told apart from an operation that was never recorded anywhere.
    const firstTabText = ((await page.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
    const firstTabSeesOperation = /保存済み送信要求とハッシュを照合|取引履歴/.test(firstTabText);
    const firstTabCanStartAnother = await page.getByRole("button", { name: "見積りを取得" }).isEnabled().catch(() => null);
    await page.screenshot({ path: resolve(output, "lost-response.png"), fullPage: true, animations: "disabled" });

    // A second tab cannot show a record for a target it has not verified, so ask
    // it the question properly: verify and connect there, then look.
    const second = await context.newPage();
    await second.goto(origin, { waitUntil: "networkidle" });
    const beforeVerify = ((await second.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
    await verifyAndConnect(second);
    await verifiedOrRetry(second);
    await connectWallet(second);
    const afterVerify = ((await second.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
    const secondTabSeesOperation = /保存済み送信要求とハッシュを照合|取引履歴/.test(afterVerify);
    const secondTabSeesBeforeVerify = /保存済み送信要求とハッシュを照合|取引履歴/.test(beforeVerify);
    const secondTabCanStartAnother = await second.getByRole("button", { name: "見積りを取得" }).isEnabled().catch(() => null);
    await second.screenshot({ path: resolve(output, "second-tab.png"), fullPage: true, animations: "disabled" });

    await page.waitForTimeout(6000);
    assert.equal(broadcast.length, sentAnyway, "something was resent after the lost answer");
    assert.equal(firstTabCanStartAnother, false, "the originating tab could start another operation after a lost answer");
    assert.equal(secondTabCanStartAnother, false, "a second tab could start another operation after a lost answer");
    assert.ok(firstTabSeesOperation, "the originating tab lost sight of the operation");
    assert.ok(secondTabSeesOperation, "a second tab did not see the unresolved operation");
    report.cases.push({ case: "lost answer after a real send", message, broadcastHashes: [...broadcast], resentAfterLoss: false, firstTabSeesOperation, firstTabCanStartAnother, secondTabSeesBeforeVerify, secondTabSeesOperation, secondTabCanStartAnother });
    await context.close();
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await finishReport(output, report);
  process.stderr.write(`cases recorded: ${report.cases.length}\n`);
  await browser?.close();
  helper.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
