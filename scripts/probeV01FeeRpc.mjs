import { Interface, toBeHex } from "ethers";

// Read-only feature probe. Fixed public endpoints, no wallet or credentials.
const oracle = "0x420000000000000000000000000000000000000F";
const abi = new Interface(["function getL1FeeUpperBound(uint256) view returns (uint256)", "function getOperatorFee(uint256) view returns (uint256)"]);
const fixture = "0x1111111111111111111111111111111111111111";
const code = "0x600054600114600e5760006000fd5b00"; // Require SLOAD(0) == 1; otherwise revert.
const results = await Promise.all(["https://sepolia.base.org/", "https://base-sepolia-rpc.publicnode.com/"].map(async endpoint => {
  let id = 0;
  const rpc = async (method, params) => {
    if (!["eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas"].includes(method)) throw new Error("READ_ONLY");
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const body = await response.json(); if (body.error) throw new Error(`RPC_${body.error.code}`); return body.result;
  };
  const attempt = async action => { try { return { ok: true, value: await action() }; } catch (error) { return { ok: false, error: /^RPC_|^HTTP_/.test(error.message) ? error.message : "UNAVAILABLE" }; } };
  const chain = await attempt(() => rpc("eth_chainId", []));
  if (!chain.ok || chain.value !== "0x14a34") return { endpoint, chain };
  const block = await attempt(() => rpc("eth_blockNumber", []));
  const fees = {};
  for (const [method, input] of [["getL1FeeUpperBound", 200], ["getOperatorFee", 120000]]) {
    fees[method] = await attempt(async () => abi.decodeFunctionResult(method, await rpc("eth_call", [{ to: oracle, data: abi.encodeFunctionData(method, [input]) }, "latest"]))[0].toString());
  }
  const override = await attempt(() => rpc("eth_estimateGas", [{ from: fixture, to: fixture, value: "0x0" }, "latest", { [fixture]: { code, stateDiff: { [toBeHex(0, 32)]: toBeHex(1, 32) } } }]));
  const control = await attempt(() => rpc("eth_estimateGas", [{ from: fixture, to: fixture, value: "0x0" }, "latest", { [fixture]: { code, stateDiff: { [toBeHex(0, 32)]: toBeHex(0, 32) } } }]));
  return { endpoint, chain, block, fees, override, control, stateDiffDistinguished: override.ok && !control.ok && control.error === "RPC_3" };
}));
process.stdout.write(`${JSON.stringify({ observedAt: new Date().toISOString(), scope: "read-only system-fee and ephemeral stateDiff capability probe; no deployment or swap evidence", results }, null, 2)}\n`);
