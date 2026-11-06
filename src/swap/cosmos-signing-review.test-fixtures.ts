import type { ComponentProps } from "react";
import type CosmosSigningReviewPanel from "./CosmosSigningReviewPanel";
import type { CosmosInjectedSigningPreparation } from "./cosmos-injected-signing-preparation";

/** UI-only synthetic values. These objects are NOT genuine execution capabilities. */
export function cosmosSigningReviewFixture(now = Date.now()) {
  const authority = `osmo1${"q".repeat(38)}`;
  const fingerprint = `0x${"1".repeat(64)}`, hash = "a".repeat(64);
  const preparation: CosmosInjectedSigningPreparation = Object.freeze({
    schema: "realdex.cosmos-injected-signing-preparation.v1", preparationId: fingerprint,
    preparedAt: now, expiresAt: now + 60_000, walletId: "synthetic-ui", sessionId: fingerprint,
    accountId: `cosmos:osmo-test-5:${authority}`, authority, chainId: "cosmos:osmo-test-5",
    walletChainId: "osmo-test-5", publicKeyHex: `02${hash}`, hardware: "none", venueId: "synthetic-osmosis-route",
    executionTarget: "osmosis:gamm:12", recipient: authority,
    sourceDenom: "uosmo", destinationDenom: `ibc/${"A".repeat(64)}`,
    amountInBaseUnits: "18446744073709551615", expectedOutBaseUnits: "11000000000000000000", minimumOutBaseUnits: "10000000000000000000",
    accountNumber: "11", sequence: "7", feeDenom: "uosmo", feeAmountBaseUnits: "2500", gasLimit: "250000", timeoutHeight: "1200", gasUsed: "170000",
    transactionBase64: "AA==", transactionSha256: hash, signDocSha256: hash, intentSha256: hash,
    sourceFingerprint: fingerprint, routeFingerprint: fingerprint, manifestPayloadHash: hash,
    readPolicySourceFingerprint: fingerprint, readPolicyPayloadHash: hash,
    requiresFreshVerification: true, signingEnabled: false, broadcastEnabled: false, executionEnabled: false
  });
  const props = {
    connection: {}, provider: {}, binding: { chainId: preparation.chainId, address: authority },
    intent: { chainId: preparation.chainId, authority, sequence: preparation.sequence }, verified: {},
    route: { schema: "realdex.osmosis-exact-in-route.v1", venueId: preparation.venueId, revision: 1, chainId: preparation.chainId, bech32Prefix: "osmo",
      sourceDenom: preparation.sourceDenom, destinationDenom: preparation.destinationDenom,
      hops: [{ poolId: "12", tokenOutDenom: preparation.destinationDenom }], evidenceUrls: ["https://example.org/synthetic-ui", "https://example.net/synthetic-review"] }
  } as unknown as ComponentProps<typeof CosmosSigningReviewPanel>;
  return { preparation, props };
}
