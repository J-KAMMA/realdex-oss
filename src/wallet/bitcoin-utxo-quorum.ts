import { hexlify, sha256, toUtf8Bytes } from "ethers";
import { decodeBitcoinAddress } from "./bitcoin-address";
import { inspectBitcoinPsbtIntent, type BitcoinPsbtInputIntent, type BitcoinPsbtInspection, type BitcoinPsbtIntent } from "./bitcoin-psbt";

type FetchLike = typeof fetch;

export type BitcoinUtxoObservation = {
  readerId: string;
  genesisHash: string;
  tipHeight: number;
  inputs: Array<{
    txid: string;
    vout: number;
    valueSats: string;
    scriptPubKey: string;
    confirmed: boolean;
    blockHeight: number;
    blockHash: string;
    spent: boolean;
  }>;
};

export type BitcoinEsploraReader = {
  id: string;
  observe(chainId: string, inputs: readonly BitcoinPsbtInputIntent[]): Promise<BitcoinUtxoObservation>;
};

export type BitcoinEsploraFeeReader = BitcoinEsploraReader & {
  feeEstimate(targetBlocks: number): Promise<{ readerId: string; targetBlocks: number; feeRateMilliSatsPerVbyte: string }>;
};

export type VerifiedBitcoinPsbtUtxoQuorum = {
  schema: "realdex.bitcoin-psbt-utxo-quorum.v1";
  status: "verified-design-gate";
  executionEnabled: false;
  signingEnabled: false;
  broadcastEnabled: false;
  chainId: string;
  psbtFingerprint: string;
  intentFingerprint: string;
  inputCount: number;
  minConfirmations: number;
  weakestConfirmations: number;
  readerIds: string[];
  inputFingerprints: string[];
  verifiedAt: number;
};

export type BitcoinUtxoQuorumPolicy = { minConfirmations: number; maxTipDivergence: number };

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_MONEY = 2_100_000_000_000_000n;

export async function verifyBitcoinPsbtUtxoQuorum(
  intent: BitcoinPsbtIntent,
  inspection: BitcoinPsbtInspection,
  readers: readonly BitcoinEsploraReader[],
  policy: BitcoinUtxoQuorumPolicy = { minConfirmations: 1, maxTipDivergence: 6 },
  now = Date.now()
): Promise<VerifiedBitcoinPsbtUtxoQuorum> {
  validateBitcoinUtxoQuorumPolicy(policy);
  if (readers.length !== 2 || new Set(readers.map((reader) => reader.id)).size !== 2) throw new Error("BITCOIN_UTXO_READER_QUORUM_INVALID");
  const fresh = inspectBitcoinPsbtIntent(intent, now);
  if (fresh.psbtFingerprint !== inspection.psbtFingerprint || fresh.intentFingerprint !== inspection.intentFingerprint || fresh.unsignedTransactionFingerprint !== inspection.unsignedTransactionFingerprint) throw new Error("BITCOIN_UTXO_INSPECTION_STALE");
  const observations = await Promise.all(readers.map((reader) => reader.observe(fresh.chainId, intent.inputs)));
  const chainReference = parseChainReference(fresh.chainId);
  observations.forEach((observation, index) => validateObservation(observation, readers[index].id, intent.inputs, chainReference));
  if (Math.abs(observations[0].tipHeight - observations[1].tipHeight) > policy.maxTipDivergence) throw new Error("BITCOIN_UTXO_TIP_DIVERGENCE");

  let weakestConfirmations = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < intent.inputs.length; index += 1) {
    const left = observations[0].inputs[index];
    const right = observations[1].inputs[index];
    if (left.valueSats !== right.valueSats || left.scriptPubKey !== right.scriptPubKey || left.confirmed !== right.confirmed || left.blockHeight !== right.blockHeight || left.blockHash !== right.blockHash || left.spent !== right.spent) throw new Error("BITCOIN_UTXO_READER_DISAGREEMENT");
    if (left.spent) throw new Error("BITCOIN_UTXO_SPENT");
    if (!left.confirmed) throw new Error("BITCOIN_UTXO_UNCONFIRMED");
    const confirmations = Math.min(...observations.map((observation) => observation.tipHeight - observation.inputs[index].blockHeight + 1));
    if (!Number.isSafeInteger(confirmations) || confirmations < policy.minConfirmations) throw new Error("BITCOIN_UTXO_CONFIRMATIONS_INSUFFICIENT");
    weakestConfirmations = Math.min(weakestConfirmations, confirmations);
  }

  return {
    schema: "realdex.bitcoin-psbt-utxo-quorum.v1",
    status: "verified-design-gate",
    executionEnabled: false,
    signingEnabled: false,
    broadcastEnabled: false,
    chainId: fresh.chainId,
    psbtFingerprint: fresh.psbtFingerprint,
    intentFingerprint: fresh.intentFingerprint,
    inputCount: intent.inputs.length,
    minConfirmations: policy.minConfirmations,
    weakestConfirmations,
    readerIds: readers.map((reader) => reader.id),
    inputFingerprints: intent.inputs.map((input) => sha256(toUtf8Bytes(`${input.txid}:${input.vout}`))),
    verifiedAt: now
  };
}

export function createBitcoinEsploraReaderQuorum(endpointValues: readonly string[], fetchImpl: FetchLike = fetch, timeoutMs = 8_000): BitcoinEsploraFeeReader[] {
  const endpoints = assertDistinctPublicEsploraEndpoints(endpointValues);
  return endpoints.map((endpoint) => createBitcoinEsploraReader(endpoint, fetchImpl, timeoutMs));
}

export function createBitcoinEsploraReader(endpointValue: string, fetchImpl: FetchLike = fetch, timeoutMs = 8_000): BitcoinEsploraFeeReader {
  const endpoint = normalizePublicEsploraEndpoint(endpointValue);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("BITCOIN_ESPLORA_TIMEOUT_INVALID");
  const id = new URL(endpoint).hostname.toLowerCase();
  const request = async (path: string): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, endpoint), {
        method: "GET", headers: { accept: "application/json, text/plain" }, credentials: "omit",
        referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal
      });
      if (!response.ok) throw new Error("BITCOIN_ESPLORA_HTTP_FAILED");
      return await readBoundedResponse(response);
    } catch (reason) {
      if ((reason instanceof DOMException && reason.name === "AbortError") || (reason instanceof Error && reason.name === "AbortError")) throw new Error("BITCOIN_ESPLORA_TIMEOUT");
      throw reason;
    } finally { clearTimeout(timeout); }
  };
  return {
    id,
    feeEstimate: async (targetBlocks) => {
      assertFeeTarget(targetBlocks);
      return { readerId: id, targetBlocks, feeRateMilliSatsPerVbyte: parseFeeEstimate(await request("fee-estimates"), targetBlocks) };
    },
    observe: async (_chainId, inputs) => {
      const genesisHash = parseHash((await request("block-height/0")).trim(), "BITCOIN_ESPLORA_GENESIS_INVALID");
      const tipHeight = parseHeight((await request("blocks/tip/height")).trim(), "BITCOIN_ESPLORA_TIP_INVALID");
      const observedInputs = await Promise.all(inputs.map(async (input) => {
        const transaction = parseTransaction(await request(`tx/${input.txid}`), input.txid, input.vout);
        const outspend = parseOutspend(await request(`tx/${input.txid}/outspend/${input.vout}`));
        return { txid: input.txid, vout: input.vout, ...transaction, spent: outspend };
      }));
      return { readerId: id, genesisHash, tipHeight, inputs: observedInputs };
    }
  };
}

function parseFeeEstimate(text: string, targetBlocks: number): string {
  assertFeeTarget(targetBlocks);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("BITCOIN_ESPLORA_FEE_ESTIMATE_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BITCOIN_ESPLORA_FEE_ESTIMATE_INVALID");
  const estimate = (value as Record<string, unknown>)[String(targetBlocks)];
  if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0.1 || estimate > 100_000) throw new Error("BITCOIN_ESPLORA_FEE_ESTIMATE_INVALID");
  const milli = Math.round(estimate * 1_000);
  if (!Number.isSafeInteger(milli) || Math.abs(estimate * 1_000 - milli) > 1e-6) throw new Error("BITCOIN_ESPLORA_FEE_ESTIMATE_INVALID");
  return String(milli);
}

function assertFeeTarget(targetBlocks: number): void {
  if (![...Array.from({ length: 25 }, (_, index) => index + 1), 144, 504, 1008].includes(targetBlocks)) throw new Error("BITCOIN_FEE_TARGET_INVALID");
}

export function normalizePublicEsploraEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("BITCOIN_ESPLORA_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("BITCOIN_ESPLORA_URL_NOT_PUBLIC");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isPrivateIpv4(hostname) || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) throw new Error("BITCOIN_ESPLORA_URL_NOT_PUBLIC");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

export function assertDistinctPublicEsploraEndpoints(values: readonly string[]): string[] {
  if (values.length !== 2) throw new Error("BITCOIN_ESPLORA_QUORUM_INVALID");
  const endpoints = values.map(normalizePublicEsploraEndpoint);
  const hosts = endpoints.map((endpoint) => new URL(endpoint).hostname.toLowerCase());
  if (new Set(endpoints).size !== 2 || new Set(hosts).size !== 2) throw new Error("BITCOIN_ESPLORA_ENDPOINTS_NOT_INDEPENDENT");
  return endpoints;
}

function validateObservation(observation: BitcoinUtxoObservation, readerId: string, inputs: readonly BitcoinPsbtInputIntent[], chainReference: string): void {
  if (observation.readerId !== readerId || !parseHash(observation.genesisHash, "BITCOIN_UTXO_CHAIN_MISMATCH").startsWith(chainReference) || !Number.isSafeInteger(observation.tipHeight) || observation.tipHeight < 0 || observation.inputs.length !== inputs.length) throw new Error("BITCOIN_UTXO_CHAIN_MISMATCH");
  observation.inputs.forEach((actual, index) => {
    const expected = inputs[index];
    const address = decodeBitcoinAddress(`bip122:${chainReference}`, expected.address);
    const expectedScript = address ? hexlify(address.scriptPubKey).slice(2) : "";
    if (actual.txid !== expected.txid || actual.vout !== expected.vout) throw new Error("BITCOIN_UTXO_OUTPOINT_MISMATCH");
    if (actual.valueSats !== expected.amountSats || actual.scriptPubKey !== expectedScript) throw new Error("BITCOIN_UTXO_WITNESS_MISMATCH");
    if (typeof actual.confirmed !== "boolean" || typeof actual.spent !== "boolean" || !Number.isSafeInteger(actual.blockHeight) || actual.blockHeight < 0 || actual.blockHeight > observation.tipHeight || !/^[0-9a-f]{64}$/.test(actual.blockHash)) throw new Error("BITCOIN_UTXO_OBSERVATION_INVALID");
  });
}

function parseTransaction(text: string, expectedTxid: string, vout: number): Omit<BitcoinUtxoObservation["inputs"][number], "txid" | "vout" | "spent"> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("BITCOIN_ESPLORA_TRANSACTION_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BITCOIN_ESPLORA_TRANSACTION_INVALID");
  const transaction = value as Record<string, unknown>;
  if (transaction.txid !== expectedTxid || !Array.isArray(transaction.vout) || vout >= transaction.vout.length || !transaction.status || typeof transaction.status !== "object") throw new Error("BITCOIN_ESPLORA_TRANSACTION_INVALID");
  const output = transaction.vout[vout] as Record<string, unknown> | undefined;
  const status = transaction.status as Record<string, unknown>;
  if (!output || !Number.isSafeInteger(output.value) || Number(output.value) < 0 || BigInt(Number(output.value)) > MAX_MONEY || typeof output.scriptpubkey !== "string" || !/^(?:[0-9a-f]{2})+$/.test(output.scriptpubkey) || status.confirmed !== true || !Number.isSafeInteger(status.block_height) || Number(status.block_height) < 0 || typeof status.block_hash !== "string") throw new Error("BITCOIN_ESPLORA_TRANSACTION_INVALID");
  return { valueSats: String(output.value), scriptPubKey: output.scriptpubkey, confirmed: true, blockHeight: Number(status.block_height), blockHash: parseHash(status.block_hash, "BITCOIN_ESPLORA_TRANSACTION_INVALID") };
}

function parseOutspend(text: string): boolean {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("BITCOIN_ESPLORA_OUTSPEND_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).spent !== "boolean") throw new Error("BITCOIN_ESPLORA_OUTSPEND_INVALID");
  return (value as { spent: boolean }).spent;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("BITCOIN_ESPLORA_RESPONSE_TOO_LARGE");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("BITCOIN_ESPLORA_RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("BITCOIN_ESPLORA_RESPONSE_TOO_LARGE");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function validateBitcoinUtxoQuorumPolicy(policy: BitcoinUtxoQuorumPolicy): void {
  if (!Number.isSafeInteger(policy.minConfirmations) || policy.minConfirmations < 1 || policy.minConfirmations > 144 || !Number.isSafeInteger(policy.maxTipDivergence) || policy.maxTipDivergence < 0 || policy.maxTipDivergence > 12) throw new Error("BITCOIN_UTXO_POLICY_INVALID");
}

function parseChainReference(chainId: string): string {
  const match = /^bip122:([0-9a-f]{32})$/.exec(chainId);
  if (!match) throw new Error("BITCOIN_UTXO_CHAIN_ID_INVALID");
  return match[1];
}

function parseHash(value: string, error: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(error);
  return value;
}

function parseHeight(value: string, error: string): number {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) throw new Error(error);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(error);
  return parsed;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
