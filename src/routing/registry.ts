import type { RouteDescriptor } from "./types";

const BASE_USDC = "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARBITRUM_USDC = "eip155:421614/erc20:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const SOLANA_USDC = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NOBLE_USDC = "cosmos:grand-1/denom:uusdc";
const OSMOSIS_USDC = "cosmos:osmo-test-5/ibc:DE6792CF9E521F6AD6E9A4BDF6225C9571A3B74ACC0A529F92BC5122A39D2E58";

const CCTP_EVIDENCE = [
  "https://developers.circle.com/cctp/concepts/supported-chains-and-domains",
  "https://developers.circle.com/cctp/references/contract-addresses"
];
const IBC_EVIDENCE = [
  "https://github.com/cosmos/chain-registry/blob/master/testnets/_IBC/nobletestnet-osmosistestnet.json",
  "https://github.com/cosmos/ibc/blob/main/spec/app/ics-020-fungible-token-transfer/README.md"
];

function bridge(id: string, adapterId: string, sourceAsset: string, destinationAsset: string, walletCapabilityIds: string[], sourceExecutionTarget: string, executionMethod: string, trustBoundary: string, finalityTracking: RouteDescriptor["finalityTracking"], evidenceUrls: string[]): RouteDescriptor {
  return { id, revision: 1, operation: "bridge", adapterId, sourceAsset, destinationAsset, state: "ready", walletCapabilityIds, sourceExecutionTarget, executionMethod, maximumQuoteTtlMs: 2 * 60_000, finalityTracking, trustBoundary, evidenceUrls };
}

export const ROUTE_DESCRIPTORS: RouteDescriptor[] = [
  bridge("cctp-v2-base-sepolia-solana-devnet-usdc", "cctp-v2", BASE_USDC, SOLANA_USDC, ["eip1193"], "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", "BridgeKit.bridge", "Circle issuer attestation and Forwarding Service", "partial", CCTP_EVIDENCE),
  bridge("cctp-v2-solana-devnet-base-sepolia-usdc", "cctp-v2", SOLANA_USDC, BASE_USDC, ["solana-wallet-standard"], "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", "BridgeKit.bridge", "Circle issuer attestation and Forwarding Service", "partial", CCTP_EVIDENCE),
  bridge("cctp-v2-base-sepolia-arbitrum-sepolia-usdc", "cctp-v2", BASE_USDC, ARBITRUM_USDC, ["eip1193"], "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", "BridgeKit.bridge", "Circle issuer attestation and Forwarding Service", "partial", CCTP_EVIDENCE),
  bridge("cctp-v2-arbitrum-sepolia-base-sepolia-usdc", "cctp-v2", ARBITRUM_USDC, BASE_USDC, ["eip1193"], "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", "BridgeKit.bridge", "Circle issuer attestation and Forwarding Service", "partial", CCTP_EVIDENCE),
  bridge("ibc-grand-1-osmo-test-5-usdc", "ibc-ics20", NOBLE_USDC, OSMOSIS_USDC, ["cosmos-injected"], "transfer/channel-22", "/ibc.applications.transfer.v1.MsgTransfer", "IBC light clients, relayers, and destination acknowledgement", "partial", IBC_EVIDENCE),
  bridge("ibc-osmo-test-5-grand-1-usdc", "ibc-ics20", OSMOSIS_USDC, NOBLE_USDC, ["cosmos-injected"], "transfer/channel-4280", "/ibc.applications.transfer.v1.MsgTransfer", "IBC light clients, relayers, and destination acknowledgement", "partial", IBC_EVIDENCE)
];
