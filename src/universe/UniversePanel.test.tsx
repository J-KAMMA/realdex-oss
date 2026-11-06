/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Interface, Wallet, keccak256 } from "ethers";
import { ed25519 } from "@noble/curves/ed25519";
import { Secp256k1, ripemd160, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { base58, base64 } from "@scure/base";
import { AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getTransactionDecoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import codeIdentities from "../swap/local-amm-code-identities.json";

vi.mock("../release/evm-public-testnet", async () => {
  const actual = await vi.importActual<typeof import("../release/evm-public-testnet")>("../release/evm-public-testnet");
  return {
    ...actual,
    verifyPublicTestnetDeployment: vi.fn(async (input: unknown, readers: readonly { id: string }[], now = Date.now()) => {
      const manifest = actual.validatePublicTestnetDeploymentManifest(input, now);
      return {
        status: "verified" as const,
        releaseId: manifest.releaseId,
        network: manifest.network.caip2,
        factoryAddress: manifest.contracts.factory.address,
        routerAddress: manifest.contracts.router.address,
        verifiedAt: now,
        observations: readers.map((reader) => ({ readerId: reader.id, chainId: 84532n, observedBlock: 120, factoryCodeHash: manifest.contracts.factory.runtimeCodeHash, routerCodeHash: manifest.contracts.router.runtimeCodeHash }))
      };
    })
  };
});

vi.mock("./non-evm-token-source", async () => {
  const actual = await vi.importActual<typeof import("./non-evm-token-source")>("./non-evm-token-source");
  return { ...actual, verifyUniversalAssetOnChain: vi.fn(actual.verifyUniversalAssetOnChain) };
});

import UniversePanel from "./UniversePanel";
import * as nonEvmTokenSource from "./non-evm-token-source";
import { canonicalSignedAssetManifestPayload } from "./token-source";
import type { OnChainAssetCheck } from "./token-source";
import { canonicalSignedExternalEvmV2VenueManifestPayload, externalEvmV2VenueSourceFingerprint, serializeExternalEvmV2VenueIdentity, type ExternalEvmV2VenueSourceDescriptor, type SignedExternalEvmV2VenueManifest } from "../swap/external-evm-v2-source";
import { EXTERNAL_EVM_V2_QUOTE_BOUNDARY_ID, EXTERNAL_EVM_V2_VERIFICATION_BOUNDARY_ID, canonicalSignedExternalEvmV2ReadPolicyPayload, externalEvmV2ReadPolicySourceFingerprint, type ExternalEvmV2ReadPolicySourceDescriptor, type SignedExternalEvmV2ReadPolicy } from "../swap/external-evm-v2-read-policy";
import { canonicalSignedSolanaVenueManifestPayload, solanaVenueSourceFingerprint, type SignedSolanaVenueManifest, type SolanaVenueSourceDescriptor } from "../swap/solana-venue-source";
import { canonicalSignedSolanaSplRouteManifestPayload, type SignedSolanaSplRouteManifest } from "../swap/solana-spl-route-source";
import { canonicalSignedSolanaReadPolicyPayload, solanaReadPolicySourceFingerprint, type SignedSolanaReadPolicy, type SolanaReadPolicySourceDescriptor } from "../swap/solana-read-policy";
import { SOLANA_SWAP_BOUNDARY_ID } from "../swap/solana-swap-boundary";
import { SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID } from "../swap/spl-token-swap-quote-boundary";
import { canonicalSignedOsmosisRouteManifestPayload, cosmosVenueSourceFingerprint, type CosmosVenueSourceDescriptor, type SignedOsmosisRouteManifest } from "../swap/cosmos-venue-source";
import { canonicalSignedCosmosReadPolicyPayload, cosmosReadPolicySourceFingerprint, type CosmosReadPolicySourceDescriptor, type SignedCosmosReadPolicy } from "../swap/cosmos-read-policy";
import { COSMOS_SWAP_BOUNDARY_ID, type CosmosSwapIntent } from "../swap/cosmos-swap-boundary";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; container?.remove(); container = undefined;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.mocked(nonEvmTokenSource.verifyUniversalAssetOnChain).mockReset();
  vi.mocked(nonEvmTokenSource.verifyUniversalAssetOnChain).mockImplementation(async (asset, readers) => {
    const actual = await vi.importActual<typeof import("./non-evm-token-source")>("./non-evm-token-source");
    return actual.verifyUniversalAssetOnChain(asset, readers);
  });
});

describe("Universal DEX public-testnet release view", () => {
  it("inspects Bitcoin wallet files locally without exposing identifiers or execution", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const walletsButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Wallets")!;
    await act(async () => { walletsButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(container.textContent).not.toMatch(/WalletConnect/i);
    expect(container.textContent).toContain("Bitcoin mainnet/testnet Base58Check and SegWit addresses are network-checked");
    expect(container.textContent).toContain("Inspect Bitcoin PSBT v0 intent JSON");
    expect(container.textContent).toContain("local page memory only");
    expect(container.textContent).toContain("Bitcoin UTXO + fee read quorum");
    expect(container.textContent).toContain("Verify wallet-returned signed Bitcoin PSBT");
    expect(container.textContent).toContain("no finalization or broadcast");
    expect(container.textContent).toContain("Verify externally finalized Bitcoin PSBT");
    expect(container.textContent).toContain("no transaction bytes or broadcast");
    expect(container.textContent).toContain("Pin Bitcoin read policy source");
    expect(container.textContent).toContain("Verify signed Bitcoin read policy");
    expect(container.textContent).toContain("A pinned publisher must sign both hosts");
    expect(container.textContent).toContain("GET only");
    expect(container.querySelector('input[aria-label="Bitcoin Esplora A"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Bitcoin Esplora B"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Bitcoin Esplora A"]')?.readOnly).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Bitcoin read policy"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("The default inspection policy is no longer sufficient by itself");
    const utxoButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify UTXOs + fee read-only")) as HTMLButtonElement;
    expect(utxoButton.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Bitcoin PSBT"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Verify finalized Bitcoin PSBT"]')?.disabled).toBe(true);
    const policySigner = new Wallet(`0x${"33".repeat(32)}`);
    const policySource = { schema: "realdex.bitcoin-read-policy-source.v1", id: "ui-bitcoin-read", name: "UI Bitcoin read policy", signerAddress: policySigner.address, allowedChainIds: ["bip122:000000000019d6689c085ae165831e93"], evidenceUrls: ["https://policy.example/evidence"] };
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin Bitcoin read policy source"]')!, policySource, "bitcoin-read-source.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("UI Bitcoin read policy"));
    const policyInput = container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Bitcoin read policy"]')!;
    expect(policyInput.disabled).toBe(false);
    await chooseJsonFile(policyInput, { schema: "untrusted" }, "invalid-bitcoin-read-policy.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Bitcoin read policy rejected: BITCOIN_READ_POLICY_INVALID"));
    const psbtInput = container.querySelector<HTMLInputElement>('input[aria-label="Inspect Bitcoin PSBT v0 intent JSON"]')!;
    expect(psbtInput).not.toBeNull();
    await chooseJsonFile(psbtInput, { schema: "untrusted" }, "invalid-psbt-intent.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Bitcoin PSBT intent rejected: BITCOIN_PSBT_INTENT_FIELDS_INVALID"));
    expect(container.textContent).toContain("This page cannot pair, connect, sign, send, or use a relay");
    expect([...container.querySelectorAll("button")].some((button) => /pair|connect|sign|send|broadcast/i.test(button.textContent ?? ""))).toBe(false);
  });

  it("shows two independent read-only endpoints per non-EVM family", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const tokensButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Tokens")!;
    await act(async () => { tokensButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(container.textContent).toContain("Optional non-EVM metadata quorum");
    expect(container.textContent).toContain("Both hosts must answer and agree");
    for (const label of ["Solana metadata RPC A", "Solana metadata RPC B", "Cosmos metadata REST A", "Cosmos metadata REST B"]) {
      expect(container.querySelector(`input[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(container.textContent).toContain("no wallet or signature");
  });

  it("discards a late metadata result after an endpoint changes", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const tokensButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Tokens")!;
    await act(async () => { tokensButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const signer = new Wallet(`0x${"11".repeat(32)}`);
    const source = { schema: "localswap.asset-source.v1", id: "late-result-source", name: "Late result source", signerAddress: signer.address, allowedChainIds: ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"], evidenceUrls: ["https://evidence.example.org/source"] } as const;
    const unsigned = {
      schema: "localswap.signed-asset-manifest.v1" as const, sourceId: source.id, revision: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      assets: [{ assetType: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", name: "Solana Devnet USDC", decimals: 6, provenance: "signed-list" as const, execution: "design-gate" as const }],
      evidenceUrls: ["https://evidence.example.org/manifest"]
    };
    const manifest = { ...unsigned, signature: await signer.signMessage(canonicalSignedAssetManifestPayload(unsigned)) };
    const fileInputs = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    await chooseJsonFile(fileInputs[1], source, "source.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Late result source"));

    const rpcA = container.querySelector<HTMLInputElement>('input[aria-label="Solana metadata RPC A"]')!;
    const rpcB = container.querySelector<HTMLInputElement>('input[aria-label="Solana metadata RPC B"]')!;
    await act(async () => { setInputValue(rpcA, "https://solana-a.example.org"); setInputValue(rpcB, "https://solana-b.example.org"); });

    let resolveCheck!: (check: OnChainAssetCheck) => void;
    vi.mocked(nonEvmTokenSource.verifyUniversalAssetOnChain).mockImplementationOnce(() => new Promise((resolve) => { resolveCheck = resolve; }));
    await chooseJsonFile(fileInputs[2], manifest, "manifest.json");
    await vi.waitFor(() => expect(nonEvmTokenSource.verifyUniversalAssetOnChain).toHaveBeenCalledTimes(1));
    await act(async () => { setInputValue(rpcA, "https://solana-c.example.org"); });
    await act(async () => { resolveCheck({ assetType: unsigned.assets[0].assetType, status: "partial", message: "stale", observed: { decimals: 6 } }); await Promise.resolve(); });

    expect(container.textContent).not.toContain("Signature verified");
    expect(container.textContent).not.toContain("On-chain · partial");
    expect(localStorage.length).toBe(0);
  });

  it("shows a read-only Base Sepolia evidence gate without exposing deployment execution", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const releaseButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Release")!;
    await act(async () => { releaseButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(container.textContent).toContain("Release evidence check is read-only");
    expect(container.textContent).toContain("Base Sepolia");
    expect(container.textContent).toContain("2 independent readers");
    expect(container.textContent).toContain("Environmentpublic-testnet");
    expect(container.textContent).not.toContain("Not allowed");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Deploy")).toBe(false);
  });

  it.each([["eip155:8453", "Base", "https://mainnet.base.org"], ["eip155:42161", "Arbitrum One", "https://arb1.arbitrum.io/rpc"]])("lets the user select %s and refuses it until contracts are configured", async (id, name, firstRpc) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const releaseButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Release")!;
    await act(async () => { releaseButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Network"]')!;
    expect([...select.options].map((option) => option.value)).toEqual(expect.arrayContaining(["eip155:84532", "eip155:8453", "eip155:421614", "eip155:42161"]));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, id);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain(name);
    expect(container.textContent).toContain("NETWORK_CONTRACTS_NOT_CONFIGURED");
    expect(container.textContent).toContain("Not configured");
    expect(container.textContent).toContain("Environmentmainnet");
    void firstRpc;
  });

  it("switches to Base when a user-deployed mainnet manifest is loaded and prefills editable public RPCs", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const releaseButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Release")!;
    await act(async () => { releaseButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const manifest = {
      schema: "realdex.evm-deployment.v1", releaseId: "base-user-deployment", environment: "mainnet",
      network: { caip2: "eip155:8453", name: "Base" },
      source: { bundleSha256: `sha256:${"c".repeat(64)}`, solidity: codeIdentities.solidity, optimizerRuns: codeIdentities.optimizerRuns, factoryRuntimeCodeHash: codeIdentities.factoryRuntimeCodeHash, routerRuntimeCodeHash: codeIdentities.routerRuntimeCodeHash },
      deployer: "0x3333333333333333333333333333333333333333",
      contracts: {
        factory: { address: "0x1111111111111111111111111111111111111111", deploymentTxHash: `0x${"a".repeat(64)}`, blockNumber: 100, runtimeCodeHash: codeIdentities.factoryRuntimeCodeHash },
        router: { address: "0x2222222222222222222222222222222222222222", deploymentTxHash: `0x${"b".repeat(64)}`, blockNumber: 101, runtimeCodeHash: codeIdentities.routerRuntimeCodeHash }
      },
      createdAt: Date.now(), evidenceUrls: ["https://evidence-a.example.org", "https://evidence-b.example.org"]
    };
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[type="file"]')!, manifest, "deployment-8453.json");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Network"]')!.value).toBe("eip155:8453");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Public RPC A"]')!.value).toBe("https://mainnet.base.org");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Public RPC B"]')!.value).toBe("https://base-rpc.publicnode.com");
    expect(container.textContent).toContain("0x1111111111111111111111111111111111111111");
    expect(container.textContent).not.toContain("NETWORK_CONTRACTS_NOT_CONFIGURED");
    expect(container.textContent).not.toContain("Deployment evidence rejected");
  });

  it("does not let the Executable badge stand alone for a route that still needs a release", async () => {
    // The badge reports the descriptor's execution state. Every route in the
    // registry is a bridge route, and each one needs a second, separate release
    // before a signature can be requested — which the badge's own wording
    // ("can request a signature") would otherwise deny.
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const routesButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Routes")!;
    await act(async () => { routesButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(container.textContent).toContain("Every bridge route below carries a second gate");
    expect(container.textContent).toContain("none of these routes can be signed as the screen stands");
    // Every route says which release it is waiting for, not just the badge.
    const rows = [...container.querySelectorAll(".route-item")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.textContent).toMatch(/Signed CCTP asset release required|Pinned signed route source required/);
    }
  });

  it("shows the external EVM V2 verifier as installed but keeps venues disabled", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const routesButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Routes")!;
    await act(async () => { routesButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).toContain("External EVM V2 safety boundary installed · no public venue enabled");
    expect(container.textContent).toContain("swapExactTokensForTokens calldata");
    expect(container.textContent).toContain("reviewed deployment identity and execution transport are still required");
    expect(container.textContent).toContain("Signed External EVM V2 venue source gate installed · no source pinned");
    expect(container.textContent).toContain("exact source fingerprint, signer, revision, expiry, chain scope");
    expect(container.textContent).toContain("success never enables execution");
    expect(container.textContent).toContain("External EVM V2 recovery journal installed · execution still disabled");
    expect(container.textContent).toContain("exact-size approval and swap envelope");
    expect(container.textContent).toContain("matching receipt, nonce, and head evidence from two independent RPC hosts");
    expect(container.textContent).toContain("replacement-unresolved and cannot authorize retrying");
    expect(container.textContent).toContain("Solana swap simulation boundary installed · no venue enabled");
    expect(container.textContent).toContain("matching simulations from two independent RPC hosts");
    expect(container.textContent).toContain("It cannot request a wallet signature");
    expect(container.textContent).toContain("Signed Solana venue source gate installed · no source pinned");
    expect(container.textContent).toContain("Ed25519 publisher");
    expect(container.textContent).toContain("success never enables submission");
    expect(container.textContent).toContain("SPL Token Swap exact-input decoder installed · no pool enabled");
    expect(container.textContent).toContain("exact pool state and authority");
    expect(container.textContent).toContain("optional host fee");
    expect(container.textContent).toContain("Solana swap recovery journal installed · submission still disabled");
    expect(container.textContent).toContain("exact simulated message");
    expect(container.textContent).toContain("Missing evidence after blockhash expiry remains unresolved");
    expect(container.textContent).toContain("Cosmos swap transaction boundary installed · no venue enabled");
    expect(container.textContent).toContain("one canonical DIRECT-sign message");
    expect(container.textContent).toContain("matching debit, credit, and gas simulations from two independent REST hosts");
    expect(container.textContent).toContain("Signed Cosmos/Osmosis route source gate installed · no source pinned");
    expect(container.textContent).toContain("secp256k1 publisher");
    expect(container.textContent).toContain("source-bound TxRaw decoder and two independent REST simulations");
    expect(container.textContent).toContain("Osmosis exact-input decoder installed · no pool enabled");
    expect(container.textContent).toContain("1–4 exact pool IDs");
    expect(container.textContent).toContain("Split routes, substituted or cyclic paths");
    expect(container.textContent).toContain("Cosmos swap recovery journal installed · broadcast still disabled");
    expect(container.textContent).toContain("64-byte low-S secp256k1 signature");
    expect(container.textContent).toContain("Missing history after timeout remains unresolved");
    expect(container.textContent).toContain("Session-pin an External V2 venue source");
    expect(container.textContent).toContain("Policy-bound External V2 exact-input quote preview");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Inspect External V2 quote intent"]')?.disabled).toBe(true);
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify policy-bound quote"))?.disabled).toBe(true);
    expect(container.textContent).toContain("Session-pin a Solana venue source");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Solana venue manifest"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("Session-pin a Cosmos venue source");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Osmosis route manifest"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("A valid source signature, matching code, and two-reader quote are a short-lived preview—not permission to trade");
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("accepts an Ed25519 source-bound Solana venue identity without enabling submission", async () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const solanaKey = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256));
    const chainId = `solana:${solanaKey(1).slice(0, 32)}`;
    const source: SolanaVenueSourceDescriptor = {
      schema: "realdex.solana-venue-source.v1", id: "ui.solana.venues", name: "UI reviewed Solana source",
      signerPublicKey: base58.encode(ed25519.getPublicKey(privateKey)), allowedChainIds: [chainId], evidenceUrls: ["https://source.example.org/solana-policy"]
    };
    const unsigned: Omit<SignedSolanaVenueManifest, "signature"> = {
      schema: "realdex.signed-solana-venues.v1", sourceId: source.id, sourceFingerprint: await solanaVenueSourceFingerprint(source), revision: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      venues: [{ schema: "realdex.solana-venue.v1", venueId: "ui-solana-pool", revision: 1, chainId,
        programAddress: solanaKey(2), programOwner: "BPFLoaderUpgradeab1e11111111111111111111111", programDataAddress: solanaKey(3), programDataSha256: "11".repeat(32),
        tokenProgramAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executionTarget: solanaKey(4), evidenceUrls: ["https://source.example.org/program", "https://explorer.example.net/program"] }],
      evidenceUrls: ["https://source.example.org/solana-revision-1"]
    };
    const signed = { ...unsigned, signature: base58.encode(ed25519.sign(new TextEncoder().encode(canonicalSignedSolanaVenueManifestPayload(unsigned)), privateKey)) };

    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    await act(async () => { [...container!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Routes")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const sourceInput = container.querySelector<HTMLInputElement>('input[aria-label="Pin Solana venue source"]')!;
    const manifestInput = container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Solana venue manifest"]')!;
    expect(manifestInput.disabled).toBe(true);
    await chooseJsonFile(sourceInput, source, "solana-source.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("UI reviewed Solana source"));
    expect(manifestInput.disabled).toBe(false);
    await chooseJsonFile(manifestInput, signed, "solana-venues.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Signed Solana venue identities accepted · submission still blocked"));
    expect(container.textContent).toContain("1 identity record · revision 1");
    expect([...container.querySelectorAll("button")].some((button) => /\b(sign|submit|swap|execute)\b/i.test(button.textContent ?? ""))).toBe(false);
  });

  it("runs a signed SPL route only through policy-bound Solana quote and simulation readers", async () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const solanaKey = (seed: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 3) % 256));
    const genesis = solanaKey(1), program = solanaKey(2), loader = solanaKey(3), programData = solanaKey(4), swapState = solanaKey(5), swapAuthority = "4KcPqwnbZXJ8Bqg9twqjrbSn6NZs7KpoJzenXTHejCaJ";
    const poolSource = solanaKey(7), poolDestination = solanaKey(8), poolMint = solanaKey(9), poolFee = solanaKey(10), sourceMint = solanaKey(11), destinationMint = solanaKey(12);
    const authority = solanaKey(13), sourceAccount = solanaKey(14), destinationAccount = solanaKey(15), destinationOwner = solanaKey(16), recentBlockhash = solanaKey(18);
    const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", chainId = `solana:${genesis.slice(0, 32)}` as const;
    const programDataBytes = Uint8Array.from([9, 8, 7, 6]);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", programDataBytes));
    const source: SolanaVenueSourceDescriptor = {
      schema: "realdex.solana-venue-source.v1", id: "ui.solana.spl-routes", name: "UI reviewed SPL routes",
      signerPublicKey: base58.encode(ed25519.getPublicKey(privateKey)), allowedChainIds: [chainId], evidenceUrls: ["https://source.example.org/solana-spl-policy"]
    };
    const unsigned: Omit<SignedSolanaSplRouteManifest, "signature"> = {
      schema: "realdex.signed-solana-spl-routes.v1", sourceId: source.id, sourceFingerprint: await solanaVenueSourceFingerprint(source), revision: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      routes: [{ schema: "realdex.spl-token-swap-exact-in-route.v1", venueId: "ui-spl-token-swap", revision: 1, chainId,
        programAddress: program, programOwner: loader, programDataAddress: programData, programDataSha256: uiHex(digest), tokenProgramAddress: tokenProgram,
        swapState, swapAuthority, poolSourceTokenAccount: poolSource, poolDestinationTokenAccount: poolDestination, poolMint, poolFeeAccount: poolFee,
        sourceMint, destinationMint, hostFeeAccount: null,
        evidenceUrls: ["https://source.example.org/spl-program", "https://explorer.example.net/spl-pool"] }],
      evidenceUrls: ["https://source.example.org/solana-spl-revision-1"]
    };
    const signed: SignedSolanaSplRouteManifest = { ...unsigned, signature: base58.encode(ed25519.sign(new TextEncoder().encode(canonicalSignedSolanaSplRouteManifestPayload(unsigned)), privateKey)) };
    const transaction = uiSolanaSwapWire({ authority, recentBlockhash, program, swapState, swapAuthority, sourceAccount, poolSource, poolDestination, destinationAccount, poolMint, poolFee, sourceMint, destinationMint, tokenProgram });
    const intent = {
      schema: "realdex.solana-swap-intent.v1", venueId: unsigned.routes[0].venueId, venueRevision: 1, chainId, authority, sourceMint, destinationMint,
      sourceTokenAccount: sourceAccount, destinationTokenAccount: destinationAccount, destinationTokenOwner: destinationOwner, tokenProgramAddress: tokenProgram,
      executionTarget: swapState, amountInBaseUnits: "1000", expectedOutBaseUnits: "900", minimumOutBaseUnits: "890", slippageBps: 111, quoteExpiresAt: Date.now() + 60_000,
      lastValidBlockHeight: 200, transactionBase64: transaction.base64
    };

    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    await act(async () => { [...container!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Routes")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const routeManifestInput = container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Solana SPL route manifest"]')!;
    expect(routeManifestInput.disabled).toBe(true);
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin Solana venue source"]')!, source, "solana-spl-source.json");
    await vi.waitFor(() => expect(routeManifestInput.disabled).toBe(false));
    await chooseJsonFile(routeManifestInput, signed, "solana-spl-routes.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Signed SPL Token Swap routes accepted · submission still blocked"));
    expect(container.textContent).toContain("Policy-bound Solana quote + unsigned transaction simulation quorum");
    expect(container.textContent).toContain("never calls sendTransaction");
    const simulationButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify policy-bound quote + simulations")) as HTMLButtonElement;
    expect(simulationButton.disabled).toBe(true);

    const readPolicyPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 91);
    const readPolicySource: SolanaReadPolicySourceDescriptor = {
      schema: "realdex.solana-read-policy-source.v1", id: "ui.solana.read-policy", name: "UI independent Solana read policy",
      signerPublicKey: base58.encode(ed25519.getPublicKey(readPolicyPrivateKey)), allowedChainIds: [chainId], evidenceUrls: ["https://policy.example.org/solana/read-source"]
    };
    const unsignedReadPolicy: Omit<SignedSolanaReadPolicy, "signature"> = {
      schema: "realdex.signed-solana-read-policy.v1", sourceId: readPolicySource.id, sourceFingerprint: await solanaReadPolicySourceFingerprint(readPolicySource), revision: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), chainId,
      rpcEndpoints: ["https://solana-a.example.org", "https://solana-b.example.net"], quoteBoundaryId: SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID,
      simulationBoundaryId: SOLANA_SWAP_BOUNDARY_ID, evidenceUrls: ["https://policy.example.org/solana/read-policy"]
    };
    const signedReadPolicy: SignedSolanaReadPolicy = { ...unsignedReadPolicy, signature: base58.encode(ed25519.sign(new TextEncoder().encode(canonicalSignedSolanaReadPolicyPayload(unsignedReadPolicy)), readPolicyPrivateKey)) };
    const readPolicyInput = container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Solana read policy"]')!;
    expect(readPolicyInput.disabled).toBe(true);
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin Solana read policy source"]')!, readPolicySource, "solana-read-policy-source.json");
    await vi.waitFor(() => expect(readPolicyInput.disabled).toBe(false));
    await chooseJsonFile(readPolicyInput, signedReadPolicy, "solana-read-policy.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Signed Solana read policy accepted · execution still blocked"));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Policy-bound Solana RPC A"]')?.readOnly).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Policy-bound Solana RPC A"]')?.value).toBe("https://solana-a.example.org/");

    const pointer = new Uint8Array(36); new DataView(pointer.buffer).setUint32(0, 2, true); pointer.set(base58.decode(programData), 4);
    const quoteState = uiSolanaSwapState({ tokenProgram, poolSource, poolDestination, poolMint, sourceMint, destinationMint, poolFee });
    const sourceVault = uiSolanaTokenAccount(sourceMint, swapAuthority, 9_000n), destinationVault = uiSolanaTokenAccount(destinationMint, swapAuthority, 9_000n);
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const request = JSON.parse(String(init?.body)) as { jsonrpc: string; id: number; method: string; params: unknown[] };
      let result: unknown;
      if (request.method === "getGenesisHash") result = genesis;
      else if (request.method === "getSlot") result = 1_000;
      else if (request.method === "getBlockHeight") result = 150;
      else if (request.method === "isBlockhashValid") result = { context: { slot: 999 }, value: true };
      else if (request.method === "getMultipleAccounts") result = { context: { slot: 1_000 }, value: [
        { owner: program, executable: false, data: [base64.encode(quoteState), "base64"] },
        { owner: tokenProgram, executable: false, data: [base64.encode(sourceVault), "base64"] },
        { owner: tokenProgram, executable: false, data: [base64.encode(destinationVault), "base64"] }
      ] };
      else if (request.method === "getAccountInfo") {
        const requestedAddress = request.params[0];
        result = { context: { slot: 999 }, value: requestedAddress === program
          ? { owner: loader, executable: true, data: [base64.encode(pointer), "base64"] }
          : requestedAddress === programData ? { owner: loader, executable: false, data: [base64.encode(programDataBytes), "base64"] } : null };
      } else if (request.method === "simulateTransaction") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        result = { context: { slot: 1_000 }, value: {
          err: null, unitsConsumed: 120_000, fee: 5_000,
          preTokenBalances: [uiTokenBalance(transaction.sourceIndex, sourceMint, authority, "5000"), uiTokenBalance(transaction.destinationIndex, destinationMint, destinationOwner, "100")],
          postTokenBalances: [uiTokenBalance(transaction.sourceIndex, sourceMint, authority, "4000"), uiTokenBalance(transaction.destinationIndex, destinationMint, destinationOwner, "1000")]
        } };
      }
      else throw new Error(`unexpected Solana method ${request.method}`);
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
    });
    vi.stubGlobal("fetch", fetchMock);
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Inspect unsigned Solana swap intent"]')!, intent, "solana-swap-intent.json");
    expect(simulationButton.disabled).toBe(false);
    await act(async () => {
      simulationButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(18));
    });
    await waitForUiState(() => expect(container?.textContent).toContain("Source-bound Solana quote + simulation verified · signing and submission still blocked"));
    expect(container.textContent).toContain("Source-bound Solana quote + simulation verified · signing and submission still blocked");
    expect(container.textContent).toContain("2 quote readers and 2 simulation readers agreed");
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method)).not.toContain("sendTransaction");
    expect([...container.querySelectorAll("button")].some((button) => /\b(sign|submit|swap|execute|broadcast)\b/i.test(button.textContent ?? ""))).toBe(false);
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin Solana read policy source"]')!, { ...readPolicySource, id: "ui.solana.read-policy-replaced" }, "replaced-read-policy-source.json");
    await vi.waitFor(() => expect(container?.textContent).not.toContain("Source-bound Solana quote + simulation verified"));
    expect(simulationButton.disabled).toBe(true);
  });

  it("accepts a secp256k1 source-bound Osmosis route without enabling broadcast", async () => {
    const privateKey = new Uint8Array(32).fill(7);
    const readPolicyPrivateKey = new Uint8Array(32).fill(8);
    const source: CosmosVenueSourceDescriptor = {
      schema: "realdex.cosmos-venue-source.v1", id: "ui.cosmos.routes", name: "UI reviewed Cosmos source",
      signerPublicKeyBase64: base64.encode(Secp256k1.compressPubkey(Secp256k1.makeKeypair(privateKey).pubkey)),
      allowedChainIds: ["cosmos:osmo-test-5"], evidenceUrls: ["https://source.example.org/cosmos-policy"]
    };
    const unsigned: Omit<SignedOsmosisRouteManifest, "signatureBase64"> = {
      schema: "realdex.signed-osmosis-routes.v1", sourceId: source.id, sourceFingerprint: cosmosVenueSourceFingerprint(source), revision: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      routes: [{ schema: "realdex.osmosis-exact-in-route.v1", venueId: "ui-osmosis-route", revision: 1, chainId: "cosmos:osmo-test-5",
        bech32Prefix: "osmo", sourceDenom: "uosmo", destinationDenom: `ibc/${"A".repeat(64)}`,
        hops: [{ poolId: "12", tokenOutDenom: `ibc/${"A".repeat(64)}` }],
        evidenceUrls: ["https://source.example.org/pool/12", "https://explorer.example.net/pool/12"] }],
      evidenceUrls: ["https://source.example.org/cosmos-revision-1"]
    };
    const payload = new TextEncoder().encode(canonicalSignedOsmosisRouteManifestPayload(unsigned));
    const signature = Secp256k1.trimRecoveryByte(Secp256k1.createSignature(sha256(payload), privateKey).toFixedLength());
    const signed: SignedOsmosisRouteManifest = { ...unsigned, signatureBase64: base64.encode(signature) };
    const readPolicySource: CosmosReadPolicySourceDescriptor = {
      schema: "realdex.cosmos-read-policy-source.v1", id: "ui.cosmos.read-policy", name: "UI reviewed Cosmos read policy",
      signerPublicKeyBase64: base64.encode(Secp256k1.compressPubkey(Secp256k1.makeKeypair(readPolicyPrivateKey).pubkey)),
      allowedChainIds: ["cosmos:osmo-test-5"], evidenceUrls: ["https://source.example.org/cosmos-read-policy"]
    };
    const unsignedReadPolicy: Omit<SignedCosmosReadPolicy, "signatureBase64"> = {
      schema: "realdex.signed-cosmos-read-policy.v1", sourceId: readPolicySource.id, sourceFingerprint: cosmosReadPolicySourceFingerprint(readPolicySource), revision: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), chainId: "cosmos:osmo-test-5",
      restEndpoints: ["https://cosmos-a.example.org/api/", "https://cosmos-b.example.net/api/"], simulationBoundaryId: COSMOS_SWAP_BOUNDARY_ID,
      evidenceUrls: ["https://source.example.org/cosmos-read-policy/revision-1"]
    };
    const readPolicyPayload = new TextEncoder().encode(canonicalSignedCosmosReadPolicyPayload(unsignedReadPolicy));
    const readPolicySignature = Secp256k1.trimRecoveryByte(Secp256k1.createSignature(sha256(readPolicyPayload), readPolicyPrivateKey).toFixedLength());
    const signedReadPolicy: SignedCosmosReadPolicy = { ...unsignedReadPolicy, signatureBase64: base64.encode(readPolicySignature) };

    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    await act(async () => { [...container!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Routes")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const sourceInput = container.querySelector<HTMLInputElement>('input[aria-label="Pin Cosmos venue source"]')!;
    const manifestInput = container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Osmosis route manifest"]')!;
    expect(manifestInput.disabled).toBe(true);
    await chooseJsonFile(sourceInput, source, "cosmos-source.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("UI reviewed Cosmos source"));
    expect(manifestInput.disabled).toBe(false);
    await chooseJsonFile(manifestInput, signed, "osmosis-routes.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Signed Osmosis routes accepted · broadcast still blocked"));
    expect(container.textContent).toContain("1 route record · revision 1");
    expect(container.textContent).toContain("not a Cosmos wallet or transaction authorization");
    const readPolicyInput = container.querySelector<HTMLInputElement>('input[aria-label="Verify signed Cosmos read policy"]')!;
    expect(readPolicyInput.disabled).toBe(true);
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin Cosmos read policy source"]')!, readPolicySource, "cosmos-read-policy-source.json");
    expect(readPolicyInput.disabled).toBe(false);
    await chooseJsonFile(readPolicyInput, signedReadPolicy, "cosmos-read-policy.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Signed Cosmos read policy accepted · execution still blocked"));
    expect(container.textContent).toContain("Policy-bound Cosmos TxRaw simulation quorum");
    expect(container.textContent).toContain("only to the two hosts authenticated by the signed read policy");
    const restA = container.querySelector<HTMLInputElement>('input[aria-label="Cosmos simulation REST A"]')!;
    const restB = container.querySelector<HTMLInputElement>('input[aria-label="Cosmos simulation REST B"]')!;
    expect(restA.readOnly).toBe(true); expect(restB.readOnly).toBe(true);
    expect(restA.value).toBe("https://cosmos-a.example.org/api/");
    const simulationButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify policy-bound TxRaw simulations")) as HTMLButtonElement;
    expect(simulationButton.disabled).toBe(true);

    const accountPublicKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(new Uint8Array(32).fill(9)).pubkey);
    const authority = toBech32("osmo", ripemd160(sha256(accountPublicKey)));
    const intent = uiOsmosisIntent(authority, accountPublicKey, unsigned.routes[0].destinationDenom);
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith("node_info")) return jsonResponse({ default_node_info: { network: "osmo-test-5" } });
      if (url.endsWith("blocks/latest")) return jsonResponse({ block: { header: { height: "1000" } } });
      if (url.includes("/accounts/")) return jsonResponse({ account: { "@type": "/cosmos.auth.v1beta1.BaseAccount", account_number: "11", sequence: "7", pub_key: { "@type": "/cosmos.crypto.secp256k1.PubKey", key: base64.encode(accountPublicKey) } } });
      if (url.endsWith("/simulate")) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return jsonResponse({ gas_info: { gas_wanted: "180000", gas_used: "170000" }, result: { events: [
          { type: "coin_spent", attributes: [{ key: "spender", value: authority }, { key: "amount", value: "1002500uosmo" }] },
          { type: "coin_received", attributes: [{ key: "receiver", value: authority }, { key: "amount", value: `950000${unsigned.routes[0].destinationDenom}` }] }
        ] } });
      }
      throw new Error(`unexpected Cosmos request ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Inspect unsigned Cosmos swap intent"]')!, intent, "cosmos-intent.json");
    expect(simulationButton.disabled).toBe(false);
    await act(async () => {
      simulationButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    });
    await waitForUiState(() => expect(container?.textContent).toContain("Source-bound TxRaw simulation verified · separate signing review required · broadcast blocked"));
    expect(container.textContent).toContain("Source-bound TxRaw simulation verified · separate signing review required · broadcast blocked");
    expect(container.textContent).toContain("Optional Cosmos account connection");
    expect(container.textContent).toContain("2 independent REST hosts agreed");
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([request]) => String(request).endsWith("/cosmos/tx/v1beta1/txs"))).toBe(false);
    expect([...container.querySelectorAll("button")].some((button) => /\b(sign|submit|swap|execute|broadcast)\b/i.test(button.textContent ?? ""))).toBe(false);
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin Cosmos read policy source"]')!, { ...readPolicySource, id: "ui.cosmos.read-policy-replaced" }, "replaced-cosmos-read-policy-source.json");
    await vi.waitFor(() => expect(container?.textContent).not.toContain("Source-bound TxRaw simulation verified"));
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify policy-bound TxRaw simulations"))).toBeUndefined();
  });

  it("accepts a source-bound signed External V2 identity for read-only verification only", async () => {
    const signer = new Wallet(`0x${"22".repeat(32)}`);
    const readPolicySigner = new Wallet(`0x${"33".repeat(32)}`);
    const source: ExternalEvmV2VenueSourceDescriptor = {
      schema: "realdex.external-evm-v2-source.v1", id: "ui.external-v2", name: "UI reviewed source",
      signerAddress: signer.address, allowedChainIds: ["eip155:84532"], evidenceUrls: ["https://source.example.org/policy"]
    };
    const unsigned: Omit<SignedExternalEvmV2VenueManifest, "signature"> = {
      schema: "realdex.signed-external-evm-v2-venues.v1", sourceId: source.id, sourceFingerprint: externalEvmV2VenueSourceFingerprint(source), revision: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      venues: [serializeExternalEvmV2VenueIdentity({
        schema: "realdex.external-evm-v2-venue.v1", venueId: "ui-v2-path", chainId: 84532n,
        router: { address: "0x1000000000000000000000000000000000000001", runtimeCodeHash: keccak256("0x6001") },
        factory: { address: "0x2000000000000000000000000000000000000002", runtimeCodeHash: keccak256("0x6002") },
        path: ["0x3000000000000000000000000000000000000003", "0x4000000000000000000000000000000000000004"],
        pairs: [{ address: "0x5000000000000000000000000000000000000005", runtimeCodeHash: keccak256("0x6003"), token0: "0x3000000000000000000000000000000000000003", token1: "0x4000000000000000000000000000000000000004" }],
        feeBps: 30, evidenceUrls: ["https://source.example.org/deployment", "https://explorer.example.net/address"]
      })],
      evidenceUrls: ["https://source.example.org/revision/1"]
    };
    const signed = { ...unsigned, signature: await signer.signMessage(canonicalSignedExternalEvmV2VenueManifestPayload(unsigned)) };
    const readPolicySource: ExternalEvmV2ReadPolicySourceDescriptor = {
      schema: "realdex.external-evm-v2-read-policy-source.v1", id: "ui.external-v2.read-policy", name: "UI reviewed External V2 read policy",
      signerAddress: readPolicySigner.address, allowedChainIds: ["eip155:84532"], evidenceUrls: ["https://source.example.org/read-policy-source"]
    };
    const unsignedReadPolicy: Omit<SignedExternalEvmV2ReadPolicy, "signature"> = {
      schema: "realdex.signed-external-evm-v2-read-policy.v2", sourceId: readPolicySource.id, sourceFingerprint: externalEvmV2ReadPolicySourceFingerprint(readPolicySource), revision: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), chainId: "eip155:84532",
      rpcEndpoints: ["https://venue-a.example.org", "https://venue-b.example.net"], verificationBoundaryId: EXTERNAL_EVM_V2_VERIFICATION_BOUNDARY_ID,
      quoteBoundaryId: EXTERNAL_EVM_V2_QUOTE_BOUNDARY_ID,
      evidenceUrls: ["https://source.example.org/read-policy/revision-1"]
    };
    const signedReadPolicy: SignedExternalEvmV2ReadPolicy = { ...unsignedReadPolicy, signature: await readPolicySigner.signMessage(canonicalSignedExternalEvmV2ReadPolicyPayload(unsignedReadPolicy)) };
    const routerAbi = new Interface(["function factory() view returns (address)", "function getAmountsOut(uint256,address[]) view returns (uint256[])"]);
    const factoryAbi = new Interface(["function getPair(address,address) view returns (address)"]);
    const pairAbi = new Interface(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"]);
    let reserveOut = 2_000_000n;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: string; data: string } | string] };
      let result = "0x14a34";
      if (body.method === "eth_getCode") {
        const target = String(body.params[0]).toLowerCase();
        result = target === "0x1000000000000000000000000000000000000001" ? "0x6001" : target === "0x2000000000000000000000000000000000000002" ? "0x6002" : "0x6003";
      }
      if (body.method === "eth_call") {
        const call = body.params[0] as { to: string; data: string };
        const selector = call.data.slice(0, 10);
        if (selector === routerAbi.getFunction("factory")!.selector || selector === pairAbi.getFunction("factory")!.selector) result = routerAbi.encodeFunctionResult("factory", ["0x2000000000000000000000000000000000000002"]);
        else if (selector === factoryAbi.getFunction("getPair")!.selector) result = factoryAbi.encodeFunctionResult("getPair", ["0x5000000000000000000000000000000000000005"]);
        else if (selector === pairAbi.getFunction("token0")!.selector) result = pairAbi.encodeFunctionResult("token0", ["0x3000000000000000000000000000000000000003"]);
        else if (selector === pairAbi.getFunction("token1")!.selector) result = pairAbi.encodeFunctionResult("token1", ["0x4000000000000000000000000000000000000004"]);
        else if (selector === pairAbi.getFunction("getReserves")!.selector) result = pairAbi.encodeFunctionResult("getReserves", [1_000_000n, reserveOut, 0]);
        else if (selector === routerAbi.getFunction("getAmountsOut")!.selector) {
          const [amountIn] = routerAbi.decodeFunctionData("getAmountsOut", call.data); const input = BigInt(amountIn); const withFee = input * 997n;
          result = routerAbi.encodeFunctionResult("getAmountsOut", [[input, (withFee * reserveOut) / (1_000_000n * 1_000n + withFee)]]);
        } else throw new Error(`unexpected selector ${selector}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    await act(async () => { [...container!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Routes")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin External V2 venue source"]')!, source, "venue-source.json");
    expect(container.textContent).toContain("UI reviewed source");
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Verify signed External V2 venue manifest"]')!, signed, "signed-venues.json");

    expect(container.textContent).toContain("Signed venue identities accepted · execution still blocked");
    const policyInput = container.querySelector<HTMLInputElement>('input[aria-label="Verify signed External V2 read policy"]')!;
    expect(policyInput.disabled).toBe(true);
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin External V2 read policy source"]')!, readPolicySource, "venue-read-policy-source.json");
    expect(policyInput.disabled).toBe(false);
    await chooseJsonFile(policyInput, signedReadPolicy, "venue-read-policy.json");
    await vi.waitFor(() => expect(container?.textContent).toContain("Signed External V2 read policy accepted · execution still blocked"));
    expect(container.textContent).toContain("ui-v2-path · eip155:84532");
    const rpcA = container.querySelector<HTMLInputElement>('input[aria-label="Venue RPC A"]')!;
    const rpcB = container.querySelector<HTMLInputElement>('input[aria-label="Venue RPC B"]')!;
    expect(rpcA.readOnly).toBe(true); expect(rpcB.readOnly).toBe(true);
    expect(rpcA.value).toBe("https://venue-a.example.org/");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify policy-bound venue identity"))).not.toBeUndefined();
    const quoteIntent = {
      schema: "realdex.external-evm-v2-quote-intent.v1", venueId: "ui-v2-path", chainId: "eip155:84532", amountInBaseUnits: "10000", slippageBps: 50,
      recipient: "0x3000000000000000000000000000000000000003", issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString()
    };
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Inspect External V2 quote intent"]')!, quoteIntent, "external-v2-quote-intent.json");
    expect(container.textContent).toContain("Pay 10000 base units · slippage 50 bps");
    const quoteButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify policy-bound quote"))!;
    await act(async () => { quoteButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await vi.waitFor(() => expect(container?.textContent).toContain("Policy-bound External V2 quote verified · signing and submission still blocked"));
    expect(container.textContent).toContain("10000 base units → quoted 19743 · minimum 19644");
    expect(container.textContent).toContain("2 RPC readers agreed");
    expect(fetchMock).toHaveBeenCalledTimes(22);
    expect([...container.querySelectorAll("button")].some((button) => /\b(sign|swap|execute)\b/i.test(button.textContent ?? ""))).toBe(false);
    const revalidateButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Revalidate exact quote read-only"))!;
    await act(async () => { revalidateButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await vi.waitFor(() => expect(container?.textContent).toContain("Exact External V2 quote revalidated · execution remains blocked"));
    expect(fetchMock).toHaveBeenCalledTimes(44);
    expect([...container.querySelectorAll("button")].some((button) => /\b(sign|swap|execute)\b/i.test(button.textContent ?? ""))).toBe(false);
    reserveOut = 2_100_000n;
    const changedQuoteButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Revalidate exact quote read-only"))!;
    await act(async () => { changedQuoteButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await vi.waitFor(() => expect(container?.textContent).toContain("The fresh two-reader quote changed; the previous quote was discarded"));
    expect(fetchMock).toHaveBeenCalledTimes(66);
    expect(container.textContent).not.toContain("Policy-bound External V2 quote verified");
    expect(container.textContent).not.toContain("Exact External V2 quote revalidated");
    let expireQuote: (() => void) | undefined;
    const realSetTimeout = window.setTimeout;
    const timeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation((handler, timeout) => {
      if ((timeout ?? 0) > 1_000 && typeof handler === "function") expireQuote = handler as () => void;
      return realSetTimeout.call(window, handler, timeout);
    });
    try {
      const freshQuoteButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify policy-bound quote"))!;
      await act(async () => { freshQuoteButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await vi.waitFor(() => expect(container?.textContent).toContain("Policy-bound External V2 quote verified · signing and submission still blocked"));
      expect(fetchMock).toHaveBeenCalledTimes(88);
      expect(expireQuote).toBeTypeOf("function");
      await act(async () => { expireQuote?.(); });
      expect(container.textContent).not.toContain("Policy-bound External V2 quote verified");
      expect(container.textContent).toContain("the green quote result was removed automatically");
    } finally { timeoutSpy.mockRestore(); }
    await chooseJsonFile(container.querySelector<HTMLInputElement>('input[aria-label="Pin External V2 read policy source"]')!, { ...readPolicySource, id: "ui.external-v2.read-policy-replaced" }, "replaced-venue-read-policy-source.json");
    await vi.waitFor(() => expect(container?.textContent).not.toContain("Signed External V2 read policy accepted"));
    expect(container.textContent).not.toContain("Policy-bound External V2 quote verified");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify policy-bound venue identity"))).toBeUndefined();
  });

  it("runs an explicit two-host read-only verification and keeps execution blocked", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<UniversePanel provider={null} />); });
    const releaseButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Release")!;
    await act(async () => { releaseButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const manifest = {
      schema: "realdex.evm-public-testnet-deployment.v1", releaseId: "base-sepolia-ui-test", environment: "public-testnet",
      network: { caip2: "eip155:84532", name: "Base Sepolia" },
      source: { bundleSha256: `sha256:${"c".repeat(64)}`, solidity: codeIdentities.solidity, optimizerRuns: codeIdentities.optimizerRuns, factoryRuntimeCodeHash: codeIdentities.factoryRuntimeCodeHash, routerRuntimeCodeHash: codeIdentities.routerRuntimeCodeHash },
      deployer: "0x3333333333333333333333333333333333333333",
      contracts: {
        factory: { address: "0x1111111111111111111111111111111111111111", deploymentTxHash: `0x${"a".repeat(64)}`, blockNumber: 100, runtimeCodeHash: codeIdentities.factoryRuntimeCodeHash },
        router: { address: "0x2222222222222222222222222222222222222222", deploymentTxHash: `0x${"b".repeat(64)}`, blockNumber: 101, runtimeCodeHash: codeIdentities.routerRuntimeCodeHash }
      },
      createdAt: Date.now(), evidenceUrls: ["https://evidence-a.example.org", "https://evidence-b.example.org"]
    };
    const file = new File([JSON.stringify(manifest)], "deployment.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(manifest) });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => { fileInput.dispatchEvent(new Event("change", { bubbles: true })); });

    const rpcA = container.querySelector<HTMLInputElement>('input[aria-label="Public RPC A"]')!;
    const rpcB = container.querySelector<HTMLInputElement>('input[aria-label="Public RPC B"]')!;
    await act(async () => {
      setInputValue(rpcA, "https://rpc-a.example.org");
      setInputValue(rpcB, "https://rpc-b.example.org");
    });
    const verifyButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Verify with 2 public RPCs"))!;
    await act(async () => { verifyButton.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(container.textContent).toContain("On-chain evidence verified · execution still blocked");
    expect(container.textContent).toContain("2 distinct RPC hosts agreed");
    expect(container.textContent).toContain("On-chain evidence verified; execution blocked");
    expect(container.textContent).toContain("never requests an account, signature, transaction, deployment, or liquidity");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Deploy")).toBe(false);
  });
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function chooseJsonFile(input: HTMLInputElement, value: unknown, name: string) {
  const json = JSON.stringify(value);
  const file = new File([json], name, { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => json });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 25)); });
}

async function waitForUiState(assertion: () => void, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    // Flush the render before inspecting it; an assertion inside act can throw
    // before React has committed the update we are waiting for.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`UI state was not reached within ${timeoutMs}ms`);
}

function uiSolanaSwapWire(values: {
  authority: string; recentBlockhash: string; program: string; swapState: string; swapAuthority: string; sourceAccount: string;
  poolSource: string; poolDestination: string; destinationAccount: string; poolMint: string; poolFee: string;
  sourceMint: string; destinationMint: string; tokenProgram: string;
}): { base64: string; sourceIndex: number; destinationIndex: number } {
  const data = new Uint8Array(17), view = new DataView(data.buffer); data[0] = 1; view.setBigUint64(1, 1_000n, true); view.setBigUint64(9, 890n, true);
  const accounts = [
    { address: values.swapState, role: AccountRole.READONLY }, { address: values.swapAuthority, role: AccountRole.READONLY }, { address: values.authority, role: AccountRole.WRITABLE_SIGNER },
    { address: values.sourceAccount, role: AccountRole.WRITABLE }, { address: values.poolSource, role: AccountRole.WRITABLE }, { address: values.poolDestination, role: AccountRole.WRITABLE },
    { address: values.destinationAccount, role: AccountRole.WRITABLE }, { address: values.poolMint, role: AccountRole.WRITABLE }, { address: values.poolFee, role: AccountRole.WRITABLE },
    { address: values.sourceMint, role: AccountRole.READONLY }, { address: values.destinationMint, role: AccountRole.READONLY },
    { address: values.tokenProgram, role: AccountRole.READONLY }, { address: values.tokenProgram, role: AccountRole.READONLY }, { address: values.tokenProgram, role: AccountRole.READONLY }
  ];
  let message: any = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(address(values.authority), message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(values.recentBlockhash), lastValidBlockHeight: 200n }, message);
  message = appendTransactionMessageInstruction({ programAddress: address(values.program), accounts: accounts.map((account) => ({ address: address(account.address), role: account.role })), data }, message);
  const transaction = compileTransaction(message);
  const decodedTransaction = getTransactionDecoder().decode(base64.decode(getBase64EncodedWireTransaction(transaction)));
  const compiled = getCompiledTransactionMessageDecoder().decode(decodedTransaction.messageBytes);
  return { base64: getBase64EncodedWireTransaction(transaction), sourceIndex: compiled.staticAccounts.indexOf(values.sourceAccount as never), destinationIndex: compiled.staticAccounts.indexOf(values.destinationAccount as never) };
}

function uiTokenBalance(accountIndex: number, mint: string, owner: string, amount: string) { return { accountIndex, mint, owner, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } }; }
function uiHex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function uiSolanaSwapState(values: { tokenProgram: string; poolSource: string; poolDestination: string; poolMint: string; sourceMint: string; destinationMint: string; poolFee: string }): Uint8Array {
  const bytes = new Uint8Array(324); bytes[0] = 1; bytes[1] = 1; bytes[2] = 255;
  uiSetSolanaAddress(bytes, 3, values.tokenProgram); uiSetSolanaAddress(bytes, 35, values.poolSource); uiSetSolanaAddress(bytes, 67, values.poolDestination);
  uiSetSolanaAddress(bytes, 99, values.poolMint); uiSetSolanaAddress(bytes, 131, values.sourceMint); uiSetSolanaAddress(bytes, 163, values.destinationMint); uiSetSolanaAddress(bytes, 195, values.poolFee);
  return bytes;
}
function uiSolanaTokenAccount(mint: string, owner: string, amount: bigint): Uint8Array { const bytes = new Uint8Array(165); uiSetSolanaAddress(bytes, 0, mint); uiSetSolanaAddress(bytes, 32, owner); new DataView(bytes.buffer).setBigUint64(64, amount, true); bytes[108] = 1; return bytes; }
function uiSetSolanaAddress(bytes: Uint8Array, offset: number, value: string): void { bytes.set(base58.decode(value), offset); }

function uiOsmosisIntent(authority: string, publicKey: Uint8Array, destinationDenom: string): CosmosSwapIntent {
  const hop = uiProtoConcat(uiProtoUint(1, 12n), uiProtoBytes(2, uiProtoText(destinationDenom)));
  const tokenIn = uiProtoConcat(uiProtoBytes(1, uiProtoText("uosmo")), uiProtoBytes(2, uiProtoText("1000000")));
  const message = uiProtoConcat(uiProtoBytes(1, uiProtoText(authority)), uiProtoBytes(2, hop), uiProtoBytes(3, tokenIn), uiProtoBytes(4, uiProtoText("900000")));
  const body = uiProtoConcat(uiProtoBytes(1, uiProtoAny("/osmosis.gamm.v1beta1.MsgSwapExactAmountIn", message)), uiProtoUint(3, 1200n));
  const key = uiProtoAny("/cosmos.crypto.secp256k1.PubKey", uiProtoBytes(1, publicKey));
  const mode = uiProtoBytes(1, uiProtoUint(1, 1n));
  const signer = uiProtoConcat(uiProtoBytes(1, key), uiProtoBytes(2, mode), uiProtoUint(3, 7n));
  const feeCoin = uiProtoConcat(uiProtoBytes(1, uiProtoText("uosmo")), uiProtoBytes(2, uiProtoText("2500")));
  const fee = uiProtoConcat(uiProtoBytes(1, feeCoin), uiProtoUint(2, 250000n));
  const auth = uiProtoConcat(uiProtoBytes(1, signer), uiProtoBytes(2, fee));
  const txRaw = uiProtoConcat(uiProtoBytes(1, body), uiProtoBytes(2, auth), uiProtoBytes(3, new Uint8Array()));
  return {
    schema: "realdex.cosmos-swap-intent.v1", venueId: "ui-osmosis-route", venueRevision: 1, chainId: "cosmos:osmo-test-5",
    authority, recipient: authority, sourceDenom: "uosmo", destinationDenom, amountInBaseUnits: "1000000",
    expectedOutBaseUnits: "950000", minimumOutBaseUnits: "900000", accountNumber: "11", sequence: "7", feeDenom: "uosmo",
    feeAmountBaseUnits: "2500", gasLimit: "250000", timeoutHeight: "1200", quoteExpiresAt: Date.now() + 60_000,
    transactionBase64: base64.encode(txRaw)
  };
}

function uiProtoAny(typeUrl: string, value: Uint8Array): Uint8Array { return uiProtoConcat(uiProtoBytes(1, uiProtoText(typeUrl)), uiProtoBytes(2, value)); }
function uiProtoBytes(number: number, value: Uint8Array): Uint8Array { return uiProtoConcat(uiProtoVarint(BigInt(number << 3 | 2)), uiProtoVarint(BigInt(value.length)), value); }
function uiProtoUint(number: number, value: bigint): Uint8Array { return uiProtoConcat(uiProtoVarint(BigInt(number << 3)), uiProtoVarint(value)); }
function uiProtoText(value: string): Uint8Array { return new TextEncoder().encode(value); }
function uiProtoConcat(...parts: Uint8Array[]): Uint8Array { const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }
function uiProtoVarint(value: bigint): Uint8Array { const bytes: number[] = []; let current = value; do { let byte = Number(current & 0x7fn); current >>= 7n; if (current) byte |= 0x80; bytes.push(byte); } while (current); return Uint8Array.from(bytes); }
function jsonResponse(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
