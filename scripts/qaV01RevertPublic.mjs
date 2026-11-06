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


// P0-09, revert: a swap the app itself sent, mined and failed, must be reported
// as a revert — not as unknown, and not as success.
//
// The revert is produced the way it happens in practice rather than by tampering
// with what the app asked for: the signing helper holds the swap until the
// deadline the app bound into the call has passed, then broadcasts it unchanged.
// The pool rejects it. This is the slow-confirmation case.
//
// The key never enters the browser; the helper signs and broadcasts.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01RevertPublic.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const ACCOUNT = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";
const CHAIN_ID = "0x14a34";
// keccak("swapExactIn(address,uint256,uint256,address,uint256)")[0:4].
// 0xc4dbea95 is addLiquidity and matches nothing here; getting this wrong makes
// the hold silently not apply and the swap simply succeed.
const SWAP_EXACT_IN = "0xb26aefb9";
const AMOUNT = "0.25";


const provider = new JsonRpcProvider(RPC_A);
const wallet = new Wallet(privateKey(), provider);
if (wallet.address !== ACCOUNT) throw new Error(`SIGNER_ADDRESS_MISMATCH: ${wallet.address}`);
const sends = [];

// The deadline is the fifth argument of swapExactIn.
const deadlineOf = data => {
  if (!data?.startsWith(SWAP_EXACT_IN)) return null;
  const word = data.slice(2 + 8 + 4 * 64, 2 + 8 + 5 * 64);
  return word.length === 64 ? Number(BigInt("0x" + word)) : null;
};

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
        const deadline = deadlineOf(tx.data);
        let heldForSeconds = 0;
        if (deadline) {
          // Hold past the app's own deadline, then send exactly what it asked for.
          const waitMs = Math.max(0, (deadline + 5) * 1000 - Date.now());
          heldForSeconds = Math.round(waitMs / 1000);
          if (waitMs > 0) await new Promise(done => setTimeout(done, waitMs));
        }
        const sent = await wallet.sendTransaction({
          to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined,
          // Estimation would reject an expired call, so the app's own limit is used.
          gasLimit: tx.gas ? BigInt(tx.gas) : 300000n
        });
        sends.push({ hash: sent.hash, to: tx.to, deadline, heldForSeconds, expiredWhenSent: Boolean(deadline) && deadline * 1000 < Date.now() });
        result = sent.hash;
      } else if (method === "eth_accounts" || method === "eth_requestAccounts") result = [ACCOUNT];
      else if (method === "eth_chainId") result = CHAIN_ID;
      else result = await provider.send(method, params);
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
  const provider = {
    isMetaMask: true,
    on: (event, handler) => { (listeners[event] ??= []).push(handler); },
    removeListener: (event, handler) => { listeners[event] = (listeners[event] ?? []).filter(h => h !== handler); },
    request: async ({ method, params }) => {
      const response = await fetch(${JSON.stringify(url)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
      const body = await response.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: 4001 });
      return body.result;
    }
  };
  const detail = Object.freeze({
    info: { uuid: "00000000-0000-4000-8000-000000000914", name: "QA SIGNING TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
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
const report = { servedRelease, scope: "built configured app on public Base Sepolia; the swap is broadcast unchanged after its own deadline passes, so the pool reverts it", cases: []  };
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  const origin = server.resolvedUrls.local[0];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
  await context.addInitScript(injectWallet(helperUrl));
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });

  await page.getByLabel("公開RPC A", { exact: true }).fill(RPC_A);
  await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(RPC_B);
  await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
  await verifiedOrRetry(page);
  await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: "QA SIGNING TRANSPORT（自己申告）" });
  await page.getByRole("button", { name: "選択したウォレットに接続" }).click();
  await page.locator(".v01-address", { hasText: ACCOUNT }).waitFor({ timeout: 30_000 });

  await page.locator('label:has-text("支払数量") input').fill(AMOUNT);
  await page.getByRole("button", { name: "見積りを取得" }).click();
  await page.getByText("見積りを取得しました。", { exact: false }).waitFor({ timeout: 40_000 });
  await page.getByRole("button", { name: /交換/ }).last().click();

  await page.locator('label:has-text("取引履歴") select').waitFor({ timeout: 300_000 });
  // Re-check until the observation settles on a terminal state.
  let label = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    label = (await page.locator('label:has-text("取引履歴") select option').first().textContent()) ?? "";
    if (/失敗|revert|取り消|拒否/i.test(label)) break;
    const refresh = page.getByRole("button", { name: "取引状況を照会" });
    if (await refresh.count()) await refresh.first().click().catch(() => {});
    await page.waitForTimeout(4000);
  }
  const card = ((await page.locator("[class*='recovery']").first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  await page.screenshot({ path: resolve(output, "reverted-swap.png"), fullPage: true, animations: "disabled" });

  const swapSend = sends.find(item => item.deadline);
  const receipt = swapSend ? await provider.getTransactionReceipt(swapSend.hash) : null;
  report.cases.push({
    sends, historyLabel: label.trim(), recordExcerpt: card.slice(0, 500),
    onChainStatus: receipt?.status ?? null, onChainBlock: receipt?.blockNumber ?? null, pageErrors: errors.length
  });

  // Write the record before asserting: a run that fails still has to leave evidence.
  await finishReport(output, report);
  process.stderr.write(`${JSON.stringify(report.cases[0], null, 2)}\n`);

  assert.ok(swapSend, "no swap was sent");
  assert.ok(swapSend.expiredWhenSent, "the swap was not broadcast after its deadline");
  assert.equal(receipt?.status, 0, "the swap did not revert on chain");
  assert.ok(/失敗|revert|取り消|拒否/i.test(label), `history did not report a failure: ${label}`);
  assert.deepEqual(errors, [], JSON.stringify(errors));

  await finishReport(output, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser?.close();
  helper.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
