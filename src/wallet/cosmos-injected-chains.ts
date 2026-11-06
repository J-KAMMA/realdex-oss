import type { CosmosInjectedChainProfile } from "./cosmos-injected-session";

export type CosmosInjectedChainOption = Readonly<{
  label: string;
  profile: CosmosInjectedChainProfile;
}>;

export const COSMOS_INJECTED_CHAINS: Readonly<Record<string, CosmosInjectedChainOption>> = Object.freeze({
  "cosmos:grand-1": Object.freeze({
    label: "Noble Testnet",
    profile: Object.freeze({
      schema: "realdex.cosmos-injected-chain-profile.v1",
      chainId: "cosmos:grand-1",
      walletChainId: "grand-1",
      bech32Prefix: "noble"
    })
  }),
  "cosmos:osmo-test-5": Object.freeze({
    label: "Osmosis Testnet",
    profile: Object.freeze({
      schema: "realdex.cosmos-injected-chain-profile.v1",
      chainId: "cosmos:osmo-test-5",
      walletChainId: "osmo-test-5",
      bech32Prefix: "osmo"
    })
  })
});
