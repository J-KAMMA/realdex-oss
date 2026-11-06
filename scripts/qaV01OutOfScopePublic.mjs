import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";
import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { v01Deployment } from "./v01Deployment.mjs";
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


// P0-10: nothing outside the fixed v0.1 target may look tradable.
//
// This is worth doing here rather than only in unit tests because out-of-scope
// assets genuinely exist on the same chain: three retired deployments, one of
// which also holds a third demo token and a second pool. If the app leaked
// anything discoverable from a factory, they would be the leak.
//
// What "in scope" means changed when fee tiers arrived. v0.1 could define it as
// one pool address, so this checked the absence of everything else. A screen that
// lists tiers reads the verified factory's registry, so case D checks the property
// that survives a second tier: the registry stays inside the verified pair. See
// the internal design notes (not published) for what this run does and does not guarantee.
//
// No key is loaded and no wallet method beyond account and chain questions is
// answered, so nothing can be sent from this run.
const [playwrightModule, chromePath, outputDirectory] = process.argv.slice(2);
if (!playwrightModule || !chromePath || !outputDirectory) throw new Error("Usage: node scripts/qaV01OutOfScopePublic.mjs PLAYWRIGHT_MODULE CHROME_PATH OUTPUT_DIRECTORY");

const RPC_A = "https://sepolia.base.org";
const RPC_B = "https://base-sepolia-rpc.publicnode.com";
const ACCOUNT = "0x3EF758d338E783a69CD297f6907c1adf98970f2c";
const BASE_SEPOLIA = "0x14a34";

// In scope, read from the deployment record so a redeploy cannot leave this
// checking a retired target while still reporting green.
const { ambr: AMBR, jade: JADE, pool: POOL, factory: FACTORY } = v01Deployment();
// Out of scope, but real, and on the same chain. Kept as constants only so the
// chain-derived set below can be checked against something known: a derivation
// that quietly collapsed to nothing would otherwise still report green.
const ONYX = "0x9d1f1296537776144968ef851cAEe73B37fEaCEa";
const ONYX_POOL = "0xEB8d082EB9E49D1FE94611f3f3e42E45d9F8f539";

// A retired deployment is the most dangerous kind of out-of-scope target: it looks
// exactly like the real thing and its pool is still exposed to the flaw that
// retired it. If any of its addresses reach the screen, a participant could act on
// it. Read from the archived record so the list cannot drift.
const retiredDir = resolve("artifacts-v01");
const retiredRecords = existsSync(retiredDir)
  ? readdirSync(retiredDir)
      .filter(name => /^deployment-\d+-retired-.+\.json$/.test(name))
      .map(name => [name.replace(/^deployment-\d+-retired-|\.json$/g, ""), JSON.parse(readFileSync(resolve(retiredDir, name), "utf8"))])
  : [];
const RETIRED = retiredRecords.flatMap(([release, record]) =>
  Object.entries(record.addresses).map(([role, address]) => [release + " " + role, address]));

const provider = new JsonRpcProvider(RPC_A);

// Which addresses are out of scope is a question the chain can answer, and the
// answer grows on its own. Walking each retired factory's registry finds every
// pool it ever created and both tokens each one trades, rather than trusting two
// constants written by hand — which had already gone stale: ONYX and its pool sit
// on the third retired factory, not on the factory this release deploys against.
const REGISTRY_ABI = ["function allPoolsLength() view returns (uint256)", "function allPools(uint256) view returns (address)"];
const POOL_PAIR_ABI = ["function token0() view returns (address)", "function token1() view returns (address)", "function factory() view returns (address)"];
async function registryOf (factory) {
  const contract = new Contract(factory, REGISTRY_ABI, provider);
  const count = Number(await contract.allPoolsLength());
  const rows = [];
  for (let index = 0; index < count; index++) {
    const pool = await contract.allPools(index);
    const summary = new Contract(pool, POOL_PAIR_ABI, provider);
    const [token0, token1, namedFactory] = await Promise.all([summary.token0(), summary.token1(), summary.factory()]);
    rows.push({ pool, token0, token1, namedFactory });
  }
  return rows;
}

const retiredRegistries = [];
for (const [release, record] of retiredRecords) {
  retiredRegistries.push([release, record.addresses.factory, await registryOf(record.addresses.factory)]);
}
const REGISTRY_DERIVED = retiredRegistries.flatMap(([release, , rows]) => rows.flatMap(row =>
  [[release + " registry pool", row.pool], [release + " registry token0", row.token0], [release + " registry token1", row.token1]]));
const OUT_OF_SCOPE = [...RETIRED, ...REGISTRY_DERIVED];

let walletChainId = BASE_SEPOLIA;
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
      if (method === "eth_chainId") return reply({ result: walletChainId });
      // Nothing that could move value is served here at all.
      if (/^(eth_sendTransaction|eth_sendRawTransaction|eth_sign|personal_sign|eth_signTypedData)/.test(method)) {
        return reply({ error: { message: `refused by the harness: ${method}`, code: -32601 } });
      }
      return reply({ result: await provider.send(method, params) });
    } catch (error) {
      reply({ error: { message: error.shortMessage ?? error.message ?? String(error), code: -32603 } });
    }
  });
});
await new Promise(done => helper.listen(0, "127.0.0.1", done));
const helperUrl = `http://127.0.0.1:${helper.address().port}/`;

const injectWallets = (url, extraWallet) => `(() => {
  const make = info => {
    const listeners = {};
    const provider = {
      isMetaMask: info.rdns === "io.metamask",
      on: (event, handler) => { (listeners[event] ??= []).push(handler); },
      removeListener: (event, handler) => { listeners[event] = (listeners[event] ?? []).filter(h => h !== handler); },
      request: async ({ method, params }) => {
        const response = await fetch(${JSON.stringify(url)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
        const body = await response.json();
        if (body.error) throw Object.assign(new Error(body.error.message), body.error.code === undefined ? {} : { code: body.error.code });
        return body.result;
      }
    };
    return Object.freeze({ info: { ...info, icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" }, provider });
  };
  const details = [make({ uuid: "00000000-0000-4000-8000-000000000918", name: "QA SIGNING TRANSPORT", rdns: "io.metamask" })];
  ${extraWallet ? `details.push(make({ uuid: "00000000-0000-4000-8000-000000000919", name: "QA FOREIGN WALLET", rdns: "com.example.qa" }));` : ""}
  const announce = () => details.forEach(detail => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail })));
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
const report = { servedRelease, scope: "built configured app on public Base Sepolia; no address from any retired factory's registry may appear, and the verified factory's own registry must stay inside the verified pair", cases: []  };
try {
  browser = await chromium.launch({ executablePath: resolve(chromePath), headless: true });
  report.browser = browser.version();
  const origin = server.resolvedUrls.local[0];

  const open = async ({ extraWallet = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "reduce" });
    await context.addInitScript(injectWallets(helperUrl, extraWallet));
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByLabel("公開RPC A", { exact: true }).fill(RPC_A);
    await page.getByLabel("公開RPC B（別ホスト）", { exact: true }).fill(RPC_B);
    await page.getByRole("button", { name: "配置記録とトークンを照合" }).click();
    await verifiedOrRetry(page);
    return { context, page };
  };

  // A. The surface never mentions the out-of-scope assets, and offers no
  //    bridge, liquidity, pool-creation or multi-hop control.
  {
    const { context, page } = await open();
    await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: "QA SIGNING TRANSPORT（自己申告）" });
    await page.getByRole("button", { name: "選択したウォレットに接続" }).click();
    await page.locator(".v01-address", { hasText: ACCOUNT }).waitFor({ timeout: 40_000 });

    const body = ((await page.locator("body").innerText()) ?? "");
    const html = await page.content();
    const leaked = [
      ["ONYX symbol", /ONYX/i.test(body)],
      ...OUT_OF_SCOPE.map(([name, address]) => [`${name} ${address}`, html.toLowerCase().includes(address.toLowerCase())])
    ].filter(([, present]) => present).map(([name]) => name);

    const controls = await page.evaluate(() => [...document.querySelectorAll("main button, main a")].map(el => (el.textContent ?? "").trim()));
    const forbidden = controls.filter(text => /ブリッジ|流動性|プール作成|マルチホップ|bridge|liquidity/i.test(text));
    const directions = await page.evaluate(() => [...document.querySelectorAll("main select option")].map(option => option.textContent?.trim()));
    const inScopeShown = [AMBR, JADE, POOL].every(address => html.toLowerCase().includes(address.toLowerCase()));

    const derivedSet = new Set(REGISTRY_DERIVED.map(([, address]) => getAddress(address)));
    report.cases.push({
      case: "configured surface",
      retiredAddressesChecked: RETIRED.length,
      registryDerivedAddressesChecked: REGISTRY_DERIVED.length,
      retiredRegistries: retiredRegistries.map(([release, factory, rows]) => ({ release, factory, pools: rows.length })),
      knownOutOfScopeFoundInRegistries: [ONYX, ONYX_POOL].every(address => derivedSet.has(getAddress(address))),
      leakedOutOfScope: leaked,
      forbiddenControls: forbidden,
      directions,
      inScopeAddressesShown: inScopeShown
    });
    await page.screenshot({ path: resolve(output, "configured-surface.png"), fullPage: true, animations: "disabled" });
    assert.ok(RETIRED.length > 0, "no archived deployment was loaded, so 'no retired address leaked' is vacuous");
    // A derivation that returned nothing would make every absence below vacuous,
    // so it has to contain the two out-of-scope addresses we already know exist.
    assert.ok(REGISTRY_DERIVED.length > 0, "no retired registry was walked, so 'no out-of-scope pool leaked' is vacuous");
    for (const address of [ONYX, ONYX_POOL]) {
      assert.ok(derivedSet.has(getAddress(address)), `the registry walk missed a known out-of-scope address (${address}), so it cannot be trusted to find the rest`);
    }
    assert.deepEqual(leaked, [], `out-of-scope assets appeared: ${leaked.join(", ")}`);
    assert.deepEqual(forbidden, [], `out-of-scope controls appeared: ${forbidden.join(", ")}`);
    // The negative only means something if the in-scope targets are on screen.
    assert.equal(inScopeShown, true, "the in-scope targets were not shown, so the absence proves nothing");
    await context.close();
  }

  // B. A wallet that is not the supported one may be seen, never connected.
  {
    const { context, page } = await open({ extraWallet: true });
    const options = await page.evaluate(() => [...document.querySelectorAll('label select')].flatMap(select => [...select.options].map(option => option.textContent?.trim())));
    const foreign = options.find(text => text?.includes("QA FOREIGN WALLET"));
    let connectEnabled = null;
    if (foreign) {
      await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: foreign });
      connectEnabled = await page.getByRole("button", { name: "選択したウォレットに接続" }).isEnabled();
    }
    report.cases.push({ case: "unsupported wallet offered", listedOptions: options, foreignListed: Boolean(foreign), connectEnabledForForeign: connectEnabled });
    await page.screenshot({ path: resolve(output, "foreign-wallet.png"), fullPage: true, animations: "disabled" });
    assert.ok(foreign, "the unsupported wallet was never offered, so nothing was tested about refusing it");
    assert.equal(connectEnabled, false, "an unsupported wallet could be connected");
    await context.close();
  }

  // C. The supported wallet on the wrong chain must not become usable.
  {
    walletChainId = "0x1"; // Ethereum mainnet
    const { context, page } = await open();
    await page.locator('label:has-text("MetaMask候補") select').selectOption({ label: "QA SIGNING TRANSPORT（自己申告）" });
    await page.getByRole("button", { name: "選択したウォレットに接続" }).click();
    let text = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const alert = await page.getByRole("alert").first().textContent().catch(() => null);
      const notice = await page.locator(".v01-notice").first().textContent().catch(() => null);
      text = [alert, notice].filter(Boolean).map(value => value.replace(/\s+/g, " ").trim()).join(" | ");
      if (text && !/^処理中です/.test(text)) break;
      await page.waitForTimeout(1000);
    }
    const connected = await page.locator(".v01-address", { hasText: ACCOUNT }).count();
    const quoteEnabled = await page.getByRole("button", { name: "見積りを取得" }).isEnabled().catch(() => null);
    report.cases.push({ case: "supported wallet on the wrong chain", walletChainId, message: text, showedConnectedAccount: connected > 0, quoteEnabled });
    await page.screenshot({ path: resolve(output, "wrong-chain-wallet.png"), fullPage: true, animations: "disabled" });
    assert.equal(connected, 0, "the app treated a wallet on another chain as connected");
    assert.equal(quoteEnabled, false, "a wallet on another chain could still ask for a quote");
    walletChainId = BASE_SEPOLIA;
    await context.close();
  }

  // D. What "in scope" means once fee tiers exist. v0.1 could define it as one
  //    pool address; a screen that lists tiers reads the verified factory's
  //    registry instead, so the property that has to hold is about the registry:
  //    every pool in it names that factory and trades only the verified pair.
  //    Absence of specific addresses stops being the useful check here — this one
  //    keeps meaning something when a second tier is added.
  {
    const pair = new Set([getAddress(AMBR), getAddress(JADE)]);
    const rows = await registryOf(FACTORY);
    const foreign = rows.filter(row => getAddress(row.namedFactory) !== getAddress(FACTORY)).map(row => row.pool);
    const offPair = rows.filter(row => !pair.has(getAddress(row.token0)) || !pair.has(getAddress(row.token1))).map(row => row.pool);
    report.cases.push({
      case: "the verified factory's registry",
      factory: FACTORY,
      pools: rows.map(row => ({ pool: row.pool, token0: row.token0, token1: row.token1 })),
      verifiedPoolListed: rows.some(row => getAddress(row.pool) === getAddress(POOL)),
      poolsNamingAnotherFactory: foreign,
      poolsOutsideTheVerifiedPair: offPair
    });
    assert.ok(rows.length > 0, "the verified factory's registry was empty, so nothing was checked about it");
    assert.ok(rows.some(row => getAddress(row.pool) === getAddress(POOL)), "the verified pool is not in its own factory's registry");
    assert.deepEqual(foreign, [], `a pool in the verified registry names another factory: ${foreign.join(", ")}`);
    // Anyone may create a pool on a permissionless factory. This detects it; it
    // does not prevent it. Preventing it would mean giving the factory an owner.
    assert.deepEqual(offPair, [], `the verified factory now lists a pool outside the verified pair: ${offPair.join(", ")}`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await finishReport(output, report);
  await browser?.close();
  helper.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(error => error ? reject(error) : resolveClose()));
}
