/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import type { CctpEvmSourceReader, CctpEvmSourceReceipt } from "../bridge/cctp-evm-source";
import type { CctpEvmDestinationReader, CctpEvmDestinationReceipt } from "../bridge/cctp-evm-destination";
import { legacyRouteDescriptorFingerprint, routeDescriptorFingerprint } from "./engine";
import { applyFinalityObservation, assertRouteFinalityRecord, checkRouteFinality, createRouteFinalityRecord, finalityTrackingReducer, initialFinalityTrackingState, isTerminalFinalityStage, loadRouteFinalities, loadRouteFinality, persistRouteFinality, reconcileRouteFinalityRecord, reserveRouteFinality, routeFinalityStorageHasCapacity } from "./finality";
import { ROUTE_DESCRIPTORS } from "./registry";
import type { RouteDescriptor, RouteFinalityCursor, RouteQuote } from "./types";

const cctpRoute = route("cctp-v2-base-sepolia-arbitrum-sepolia-usdc");
const ibcRoute = route("ibc-grand-1-osmo-test-5-usdc");
const evmTx = `0x${"a".repeat(64)}`;
const ibcTx = "B".repeat(64);
const now = Date.now();

beforeEach(() => localStorage.clear());

describe("route finality tracking", () => {
  it("rejects stale check results and impossible regression", () => {
    const record = cctpRecord();
    let state = initialFinalityTrackingState(record);
    state = finalityTrackingReducer(state, { type: "checkStarted", attemptId: "check-1" });
    expect(finalityTrackingReducer(state, { type: "checkSucceeded", attemptId: "stale", observation: { stage: "source-included", evidence: [] }, now })).toBe(state);
    state = finalityTrackingReducer(state, { type: "checkSucceeded", attemptId: "check-1", observation: { stage: "destination-submitted", evidence: cctpProofEvidence() }, now });
    expect(state.record.stage).toBe("destination-submitted");
    expect(() => applyFinalityObservation(state.record, { stage: "source-included", evidence: [] }, now + 1)).toThrow("FINALITY_TRANSITION_INVALID");
  });

  it("persists only a record bound to the current route fingerprint", () => {
    const record = cctpRecord();
    expect(persistRouteFinality(record, cctpRoute)).toBe(true);
    expect(loadRouteFinality(cctpRoute).record).toEqual(record);
    const changed = { ...cctpRoute, revision: cctpRoute.revision + 1 };
    expect(loadRouteFinality(changed).error).toBe("FINALITY_ROUTE_CHANGED");
    localStorage.setItem(`localswap:finality:v1:${cctpRoute.id}`, "not-json");
    expect(loadRouteFinality(cctpRoute).error).toBe("FINALITY_CHECK_FAILED");
  });

  it("reports failure when finality storage does not retain the exact serialized record", () => {
    const record = cctpRecord();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => undefined);
    expect(persistRouteFinality(record, cctpRoute)).toBe(false);
    expect(loadRouteFinality(cctpRoute).record).toBeUndefined();
    setItem.mockRestore();
  });

  it("retains separate evidence records for repeated transfers on the same route", () => {
    const first = cctpRecord();
    const second = { ...cctpRecord(), executionId: "exec:cctp:second", quoteId: "quote:cctp:second", createdAt: now + 1, updatedAt: now + 1 };
    expect(persistRouteFinality(first, cctpRoute)).toBe(true);
    expect(persistRouteFinality(second, cctpRoute)).toBe(true);
    const loaded = loadRouteFinalities(cctpRoute);
    expect(loaded.error).toBeUndefined();
    expect(loaded.records.map((record) => record.executionId)).toEqual([second.executionId, first.executionId]);
  });

  it("durably reserves a quote-specific recovery slot before execution and upgrades it after submission", () => {
    const quote = cctpQuote();
    const reservation = reserveRouteFinality(cctpRoute, quote, `cctp:${quote.quoteId}`, now);
    let loaded = loadRouteFinalities(cctpRoute);
    expect(loaded.records).toEqual([]);
    expect(loaded.reservations).toEqual([reservation]);
    const submitted = { ...cctpRecord(), executionId: reservation.executionId, quoteId: reservation.quoteId };
    expect(persistRouteFinality(submitted, cctpRoute)).toBe(true);
    loaded = loadRouteFinalities(cctpRoute);
    expect(loaded.reservations).toEqual([]);
    expect(loaded.records).toEqual([submitted]);
  });

  it("stops before execution when a recovery reservation does not survive exact readback", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => undefined);
    expect(() => reserveRouteFinality(cctpRoute, cctpQuote(), "cctp:quote:reserved", now)).toThrow("FINALITY_STORAGE_PERSIST_FAILED");
    expect(loadRouteFinalities(cctpRoute).reservations).toEqual([]);
    setItem.mockRestore();
  });

  it("counts durable reservations against the route recovery capacity", () => {
    for (let index = 0; index < 16; index += 1) {
      const quote = { ...cctpQuote(), quoteId: `quote:reserved:${index}` };
      reserveRouteFinality(cctpRoute, quote, `cctp:${quote.quoteId}`, now + index);
    }
    expect(loadRouteFinalities(cctpRoute).reservations).toHaveLength(16);
    expect(routeFinalityStorageHasCapacity(cctpRoute)).toBe(false);
    const overflow = { ...cctpQuote(), quoteId: "quote:reserved:overflow" };
    expect(() => reserveRouteFinality(cctpRoute, overflow, `cctp:${overflow.quoteId}`, now + 17)).toThrow("FINALITY_STORAGE_CAPACITY_UNAVAILABLE");
  });

  it("rejects quote or execution identity reuse before corrupting the recovery journal", () => {
    const first = cctpQuote();
    reserveRouteFinality(cctpRoute, first, "cctp:stable-execution", now);
    const differentQuote = { ...first, quoteId: "quote:different" };
    expect(() => reserveRouteFinality(cctpRoute, differentQuote, "cctp:stable-execution", now + 1)).toThrow("FINALITY_RESERVATION_CONFLICT");
    expect(() => reserveRouteFinality(cctpRoute, first, "cctp:different-execution", now + 1)).toThrow("FINALITY_RESERVATION_CONFLICT");
    const loaded = loadRouteFinalities(cctpRoute);
    expect(loaded.error).toBeUndefined();
    expect(loaded.reservations).toHaveLength(1);
  });

  it("reconciles a later provider receipt onto already durable progress without resetting revision", () => {
    const submitted = cctpRecord();
    const completed = { ...submitted, stage: "awaiting-proof" as const, evidence: cctpProofEvidence(), createdAt: now + 1, updatedAt: now + 1 };
    const reconciled = reconcileRouteFinalityRecord(submitted, completed, cctpRoute, now + 2);
    expect(reconciled).toMatchObject({ stage: "awaiting-proof", revision: 2, createdAt: submitted.createdAt, updatedAt: now + 2 });
  });

  it("rejects identity collisions, stale updates, and evidence regression", () => {
    const first = cctpRecord();
    expect(persistRouteFinality(first, cctpRoute)).toBe(true);
    expect(persistRouteFinality({ ...first, quoteId: "different-quote" }, cctpRoute)).toBe(false);
    const advanced = applyFinalityObservation(first, { stage: "source-included", evidence: cctpProofEvidence() }, now + 1);
    expect(persistRouteFinality(advanced, cctpRoute)).toBe(true);
    expect(persistRouteFinality(first, cctpRoute)).toBe(false);
    expect(() => persistRouteFinality({ ...advanced, revision: advanced.revision + 1, updatedAt: now + 2, evidence: [] }, cctpRoute)).toThrow("CCTP_SOURCE_PROOF_REQUIRED");
    expect(loadRouteFinality(cctpRoute).record).toEqual(advanced);
  });

  it("keeps an exact legacy route fingerprint readable for tracking only", () => {
    const legacy = { ...cctpRecord(), routeFingerprint: legacyRouteDescriptorFingerprint(cctpRoute) };
    expect(legacy.routeFingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    expect(() => assertRouteFinalityRecord(legacy, cctpRoute, now)).not.toThrow();
    expect(persistRouteFinality(legacy, cctpRoute)).toBe(false);
    expect(() => assertRouteFinalityRecord({ ...legacy, routeFingerprint: "fnv1a:00000000" }, cctpRoute, now)).toThrow("FINALITY_ROUTE_CHANGED");
  });

  it("confirms an EVM CCTP destination only after exact message and mint logs reach two-RPC quorum", async () => {
    const pending = await checkRouteFinality(cctpRecord(), cctpRoute, responseSequence([
      jsonResponse({ messages: [{ cctpVersion: 2, status: "pending", message: cctpMessage() }] })
    ]), now, cctpReaders(cctpMessage()));
    expect(pending.stage).toBe("source-included");

    const proofReady = await checkRouteFinality(cctpRecord(), cctpRoute, responseSequence([
      jsonResponse({ messages: [{ cctpVersion: 2, status: "complete", message: cctpMessage() }] })
    ]), now, cctpReaders(cctpMessage()));
    expect(proofReady.stage).toBe("awaiting-proof");

    const destination = await checkRouteFinality(cctpRecord(), cctpRoute, responseSequence([
      jsonResponse({ messages: [{ cctpVersion: 2, status: "complete", forwardTxHash: `0x${"c".repeat(64)}`, message: cctpMessage() }] })
    ]), now, cctpReaders(cctpMessage()), cctpDestinationReaders(cctpMessage()));
    expect(destination.stage).toBe("destination-confirmed");
    expect(destination.evidence.map((item) => item.kind)).toEqual(["source-tx", "source-log", "provider-message", "destination-tx", "destination-message", "destination-mint"]);
    expect(() => assertRouteFinalityRecord({ ...cctpRecord(), stage: "destination-confirmed", evidence: destination.evidence.filter((item) => item.kind !== "destination-mint") }, cctpRoute, now)).toThrow("CCTP_DESTINATION_PROOF_REQUIRED");
  });

  it("does not attach a valid but different CCTP burn message to this execution", async () => {
    const mismatched = await checkRouteFinality(cctpRecord(), cctpRoute, responseSequence([
      jsonResponse({ messages: [{ cctpVersion: 2, status: "complete", message: cctpMessage({ amount: 9_999_999n }) }] })
    ]), now);
    expect(mismatched).toEqual({ stage: "source-submitted", evidence: [] });
    await expect(checkRouteFinality(cctpRecord(), cctpRoute, responseSequence([
      jsonResponse({ messages: [{ cctpVersion: 2, status: "complete", message: "0x01" }] })
    ]), now)).rejects.toThrow("CCTP_FINALITY_MESSAGE_INVALID");
  });

  it("keeps an unbound historical CCTP cursor readable but refuses to refresh it", async () => {
    const current = cctpRecord();
    const legacy = { ...current, cursor: { protocol: "cctp-v2" as const, sourceDomain: 6, destinationDomain: 3, sourceTxCandidates: [evmTx] } };
    expect(() => assertRouteFinalityRecord(legacy, cctpRoute, now)).not.toThrow();
    await expect(checkRouteFinality(legacy, cctpRoute, responseSequence([]), now)).rejects.toThrow("CCTP_FINALITY_TRANSFER_BINDING_REQUIRED");
    expect(() => assertRouteFinalityRecord({ ...legacy, cursor: { ...legacy.cursor, unreviewed: true } } as never, cctpRoute, now)).toThrow("CCTP_FINALITY_CURSOR_INVALID");
  });

  it("bounds and strictly parses external finality responses", async () => {
    await expect(checkRouteFinality(cctpRecord(), cctpRoute, responseSequence([new Response("x".repeat(1_000_001), { status: 200 })]), now)).rejects.toThrow("FINALITY_PROVIDER_RESPONSE_TOO_LARGE");
    await expect(checkRouteFinality(cctpRecord(), cctpRoute, responseSequence([new Response("not-json", { status: 200 })]), now)).rejects.toThrow("FINALITY_PROVIDER_RESPONSE_INVALID");
  });

  it("keeps a REST-observed successful IBC acknowledgement non-terminal until its proof is independently verified", async () => {
    const record = ibcRecord(now + 60_000);
    const request = vi.fn(async (input: string | URL | Request) => String(input).includes("cosmos/tx")
      ? jsonResponse(sourceTxBody())
      : jsonResponse({ acknowledgement: btoa(JSON.stringify({ result: "AQ==" })), proof_height: { revision_height: "123" } }));
    const observation = await checkRouteFinality(record, ibcRoute, request as typeof fetch, now);
    expect(observation.stage).toBe("destination-observed");
    expect(isTerminalFinalityStage(observation.stage)).toBe(false);
    expect(observation.evidence.map((item) => item.kind)).toEqual(["source-tx", "packet-ack"]);
    expect(observation.evidence[1].outcome).toBe("success");
  });

  it("keeps an absent IBC acknowledgement pending before timeout and unknown after timeout", async () => {
    const request = vi.fn(async (input: string | URL | Request) => String(input).includes("cosmos/tx") ? jsonResponse(sourceTxBody()) : jsonResponse({}, 404));
    expect((await checkRouteFinality(ibcRecord(now + 60_000), ibcRoute, request as typeof fetch, now)).stage).toBe("awaiting-proof");
    expect((await checkRouteFinality(ibcRecord(now - 1), ibcRoute, request as typeof fetch, now)).stage).toBe("unknown");
  });

  it("keeps a REST-observed ICS-20 error acknowledgement non-terminal", async () => {
    const request = vi.fn(async (input: string | URL | Request) => String(input).includes("cosmos/tx")
      ? jsonResponse(sourceTxBody())
      : jsonResponse({ acknowledgement: btoa(JSON.stringify({ error: "destination rejected packet" })), proof_height: { revision_height: "124" } }));
    const observation = await checkRouteFinality(ibcRecord(now + 60_000), ibcRoute, request as typeof fetch, now);
    expect(observation.stage).toBe("destination-observed");
    expect(observation.evidence[1].outcome).toBe("error");
    expect(isTerminalFinalityStage(observation.stage)).toBe(false);
  });

  it("rejects contradictory acknowledgement outcomes for one exact proof height", () => {
    const record = ibcRecord(now + 60_000);
    const id = "channel-4280/7@123";
    const observed = applyFinalityObservation(record, { stage: "destination-observed", evidence: [{ kind: "packet-ack", id, observedAt: now, outcome: "success" }] }, now + 1);
    expect(() => applyFinalityObservation(observed, { stage: "destination-observed", evidence: [{ kind: "packet-ack", id, observedAt: now + 2, outcome: "error" }] }, now + 2)).toThrow("IBC_ACK_OBSERVATION_CONFLICT");
  });

  it("rejects legacy IBC terminal claims that lack independent proof authority", () => {
    const legacyTerminal = {
      ...ibcRecord(now + 60_000), stage: "destination-confirmed" as const,
      evidence: [{ kind: "packet-ack" as const, id: "channel-4280/7@123", observedAt: now, outcome: "success" as const }]
    };
    expect(() => assertRouteFinalityRecord(legacyTerminal, ibcRoute, now)).toThrow("IBC_FINALITY_INDEPENDENT_PROOF_REQUIRED");
    expect(() => applyFinalityObservation(ibcRecord(now + 60_000), { stage: "destination-confirmed", evidence: [] }, now + 1)).toThrow("IBC_FINALITY_INDEPENDENT_PROOF_REQUIRED");
    expect(() => applyFinalityObservation(ibcRecord(now + 60_000), { stage: "failed", evidence: [{ kind: "packet-ack", id: "channel-4280/7@123", observedAt: now, outcome: "error" }] }, now + 1)).toThrow("IBC_FINALITY_INDEPENDENT_PROOF_REQUIRED");
  });
});

function cctpRecord() {
  return createRouteFinalityRecord({ executionId: "exec:cctp", quoteId: "quote:cctp", routeId: cctpRoute.id, routeFingerprint: routeDescriptorFingerprint(cctpRoute), provider: "Circle", stage: "source-submitted", cursor: { protocol: "cctp-v2", sourceDomain: 6, destinationDomain: 3, sourceTxCandidates: [evmTx], transferBinding: { expectedBurnToken: bytes32Address("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), expectedMintRecipient: bytes32Address("0x2222222222222222222222222222222222222222"), expectedAmount: "10000000", expectedMessageSender: bytes32Address("0x1111111111111111111111111111111111111111") } }, evidence: [] }, now);
}

function cctpMessage(change: Partial<{ sourceDomain: number; destinationDomain: number; burnToken: string; mintRecipient: string; amount: bigint; messageSender: string }> = {}): string {
  const bodyOffset = 148;
  const bytes = new Uint8Array(bodyOffset + 228);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, false);
  view.setUint32(4, change.sourceDomain ?? 6, false);
  view.setUint32(8, change.destinationDomain ?? 3, false);
  bytes[43] = 7;
  setHex(bytes, 44, bytes32Address("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"));
  setHex(bytes, 76, bytes32Address("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"));
  view.setUint32(144, 1_000, false);
  view.setUint32(bodyOffset, 1, false);
  setHex(bytes, bodyOffset + 4, change.burnToken ?? bytes32Address("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
  setHex(bytes, bodyOffset + 36, change.mintRecipient ?? bytes32Address("0x2222222222222222222222222222222222222222"));
  setUint256(bytes, bodyOffset + 68, change.amount ?? 10_000_000n);
  setHex(bytes, bodyOffset + 100, change.messageSender ?? bytes32Address("0x1111111111111111111111111111111111111111"));
  return `0x${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function cctpReaders(rawMessage: string): CctpEvmSourceReader[] {
  const blockHash = `0x${"b".repeat(64)}`;
  const receipt: CctpEvmSourceReceipt = {
    transactionHash: evmTx, status: 1, blockNumber: 100, blockHash,
    logs: [{ address: "0xe737e5cebeeba77efe34d4aa090756590b1ce275", topics: [keccak256(toUtf8Bytes("MessageSent(bytes)")).toLowerCase()], data: abiBytes(rawMessage), transactionHash: evmTx, blockNumber: 100, blockHash, logIndex: 7 }]
  };
  return ["rpc-a.example.org", "rpc-b.example.net"].map((id) => ({ id, chainId: async () => 84_532n, blockNumber: async () => 101, receipt: async () => receipt }));
}

function cctpDestinationReaders(rawMessage: string): CctpEvmDestinationReader[] {
  const destinationTx = `0x${"c".repeat(64)}`, destinationBlockHash = `0x${"d".repeat(64)}`;
  const body = `0x${rawMessage.slice(2 + 148 * 2)}`;
  const receipt: CctpEvmDestinationReceipt = {
    transactionHash: destinationTx, status: 1, blockNumber: 200, blockHash: destinationBlockHash,
    logs: [
      { address: "0xe737e5cebeeba77efe34d4aa090756590b1ce275", topics: [keccak256(toUtf8Bytes("MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)")).toLowerCase(), bytes32Address("0x3333333333333333333333333333333333333333"), `0x${"0".repeat(62)}07`, `0x${(1_000).toString(16).padStart(64, "0")}`], data: AbiCoder.defaultAbiCoder().encode(["uint32", "bytes32", "bytes"], [6, bytes32Address("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"), body]).toLowerCase(), transactionHash: destinationTx, blockNumber: 200, blockHash: destinationBlockHash, logIndex: 8 },
      { address: "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa", topics: [keccak256(toUtf8Bytes("MintAndWithdraw(address,uint256,address,uint256)")).toLowerCase(), bytes32Address("0x2222222222222222222222222222222222222222"), bytes32Address("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d")], data: AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [10_000_000n, 0n]).toLowerCase(), transactionHash: destinationTx, blockNumber: 200, blockHash: destinationBlockHash, logIndex: 9 }
    ]
  };
  return ["rpc-a.example.org", "rpc-b.example.net"].map((id) => ({ id, chainId: async () => 421_614n, blockNumber: async () => 201, receipt: async () => receipt }));
}

function cctpProofEvidence() {
  return [
    { kind: "source-tx" as const, id: evmTx, observedAt: now },
    { kind: "source-log" as const, id: `evm:${evmTx}@0x${"b".repeat(64)}:7:rpc-a.example.org+rpc-b.example.net`, observedAt: now }
  ];
}

function abiBytes(value: string): string {
  const data = value.slice(2).toLowerCase(), length = data.length / 2, padded = data.padEnd(Math.ceil(length / 32) * 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${length.toString(16).padStart(64, "0")}${padded}`;
}

function bytes32Address(address: string): string { return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`; }
function setHex(target: Uint8Array, offset: number, value: string): void { for (let index = 0; index < 32; index += 1) target[offset + index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16); }
function setUint256(target: Uint8Array, offset: number, value: bigint): void { setHex(target, offset, `0x${value.toString(16).padStart(64, "0")}`); }

function cctpQuote(): RouteQuote {
  return {
    quoteId: "quote:reserved", routeId: cctpRoute.id, routeFingerprint: routeDescriptorFingerprint(cctpRoute), requestFingerprint: `0x${"1".repeat(64)}`,
    adapterId: cctpRoute.adapterId, amountInBaseUnits: 1_000_000n, expectedOutBaseUnits: 990_000n, minimumOutBaseUnits: 990_000n,
    fees: [], unpricedCosts: [], expiresAt: now + 60_000, estimatedSeconds: null, authorization: { type: "none" },
    executionPreview: { chainId: "eip155:84532", target: cctpRoute.sourceExecutionTarget, method: cctpRoute.executionMethod, valueBaseUnits: 0n },
    adapterData: { format: "test", value: {} }
  };
}

function ibcRecord(timeoutAt: number) {
  const cursor: RouteFinalityCursor = { protocol: "ibc-ics20", sourceTxHash: ibcTx, sequence: "7", sourceChannel: "channel-22", destinationChannel: "channel-4280", timeoutAt };
  return createRouteFinalityRecord({ executionId: "exec:ibc", quoteId: "quote:ibc", routeId: ibcRoute.id, routeFingerprint: routeDescriptorFingerprint(ibcRoute), provider: "IBC", stage: "source-included", cursor, evidence: [] }, now);
}

function sourceTxBody() {
  return { tx_response: { code: 0, txhash: ibcTx, events: [{ type: "send_packet", attributes: [{ key: "packet_sequence", value: "7" }, { key: "packet_src_channel", value: "channel-22" }, { key: "packet_dst_channel", value: "channel-4280" }] }] } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function responseSequence(responses: Response[]): typeof fetch {
  const mock = vi.fn(async () => responses.shift() ?? jsonResponse({}, 404));
  return mock as typeof fetch;
}

function route(id: string): RouteDescriptor {
  const found = ROUTE_DESCRIPTORS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing route ${id}`);
  return found;
}
