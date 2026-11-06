import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { cctpEvmDestinationConfig, createCctpEvmDestinationReaderQuorum, verifyCctpEvmDestination, type CctpEvmDestinationReader, type CctpEvmDestinationReceipt } from "./cctp-evm-destination";

const txHash = `0x${"c".repeat(64)}`;
const blockHash = `0x${"d".repeat(64)}`;
const transmitter = "0xe737e5cebeeba77efe34d4aa090756590b1ce275";
const messenger = "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa";
const arbitrumUsdc = "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d";
const recipient = "0x2222222222222222222222222222222222222222";
const nonce = `0x${"7".repeat(64)}`;
const finality = 1_000;
const rawMessage = message();
const messageTopic = keccak256(toUtf8Bytes("MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)")).toLowerCase();
const mintTopic = keccak256(toUtf8Bytes("MintAndWithdraw(address,uint256,address,uint256)")).toLowerCase();

describe("CCTP EVM destination receipt quorum", () => {
  it("requires one exact MessageReceived and net MintAndWithdraw agreed by two RPC hosts", async () => {
    const verified = await verifyCctpEvmDestination({ sourceDomain: 6, destinationDomain: 3, transactionHash: txHash, rawMessage, readers: readers(receipt(), receipt()) });
    expect(verified).toMatchObject({ transactionHash: txHash, blockNumber: 100, blockHash, messageLogIndex: 4, mintLogIndex: 5, confirmations: 2 });
    expect(verified?.readerIds).toEqual(["rpc-a.example.org", "rpc-b.example.net"]);
  });

  it("keeps missing or under-confirmed receipts pending and rejects divergent or incomplete mint proof", async () => {
    expect(await verifyCctpEvmDestination({ sourceDomain: 6, destinationDomain: 3, transactionHash: txHash, rawMessage, readers: readers(null, null) })).toBeNull();
    expect(await verifyCctpEvmDestination({ sourceDomain: 6, destinationDomain: 3, transactionHash: txHash, rawMessage, readers: readers(receipt(), receipt(), 100) })).toBeNull();
    await expect(verifyCctpEvmDestination({ sourceDomain: 6, destinationDomain: 3, transactionHash: txHash, rawMessage, readers: readers(receipt(), null) })).rejects.toThrow("CCTP_DESTINATION_RECEIPT_QUORUM_MISMATCH");
    await expect(verifyCctpEvmDestination({ sourceDomain: 6, destinationDomain: 3, transactionHash: txHash, rawMessage, readers: readers(receipt({ logs: receipt().logs.slice(0, 1) }), receipt({ logs: receipt().logs.slice(0, 1) })) })).rejects.toThrow("CCTP_DESTINATION_MINT_LOG_MISSING");
    await expect(verifyCctpEvmDestination({ sourceDomain: 6, destinationDomain: 3, transactionHash: txHash, rawMessage: message({ fee: 10_000_000n }), readers: readers(receipt(), receipt()) })).rejects.toThrow("CCTP_DESTINATION_MESSAGE_INVALID");
  });

  it("pins reviewed EVM destinations and uses credential-free bounded JSON-RPC", async () => {
    expect(cctpEvmDestinationConfig(3)).toMatchObject({ chainId: 421_614n, messageTransmitter: transmitter, tokenMessenger: messenger, mintToken: arbitrumUsdc });
    expect(cctpEvmDestinationConfig(5)).toBeNull();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = request.method === "eth_chainId" ? "0x66eee" : request.method === "eth_blockNumber" ? "0x65" : rpcReceipt();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await verifyCctpEvmDestination({ sourceDomain: 6, destinationDomain: 3, transactionHash: txHash, rawMessage, readers: createCctpEvmDestinationReaderQuorum(3, fetchMock as typeof fetch)! });
    expect(result?.confirmations).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }));
  });
});

function message(change: Partial<{ fee: bigint; recipient: string }> = {}): string {
  const bytes = new Uint8Array(376), view = new DataView(bytes.buffer);
  view.setUint32(0, 1, false); view.setUint32(4, 6, false); view.setUint32(8, 3, false);
  setHex(bytes, 12, nonce); setHex(bytes, 44, addressWord(messenger)); setHex(bytes, 76, addressWord(messenger)); view.setUint32(144, finality, false);
  view.setUint32(148, 1, false); setHex(bytes, 152, addressWord("0x036cbd53842c5426634e7929541ec2318f3dcf7e")); setHex(bytes, 184, addressWord(change.recipient ?? recipient));
  setUint256(bytes, 216, 10_000_000n); setHex(bytes, 248, addressWord("0x1111111111111111111111111111111111111111")); setUint256(bytes, 280, 10_000n); setUint256(bytes, 312, change.fee ?? 1_000n); setUint256(bytes, 344, 123_456n);
  return `0x${hex(bytes)}`;
}

function receipt(change: Partial<CctpEvmDestinationReceipt> = {}): CctpEvmDestinationReceipt {
  const body = `0x${rawMessage.slice(2 + 148 * 2)}`;
  const logs = [
    { address: transmitter, topics: [messageTopic, addressWord("0x3333333333333333333333333333333333333333"), nonce, word(BigInt(finality))], data: AbiCoder.defaultAbiCoder().encode(["uint32", "bytes32", "bytes"], [6, addressWord(messenger), body]).toLowerCase(), transactionHash: txHash, blockNumber: 100, blockHash, logIndex: 4 },
    { address: messenger, topics: [mintTopic, addressWord(recipient), addressWord(arbitrumUsdc)], data: AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [9_999_000n, 1_000n]).toLowerCase(), transactionHash: txHash, blockNumber: 100, blockHash, logIndex: 5 }
  ];
  return { transactionHash: txHash, status: 1, blockNumber: 100, blockHash, logs, ...change };
}

function rpcReceipt() {
  return { transactionHash: txHash, status: "0x1", blockNumber: "0x64", blockHash, logs: receipt().logs.map((log) => ({ ...log, blockNumber: "0x64", logIndex: `0x${log.logIndex.toString(16)}`, removed: false })) };
}

function readers(left: CctpEvmDestinationReceipt | null, right: CctpEvmDestinationReceipt | null, head = 101): CctpEvmDestinationReader[] {
  return [left, right].map((value, index) => ({ id: index ? "rpc-b.example.net" : "rpc-a.example.org", chainId: async () => 421_614n, blockNumber: async () => head, receipt: async () => value }));
}

function addressWord(address: string): string { return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`; }
function word(value: bigint): string { return `0x${value.toString(16).padStart(64, "0")}`; }
function setHex(target: Uint8Array, offset: number, value: string): void { for (let index = 0; index < 32; index += 1) target[offset + index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16); }
function setUint256(target: Uint8Array, offset: number, value: bigint): void { setHex(target, offset, word(value)); }
function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
