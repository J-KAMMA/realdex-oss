import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { ROUTE_DESCRIPTORS } from "../routing/registry";
import type { RouteQuoteRequest } from "../routing/types";
import { createCctpTransferBinding } from "./cctp-message";

describe("CCTP transfer binding", () => {
  it("encodes EVM token, sender, and destination identities as exact bytes32 values", () => {
    const route = routeById("cctp-v2-base-sepolia-arbitrum-sepolia-usdc");
    const request = requestFor(route, "eip155:84532:0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222");
    expect(createCctpTransferBinding(route, request)).toEqual({
      expectedBurnToken: `0x${"0".repeat(24)}036cbd53842c5426634e7929541ec2318f3dcf7e`,
      expectedMintRecipient: `0x${"0".repeat(24)}${"2".repeat(40)}`,
      expectedAmount: "10000000",
      expectedMessageSender: `0x${"0".repeat(24)}${"1".repeat(40)}`
    });
  });

  it("binds Solana public keys without truncation or EVM padding", () => {
    const source = base58.encode(new Uint8Array(32).fill(3));
    const destination = base58.encode(new Uint8Array(32).fill(4));
    const route = routeById("cctp-v2-solana-devnet-base-sepolia-usdc");
    const request = requestFor(route, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${source}`, "0x2222222222222222222222222222222222222222");
    expect(createCctpTransferBinding(route, request).expectedMessageSender).toBe(`0x${"03".repeat(32)}`);
    const reverse = routeById("cctp-v2-base-sepolia-solana-devnet-usdc");
    expect(createCctpTransferBinding(reverse, requestFor(reverse, "eip155:84532:0x1111111111111111111111111111111111111111", destination)).expectedMintRecipient).toBe(`0x${"04".repeat(32)}`);
  });
});

function routeById(id: string) {
  const route = ROUTE_DESCRIPTORS.find((candidate) => candidate.id === id);
  if (!route) throw new Error("missing route");
  return route;
}

function requestFor(route: ReturnType<typeof routeById>, accountId: string, recipient: string): RouteQuoteRequest {
  return {
    executionIntentId: "realdex-intent:v1:00000000-0000-4000-8000-000000000099",
    sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset, amountInBaseUnits: 10_000_000n,
    accountId, recipient, walletCapabilityId: route.walletCapabilityIds[0], sessionRevision: 1,
    walletGrant: createProviderBindingGrant({ transportId: "test:cctp", accountId, walletCapabilityId: route.walletCapabilityIds[0], sessionRevision: 1, expiresAt: Date.now() + 60_000 }), slippageBps: 0
  };
}
