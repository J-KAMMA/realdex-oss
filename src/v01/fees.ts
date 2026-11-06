import { AbiCoder, Interface, Transaction, getAddress, getBytes, keccak256, toBeHex, toQuantity } from "ethers";

export const V01_GAS_ORACLE = "0x420000000000000000000000000000000000000F";
export const V01_GAS_ORACLE_ABI = ["function getL1FeeUpperBound(uint256) view returns (uint256)", "function getOperatorFee(uint256) view returns (uint256)"];
type Rpc = { send(method: string, params: unknown[]): Promise<unknown> };
type Role = "approval" | "swap";
export type V01FeeCall = { role: Role; from: string; to: string; data: string };
export type V01FeeStep = V01FeeCall & { nonce: number; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; l2Budget: bigint; l1Budget: bigint; operatorBudget: bigint; totalBudget: bigint };
export type V01FeePlan = { steps: V01FeeStep[]; totalBudget: bigint; expiresAt: number; observedAt: number; approvalSimulation: boolean };

const oracle = new Interface(V01_GAS_ORACLE_ABI);
const uintMax = (1n << 256n) - 1n;
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error("V01_FEE_RESPONSE_INVALID");
  const result = BigInt(value); if (result > uintMax) throw new Error("V01_FEE_RESPONSE_INVALID"); return result;
}
function positive(value: bigint): bigint { if (value <= 0n || value > uintMax) throw new Error("V01_FEE_RESPONSE_INVALID"); return value; }
function fresh(expiresAt: number, observedAt: number) { const now = Date.now(); if (!Number.isSafeInteger(expiresAt) || now < observedAt || now >= expiresAt) throw new Error("V01_FEE_EXPIRED"); }
async function read(rpc: Rpc, method: string, params: unknown[]): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([rpc.send(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("V01_FEE_UNAVAILABLE")), 8_000); })]); }
  catch { throw new Error("V01_FEE_UNAVAILABLE"); }
  finally { clearTimeout(timer); }
}
async function chain(rpc: Rpc) { if (quantity(await read(rpc, "eth_chainId", [])) !== 84532n) throw new Error("WALLET_NETWORK_CHANGED"); }
async function oracleFee(rpc: Rpc, method: string, input: bigint): Promise<bigint> {
  const result = await read(rpc, "eth_call", [{ to: V01_GAS_ORACLE, data: oracle.encodeFunctionData(method, [input]) }, "latest"]);
  if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/i.test(result)) throw new Error("V01_FEE_RESPONSE_INVALID");
  return BigInt(result);
}

/** ONLY the verified bundled MockERC20: allowance is nested mapping at slot 4.
 * This is eth_estimateGas stateDiff, never a state write or signing request. */
export function v01AllowanceOverride(token: string, owner: string, spender: string, amount: bigint) {
  const abi = AbiCoder.defaultAbiCoder();
  const ownerSlot = keccak256(abi.encode(["address", "uint256"], [getAddress(owner), 4n]));
  const slot = keccak256(abi.encode(["address", "bytes32"], [getAddress(spender), ownerSlot]));
  return { [getAddress(token)]: { stateDiff: { [slot]: toBeHex(positive(amount), 32) } } };
}

export function v01FeeTransaction(step: V01FeeStep) {
  return { from: step.from, to: step.to, data: step.data, value: "0x0", chainId: "0x14a34", type: "0x2", nonce: toQuantity(step.nonce), gas: toQuantity(step.gasLimit), maxFeePerGas: toQuantity(step.maxFeePerGas), maxPriorityFeePerGas: toQuantity(step.maxPriorityFeePerGas) };
}
function unsignedSize(step: V01FeeStep): bigint {
  // Oracle adds signature-size padding itself. Do not add it a second time.
  return BigInt(getBytes(Transaction.from({ type: 2, chainId: 84532, nonce: step.nonce, to: step.to, data: step.data, value: 0n, gasLimit: step.gasLimit, maxFeePerGas: step.maxFeePerGas, maxPriorityFeePerGas: step.maxPriorityFeePerGas, accessList: [] }).unsignedSerialized).length);
}
async function currentPrices(rpc: Rpc) {
  const [block, tip] = await Promise.all([read(rpc, "eth_getBlockByNumber", ["latest", false]), read(rpc, "eth_maxPriorityFeePerGas", [])]);
  if (!block || typeof block !== "object") throw new Error("V01_FEE_RESPONSE_INVALID");
  return { base: positive(quantity((block as { baseFeePerGas?: unknown }).baseFeePerGas)), tip: quantity(tip) };
}
async function nonce(rpc: Rpc, owner: string) {
  const [latest, pending] = await Promise.all([read(rpc, "eth_getTransactionCount", [owner, "latest"]), read(rpc, "eth_getTransactionCount", [owner, "pending"])]);
  const next = quantity(pending);
  if (quantity(latest) !== next || next >= BigInt(Number.MAX_SAFE_INTEGER - 1)) throw new Error("V01_FEE_NONCE_CHANGED");
  return Number(next);
}

/** Current-node fee budget, not a guaranteed final cost. Runtime must bind calls to its genuine profile/quote. */
export async function estimateV01FeePlan(rpc: Rpc, calls: V01FeeCall[], expiresAt: number, approval?: { token: string; spender: string; amount: bigint }): Promise<V01FeePlan> {
  const observedAt = Date.now(); fresh(expiresAt, observedAt);
  if (!(calls.length === 1 && calls[0].role === "swap" && !approval || calls.length === 2 && calls[0].role === "approval" && calls[1].role === "swap" && approval)) throw new Error("V01_FEE_CALLS_INVALID");
  // Snapshot before IO, so mutable caller data cannot change the preview halfway through.
  const captured = calls.map(call => ({ role: call.role, from: getAddress(call.from), to: getAddress(call.to), data: call.data }));
  if (captured.some(call => call.from !== captured[0].from || !/^0x(?:[0-9a-f]{2})+$/i.test(call.data))) throw new Error("V01_FEE_CALLS_INVALID");
  const override = approval && v01AllowanceOverride(approval.token, captured[0].from, approval.spender, approval.amount);
  await chain(rpc);
  const [prices, firstNonce] = await Promise.all([currentPrices(rpc), nonce(rpc, captured[0].from)]);
  const maxFeePerGas = positive(2n * prices.base + prices.tip);
  const steps: V01FeeStep[] = [];
  for (const [index, call] of captured.entries()) {
    const step: V01FeeStep = { ...call, nonce: firstNonce + index, gasLimit: 0n, maxFeePerGas, maxPriorityFeePerGas: prices.tip, l2Budget: 0n, l1Budget: 0n, operatorBudget: 0n, totalBudget: 0n };
    const tx = { from: call.from, to: call.to, data: call.data, value: "0x0" };
    const params: unknown[] = [tx, "latest"];
    if (override && call.role === "swap") params.push(override);
    const gas = positive(quantity(await read(rpc, "eth_estimateGas", params)));
    step.gasLimit = (gas * 120n + 99n) / 100n;
    if (step.gasLimit >= 1n << 64n) throw new Error("V01_FEE_RESPONSE_INVALID");
    step.l2Budget = positive(step.gasLimit * maxFeePerGas);
    const [l1, operator] = await Promise.all([oracleFee(rpc, "getL1FeeUpperBound", unsignedSize(step)), oracleFee(rpc, "getOperatorFee", step.gasLimit)]);
    step.l1Budget = l1 * 2n; step.operatorBudget = operator * 2n;
    step.totalBudget = positive(step.l2Budget + step.l1Budget + step.operatorBudget);
    steps.push(Object.freeze(step));
  }
  const totalBudget = positive(steps.reduce((sum, step) => sum + step.totalBudget, 0n));
  const balance = quantity(await read(rpc, "eth_getBalance", [captured[0].from, "pending"]));
  if (balance < totalBudget) throw new Error("V01_GAS_BALANCE_INSUFFICIENT");
  if (await nonce(rpc, captured[0].from) !== firstNonce) throw new Error("V01_FEE_NONCE_CHANGED");
  await chain(rpc); fresh(expiresAt, observedAt);
  return Object.freeze({ steps: Object.freeze(steps) as unknown as V01FeeStep[], totalBudget, observedAt, expiresAt, approvalSimulation: !!override });
}

/** Recheck the exact reviewed budget with NO state override immediately before each send. */
export async function checkV01FeeStep(rpc: Rpc, plan: V01FeePlan, role: Role): Promise<V01FeeStep> {
  fresh(plan.expiresAt, plan.observedAt); await chain(rpc);
  const step = plan.steps.find(item => item.role === role); if (!step) throw new Error("V01_FEE_CALLS_INVALID");
  if (await nonce(rpc, step.from) !== step.nonce) throw new Error("V01_FEE_NONCE_CHANGED");
  const tx = v01FeeTransaction(step);
  const [gas, prices, l1, operator, balance] = await Promise.all([
    read(rpc, "eth_estimateGas", [tx, "latest"]), currentPrices(rpc), oracleFee(rpc, "getL1FeeUpperBound", unsignedSize(step)), oracleFee(rpc, "getOperatorFee", step.gasLimit), read(rpc, "eth_getBalance", [step.from, "pending"])
  ]);
  if (positive(quantity(gas)) > step.gasLimit || prices.base + prices.tip > step.maxFeePerGas || prices.tip > step.maxPriorityFeePerGas || l1 > step.l1Budget || operator > step.operatorBudget) throw new Error("V01_FEE_REVIEW_REQUIRED");
  const remaining = plan.steps.filter(item => item.nonce >= step.nonce).reduce((sum, item) => sum + item.totalBudget, 0n);
  if (quantity(balance) < remaining) throw new Error("V01_GAS_BALANCE_INSUFFICIENT");
  if (await nonce(rpc, step.from) !== step.nonce) throw new Error("V01_FEE_NONCE_CHANGED");
  await chain(rpc); fresh(plan.expiresAt, plan.observedAt); return step;
}
