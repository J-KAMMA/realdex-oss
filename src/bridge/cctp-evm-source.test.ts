import { keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { cctpEvmSourceConfig, createCctpEvmSourceReaderQuorum, verifyCctpEvmSourceMessage, type CctpEvmSourceReader, type CctpEvmSourceReceipt } from "./cctp-evm-source";

const transactionHash = `0x${"a".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;
const rawMessage = "0x01020304";
const transmitter = "0xe737e5cebeeba77efe34d4aa090756590b1ce275";
const topic = keccak256(toUtf8Bytes("MessageSent(bytes)")).toLowerCase();

describe("CCTP EVM source receipt quorum", () => {
  it("binds Circle raw message bytes to one successful MessageSent log agreed by two hosts", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = request.method === "eth_chainId" ? "0x14a34" : request.method === "eth_blockNumber" ? "0x65" : rpcReceipt();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const readers = createCctpEvmSourceReaderQuorum(6, fetchMock as typeof fetch)!;
    const verified = await verifyCctpEvmSourceMessage({ sourceDomain: 6, transactionHash, rawMessage, readers });
    expect(verified).toMatchObject({ transactionHash, blockNumber: 100, blockHash, logIndex: 7, confirmations: 2 });
    expect(verified?.readerIds).toEqual(["sepolia.base.org", "base-sepolia-rpc.publicnode.com"]);
    expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }));
  });

  it("keeps absent or under-confirmed receipts pending and rejects disagreement, revert, or another message", async () => {
    expect(await verifyCctpEvmSourceMessage({ sourceDomain: 6, transactionHash, rawMessage, readers: readers(null, null) })).toBeNull();
    expect(await verifyCctpEvmSourceMessage({ sourceDomain: 6, transactionHash, rawMessage, readers: readers(receipt(), receipt(), 100) })).toBeNull();
    await expect(verifyCctpEvmSourceMessage({ sourceDomain: 6, transactionHash, rawMessage, readers: readers(receipt(), null) })).rejects.toThrow("CCTP_SOURCE_RECEIPT_QUORUM_MISMATCH");
    await expect(verifyCctpEvmSourceMessage({ sourceDomain: 6, transactionHash, rawMessage, readers: readers(receipt({ status: 0 }), receipt({ status: 0 })) })).rejects.toThrow("CCTP_SOURCE_TRANSACTION_REVERTED");
    await expect(verifyCctpEvmSourceMessage({ sourceDomain: 6, transactionHash, rawMessage: "0x0506", readers: readers(receipt(), receipt()) })).rejects.toThrow("CCTP_SOURCE_MESSAGE_LOG_MISSING");
  });

  it("installs only reviewed EVM source domains and pins two independent public endpoints", () => {
    expect(cctpEvmSourceConfig(6)).toMatchObject({ chainId: 84_532n, messageTransmitter: transmitter });
    expect(cctpEvmSourceConfig(3)).toMatchObject({ chainId: 421_614n, messageTransmitter: transmitter });
    expect(cctpEvmSourceConfig(5)).toBeNull();
  });
});

function rpcReceipt() {
  return {
    transactionHash, status: "0x1", blockNumber: "0x64", blockHash,
    logs: [{ address: transmitter, topics: [topic], data: abiBytes(rawMessage), transactionHash, blockNumber: "0x64", blockHash, logIndex: "0x7", removed: false }]
  };
}

function receipt(change: Partial<CctpEvmSourceReceipt> = {}): CctpEvmSourceReceipt {
  return {
    transactionHash, status: 1, blockNumber: 100, blockHash,
    logs: [{ address: transmitter, topics: [topic], data: abiBytes(rawMessage), transactionHash, blockNumber: 100, blockHash, logIndex: 7 }],
    ...change
  };
}

function readers(left: CctpEvmSourceReceipt | null, right: CctpEvmSourceReceipt | null, head = 101): CctpEvmSourceReader[] {
  return [left, right].map((value, index) => ({ id: index ? "rpc-b.example.net" : "rpc-a.example.org", chainId: async () => 84_532n, blockNumber: async () => head, receipt: async () => value }));
}

function abiBytes(value: string): string {
  const data = value.slice(2).toLowerCase(), length = data.length / 2, padded = data.padEnd(Math.ceil(length / 32) * 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${length.toString(16).padStart(64, "0")}${padded}`;
}
