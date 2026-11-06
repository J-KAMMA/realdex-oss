import { readFile } from "node:fs/promises";

const debugPort = Number(process.argv[2] ?? "9222");
const appUrl = process.argv[3] ?? "http://127.0.0.1:5173";
const identities = JSON.parse(await readFile(new URL("../src/swap/local-amm-code-identities.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

let sequence = 0;
const pending = new Map();
let runtimeExceptions = 0;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") runtimeExceptions += 1;
  if (!message.id || !pending.has(message.id)) return;
  const operation = pending.get(message.id); pending.delete(message.id);
  if (message.error) operation.reject(new Error(JSON.stringify(message.error)));
  else operation.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url: appUrl });
await sleep(2_000);

const manifest = {
  schema: "realdex.evm-public-testnet-deployment.v1", releaseId: "base-sepolia-browser-qa", environment: "public-testnet",
  network: { caip2: "eip155:84532", name: "Base Sepolia" },
  source: { bundleSha256: `sha256:${"c".repeat(64)}`, solidity: identities.solidity, optimizerRuns: identities.optimizerRuns, factoryRuntimeCodeHash: identities.factoryRuntimeCodeHash, routerRuntimeCodeHash: identities.routerRuntimeCodeHash },
  deployer: "0x3333333333333333333333333333333333333333",
  contracts: {
    factory: { address: "0x1111111111111111111111111111111111111111", deploymentTxHash: `0x${"a".repeat(64)}`, blockNumber: 100, runtimeCodeHash: identities.factoryRuntimeCodeHash },
    router: { address: "0x2222222222222222222222222222222222222222", deploymentTxHash: `0x${"b".repeat(64)}`, blockNumber: 101, runtimeCodeHash: identities.routerRuntimeCodeHash }
  },
  createdAt: Date.now(), evidenceUrls: ["https://evidence-a.example.org", "https://evidence-b.example.org"]
};

await evaluate(`(async () => {
  const click = (text) => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === text)?.click();
  click("Universe"); await new Promise((resolve) => setTimeout(resolve, 120)); click("Release"); await new Promise((resolve) => setTimeout(resolve, 120));
  const input = document.querySelector("input[type=file]");
  const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify(manifest))}], "deployment.json", { type: "application/json" }));
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 350));
})()`);

const measure = () => evaluate(`(() => {
  const root = document.documentElement;
  const button = document.querySelector(".release-verify-button");
  const panel = document.querySelector(".release-rpc-check");
  return {
    viewport: [innerWidth, innerHeight], clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
    overflow: root.scrollWidth > root.clientWidth, brand: document.querySelector(".brand")?.textContent.trim(),
    releaseVisible: document.body.innerText.includes("Read-only on-chain verification"),
    rpcInputs: document.querySelectorAll(".release-rpc-grid input").length,
    buttonHeight: button?.getBoundingClientRect().height, buttonDisabled: button?.disabled,
    panelWithinViewport: panel ? panel.getBoundingClientRect().left >= 0 && panel.getBoundingClientRect().right <= root.clientWidth : false,
    noDeployAction: ![...document.querySelectorAll("button")].some((item) => item.textContent.trim() === "Deploy"),
    mainnetBlocked: document.body.innerText.includes("Mainnet") && document.body.innerText.includes("Not allowed")
  };
})()`);

const releaseMobile = await measure();
await evaluate(`(async () => { [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Routes")?.click(); await new Promise((resolve) => setTimeout(resolve, 150)); })()`);
const measureRoutes = () => evaluate(`(() => {
  const root = document.documentElement;
  const status = [...document.querySelectorAll(".bridge-status")].find((item) => item.textContent.includes("External EVM V2 safety boundary"));
  return {
    viewport: [innerWidth, innerHeight], clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
    overflow: root.scrollWidth > root.clientWidth, statusVisible: Boolean(status),
    noVenueEnabled: document.body.innerText.includes("no public venue enabled"),
    executionStillRequired: document.body.innerText.includes("execution transport are still required"),
    statusWithinViewport: status ? status.getBoundingClientRect().left >= 0 && status.getBoundingClientRect().right <= root.clientWidth : false
  };
})()`);
const routesMobile = await measureRoutes();
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(300);
const routesDesktop = await measureRoutes();
console.log(JSON.stringify({ releaseMobile, routesMobile, routesDesktop, runtimeExceptions }, null, 2));
socket.close();
