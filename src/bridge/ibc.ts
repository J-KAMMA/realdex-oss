import { fromBech32 } from "@cosmjs/encoding";
import type { OfflineSigner } from "@cosmjs/proto-signing";
import { boundedJsonGet } from "../security/bounded-json-get";
import type { BridgeRoute } from "./types";

export type IbcDirection = "noble-to-osmosis" | "osmosis-to-noble";

export type IbcEstimate = {
  amountReceived: string;
  feeAmount: string;
  feeSymbol: string;
  totalDebit: string;
  sender: string;
  gasLimit: number;
  timeoutAt: number;
  quoteExpiresAt: number;
  fee: { amount: readonly { denom: string; amount: string }[]; gas: string };
};

export type IbcExecutionResult = {
  state: "pending" | "error";
  provider: string;
  steps: Array<{ name: string; state: string; txHash?: string; explorerUrl?: string; errorMessage?: string }>;
  tracking?: IbcPacketTracking;
  failureCode?: number;
};

export type IbcPacketTracking = { sourceTxHash: string; sequence: string; sourceChannel: string; destinationChannel: string; timeoutAt: number };

type RuntimeRoute = {
  direction: IbcDirection;
  manifest: BridgeRoute;
  sourceChannel: string;
  counterpartyChannel: string;
  sourcePort: "transfer";
  sourceRpc: string;
  sourceRest: string;
  destinationRest: string;
  sourceDenom: string;
  feeDenom: string;
  feeSymbol: string;
  gasPrice: string;
  sourcePrefix: string;
  destinationPrefix: string;
  explorerTx: string;
};

type KeplrLike = {
  enable(chainId: string): Promise<void>;
  experimentalSuggestChain?(chainInfo: unknown): Promise<void>;
};

declare global {
  interface Window {
    keplr?: KeplrLike;
    getOfflineSignerAuto?: (chainId: string) => Promise<OfflineSigner>;
  }
}

const REVIEWED_AT = "2026-08-31T00:00:00.000Z";
const NOBLE_USDC = "uusdc";
const OSMOSIS_USDC = "ibc/DE6792CF9E521F6AD6E9A4BDF6225C9571A3B74ACC0A529F92BC5122A39D2E58";
const EVIDENCE = [
  "https://github.com/cosmos/chain-registry/blob/master/testnets/nobletestnet/chain.json",
  "https://github.com/cosmos/chain-registry/blob/master/testnets/osmosistestnet/chain.json",
  "https://github.com/cosmos/chain-registry/blob/master/testnets/_IBC/nobletestnet-osmosistestnet.json",
  "https://github.com/cosmos/ibc/blob/main/spec/app/ics-020-fungible-token-transfer/README.md"
];

const NOBLE = { id: "grand-1", name: "Noble Testnet", family: "cosmos" as const, nativeAsset: "USDC.n", addressFormat: "noble bech32", finalityLabel: "source block included" };
const OSMOSIS = { id: "osmo-test-5", name: "Osmosis Testnet", family: "cosmos" as const, nativeAsset: "OSMO", addressFormat: "osmo bech32", finalityLabel: "source block included" };

export const IBC_ROUTES: Record<IbcDirection, BridgeRoute> = {
  "noble-to-osmosis": {
    id: "ibc-grand-1-osmo-test-5-usdc", revision: 1, category: "non-evm-to-non-evm", status: "verified",
    provider: "Cosmos IBC ICS-20", mechanism: "escrow-release", verificationModel: "light-client", source: NOBLE, destination: OSMOSIS,
    sourceEndpoint: "transfer/channel-22", destinationEndpoint: "transfer/channel-4280",
    supportedAssets: [{ chainId: NOBLE.id, assetId: NOBLE_USDC, symbol: "USDC.n", decimals: 6, representation: "native" }],
    requiredSourceFinality: "included in a source block", requiredDestinationFinality: "ICS-20 acknowledgement observed",
    recovery: "automatic-timeout", reviewedAt: REVIEWED_AT, evidenceUrls: EVIDENCE
  },
  "osmosis-to-noble": {
    id: "ibc-osmo-test-5-grand-1-usdc", revision: 1, category: "non-evm-to-non-evm", status: "verified",
    provider: "Cosmos IBC ICS-20", mechanism: "escrow-release", verificationModel: "light-client", source: OSMOSIS, destination: NOBLE,
    sourceEndpoint: "transfer/channel-4280", destinationEndpoint: "transfer/channel-22",
    supportedAssets: [{ chainId: OSMOSIS.id, assetId: OSMOSIS_USDC, symbol: "USDC.n", decimals: 6, representation: "bridge-wrapped" }],
    requiredSourceFinality: "included in a source block", requiredDestinationFinality: "ICS-20 acknowledgement observed",
    recovery: "automatic-timeout", reviewedAt: REVIEWED_AT, evidenceUrls: EVIDENCE
  }
};

const RUNTIME: Record<IbcDirection, RuntimeRoute> = {
  "noble-to-osmosis": {
    direction: "noble-to-osmosis", manifest: IBC_ROUTES["noble-to-osmosis"], sourceChannel: "channel-22", counterpartyChannel: "channel-4280", sourcePort: "transfer",
    sourceRpc: "https://noble-testnet-rpc.polkachu.com", sourceRest: "https://noble-testnet-api.polkachu.com", destinationRest: "https://lcd.osmotest5.osmosis.zone",
    sourceDenom: NOBLE_USDC, feeDenom: "uusdc", feeSymbol: "USDC.n", gasPrice: "0.025uusdc", sourcePrefix: "noble", destinationPrefix: "osmo",
    explorerTx: "https://mintscan.io/noble-testnet/txs/"
  },
  "osmosis-to-noble": {
    direction: "osmosis-to-noble", manifest: IBC_ROUTES["osmosis-to-noble"], sourceChannel: "channel-4280", counterpartyChannel: "channel-22", sourcePort: "transfer",
    sourceRpc: "https://rpc.osmotest5.osmosis.zone", sourceRest: "https://lcd.osmotest5.osmosis.zone", destinationRest: "https://noble-testnet-api.polkachu.com",
    sourceDenom: OSMOSIS_USDC, feeDenom: "uosmo", feeSymbol: "OSMO", gasPrice: "0.025uosmo", sourcePrefix: "osmo", destinationPrefix: "noble",
    explorerTx: "https://mintscan.io/osmosis-testnet/txs/"
  }
};

export function isIbcDirection(value: string | null): value is IbcDirection {
  return value === "noble-to-osmosis" || value === "osmosis-to-noble";
}

export function ibcFinalityRouteForId(routeId: string): Pick<RuntimeRoute, "sourceRest" | "destinationRest" | "sourceChannel" | "counterpartyChannel" | "explorerTx"> & { destinationChannel: string } | null {
  const route = Object.values(RUNTIME).find((candidate) => candidate.manifest.id === routeId);
  return route ? { sourceRest: route.sourceRest, destinationRest: route.destinationRest, sourceChannel: route.sourceChannel, counterpartyChannel: route.counterpartyChannel, destinationChannel: route.counterpartyChannel, explorerTx: route.explorerTx } : null;
}

export function extractIbcPacketTracking(direction: IbcDirection, txHash: string, events: readonly unknown[], timeoutAt: number): IbcPacketTracking {
  const route = RUNTIME[direction];
  if (!/^[0-9A-F]{64}$/i.test(txHash) || !Number.isSafeInteger(timeoutAt) || timeoutAt <= 0 || !Array.isArray(events)) throw new Error("IBC_PACKET_TRACKING_INVALID");
  const packets = events.flatMap((event) => {
    if (!isPlainObject(event) || event.type !== "send_packet" || !Array.isArray(event.attributes)) return [];
    const attributes = new Map(event.attributes.filter(isPlainObject).map((item) => [String(item.key), String(item.value)]));
    const sequence = attributes.get("packet_sequence");
    const sourceChannel = attributes.get("packet_src_channel");
    const destinationChannel = attributes.get("packet_dst_channel");
    return sequence && sourceChannel && destinationChannel ? [{ sequence, sourceChannel, destinationChannel }] : [];
  }).filter((packet) => /^\d{1,20}$/.test(packet.sequence) && packet.sourceChannel === route.sourceChannel && packet.destinationChannel === route.counterpartyChannel);
  if (packets.length !== 1) throw new Error(packets.length ? "IBC_PACKET_TRACKING_AMBIGUOUS" : "IBC_PACKET_TRACKING_MISSING");
  return { sourceTxHash: txHash.toUpperCase(), ...packets[0], timeoutAt };
}

export function validateIbcAmount(value: string): string {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(trimmed)) throw new Error("Enter a positive USDC amount with at most 6 decimal places.");
  const units = toBaseUnits(trimmed);
  if (units <= 0n) throw new Error("Amount must be greater than zero.");
  return trimmed;
}

export function validateIbcRecipient(direction: IbcDirection, value: string): string {
  const recipient = value.trim();
  const expectedPrefix = RUNTIME[direction].destinationPrefix;
  try {
    const decoded = fromBech32(recipient);
    if (decoded.prefix !== expectedPrefix || decoded.data.length !== 20) throw new Error("wrong prefix or length");
  } catch {
    throw new Error(`Enter an exact ${expectedPrefix} bech32 recipient address.`);
  }
  return recipient;
}

export function canRequestIbcEstimate(direction: IbcDirection | null, amount: string, recipient: string): boolean {
  if (!direction) return false;
  try { validateIbcAmount(amount); validateIbcRecipient(direction, recipient); return true; } catch { return false; }
}

export async function estimateIbc(direction: IbcDirection, amountInput: string, recipientInput: string): Promise<IbcEstimate> {
  const amount = validateIbcAmount(amountInput);
  const recipient = validateIbcRecipient(direction, recipientInput);
  const route = RUNTIME[direction];
  await assertOpenChannel(route);
  const { client, sender } = await signingClient(route);
  const amountBaseUnits = toBaseUnits(amount);
  const message = transferMessage(route, sender, recipient, amountBaseUnits, Date.now() + 20 * 60_000);
  const [{ calculateFee, GasPrice }, gasUsed, transferBalance, feeBalance] = await Promise.all([
    import("@cosmjs/stargate"),
    client.simulate(sender, [message], "RealDEX IBC testnet transfer"),
    client.getBalance(sender, route.sourceDenom),
    client.getBalance(sender, route.feeDenom)
  ]);
  const gasLimit = Math.ceil(gasUsed * 1.3);
  const fee = calculateFee(gasLimit, GasPrice.fromString(route.gasPrice));
  const feeBaseUnits = BigInt(fee.amount.find((coin) => coin.denom === route.feeDenom)?.amount ?? "0");
  if (BigInt(transferBalance.amount) < amountBaseUnits) throw new Error("The source wallet does not have enough testnet USDC for this transfer.");
  const sameDenom = route.sourceDenom === route.feeDenom;
  if (BigInt(feeBalance.amount) < feeBaseUnits + (sameDenom ? amountBaseUnits : 0n)) throw new Error(`The source wallet does not have enough ${route.feeSymbol} for amount plus gas.`);
  const now = Date.now();
  return {
    amountReceived: amount, feeAmount: fromBaseUnits(feeBaseUnits), feeSymbol: route.feeSymbol,
    totalDebit: sameDenom ? fromBaseUnits(amountBaseUnits + feeBaseUnits) : amount,
    sender, gasLimit, timeoutAt: now + 20 * 60_000, quoteExpiresAt: now + 2 * 60_000, fee
  };
}

const inFlight = new Set<string>();

export async function executeIbc(direction: IbcDirection, amountInput: string, recipientInput: string, estimate: IbcEstimate, onProgress?: (result: IbcExecutionResult) => void): Promise<IbcExecutionResult> {
  const amount = validateIbcAmount(amountInput);
  const recipient = validateIbcRecipient(direction, recipientInput);
  if (estimate.quoteExpiresAt <= Date.now()) throw new Error("The fee estimate expired. Request a new estimate before signing.");
  const route = RUNTIME[direction];
  const fingerprint = `${route.manifest.id}|${estimate.sender}|${recipient}|${toBaseUnits(amount)}|${estimate.timeoutAt}`;
  const guardKey = `localswap:ibc-pending:${fingerprint}`;
  if (inFlight.has(fingerprint) || pendingGuardExists(guardKey)) throw new Error("An identical IBC transfer is already signing, submitted, or awaiting acknowledgement.");
  inFlight.add(fingerprint);
  writeGuard(guardKey, { state: "signing-or-unknown", expiresAt: estimate.timeoutAt + 10 * 60_000 });
  try {
    await assertOpenChannel(route);
    const { client, sender } = await signingClient(route);
    if (sender !== estimate.sender) throw new Error("The connected source account changed after the estimate. Request a new estimate.");
    const response = await client.signAndBroadcast(sender, [transferMessage(route, sender, recipient, toBaseUnits(amount), estimate.timeoutAt)], estimate.fee, "RealDEX IBC testnet transfer");
    if (response.code !== 0) {
      localStorage.removeItem(guardKey);
      return { state: "error", provider: route.manifest.provider, steps: [{ name: "Source transaction", state: "failed", txHash: response.transactionHash, errorMessage: response.rawLog }], failureCode: response.code };
    }
    writeGuard(guardKey, { state: "source-included-awaiting-ack", txHash: response.transactionHash, expiresAt: estimate.timeoutAt + 10 * 60_000 });
    let tracking: IbcPacketTracking | undefined;
    let trackingError: string | undefined;
    try { tracking = extractIbcPacketTracking(direction, response.transactionHash, response.events, estimate.timeoutAt); }
    catch (reason) { trackingError = reason instanceof Error ? reason.message : "IBC_PACKET_TRACKING_INVALID"; }
    const result: IbcExecutionResult = {
      state: "pending", provider: route.manifest.provider,
      steps: [
        { name: "Source transaction", state: "included", txHash: response.transactionHash, explorerUrl: `${route.explorerTx}${response.transactionHash}` },
        { name: "IBC packet acknowledgement", state: tracking ? "not yet verified" : "tracking metadata unavailable", errorMessage: trackingError }
      ],
      tracking
    };
    onProgress?.(result);
    return result;
  } catch (reason) {
    if (isKnownWalletRejection(reason)) localStorage.removeItem(guardKey);
    throw reason;
  } finally {
    inFlight.delete(fingerprint);
  }
}

async function signingClient(route: RuntimeRoute) {
  if (!window.keplr || !window.getOfflineSignerAuto) throw new Error("Install and unlock a Keplr-compatible wallet to use this IBC testnet route.");
  if (window.keplr.experimentalSuggestChain) await window.keplr.experimentalSuggestChain(chainInfo(route));
  await window.keplr.enable(route.manifest.source.id);
  const signer = await window.getOfflineSignerAuto(route.manifest.source.id);
  const accounts = await signer.getAccounts();
  const sender = accounts[0]?.address;
  if (!sender || fromBech32(sender).prefix !== route.sourcePrefix) throw new Error(`The wallet did not return a ${route.sourcePrefix} source account.`);
  const { GasPrice, SigningStargateClient } = await import("@cosmjs/stargate");
  const client = await SigningStargateClient.connectWithSigner(route.sourceRpc, signer, { gasPrice: GasPrice.fromString(route.gasPrice) });
  if (await client.getChainId() !== route.manifest.source.id) throw new Error("The RPC chain ID does not match the reviewed route.");
  return { client, sender };
}

function transferMessage(route: RuntimeRoute, sender: string, receiver: string, amount: bigint, timeoutAt: number) {
  return {
    typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
    value: {
      sourcePort: route.sourcePort, sourceChannel: route.sourceChannel,
      token: { denom: route.sourceDenom, amount: amount.toString() }, sender, receiver,
      timeoutHeight: undefined, timeoutTimestamp: BigInt(timeoutAt) * 1_000_000n, memo: ""
    }
  } as const;
}

async function assertOpenChannel(route: RuntimeRoute) {
  const [source, destination] = await Promise.all([
    readIbcChannel(route.sourceRest, route.sourceChannel), readIbcChannel(route.destinationRest, route.counterpartyChannel)
  ]);
  if (source.state !== "STATE_OPEN" || source.version !== "ics20-1" || source.counterparty !== route.counterpartyChannel) throw new Error("The reviewed source IBC channel is not OPEN or its counterparty changed.");
  if (destination.state !== "STATE_OPEN" || destination.version !== "ics20-1" || destination.counterparty !== route.sourceChannel) throw new Error("The reviewed destination IBC channel is not OPEN or its counterparty changed.");
}

export async function readIbcChannel(rest: string, channel: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000) {
  if (!/^channel-\d{1,10}$/.test(channel)) throw new Error("IBC_CHANNEL_ID_INVALID");
  const response = await boundedJsonGet(`${rest}/ibc/core/channel/v1/channels/${channel}/ports/transfer`, fetchImpl, { errorPrefix: "IBC_CHANNEL", timeoutMs });
  if (!response.ok) throw new Error(`IBC channel verification failed with HTTP ${response.status}.`);
  const body = response.body as { channel?: { state?: string; version?: string; counterparty?: { channel_id?: string } } };
  return { state: body.channel?.state, version: body.channel?.version, counterparty: body.channel?.counterparty?.channel_id };
}

function chainInfo(route: RuntimeRoute) {
  const noble = route.manifest.source.id === "grand-1";
  const prefix = noble ? "noble" : "osmo";
  const coin = noble
    ? { coinDenom: "USDC.n", coinMinimalDenom: "uusdc", coinDecimals: 6 }
    : { coinDenom: "OSMO", coinMinimalDenom: "uosmo", coinDecimals: 6 };
  return {
    chainId: route.manifest.source.id, chainName: route.manifest.source.name, rpc: route.sourceRpc, rest: route.sourceRest,
    bip44: { coinType: 118 }, stakeCurrency: coin, currencies: [coin], feeCurrencies: [{ ...coin, gasPriceStep: noble ? { low: 0.01, average: 0.025, high: 0.03 } : { low: 0.0025, average: 0.025, high: 0.04 } }],
    bech32Config: {
      bech32PrefixAccAddr: prefix, bech32PrefixAccPub: `${prefix}pub`, bech32PrefixValAddr: `${prefix}valoper`, bech32PrefixValPub: `${prefix}valoperpub`,
      bech32PrefixConsAddr: `${prefix}valcons`, bech32PrefixConsPub: `${prefix}valconspub`
    }
  };
}

function toBaseUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

function fromBaseUnits(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function pendingGuardExists(key: string): boolean {
  try {
    const item = JSON.parse(localStorage.getItem(key) ?? "null") as { expiresAt?: number } | null;
    if (!item?.expiresAt || item.expiresAt <= Date.now()) { localStorage.removeItem(key); return false; }
    return true;
  } catch { localStorage.removeItem(key); return false; }
}

function writeGuard(key: string, value: object) {
  localStorage.setItem(key, JSON.stringify({ ...value, updatedAt: Date.now() }));
}

function isKnownWalletRejection(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /reject|denied|cancel/i.test(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
