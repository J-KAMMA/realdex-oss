import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress, parseEther } from "ethers";
import { v01Deployment } from "./v01Deployment.mjs";
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


// P0-05: the app must stop, and send nothing, when the conditions it displays
// are not met. Every case runs against the real deployment.
//
// Three cases need nothing but the real chain: an amount above the balance, an
// expired quote, and a price that moves between the quote and the send. The
// fourth needs a gas balance the account does not have, so that one value is
// rewritten in the browser network layer — and is labelled as injected rather
// than presented as a chain state.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01StopsPublic.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const ACCOUNT = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";
const CHAIN_ID = "0x14a34";
// Read from the deployment record, never pinned here: a constant address keeps
// this check green against a retired deployment after a redeploy.
const { pool: POOL, ambr: AMBR } = v01Deployment();


const provider = new JsonRpcProvider(RPC_A);
const wallet = new Wallet(privateKey(), provider);
let sendRequests = 0;
let broadcast = [];

// The app refuses a non-HTTPS reader endpoint, so a local proxy cannot stand in
// for the public RPC. The one value that has to differ is rewritten in the
// browser's own network layer instead, and only while an override is set.
let gasBalanceOverride = null;

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
      const [tx] = params;
      const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, gasLimit: tx.gas ? BigInt(tx.gas) : 300000n });
      broadcast.push(sent.hash);
      return reply({ result: sent.hash });
    } catch (error) {
      reply({ error: { message: error.shortMessage ?? error.message ?? String(error), code: -32603 } });
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
    info: { uuid: "00000000-0000-4000-8000-000000000917", name: "QA SIGNING TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
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
const report = { servedRelease, scope: "built configured app on public Base Sepolia; stop conditions observed, sends counted at the signing helper", cases: []  };
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  const origin = server.resolvedUrls.local[0];

  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
    await context.addInitScript(injectWallet(helperUrl));
    await context.route(RPC_A, async route => {
      if (!gasBalanceOverride) return route.continue();
      const payload = JSON.parse(route.request().postData() ?? "{}");
      if (payload.method !== "eth_getBalance" || getAddress(payload.params?.[0] ?? ACCOUNT) !== getAddress(ACCOUNT)) return route.continue();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: gasBalanceOverride }) });
    });
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByLabel("公開RPC A", { exact: true }).fill(RPC_A);
    await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(RPC_B);
    await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
    await verifiedOrRetry(page);
    await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: "QA SIGNING TRANSPORT（自己申告）" });
    await page.getByRole("button", { name: "選択したウォレットに接続" }).click();
    await page.locator(".v01-address", { hasText: ACCOUNT }).waitFor({ timeout: 40_000 });
    return { context, page };
  };
  const message = async (page, timeoutMs = 60_000) => {
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

  // 1. More than the account holds.
  {
    sendRequests = 0; broadcast = [];
    const { context, page } = await open();
    await page.locator('label:has-text("支払数量") input').fill("1000000");
    await page.getByRole("button", { name: "見積りを取得" }).click();
    const text = await message(page);
    const quoted = await page.locator(".v01-review").count();
    report.cases.push({ case: "amount above the token balance", message: text, quoteShown: quoted > 0, sendsRequested: sendRequests });
    await page.screenshot({ path: resolve(output, "over-balance.png"), fullPage: true, animations: "disabled" });
    assert.equal(sendRequests, 0);
    assert.equal(quoted, 0, "a quote was offered for more than the balance");
    await context.close();
  }

  // 2. A quote left to expire cannot be executed.
  {
    sendRequests = 0; broadcast = [];
    const { context, page } = await open();
    await page.locator('label:has-text("支払数量") input').fill("0.2");
    await page.getByRole("button", { name: "見積りを取得" }).click();
    await page.getByText("見積りを取得しました。", { exact: false }).waitFor({ timeout: 40_000 });
    const executeBefore = await page.getByRole("button", { name: /交換/ }).last().isEnabled();
    await page.waitForTimeout(65_000); // the quote TTL is one minute
    const expiredLabel = await page.getByText("（失効）", { exact: false }).count();
    const executeAfter = await page.getByRole("button", { name: /交換/ }).last().isEnabled();
    report.cases.push({ case: "quote left to expire", executableBefore: executeBefore, executableAfter: executeAfter, expiryShown: expiredLabel > 0, sendsRequested: sendRequests });
    await page.screenshot({ path: resolve(output, "expired-quote.png"), fullPage: true, animations: "disabled" });
    assert.equal(executeBefore, true);
    assert.equal(executeAfter, false, "an expired quote stayed executable");
    assert.equal(sendRequests, 0);
    await context.close();
  }

  // 3. Not enough gas for the fee budget. The balance is injected, not real.
  {
    sendRequests = 0; broadcast = [];
    gasBalanceOverride = "0x1"; // 1 wei
    const { context, page } = await open();
    await page.locator('label:has-text("支払数量") input').fill("0.2");
    await page.getByRole("button", { name: "見積りを取得" }).click();
    const text = await message(page);
    const quoted = await page.locator(".v01-review").count();
    report.cases.push({ case: "gas balance below the fee budget (injected reader value)", injectedBalanceWei: gasBalanceOverride, message: text, quoteShown: quoted > 0, sendsRequested: sendRequests });
    await page.screenshot({ path: resolve(output, "insufficient-gas.png"), fullPage: true, animations: "disabled" });
    assert.equal(sendRequests, 0);
    gasBalanceOverride = null;
    await context.close();
  }

  // 4. The price moves between the quote and the send, so the minimum is missed.
  {
    sendRequests = 0; broadcast = [];
    const { context, page } = await open();
    await page.locator('label:has-text("支払数量") input').fill("0.2");
    await page.getByRole("button", { name: "見積りを取得" }).click();
    await page.getByText("見積りを取得しました。", { exact: false }).waitFor({ timeout: 40_000 });

    // Move the pool with a separate, real swap before the app's send goes out.
    const pool = new Contract(POOL, new Interface([
      "function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient, uint256 deadline) returns (uint256)"
    ]), wallet);
    const token = new Contract(AMBR, new Interface(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]), wallet);
    // Enough to break a 0.5% bound on a 0.2 AMBR trade, not more.
    const moveAmount = parseEther("200");
    if ((await token.allowance(ACCOUNT, POOL)) < moveAmount) {
      await (await token.approve(POOL, moveAmount)).wait();
      // The receipt is not enough: the node that estimates the swap must see it.
      for (let attempt = 0; attempt < 20 && (await token.allowance(ACCOUNT, POOL)) < moveAmount; attempt++) await new Promise(done => setTimeout(done, 1500));
    }
    // The pool now refuses a swap with no minimum at all, and this setup swap is
    // no exception. A bound of 1 is honest here: this transaction exists to move
    // the price, not to protect anyone, but it still may not be unbounded.
    const mover = await pool.swapExactIn(AMBR, moveAmount, 1n, ACCOUNT, Math.floor(Date.now() / 1000) + 600);
    await mover.wait();

    await page.getByRole("button", { name: /交換/ }).last().click();
    const text = await message(page, 180_000);
    const swapHash = broadcast[broadcast.length - 1];
    const receipt = swapHash ? await provider.getTransactionReceipt(swapHash) : null;
    report.cases.push({ case: "price moved after the quote", priceMoverHash: mover.hash, message: text, walletAskedToSend: sendRequests, appSendHash: swapHash ?? null, appSendStatus: receipt?.status ?? null });

    // This case recorded its result and asserted nothing, so a run in which the
    // app happily sent after the price moved would have written that down and
    // exited clean. The whole point of the row is that it stops, and the number
    // that says it stopped has to be checked, not merely printed.
    assert.equal(sendRequests, 0, `the wallet was asked to send after the price moved: ${JSON.stringify(report.cases[report.cases.length - 1])}`);
    assert.equal(swapHash ?? null, null, "a swap was broadcast after the price moved");
    await page.screenshot({ path: resolve(output, "minimum-out-violated.png"), fullPage: true, animations: "disabled" });
    await context.close();
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await finishReport(output, report);
  await browser?.close();
  helper.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
