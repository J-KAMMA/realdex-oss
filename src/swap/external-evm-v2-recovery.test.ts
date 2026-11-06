import { Interface, keccak256 } from "ethers";
import { describe, expect, it, vi } from "vitest";
import {
  quoteExternalEvmV2ExactIn, verifyExternalEvmV2Venue,
  type ExternalEvmV2ReadClient, type ExternalEvmV2VenueIdentity
} from "./external-evm-v2";
import {
  createExternalEvmV2RecoveryReader, createExternalEvmV2RecoveryReaderQuorum,
  readExternalEvmV2RecoveryJournal, recordExternalEvmV2Submission, refreshExternalEvmV2Recovery,
  writeExternalEvmV2RecoveryRecord, type ExternalEvmV2ObservedReceipt, type ExternalEvmV2ObservedTransaction,
  type ExternalEvmV2RecoveryReader, type ExternalEvmV2SubmittedTransaction
} from "./external-evm-v2-recovery";

const tokenA = "0x1111111111111111111111111111111111111111";
const tokenB = "0x2222222222222222222222222222222222222222";
const tokenC = "0x3333333333333333333333333333333333333333";
const router = "0x4444444444444444444444444444444444444444";
const factory = "0x5555555555555555555555555555555555555555";
const pairAB = "0x6666666666666666666666666666666666666666";
const pairBC = "0x7777777777777777777777777777777777777777";
const account = "0x8888888888888888888888888888888888888888";
const routerCode = "0x6000", factoryCode = "0x6001", pairCode = "0x6002";
const approvalHash = `0x${"a".repeat(64)}`, swapHash = `0x${"b".repeat(64)}`, blockHash = `0x${"c".repeat(64)}`;
const approvalInterface = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);
const now = 1_800_000_000_000;

describe("external EVM V2 recovery boundary", () => {
  it("binds a submitted swap to the exact verified venue, quote, account, and wallet envelope", async () => {
    const fixture = await makeFixture(), record = recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.swap], now });
    expect(record).toMatchObject({ schema: "realdex.external-evm-v2-recovery.v1", revision: 1, stage: "swap-submitted", resendBlocked: true, account, venue: { chainId: "84532", router: { address: router } }, quote: { amountIn: "10000" } });
    expect(record.transactions[0]).toMatchObject({ operation: "swap", to: router, data: fixture.quote.calldata, state: "submitted" });
    expect(record).not.toHaveProperty("signedTransaction");
  });

  it("requires exact approval and permits appending the swap only after approval confirmation", async () => {
    const fixture = await makeFixture();
    const approvalRecord = recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.approval], now });
    expect(approvalRecord.stage).toBe("approval-submitted");
    await expect(async () => recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.approval, fixture.swap], previous: approvalRecord, now: now + 1 })).rejects.toThrow("EXTERNAL_V2_RECOVERY_APPROVAL_NOT_CONFIRMED");
    const confirmed = await refreshExternalEvmV2Recovery(approvalRecord, [reader("a.example.org", 101, fixture.approval, 8, true), reader("b.example.org", 102, fixture.approval, 8, true)], now + 1);
    expect(confirmed.stage).toBe("approval-confirmed");
    const appended = recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.approval, fixture.swap], previous: confirmed, now: now + 2 });
    expect(appended).toMatchObject({ revision: 3, stage: "swap-submitted", transactions: [{ state: "confirmed" }, { state: "submitted" }] });
  });

  it("rejects unlimited approval, calldata, account, chain, value, target, and nonce-order substitutions", async () => {
    const fixture = await makeFixture();
    const unlimited = { ...fixture.approval, data: approvalInterface.encodeFunctionData("approve", [router, (1n << 256n) - 1n]) };
    const cases = [
      unlimited, { ...fixture.swap, data: `${fixture.swap.data.slice(0, -2)}00` }, { ...fixture.swap, from: tokenA },
      { ...fixture.swap, chainId: "1" }, { ...fixture.swap, valueBaseUnits: "1" }, { ...fixture.swap, to: factory }
    ];
    for (const transaction of cases) expect(() => recordExternalEvmV2Submission({ ...fixture, account, transactions: [transaction], now })).toThrow();
    expect(() => recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.approval, { ...fixture.swap, nonce: fixture.approval.nonce }], now })).toThrow("EXTERNAL_V2_RECOVERY_TRANSACTION_SET_INVALID");
    expect(() => recordExternalEvmV2Submission({ ...fixture, quote: { ...fixture.quote, minimumOut: fixture.quote.minimumOut - 1n }, account, transactions: [fixture.swap], now })).toThrow();
  });

  it("advances included to two-reader confirmed and rejects receipt disappearance", async () => {
    const fixture = await makeFixture(), record = recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.swap], now });
    const included = await refreshExternalEvmV2Recovery(record, [reader("a.example.org", 100, fixture.swap, 8, true), reader("b.example.org", 100, fixture.swap, 8, true)], now + 1);
    expect(included).toMatchObject({ stage: "swap-included", transactions: [{ confirmations: 1 }] });
    const confirmed = await refreshExternalEvmV2Recovery(included, [reader("a.example.org", 101, fixture.swap, 8, true), reader("b.example.org", 102, fixture.swap, 8, true)], now + 2);
    expect(confirmed).toMatchObject({ stage: "swap-confirmed", transactions: [{ confirmations: 2 }] });
    await expect(refreshExternalEvmV2Recovery(confirmed, [reader("a.example.org", 103, fixture.swap, 8, false), reader("b.example.org", 104, fixture.swap, 8, false)], now + 3)).rejects.toThrow("EXTERNAL_V2_RECOVERY_STATE_REGRESSION");
  });

  it("keeps consumed nonce with missing hash replacement-unresolved, but accepts later exact original evidence", async () => {
    const fixture = await makeFixture(), record = recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.swap], now });
    const unresolved = await refreshExternalEvmV2Recovery(record, [reader("a.example.org", 105, null, 9, false), reader("b.example.org", 106, null, 9, false)], now + 1);
    expect(unresolved).toMatchObject({ stage: "swap-replacement-unresolved", resendBlocked: true });
    const found = await refreshExternalEvmV2Recovery(unresolved, [reader("a.example.org", 107, fixture.swap, 9, true), reader("b.example.org", 108, fixture.swap, 9, true)], now + 2);
    expect(found.stage).toBe("swap-confirmed");
  });

  it("rejects split RPC evidence, wrong chains, head divergence, head regression, and one reader", async () => {
    const fixture = await makeFixture(), record = recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.swap], now });
    await expect(refreshExternalEvmV2Recovery(record, [reader("a.example.org", 100, fixture.swap, 8, true), reader("b.example.org", 100, null, 8, false)], now + 1)).rejects.toThrow("EXTERNAL_V2_RECOVERY_QUORUM_MISMATCH");
    await expect(refreshExternalEvmV2Recovery(record, [reader("a.example.org", 100, null, 8, false, 1n), reader("b.example.org", 100, null, 8, false)], now + 1)).rejects.toThrow("EXTERNAL_V2_RECOVERY_CHAIN_MISMATCH");
    await expect(refreshExternalEvmV2Recovery(record, [reader("a.example.org", 100, null, 8, false), reader("b.example.org", 113, null, 8, false)], now + 1)).rejects.toThrow("EXTERNAL_V2_RECOVERY_HEAD_DIVERGENCE");
    const observed = await refreshExternalEvmV2Recovery(record, [reader("a.example.org", 100, null, 8, false), reader("b.example.org", 101, null, 8, false)], now + 1);
    await expect(refreshExternalEvmV2Recovery(observed, [reader("a.example.org", 99, null, 8, false), reader("b.example.org", 102, null, 8, false)], now + 2)).rejects.toThrow("EXTERNAL_V2_RECOVERY_HEAD_REGRESSION");
    await expect(refreshExternalEvmV2Recovery(record, [reader("a.example.org", 100, null, 8, false)], now + 1)).rejects.toThrow("EXTERNAL_V2_RECOVERY_READER_QUORUM_REQUIRED");
  });

  it("persists a strict revisioned journal and refuses stale or tampered overwrite", async () => {
    const fixture = await makeFixture(), record = recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.swap], now }), storage = memoryStorage();
    writeExternalEvmV2RecoveryRecord(record, storage);
    expect(readExternalEvmV2RecoveryJournal(storage)).toEqual([record]);
    expect(() => writeExternalEvmV2RecoveryRecord(record, storage)).toThrow("EXTERNAL_V2_RECOVERY_REVISION_NOT_ADVANCED");
    const parsed = JSON.parse(storage.value!); parsed.records[0].quote.minimumOut = "1"; storage.value = JSON.stringify(parsed);
    expect(() => readExternalEvmV2RecoveryJournal(storage)).toThrow();
    expect(() => writeExternalEvmV2RecoveryRecord(record, storage)).toThrow();
  });

  it("uses two public HTTPS RPC hosts and only bounded credential-free read methods", async () => {
    const fixture = await makeFixture();
    const fetchMock = vi.fn(async (_endpoint: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result = body.method === "eth_chainId" ? "0x14a34" : body.method === "eth_blockNumber" ? "0x65" : body.method === "eth_getTransactionCount" ? "0x9" : body.method === "eth_getTransactionByHash" ? rpcTransaction(fixture.swap) : body.method === "eth_getTransactionReceipt" ? rpcReceipt(fixture.swap) : undefined;
      return json({ jsonrpc: "2.0", id: body.id, result });
    });
    const readers = createExternalEvmV2RecoveryReaderQuorum(["https://a.example.org", "https://b.example.org"], fetchMock as typeof fetch);
    const refreshed = await refreshExternalEvmV2Recovery(recordExternalEvmV2Submission({ ...fixture, account, transactions: [fixture.swap], now }), readers, now + 1);
    expect(refreshed.stage).toBe("swap-confirmed");
    expect(new Set(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method))).toEqual(new Set(["eth_chainId", "eth_blockNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getTransactionCount"]));
    fetchMock.mock.calls.forEach(([, init]) => expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }));
    expect(() => createExternalEvmV2RecoveryReader("http://localhost:8545")).toThrow("EXTERNAL_V2_RECOVERY_ENDPOINT_NOT_PUBLIC");
    expect(() => createExternalEvmV2RecoveryReaderQuorum(["https://same.example.org/a", "https://same.example.org/b"])).toThrow("EXTERNAL_V2_RECOVERY_READER_QUORUM_NOT_INDEPENDENT");
  });
});

async function makeFixture() {
  const venue = await verifyExternalEvmV2Venue(identity(), readClient());
  const quote = await quoteExternalEvmV2ExactIn(venue, 10_000n, 50, account, readClient(), now);
  const approval: ExternalEvmV2SubmittedTransaction = { operation: "approval", hash: approvalHash, from: account, to: tokenA, nonce: 7, data: approvalInterface.encodeFunctionData("approve", [router, 10_000n]), valueBaseUnits: "0", chainId: "84532", observedBeforeBlock: 99 };
  const swap: ExternalEvmV2SubmittedTransaction = { operation: "swap", hash: swapHash, from: account, to: router, nonce: 8, data: quote.calldata, valueBaseUnits: "0", chainId: "84532", observedBeforeBlock: 99 };
  return { venue, quote, approval, swap };
}
function identity(): ExternalEvmV2VenueIdentity { return { schema: "realdex.external-evm-v2-venue.v1", venueId: "official-v2-compatible-test", chainId: 84532n, router: { address: router, runtimeCodeHash: keccak256(routerCode) }, factory: { address: factory, runtimeCodeHash: keccak256(factoryCode) }, path: [tokenA, tokenB, tokenC], pairs: [{ address: pairAB, runtimeCodeHash: keccak256(pairCode), token0: tokenA, token1: tokenB }, { address: pairBC, runtimeCodeHash: keccak256(pairCode), token0: tokenB, token1: tokenC }], feeBps: 30, evidenceUrls: ["https://github.com/Uniswap/v2-periphery", "https://github.com/Uniswap/v2-core"] }; }
function readClient(): ExternalEvmV2ReadClient { return { chainId: async () => 84532n, code: async (address) => address === router ? routerCode : address === factory ? factoryCode : pairCode, routerFactory: async () => factory, factoryPair: async (_factory, a) => a === tokenA ? pairAB : pairBC, pairFactory: async () => factory, pairTokens: async (pair) => pair === pairAB ? [tokenA, tokenB] : [tokenB, tokenC], pairReserves: async (pair) => pair === pairAB ? [1_000_000n, 2_000_000n] : [2_000_000n, 1_000_000n], routerAmountsOut: async (_router, amountIn) => { const first = output(amountIn, 1_000_000n, 2_000_000n); return [amountIn, first, output(first, 2_000_000n, 1_000_000n)]; } }; }
function output(input: bigint, reserveIn: bigint, reserveOut: bigint): bigint { const withFee = input * 997n; return withFee * reserveOut / (reserveIn * 1000n + withFee); }
function observed(transaction: ExternalEvmV2SubmittedTransaction, included: boolean): ExternalEvmV2ObservedTransaction { return { hash: transaction.hash, from: transaction.from, to: transaction.to, nonce: transaction.nonce, data: transaction.data, valueBaseUnits: transaction.valueBaseUnits, chainId: transaction.chainId, blockNumber: included ? 100 : null, blockHash: included ? blockHash : null }; }
function receipt(transaction: ExternalEvmV2SubmittedTransaction): ExternalEvmV2ObservedReceipt { return { transactionHash: transaction.hash, from: transaction.from, to: transaction.to, status: 1, blockNumber: 100, blockHash }; }
function reader(id: string, head: number, transaction: ExternalEvmV2SubmittedTransaction | null, transactionCount: number, withReceipt: boolean, chainId = 84532n): ExternalEvmV2RecoveryReader { return { id, chainId: async () => chainId, blockNumber: async () => head, transaction: async () => transaction ? observed(transaction, withReceipt) : null, receipt: async () => transaction && withReceipt ? receipt(transaction) : null, transactionCount: async () => transactionCount }; }
function rpcTransaction(transaction: ExternalEvmV2SubmittedTransaction) { return { hash: transaction.hash, from: transaction.from, to: transaction.to, nonce: "0x8", input: transaction.data, value: "0x0", chainId: "0x14a34", blockNumber: "0x64", blockHash }; }
function rpcReceipt(transaction: ExternalEvmV2SubmittedTransaction) { return { transactionHash: transaction.hash, from: transaction.from, to: transaction.to, status: "0x1", blockNumber: "0x64", blockHash, contractAddress: null }; }
function memoryStorage() { return { value: null as string | null, getItem() { return this.value; }, setItem(_key: string, value: string) { this.value = value; } }; }
function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
