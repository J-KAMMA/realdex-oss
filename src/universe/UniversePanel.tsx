import { useEffect, useMemo, useRef, useState } from "react";
import type { JsonRpcProvider } from "ethers";
import { ArrowRight, Check, CircleAlert, Coins, FileJson, Fingerprint, LockKeyhole, Network, Search, ShieldCheck, ShieldX, WalletCards, Waypoints } from "lucide-react";
import { BUILT_IN_ASSETS, CHAIN_NAMESPACES, WALLET_CAPABILITIES, capabilitySummary, validateAssetManifest } from "./registry";
import { ROUTE_DESCRIPTORS } from "../routing/registry";
import type { AssetManifest, CapabilityState } from "./types";
import {
  assetSourceFingerprint, createEvmAssetMetadataReader, validateAssetSourceDescriptor,
  verifySignedAssetManifest, type AssetSourceDescriptor, type AssetSourceHead, type OnChainAssetCheck,
  type VerifiedAssetManifest
} from "./token-source";
import { createCosmosRestDenomReaderQuorum, createSolanaJsonRpcMintReaderQuorum, verifyUniversalAssetOnChain } from "./non-evm-token-source";
import { SOLANA_SWAP_BOUNDARY_ID, validateSolanaSwapIntent, type SolanaSwapIntent } from "../swap/solana-swap-boundary";
import { SPL_TOKEN_SWAP_EXACT_IN_DECODER_ID } from "../swap/spl-token-swap-exact-in-decoder";
import { SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID } from "../swap/spl-token-swap-quote-boundary";
import { SOLANA_SWAP_RECOVERY_ID } from "../swap/solana-swap-recovery";
import {
  SOLANA_VENUE_SOURCE_GATE_ID, solanaVenueSourceFingerprint, validateSolanaVenueSource,
  verifySignedSolanaVenueManifest, type SolanaVenueSourceDescriptor, type SolanaVenueSourceHead,
  type VerifiedSolanaVenueManifest
} from "../swap/solana-venue-source";
import {
  SOLANA_SPL_ROUTE_SOURCE_GATE_ID, verifySignedSolanaSplRouteManifest, verifySourceBoundSplTokenSwap,
  type SolanaSplRouteSourceHead, type VerifiedSolanaSplRouteManifest, type VerifiedSourceBoundSplTokenSwap
} from "../swap/solana-spl-route-source";
import {
  SOLANA_READ_POLICY_GATE_ID, solanaReadPolicySourceFingerprint, validateSolanaReadPolicySource, verifySignedSolanaReadPolicy,
  type SolanaReadPolicyHead, type SolanaReadPolicySourceDescriptor, type VerifiedSolanaReadPolicy
} from "../swap/solana-read-policy";
import { COSMOS_SWAP_BOUNDARY_ID, validateCosmosSwapIntent, type CosmosSwapIntent } from "../swap/cosmos-swap-boundary";
import { COSMOS_SWAP_RECOVERY_ID } from "../swap/cosmos-swap-recovery";
import { OSMOSIS_EXACT_IN_DECODER_ID } from "../swap/osmosis-exact-in-decoder";
import {
  COSMOS_READ_POLICY_GATE_ID, cosmosReadPolicySourceFingerprint, validateCosmosReadPolicySource, verifySignedCosmosReadPolicy,
  type CosmosReadPolicyHead, type CosmosReadPolicySourceDescriptor, type VerifiedCosmosReadPolicy
} from "../swap/cosmos-read-policy";
import {
  COSMOS_VENUE_SOURCE_GATE_ID, cosmosVenueSourceFingerprint, validateCosmosVenueSource,
  verifySignedOsmosisRouteManifest, verifySourceBoundOsmosisSwap, type CosmosVenueSourceDescriptor, type CosmosVenueSourceHead,
  type VerifiedOsmosisRouteManifest, type VerifiedSourceBoundOsmosisSwap
} from "../swap/cosmos-venue-source";
import { EVM_NETWORKS, networkContractsMessage, resolveEvmNetwork, type EvmNetworkId } from "../release/evm-networks";
import { validatePublicTestnetDeploymentManifest, verifyPublicTestnetDeployment, type EvmPublicTestnetDeploymentManifest, type VerifiedEvmPublicTestnetDeployment } from "../release/evm-public-testnet";
import { assertDistinctPublicRpcEndpoints, createPublicJsonRpcDeploymentReader } from "../release/evm-json-rpc-reader";
import { EXTERNAL_EVM_V2_ADAPTER_ID, EXTERNAL_EVM_V2_METHOD } from "../swap/external-evm-v2";
import { EXTERNAL_EVM_V2_RECOVERY_ID } from "../swap/external-evm-v2-recovery";
import {
  EXTERNAL_EVM_V2_SOURCE_GATE_ID,
  externalEvmV2VenueSourceFingerprint,
  validateExternalEvmV2VenueSource,
  verifySignedExternalEvmV2VenueManifest,
  type ExternalEvmV2VenueSourceDescriptor,
  type ExternalEvmV2VenueSourceHead,
  type VerifiedExternalEvmV2VenueManifest
} from "../swap/external-evm-v2-source";
import {
  EXTERNAL_EVM_V2_READ_POLICY_GATE_ID, externalEvmV2ReadPolicySourceFingerprint, validateExternalEvmV2ReadPolicySource,
  quotePolicyBoundExternalEvmV2ExactIn, revalidatePolicyBoundExternalEvmV2Quote, validateExternalEvmV2QuoteIntent, verifyPolicyBoundExternalEvmV2Venue, verifySignedExternalEvmV2ReadPolicy,
  type ExternalEvmV2QuoteIntent, type PolicyBoundExternalEvmV2Quote, type PolicyBoundExternalEvmV2QuoteRevalidation,
  type ExternalEvmV2ReadPolicyHead, type ExternalEvmV2ReadPolicySourceDescriptor, type PolicyBoundExternalEvmV2Venue,
  type VerifiedExternalEvmV2ReadPolicy
} from "../swap/external-evm-v2-read-policy";
import { inspectBitcoinPsbtIntent, type BitcoinPsbtInspection, type BitcoinPsbtIntent } from "../wallet/bitcoin-psbt";
import { createBitcoinEsploraReaderQuorum, verifyBitcoinPsbtUtxoQuorum, type VerifiedBitcoinPsbtUtxoQuorum } from "../wallet/bitcoin-utxo-quorum";
import { verifyBitcoinFeeSafety, type VerifiedBitcoinFeeSafety } from "../wallet/bitcoin-fee-policy";
import {
  bitcoinReadPolicySourceFingerprint, revalidateBitcoinReadPolicy, validateBitcoinReadPolicySource, verifySignedBitcoinReadPolicy,
  type BitcoinReadPolicyHead, type BitcoinReadPolicySourceDescriptor, type VerifiedBitcoinReadPolicy
} from "../wallet/bitcoin-read-policy";
import { verifySignedBitcoinPsbt, type BitcoinSignedPsbtEnvelope, type VerifiedBitcoinSignedPsbt } from "../wallet/bitcoin-signed-psbt";
import { verifyFinalizedBitcoinPsbt, type VerifiedBitcoinFinalizedPsbt } from "../wallet/bitcoin-finalized-psbt";
import WalletStandardDiscoveryPanel from "../wallet/WalletStandardDiscoveryPanel";
import CosmosInjectedConnectionPanel from "../wallet/CosmosInjectedConnectionPanel";
import CosmosSigningReviewPanel from "../swap/CosmosSigningReviewPanel";

type UniverseView = "chains" | "wallets" | "assets" | "routes" | "deployments";
type AssetReaderUrls = { solana: [string, string]; cosmos: [string, string] };

const STATUS: Record<CapabilityState, { label: string; detail: string }> = {
  ready: { label: "Executable", detail: "Installed code and reviewed route can request a signature." },
  partial: { label: "Partial", detail: "Some operations exist; unsupported actions remain blocked." },
  "design-gate": { label: "Design gate", detail: "Discoverable only. It cannot request a signature." }
};

export default function UniversePanel({ provider }: { provider: JsonRpcProvider | null }) {
  const [view, setView] = useState<UniverseView>("chains");
  const [query, setQuery] = useState("");
  const [manifest, setManifest] = useState<AssetManifest>();
  const [source, setSource] = useState<AssetSourceDescriptor>();
  const [sourceFingerprint, setSourceFingerprint] = useState("");
  const [verifiedManifest, setVerifiedManifest] = useState<VerifiedAssetManifest>();
  const [onChainChecks, setOnChainChecks] = useState<OnChainAssetCheck[]>([]);
  const [assetReaderUrls, setAssetReaderUrls] = useState<AssetReaderUrls>({ solana: ["", ""], cosmos: ["", ""] });
  const [assetVerificationState, setAssetVerificationState] = useState<"idle" | "checking" | "accepted" | "failed">("idle");
  const [error, setError] = useState("");
  const [deploymentManifest, setDeploymentManifest] = useState<EvmPublicTestnetDeploymentManifest>();
  const [deploymentError, setDeploymentError] = useState("");
  const [deploymentNetwork, setDeploymentNetwork] = useState<EvmNetworkId>("eip155:84532");
  // Well-known public endpoints, prefilled so the quorum can be checked at once. Every field stays editable.
  const [deploymentRpcUrls, setDeploymentRpcUrls] = useState<[string, string]>(() => defaultRpcPair("eip155:84532"));
  const [deploymentVerification, setDeploymentVerification] = useState<VerifiedEvmPublicTestnetDeployment>();
  const [deploymentVerificationState, setDeploymentVerificationState] = useState<"idle" | "checking" | "verified" | "failed">("idle");
  const [venueSource, setVenueSource] = useState<ExternalEvmV2VenueSourceDescriptor>();
  const [venueSourceFingerprint, setVenueSourceFingerprint] = useState("");
  const [venueManifest, setVenueManifest] = useState<VerifiedExternalEvmV2VenueManifest>();
  const [venueId, setVenueId] = useState("");
  const [venueReadPolicySource, setVenueReadPolicySource] = useState<ExternalEvmV2ReadPolicySourceDescriptor>();
  const [venueReadPolicyFingerprint, setVenueReadPolicyFingerprint] = useState("");
  const [venueReadPolicy, setVenueReadPolicy] = useState<VerifiedExternalEvmV2ReadPolicy>();
  const [venueReadPolicyState, setVenueReadPolicyState] = useState<"idle" | "checking" | "accepted" | "failed">("idle");
  const [venueReadPolicyError, setVenueReadPolicyError] = useState("");
  const [venueVerification, setVenueVerification] = useState<PolicyBoundExternalEvmV2Venue>();
  const [venueVerificationState, setVenueVerificationState] = useState<"idle" | "checking" | "verified" | "failed">("idle");
  const [venueError, setVenueError] = useState("");
  const [venueQuoteIntent, setVenueQuoteIntent] = useState<ExternalEvmV2QuoteIntent>();
  const [venueQuote, setVenueQuote] = useState<PolicyBoundExternalEvmV2Quote>();
  const [venueQuoteRevalidation, setVenueQuoteRevalidation] = useState<PolicyBoundExternalEvmV2QuoteRevalidation>();
  const [venueQuoteState, setVenueQuoteState] = useState<"idle" | "checking" | "verified" | "failed">("idle");
  const [venueQuoteError, setVenueQuoteError] = useState("");
  const [solanaVenueSource, setSolanaVenueSource] = useState<SolanaVenueSourceDescriptor>();
  const [solanaVenueSourceFingerprintValue, setSolanaVenueSourceFingerprintValue] = useState("");
  const [solanaVenueManifest, setSolanaVenueManifest] = useState<VerifiedSolanaVenueManifest>();
  const [solanaVenueVerificationState, setSolanaVenueVerificationState] = useState<"idle" | "checking" | "accepted" | "failed">("idle");
  const [solanaVenueError, setSolanaVenueError] = useState("");
  const [solanaSplRouteManifest, setSolanaSplRouteManifest] = useState<VerifiedSolanaSplRouteManifest>();
  const [solanaSplRouteVerificationState, setSolanaSplRouteVerificationState] = useState<"idle" | "checking" | "accepted" | "failed">("idle");
  const [solanaSplRouteError, setSolanaSplRouteError] = useState("");
  const [solanaSwapRouteId, setSolanaSwapRouteId] = useState("");
  const [solanaSwapIntent, setSolanaSwapIntent] = useState<SolanaSwapIntent>();
  const [solanaReadPolicySource, setSolanaReadPolicySource] = useState<SolanaReadPolicySourceDescriptor>();
  const [solanaReadPolicyFingerprintValue, setSolanaReadPolicyFingerprintValue] = useState("");
  const [solanaReadPolicy, setSolanaReadPolicy] = useState<VerifiedSolanaReadPolicy>();
  const [solanaReadPolicyState, setSolanaReadPolicyState] = useState<"idle" | "checking" | "accepted" | "failed">("idle");
  const [solanaReadPolicyError, setSolanaReadPolicyError] = useState("");
  const [solanaSwapVerification, setSolanaSwapVerification] = useState<VerifiedSourceBoundSplTokenSwap>();
  const [solanaSwapVerificationState, setSolanaSwapVerificationState] = useState<"idle" | "checking" | "verified" | "failed">("idle");
  const [solanaSwapError, setSolanaSwapError] = useState("");
  const [cosmosVenueSource, setCosmosVenueSource] = useState<CosmosVenueSourceDescriptor>();
  const [cosmosVenueSourceFingerprintValue, setCosmosVenueSourceFingerprintValue] = useState("");
  const [cosmosVenueManifest, setCosmosVenueManifest] = useState<VerifiedOsmosisRouteManifest>();
  const [cosmosVenueVerificationState, setCosmosVenueVerificationState] = useState<"idle" | "checking" | "accepted" | "failed">("idle");
  const [cosmosVenueError, setCosmosVenueError] = useState("");
  const [cosmosSwapRouteId, setCosmosSwapRouteId] = useState("");
  const [cosmosSwapIntent, setCosmosSwapIntent] = useState<CosmosSwapIntent>();
  const [cosmosReadPolicySource, setCosmosReadPolicySource] = useState<CosmosReadPolicySourceDescriptor>();
  const [cosmosReadPolicyFingerprintValue, setCosmosReadPolicyFingerprintValue] = useState("");
  const [cosmosReadPolicy, setCosmosReadPolicy] = useState<VerifiedCosmosReadPolicy>();
  const [cosmosReadPolicyState, setCosmosReadPolicyState] = useState<"idle" | "checking" | "accepted" | "failed">("idle");
  const [cosmosReadPolicyError, setCosmosReadPolicyError] = useState("");
  const [cosmosSwapVerification, setCosmosSwapVerification] = useState<VerifiedSourceBoundOsmosisSwap>();
  const [cosmosSwapVerificationState, setCosmosSwapVerificationState] = useState<"idle" | "checking" | "verified" | "failed">("idle");
  const [cosmosSwapError, setCosmosSwapError] = useState("");
  const [bitcoinPsbtInspection, setBitcoinPsbtInspection] = useState<BitcoinPsbtInspection>();
  const [bitcoinPsbtIntent, setBitcoinPsbtIntent] = useState<BitcoinPsbtIntent>();
  const [bitcoinPsbtInspectionError, setBitcoinPsbtInspectionError] = useState("");
  const [bitcoinEsploraUrls, setBitcoinEsploraUrls] = useState<[string, string]>(["", ""]);
  const [bitcoinUtxoVerification, setBitcoinUtxoVerification] = useState<VerifiedBitcoinPsbtUtxoQuorum>();
  const [bitcoinFeeVerification, setBitcoinFeeVerification] = useState<VerifiedBitcoinFeeSafety>();
  const [bitcoinUtxoState, setBitcoinUtxoState] = useState<"idle" | "checking" | "verified" | "failed">("idle");
  const [bitcoinReadError, setBitcoinReadError] = useState("");
  const [bitcoinReadPolicySource, setBitcoinReadPolicySource] = useState<BitcoinReadPolicySourceDescriptor>();
  const [bitcoinReadPolicyFingerprint, setBitcoinReadPolicyFingerprint] = useState("");
  const [bitcoinReadPolicy, setBitcoinReadPolicy] = useState<VerifiedBitcoinReadPolicy>();
  const [bitcoinReadPolicyError, setBitcoinReadPolicyError] = useState("");
  const [bitcoinSignedPsbt, setBitcoinSignedPsbt] = useState<VerifiedBitcoinSignedPsbt>();
  const [bitcoinSignedPsbtEnvelope, setBitcoinSignedPsbtEnvelope] = useState<BitcoinSignedPsbtEnvelope>();
  const [bitcoinSignedPsbtError, setBitcoinSignedPsbtError] = useState("");
  const [bitcoinFinalizedPsbt, setBitcoinFinalizedPsbt] = useState<VerifiedBitcoinFinalizedPsbt>();
  const [bitcoinFinalizedPsbtError, setBitcoinFinalizedPsbtError] = useState("");
  const deploymentAttempt = useRef(0);
  const assetVerificationAttempt = useRef(0);
  const venueAttempt = useRef(0);
  const venueReadPolicyAttempt = useRef(0);
  const venueQuoteAttempt = useRef(0);
  const solanaVenueAttempt = useRef(0);
  const solanaSplRouteAttempt = useRef(0);
  const solanaReadPolicyAttempt = useRef(0);
  const solanaSwapAttempt = useRef(0);
  const cosmosVenueAttempt = useRef(0);
  const cosmosReadPolicyAttempt = useRef(0);
  const cosmosSwapAttempt = useRef(0);
  const bitcoinUtxoAttempt = useRef(0);
  const summary = capabilitySummary();
  const normalized = query.trim().toLowerCase();
  const chains = useMemo(() => CHAIN_NAMESPACES.filter((item) => !normalized || `${item.label} ${item.namespace} ${item.examples.join(" ")}`.toLowerCase().includes(normalized)), [normalized]);
  const wallets = useMemo(() => WALLET_CAPABILITIES.filter((item) => !normalized || `${item.name} ${item.namespaces.join(" ")}`.toLowerCase().includes(normalized)), [normalized]);
  const assets = useMemo(() => [...BUILT_IN_ASSETS, ...(manifest?.assets ?? []), ...(verifiedManifest?.manifest.assets ?? [])].filter((item) => !normalized || `${item.name} ${item.symbol} ${item.assetType}`.toLowerCase().includes(normalized)), [manifest, normalized, verifiedManifest]);
  const routes = useMemo(() => ROUTE_DESCRIPTORS.filter((item) => !normalized || `${item.id} ${item.adapterId} ${item.sourceAsset} ${item.destinationAsset} ${item.trustBoundary}`.toLowerCase().includes(normalized)), [normalized]);
  const selectedNetwork = EVM_NETWORKS[deploymentNetwork];
  const matchingDeployment = deploymentManifest?.network.caip2 === deploymentNetwork ? deploymentManifest : undefined;
  const deploymentMatches = !normalized || `${selectedNetwork.name} ${selectedNetwork.id} ${selectedNetwork.environment} release deployment`.toLowerCase().includes(normalized);

  useEffect(() => {
    if (!venueQuote || !venueManifest || !venueReadPolicy) return;
    const expiresAt = Math.min(
      venueQuote.quote.deadline * 1_000,
      Date.parse(venueQuote.intent.expiresAt),
      Date.parse(venueManifest.manifest.expiresAt),
      Date.parse(venueReadPolicy.policy.expiresAt)
    );
    const expire = () => {
      venueQuoteAttempt.current += 1;
      setVenueQuote(undefined);
      setVenueQuoteRevalidation(undefined);
      setVenueQuoteState("failed");
      setVenueQuoteError(externalVenueErrorMessage(new Error("EXTERNAL_V2_QUOTE_EVIDENCE_EXPIRED")));
    };
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, remaining + 1);
    return () => window.clearTimeout(timer);
  }, [venueManifest, venueQuote, venueReadPolicy]);

  const inspectManifest = async (file?: File) => {
    setManifest(undefined); setError("");
    if (!file) return;
    try { setManifest(validateAssetManifest(JSON.parse(await file.text()))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };


  const inspectBitcoinPsbt = async (file?: File) => {
    bitcoinUtxoAttempt.current += 1;
    setBitcoinPsbtIntent(undefined); setBitcoinPsbtInspection(undefined); setBitcoinPsbtInspectionError(""); setBitcoinUtxoVerification(undefined); setBitcoinFeeVerification(undefined); clearBitcoinPostReadState(); setBitcoinUtxoState("idle"); setBitcoinReadError("");
    if (!file) return;
    try { const parsed = JSON.parse(await file.text()) as BitcoinPsbtIntent; setBitcoinPsbtInspection(inspectBitcoinPsbtIntent(parsed)); setBitcoinPsbtIntent(parsed); }
    catch (reason) { setBitcoinPsbtInspectionError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const pinBitcoinReadPolicySource = async (file?: File) => {
    bitcoinUtxoAttempt.current += 1;
    setBitcoinReadPolicySource(undefined); setBitcoinReadPolicyFingerprint(""); setBitcoinReadPolicy(undefined); setBitcoinEsploraUrls(["", ""]); setBitcoinUtxoVerification(undefined); setBitcoinFeeVerification(undefined); clearBitcoinPostReadState(); setBitcoinUtxoState("idle"); setBitcoinReadError(""); setBitcoinReadPolicyError("");
    if (!file) return;
    try { const source = validateBitcoinReadPolicySource(JSON.parse(await file.text())); setBitcoinReadPolicySource(source); setBitcoinReadPolicyFingerprint(bitcoinReadPolicySourceFingerprint(source)); }
    catch (reason) { setBitcoinReadPolicyError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const inspectBitcoinReadPolicy = async (file?: File) => {
    const attempt = ++bitcoinUtxoAttempt.current;
    setBitcoinReadPolicy(undefined); setBitcoinEsploraUrls(["", ""]); setBitcoinUtxoVerification(undefined); setBitcoinFeeVerification(undefined); clearBitcoinPostReadState(); setBitcoinUtxoState("idle"); setBitcoinReadError(""); setBitcoinReadPolicyError("");
    if (!file) return;
    if (!bitcoinReadPolicySource || !bitcoinReadPolicyFingerprint) { setBitcoinReadPolicyError("Pin an exact Bitcoin read policy source first."); return; }
    try {
      const head = readBitcoinReadPolicyHead(bitcoinReadPolicyFingerprint);
      const verified = verifySignedBitcoinReadPolicy(JSON.parse(await file.text()), bitcoinReadPolicySource, { previousHead: head });
      if (bitcoinUtxoAttempt.current !== attempt) return;
      writeBitcoinReadPolicyHead(bitcoinReadPolicyFingerprint, { revision: verified.policy.revision, payloadHash: verified.payloadHash });
      setBitcoinReadPolicy(verified); setBitcoinEsploraUrls([...verified.policy.esploraEndpoints] as [string, string]);
    } catch (reason) { if (bitcoinUtxoAttempt.current === attempt) setBitcoinReadPolicyError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const verifyBitcoinUtxos = async () => {
    if (!bitcoinPsbtIntent || !bitcoinPsbtInspection || !bitcoinReadPolicy || bitcoinUtxoState === "checking") return;
    const attempt = ++bitcoinUtxoAttempt.current;
    setBitcoinUtxoVerification(undefined); setBitcoinFeeVerification(undefined); clearBitcoinPostReadState(); setBitcoinUtxoState("checking"); setBitcoinReadError("");
    try {
      const currentPolicy = revalidateBitcoinReadPolicy(bitcoinReadPolicy);
      if (currentPolicy.policy.chainId !== bitcoinPsbtInspection.chainId) throw new Error("BITCOIN_READ_POLICY_PSBT_CHAIN_MISMATCH");
      const readers = createBitcoinEsploraReaderQuorum(currentPolicy.policy.esploraEndpoints);
      const verified = await verifyBitcoinPsbtUtxoQuorum(bitcoinPsbtIntent, bitcoinPsbtInspection, readers, currentPolicy.policy.utxoPolicy);
      const feeVerified = await verifyBitcoinFeeSafety(bitcoinPsbtIntent, bitcoinPsbtInspection, verified, readers, currentPolicy.policy.feePolicy);
      if (bitcoinUtxoAttempt.current !== attempt) return;
      setBitcoinUtxoVerification(verified); setBitcoinFeeVerification(feeVerified); setBitcoinUtxoState("verified");
    } catch (reason) {
      if (bitcoinUtxoAttempt.current !== attempt) return;
      setBitcoinUtxoState("failed"); setBitcoinReadError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const inspectSignedBitcoinPsbt = async (file?: File) => {
    setBitcoinSignedPsbt(undefined); setBitcoinSignedPsbtEnvelope(undefined); setBitcoinSignedPsbtError(""); setBitcoinFinalizedPsbt(undefined); setBitcoinFinalizedPsbtError("");
    if (!file) return;
    if (!bitcoinPsbtIntent || !bitcoinPsbtInspection || !bitcoinUtxoVerification || !bitcoinFeeVerification || !bitcoinReadPolicy) { setBitcoinSignedPsbtError("BITCOIN_SIGNED_PSBT_SAFETY_GATE_REQUIRED"); return; }
    try { const parsed = JSON.parse(await file.text()) as BitcoinSignedPsbtEnvelope; setBitcoinSignedPsbt(verifySignedBitcoinPsbt(parsed, bitcoinPsbtIntent, bitcoinPsbtInspection, bitcoinUtxoVerification, bitcoinFeeVerification, bitcoinReadPolicy)); setBitcoinSignedPsbtEnvelope(parsed); }
    catch (reason) { setBitcoinSignedPsbtError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const inspectFinalizedBitcoinPsbt = async (file?: File) => {
    setBitcoinFinalizedPsbt(undefined); setBitcoinFinalizedPsbtError("");
    if (!file) return;
    if (!bitcoinPsbtIntent || !bitcoinPsbtInspection || !bitcoinUtxoVerification || !bitcoinFeeVerification || !bitcoinReadPolicy || !bitcoinSignedPsbt || !bitcoinSignedPsbtEnvelope) { setBitcoinFinalizedPsbtError("BITCOIN_FINALIZED_PSBT_SAFETY_GATE_REQUIRED"); return; }
    try { setBitcoinFinalizedPsbt(verifyFinalizedBitcoinPsbt(JSON.parse(await file.text()), bitcoinSignedPsbtEnvelope, bitcoinPsbtIntent, bitcoinPsbtInspection, bitcoinUtxoVerification, bitcoinFeeVerification, bitcoinReadPolicy, bitcoinSignedPsbt)); }
    catch (reason) { setBitcoinFinalizedPsbtError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const clearBitcoinPostReadState = () => { setBitcoinSignedPsbt(undefined); setBitcoinSignedPsbtEnvelope(undefined); setBitcoinSignedPsbtError(""); setBitcoinFinalizedPsbt(undefined); setBitcoinFinalizedPsbtError(""); };
  const clearVenueQuoteState = () => { venueQuoteAttempt.current += 1; setVenueQuoteIntent(undefined); setVenueQuote(undefined); setVenueQuoteRevalidation(undefined); setVenueQuoteState("idle"); setVenueQuoteError(""); };

  const pinSource = async (file?: File) => {
    assetVerificationAttempt.current += 1;
    setSource(undefined); setSourceFingerprint(""); setVerifiedManifest(undefined); setOnChainChecks([]); setAssetVerificationState("idle"); setError("");
    if (!file) return;
    try {
      const next = validateAssetSourceDescriptor(JSON.parse(await file.text()));
      setSource(next); setSourceFingerprint(assetSourceFingerprint(next));
    } catch (reason) { setError(sourceErrorMessage(reason)); }
  };

  const inspectSignedManifest = async (file?: File) => {
    const attempt = ++assetVerificationAttempt.current;
    setVerifiedManifest(undefined); setOnChainChecks([]); setAssetVerificationState(file ? "checking" : "idle"); setError("");
    if (!file) return;
    if (!source || !sourceFingerprint) { setAssetVerificationState("failed"); setError("Pin an exact source descriptor before inspecting a signed manifest."); return; }
    try {
      const head = readAssetSourceHead(sourceFingerprint);
      const verified = verifySignedAssetManifest(JSON.parse(await file.text()), source, { previousHead: head });
      const hasSolanaAssets = verified.manifest.assets.some((asset) => asset.assetType.startsWith("solana:"));
      const hasCosmosAssets = verified.manifest.assets.some((asset) => asset.assetType.startsWith("cosmos:"));
      const readers = {
        evm: provider ? createEvmAssetMetadataReader(provider) : undefined,
        solana: hasSolanaAssets ? optionalReaderQuorum(assetReaderUrls.solana, createSolanaJsonRpcMintReaderQuorum) : undefined,
        cosmos: hasCosmosAssets ? optionalReaderQuorum(assetReaderUrls.cosmos, createCosmosRestDenomReaderQuorum) : undefined
      };
      const checks = await Promise.all(verified.manifest.assets.map((asset) => verifyUniversalAssetOnChain(asset, readers)));
      if (assetVerificationAttempt.current !== attempt) return;
      writeAssetSourceHead(sourceFingerprint, { revision: verified.manifest.revision, payloadHash: verified.payloadHash });
      setVerifiedManifest(verified); setOnChainChecks(checks); setAssetVerificationState("accepted");
    } catch (reason) {
      if (assetVerificationAttempt.current !== attempt) return;
      setAssetVerificationState("failed"); setError(sourceErrorMessage(reason));
    }
  };

  const updateAssetReaderUrl = (namespace: keyof AssetReaderUrls, index: number, value: string) => {
    assetVerificationAttempt.current += 1;
    setAssetReaderUrls((current) => {
      const urls = [...current[namespace]] as [string, string];
      urls[index] = value;
      return { ...current, [namespace]: urls };
    });
    setVerifiedManifest(undefined); setOnChainChecks([]); setAssetVerificationState("idle"); setError("");
  };

  const inspectDeploymentManifest = async (file?: File) => {
    deploymentAttempt.current += 1;
    setDeploymentManifest(undefined); setDeploymentVerification(undefined); setDeploymentVerificationState("idle"); setDeploymentError("");
    if (!file) return;
    try {
      const parsed = validatePublicTestnetDeploymentManifest(JSON.parse(await file.text()));
      if (parsed.network.caip2 !== deploymentNetwork) { setDeploymentNetwork(parsed.network.caip2); setDeploymentRpcUrls(defaultRpcPair(parsed.network.caip2)); }
      setDeploymentManifest(parsed);
    }
    catch (reason) { setDeploymentError(deploymentErrorMessage(reason)); }
  };

  const selectDeploymentNetwork = (id: EvmNetworkId) => {
    deploymentAttempt.current += 1;
    setDeploymentNetwork(id); setDeploymentRpcUrls(defaultRpcPair(id));
    setDeploymentVerification(undefined); setDeploymentVerificationState("idle"); setDeploymentError("");
  };

  const verifyDeploymentOnChain = async () => {
    if (!deploymentManifest || deploymentVerificationState === "checking") return;
    const attempt = ++deploymentAttempt.current;
    setDeploymentVerification(undefined); setDeploymentVerificationState("checking"); setDeploymentError("");
    try {
      const endpoints = assertDistinctPublicRpcEndpoints(deploymentRpcUrls);
      const readers = endpoints.map((endpoint) => createPublicJsonRpcDeploymentReader(endpoint));
      const verified = await verifyPublicTestnetDeployment(deploymentManifest, readers);
      if (deploymentAttempt.current !== attempt) return;
      setDeploymentVerification(verified); setDeploymentVerificationState("verified");
    } catch (reason) {
      if (deploymentAttempt.current !== attempt) return;
      setDeploymentVerificationState("failed"); setDeploymentError(deploymentErrorMessage(reason));
    }
  };

  const pinVenueSource = async (file?: File) => {
    venueAttempt.current += 1;
    clearVenueQuoteState();
    setVenueSource(undefined); setVenueSourceFingerprint(""); setVenueManifest(undefined); setVenueId(""); setVenueVerification(undefined); setVenueVerificationState("idle"); setVenueError("");
    if (!file) return;
    try {
      const source = validateExternalEvmV2VenueSource(JSON.parse(await file.text()));
      setVenueSource(source); setVenueSourceFingerprint(externalEvmV2VenueSourceFingerprint(source));
    } catch (reason) { setVenueError(externalVenueErrorMessage(reason)); }
  };

  const inspectVenueManifest = async (file?: File) => {
    const attempt = ++venueAttempt.current;
    clearVenueQuoteState();
    setVenueManifest(undefined); setVenueId(""); setVenueVerification(undefined); setVenueVerificationState(file ? "checking" : "idle"); setVenueError("");
    if (!file) return;
    if (!venueSource || !venueSourceFingerprint) { setVenueVerificationState("failed"); setVenueError("Pin an exact External V2 venue source before inspecting its signed manifest."); return; }
    try {
      const head = readVenueSourceHead(venueSourceFingerprint);
      const verified = verifySignedExternalEvmV2VenueManifest(JSON.parse(await file.text()), venueSource, { previousHead: head });
      if (venueAttempt.current !== attempt) return;
      writeVenueSourceHead(venueSourceFingerprint, { revision: verified.manifest.revision, payloadHash: verified.payloadHash });
      setVenueManifest(verified); setVenueId(verified.identities[0].venueId); setVenueVerificationState("idle");
    } catch (reason) {
      if (venueAttempt.current !== attempt) return;
      setVenueVerificationState("failed"); setVenueError(externalVenueErrorMessage(reason));
    }
  };

  const verifyVenueOnChain = async () => {
    if (!venueSource || !venueManifest || !venueReadPolicy || !venueId || venueVerificationState === "checking") return;
    const attempt = ++venueAttempt.current;
    venueQuoteAttempt.current += 1; setVenueQuote(undefined); setVenueQuoteRevalidation(undefined); setVenueQuoteState("idle"); setVenueQuoteError("");
    setVenueVerification(undefined); setVenueVerificationState("checking"); setVenueError("");
    try {
      const head = readVenueSourceHead(venueSourceFingerprint);
      const verified = await verifyPolicyBoundExternalEvmV2Venue({ venueSource, signedVenueManifest: venueManifest.manifest, previousVenueHead: head, venueId, readPolicy: venueReadPolicy });
      if (venueAttempt.current !== attempt) return;
      setVenueVerification(verified); setVenueVerificationState("verified");
    } catch (reason) {
      if (venueAttempt.current !== attempt) return;
      setVenueVerificationState("failed"); setVenueError(externalVenueErrorMessage(reason));
    }
  };

  const pinVenueReadPolicySource = async (file?: File) => {
    const attempt = ++venueReadPolicyAttempt.current;
    venueAttempt.current += 1;
    setVenueReadPolicySource(undefined); setVenueReadPolicyFingerprint(""); setVenueReadPolicy(undefined); setVenueReadPolicyState("idle"); setVenueReadPolicyError("");
    setVenueVerification(undefined); setVenueVerificationState("idle"); setVenueError("");
    clearVenueQuoteState();
    if (!file) return;
    try {
      const source = validateExternalEvmV2ReadPolicySource(JSON.parse(await file.text()));
      const fingerprint = externalEvmV2ReadPolicySourceFingerprint(source);
      if (venueReadPolicyAttempt.current !== attempt) return;
      setVenueReadPolicySource(source); setVenueReadPolicyFingerprint(fingerprint);
    } catch (reason) {
      if (venueReadPolicyAttempt.current !== attempt) return;
      setVenueReadPolicyState("failed"); setVenueReadPolicyError(externalVenueReadPolicyErrorMessage(reason));
    }
  };

  const inspectVenueReadPolicy = async (file?: File) => {
    const attempt = ++venueReadPolicyAttempt.current;
    venueAttempt.current += 1;
    setVenueReadPolicy(undefined); setVenueReadPolicyState(file ? "checking" : "idle"); setVenueReadPolicyError("");
    setVenueVerification(undefined); setVenueVerificationState("idle"); setVenueError("");
    clearVenueQuoteState();
    if (!file) return;
    if (!venueReadPolicySource || !venueReadPolicyFingerprint) { setVenueReadPolicyState("failed"); setVenueReadPolicyError("Pin an exact External V2 read-policy source before inspecting its signed policy."); return; }
    try {
      const head = readVenueReadPolicyHead(venueReadPolicyFingerprint);
      const verified = verifySignedExternalEvmV2ReadPolicy(JSON.parse(await file.text()), venueReadPolicySource, { previousHead: head });
      if (venueReadPolicyAttempt.current !== attempt) return;
      writeVenueReadPolicyHead(venueReadPolicyFingerprint, { revision: verified.policy.revision, payloadHash: verified.payloadHash });
      setVenueReadPolicy(verified); setVenueReadPolicyState("accepted");
    } catch (reason) {
      if (venueReadPolicyAttempt.current !== attempt) return;
      setVenueReadPolicyState("failed"); setVenueReadPolicyError(externalVenueReadPolicyErrorMessage(reason));
    }
  };

  const inspectVenueQuoteIntent = async (file?: File) => {
    const attempt = ++venueQuoteAttempt.current;
    setVenueQuoteIntent(undefined); setVenueQuote(undefined); setVenueQuoteRevalidation(undefined); setVenueQuoteState("idle"); setVenueQuoteError("");
    if (!file) return;
    try {
      const intent = validateExternalEvmV2QuoteIntent(JSON.parse(await file.text()));
      if (venueQuoteAttempt.current !== attempt) return;
      if (venueManifest?.identities.some((identity) => identity.venueId === intent.venueId)) {
        venueAttempt.current += 1; setVenueId(intent.venueId); setVenueVerification(undefined); setVenueVerificationState("idle"); setVenueError("");
      }
      setVenueQuoteIntent(intent);
    } catch (reason) {
      if (venueQuoteAttempt.current !== attempt) return;
      setVenueQuoteState("failed"); setVenueQuoteError(externalVenueErrorMessage(reason));
    }
  };

  const verifyVenueQuote = async () => {
    if (!venueSource || !venueManifest || !venueReadPolicy || !venueQuoteIntent || venueQuoteState === "checking") return;
    const attempt = ++venueQuoteAttempt.current;
    setVenueQuote(undefined); setVenueQuoteRevalidation(undefined); setVenueQuoteState("checking"); setVenueQuoteError("");
    try {
      const head = readVenueSourceHead(venueSourceFingerprint);
      const verified = await quotePolicyBoundExternalEvmV2ExactIn({ venueSource, signedVenueManifest: venueManifest.manifest, previousVenueHead: head, readPolicy: venueReadPolicy, intent: venueQuoteIntent });
      if (venueQuoteAttempt.current !== attempt) return;
      setVenueQuote(verified); setVenueQuoteState("verified");
    } catch (reason) {
      if (venueQuoteAttempt.current !== attempt) return;
      setVenueQuoteState("failed"); setVenueQuoteError(externalVenueErrorMessage(reason));
    }
  };

  const revalidateVenueQuote = async () => {
    if (!venueSource || !venueManifest || !venueReadPolicy || !venueQuote || venueQuoteState === "checking") return;
    const expectedQuote = venueQuote;
    const attempt = ++venueQuoteAttempt.current;
    setVenueQuoteRevalidation(undefined); setVenueQuoteState("checking"); setVenueQuoteError("");
    try {
      const head = readVenueSourceHead(venueSourceFingerprint);
      const revalidated = await revalidatePolicyBoundExternalEvmV2Quote({ venueSource, signedVenueManifest: venueManifest.manifest, previousVenueHead: head, readPolicy: venueReadPolicy, expectedQuote });
      if (venueQuoteAttempt.current !== attempt) return;
      setVenueQuote(revalidated.quote); setVenueQuoteRevalidation(revalidated); setVenueQuoteState("verified");
    } catch (reason) {
      if (venueQuoteAttempt.current !== attempt) return;
      setVenueQuote(undefined); setVenueQuoteRevalidation(undefined); setVenueQuoteState("failed"); setVenueQuoteError(externalVenueErrorMessage(reason));
    }
  };

  const pinSolanaVenueSource = async (file?: File) => {
    const attempt = ++solanaVenueAttempt.current;
    solanaSplRouteAttempt.current += 1; solanaSwapAttempt.current += 1;
    setSolanaVenueSource(undefined); setSolanaVenueSourceFingerprintValue(""); setSolanaVenueManifest(undefined); setSolanaVenueVerificationState("idle"); setSolanaVenueError("");
    clearSolanaSplRouteState();
    if (!file) return;
    try {
      const source = validateSolanaVenueSource(JSON.parse(await file.text()));
      const fingerprint = await solanaVenueSourceFingerprint(source);
      if (solanaVenueAttempt.current !== attempt) return;
      setSolanaVenueSource(source); setSolanaVenueSourceFingerprintValue(fingerprint);
    } catch (reason) {
      if (solanaVenueAttempt.current !== attempt) return;
      setSolanaVenueError(solanaVenueSourceErrorMessage(reason));
    }
  };

  const inspectSolanaVenueManifest = async (file?: File) => {
    const attempt = ++solanaVenueAttempt.current;
    setSolanaVenueManifest(undefined); setSolanaVenueVerificationState(file ? "checking" : "idle"); setSolanaVenueError("");
    if (!file) return;
    if (!solanaVenueSource || !solanaVenueSourceFingerprintValue) { setSolanaVenueVerificationState("failed"); setSolanaVenueError("Pin an exact Solana venue source before inspecting its signed manifest."); return; }
    try {
      const head = readSolanaVenueSourceHead(solanaVenueSourceFingerprintValue);
      const verified = await verifySignedSolanaVenueManifest(JSON.parse(await file.text()), solanaVenueSource, { previousHead: head });
      if (solanaVenueAttempt.current !== attempt) return;
      writeSolanaVenueSourceHead(solanaVenueSourceFingerprintValue, { revision: verified.manifest.revision, payloadHash: verified.payloadHash });
      setSolanaVenueManifest(verified); setSolanaVenueVerificationState("accepted");
    } catch (reason) {
      if (solanaVenueAttempt.current !== attempt) return;
      setSolanaVenueVerificationState("failed"); setSolanaVenueError(solanaVenueSourceErrorMessage(reason));
    }
  };

  const inspectSolanaSplRouteManifest = async (file?: File) => {
    const attempt = ++solanaSplRouteAttempt.current;
    solanaSwapAttempt.current += 1;
    setSolanaSplRouteManifest(undefined); setSolanaSplRouteVerificationState(file ? "checking" : "idle"); setSolanaSplRouteError("");
    clearSolanaSwapState();
    if (!file) return;
    if (!solanaVenueSource || !solanaVenueSourceFingerprintValue) { setSolanaSplRouteVerificationState("failed"); setSolanaSplRouteError("Pin an exact Solana venue source before inspecting its signed SPL route manifest."); return; }
    try {
      const head = readSolanaSplRouteSourceHead(solanaVenueSourceFingerprintValue);
      const verified = await verifySignedSolanaSplRouteManifest(JSON.parse(await file.text()), solanaVenueSource, { previousHead: head });
      if (solanaSplRouteAttempt.current !== attempt) return;
      writeSolanaSplRouteSourceHead(solanaVenueSourceFingerprintValue, { revision: verified.manifest.revision, payloadHash: verified.payloadHash });
      setSolanaSplRouteManifest(verified); setSolanaSwapRouteId(verified.routes[0].venueId); setSolanaSplRouteVerificationState("accepted");
    } catch (reason) {
      if (solanaSplRouteAttempt.current !== attempt) return;
      setSolanaSplRouteVerificationState("failed"); setSolanaSplRouteError(solanaSplRouteSourceErrorMessage(reason));
    }
  };

  const inspectSolanaSwapIntent = async (file?: File) => {
    const attempt = ++solanaSwapAttempt.current;
    setSolanaSwapIntent(undefined); setSolanaSwapVerification(undefined); setSolanaSwapVerificationState("idle"); setSolanaSwapError("");
    if (!file) return;
    if (!solanaSplRouteManifest) { setSolanaSwapVerificationState("failed"); setSolanaSwapError("Verify a signed SPL Token Swap route manifest first."); return; }
    try {
      const intent = validateSolanaSwapIntent(JSON.parse(await file.text()));
      if (solanaSwapAttempt.current !== attempt) return;
      setSolanaSwapIntent(intent);
    } catch (reason) { if (solanaSwapAttempt.current === attempt) { setSolanaSwapVerificationState("failed"); setSolanaSwapError(solanaSwapErrorMessage(reason)); } }
  };

  const pinSolanaReadPolicySource = async (file?: File) => {
    const attempt = ++solanaReadPolicyAttempt.current;
    solanaSwapAttempt.current += 1;
    setSolanaReadPolicySource(undefined); setSolanaReadPolicyFingerprintValue(""); setSolanaReadPolicy(undefined); setSolanaReadPolicyState("idle"); setSolanaReadPolicyError("");
    setSolanaSwapVerification(undefined); setSolanaSwapVerificationState("idle"); setSolanaSwapError("");
    if (!file) return;
    try {
      const source = validateSolanaReadPolicySource(JSON.parse(await file.text()));
      const fingerprint = await solanaReadPolicySourceFingerprint(source);
      if (solanaReadPolicyAttempt.current !== attempt) return;
      setSolanaReadPolicySource(source); setSolanaReadPolicyFingerprintValue(fingerprint);
    } catch (reason) {
      if (solanaReadPolicyAttempt.current !== attempt) return;
      setSolanaReadPolicyState("failed"); setSolanaReadPolicyError(solanaReadPolicyErrorMessage(reason));
    }
  };

  const inspectSolanaReadPolicy = async (file?: File) => {
    const attempt = ++solanaReadPolicyAttempt.current;
    solanaSwapAttempt.current += 1;
    setSolanaReadPolicy(undefined); setSolanaReadPolicyState(file ? "checking" : "idle"); setSolanaReadPolicyError("");
    setSolanaSwapVerification(undefined); setSolanaSwapVerificationState("idle"); setSolanaSwapError("");
    if (!file) return;
    if (!solanaReadPolicySource || !solanaReadPolicyFingerprintValue) { setSolanaReadPolicyState("failed"); setSolanaReadPolicyError("Pin an exact Solana read-policy source before inspecting its signed policy."); return; }
    try {
      const head = readSolanaReadPolicyHead(solanaReadPolicyFingerprintValue);
      const verified = await verifySignedSolanaReadPolicy(JSON.parse(await file.text()), solanaReadPolicySource, { previousHead: head });
      if (solanaReadPolicyAttempt.current !== attempt) return;
      writeSolanaReadPolicyHead(solanaReadPolicyFingerprintValue, { revision: verified.policy.revision, payloadHash: verified.payloadHash });
      setSolanaReadPolicy(verified); setSolanaReadPolicyState("accepted");
    } catch (reason) {
      if (solanaReadPolicyAttempt.current !== attempt) return;
      setSolanaReadPolicyState("failed"); setSolanaReadPolicyError(solanaReadPolicyErrorMessage(reason));
    }
  };

  const verifySolanaSwapSimulation = async () => {
    if (!solanaVenueSource || !solanaSplRouteManifest || !solanaReadPolicy || !solanaSwapIntent || !solanaSwapRouteId || solanaSwapVerificationState === "checking") return;
    const attempt = ++solanaSwapAttempt.current;
    setSolanaSwapVerification(undefined); setSolanaSwapVerificationState("checking"); setSolanaSwapError("");
    try {
      const head = readSolanaSplRouteSourceHead(solanaVenueSourceFingerprintValue);
      const verified = await verifySourceBoundSplTokenSwap({ source: solanaVenueSource, signedManifest: solanaSplRouteManifest.manifest, previousHead: head, venueId: solanaSwapRouteId, intent: solanaSwapIntent, readPolicy: solanaReadPolicy });
      if (solanaSwapAttempt.current !== attempt) return;
      setSolanaSwapVerification(verified); setSolanaSwapVerificationState("verified");
    } catch (reason) {
      if (solanaSwapAttempt.current !== attempt) return;
      setSolanaSwapVerificationState("failed"); setSolanaSwapError(solanaSwapErrorMessage(reason));
    }
  };

  function clearSolanaSplRouteState() {
    setSolanaSplRouteManifest(undefined); setSolanaSplRouteVerificationState("idle"); setSolanaSplRouteError(""); clearSolanaSwapState();
  }

  function clearSolanaSwapState() {
    setSolanaSwapRouteId(""); setSolanaSwapIntent(undefined); setSolanaSwapVerification(undefined); setSolanaSwapVerificationState("idle"); setSolanaSwapError("");
  }

  const pinCosmosVenueSource = async (file?: File) => {
    const attempt = ++cosmosVenueAttempt.current;
    cosmosSwapAttempt.current += 1;
    setCosmosVenueSource(undefined); setCosmosVenueSourceFingerprintValue(""); setCosmosVenueManifest(undefined); setCosmosVenueVerificationState("idle"); setCosmosVenueError("");
    clearCosmosSwapState();
    if (!file) return;
    try {
      const source = validateCosmosVenueSource(JSON.parse(await file.text()));
      const fingerprint = cosmosVenueSourceFingerprint(source);
      if (cosmosVenueAttempt.current !== attempt) return;
      setCosmosVenueSource(source); setCosmosVenueSourceFingerprintValue(fingerprint);
    } catch (reason) {
      if (cosmosVenueAttempt.current !== attempt) return;
      setCosmosVenueError(cosmosVenueSourceErrorMessage(reason));
    }
  };

  const inspectCosmosVenueManifest = async (file?: File) => {
    const attempt = ++cosmosVenueAttempt.current;
    cosmosSwapAttempt.current += 1;
    setCosmosVenueManifest(undefined); setCosmosVenueVerificationState(file ? "checking" : "idle"); setCosmosVenueError("");
    clearCosmosSwapState();
    if (!file) return;
    if (!cosmosVenueSource || !cosmosVenueSourceFingerprintValue) { setCosmosVenueVerificationState("failed"); setCosmosVenueError("Pin an exact Cosmos venue source before inspecting its signed manifest."); return; }
    try {
      const head = readCosmosVenueSourceHead(cosmosVenueSourceFingerprintValue);
      const verified = verifySignedOsmosisRouteManifest(JSON.parse(await file.text()), cosmosVenueSource, { previousHead: head });
      if (cosmosVenueAttempt.current !== attempt) return;
      writeCosmosVenueSourceHead(cosmosVenueSourceFingerprintValue, { revision: verified.manifest.revision, payloadHash: verified.payloadHash });
      setCosmosVenueManifest(verified); setCosmosSwapRouteId(verified.routes[0].venueId); setCosmosVenueVerificationState("accepted");
    } catch (reason) {
      if (cosmosVenueAttempt.current !== attempt) return;
      setCosmosVenueVerificationState("failed"); setCosmosVenueError(cosmosVenueSourceErrorMessage(reason));
    }
  };

  const inspectCosmosSwapIntent = async (file?: File) => {
    const attempt = ++cosmosSwapAttempt.current;
    setCosmosSwapIntent(undefined); setCosmosSwapVerification(undefined); setCosmosSwapVerificationState("idle"); setCosmosSwapError("");
    if (!file) return;
    if (!cosmosVenueManifest) { setCosmosSwapVerificationState("failed"); setCosmosSwapError("Verify a signed Osmosis route manifest first."); return; }
    try {
      const intent = validateCosmosSwapIntent(JSON.parse(await file.text()));
      if (cosmosSwapAttempt.current !== attempt) return;
      setCosmosSwapIntent(intent);
    } catch (reason) { if (cosmosSwapAttempt.current === attempt) { setCosmosSwapVerificationState("failed"); setCosmosSwapError(cosmosSwapErrorMessage(reason)); } }
  };

  const pinCosmosReadPolicySource = async (file?: File) => {
    const attempt = ++cosmosReadPolicyAttempt.current;
    cosmosSwapAttempt.current += 1;
    setCosmosReadPolicySource(undefined); setCosmosReadPolicyFingerprintValue(""); setCosmosReadPolicy(undefined); setCosmosReadPolicyState("idle"); setCosmosReadPolicyError("");
    setCosmosSwapVerification(undefined); setCosmosSwapVerificationState("idle"); setCosmosSwapError("");
    if (!file) return;
    try {
      const source = validateCosmosReadPolicySource(JSON.parse(await file.text()));
      const fingerprint = cosmosReadPolicySourceFingerprint(source);
      if (cosmosReadPolicyAttempt.current !== attempt) return;
      setCosmosReadPolicySource(source); setCosmosReadPolicyFingerprintValue(fingerprint);
    } catch (reason) {
      if (cosmosReadPolicyAttempt.current !== attempt) return;
      setCosmosReadPolicyState("failed"); setCosmosReadPolicyError(cosmosReadPolicyErrorMessage(reason));
    }
  };

  const inspectCosmosReadPolicy = async (file?: File) => {
    const attempt = ++cosmosReadPolicyAttempt.current;
    cosmosSwapAttempt.current += 1;
    setCosmosReadPolicy(undefined); setCosmosReadPolicyState(file ? "checking" : "idle"); setCosmosReadPolicyError("");
    setCosmosSwapVerification(undefined); setCosmosSwapVerificationState("idle"); setCosmosSwapError("");
    if (!file) return;
    if (!cosmosReadPolicySource || !cosmosReadPolicyFingerprintValue) { setCosmosReadPolicyState("failed"); setCosmosReadPolicyError("Pin an exact Cosmos read-policy source before inspecting its signed policy."); return; }
    try {
      const head = readCosmosReadPolicyHead(cosmosReadPolicyFingerprintValue);
      const verified = verifySignedCosmosReadPolicy(JSON.parse(await file.text()), cosmosReadPolicySource, { previousHead: head });
      if (cosmosReadPolicyAttempt.current !== attempt) return;
      writeCosmosReadPolicyHead(cosmosReadPolicyFingerprintValue, { revision: verified.policy.revision, payloadHash: verified.payloadHash });
      setCosmosReadPolicy(verified); setCosmosReadPolicyState("accepted");
    } catch (reason) {
      if (cosmosReadPolicyAttempt.current !== attempt) return;
      setCosmosReadPolicyState("failed"); setCosmosReadPolicyError(cosmosReadPolicyErrorMessage(reason));
    }
  };

  const verifyCosmosSwapSimulation = async () => {
    if (!cosmosVenueSource || !cosmosVenueManifest || !cosmosReadPolicy || !cosmosSwapIntent || !cosmosSwapRouteId || cosmosSwapVerificationState === "checking") return;
    const attempt = ++cosmosSwapAttempt.current;
    setCosmosSwapVerification(undefined); setCosmosSwapVerificationState("checking"); setCosmosSwapError("");
    try {
      const head = readCosmosVenueSourceHead(cosmosVenueSourceFingerprintValue);
      const verified = await verifySourceBoundOsmosisSwap({ source: cosmosVenueSource, signedManifest: cosmosVenueManifest.manifest, previousHead: head, venueId: cosmosSwapRouteId, intent: cosmosSwapIntent, readPolicy: cosmosReadPolicy });
      if (cosmosSwapAttempt.current !== attempt) return;
      setCosmosSwapVerification(verified); setCosmosSwapVerificationState("verified");
    } catch (reason) {
      if (cosmosSwapAttempt.current !== attempt) return;
      setCosmosSwapVerificationState("failed"); setCosmosSwapError(cosmosSwapErrorMessage(reason));
    }
  };

  function clearCosmosSwapState() {
    setCosmosSwapRouteId(""); setCosmosSwapIntent(undefined); setCosmosSwapVerification(undefined); setCosmosSwapVerificationState("idle"); setCosmosSwapError("");
  }

  return <div className="trade-panel universe-panel">
    <div className="panel-header"><div><h2>RealDEX Universal Registry</h2><p>CAIP identities · capability-gated execution</p></div><span className="bridge-beta">EXTENSIBLE</span></div>
    <div className="risk-callout universe-principle"><CircleAlert size={18} /><span><strong>Universal does not mean blindly enabled.</strong> Any chain, wallet, or token can enter the registry, but value movement stays blocked until exact adapter code, liquidity, fees, finality, and recovery are verified.</span></div>
    <div className="universe-stats">
      <div><strong>{summary.namespaces}</strong><span>namespace families</span></div>
      <div><strong>{summary.readyNamespaces}</strong><span>wallet-ready families</span></div>
      <div><strong>{summary.wallets}</strong><span>wallet capability classes</span></div>
      <div><strong>{summary.builtInAssets}</strong><span>reviewed asset identities</span></div>
    </div>
    <div className="universe-flow" aria-label="Universal execution gate">
      <span><Network size={15} /> Chain identity</span><b>→</b><span><WalletCards size={15} /> Wallet capability</span><b>→</b><span><Coins size={15} /> Asset provenance</span><b>→</b><span><ShieldCheck size={15} /> Executable route</span>
    </div>
    <div className="universe-toolbar">
      <div className="universe-switch" role="group" aria-label="Capability registry view">
        <button className={view === "chains" ? "active" : ""} onClick={() => setView("chains")}><Network size={15} />Chains</button>
        <button className={view === "wallets" ? "active" : ""} onClick={() => setView("wallets")}><WalletCards size={15} />Wallets</button>
        <button className={view === "assets" ? "active" : ""} onClick={() => setView("assets")}><Coins size={15} />Tokens</button>
        <button className={view === "routes" ? "active" : ""} onClick={() => setView("routes")}><Waypoints size={15} />Routes</button>
        <button className={view === "deployments" ? "active" : ""} onClick={() => setView("deployments")}><ShieldCheck size={15} />Release</button>
      </div>
      <label className="universe-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search registry" aria-label="Search capability registry" /></label>
    </div>

    {view === "chains" && <div className="universe-list">{chains.map((chain) => {
      const execute = chain.operations["execute-swap"] ?? "design-gate";
      const bridge = chain.operations.bridge ?? "design-gate";
      const overall: CapabilityState = execute === "ready" ? "ready" : Object.values(chain.operations).includes("ready") ? "partial" : "design-gate";
      return <article className="universe-item" key={chain.namespace}>
        <div className="universe-item-head"><span className="namespace-chip">{chain.namespace}</span><StateBadge state={overall} /></div>
        <strong>{chain.label}</strong><p>{chain.examples.join(" · ")}</p>
        <dl><div><dt>Wallet</dt><dd>{chain.walletStandard}</dd></div><div><dt>Address</dt><dd>{chain.addressModel}</dd></div><div><dt>Swap</dt><dd>{STATUS[execute].label}</dd></div><div><dt>Bridge</dt><dd>{STATUS[bridge].label}</dd></div></dl>
      </article>;
    })}</div>}

    {view === "wallets" && <><WalletStandardDiscoveryPanel /><CosmosInjectedConnectionPanel /><div className="bridge-status ok"><ShieldCheck size={17} /><span><strong>Wallet execution scope gate installed</strong><small>Every quote binds the exact CAIP-2 chain, CAIP-10 account, method, notification set, transport identity, expiry, and session revision.</small></span></div>
      <div className="bridge-status pending"><LockKeyhole size={17} /><span><strong>Bitcoin address checks installed · connection still disabled</strong><small>Bitcoin mainnet/testnet Base58Check and SegWit addresses are network-checked. This page cannot pair, connect, sign, send, or use a relay.</small></span></div>
      <div className="asset-import"><div><FileJson size={18} /><span><strong>Inspect Bitcoin PSBT v0 intent JSON</strong><small>Exact native-witness inputs, ordered outputs, fee, locktime, and 15-minute expiry · local page memory only</small></span></div><label className="manifest-button">Inspect PSBT<input type="file" accept="application/json,.json" aria-label="Inspect Bitcoin PSBT v0 intent JSON" onChange={(event) => void inspectBitcoinPsbt(event.target.files?.[0])} /></label></div>
      {bitcoinPsbtInspection && <>
        <div className="bridge-status ok"><ShieldCheck size={17} /><span><strong>Bitcoin PSBT exact intent verified · signing still disabled</strong><small>{bitcoinPsbtInspection.inputCount} input(s) · {bitcoinPsbtInspection.outputCount} output(s) · fee {bitcoinPsbtInspection.feeSats} sats · expires {new Date(bitcoinPsbtInspection.expiresAt).toLocaleString()}</small></span></div>
        <div className="risk-callout source-trust-warning"><CircleAlert size={18} /><span><strong>Exact structure is not ownership, liquidity, price, or authorization evidence.</strong> Only unsigned PSBT v0 native P2WPKH/P2TR witness inputs are accepted. PSBT v2, legacy inputs, signatures, unknown fields, signing, finalization, and broadcast remain blocked.</span></div>
      </>}
      <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Pin Bitcoin read policy source</strong><small>Exact EIP-191 publisher, BIP122 chain scope, and evidence · page memory only</small></span></div><label className="manifest-button">Pin source<input type="file" accept="application/json,.json" aria-label="Pin Bitcoin read policy source" onChange={(event) => void pinBitcoinReadPolicySource(event.target.files?.[0])} /></label></div>
      {bitcoinReadPolicySource && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{bitcoinReadPolicySource.name}</strong><small>{bitcoinReadPolicySource.id} · {shortFingerprint(bitcoinReadPolicySource.signerAddress)}</small><code>{shortFingerprint(bitcoinReadPolicyFingerprint)}</code></span></div>}
      <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Verify signed Bitcoin read policy</strong><small>Chain, two Esplora hosts, UTXO rules, fee rules, expiry, and revision are signed together</small></span></div><label className={`manifest-button ${bitcoinReadPolicySource ? "" : "disabled"}`}>Verify policy<input disabled={!bitcoinReadPolicySource} type="file" accept="application/json,.json" aria-label="Verify signed Bitcoin read policy" onChange={(event) => void inspectBitcoinReadPolicy(event.target.files?.[0])} /></label></div>
      {bitcoinReadPolicy && <div className="bridge-status ok"><ShieldCheck size={17} /><span><strong>Bitcoin read policy signature verified · execution still disabled</strong><small>{bitcoinReadPolicy.policy.chainId} · revision {bitcoinReadPolicy.policy.revision} · expires {new Date(bitcoinReadPolicy.policy.expiresAt).toLocaleString()}</small></span></div>}
      {bitcoinReadPolicyError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Bitcoin read policy rejected: {bitcoinReadPolicyError}</span></div>}
      <div className="asset-reader-config">
        <div className="release-rpc-heading"><Network size={18} /><span><strong>Bitcoin UTXO + fee read quorum</strong><small>2 independent public HTTPS Esplora hosts · GET only · page memory only</small></span></div>
        <div className="release-rpc-grid">{bitcoinEsploraUrls.map((value, index) => <label className="field" key={index}><span>Bitcoin Esplora {index === 0 ? "A" : "B"}</span><input type="url" value={value} readOnly autoComplete="off" spellCheck={false} placeholder="Signed policy required" aria-label={`Bitcoin Esplora ${index === 0 ? "A" : "B"}`} /></label>)}</div>
        <p className="action-note">A pinned publisher must sign both hosts and every UTXO/fee threshold. The default inspection policy is no longer sufficient by itself. No wallet, signature, finalization, transaction submission, or broadcast is available.</p>
        <button className="manifest-button" disabled={!bitcoinPsbtInspection || !bitcoinPsbtIntent || !bitcoinReadPolicy || bitcoinUtxoState === "checking"} onClick={() => void verifyBitcoinUtxos()}>{bitcoinUtxoState === "checking" ? "Checking UTXOs + fee…" : "Verify UTXOs + fee read-only"}</button>
      </div>
      {bitcoinUtxoState === "checking" && <div className="bridge-status pending"><CircleAlert size={17} /><span><strong>Read-only Bitcoin UTXO verification in progress</strong><small>Changing the PSBT or either endpoint cancels the authority of a late result.</small></span></div>}
      {bitcoinUtxoVerification && <div className="bridge-status ok"><ShieldCheck size={17} /><span><strong>Bitcoin UTXO quorum verified · signing still disabled</strong><small>{bitcoinUtxoVerification.inputCount} input(s) · weakest {bitcoinUtxoVerification.weakestConfirmations} confirmation(s) · 2 independent readers</small></span></div>}
      {bitcoinFeeVerification && <div className="bridge-status ok"><ShieldCheck size={17} /><span><strong>Bitcoin fee safety verified · signing still disabled</strong><small>{formatMilliFeeRate(bitcoinFeeVerification.feeRateMilliSatsPerVbyteMin)}–{formatMilliFeeRate(bitcoinFeeVerification.feeRateMilliSatsPerVbyteMax)} sat/vB actual · {formatMilliFeeRate(bitcoinFeeVerification.recommendationMilliSatsPerVbyteMin)}–{formatMilliFeeRate(bitcoinFeeVerification.recommendationMilliSatsPerVbyteMax)} sat/vB reader range · target {bitcoinFeeVerification.confirmationTargetBlocks} blocks</small></span></div>}
      <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Verify wallet-returned signed Bitcoin PSBT</strong><small>Offline ECDSA/Schnorr verification · exact original intent and read evidence · no finalization or broadcast</small></span></div><label className={`manifest-button ${bitcoinUtxoVerification && bitcoinFeeVerification && bitcoinReadPolicy ? "" : "disabled"}`}>Verify signatures<input disabled={!bitcoinUtxoVerification || !bitcoinFeeVerification || !bitcoinReadPolicy} type="file" accept="application/json,.json" aria-label="Verify signed Bitcoin PSBT" onChange={(event) => void inspectSignedBitcoinPsbt(event.target.files?.[0])} /></label></div>
      {bitcoinSignedPsbt && <div className="bridge-status ok"><ShieldCheck size={17} /><span><strong>Bitcoin PSBT signatures verified offline · finalization and broadcast still disabled</strong><small>{bitcoinSignedPsbt.inputCount} input(s) · {bitcoinSignedPsbt.p2wpkhSignatureCount} P2WPKH · {bitcoinSignedPsbt.p2trSignatureCount} P2TR · expires {new Date(bitcoinSignedPsbt.expiresAt).toLocaleString()}</small></span></div>}
      {bitcoinSignedPsbtError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Signed Bitcoin PSBT rejected: {bitcoinSignedPsbtError}</span></div>}
      <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Verify externally finalized Bitcoin PSBT</strong><small>Exact native witness extraction check and txid/wtxid derivation · no transaction bytes or broadcast</small></span></div><label className={`manifest-button ${bitcoinSignedPsbt && bitcoinSignedPsbtEnvelope ? "" : "disabled"}`}>Verify finalization<input disabled={!bitcoinSignedPsbt || !bitcoinSignedPsbtEnvelope} type="file" accept="application/json,.json" aria-label="Verify finalized Bitcoin PSBT" onChange={(event) => void inspectFinalizedBitcoinPsbt(event.target.files?.[0])} /></label></div>
      {bitcoinFinalizedPsbt && <div className="bridge-status ok"><ShieldCheck size={17} /><span><strong>Bitcoin finalization verified offline · extraction and broadcast still disabled</strong><small>txid {shortFingerprint(bitcoinFinalizedPsbt.txid)} · wtxid {shortFingerprint(bitcoinFinalizedPsbt.wtxid)} · {bitcoinFinalizedPsbt.virtualSize} vB · {formatMilliFeeRate(bitcoinFinalizedPsbt.feeRateMilliSatsPerVbyte)} sat/vB</small></span></div>}
      {bitcoinFinalizedPsbtError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Finalized Bitcoin PSBT rejected: {bitcoinFinalizedPsbtError}</span></div>}
      {bitcoinPsbtInspectionError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Bitcoin PSBT intent rejected: {bitcoinPsbtInspectionError}</span></div>}
      {bitcoinReadError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Bitcoin read safety rejected: {bitcoinReadError}</span></div>}
      <div className="universe-list">{wallets.map((wallet) => <article className="universe-item" key={wallet.id}>
      <div className="universe-item-head"><span className="namespace-chip">{wallet.transport}</span><StateBadge state={wallet.state} /></div>
      <strong>{wallet.name}</strong><p>{wallet.namespaces.join(" · ")}</p>
      <div className="grant-list">{wallet.grants.map((grant) => <span key={grant}>{grant}</span>)}</div>
    </article>)}</div></>}

    {view === "assets" && <>
      <div className="asset-import"><div><FileJson size={18} /><span><strong>Unsigned token manifest</strong><small>CAIP-19 identity required · inspection-only</small></span></div><label className="manifest-button">Inspect JSON<input type="file" accept="application/json,.json" onChange={(event) => void inspectManifest(event.target.files?.[0])} /></label></div>
      {manifest && <div className="bridge-status ok"><Check size={17} /><span><strong>{manifest.name}</strong><small>{manifest.assets.length} imported identities · inspection-only</small></span></div>}
      <div className="asset-source-stack">
        <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Session-pin a signing source</strong><small>Exact signer, source ID, allowed chains, and evidence are fingerprinted</small></span></div><label className="manifest-button">Pin source<input type="file" accept="application/json,.json" onChange={(event) => void pinSource(event.target.files?.[0])} /></label></div>
        {source && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{source.name}</strong><small>{source.id} · {shortFingerprint(source.signerAddress)}</small><code>{shortFingerprint(sourceFingerprint)}</code></span></div>}
        <div className="asset-reader-config">
          <div className="release-rpc-heading"><Network size={18} /><span><strong>Optional non-EVM metadata quorum</strong><small>2 independent public HTTPS hosts per configured family · page memory only · no wallet or signature</small></span></div>
          <div className="release-rpc-grid">
            {(["solana", "cosmos"] as const).flatMap((namespace) => assetReaderUrls[namespace].map((value, index) => {
              const family = namespace === "solana" ? "Solana JSON-RPC" : "Cosmos REST";
              const suffix = index === 0 ? "A" : "B";
              return <label className="field" key={`${namespace}:${index}`}><span>{family} {suffix}</span><input type="url" value={value} autoComplete="off" spellCheck={false} placeholder={`https://${namespace}-${suffix.toLowerCase()}.example`} aria-label={`${namespace === "solana" ? "Solana metadata RPC" : "Cosmos metadata REST"} ${suffix}`} onChange={(event) => updateAssetReaderUrl(namespace, index, event.target.value)} /></label>;
            }))}
          </div>
          <p className="action-note">Both hosts must answer and agree. Solana remains partial because mint state does not prove symbol/name. Cosmos becomes verified only when both hosts agree on chain ID and exact bank metadata.</p>
        </div>
        <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Signed token manifest</strong><small>Signature, expiry, revision head, chain scope, collisions, and configured reader quorum are checked</small></span></div><label className={`manifest-button ${source && assetVerificationState !== "checking" ? "" : "disabled"}`}>{assetVerificationState === "checking" ? "Checking readers…" : "Verify signed JSON"}<input disabled={!source || assetVerificationState === "checking"} type="file" accept="application/json,.json" onChange={(event) => void inspectSignedManifest(event.target.files?.[0])} /></label></div>
        {assetVerificationState === "checking" && <div className="bridge-status pending"><CircleAlert size={17} /><span><strong>Read-only metadata verification in progress</strong><small>Changing a source or endpoint cancels the authority of this result. No wallet request or transaction is made.</small></span></div>}
        {verifiedManifest && <>
          <div className="bridge-status ok"><Check size={17} /><span><strong>Signature verified · revision {verifiedManifest.manifest.revision}</strong><small>{verifiedManifest.manifest.assets.length} identities · expires {new Date(verifiedManifest.manifest.expiresAt).toLocaleString()} · still design-gated</small></span></div>
          <div className="risk-callout source-trust-warning"><CircleAlert size={18} /><span><strong>A valid signature identifies the pinned publisher; it does not prove token safety.</strong> Contract behavior, liquidity, route code, fees, and execution readiness remain separate gates.</span></div>
          {verifiedManifest.collisions.map((collision, index) => <div className={`source-finding ${collision.severity}`} key={`${collision.kind}:${collision.assetType}:${collision.comparedAssetType}:${index}`}>
            {collision.severity === "critical" ? <ShieldX size={16} /> : <CircleAlert size={16} />}<span><strong>{collision.kind}</strong><small>{collision.message}</small><code>{collision.assetType}</code></span>
          </div>)}
          <div className="onchain-checks">{onChainChecks.map((check) => <div className={`source-finding ${check.status}`} key={check.assetType}>
            {check.status === "verified" ? <Check size={16} /> : check.status === "mismatch" ? <ShieldX size={16} /> : <CircleAlert size={16} />}<span><strong>On-chain · {check.status}</strong><small>{check.message}</small>{check.observed && <code>{observedAssetMetadata(check.observed)}</code>}</span>
          </div>)}</div>
        </>}
      </div>
      {error && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Token manifest rejected: {error}</span></div>}
      <div className="universe-list">{assets.map((asset, index) => <article className="universe-item asset-item" key={`${asset.provenance}:${asset.assetType}:${index}`}>
        <div className="universe-item-head"><span className="asset-symbol">{asset.symbol}</span><StateBadge state={asset.execution} /></div>
        <strong>{asset.name}</strong><code>{asset.assetType}</code>
        <dl><div><dt>Decimals</dt><dd>{asset.decimals}</dd></div><div><dt>Provenance</dt><dd>{asset.provenance}</dd></div>{asset.provenance === "signed-list" && <div><dt>On-chain</dt><dd>{onChainChecks.find((check) => check.assetType === asset.assetType)?.status ?? "not-checked"}</dd></div>}</dl>
      </article>)}</div>
    </>}

    {view === "routes" && <>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>External EVM V2 safety boundary installed · no public venue enabled</strong><small>{EXTERNAL_EVM_V2_ADAPTER_ID} independently checks Router, Factory, every Pair, reserves, the 0.30% fee formula, and decoded {EXTERNAL_EVM_V2_METHOD} calldata. A reviewed deployment identity and execution transport are still required.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed External EVM V2 venue source gate installed · no source pinned</strong><small>{EXTERNAL_EVM_V2_SOURCE_GATE_ID} binds the exact source fingerprint, signer, revision, expiry, chain scope, Router, Factory, Pairs, path, runtime hashes, and evidence. Two independent public RPC hosts must still match; success never enables execution.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed External EVM V2 read policy gate installed · no policy pinned</strong><small>{EXTERNAL_EVM_V2_READ_POLICY_GATE_ID} binds an independent EIP-191 reviewer, exact chain, two public RPC endpoints, venue and quote boundary versions, revision, expiry, and evidence. Only policy-derived readers may enter the source-bound venue and quote path.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>External EVM V2 recovery journal installed · execution still disabled</strong><small>{EXTERNAL_EVM_V2_RECOVERY_ID} binds an exact-size approval and swap envelope to the verified venue and quote, then requires matching receipt, nonce, and head evidence from two independent RPC hosts. A consumed nonce with missing transaction evidence remains replacement-unresolved and cannot authorize retrying.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Solana swap simulation boundary installed · no venue enabled</strong><small>{SOLANA_SWAP_BOUNDARY_ID} requires exact upgradeable-program bytes, a single decoded swap instruction, amount/min-out and token-account binding, blockhash lifetime, and matching simulations from two independent RPC hosts. It cannot request a wallet signature.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed Solana venue source gate installed · no source pinned</strong><small>{SOLANA_VENUE_SOURCE_GATE_ID} binds an Ed25519 publisher, exact CAIP-2 scope, revision, expiry, program, ProgramData bytes, token program, pool target, and evidence. The signed identity must still pass the existing two-RPC simulation boundary; success never enables submission.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed SPL Token Swap route source gate installed · no route enabled</strong><small>{SOLANA_SPL_ROUTE_SOURCE_GATE_ID} signs the exact pool state, authority, vaults, mint, fee accounts, token program, ProgramData identity, revision, expiry, and evidence. The decoder is derived only from this signed route; submission remains unavailable.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed Solana read policy gate installed · no policy pinned</strong><small>{SOLANA_READ_POLICY_GATE_ID} binds an independent Ed25519 reviewer, exact chain, two public RPC endpoints, quote/simulation boundary versions, revision, expiry, and evidence. Only policy-derived readers may enter the source-bound SPL path.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>SPL Token Swap exact-input decoder installed · no pool enabled</strong><small>{SPL_TOKEN_SWAP_EXACT_IN_DECODER_ID} binds the exact pool state and authority, pool vaults, mint, fee account, user token accounts, token program, amount, minimum output, and optional host fee. Other instructions, substituted accounts, extra bytes, signing, and submission remain blocked.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>SPL Token Swap reserve quote boundary installed · no pool enabled</strong><small>{SPL_TOKEN_SWAP_QUOTE_BOUNDARY_ID} parses the exact signed swap state and classic token vaults on two independent RPC hosts, permits only the constant-product curve, recomputes both trading fees and output, and binds a maximum 5% slippage floor before simulation.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Solana swap recovery journal installed · submission still disabled</strong><small>{SOLANA_SWAP_RECOVERY_ID} verifies the wallet signature against the exact simulated message, persists a pool- and intent-bound duplicate guard, and requires matching history-aware status evidence from two independent RPC hosts. Missing evidence after blockhash expiry remains unresolved and cannot authorize resending.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Cosmos swap transaction boundary installed · no venue enabled</strong><small>{COSMOS_SWAP_BOUNDARY_ID} requires one canonical DIRECT-sign message, exact signer sequence, fee and timeout height, venue-specific decoding, and matching debit, credit, and gas simulations from two independent REST hosts. It cannot request a wallet signature.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed Cosmos/Osmosis route source gate installed · no source pinned</strong><small>{COSMOS_VENUE_SOURCE_GATE_ID} binds a secp256k1 publisher, exact CAIP-2 scope, revision, expiry, ordered pool IDs, every hop denom, and evidence. A signed route must still pass the source-bound TxRaw decoder and two independent REST simulations; success never enables broadcast.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed Cosmos read policy gate installed · no policy pinned</strong><small>{COSMOS_READ_POLICY_GATE_ID} binds an independent secp256k1 reviewer, exact chain, two public REST endpoints, simulation boundary version, revision, expiry, and evidence. Only policy-derived readers may enter the source-bound Osmosis path.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Osmosis exact-input decoder installed · no pool enabled</strong><small>{OSMOSIS_EXACT_IN_DECODER_ID} binds the osmo sender, 1–4 exact pool IDs, every hop output denom, input coin, and final minimum output. Split routes, substituted or cyclic paths, unknown protobuf fields, signing, and broadcast remain blocked.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Cosmos swap recovery journal installed · broadcast still disabled</strong><small>{COSMOS_SWAP_RECOVERY_ID} verifies the exact 64-byte low-S secp256k1 signature, derives the bech32 authority from the signed public key, binds the prior simulation evidence, and requires matching committed status from two independent REST hosts. Missing history after timeout remains unresolved and cannot authorize rebroadcast.</small></span></div>
      <div className="asset-source-stack">
        <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Session-pin an External V2 venue source</strong><small>Exact signer, source policy, chain scope, and evidence are fingerprinted</small></span></div><label className="manifest-button">Pin source<input type="file" accept="application/json,.json" aria-label="Pin External V2 venue source" onChange={(event) => void pinVenueSource(event.target.files?.[0])} /></label></div>
        {venueSource && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{venueSource.name}</strong><small>{venueSource.id} · {shortFingerprint(venueSource.signerAddress)}</small><code>{shortFingerprint(venueSourceFingerprint)}</code></span></div>}
        <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Signed External V2 venue manifest</strong><small>Source fingerprint, signature, expiry, revision, paths, contracts, and runtime hashes are checked</small></span></div><label className={`manifest-button ${venueSource && venueVerificationState !== "checking" ? "" : "disabled"}`}>{venueVerificationState === "checking" && !venueManifest ? "Checking signature…" : "Verify signed JSON"}<input disabled={!venueSource || venueVerificationState === "checking"} type="file" accept="application/json,.json" aria-label="Verify signed External V2 venue manifest" onChange={(event) => void inspectVenueManifest(event.target.files?.[0])} /></label></div>
        {venueManifest && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed venue identities accepted · execution still blocked</strong><small>{venueManifest.identities.length} identity record{venueManifest.identities.length === 1 ? "" : "s"} · revision {venueManifest.manifest.revision} · current code must still match through two independent public RPC hosts.</small></span></div>}
        <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Session-pin an External V2 read-policy source</strong><small>Independent EIP-191 reviewer, EIP-155 chain scope, and RPC policy evidence · page memory only</small></span></div><label className="manifest-button">Pin read-policy source<input type="file" accept="application/json,.json" aria-label="Pin External V2 read policy source" onChange={(event) => void pinVenueReadPolicySource(event.target.files?.[0])} /></label></div>
        {venueReadPolicySource && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{venueReadPolicySource.name}</strong><small>{venueReadPolicySource.id} · {shortFingerprint(venueReadPolicySource.signerAddress)}</small><code>{shortFingerprint(venueReadPolicyFingerprint)}</code></span></div>}
        <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Signed External V2 identity read policy</strong><small>Exact chain, RPC pair, boundary version, expiry, monotonic revision, and evidence</small></span></div><label className={`manifest-button ${venueReadPolicySource && venueReadPolicyState !== "checking" ? "" : "disabled"}`}>{venueReadPolicyState === "checking" ? "Checking read policy…" : "Verify read-policy JSON"}<input disabled={!venueReadPolicySource || venueReadPolicyState === "checking"} type="file" accept="application/json,.json" aria-label="Verify signed External V2 read policy" onChange={(event) => void inspectVenueReadPolicy(event.target.files?.[0])} /></label></div>
        {venueReadPolicy && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed External V2 read policy accepted · execution still blocked</strong><small>{venueReadPolicy.policy.chainId} · revision {venueReadPolicy.policy.revision} · {venueReadPolicy.policy.rpcEndpoints.map((endpoint) => new URL(endpoint).hostname).join(" + ")} · readers are recreated only from this signed pair.</small></span></div>}
        {venueManifest && venueReadPolicy && <div className="release-rpc-check" aria-busy={venueVerificationState === "checking"}>
          <div className="release-rpc-heading"><Network size={18} /><span><strong>Policy-bound External V2 identity quorum</strong><small>Exact signed venue identity + signed read policy · endpoints and evidence remain in page memory only.</small></span></div>
          <label className="field"><span>Signed venue identity</span><select aria-label="Signed External V2 venue identity" value={venueId} onChange={(event) => { venueAttempt.current += 1; setVenueId(event.target.value); setVenueVerification(undefined); setVenueVerificationState("idle"); setVenueError(""); clearVenueQuoteState(); }}>{venueManifest.identities.map((identity) => <option key={identity.venueId} value={identity.venueId}>{identity.venueId} · eip155:{identity.chainId.toString()}</option>)}</select></label>
          <div className="release-rpc-grid">{venueReadPolicy.policy.rpcEndpoints.map((value, index) => <label className="field" key={index}><span>Policy-bound venue RPC {index === 0 ? "A" : "B"}</span><input readOnly type="url" value={value} autoComplete="off" spellCheck={false} aria-label={`Venue RPC ${index === 0 ? "A" : "B"}`} /></label>)}</div>
          <button className="secondary-button release-verify-button" type="button" disabled={venueVerificationState === "checking"} onClick={() => void verifyVenueOnChain()}>{venueVerificationState === "checking" ? "Re-verifying source, policy, and venue identity…" : "Verify policy-bound venue identity"}</button>
          <p className="action-note">This sends only eth_chainId, eth_getCode, and eth_call to the two hosts authenticated by the signed read policy. It never requests an account, signature, approval, swap, retry, or transaction.</p>
        </div>}
        {venueVerification && <div className="bridge-status ok"><Check size={17} /><span><strong>External V2 identity verified · execution still blocked</strong><small>{venueVerification.observations.length} independent RPC hosts matched the exact chain, Router, Factory, Pair code, origin, tokens, and path identity.</small></span></div>}
        <div className="release-rpc-check" aria-busy={venueQuoteState === "checking"}>
          <div className="release-rpc-heading"><Coins size={18} /><span><strong>Policy-bound External V2 exact-input quote preview</strong><small>Strict local intent + freshly verified signed venue + signed two-RPC policy · no wallet or transaction authority</small></span></div>
          <div className="asset-import"><div><FileJson size={18} /><span><strong>Inspect External V2 quote intent</strong><small>Exact venue, chain, base-unit amount, recipient, slippage, and maximum five-minute lifetime</small></span></div><label className={`manifest-button ${venueManifest && venueReadPolicy ? "" : "disabled"}`}>Inspect quote intent<input disabled={!venueManifest || !venueReadPolicy} type="file" accept="application/json,.json" aria-label="Inspect External V2 quote intent" onChange={(event) => void inspectVenueQuoteIntent(event.target.files?.[0])} /></label></div>
          {venueQuoteIntent && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{venueQuoteIntent.venueId} · {venueQuoteIntent.chainId}</strong><small>Pay {venueQuoteIntent.amountInBaseUnits} base units · slippage {venueQuoteIntent.slippageBps} bps · expires {new Date(venueQuoteIntent.expiresAt).toLocaleString()}</small><code>Recipient {venueQuoteIntent.recipient}</code></span></div>}
          <button className="secondary-button release-verify-button" type="button" disabled={!venueManifest || !venueReadPolicy || !venueQuoteIntent || venueQuoteState === "checking"} onClick={() => void verifyVenueQuote()}>{venueQuoteState === "checking" ? "Re-verifying intent, venue, policy, reserves, and Router quote…" : "Verify policy-bound quote"}</button>
          <p className="action-note">Both signed-policy RPC hosts receive bounded read-only calls for chain, code, contract identity, reserves, and Router output. The amount and path are visible to both RPC operators; the recipient stays local. No account request, signature, approval, submission, or retry is available.</p>
        </div>
        {venueQuote && <>
          <div className="bridge-status ok"><Check size={17} /><span><strong>Policy-bound External V2 quote verified · signing and submission still blocked</strong><small>{venueQuote.intent.amountInBaseUnits} base units → quoted {venueQuote.quote.amounts.at(-1)?.toString()} · minimum {venueQuote.quote.minimumOut.toString()} · recipient {venueQuote.quote.recipient} · deadline {new Date(venueQuote.quote.deadline * 1_000).toLocaleString()} · {venueQuote.observations.length} RPC readers agreed</small><code>Quote {venueQuote.quote.quoteId} · calldata {venueQuote.quote.calldata}</code></span></div>
          <button className="secondary-button release-verify-button" type="button" disabled={venueQuoteState === "checking"} onClick={() => void revalidateVenueQuote()}>{venueQuoteState === "checking" ? "Revalidating the exact quote through both policy readers…" : "Revalidate exact quote read-only"}</button>
        </>}
        {venueQuoteRevalidation && <div className="bridge-status ok"><ShieldCheck size={17} /><span><strong>Exact External V2 quote revalidated · execution remains blocked</strong><small>The same intent, signed identities, reserves, Router output, minimum, deadline, and calldata matched at {new Date(venueQuoteRevalidation.revalidatedAt).toLocaleString()}.</small><code>Quote {venueQuoteRevalidation.expectedQuoteId}</code></span></div>}
        {venueQuoteError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>External V2 quote rejected: {venueQuoteError}</span></div>}
        {venueReadPolicyError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>External V2 read policy rejected: {venueReadPolicyError}</span></div>}
        {venueError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>External V2 venue rejected: {venueError}</span></div>}
        <div className="risk-callout source-trust-warning"><CircleAlert size={18} /><span><strong>A valid source signature, matching code, and two-reader quote are a short-lived preview—not permission to trade.</strong> Token behavior, wallet capability, approval, execution-time price change, transaction simulation, submission, and recovery remain separate gates.</span></div>
      </div>
      <div className="asset-source-stack">
        <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Session-pin a Solana venue source</strong><small>Exact Ed25519 publisher, CAIP-2 chain scope, and review evidence · page memory only</small></span></div><label className="manifest-button">Pin Solana source<input type="file" accept="application/json,.json" aria-label="Pin Solana venue source" onChange={(event) => void pinSolanaVenueSource(event.target.files?.[0])} /></label></div>
        {solanaVenueSource && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{solanaVenueSource.name}</strong><small>{solanaVenueSource.id} · {shortFingerprint(solanaVenueSource.signerPublicKey)}</small><code>{shortFingerprint(solanaVenueSourceFingerprintValue)}</code></span></div>}
        <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Signed Solana venue manifest</strong><small>Publisher signature, expiry, revision head, program and ProgramData identity, token program, pool target, and evidence</small></span></div><label className={`manifest-button ${solanaVenueSource && solanaVenueVerificationState !== "checking" ? "" : "disabled"}`}>{solanaVenueVerificationState === "checking" ? "Checking Ed25519 signature…" : "Verify Solana JSON"}<input disabled={!solanaVenueSource || solanaVenueVerificationState === "checking"} type="file" accept="application/json,.json" aria-label="Verify signed Solana venue manifest" onChange={(event) => void inspectSolanaVenueManifest(event.target.files?.[0])} /></label></div>
        {solanaVenueManifest && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed Solana venue identities accepted · submission still blocked</strong><small>{solanaVenueManifest.venues.length} identity record{solanaVenueManifest.venues.length === 1 ? "" : "s"} · revision {solanaVenueManifest.manifest.revision} · each transaction must freshly re-verify this signature and pass two independent RPC simulations.</small></span></div>}
        <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Signed SPL Token Swap route manifest</strong><small>Publisher signature, expiry, revision head, exact program and complete pool account topology</small></span></div><label className={`manifest-button ${solanaVenueSource && solanaSplRouteVerificationState !== "checking" ? "" : "disabled"}`}>{solanaSplRouteVerificationState === "checking" ? "Checking signed account topology…" : "Verify SPL route JSON"}<input disabled={!solanaVenueSource || solanaSplRouteVerificationState === "checking"} type="file" accept="application/json,.json" aria-label="Verify signed Solana SPL route manifest" onChange={(event) => void inspectSolanaSplRouteManifest(event.target.files?.[0])} /></label></div>
        {solanaSplRouteManifest && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed SPL Token Swap routes accepted · submission still blocked</strong><small>{solanaSplRouteManifest.routes.length} route record{solanaSplRouteManifest.routes.length === 1 ? "" : "s"} · revision {solanaSplRouteManifest.manifest.revision} · each transaction freshly derives its decoder from the signed route and must pass two independent RPC simulations.</small></span></div>}
        <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Session-pin a Solana read-policy source</strong><small>Independent Ed25519 reviewer, CAIP-2 chain scope, and RPC policy evidence · page memory only</small></span></div><label className="manifest-button">Pin read-policy source<input type="file" accept="application/json,.json" aria-label="Pin Solana read policy source" onChange={(event) => void pinSolanaReadPolicySource(event.target.files?.[0])} /></label></div>
        {solanaReadPolicySource && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{solanaReadPolicySource.name}</strong><small>{solanaReadPolicySource.id} · {shortFingerprint(solanaReadPolicySource.signerPublicKey)}</small><code>{shortFingerprint(solanaReadPolicyFingerprintValue)}</code></span></div>}
        <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Signed Solana quote + simulation read policy</strong><small>Exact chain, RPC pair, boundary versions, expiry, monotonic revision, and evidence</small></span></div><label className={`manifest-button ${solanaReadPolicySource && solanaReadPolicyState !== "checking" ? "" : "disabled"}`}>{solanaReadPolicyState === "checking" ? "Checking read policy…" : "Verify read-policy JSON"}<input disabled={!solanaReadPolicySource || solanaReadPolicyState === "checking"} type="file" accept="application/json,.json" aria-label="Verify signed Solana read policy" onChange={(event) => void inspectSolanaReadPolicy(event.target.files?.[0])} /></label></div>
        {solanaReadPolicy && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed Solana read policy accepted · execution still blocked</strong><small>{solanaReadPolicy.policy.chainId} · revision {solanaReadPolicy.policy.revision} · {solanaReadPolicy.policy.rpcEndpoints.map((endpoint) => new URL(endpoint).hostname).join(" + ")} · readers are recreated only from this signed pair.</small></span></div>}
        {solanaSplRouteManifest && <div className="release-rpc-check" aria-busy={solanaSwapVerificationState === "checking"}>
          <div className="release-rpc-heading"><Network size={18} /><span><strong>Policy-bound Solana quote + unsigned transaction simulation quorum</strong><small>Exact signed SPL route + signed read policy + unsigned v0 transaction · page memory only</small></span></div>
          <label className="field"><span>Signed SPL Token Swap route</span><select aria-label="Signed Solana SPL route" value={solanaSwapRouteId} onChange={(event) => { solanaSwapAttempt.current += 1; setSolanaSwapRouteId(event.target.value); setSolanaSwapVerification(undefined); setSolanaSwapVerificationState("idle"); setSolanaSwapError(""); }}>{solanaSplRouteManifest.routes.map((route) => <option key={route.venueId} value={route.venueId}>{route.venueId} · {route.chainId}</option>)}</select></label>
          <div className="asset-import"><div><FileJson size={18} /><span><strong>Inspect unsigned Solana swap intent</strong><small>Unsigned v0 transaction, exact account roles, blockhash lifetime, amount, min-out, and quote expiry</small></span></div><label className="manifest-button">Inspect transaction JSON<input type="file" accept="application/json,.json" aria-label="Inspect unsigned Solana swap intent" onChange={(event) => void inspectSolanaSwapIntent(event.target.files?.[0])} /></label></div>
          {solanaSwapIntent && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{solanaSwapIntent.venueId}</strong><small>{solanaSwapIntent.chainId} · slippage {solanaSwapIntent.slippageBps} bps · last valid block height {solanaSwapIntent.lastValidBlockHeight}</small><code>{solanaSwapIntent.amountInBaseUnits} base units → quoted {solanaSwapIntent.expectedOutBaseUnits} · min {solanaSwapIntent.minimumOutBaseUnits}</code></span></div>}
          <div className="release-rpc-grid">{(solanaReadPolicy?.policy.rpcEndpoints ?? ["", ""]).map((value, index) => <label className="field" key={index}><span>Policy-bound Solana RPC {index === 0 ? "A" : "B"}</span><input type="url" value={value} readOnly placeholder="Signed policy required" aria-label={`Policy-bound Solana RPC ${index === 0 ? "A" : "B"}`} /></label>)}</div>
          <button className="secondary-button release-verify-button" type="button" disabled={!solanaSwapIntent || !solanaReadPolicy || solanaSwapVerificationState === "checking"} onClick={() => void verifySolanaSwapSimulation()}>{solanaSwapVerificationState === "checking" ? "Re-verifying route, policy, quote, and simulations…" : "Verify policy-bound quote + simulations"}</button>
          <p className="action-note">This exposes the unsigned transaction and account addresses only to the two hosts authenticated by the signed read policy and sends bounded JSON-RPC POST requests for genesis, current slot, exact pool/vault state, block height, blockhash validity, program identity, and simulation. It never calls sendTransaction or requests a wallet signature.</p>
        </div>}
        {solanaSwapVerification && <div className="bridge-status ok"><Check size={17} /><span><strong>Source-bound Solana quote + simulation verified · signing and submission still blocked</strong><small>{solanaSwapVerification.quote.observations.length} quote readers and {solanaSwapVerification.observations.length} simulation readers agreed · reserves {solanaSwapVerification.quote.sourceReserveBaseUnits}/{solanaSwapVerification.quote.destinationReserveBaseUnits} · output {solanaSwapVerification.quote.expectedOutBaseUnits} · protocol trade fees {solanaSwapVerification.quote.tradeFeeBaseUnits}+{solanaSwapVerification.quote.ownerTradeFeeBaseUnits} · network fee {solanaSwapVerification.feeLamports} lamports</small></span></div>}
        {solanaSwapError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Solana transaction simulation rejected: {solanaSwapError}</span></div>}
        {solanaReadPolicyError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Solana read policy rejected: {solanaReadPolicyError}</span></div>}
        {solanaSplRouteError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Solana SPL route rejected: {solanaSplRouteError}</span></div>}
        {solanaVenueError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Solana venue rejected: {solanaVenueError}</span></div>}
        <div className="risk-callout source-trust-warning"><CircleAlert size={18} /><span><strong>An Ed25519 source signature proves only which publisher authorized the exact venue identity.</strong> Current ProgramData bytes, pool state, quote, balances, token behavior, blockhash lifetime, wallet authorization, and recovery remain separately fail-closed.</span></div>
      </div>
      <div className="asset-source-stack">
        <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Session-pin a Cosmos venue source</strong><small>Exact secp256k1 publisher, CAIP-2 chain scope, and review evidence · page memory only</small></span></div><label className="manifest-button">Pin Cosmos source<input type="file" accept="application/json,.json" aria-label="Pin Cosmos venue source" onChange={(event) => void pinCosmosVenueSource(event.target.files?.[0])} /></label></div>
        {cosmosVenueSource && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{cosmosVenueSource.name}</strong><small>{cosmosVenueSource.id} · {shortFingerprint(cosmosVenueSource.signerPublicKeyBase64)}</small><code>{shortFingerprint(cosmosVenueSourceFingerprintValue)}</code></span></div>}
        <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Signed Osmosis route manifest</strong><small>Publisher signature, expiry, revision head, exact pool sequence, hop denoms, chain scope, and evidence</small></span></div><label className={`manifest-button ${cosmosVenueSource && cosmosVenueVerificationState !== "checking" ? "" : "disabled"}`}>{cosmosVenueVerificationState === "checking" ? "Checking secp256k1 signature…" : "Verify Osmosis JSON"}<input disabled={!cosmosVenueSource || cosmosVenueVerificationState === "checking"} type="file" accept="application/json,.json" aria-label="Verify signed Osmosis route manifest" onChange={(event) => void inspectCosmosVenueManifest(event.target.files?.[0])} /></label></div>
        {cosmosVenueManifest && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed Osmosis routes accepted · broadcast still blocked</strong><small>{cosmosVenueManifest.routes.length} route record{cosmosVenueManifest.routes.length === 1 ? "" : "s"} · revision {cosmosVenueManifest.manifest.revision} · each TxRaw must freshly re-verify this signature and pass two independent REST simulations.</small></span></div>}
        <div className="asset-import"><div><Fingerprint size={18} /><span><strong>Session-pin a Cosmos read-policy source</strong><small>Independent secp256k1 reviewer, CAIP-2 chain scope, and REST policy evidence · page memory only</small></span></div><label className="manifest-button">Pin read-policy source<input type="file" accept="application/json,.json" aria-label="Pin Cosmos read policy source" onChange={(event) => void pinCosmosReadPolicySource(event.target.files?.[0])} /></label></div>
        {cosmosReadPolicySource && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{cosmosReadPolicySource.name}</strong><small>{cosmosReadPolicySource.id} · {shortFingerprint(cosmosReadPolicySource.signerPublicKeyBase64)}</small><code>{shortFingerprint(cosmosReadPolicyFingerprintValue)}</code></span></div>}
        <div className="asset-import"><div><ShieldCheck size={18} /><span><strong>Signed Cosmos simulation read policy</strong><small>Exact chain, REST pair, boundary version, expiry, monotonic revision, and evidence</small></span></div><label className={`manifest-button ${cosmosReadPolicySource && cosmosReadPolicyState !== "checking" ? "" : "disabled"}`}>{cosmosReadPolicyState === "checking" ? "Checking read policy…" : "Verify read-policy JSON"}<input disabled={!cosmosReadPolicySource || cosmosReadPolicyState === "checking"} type="file" accept="application/json,.json" aria-label="Verify signed Cosmos read policy" onChange={(event) => void inspectCosmosReadPolicy(event.target.files?.[0])} /></label></div>
        {cosmosReadPolicy && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Signed Cosmos read policy accepted · execution still blocked</strong><small>{cosmosReadPolicy.policy.chainId} · revision {cosmosReadPolicy.policy.revision} · {cosmosReadPolicy.policy.restEndpoints.map((endpoint) => new URL(endpoint).hostname).join(" + ")} · readers are recreated only from this signed pair.</small></span></div>}
        {cosmosVenueManifest && cosmosReadPolicy && <div className="release-rpc-check" aria-busy={cosmosSwapVerificationState === "checking"}>
          <div className="release-rpc-heading"><Network size={18} /><span><strong>Policy-bound Cosmos TxRaw simulation quorum</strong><small>Exact signed route + signed read policy + unsigned canonical TxRaw · page memory only</small></span></div>
          <label className="field"><span>Signed Osmosis route</span><select aria-label="Signed Osmosis route" value={cosmosSwapRouteId} onChange={(event) => { cosmosSwapAttempt.current += 1; setCosmosSwapRouteId(event.target.value); setCosmosSwapVerification(undefined); setCosmosSwapVerificationState("idle"); setCosmosSwapError(""); }}>{cosmosVenueManifest.routes.map((route) => <option key={route.venueId} value={route.venueId}>{route.venueId} · {route.chainId} · pools {route.hops.map((hop) => hop.poolId).join(" → ")}</option>)}</select></label>
          <div className="asset-import"><div><FileJson size={18} /><span><strong>Inspect unsigned Cosmos swap intent</strong><small>Canonical TxRaw, exact account/sequence, fee, timeout, amount, min-out, and quote expiry</small></span></div><label className="manifest-button">Inspect TxRaw JSON<input type="file" accept="application/json,.json" aria-label="Inspect unsigned Cosmos swap intent" onChange={(event) => void inspectCosmosSwapIntent(event.target.files?.[0])} /></label></div>
          {cosmosSwapIntent && <div className="source-pin-status"><ShieldCheck size={17} /><span><strong>{cosmosSwapIntent.venueId}</strong><small>{cosmosSwapIntent.chainId} · sequence {cosmosSwapIntent.sequence} · timeout height {cosmosSwapIntent.timeoutHeight}</small><code>{cosmosSwapIntent.amountInBaseUnits} {cosmosSwapIntent.sourceDenom} → min {cosmosSwapIntent.minimumOutBaseUnits} {cosmosSwapIntent.destinationDenom}</code></span></div>}
          <div className="release-rpc-grid">{cosmosReadPolicy.policy.restEndpoints.map((value, index) => <label className="field" key={index}><span>Policy-bound Cosmos REST {index === 0 ? "A" : "B"}</span><input readOnly type="url" value={value} autoComplete="off" spellCheck={false} aria-label={`Cosmos simulation REST ${index === 0 ? "A" : "B"}`} /></label>)}</div>
          <button className="secondary-button release-verify-button" type="button" disabled={!cosmosSwapIntent || cosmosSwapVerificationState === "checking"} onClick={() => void verifyCosmosSwapSimulation()}>{cosmosSwapVerificationState === "checking" ? "Re-verifying route, policy, and 2 REST simulations…" : "Verify policy-bound TxRaw simulations"}</button>
          <p className="action-note">This exposes the unsigned transaction and account address only to the two hosts authenticated by the signed read policy, performs bounded GET queries and POST /cosmos/tx/v1beta1/simulate, and never requests a wallet signature or calls the broadcast endpoint.</p>
        </div>}
        {cosmosSwapVerification && <div className="bridge-status ok"><Check size={17} /><span><strong>Source-bound TxRaw simulation verified · separate signing review required · broadcast blocked</strong><small>{cosmosSwapVerification.observations.length} independent REST hosts agreed · debit {cosmosSwapVerification.sourceDebitBaseUnits} · credit {cosmosSwapVerification.destinationCreditBaseUnits} · gas used {cosmosSwapVerification.gasUsed} · intent {shortFingerprint(cosmosSwapVerification.intentSha256)}</small></span></div>}
        {cosmosSwapVerification && cosmosSwapIntent && cosmosVenueManifest && cosmosVenueManifest.routes.filter(route => route.venueId === cosmosSwapVerification.venueId).map(route => <CosmosInjectedConnectionPanel key={route.venueId} renderSelectedAccount={selection => <CosmosSigningReviewPanel {...selection} route={route} intent={cosmosSwapIntent} verified={cosmosSwapVerification} recoveryPolicy={cosmosReadPolicy} readRecoveryPolicyHead={readCosmosReadPolicyHead} />} />)}
        {cosmosSwapError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Cosmos TxRaw simulation rejected: {cosmosSwapError}</span></div>}
        {cosmosReadPolicyError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Cosmos read policy rejected: {cosmosReadPolicyError}</span></div>}
        {cosmosVenueError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Cosmos venue rejected: {cosmosVenueError}</span></div>}
        <div className="risk-callout source-trust-warning"><CircleAlert size={18} /><span><strong>This custom publisher signature proves route provenance only; it is not a Cosmos wallet or transaction authorization.</strong> Current pool state, quote, balances, sequence, fee, timeout, wallet authorization, TxRaw signature, simulation, and recovery remain separately fail-closed.</span></div>
      </div>
      <div className="route-registry-summary"><Waypoints size={18} /><span><strong>{routes.length} direct routes in the common registry</strong><small>Only an exact installed adapter may produce a bound quote. Registration alone cannot request a signature.</small></span></div>
      <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Every bridge route below carries a second gate · the badge is not the whole condition</strong><small>Executable here means the descriptor and its adapter are installed. Each route still needs its own release before a signature can be requested: the CCTP routes need a signed asset release reviewed on the Bridge screen, and the IBC routes need a pinned signed route source. Neither is loaded by default, so none of these routes can be signed as the screen stands.</small></span></div>
      <div className="universe-list">{routes.map((route) => <article className="universe-item route-item" key={route.id}>
        <div className="universe-item-head"><span className="namespace-chip">{route.operation}</span><StateBadge state={route.state} /></div>
        <strong className="route-assets"><code>{assetLabel(route.sourceAsset)}</code><ArrowRight size={13} /><code>{assetLabel(route.destinationAsset)}</code></strong>
        <p>{route.trustBoundary}</p>
        <dl><div><dt>Source asset</dt><dd>{route.sourceAsset}</dd></div><div><dt>Destination asset</dt><dd>{route.destinationAsset}</dd></div><div><dt>Adapter</dt><dd>{route.adapterId}</dd></div><div><dt>Wallet</dt><dd>{route.walletCapabilityIds.join(", ")}</dd></div><div><dt>Execution target</dt><dd>{route.sourceExecutionTarget}</dd></div><div><dt>Method</dt><dd>{route.executionMethod}</dd></div><div><dt>Release</dt><dd>{route.adapterId === "cctp-v2" ? "Signed CCTP asset release required before any signature" : "Pinned signed route source required before any broadcast"}</dd></div><div><dt>Quote TTL cap</dt><dd>{route.maximumQuoteTtlMs / 1000}s</dd></div><div><dt>Finality</dt><dd>{route.finalityTracking}</dd></div></dl>
      </article>)}</div>
    </>}

    {view === "deployments" && <>
      <div className="risk-callout universe-principle"><LockKeyhole size={18} /><span><strong>Release evidence check is read-only.</strong> This screen can inspect public deployment evidence, but it cannot deploy contracts, access a private key, or add liquidity. Deploy your own Factory and Router with scripts/deployEvm.mjs and load the file it writes.</span></div>
      <label className="field release-network"><span>Network</span><select aria-label="Network" value={deploymentNetwork} onChange={(event) => selectDeploymentNetwork(event.target.value as EvmNetworkId)}>{Object.values(EVM_NETWORKS).map((network) => <option key={network.id} value={network.id}>{network.name} · {network.id} · {network.environment}</option>)}</select></label>
      <div className="asset-import"><div><FileJson size={18} /><span><strong>Deployment evidence</strong><small>Exact source bundle, compiler, runtime code, receipts, and public evidence URLs</small></span></div><label className="manifest-button">Inspect evidence<input type="file" accept="application/json,.json" onChange={(event) => void inspectDeploymentManifest(event.target.files?.[0])} /></label></div>
      {deploymentManifest && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>Evidence structure accepted · execution still blocked</strong><small>{deploymentManifest.releaseId} · {deploymentManifest.network.caip2} · two independent RPC observations are still required.</small></span></div>}
      {deploymentManifest && <div className="release-rpc-check" aria-busy={deploymentVerificationState === "checking"}>
        <div className="release-rpc-heading"><ShieldCheck size={18} /><span><strong>Read-only on-chain verification</strong><small>Use two public HTTPS RPC endpoints on different hosts. URLs are held only in this page state; credentials, query parameters, localhost, and private-network addresses are rejected.</small></span></div>
        <div className="release-rpc-grid">
          {deploymentRpcUrls.map((value, index) => <label className="field" key={index}><span>Public RPC {index === 0 ? "A" : "B"}</span><input type="url" value={value} autoComplete="off" spellCheck={false} placeholder={`https://rpc-${index === 0 ? "a" : "b"}.example`} aria-label={`Public RPC ${index === 0 ? "A" : "B"}`} onChange={(event) => {
            deploymentAttempt.current += 1;
            const next = [...deploymentRpcUrls] as [string, string]; next[index] = event.target.value;
            setDeploymentRpcUrls(next); setDeploymentVerification(undefined); setDeploymentVerificationState("idle"); setDeploymentError("");
          }} /></label>)}
        </div>
        <button className="secondary-button release-verify-button" type="button" disabled={deploymentVerificationState === "checking" || deploymentRpcUrls.some((value) => !value.trim())} onClick={() => void verifyDeploymentOnChain()}>{deploymentVerificationState === "checking" ? "Checking chain, receipts, and code…" : "Verify with 2 public RPCs"}</button>
        <p className="action-note">This sends only eth_chainId, eth_blockNumber, eth_getCode, and eth_getTransactionReceipt. It never requests an account, signature, transaction, deployment, or liquidity.</p>
      </div>}
      {deploymentVerification && <div className="bridge-status ok"><Check size={17} /><span><strong>On-chain evidence verified · execution still blocked</strong><small>{deploymentVerification.observations.length} distinct RPC hosts agreed on chain, deployment receipts, and exact Factory + Router runtime code.</small></span></div>}
      {deploymentError && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Deployment evidence rejected: {deploymentError}</span></div>}
      {!matchingDeployment && selectedNetwork.environment === "mainnet" && <div className="bridge-status blocked"><LockKeyhole size={17} /><span><strong>NETWORK_CONTRACTS_NOT_CONFIGURED</strong><small>{networkContractsMessage(selectedNetwork)}</small></span></div>}
      {deploymentMatches && <div className="universe-list"><article className="universe-item route-item release-item">
        <div className="universe-item-head"><span className="namespace-chip">{selectedNetwork.environment}</span><StateBadge state="design-gate" /></div>
        <strong>{selectedNetwork.name}</strong><p>Contracts are deployed and configured by you · no deployment action is exposed</p>
        <dl><div><dt>Chain</dt><dd>{selectedNetwork.id}</dd></div><div><dt>Required RPC quorum</dt><dd>2 independent readers</dd></div><div><dt>Factory</dt><dd>{matchingDeployment?.contracts.factory.address ?? (selectedNetwork.environment === "mainnet" ? "Not configured" : "Deployment receipt required")}</dd></div><div><dt>Router</dt><dd>{matchingDeployment?.contracts.router.address ?? (selectedNetwork.environment === "mainnet" ? "Not configured" : "Deployment receipt required")}</dd></div><div><dt>Source bundle</dt><dd>{deploymentManifest ? shortFingerprint(deploymentManifest.source.bundleSha256) : "SHA-256 binding required"}</dd></div><div><dt>Runtime identity</dt><dd>Exact pinned Factory + Router bytecode</dd></div><div><dt>Release state</dt><dd>{deploymentVerification ? "On-chain evidence verified; execution blocked" : deploymentManifest ? "Structure checked; on-chain quorum pending" : "No evidence loaded"}</dd></div><div><dt>Environment</dt><dd>{selectedNetwork.environment}</dd></div></dl>
      </article></div>}
    </>}

    {!((view === "chains" ? chains : view === "wallets" ? wallets : view === "assets" ? assets : view === "routes" ? routes : deploymentMatches ? ["release"] : []).length) && <div className="universe-empty"><LockKeyhole size={18} /><span>No matching registry entry. Discovery must not be mistaken for executable support.</span></div>}
    <div className="universe-legend">{(Object.keys(STATUS) as CapabilityState[]).map((state) => <span key={state}><StateBadge state={state} /><small>{STATUS[state].detail}</small></span>)}</div>
  </div>;
}

function StateBadge({ state }: { state: CapabilityState }) {
  return <span className={`capability-badge ${state}`}>{state === "ready" ? <Check size={12} /> : state === "partial" ? <CircleAlert size={12} /> : <LockKeyhole size={12} />}{STATUS[state].label}</span>;
}

function assetLabel(assetType: string): string {
  const asset = BUILT_IN_ASSETS.find((item) => item.assetType === assetType);
  if (asset) return `${asset.symbol} · ${assetType.slice(0, assetType.indexOf("/"))}`;
  return assetType;
}

function readAssetSourceHead(fingerprint: string): AssetSourceHead | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(`localswap-asset-source-head:${fingerprint}`) ?? "null") as Partial<AssetSourceHead> | null;
    if (!parsed || !Number.isInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^0x[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) return undefined;
    return parsed as AssetSourceHead;
  } catch { return undefined; }
}

function writeAssetSourceHead(fingerprint: string, head: AssetSourceHead) {
  try { localStorage.setItem(`localswap-asset-source-head:${fingerprint}`, JSON.stringify(head)); } catch { /* session validation still applies */ }
}

function readVenueSourceHead(fingerprint: string): ExternalEvmV2VenueSourceHead | undefined {
  const key = `realdex-external-v2-source-head:${fingerprint}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored) as Partial<ExternalEvmV2VenueSourceHead> | null;
    if (!parsed || !Number.isInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^0x[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) throw new Error();
    return parsed as ExternalEvmV2VenueSourceHead;
  } catch { throw new Error("EXTERNAL_V2_MANIFEST_HEAD_INVALID"); }
}

function writeVenueSourceHead(fingerprint: string, head: ExternalEvmV2VenueSourceHead) {
  const key = `realdex-external-v2-source-head:${fingerprint}`;
  const serialized = JSON.stringify(head);
  try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error(); }
  catch { throw new Error("EXTERNAL_V2_MANIFEST_HEAD_PERSIST_FAILED"); }
}

function readVenueReadPolicyHead(fingerprint: string): ExternalEvmV2ReadPolicyHead | undefined {
  const key = `realdex-external-v2-read-policy-head:${fingerprint}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored) as Partial<ExternalEvmV2ReadPolicyHead> | null;
    if (!parsed || !Number.isInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^0x[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) throw new Error();
    return parsed as ExternalEvmV2ReadPolicyHead;
  } catch { throw new Error("EXTERNAL_V2_READ_POLICY_HEAD_INVALID"); }
}

function writeVenueReadPolicyHead(fingerprint: string, head: ExternalEvmV2ReadPolicyHead): void {
  const key = `realdex-external-v2-read-policy-head:${fingerprint}`;
  const serialized = JSON.stringify(head);
  try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error(); }
  catch { throw new Error("EXTERNAL_V2_READ_POLICY_HEAD_PERSIST_FAILED"); }
}

function readSolanaVenueSourceHead(fingerprint: string): SolanaVenueSourceHead | undefined {
  const key = `realdex-solana-venue-source-head:${fingerprint}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored) as Partial<SolanaVenueSourceHead> | null;
    if (!parsed || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) throw new Error("SOLANA_VENUE_MANIFEST_HEAD_INVALID");
    return parsed as SolanaVenueSourceHead;
  } catch { throw new Error("SOLANA_VENUE_MANIFEST_HEAD_INVALID"); }
}

function writeSolanaVenueSourceHead(fingerprint: string, head: SolanaVenueSourceHead): void {
  const key = `realdex-solana-venue-source-head:${fingerprint}`;
  const serialized = JSON.stringify(head);
  try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error(); }
  catch { throw new Error("SOLANA_VENUE_MANIFEST_HEAD_PERSIST_FAILED"); }
}

function readSolanaSplRouteSourceHead(fingerprint: string): SolanaSplRouteSourceHead | undefined {
  const key = `realdex-solana-spl-route-source-head:${fingerprint}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored) as Partial<SolanaSplRouteSourceHead> | null;
    if (!parsed || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) throw new Error("SOLANA_SPL_ROUTE_MANIFEST_HEAD_INVALID");
    return parsed as SolanaSplRouteSourceHead;
  } catch { throw new Error("SOLANA_SPL_ROUTE_MANIFEST_HEAD_INVALID"); }
}

function writeSolanaSplRouteSourceHead(fingerprint: string, head: SolanaSplRouteSourceHead): void {
  const key = `realdex-solana-spl-route-source-head:${fingerprint}`;
  const serialized = JSON.stringify(head);
  try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error(); }
  catch { throw new Error("SOLANA_SPL_ROUTE_MANIFEST_HEAD_PERSIST_FAILED"); }
}

function readSolanaReadPolicyHead(fingerprint: string): SolanaReadPolicyHead | undefined {
  const key = `realdex-solana-read-policy-head:${fingerprint}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored) as Partial<SolanaReadPolicyHead> | null;
    if (!parsed || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) throw new Error("SOLANA_READ_POLICY_HEAD_INVALID");
    return parsed as SolanaReadPolicyHead;
  } catch { throw new Error("SOLANA_READ_POLICY_HEAD_INVALID"); }
}

function writeSolanaReadPolicyHead(fingerprint: string, head: SolanaReadPolicyHead): void {
  const key = `realdex-solana-read-policy-head:${fingerprint}`;
  const serialized = JSON.stringify(head);
  try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error(); }
  catch { throw new Error("SOLANA_READ_POLICY_HEAD_PERSIST_FAILED"); }
}

function readCosmosVenueSourceHead(fingerprint: string): CosmosVenueSourceHead | undefined {
  const key = `realdex-cosmos-venue-source-head:${fingerprint}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored) as Partial<CosmosVenueSourceHead> | null;
    if (!parsed || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) throw new Error("COSMOS_VENUE_MANIFEST_HEAD_INVALID");
    return parsed as CosmosVenueSourceHead;
  } catch { throw new Error("COSMOS_VENUE_MANIFEST_HEAD_INVALID"); }
}

function writeCosmosVenueSourceHead(fingerprint: string, head: CosmosVenueSourceHead): void {
  const key = `realdex-cosmos-venue-source-head:${fingerprint}`;
  const serialized = JSON.stringify(head);
  try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error(); }
  catch { throw new Error("COSMOS_VENUE_MANIFEST_HEAD_PERSIST_FAILED"); }
}

function readCosmosReadPolicyHead(fingerprint: string): CosmosReadPolicyHead | undefined {
  const key = `realdex-cosmos-read-policy-head:${fingerprint}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored) as Partial<CosmosReadPolicyHead> | null;
    if (!parsed || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) throw new Error("COSMOS_READ_POLICY_HEAD_INVALID");
    return parsed as CosmosReadPolicyHead;
  } catch { throw new Error("COSMOS_READ_POLICY_HEAD_INVALID"); }
}

function writeCosmosReadPolicyHead(fingerprint: string, head: CosmosReadPolicyHead): void {
  const key = `realdex-cosmos-read-policy-head:${fingerprint}`;
  const serialized = JSON.stringify(head);
  try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error(); }
  catch { throw new Error("COSMOS_READ_POLICY_HEAD_PERSIST_FAILED"); }
}

function readBitcoinReadPolicyHead(fingerprint: string): BitcoinReadPolicyHead | undefined {
  try {
    const stored = localStorage.getItem(`realdex-bitcoin-read-policy-head:${fingerprint}`);
    if (stored === null) return undefined;
    const parsed = JSON.parse(stored) as Partial<BitcoinReadPolicyHead> | null;
    if (!parsed || !Number.isInteger(parsed.revision) || Number(parsed.revision) <= 0 || !/^0x[0-9a-f]{64}$/.test(parsed.payloadHash ?? "")) throw new Error("BITCOIN_READ_POLICY_HEAD_INVALID");
    return parsed as BitcoinReadPolicyHead;
  } catch (reason) { if (reason instanceof Error && reason.message === "BITCOIN_READ_POLICY_HEAD_INVALID") throw reason; throw new Error("BITCOIN_READ_POLICY_HEAD_INVALID"); }
}

function writeBitcoinReadPolicyHead(fingerprint: string, head: BitcoinReadPolicyHead): void {
  const key = `realdex-bitcoin-read-policy-head:${fingerprint}`;
  const serialized = JSON.stringify(head);
  try { localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) throw new Error("BITCOIN_READ_POLICY_HEAD_PERSIST_FAILED"); }
  catch { throw new Error("BITCOIN_READ_POLICY_HEAD_PERSIST_FAILED"); }
}

function shortFingerprint(value: string) {
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function formatMilliFeeRate(value: string): string {
  const milli = BigInt(value);
  return `${milli / 1_000n}.${(milli % 1_000n).toString().padStart(3, "0")}`;
}

function observedAssetMetadata(observed: NonNullable<OnChainAssetCheck["observed"]>) {
  return [observed.symbol, observed.name, `${observed.decimals} decimals`, observed.authority].filter(Boolean).join(" · ");
}

function optionalReaderQuorum<T>(urls: readonly [string, string], create: (values: readonly string[]) => T[]): T[] | undefined {
  if (urls.every((value) => !value.trim())) return undefined;
  return create(urls);
}

function sourceErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    SIGNED_MANIFEST_SIGNATURE_INVALID: "The manifest has no valid EIP-191 signature and was rejected.",
    SIGNED_MANIFEST_SIGNER_NOT_PINNED: "The signature does not match the session-pinned signer.",
    SIGNED_MANIFEST_EXPIRED: "The signed manifest has expired.",
    SIGNED_MANIFEST_ROLLBACK_BLOCKED: "An older signed revision was blocked by the stored source head.",
    SIGNED_MANIFEST_REVISION_CONFLICT: "The same revision has a different signed payload and was blocked.",
    SIGNED_MANIFEST_CHAIN_NOT_ALLOWED: "The manifest contains a chain outside the pinned source scope.",
    IMPORTED_ASSET_CANNOT_ENABLE_EXECUTION: "Imported and signed metadata cannot enable execution.",
    NON_EVM_ENDPOINT_NOT_PUBLIC: "Non-EVM readers must be public HTTPS endpoints without credentials, query parameters, fragments, localhost, or private-network addresses.",
    NON_EVM_READER_QUORUM_REQUIRED: "Enter both public reader endpoints for each configured non-EVM family, or leave both blank.",
    NON_EVM_READER_QUORUM_NOT_INDEPENDENT: "The two non-EVM readers must use distinct public hosts. Different paths on one host are not independent."
  };
  return known[message] ?? message;
}

function externalVenueErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    EXTERNAL_V2_SOURCE_SIGNER_INVALID: "The pinned venue source signer is invalid.",
    EXTERNAL_V2_SOURCE_CHAINS_INVALID: "The venue source must declare a unique EIP-155 chain scope.",
    EXTERNAL_V2_MANIFEST_SOURCE_MISMATCH: "The signed manifest does not bind the exact pinned venue source fingerprint.",
    EXTERNAL_V2_MANIFEST_SIGNATURE_INVALID: "The venue manifest has no valid EIP-191 signature.",
    EXTERNAL_V2_MANIFEST_SIGNER_NOT_PINNED: "The venue manifest signature does not match the pinned signer.",
    EXTERNAL_V2_MANIFEST_EXPIRED: "The signed venue manifest has expired.",
    EXTERNAL_V2_MANIFEST_ROLLBACK_BLOCKED: "An older venue revision was blocked by the stored source head.",
    EXTERNAL_V2_MANIFEST_REVISION_CONFLICT: "The same venue revision has a different signed payload and was blocked.",
    EXTERNAL_V2_MANIFEST_HEAD_INVALID: "The stored External V2 venue revision head is malformed; acceptance stopped safely.",
    EXTERNAL_V2_MANIFEST_HEAD_PERSIST_FAILED: "The verified External V2 venue head could not be persisted and was not accepted.",
    EXTERNAL_V2_MANIFEST_CHAIN_NOT_ALLOWED: "A signed venue uses a chain outside the pinned source scope.",
    EXTERNAL_V2_MANIFEST_VENUE_DUPLICATE: "The manifest repeats a venue identity or exact venue fingerprint.",
    DEPLOYMENT_RPC_URL_INVALID: "Enter two valid public HTTPS venue RPC URLs.",
    DEPLOYMENT_RPC_URL_NOT_PUBLIC: "Venue RPC URLs must be public HTTPS endpoints without credentials, query parameters, fragments, localhost, or private-network addresses.",
    DEPLOYMENT_RPC_ENDPOINTS_NOT_INDEPENDENT: "Use two distinct venue RPC hosts; two paths on one host are not independent.",
    EXTERNAL_V2_SOURCE_RPC_QUORUM_INVALID: "Exactly two independently identified venue RPC readers are required.",
    EXTERNAL_V2_SOURCE_RPC_TIMEOUT: "A venue RPC timed out. No identity result was inferred.",
    EXTERNAL_V2_SOURCE_RPC_HTTP_FAILED: "A venue RPC returned an HTTP failure. No identity result was inferred.",
    EXTERNAL_V2_SOURCE_RPC_RESPONSE_INVALID: "A venue RPC returned an invalid or error response.",
    EXTERNAL_V2_CHAIN_MISMATCH: "At least one venue RPC is serving the wrong chain.",
    EXTERNAL_V2_ROUTER_CODE_MISMATCH: "Current Router code differs from the exact signed runtime hash.",
    EXTERNAL_V2_FACTORY_CODE_MISMATCH: "Current Factory code differs from the exact signed runtime hash.",
    EXTERNAL_V2_PAIR_CODE_MISMATCH: "Current Pair code differs from the exact signed runtime hash.",
    EXTERNAL_V2_ROUTER_FACTORY_MISMATCH: "The Router no longer points to the signed Factory.",
    EXTERNAL_V2_FACTORY_PAIR_MISMATCH: "The Factory no longer returns the signed Pair for this path.",
    EXTERNAL_V2_PAIR_FACTORY_MISMATCH: "A Pair no longer reports the signed Factory.",
    EXTERNAL_V2_PAIR_TOKENS_MISMATCH: "A Pair token identity differs from the signed path.",
    EXTERNAL_V2_MANIFEST_VENUE_NOT_FOUND: "The selected venue is absent from the freshly verified signed manifest.",
    EXTERNAL_V2_READ_POLICY_VENUE_CHAIN_MISMATCH: "The signed read policy targets a different EVM chain than the selected signed venue.",
    EXTERNAL_V2_READ_POLICY_REVIEWER_NOT_INDEPENDENT: "The read policy must use a different EIP-191 reviewer address from the venue publisher.",
    EXTERNAL_V2_READ_POLICY_VERIFICATION_INVALID: "The accepted External V2 read-policy evidence changed or is no longer valid.",
    EXTERNAL_V2_QUOTE_INTENT_INVALID: "The External V2 quote intent contains missing or unknown fields.",
    EXTERNAL_V2_QUOTE_INTENT_IDENTITY_INVALID: "The External V2 quote intent has an invalid venue, chain, amount, or slippage value.",
    EXTERNAL_V2_QUOTE_INTENT_AMOUNT_INVALID: "The External V2 input amount exceeds the uint256 transaction boundary.",
    EXTERNAL_V2_QUOTE_INTENT_RECIPIENT_INVALID: "The External V2 recipient must be one exact non-zero EVM address.",
    EXTERNAL_V2_QUOTE_INTENT_EXPIRED: "The External V2 quote intent has expired; inspect a fresh intent.",
    EXTERNAL_V2_QUOTE_INTENT_VALIDITY_INVALID: "The External V2 quote intent lifetime must be positive and at most five minutes.",
    EXTERNAL_V2_QUOTE_INTENT_CHAIN_MISMATCH: "The External V2 quote intent targets a different chain than its signed venue.",
    EXTERNAL_V2_QUOTE_RPC_DIVERGED: "The two signed-policy RPC hosts returned different valid quote snapshots; no quote was accepted.",
    EXTERNAL_V2_POLICY_QUOTE_REPORT_INVALID: "The previously accepted External V2 quote evidence is malformed, expired, or no longer authoritative.",
    EXTERNAL_V2_QUOTE_CHANGED_RECONFIRM_REQUIRED: "The fresh two-reader quote changed; the previous quote was discarded and a new explicit review is required.",
    EXTERNAL_V2_QUOTE_EVIDENCE_EXPIRED: "The quote, signed venue manifest, or signed read policy expired; the green quote result was removed automatically.",
    EXTERNAL_V2_ROUTER_QUOTE_DIVERGED: "A Router quote did not match the reserve-derived constant-product output.",
    EXTERNAL_V2_LIQUIDITY_MISSING: "At least one signed path Pair has no usable liquidity.",
    EXTERNAL_V2_DEADLINE_INVALID: "The External V2 quote deadline is no longer safely usable."
  };
  return known[message] ?? externalVenueReadPolicyErrorMessage(reason);
}

function externalVenueReadPolicyErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    EXTERNAL_V2_READ_POLICY_INVALID: "The signed External V2 read policy contains missing or unknown fields.",
    EXTERNAL_V2_READ_POLICY_SOURCE_IDENTITY_INVALID: "The External V2 read-policy source identity is invalid.",
    EXTERNAL_V2_READ_POLICY_SOURCE_SIGNER_INVALID: "The pinned External V2 read-policy reviewer address is invalid.",
    EXTERNAL_V2_READ_POLICY_SOURCE_CHAINS_INVALID: "The External V2 read-policy source must declare a unique EIP-155 chain scope.",
    EXTERNAL_V2_READ_POLICY_SOURCE_MISMATCH: "The signed read policy does not bind the exact pinned source fingerprint.",
    EXTERNAL_V2_READ_POLICY_SIGNATURE_INVALID: "The External V2 read policy has no valid EIP-191 signature.",
    EXTERNAL_V2_READ_POLICY_SIGNER_NOT_PINNED: "The read-policy signature does not match the pinned reviewer.",
    EXTERNAL_V2_READ_POLICY_CHAIN_NOT_ALLOWED: "The signed read policy uses a chain outside the pinned source scope.",
    EXTERNAL_V2_READ_POLICY_BOUNDARY_MISMATCH: "The signed read policy targets a different venue-verification boundary version.",
    EXTERNAL_V2_READ_POLICY_QUOTE_BOUNDARY_MISMATCH: "The signed read policy targets a different quote-verification boundary version.",
    EXTERNAL_V2_READ_POLICY_ENDPOINTS_NOT_PUBLIC_OR_INDEPENDENT: "The signed policy must name two distinct public HTTPS RPC hosts without credentials or private-network addresses.",
    EXTERNAL_V2_READ_POLICY_EXPIRED: "The signed External V2 read policy has expired.",
    EXTERNAL_V2_READ_POLICY_ROLLBACK_BLOCKED: "An older External V2 read-policy revision was blocked by the stored source head.",
    EXTERNAL_V2_READ_POLICY_REVISION_CONFLICT: "The same External V2 read-policy revision has a different signed payload and was blocked.",
    EXTERNAL_V2_READ_POLICY_HEAD_INVALID: "The stored External V2 read-policy revision head is malformed; acceptance stopped safely.",
    EXTERNAL_V2_READ_POLICY_HEAD_PERSIST_FAILED: "The verified External V2 read-policy head could not be persisted and was not accepted."
  };
  return known[message] ?? message;
}

function solanaVenueSourceErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    SOLANA_VENUE_SOURCE_IDENTITY_INVALID: "The Solana venue source identity or Ed25519 public key is invalid.",
    SOLANA_VENUE_SOURCE_CHAINS_INVALID: "The Solana venue source must declare a unique CAIP-2 chain scope.",
    SOLANA_VENUE_MANIFEST_SOURCE_MISMATCH: "The signed manifest does not bind the exact pinned Solana source fingerprint.",
    SOLANA_VENUE_MANIFEST_SIGNATURE_INVALID: "The Solana venue manifest signature encoding is invalid.",
    SOLANA_VENUE_MANIFEST_SIGNER_NOT_PINNED: "The Ed25519 signature does not match the pinned Solana publisher.",
    SOLANA_VENUE_MANIFEST_EXPIRED: "The signed Solana venue manifest has expired.",
    SOLANA_VENUE_MANIFEST_ROLLBACK_BLOCKED: "An older Solana venue revision was blocked by the stored source head.",
    SOLANA_VENUE_MANIFEST_REVISION_CONFLICT: "The same Solana venue revision has a different signed payload and was blocked.",
    SOLANA_VENUE_MANIFEST_CHAIN_NOT_ALLOWED: "A signed Solana venue uses a chain outside the pinned source scope.",
    SOLANA_VENUE_MANIFEST_VENUE_DUPLICATE: "The manifest repeats a Solana venue ID or exact venue fingerprint.",
    SOLANA_VENUE_MANIFEST_HEAD_INVALID: "The stored Solana venue revision head is malformed; acceptance stopped safely.",
    SOLANA_VENUE_MANIFEST_HEAD_PERSIST_FAILED: "The verified Solana venue revision head could not be persisted and was not accepted."
  };
  return known[message] ?? message;
}

function solanaSplRouteSourceErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    SOLANA_SPL_ROUTE_MANIFEST_INVALID: "The signed SPL route manifest contains missing or unknown fields.",
    SOLANA_SPL_ROUTE_MANIFEST_IDENTITY_INVALID: "The SPL route manifest source identity, revision, or timestamp is invalid.",
    SOLANA_SPL_ROUTE_MANIFEST_SIGNATURE_INVALID: "The SPL route manifest signature encoding is invalid.",
    SOLANA_SPL_ROUTE_MANIFEST_SIGNER_NOT_PINNED: "The Ed25519 signature does not match the pinned Solana publisher.",
    SOLANA_SPL_ROUTE_MANIFEST_SOURCE_MISMATCH: "The signed SPL route manifest does not bind the exact pinned Solana source fingerprint.",
    SOLANA_SPL_ROUTE_MANIFEST_EXPIRED: "The signed SPL route manifest has expired.",
    SOLANA_SPL_ROUTE_MANIFEST_VALIDITY_INVALID: "The signed SPL route manifest validity interval is invalid or exceeds 30 days.",
    SOLANA_SPL_ROUTE_MANIFEST_ROLLBACK_BLOCKED: "An older signed SPL route revision was blocked by the stored source head.",
    SOLANA_SPL_ROUTE_MANIFEST_REVISION_CONFLICT: "The same SPL route revision has a different signed payload and was blocked.",
    SOLANA_SPL_ROUTE_MANIFEST_CHAIN_NOT_ALLOWED: "A signed SPL route uses a chain outside the pinned source scope.",
    SOLANA_SPL_ROUTE_MANIFEST_ROUTE_DUPLICATE: "The manifest repeats an SPL route ID or exact route fingerprint.",
    SOLANA_SPL_ROUTE_MANIFEST_HEAD_INVALID: "The stored SPL route revision head is malformed; acceptance stopped safely.",
    SOLANA_SPL_ROUTE_MANIFEST_HEAD_PERSIST_FAILED: "The verified SPL route revision head could not be persisted and was not accepted.",
    SPL_TOKEN_SWAP_ROUTE_INVALID: "An SPL route has invalid or unknown fields, addresses, evidence, or duplicate pool identities."
  };
  return known[message] ?? message;
}

function solanaReadPolicyErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    SOLANA_READ_POLICY_SOURCE_INVALID: "The Solana read-policy source contains missing or unknown fields.",
    SOLANA_READ_POLICY_SOURCE_IDENTITY_INVALID: "The Solana read-policy source identity or Ed25519 public key is invalid.",
    SOLANA_READ_POLICY_SOURCE_CHAINS_INVALID: "The Solana read-policy source must declare a unique CAIP-2 chain scope.",
    SOLANA_READ_POLICY_INVALID: "The signed Solana read policy contains missing or unknown fields.",
    SOLANA_READ_POLICY_SIGNATURE_INVALID: "The Solana read-policy signature encoding is invalid.",
    SOLANA_READ_POLICY_SIGNER_NOT_PINNED: "The read-policy signature does not match the independently pinned Ed25519 reviewer.",
    SOLANA_READ_POLICY_SOURCE_MISMATCH: "The signed read policy does not bind the exact pinned source fingerprint.",
    SOLANA_READ_POLICY_CHAIN_NOT_ALLOWED: "The signed read policy uses a chain outside the pinned source scope.",
    SOLANA_READ_POLICY_BOUNDARY_MISMATCH: "The signed read policy targets different quote or simulation boundary versions.",
    SOLANA_READ_POLICY_ENDPOINTS_NOT_PUBLIC: "Policy RPC endpoints must be public HTTPS without credentials, query parameters, fragments, localhost, or private-network addresses.",
    SOLANA_READ_POLICY_ENDPOINTS_NOT_INDEPENDENT: "The signed read policy must name two different RPC hosts.",
    SOLANA_READ_POLICY_EXPIRED: "The signed Solana read policy has expired.",
    SOLANA_READ_POLICY_VALIDITY_INVALID: "The signed Solana read-policy validity interval is invalid or exceeds 30 days.",
    SOLANA_READ_POLICY_ROLLBACK_BLOCKED: "An older Solana read-policy revision was blocked by the stored head.",
    SOLANA_READ_POLICY_REVISION_CONFLICT: "The same Solana read-policy revision has a different signed payload and was blocked.",
    SOLANA_READ_POLICY_HEAD_INVALID: "The stored Solana read-policy revision head is malformed; acceptance stopped safely.",
    SOLANA_READ_POLICY_HEAD_PERSIST_FAILED: "The verified Solana read-policy head could not be persisted and was not accepted."
  };
  return known[message] ?? message;
}

function solanaSwapErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    SOLANA_SWAP_INTENT_INVALID: "The Solana swap intent contains missing, invalid, or unknown fields.",
    SOLANA_SWAP_INTENT_IDENTITY_INVALID: "The intent does not bind the selected signed SPL route and revision.",
    SOLANA_READ_POLICY_ROUTE_CHAIN_MISMATCH: "The signed read policy targets a different Solana chain than the selected signed route.",
    SOLANA_READ_POLICY_REVIEWER_NOT_INDEPENDENT: "The read policy must use a different Ed25519 reviewer key from the route publisher.",
    SOLANA_READ_POLICY_VERIFICATION_INVALID: "The previously verified read-policy evidence changed or could not be freshly revalidated.",
    SOLANA_SWAP_ENDPOINT_NOT_PUBLIC: "Each Solana RPC endpoint must be public HTTPS without credentials, query parameters, localhost, or private-network addresses.",
    SOLANA_SWAP_READER_QUORUM_REQUIRED: "Exactly two Solana RPC hosts are required.",
    SOLANA_SWAP_READER_QUORUM_NOT_INDEPENDENT: "Use two different Solana RPC hosts; two paths on one host are not independent.",
    SOLANA_SWAP_RPC_FAILED: "A Solana JSON-RPC query or simulation failed. No result was inferred.",
    SOLANA_SWAP_RPC_RESPONSE_INVALID: "A Solana RPC host returned an invalid JSON-RPC, account, or simulation response.",
    SOLANA_SWAP_RPC_RESPONSE_TOO_LARGE: "A Solana RPC response exceeded the bounded reader limit.",
    SOLANA_SWAP_CHAIN_MISMATCH: "At least one Solana RPC host is serving a different genesis chain.",
    SOLANA_SWAP_PROGRAM_IDENTITY_MISMATCH: "Current program or ProgramData bytes differ from the exact signed SPL route.",
    SOLANA_SWAP_BLOCKHASH_EXPIRED: "The transaction blockhash is invalid, expired, or outside the bounded remaining lifetime.",
    SOLANA_SWAP_SIMULATION_QUORUM_MISMATCH: "The two Solana simulations disagree on debit, credit, fee, or compute units.",
    SOLANA_SWAP_SIMULATION_FAILED: "Simulation failed or reported unsafe compute or fee values.",
    SOLANA_SWAP_SIMULATION_ACCOUNT_MISMATCH: "Simulation token account identity differs from the exact intent.",
    SOLANA_SWAP_SIMULATION_AMOUNT_MISMATCH: "Simulation did not show the exact input debit and expected output credit.",
    SOLANA_SWAP_PRE_SIGNED_TRANSACTION_BLOCKED: "A pre-signed Solana transaction was rejected; this screen accepts unsigned simulation input only.",
    SOLANA_SWAP_INSTRUCTION_DECODE_FAILED: "The signed SPL route could not decode the exact transaction instruction.",
    SOLANA_SPL_ROUTE_MANIFEST_ROUTE_NOT_FOUND: "The selected route is absent from the freshly verified signed manifest.",
    SPL_TOKEN_SWAP_QUOTE_INTENT_IDENTITY_INVALID: "The unsigned intent does not bind the exact signed SPL pool, mints, token program, and revision.",
    SPL_TOKEN_SWAP_QUOTE_ENDPOINT_NOT_PUBLIC: "Each quote RPC must be public HTTPS without credentials, query parameters, localhost, or private-network addresses.",
    SPL_TOKEN_SWAP_QUOTE_READER_QUORUM_REQUIRED: "Exactly two SPL quote RPC readers are required.",
    SPL_TOKEN_SWAP_QUOTE_READER_NOT_INDEPENDENT: "Use two different SPL quote RPC hosts; two paths on one host are not independent.",
    SPL_TOKEN_SWAP_QUOTE_RPC_FAILED: "An SPL pool-state JSON-RPC query failed. No quote was inferred.",
    SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_INVALID: "An SPL quote RPC returned an invalid JSON-RPC, slot, or account response.",
    SPL_TOKEN_SWAP_QUOTE_RPC_RESPONSE_TOO_LARGE: "An SPL quote RPC response exceeded the bounded reader limit.",
    SPL_TOKEN_SWAP_QUOTE_CHAIN_MISMATCH: "At least one SPL quote RPC is serving a different genesis chain.",
    SPL_TOKEN_SWAP_QUOTE_SNAPSHOT_STALE: "An SPL pool snapshot is missing, ahead of its reader, or more than 150 slots behind.",
    SPL_TOKEN_SWAP_QUOTE_SNAPSHOT_DIVERGED: "The two SPL quote readers are more than 150 slots apart.",
    SPL_TOKEN_SWAP_QUOTE_QUORUM_MISMATCH: "The two SPL quote readers disagree on reserves, fees, or computed output.",
    SPL_TOKEN_SWAP_QUOTE_STATE_INVALID: "Current swap state differs from the exact signed route or uses an unsupported curve.",
    SPL_TOKEN_SWAP_QUOTE_VAULT_INVALID: "A pool vault has an unexpected mint, authority, token program, state, delegate, or close authority.",
    SPL_TOKEN_SWAP_QUOTE_AUTHORITY_MISMATCH: "The signed swap authority or state bump does not match the program-derived address.",
    SPL_TOKEN_SWAP_QUOTE_FEE_INVALID: "Current SPL pool fee fractions are invalid or consume the complete input.",
    SPL_TOKEN_SWAP_QUOTE_LIQUIDITY_INVALID: "Current vault liquidity cannot produce a positive bounded constant-product output.",
    SPL_TOKEN_SWAP_QUOTE_OUTPUT_MISMATCH: "The self-asserted expected output does not equal the independently computed pool quote.",
    SPL_TOKEN_SWAP_QUOTE_SLIPPAGE_MISMATCH: "The transaction minimum output does not equal the exact bounded slippage floor.",
    SPL_TOKEN_SWAP_QUOTE_EXPIRED: "The SPL pool quote has expired or exceeds the five-minute lifetime."
  };
  return known[message] ?? solanaReadPolicyErrorMessage(reason);
}

function cosmosVenueSourceErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    COSMOS_VENUE_SOURCE_IDENTITY_INVALID: "The Cosmos venue source identity or compressed secp256k1 public key is invalid.",
    COSMOS_VENUE_SOURCE_CHAINS_INVALID: "The Cosmos venue source must declare a unique CAIP-2 chain scope.",
    COSMOS_VENUE_MANIFEST_SOURCE_MISMATCH: "The signed manifest does not bind the exact pinned Cosmos source fingerprint.",
    COSMOS_VENUE_MANIFEST_SIGNATURE_INVALID: "The Osmosis route manifest signature encoding is invalid.",
    COSMOS_VENUE_MANIFEST_SIGNER_NOT_PINNED: "The secp256k1 signature does not match the pinned Cosmos publisher.",
    COSMOS_VENUE_MANIFEST_HIGH_S_SIGNATURE: "A non-canonical high-S Cosmos publisher signature was rejected.",
    COSMOS_VENUE_MANIFEST_EXPIRED: "The signed Osmosis route manifest has expired.",
    COSMOS_VENUE_MANIFEST_ROLLBACK_BLOCKED: "An older Osmosis route revision was blocked by the stored source head.",
    COSMOS_VENUE_MANIFEST_REVISION_CONFLICT: "The same Osmosis route revision has a different signed payload and was blocked.",
    COSMOS_VENUE_MANIFEST_CHAIN_NOT_ALLOWED: "A signed Osmosis route uses a chain outside the pinned source scope.",
    COSMOS_VENUE_MANIFEST_ROUTE_DUPLICATE: "The manifest repeats an Osmosis venue ID or exact route fingerprint.",
    COSMOS_VENUE_MANIFEST_HEAD_INVALID: "The stored Cosmos venue revision head is malformed; acceptance stopped safely.",
    COSMOS_VENUE_MANIFEST_HEAD_PERSIST_FAILED: "The verified Cosmos venue revision head could not be persisted and was not accepted."
  };
  return known[message] ?? message;
}

function cosmosReadPolicyErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    COSMOS_READ_POLICY_INVALID: "The signed Cosmos read policy contains missing or unknown fields.",
    COSMOS_READ_POLICY_SOURCE_IDENTITY_INVALID: "The Cosmos read-policy source identity or compressed secp256k1 reviewer key is invalid.",
    COSMOS_READ_POLICY_SOURCE_CHAINS_INVALID: "The Cosmos read-policy source must declare a unique CAIP-2 chain scope.",
    COSMOS_READ_POLICY_SOURCE_MISMATCH: "The signed read policy does not bind the exact pinned Cosmos source fingerprint.",
    COSMOS_READ_POLICY_SIGNATURE_INVALID: "The Cosmos read-policy signature encoding is invalid.",
    COSMOS_READ_POLICY_SIGNER_NOT_PINNED: "The read-policy signature does not match the pinned Cosmos reviewer.",
    COSMOS_READ_POLICY_HIGH_S_SIGNATURE: "A non-canonical high-S Cosmos read-policy signature was rejected.",
    COSMOS_READ_POLICY_CHAIN_NOT_ALLOWED: "The signed read policy uses a chain outside the pinned source scope.",
    COSMOS_READ_POLICY_BOUNDARY_MISMATCH: "The signed read policy targets a different simulation boundary version.",
    COSMOS_READ_POLICY_ENDPOINTS_NOT_PUBLIC: "Each signed Cosmos REST endpoint must be public HTTPS without credentials, query parameters, localhost, or private-network addresses.",
    COSMOS_READ_POLICY_ENDPOINTS_NOT_INDEPENDENT: "The signed read policy must name two different REST hosts.",
    COSMOS_READ_POLICY_EXPIRED: "The signed Cosmos read policy has expired.",
    COSMOS_READ_POLICY_ROLLBACK_BLOCKED: "An older Cosmos read-policy revision was blocked by the stored source head.",
    COSMOS_READ_POLICY_REVISION_CONFLICT: "The same Cosmos read-policy revision has a different signed payload and was blocked.",
    COSMOS_READ_POLICY_HEAD_INVALID: "The stored Cosmos read-policy revision head is malformed; acceptance stopped safely.",
    COSMOS_READ_POLICY_HEAD_PERSIST_FAILED: "The verified Cosmos read-policy head could not be persisted and was not accepted."
  };
  return known[message] ?? message;
}

function cosmosSwapErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    COSMOS_SWAP_INTENT_INVALID: "The Cosmos swap intent schema contains missing, invalid, or unknown fields.",
    COSMOS_SWAP_INTENT_IDENTITY_INVALID: "The intent does not bind the selected signed route and revision.",
    COSMOS_SWAP_ENDPOINT_NOT_PUBLIC: "Each Cosmos REST endpoint must be public HTTPS without credentials, query parameters, localhost, or private-network addresses.",
    COSMOS_SWAP_READER_QUORUM_REQUIRED: "Exactly two Cosmos REST hosts are required.",
    COSMOS_SWAP_READER_QUORUM_NOT_INDEPENDENT: "Use two different Cosmos REST hosts; two paths on one host are not independent.",
    COSMOS_SWAP_REST_FAILED: "A Cosmos REST query or simulation failed. No result was inferred.",
    COSMOS_SWAP_REST_RESPONSE_INVALID: "A Cosmos REST host returned an invalid account, chain, height, event, or gas response.",
    COSMOS_SWAP_RESPONSE_TOO_LARGE: "A Cosmos REST response exceeded the bounded reader limit.",
    COSMOS_SWAP_CHAIN_MISMATCH: "At least one Cosmos REST host is serving a different chain.",
    COSMOS_SWAP_ACCOUNT_STATE_MISMATCH: "Current account number, sequence, or public key differs from the exact TxRaw intent.",
    COSMOS_SWAP_TIMEOUT_HEIGHT_INVALID: "The signed timeout height is expired or outside the bounded remaining lifetime.",
    COSMOS_SWAP_SIMULATION_QUORUM_MISMATCH: "The two Cosmos REST simulations disagree on debit, credit, or gas.",
    COSMOS_SWAP_SIMULATION_DEBIT_MISMATCH: "Simulation did not show the exact source amount plus fee debit.",
    COSMOS_SWAP_SIMULATION_CREDIT_MISMATCH: "Simulation did not show the exact quoted destination credit above min-out.",
    COSMOS_SWAP_SIMULATION_FAILED: "Simulation failed or reported unsafe gas values.",
    COSMOS_VENUE_MANIFEST_ROUTE_NOT_FOUND: "The selected route is absent from the freshly verified signed manifest.",
    COSMOS_READ_POLICY_ROUTE_CHAIN_MISMATCH: "The signed read policy targets a different Cosmos chain than the selected signed route.",
    COSMOS_READ_POLICY_REVIEWER_NOT_INDEPENDENT: "The read policy must use a different secp256k1 reviewer key from the route publisher.",
    COSMOS_READ_POLICY_VERIFICATION_INVALID: "The accepted Cosmos read-policy evidence changed or is no longer valid."
  };
  return known[message] ?? cosmosReadPolicyErrorMessage(reason);
}

function defaultRpcPair(id: EvmNetworkId): [string, string] {
  const urls = resolveEvmNetwork(id).rpcUrls;
  return [urls[0] ?? "", urls[1] ?? ""];
}

function deploymentErrorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const known: Record<string, string> = {
    DEPLOYMENT_NETWORK_NOT_ALLOWED: "Unknown network. Supported: Base, Base Sepolia, Arbitrum One and Arbitrum Sepolia.",
    DEPLOYMENT_NETWORK_IDENTITY_MISMATCH: "The network name does not match the chain identifier in this manifest.",
    DEPLOYMENT_ENVIRONMENT_MISMATCH: "The manifest environment (mainnet or public-testnet) does not match its network.",
    DEPLOYMENT_SOURCE_IDENTITY_MISMATCH: "The source bundle, compiler settings, or pinned runtime identities do not match this build.",
    DEPLOYMENT_CODE_IDENTITY_MISMATCH: "The claimed Factory or Router runtime identity does not match this build.",
    DEPLOYMENT_EVIDENCE_INVALID: "At least two distinct HTTPS evidence URLs are required.",
    DEPLOYMENT_MANIFEST_INVALID: "The deployment evidence schema contains missing or unknown fields. Secret fields are never accepted.",
    DEPLOYMENT_RPC_URL_INVALID: "Enter two valid public HTTPS RPC URLs.",
    DEPLOYMENT_RPC_URL_NOT_PUBLIC: "RPC URLs must be public HTTPS endpoints without credentials, query parameters, fragments, localhost, or private-network addresses.",
    DEPLOYMENT_RPC_ENDPOINTS_NOT_INDEPENDENT: "Use two distinct RPC hosts; two paths on the same host do not form an independent quorum.",
    DEPLOYMENT_RPC_TIMEOUT: "An RPC timed out. No result was inferred; check both public endpoints before retrying.",
    DEPLOYMENT_RPC_HTTP_FAILED: "An RPC returned an HTTP failure. No deployment status was inferred.",
    DEPLOYMENT_RPC_RESPONSE_INVALID: "An RPC returned an invalid or error response. No deployment status was inferred.",
    DEPLOYMENT_RPC_CHAIN_MISMATCH: "At least one RPC is not serving the chain named in the manifest.",
    DEPLOYMENT_RPC_BEHIND: "At least one RPC has not reached both deployment blocks.",
    DEPLOYMENT_RECEIPT_INVALID: "A deployment receipt is missing, failed, or does not match the claimed contract and block.",
    DEPLOYMENT_RUNTIME_CODE_MISMATCH: "Observed Factory or Router runtime code does not match the exact pinned build."
  };
  return known[message] ?? message;
}
