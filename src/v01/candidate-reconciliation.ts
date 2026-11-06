import { Interface, getAddress, toQuantity } from "ethers";
import { ERC20_ABI, POOL_ABI } from "../abi";
import { assertCurrentV01Profile, type VerifiedV01Profile } from "../release/v01-profile";
import { cryptographicFingerprint } from "../security/cryptographic-fingerprint";
import { assertActiveV01Operation, type ActiveV01Operation } from "./active-operation";
import type { V01SendAttempt } from "./send-attempt";
import { assertV01RecoveryIntentProfile } from "./recovery-intent";

export type V01CandidateReader = { id: string; send(method: string, params: unknown[]): Promise<unknown> };
export type V01CandidateObservation = {
  status: "candidate-matched"; intentId: string; quoteId: string; profileFingerprint: string;
  role: "approval" | "swap"; hash: string; attemptFingerprint: string;
  blockNumber: number; blockHash: string; receiptStatus: 0 | 1; confirmations: number;
  commonHead: { number: number; hash: string }; readerIds: string[]; checkedAt: number;
};

const fingerprint = (value: unknown) => cryptographicFingerprint("realdex.v01-candidate-binding.v1", value);
function fail(): never { throw new Error("V01_CANDIDATE_MISMATCH"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return fail();
  return value.toLowerCase();
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) || value.length > 66) return fail();
  return BigInt(value);
}
function blockNumber(value: unknown): number {
  const result = quantity(value); if (result > BigInt(Number.MAX_SAFE_INTEGER)) return fail(); return Number(result);
}
function address(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) return fail();
  return getAddress(value.toLowerCase());
}

function assertCall(attempt: V01SendAttempt, profile: VerifiedV01Profile) {
  const tx = attempt.transaction, pool = profile.profile.pool.address;
  const tokens = Object.values(profile.profile.tokens).map(address);
  const abi = new Interface(attempt.role === "approval" ? ERC20_ABI : POOL_ABI);
  const method = attempt.role === "approval" ? "approve" : "swapExactIn";
  const decoded = abi.decodeFunctionData(method, tx.data);
  if (abi.encodeFunctionData(method, decoded).toLowerCase() !== tx.data.toLowerCase()) fail();
  if (attempt.role === "approval") {
    if (!tokens.includes(address(tx.to)) || address(decoded[0]) !== address(pool) || decoded[1] <= 0n) fail();
  } else if (address(tx.to) !== address(pool) || !tokens.includes(address(decoded[0])) || decoded[1] <= 0n || decoded[2] <= 0n || address(decoded[3]) !== address(tx.from) || decoded[4] <= 0n) fail();
}

/** Candidate observation only. Does not write history, clear an operation, connect or sign.
 * Reader agreement is not operator independence, cryptographic inclusion proof or finality.
 * Caller must revalidate before any later explicit persistence/operation-close decision.
 */
export async function verifyV01Candidate(options: {
  operation: ActiveV01Operation; role: "approval" | "swap"; hash: string; profile: VerifiedV01Profile;
  readers: readonly V01CandidateReader[]; readOperation: () => ActiveV01Operation | null; isCurrent: () => boolean;
}): Promise<V01CandidateObservation> {
  const started = Date.now(), deadline = started + 15_000;
  assertActiveV01Operation(options.operation);
  const operation = structuredClone(options.operation), binding = fingerprint(operation);
  const profile = options.profile, candidate = hash(options.hash), role = options.role;
  const check = () => {
    if (Date.now() < started || Date.now() >= deadline) throw new Error("V01_CANDIDATE_TIMEOUT");
    assertCurrentV01Profile(profile);
    if (!options.isCurrent() || fingerprint(options.readOperation()) !== binding || fingerprint(options.operation) !== binding) throw new Error("V01_CANDIDATE_CONTEXT_CHANGED");
  };
  check();
  if (operation.schema === "realdex.v01-active-operation.v1" || operation.profileFingerprint !== profile.fingerprint) fail();
  if (operation.schema === "realdex.v01-active-operation.v3") assertV01RecoveryIntentProfile(operation.recovery, profile);
  const attempt = operation.attempts.find(item => item.role === role);
  if (!attempt) fail();
  assertCall(attempt, profile);
  const readers = options.readers.map(reader => ({ id: reader.id, send: reader.send.bind(reader) }));
  if (readers.length < 2 || readers.length > 4 || readers.some(reader => typeof reader.id !== "string" || !reader.id.length || reader.id.length > 250) ||
      new Set(readers.map(reader => reader.id)).size !== readers.length || JSON.stringify(readers.map(reader => reader.id).sort()) !== JSON.stringify([...profile.readerIds].sort())) throw new Error("V01_CANDIDATE_READERS_INVALID");
  const read = async (reader: V01CandidateReader, method: string, params: unknown[]): Promise<unknown> => {
    check(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([reader.send(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("V01_CANDIDATE_TIMEOUT")), Math.max(1, deadline - Date.now())); })]);
      check(); return structuredClone(value);
    } catch (error) {
      if (error instanceof Error && ["V01_CANDIDATE_TIMEOUT", "V01_CANDIDATE_CONTEXT_CHANGED"].includes(error.message)) throw error;
      throw new Error("V01_CANDIDATE_READ_FAILED");
    } finally { clearTimeout(timer); }
  };
  const chain = async (reader: V01CandidateReader) => { if (quantity(await read(reader, "eth_chainId", [])) !== 84532n) fail(); };
  const tx = attempt.transaction;
  const observations = await Promise.all(readers.map(async reader => {
    await chain(reader);
    const observed = object(await read(reader, "eth_getTransactionByHash", [candidate]));
    if (hash(observed.hash) !== candidate || address(observed.from) !== address(tx.from) || address(observed.to) !== address(tx.to) ||
        typeof observed.input !== "string" || observed.input.toLowerCase() !== tx.data.toLowerCase() || !Array.isArray(observed.accessList) || observed.accessList.length !== 0) fail();
    for (const field of ["value", "chainId", "type", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas"] as const) if (quantity(observed[field]) !== quantity(tx[field])) fail();
    const receipt = object(await read(reader, "eth_getTransactionReceipt", [candidate]));
    const includedAt = blockNumber(receipt.blockNumber), includedHash = hash(receipt.blockHash), status = quantity(receipt.status);
    if (hash(receipt.transactionHash) !== candidate || address(receipt.from) !== address(tx.from) || address(receipt.to) !== address(tx.to) ||
        blockNumber(observed.blockNumber) !== includedAt || hash(observed.blockHash) !== includedHash || includedAt <= attempt.observedBeforeBlock || (status !== 0n && status !== 1n)) fail();
    const canonical = async () => {
      const block = object(await read(reader, "eth_getBlockByNumber", [toQuantity(includedAt), false]));
      if (blockNumber(block.number) !== includedAt || hash(block.hash) !== includedHash || !Array.isArray(block.transactions) ||
          block.transactions.filter(item => typeof item === "string" && item.toLowerCase() === candidate).length !== 1) fail();
    };
    await canonical();
    const head = blockNumber(await read(reader, "eth_blockNumber", []));
    if (head < includedAt) fail();
    return { reader, includedAt, includedHash, receiptStatus: Number(status) as 0 | 1, head, canonical };
  }));
  const first = observations[0], head = Math.min(...observations.map(item => item.head));
  if (observations.some(item => item.includedAt !== first.includedAt || item.includedHash !== first.includedHash || item.receiptStatus !== first.receiptStatus)) fail();
  const heads = await Promise.all(observations.map(async item => {
    const block = object(await read(item.reader, "eth_getBlockByNumber", [toQuantity(head), false]));
    if (blockNumber(block.number) !== head) fail();
    const result = hash(block.hash);
    if (head === item.includedAt && result !== item.includedHash) fail();
    await item.canonical(); await chain(item.reader); return result;
  }));
  if (heads.some(item => item !== heads[0])) fail();
  check();
  return Object.freeze({ status: "candidate-matched", intentId: operation.intentId, quoteId: operation.quoteId, profileFingerprint: operation.profileFingerprint,
    role, hash: candidate, attemptFingerprint: fingerprint(attempt), blockNumber: first.includedAt, blockHash: first.includedHash, receiptStatus: first.receiptStatus,
    confirmations: head - first.includedAt + 1, commonHead: Object.freeze({ number: head, hash: heads[0] }), readerIds: Object.freeze(readers.map(reader => reader.id)) as unknown as string[], checkedAt: Date.now() });
}
