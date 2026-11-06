import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowRight, Check, CircleAlert, FileJson, LockKeyhole, Network, RadioTower, RefreshCw, ShieldCheck, WalletCards } from "lucide-react";
import { CCTP_ROUTES, canRequestCctpQuote, directionForFamilies, validateRecipient, type CctpDirection, type CctpEstimate } from "./cctp";
import { createPinnedBaseCctpAssetReaders, observeBaseCctpAssetIdentity, type CctpAssetReleaseEvidence } from "./cctp-asset-release";
import CctpReleaseReviewPanel from "./CctpReleaseReviewPanel";
import { IBC_ROUTES, canRequestIbcEstimate, isIbcDirection, validateIbcRecipient, type IbcDirection, type IbcEstimate } from "./ibc";
import { assertExecutableRoute, classifyRoute } from "./engine";
import type { BridgeRoute, BridgeStage, ChainFamily, RouteCategory } from "./types";
import { createInstalledQuoteAdapters, decimalToBaseUnits, expectedBridgeExecutionId } from "../routing/adapters";
import { executeRouteQuote, quoteRoutes } from "../routing/engine";
import { createRouteExecutionIntentId } from "../routing/execution-intent";
import { applyFinalityObservation, checkRouteFinality, clearRouteFinalityReservation, finalityRecordIdentity, finalityTrackingReducer, initialFinalityTrackingState, isTerminalFinalityStage, loadRouteFinalities, persistRouteFinality, reconcileRouteFinalityRecord, reserveRouteFinality, routeFinalityStorageHasCapacity, type FinalityTrackingEvent, type FinalityTrackingState, type RouteFinalityReservation } from "../routing/finality";
import { browserCrossTabExecutionLockManager } from "../routing/cross-tab-execution-lock";
import { withCrossTabFinalityLock } from "../routing/cross-tab-finality-lock";
import { ROUTE_DESCRIPTORS } from "../routing/registry";
import type { RouteExecutionReceipt, RouteFinalityRecord, RouteFinalityStage, RouteQuote, RouteQuoteRequest } from "../routing/types";
import type { SelectableEip1193Provider } from "../wallet/eip6963";
import { createProviderBindingGrant, walletGrantFingerprint } from "../wallet/capabilities";
import type { WalletExecutionGrant } from "../wallet/capabilities";

const FAMILY_OPTIONS: Array<{ value: ChainFamily; label: string; wallet: string }> = [
  { value: "evm", label: "EVM", wallet: "EIP-1193" }, { value: "solana", label: "Solana / SVM", wallet: "Wallet Standard" },
  { value: "cosmos", label: "Cosmos / IBC", wallet: "Cosmos Wallet Standard" }, { value: "bitcoin", label: "Bitcoin", wallet: "PSBT-capable" },
  { value: "move", label: "Move chains", wallet: "Chain wallet" }, { value: "substrate", label: "Substrate", wallet: "Polkadot extension" },
  { value: "other", label: "Other", wallet: "Adapter-defined" }
];

const CATEGORY_COPY: Record<RouteCategory, { title: string; mechanism: string; caution: string }> = {
  "evm-to-evm": { title: "EVM ↔ EVM", mechanism: "Canonical lane, attestation network, or light client", caution: "Next: reuse CCTP for a reviewed EVM testnet pair." },
  "evm-to-non-evm": { title: "EVM ↔ non-EVM", mechanism: "Cross-VM verification plus explicit address conversion", caution: "Base Sepolia ↔ Solana Devnet is installed for native USDC." },
  "non-evm-to-non-evm": { title: "non-EVM ↔ non-EVM", mechanism: "IBC/light client, attestation network, or HTLC", caution: "Noble Testnet ↔ Osmosis Testnet is installed through ICS-20." }
};

const CCTP_STAGES: Array<{ stage: BridgeStage; label: string }> = [
  { stage: "quote-ready", label: "Quote locked" }, { stage: "source-submitted", label: "Burn submitted" },
  { stage: "source-finalized", label: "Burn finalized" }, { stage: "awaiting-proof", label: "Attestation" },
  { stage: "destination-finalized", label: "Mint confirmed" }
];
const IBC_STAGES: Array<{ stage: BridgeStage; label: string }> = [
  { stage: "quote-ready", label: "Fee estimated" }, { stage: "source-submitted", label: "Packet submitted" },
  { stage: "source-finalized", label: "Source included" }, { stage: "awaiting-proof", label: "Relayer delivery" },
  { stage: "destination-finalized", label: "Ack proof verified" }
];

type InstalledDirection = CctpDirection | IbcDirection;
type InstalledEstimate = CctpEstimate | IbcEstimate;
type FinalityUiState = { status: "empty"; error?: string } | FinalityTrackingState;
type FinalityUiEvent = { type: "loaded"; record?: RouteFinalityRecord; error?: string } | { type: "tracking"; event: FinalityTrackingEvent } | { type: "refreshPersisted"; attemptId: string; record: RouteFinalityRecord };
type CctpAssetEvidenceState = { status: "idle" | "checking" } | { status: "observed"; evidence: CctpAssetReleaseEvidence } | { status: "failed"; code: string };
const isCctpDirection = (value: InstalledDirection | null): value is CctpDirection => Boolean(value && !isIbcDirection(value));
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

type BridgePanelProps = {
  evmProvider?: SelectableEip1193Provider;
  evmProviderId: string | null;
  evmWalletRevision?: number;
  evmWalletCapabilityId: "eip1193";
  cctpAssetVerifier?: () => Promise<CctpAssetReleaseEvidence>;
};

export default function BridgePanel({ evmProvider, evmProviderId, evmWalletRevision = 0, evmWalletCapabilityId, cctpAssetVerifier = verifyPinnedBaseCctpAsset }: BridgePanelProps) {
  const [sourceFamily, setSourceFamily] = useState<ChainFamily>("evm");
  const [destinationFamily, setDestinationFamily] = useState<ChainFamily>("solana");
  const [selectedDirection, setSelectedDirection] = useState<InstalledDirection | null>("base-to-solana");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [importedRoute, setImportedRoute] = useState<BridgeRoute>();
  const [manifestName, setManifestName] = useState("");
  const [estimate, setEstimate] = useState<InstalledEstimate>();
  const [routeQuote, setRouteQuote] = useState<RouteQuote>();
  const [routeRequest, setRouteRequest] = useState<RouteQuoteRequest>();
  const [executionIntentId, setExecutionIntentId] = useState(createRouteExecutionIntentId);
  const [result, setResult] = useState<RouteExecutionReceipt>();
  const [sessionRevision, setSessionRevision] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"quote" | "transfer" | "">("");
  const [error, setError] = useState("");
  const [finalityState, dispatchFinality] = useReducer(finalityUiReducer, { status: "empty" });
  const [savedFinalities, setSavedFinalities] = useState<RouteFinalityRecord[]>([]);
  const [finalityReservations, setFinalityReservations] = useState<RouteFinalityReservation[]>([]);
  const [cctpAssetEvidence, setCctpAssetEvidence] = useState<CctpAssetEvidenceState>({ status: "idle" });
  const routeIdRef = useRef<string | undefined>(undefined);
  const installedAdapters = useMemo(() => {
    const browserWallets = window as unknown as { solana?: unknown; phantom?: { solana?: unknown } };
    return createInstalledQuoteAdapters({ ethereum: evmProvider, solana: browserWallets.solana, phantom: browserWallets.phantom });
  }, [evmProvider]);

  useEffect(() => {
    setEstimate(undefined); setRouteQuote(undefined); setRouteRequest(undefined); setResult(undefined);
    setExecutionIntentId(createRouteExecutionIntentId());
    setConfirmed(false); setError(""); setSessionRevision((revision) => revision + 1);
  }, [evmProviderId, evmWalletRevision]);

  const direction = selectedDirection;
  const ibc = isIbcDirection(direction);
  const installedRoute = direction ? (ibc ? IBC_ROUTES[direction] : CCTP_ROUTES[direction as CctpDirection]) : undefined;
  const routeDescriptor = installedRoute ? ROUTE_DESCRIPTORS.find((candidate) => candidate.id === installedRoute.id) : undefined;
  routeIdRef.current = routeDescriptor?.id;
  const routeAdapter = routeDescriptor ? installedAdapters.find((candidate) => candidate.adapterId === routeDescriptor.adapterId && candidate.supports(routeDescriptor)) : undefined;
  const route = installedRoute ?? importedRoute;
  const categoryInfo = CATEGORY_COPY[classifyRoute(sourceFamily, destinationFamily)];
  const sourceWallet = FAMILY_OPTIONS.find((item) => item.value === sourceFamily)?.wallet;
  const destinationWallet = FAMILY_OPTIONS.find((item) => item.value === destinationFamily)?.wallet;
  const routeMatches = route?.source.family === sourceFamily && route.destination.family === destinationFamily;
  const executable = Boolean(installedRoute && routeDescriptor && routeAdapter && routeMatches && route?.status === "verified");
  const quoteExpired = routeQuote ? routeQuote.expiresAt <= Date.now() : false;
  const quoteInputValid = ibc ? canRequestIbcEstimate(direction, amount, recipient) : canRequestCctpQuote(direction as CctpDirection | null, amount, recipient);
  // Both validators already say exactly what is wrong; the two canRequest…
  // helpers throw that away to return a boolean. Changing the route keeps
  // whatever was typed, so an address for the previous destination stays sitting
  // in a field labelled "exact" with nothing to say it no longer fits. The action
  // is refused either way — this only makes the refusal legible.
  const recipientProblem = (() => {
    if (!recipient.trim() || !direction) return "";
    try {
      if (ibc) validateIbcRecipient(direction as IbcDirection, recipient);
      else validateRecipient(direction as CctpDirection, recipient);
      return "";
    } catch (reason) { return reason instanceof Error ? reason.message : "Enter a valid recipient address."; }
  })();
  const finalityRecord = finalityState.status === "empty" ? undefined : finalityState.record;
  const resetQuote = () => { setEstimate(undefined); setRouteQuote(undefined); setRouteRequest(undefined); setResult(undefined); setConfirmed(false); setError(""); setExecutionIntentId(createRouteExecutionIntentId()); setSessionRevision((revision) => revision + 1); };

  useEffect(() => {
    if (!routeDescriptor) { setSavedFinalities([]); setFinalityReservations([]); dispatchFinality({ type: "loaded" }); return; }
    const restored = loadRouteFinalities(routeDescriptor);
    setSavedFinalities(restored.records);
    setFinalityReservations(restored.reservations);
    dispatchFinality({ type: "loaded", record: restored.records[0], error: restored.error });
  }, [routeDescriptor]);
  const selectInstalledRoute = (next: InstalledDirection | null) => {
    setSelectedDirection(next); setImportedRoute(undefined); resetQuote();
    if (!next) return;
    const selected = isIbcDirection(next) ? IBC_ROUTES[next] : CCTP_ROUTES[next];
    setSourceFamily(selected.source.family);
    setDestinationFamily(selected.destination.family);
  };
  const selectFamilies = (source: ChainFamily, destination: ChainFamily) => {
    setSourceFamily(source); setDestinationFamily(destination); setImportedRoute(undefined); resetQuote();
    setSelectedDirection(source === "cosmos" && destination === "cosmos" ? "noble-to-osmosis" : directionForFamilies(source, destination));
  };

  const routeStatus = useMemo(() => {
    if (installedRoute && !ibc && installedRoute.status === "disabled") return { label: "CCTP release review required", detail: "Base Sepolia USDC code is observable again after an earlier two-reader absence. Automatic re-enabling is forbidden; the current proxy, implementation, and metadata must be reviewed and explicitly released." };
    if (installedRoute) return ibc
      ? { label: "Common quote + live channel adapter installed", detail: "The bound quote is rechecked before an ICS-20 transfer and both testnet channels must still be OPEN." }
      : { label: "Common quote + CCTP adapter installed", detail: "The signed provider quote, wallet account, execution target, expiry, and source-paid fees are bound before burn." };
    if (!route) return { label: "No executable route", detail: "Asset movement is disabled until an exact protocol adapter is reviewed and installed." };
    if (!routeMatches) return { label: "Route mismatch", detail: "The manifest does not match the selected chain families." };
    return { label: "Manifest inspected only", detail: "A JSON manifest cannot enable signing without installed adapter code." };
  }, [ibc, installedRoute, route, routeMatches]);

  const recheckCctpAsset = async () => {
    setCctpAssetEvidence({ status: "checking" });
    try { setCctpAssetEvidence({ status: "observed", evidence: await cctpAssetVerifier() }); }
    catch (reason) { setCctpAssetEvidence({ status: "failed", code: errorText(reason) }); }
  };

  const importManifest = async (file?: File) => {
    setError(""); setImportedRoute(undefined); setManifestName(""); resetQuote();
    if (!file) return;
    try { const parsed = JSON.parse(await file.text()) as BridgeRoute; assertExecutableRoute(parsed); setImportedRoute(parsed); setManifestName(file.name); setSelectedDirection(null); setSourceFamily(parsed.source.family); setDestinationFamily(parsed.destination.family); }
    catch (reason) { setError(`Route manifest rejected: ${errorText(reason)}`); }
  };

  const getEstimate = async () => {
    if (!direction || !routeDescriptor || !routeAdapter) return;
    setBusy("quote"); setError(""); setEstimate(undefined); setResult(undefined); setConfirmed(false);
    try {
      const accountId = await routeAdapter.connectAccount(routeDescriptor);
      const walletCapabilityId = routeDescriptor.sourceAsset.startsWith("eip155:") ? evmWalletCapabilityId : routeDescriptor.walletCapabilityIds[0];
      const requestSessionRevision = routeDescriptor.sourceAsset.startsWith("eip155:") ? evmWalletRevision : sessionRevision;
      if (!routeDescriptor.walletCapabilityIds.includes(walletCapabilityId)) throw new Error("WALLET_CAPABILITY_UNSUPPORTED");
      const request: RouteQuoteRequest = {
        executionIntentId,
        sourceAsset: routeDescriptor.sourceAsset, destinationAsset: routeDescriptor.destinationAsset,
        amountInBaseUnits: decimalToBaseUnits(amount, 6), accountId, recipient,
        walletCapabilityId, sessionRevision: requestSessionRevision,
        walletGrant: createProviderBindingGrant({
            transportId: walletCapabilityId === "eip1193" ? `eip6963:${evmProviderId}` : `injected:${walletCapabilityId}`,
            accountId, walletCapabilityId, sessionRevision: requestSessionRevision,
            expiresAt: Date.now() + routeDescriptor.maximumQuoteTtlMs
          }),
        slippageBps: 0
      };
      const search = await quoteRoutes(request, [routeDescriptor], [routeAdapter]);
      const quote = search.quotes[0];
      if (!quote) throw new Error(search.rejected[0]?.code ?? "NO_EXECUTABLE_QUOTE");
      setRouteRequest(request); setRouteQuote(quote); setEstimate(estimateFromUniversalQuote(quote));
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(""); }
  };

  const transfer = async () => {
    if (!direction || !estimate || !routeDescriptor || !routeAdapter || !routeRequest || !routeQuote || !confirmed || quoteExpired) return;
    setBusy("transfer"); setError(""); setResult(undefined);
    try {
      const lockManager = browserCrossTabExecutionLockManager();
      if (!lockManager) throw new Error("FINALITY_CROSS_TAB_LOCK_UNAVAILABLE");
      const completed = await withCrossTabFinalityLock(lockManager, routeDescriptor, async () => {
        if (!routeFinalityStorageHasCapacity(routeDescriptor)) throw new Error("FINALITY_STORAGE_CAPACITY_UNAVAILABLE");
        let reservation: RouteFinalityReservation | undefined;
        const persistReceiptFinality = (receipt: RouteExecutionReceipt): RouteFinalityRecord => {
          if (!receipt.finality) throw new Error("EXECUTION_PROGRESS_FINALITY_MISSING");
          const current = loadRouteFinalities(routeDescriptor);
          if (current.error) throw new Error(current.error);
          const identity = finalityRecordIdentity(receipt.finality);
          const reconciled = reconcileRouteFinalityRecord(current.records.find((record) => finalityRecordIdentity(record) === identity), receipt.finality, routeDescriptor);
          if (!persistRouteFinality(reconciled, routeDescriptor)) throw new Error("FINALITY_STORAGE_PERSIST_FAILED");
          return reconciled;
        };
        const next = await executeRouteQuote(
          routeDescriptor,
          routeRequest,
          routeQuote,
          [routeAdapter],
          Date.now(),
          (progress) => { persistReceiptFinality(progress); },
          () => { reservation = reserveRouteFinality(routeDescriptor, routeQuote, expectedBridgeExecutionId(routeDescriptor, routeQuote)); }
        );
        if (!reservation) throw new Error("FINALITY_RESERVATION_MISSING");
        let durableFinality: RouteFinalityRecord | undefined;
        if (next.finality) durableFinality = persistReceiptFinality(next);
        else if (next.state === "failed" && next.failureProof) clearRouteFinalityReservation(reservation, routeDescriptor);
        const saved = loadRouteFinalities(routeDescriptor);
        if (saved.error) throw new Error(saved.error);
        return { next, durableFinality, saved: saved.records, reservations: saved.reservations };
      });
      if (routeIdRef.current !== routeDescriptor.id) return;
      setResult(completed.next);
      setSavedFinalities(completed.saved);
      setFinalityReservations(completed.reservations);
      if (completed.durableFinality) {
        dispatchFinality({ type: "loaded", record: completed.durableFinality });
      } else if (completed.next.state === "pending" || completed.next.state === "unknown") setError("The transfer may have been submitted, but no recoverable finality identity was returned. Preserve every transaction hash and do not retry.");
      if (completed.next.state === "failed") setError("The bridge did not complete. Review every step before retrying.");
    }
    catch (reason) {
      if (routeIdRef.current === routeDescriptor.id) {
        const saved = loadRouteFinalities(routeDescriptor);
        if (!saved.error) { setSavedFinalities(saved.records); setFinalityReservations(saved.reservations); }
        setError(errorText(reason));
      }
    } finally { setBusy(""); }
  };

  const refreshFinality = async () => {
    if (!routeDescriptor || !finalityRecord || finalityState.status === "checking" || isTerminalFinalityStage(finalityRecord.stage)) return;
    const attemptId = crypto.randomUUID();
    dispatchFinality({ type: "tracking", event: { type: "checkStarted", attemptId } });
    try {
      const lockManager = browserCrossTabExecutionLockManager();
      if (!lockManager) throw new Error("FINALITY_CROSS_TAB_LOCK_UNAVAILABLE");
      const updated = await withCrossTabFinalityLock(lockManager, routeDescriptor, async () => {
        const loaded = loadRouteFinalities(routeDescriptor);
        if (loaded.error) throw new Error(loaded.error);
        const current = loaded.records.find((record) => finalityRecordIdentity(record) === finalityRecordIdentity(finalityRecord));
        if (!current) throw new Error("FINALITY_RECORD_NOT_FOUND");
        if (isTerminalFinalityStage(current.stage)) return current;
        const observation = await checkRouteFinality(current, routeDescriptor);
        const next = applyFinalityObservation(current, observation);
        if (!persistRouteFinality(next, routeDescriptor)) throw new Error("FINALITY_STORAGE_PERSIST_FAILED");
        return next;
      });
      if (routeIdRef.current !== routeDescriptor.id) return;
      const saved = loadRouteFinalities(routeDescriptor);
      if (saved.error) throw new Error(saved.error);
      setSavedFinalities(saved.records);
      setFinalityReservations(saved.reservations);
      dispatchFinality({ type: "refreshPersisted", attemptId, record: updated });
    } catch (reason) {
      dispatchFinality({ type: "tracking", event: { type: "checkFailed", attemptId, code: errorText(reason) } });
    }
  };

  return <div className="trade-panel bridge-panel">
    <div className="panel-header"><div><h2>Bridge assets</h2><p>{ibc ? "IBC ICS-20 TESTNET · USDC.n" : "CCTP V2 TESTNET · NATIVE USDC"}</p></div><span className="bridge-beta">TESTNET ONLY</span></div>
    <label className="bridge-preset"><span>INSTALLED TESTNET ROUTE</span><select value={direction ?? ""} onChange={(event) => selectInstalledRoute((event.target.value || null) as InstalledDirection | null)}><optgroup label="EVM ↔ non-EVM"><option value="base-to-solana">Base Sepolia → Solana Devnet</option><option value="solana-to-base">Solana Devnet → Base Sepolia</option></optgroup><optgroup label="EVM ↔ EVM"><option value="base-to-arbitrum">Base Sepolia → Arbitrum Sepolia</option><option value="arbitrum-to-base">Arbitrum Sepolia → Base Sepolia</option></optgroup><optgroup label="non-EVM ↔ non-EVM"><option value="noble-to-osmosis">Noble Testnet → Osmosis Testnet</option><option value="osmosis-to-noble">Osmosis Testnet → Noble Testnet</option></optgroup><option value="">Custom family · design gate</option></select></label>
    <div className="bridge-route-grid">
      <label className="bridge-chain-field"><span>SOURCE FAMILY</span><select value={sourceFamily} onChange={(event) => selectFamilies(event.target.value as ChainFamily, destinationFamily)}>{FAMILY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><small><WalletCards size={13} /> {sourceWallet}</small></label>
      <div className="bridge-arrow"><ArrowRight size={19} /></div>
      <label className="bridge-chain-field"><span>DESTINATION FAMILY</span><select value={destinationFamily} onChange={(event) => selectFamilies(sourceFamily, event.target.value as ChainFamily)}>{FAMILY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><small><WalletCards size={13} /> {destinationWallet}</small></label>
    </div>
    <div className="bridge-category-card"><div className="bridge-category-icon"><Network size={18} /></div><div><strong>{installedRoute ? `${installedRoute.source.name} → ${installedRoute.destination.name}` : categoryInfo.title}</strong><p>{categoryInfo.mechanism}</p><small>{categoryInfo.caution}</small></div></div>
    {installedRoute && <div className="risk-callout bridge-trust"><CircleAlert size={18} /><span>{ibc ? <><strong>IBC trust boundary:</strong> on-chain light clients verify the counterparty, while independent relayers provide liveness. A source inclusion is not destination completion; this app waits for explicit acknowledgement evidence.</> : <><strong>External trust boundary:</strong> Circle attests the burn and its Forwarding Service submits the destination mint. RealDEX adds no app fee and sends no error telemetry, but this route is not operatorless.</>}</span></div>}
    <div className="bridge-input-grid"><label className="field"><span>Source amount · {ibc ? "USDC.n" : "USDC"}</span><input value={amount} onChange={(event) => { setAmount(event.target.value); resetQuote(); }} inputMode="decimal" placeholder="0.0" /></label><label className="field"><span>Exact destination recipient</span><input value={recipient} onChange={(event) => { setRecipient(event.target.value); resetQuote(); }} placeholder={ibc ? (direction === "noble-to-osmosis" ? "osmo1…" : "noble1…") : direction && direction !== "base-to-solana" ? "0x… EVM address" : "Solana base58 address"} className="mono" aria-invalid={recipientProblem ? true : undefined} />{recipientProblem && <small className="field-problem" role="status">{recipientProblem}</small>}</label></div>
    <section className="bridge-manifest">
      <div className="bridge-manifest-head"><div><FileJson size={18} /><span><strong>Route evidence</strong><small>{installedRoute ? "Built-in reviewed testnet manifest" : manifestName || "No local manifest selected"}</small></span></div><label className="manifest-button">Inspect JSON<input type="file" accept="application/json,.json" onChange={(event) => void importManifest(event.target.files?.[0])} /></label></div>
      <div className={`bridge-status ${executable ? "ok" : "blocked"}`}>{executable ? <ShieldCheck size={17} /> : <LockKeyhole size={17} />}<span><strong>{routeStatus.label}</strong><small>{routeStatus.detail}</small></span></div>
      {installedRoute && !ibc && installedRoute.status === "disabled" && <div className="cctp-asset-release">
        <button className="secondary-button" type="button" onClick={() => void recheckCctpAsset()} disabled={cctpAssetEvidence.status === "checking"}><RefreshCw size={16} className={cctpAssetEvidence.status === "checking" ? "spin" : ""} />{cctpAssetEvidence.status === "checking" ? "Reading two Base RPCs…" : "Recheck current USDC identity"}</button>
        <p className="action-note">Read-only: sends chain ID, block number, code, Circle proxy implementation slot, and ERC-20 metadata calls to the two pinned Base RPC hosts. A matching result cannot enable execution.</p>
        {cctpAssetEvidence.status === "observed" && <div className="bridge-status blocked" aria-live="polite"><ShieldCheck size={17} /><span><strong>Current asset quorum observed · execution still disabled</strong><small>{cctpAssetEvidence.evidence.observations.map((item) => item.readerId).join(" + ")} · implementation {shortEvidence(cctpAssetEvidence.evidence.observations[0].implementationAddress)} · explicit release approval required</small></span></div>}
        {cctpAssetEvidence.status === "failed" && <div className="risk-callout bridge-error" role="alert"><CircleAlert size={18} /><span>USDC identity check failed: {cctpAssetEvidence.code}. CCTP remains disabled.</span></div>}
        <CctpReleaseReviewPanel key={direction} evidence={cctpAssetEvidence.status === "observed" ? cctpAssetEvidence.evidence : undefined} />
      </div>}
      {route && <div className="bridge-route-facts"><span>Provider<strong>{route.provider}</strong></span><span>Verification<strong>{ibc ? "On-chain light clients" : "Circle attestation"}</strong></span><span>Mechanism<strong>{route.mechanism}</strong></span><span>Recovery<strong>{route.recovery}</strong></span></div>}
    </section>
    <div className="bridge-summary">
      <div><span>Source endpoint</span><strong>{route?.sourceEndpoint || "Not installed"}</strong></div><div><span>Destination endpoint</span><strong>{route?.destinationEndpoint || "Not installed"}</strong></div>
      <div><span>Recipient receives</span><strong>{estimate ? `${estimate.amountReceived} ${ibc ? "USDC.n" : "USDC"}` : ibc ? "Estimate source gas" : "Get a signed quote"}</strong></div><div><span>Source wallet debit</span><strong>{estimate ? `${estimate.totalDebit} ${ibc ? "USDC.n" : "USDC"}` : "Not estimated"}</strong></div>
      <div><span>{ibc ? "Estimated source gas" : "Circle + forwarder fee"}</span><strong>{estimate ? ibc ? `${(estimate as IbcEstimate).feeAmount} ${(estimate as IbcEstimate).feeSymbol}` : `${(estimate as CctpEstimate).feeTotal} USDC` : "Route-specific"}</strong></div><div><span>{ibc ? "Packet timeout" : "Quote expiry"}</span><strong>{estimate ? new Date(ibc ? (estimate as IbcEstimate).timeoutAt : estimate.quoteExpiresAt ?? 0).toLocaleTimeString() : "Not quoted"}</strong></div>
      <div><span>Authorization</span><strong>{routeQuote ? routeQuote.authorization.type === "adapter-managed" ? routeQuote.authorization.detail : routeQuote.authorization.type === "approval" ? `Exact approval · ${routeQuote.authorization.spender}` : "Transaction signature only" : "Not quoted"}</strong></div><div><span>Quote binding</span><strong>{routeQuote && routeRequest ? `${routeQuote.requestFingerprint} · ${walletGrantFingerprint(routeRequest.walletGrant)}` : "Account + chain + method + wallet session"}</strong></div>
      <div><span>Execution intent</span><strong title={routeRequest?.executionIntentId}>{routeRequest ? shortExecutionIntent(routeRequest.executionIntentId) : "Created with transaction inputs"}</strong></div>
    </div>
    <div className="bridge-lifecycle" aria-label="Bridge lifecycle status">{(ibc ? IBC_STAGES : CCTP_STAGES).map((item, index) => <div className={finalityRecord && finalityStageIndex(finalityRecord.stage) >= index ? "complete" : ""} key={item.stage}><span>{finalityRecord && finalityStageIndex(finalityRecord.stage) >= index ? <Check size={12} /> : index + 1}</span><small>{item.label}</small></div>)}</div>
    {result && <div className={`bridge-result ${result.state === "confirmed" ? "success" : result.state === "failed" ? "error" : result.state}`}><strong>{result.state === "confirmed" ? "Destination mint confirmed" : result.state === "pending" ? ibc ? "Source included · acknowledgement pending" : "Transfer still pending" : result.state === "unknown" ? "Transfer state unknown · reconcile before retrying" : "Transfer stopped"}</strong>{result.steps.map((step) => <span key={`${step.name}-${step.txHash ?? step.state}`}>{step.name}: {step.state}{step.explorerUrl && <> · <a href={step.explorerUrl} target="_blank" rel="noreferrer">Explorer</a></>}</span>)}</div>}
    {savedFinalities.length > 1 && <label className="bridge-finality-selector"><span>SAVED TRANSFER EVIDENCE · {savedFinalities.length}</span><select value={finalityRecord ? finalityRecordIdentity(finalityRecord) : ""} onChange={(event) => { const record = savedFinalities.find((item) => finalityRecordIdentity(item) === event.target.value); dispatchFinality({ type: "loaded", record }); }} aria-label="Saved transfer evidence"><option value="" disabled>Select a transfer</option>{savedFinalities.map((record) => <option key={finalityRecordIdentity(record)} value={finalityRecordIdentity(record)}>{new Date(record.updatedAt).toLocaleString()} · {finalityStageLabel(record.stage, record.cursor.protocol === "ibc-ics20")} · {shortEvidence(record.executionId)}</option>)}</select></label>}
    {finalityReservations.length > 0 && <div className="risk-callout bridge-error" role="alert"><CircleAlert size={18} /><span><strong>{finalityReservations.length} transfer attempt{finalityReservations.length === 1 ? "" : "s"} {finalityReservations.length === 1 ? "lacks" : "lack"} a durable source transaction identity.</strong> The attempt may have reached a wallet or network. Do not retry; preserve wallet history and reconcile the exact quote ID first.</span></div>}
    {finalityRecord && <section className={`bridge-finality ${finalityRecord.stage === "destination-confirmed" ? "success" : finalityRecord.stage === "failed" ? "error" : ""}`} aria-live="polite">
      <div><strong>{finalityStageLabel(finalityRecord.stage, ibc)}</strong><small>Revision {finalityRecord.revision} · {new Date(finalityRecord.updatedAt).toLocaleString()}</small></div>
      <p>{finalityStageDetail(finalityRecord.stage, ibc)}</p>
      {finalityRecord.evidence.length > 0 && <div className="bridge-finality-evidence">{finalityRecord.evidence.map((item) => <span key={`${item.kind}:${item.id}`}>{item.kind}: <code>{shortEvidence(item.id)}</code>{item.outcome && <> · {item.outcome} observed</>}{item.url && <> · <a href={item.url} target="_blank" rel="noreferrer">Evidence</a></>}</span>)}</div>}
      {finalityState.status === "check-failed" && <p className="bridge-finality-error">Status check failed; the prior state was preserved. Detail: {finalityState.code}</p>}
      {!isTerminalFinalityStage(finalityRecord.stage) && <button className="secondary-button" type="button" onClick={() => void refreshFinality()} disabled={finalityState.status === "checking"}><RefreshCw size={16} className={finalityState.status === "checking" ? "spin" : ""} />{finalityState.status === "checking" ? "Checking source and destination evidence…" : "Check destination status"}</button>}
    </section>}
    {finalityState.status === "empty" && finalityState.error && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>Saved finality record was rejected: {finalityState.error}. Existing execution guards remain in place.</span></div>}
    {error && <div className="risk-callout bridge-error"><CircleAlert size={18} /><span>{error}</span></div>}
    {!estimate ? <button className={`primary-button ${!executable ? "blocked" : ""}`} disabled={!executable || busy !== "" || !quoteInputValid} onClick={() => void getEstimate()}><RadioTower size={18} />{busy === "quote" ? ibc ? "Checking channels and estimating gas…" : "Requesting signed quote…" : executable ? ibc ? "Connect wallet and estimate gas" : "Get signed fee quote" : installedRoute && !ibc && installedRoute.status === "disabled" ? "CCTP release approval required" : "Verified protocol adapter required"}</button> : <><label className="bridge-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{ibc ? "I verified both testnets, the exact recipient, amount, source gas, packet timeout, and that relayer delivery is not yet guaranteed." : "I verified the testnet, exact recipient, received amount, total debit, expiry, and Circle relayer dependency."}</span></label><button className="primary-button" disabled={!confirmed || quoteExpired || busy !== ""} onClick={() => void transfer()}><RadioTower size={18} />{busy === "transfer" ? "Follow wallet prompts…" : quoteExpired ? "Estimate expired — request again" : ibc ? "Sign and send IBC packet" : "Approve and burn testnet USDC"}</button></>}
    <p className="action-note">{ibc ? "This route uses testnet assets only. Wallet connection is separate from signing; signing submits value movement. Closing the page cannot cancel an included IBC packet." : installedRoute?.status === "disabled" ? "This CCTP route remains read-only even when both RPCs agree. No wallet connection, quote request, approval, burn, or mint can start without a separate reviewed release." : "This route uses testnet assets only. Approval and burn are separate wallet-authorized value-transfer steps; closing the page does not reverse a submitted burn."}</p>
    <div className="bridge-recovery"><RefreshCw size={14} /><span>Finality records are retained per transfer and survive reload. A status-check failure never rolls back evidence or permits a duplicate transfer; source inclusion, provider proof, destination submission, and destination confirmation remain distinct.</span></div>
  </div>;
}

function finalityUiReducer(state: FinalityUiState, event: FinalityUiEvent): FinalityUiState {
  if (event.type === "loaded") return event.record ? initialFinalityTrackingState(event.record) : { status: "empty", error: event.error };
  if (event.type === "refreshPersisted") {
    if (state.status !== "checking" || state.attemptId !== event.attemptId || finalityRecordIdentity(state.record) !== finalityRecordIdentity(event.record)) return state;
    return initialFinalityTrackingState(event.record);
  }
  return state.status === "empty" ? state : finalityTrackingReducer(state, event.event);
}

function finalityStageIndex(stage: RouteFinalityStage): number {
  return ({ "source-submitted": 1, "source-included": 2, "awaiting-proof": 3, "destination-submitted": 3, "destination-observed": 3, "destination-confirmed": 4, refundable: 2, failed: 1, unknown: 1 } as Record<RouteFinalityStage, number>)[stage];
}

function finalityStageLabel(stage: RouteFinalityStage, ibc: boolean): string {
  return ({ "source-submitted": ibc ? "Packet submitted" : "Burn submitted", "source-included": "Source transaction observed", "awaiting-proof": ibc ? "Awaiting destination acknowledgement" : "Provider completion reported · independent proof pending", "destination-submitted": "Destination transaction submitted", "destination-observed": "Destination acknowledgement observed · proof unverified", "destination-confirmed": ibc ? "Destination acknowledgement independently verified" : "Destination independently confirmed", refundable: "Timeout recovery may be available", failed: "Terminal failure evidence observed", unknown: "Finality unresolved" } as Record<RouteFinalityStage, string>)[stage];
}

function finalityStageDetail(stage: RouteFinalityStage, ibc: boolean): string {
  if (stage === "destination-confirmed") return ibc ? "The acknowledgement proof was independently verified against an accepted source-chain light-client state." : "The bridge provider reported completion. Use the destination transaction evidence for independent chain confirmation.";
  if (stage === "destination-observed") return "A configured destination REST endpoint returned an acknowledgement value and proof height. RealDEX has not verified its Merkle proof against a trusted header, so neither success nor error is terminal and retry remains blocked.";
  if (stage === "destination-submitted") return "A destination transaction hash is available, but a hash alone is not independent finality proof.";
  if (stage === "awaiting-proof" && !ibc) return "The bridge provider reported progress or completion, but destination finality is not independently confirmed.";
  if (stage === "unknown") return "Do not retry. Check both chains and preserve the execution and transaction identifiers for reconciliation.";
  if (stage === "failed") return "Review the evidence before retrying; a source-side value movement may still have occurred.";
  return "The transfer is not complete. Refreshing reads evidence only and never submits another transaction.";
}

function shortEvidence(value: string): string { return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value; }
function shortExecutionIntent(value: string): string { return `intent …${value.slice(-12)}`; }
function verifyPinnedBaseCctpAsset(): Promise<CctpAssetReleaseEvidence> { return observeBaseCctpAssetIdentity(createPinnedBaseCctpAssetReaders()); }

function estimateFromUniversalQuote(quote: RouteQuote): InstalledEstimate {
  if (!quote.adapterData.value || typeof quote.adapterData.value !== "object") throw new Error("QUOTE_ADAPTER_DATA_INVALID");
  const value = quote.adapterData.value as { estimate?: InstalledEstimate };
  if (!value.estimate || decimalToBaseUnits(value.estimate.amountReceived, 6) !== quote.expectedOutBaseUnits) throw new Error("QUOTE_DISPLAY_VALUE_MISMATCH");
  return value.estimate;
}
