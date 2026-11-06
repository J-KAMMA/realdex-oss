import { base58 } from "@scure/base";
import type { RouteDescriptor, RouteQuoteRequest } from "../routing/types";

export type CctpTransferBinding = {
  expectedBurnToken: string;
  expectedMintRecipient: string;
  expectedAmount: string;
  expectedMessageSender: string;
};

export type ParsedCctpV2BurnMessage = CctpTransferBinding & {
  nonce: string;
  sourceDomain: number;
  destinationDomain: number;
};

const bytes32Pattern = /^0x[0-9a-f]{64}$/;

export function createCctpTransferBinding(route: RouteDescriptor, request: RouteQuoteRequest): CctpTransferBinding {
  const sourceChain = chainId(route.sourceAsset);
  const destinationChain = chainId(route.destinationAsset);
  if (request.sourceAsset !== route.sourceAsset || request.destinationAsset !== route.destinationAsset || !request.accountId.startsWith(`${sourceChain}:`) || request.amountInBaseUnits <= 0n) throw new Error("CCTP_TRANSFER_BINDING_INVALID");
  const sourceAccount = request.accountId.slice(sourceChain.length + 1);
  return {
    expectedBurnToken: addressToBytes32(sourceChain, assetReference(route.sourceAsset)),
    expectedMintRecipient: addressToBytes32(destinationChain, request.recipient),
    expectedAmount: request.amountInBaseUnits.toString(),
    expectedMessageSender: addressToBytes32(sourceChain, sourceAccount)
  };
}

export function assertCctpTransferBinding(value: unknown): asserts value is CctpTransferBinding {
  if (!isPlainObject(value) || !exactKeys(value, ["expectedBurnToken", "expectedMintRecipient", "expectedAmount", "expectedMessageSender"])) throw new Error("CCTP_TRANSFER_BINDING_INVALID");
  if (![value.expectedBurnToken, value.expectedMintRecipient, value.expectedMessageSender].every((item) => typeof item === "string" && bytes32Pattern.test(item)) || typeof value.expectedAmount !== "string" || !/^[1-9]\d{0,79}$/.test(value.expectedAmount)) throw new Error("CCTP_TRANSFER_BINDING_INVALID");
}

export function parseCctpV2BurnMessage(message: unknown): ParsedCctpV2BurnMessage {
  if (typeof message !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(message)) throw new Error("CCTP_FINALITY_MESSAGE_INVALID");
  const bytes = hexBytes(message);
  const messageBodyOffset = 148;
  const minimumBurnBodyLength = 228;
  if (bytes.length < messageBodyOffset + minimumBurnBodyLength || readUint32(bytes, 0) !== 1 || readUint32(bytes, messageBodyOffset) !== 1) throw new Error("CCTP_FINALITY_MESSAGE_INVALID");
  return {
    nonce: bytes32(bytes, 12),
    sourceDomain: readUint32(bytes, 4),
    destinationDomain: readUint32(bytes, 8),
    expectedBurnToken: bytes32(bytes, messageBodyOffset + 4),
    expectedMintRecipient: bytes32(bytes, messageBodyOffset + 36),
    expectedAmount: uint256(bytes, messageBodyOffset + 68).toString(),
    expectedMessageSender: bytes32(bytes, messageBodyOffset + 100)
  };
}

export function cctpMessageMatchesBinding(message: ParsedCctpV2BurnMessage, sourceDomain: number, destinationDomain: number, binding: CctpTransferBinding): boolean {
  assertCctpTransferBinding(binding);
  return message.sourceDomain === sourceDomain
    && message.destinationDomain === destinationDomain
    && message.expectedBurnToken === binding.expectedBurnToken
    && message.expectedMintRecipient === binding.expectedMintRecipient
    && message.expectedAmount === binding.expectedAmount
    && message.expectedMessageSender === binding.expectedMessageSender;
}

function chainId(asset: string): string {
  const separator = asset.indexOf("/");
  if (separator <= 0) throw new Error("CCTP_TRANSFER_BINDING_INVALID");
  return asset.slice(0, separator);
}

function assetReference(asset: string): string {
  const separator = asset.indexOf("/");
  const identity = asset.slice(separator + 1);
  const referenceSeparator = identity.indexOf(":");
  if (separator <= 0 || referenceSeparator <= 0 || referenceSeparator === identity.length - 1) throw new Error("CCTP_TRANSFER_BINDING_INVALID");
  return identity.slice(referenceSeparator + 1);
}

function addressToBytes32(chain: string, address: string): string {
  if (chain.startsWith("eip155:")) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("CCTP_TRANSFER_BINDING_INVALID");
    return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  }
  if (chain.startsWith("solana:")) {
    let decoded: Uint8Array;
    try { decoded = base58.decode(address); } catch { throw new Error("CCTP_TRANSFER_BINDING_INVALID"); }
    if (decoded.length !== 32) throw new Error("CCTP_TRANSFER_BINDING_INVALID");
    return `0x${hex(decoded)}`;
  }
  throw new Error("CCTP_TRANSFER_BINDING_INVALID");
}

function hexBytes(value: string): Uint8Array {
  const output = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return output;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function uint256(bytes: Uint8Array, offset: number): bigint {
  return BigInt(`0x${hex(bytes.slice(offset, offset + 32))}`);
}

function bytes32(bytes: Uint8Array, offset: number): string {
  return `0x${hex(bytes.slice(offset, offset + 32))}`;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
