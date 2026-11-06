import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { Interface, JsonRpcProvider, Wallet, formatUnits, getAddress, parseUnits } from "ethers";
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


// P0-04: what the screen shows must be what the wallet is asked to sign.
//
// The signing helper decodes each request before acting on it. The approval is
// broadcast so the run can reach the swap leg; the swap request is captured and
// then refused, so the comparison costs one approval and changes nothing else.
// A refusal is reported as 4001 because that is what it is — a wallet saying it
// submitted nothing.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01RequestMatchPublic.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const ACCOUNT = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";
const CHAIN_ID = "0x14a34";
const AMOUNT = "0.3";
// Read from the deployment record, never pinned here: a constant address keeps
// this check green against a retired deployment after a redeploy.
const { ambr: AMBR_ADDRESS } = v01Deployment();

const iface = new Interface([
  "function approve(address spender, uint256 value)",
  "function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient, uint256 deadline)"
]);


const provider = new JsonRpcProvider(RPC_A);
const wallet = new Wallet(privateKey(), provider);
const requests = [];

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

      const [tx] = params;
      const parsed = iface.parseTransaction({ data: tx.data });
      const decoded = {
        name: parsed?.name ?? null,
        to: tx.to ? getAddress(tx.to) : null,
        from: tx.from ? getAddress(tx.from) : null,
        args: parsed ? Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name, parsed.args[index].toString()])) : null,
        gas: tx.gas ?? null, maxFeePerGas: tx.maxFeePerGas ?? null, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
        nonce: tx.nonce ?? null, value: tx.value ?? null
      };
      requests.push(decoded);
      if (parsed?.name === "swapExactIn") {
        // Captured in full; refusing keeps the chain untouched for this leg.
        return reply({ error: { message: "User rejected the request.", code: 4001 } });
      }
      const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, gasLimit: tx.gas ? BigInt(tx.gas) : undefined });
      decoded.broadcastHash = sent.hash;
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
    info: { uuid: "00000000-0000-4000-8000-000000000916", name: "QA SIGNING TRANSPORT", rdns: "io.metamask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
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
const report = { servedRelease, scope: "built configured app on public Base Sepolia; every wallet request decoded and compared with the review panel", comparisons: []  };
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  const origin = server.resolvedUrls.local[0];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
  await context.addInitScript(injectWallet(helperUrl));
  const page = await context.newPage();
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

  // Read the panel the participant actually sees, before anything is signed.
  const shown = await page.evaluate(() => {
    const review = document.querySelector(".v01-review");
    const pairs = {};
    const list = review?.querySelector("dl");
    if (list) {
      const terms = [...list.querySelectorAll("dt")], values = [...list.querySelectorAll("dd")];
      terms.forEach((term, index) => { pairs[term.textContent.trim()] = values[index]?.textContent.trim() ?? ""; });
    }
    const steps = [...(review?.querySelectorAll("details") ?? [])].map(detail => {
      const entry = { summary: detail.querySelector("summary")?.textContent.trim() ?? "" };
      const terms = [...detail.querySelectorAll("dt")], values = [...detail.querySelectorAll("dd")];
      terms.forEach((term, index) => { entry[term.textContent.trim()] = values[index]?.textContent.trim() ?? ""; });
      return entry;
    });
    return { pairs, steps };
  });
  await page.screenshot({ path: resolve(output, "review-panel.png"), fullPage: true, animations: "disabled" });

  await page.getByRole("button", { name: /交換/ }).last().click();
  // Wait until both legs have been asked for, or the run stops.
  // The app waits for the approval to be visible before asking for the swap, and
  // a public endpoint can take a while to show it. Two minutes was not enough.
  for (let attempt = 0; attempt < 180 && !requests.some(item => item.name === "swapExactIn"); attempt++) await page.waitForTimeout(2000);

  const approval = requests.find(item => item.name === "approve");
  const swap = requests.find(item => item.name === "swapExactIn");
  const amountUnits = parseUnits(AMOUNT, 18);
  const shownAmount = parseUnits(shown.pairs["支払"].split(" ")[0], 18);
  const shownMinimum = parseUnits(shown.pairs["最低受取"].split(" ")[0], 18);
  const shownTarget = getAddress(shown.pairs["承認先・交換先"]);
  const shownRecipient = getAddress(shown.pairs["受取先"]);

  report.shown = shown;
  report.requests = requests;
  report.comparisons = [
    { field: "input amount", shown: shownAmount.toString(), requested: swap?.args.amountIn ?? null, match: swap?.args.amountIn === amountUnits.toString() && shownAmount === amountUnits },
    { field: "minimum received", shown: shownMinimum.toString(), requested: swap?.args.minAmountOut ?? null, match: swap?.args.minAmountOut === shownMinimum.toString() },
    { field: "recipient", shown: shownRecipient, requested: swap ? getAddress(swap.args.recipient) : null, match: swap ? getAddress(swap.args.recipient) === shownRecipient && shownRecipient === getAddress(ACCOUNT) : false },
    { field: "execution target", shown: shownTarget, requested: swap?.to ?? null, match: swap?.to === shownTarget },
    { field: "approval spender", shown: shownTarget, requested: approval ? getAddress(approval.args.spender) : null, match: approval ? getAddress(approval.args.spender) === shownTarget : null },
    { field: "approval amount", shown: `今回の${AMOUNT}のみ`, requested: approval?.args.value ?? null, match: approval ? approval.args.value === amountUnits.toString() : null },
    { field: "token in", shown: AMBR_ADDRESS, requested: swap ? getAddress(swap.args.tokenIn) : null, match: swap ? getAddress(swap.args.tokenIn) === AMBR_ADDRESS : false },
    { field: "deadline", shown: shown.pairs["期限"], requested: swap ? new Date(Number(swap.args.deadline) * 1000).toLocaleTimeString("ja-JP") : null, match: swap ? new Date(Number(swap.args.deadline) * 1000).toLocaleTimeString("ja-JP") === shown.pairs["期限"] : false }
  ];

  assert.ok(swap, "the swap request was never made");
  for (const field of ["input amount", "minimum received", "recipient", "execution target", "token in", "deadline"]) {
    const entry = report.comparisons.find(item => item.field === field);
    assert.equal(entry.match, true, `${field}: ${JSON.stringify(entry)}`);
  }
  // The approval half used to be checked only when an approval happened, so a
  // standing allowance turned this row into a six-of-eight pass that reported
  // itself as a pass. The deployment left 89,900 AMBR approved to the pool and the
  // app, correctly, asked for nothing — and the run exited clean while recording
  // "approval spender" and "approval amount" as unmatched.
  //
  // The row is about the screen agreeing with the wallet request, and the approval
  // is one of the requests it must agree about. If there is none, this run did not
  // cover it, and that has to fail rather than pass quietly. Reset the allowance to
  // zero (scripts/acceptV01Swaps.mjs --reset-allowance, or approve(spender, 0))
  // and run it again.
  assert.ok(approval, "no approval was requested, so the approval fields were never checked; reset the allowance to zero and re-run");
  for (const field of ["approval spender", "approval amount"]) {
    const entry = report.comparisons.find(item => item.field === field);
    assert.equal(entry.match, true, `${field}: ${JSON.stringify(entry)}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await finishReport(output, report);
  await browser?.close();
  helper.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
