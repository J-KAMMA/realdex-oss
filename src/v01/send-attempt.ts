import type { v01FeeTransaction } from "./fees";

/** Write-ahead evidence of a wallet request, NOT proof of signing or submission. */
export type V01SendAttempt = {
  intentId: string;
  quoteId: string;
  profileFingerprint: string;
  role: "approval" | "swap";
  observedBeforeBlock: number;
  transaction: ReturnType<typeof v01FeeTransaction>;
};

const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join() === keys.sort().join();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const address = (value: unknown) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const quantity = (value: unknown) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) && value.length <= 66;

export function assertV01SendAttempt(value: unknown): asserts value is V01SendAttempt {
  if (!object(value) || !exactKeys(value, ["intentId", "quoteId", "profileFingerprint", "role", "observedBeforeBlock", "transaction"]) ||
      typeof value.intentId !== "string" || !/^realdex-intent:v1:[0-9a-f-]{36}$/.test(value.intentId) ||
      typeof value.quoteId !== "string" || !value.quoteId.length || value.quoteId.length > 800 ||
      typeof value.profileFingerprint !== "string" || !/^0x[0-9a-f]{64}$/.test(value.profileFingerprint) ||
      !["approval", "swap"].includes(String(value.role)) || !Number.isSafeInteger(value.observedBeforeBlock) || Number(value.observedBeforeBlock) < 0) throw new Error("V01_SEND_ATTEMPT_INVALID");
  const tx = value.transaction;
  if (!object(tx) || !exactKeys(tx, ["from", "to", "data", "value", "chainId", "type", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas"]) ||
      !address(tx.from) || !address(tx.to) || typeof tx.data !== "string" || !/^0x[0-9a-f]+$/i.test(tx.data) ||
      tx.data.length !== (value.role === "approval" ? 138 : 330) || tx.value !== "0x0" || tx.chainId !== "0x14a34" || tx.type !== "0x2" ||
      ![tx.nonce, tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas].every(quantity)) throw new Error("V01_SEND_ATTEMPT_INVALID");
  if (BigInt(String(tx.nonce)) >= BigInt(Number.MAX_SAFE_INTEGER) || BigInt(String(tx.gas)) <= 0n || BigInt(String(tx.gas)) >= 1n << 64n ||
      BigInt(String(tx.maxFeePerGas)) <= 0n || BigInt(String(tx.maxPriorityFeePerGas)) > BigInt(String(tx.maxFeePerGas))) throw new Error("V01_SEND_ATTEMPT_INVALID");
}
