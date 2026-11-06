import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CosmosInjectedAccountBinding, CosmosInjectedConnection, CosmosInjectedProvider } from "../wallet/cosmos-injected-session";
import type { CosmosSwapIntent } from "./cosmos-swap-boundary";
import type { VerifiedSourceBoundOsmosisSwap } from "./cosmos-venue-source";
import { createOsmosisExactInVenue, type OsmosisExactInRouteDescriptor } from "./osmosis-exact-in-decoder";
import { prepareCosmosInjectedSigning, type CosmosInjectedSigningPreparation } from "./cosmos-injected-signing-preparation";
import { readCosmosSigningSlot, reserveCosmosInjectedSigning } from "./cosmos-signed-swap-journal";
import { requestCosmosInjectedSwapSignature } from "./cosmos-injected-direct-signing";
import CosmosRecoveryPanel from "./CosmosRecoveryPanel";
import type { CosmosReadPolicyHead, VerifiedCosmosReadPolicy } from "./cosmos-read-policy";
import type { CosmosInjectedSignedSwapEvidence } from "./cosmos-injected-signed-swap-evidence";
import type { CosmosSwapRecoveryRecord } from "./cosmos-swap-recovery";

type Props = {
  connection: CosmosInjectedConnection; binding: CosmosInjectedAccountBinding; provider: CosmosInjectedProvider;
  intent: CosmosSwapIntent; verified: VerifiedSourceBoundOsmosisSwap; route: OsmosisExactInRouteDescriptor;
  recoveryPolicy?: VerifiedCosmosReadPolicy;
  readRecoveryPolicyHead?: (fingerprint: string) => CosmosReadPolicyHead | undefined;
};
type Phase = "idle" | "preparing" | "review" | "signing" | "signed" | "stopped" | "error";

export default function CosmosSigningReviewPanel(props: Props) {
  const { connection, binding, provider, intent, verified, route } = props;
  const titleId = useId();
  const scope = useMemo(() => ({ connection, binding, provider, intent, verified, route }), [connection, binding, provider, intent, verified, route]);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const [review, setReview] = useState<{ scope: typeof scope; preparation: CosmosInjectedSigningPreparation; blocked: string }>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState("");
  const [transactionHash, setTransactionHash] = useState("");
  const [recovery, setRecovery] = useState<{ scope: typeof scope; evidence: CosmosInjectedSignedSwapEvidence; record: CosmosSwapRecoveryRecord }>();
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0), busy = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const signedBytes = useRef<string | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = review?.scope === scope ? review : undefined;
  const p = active?.preparation;
  const expired = !!p && now >= p.expiresAt;
  const mismatch = binding.chainId !== intent.chainId || binding.address !== intent.authority;
  const pending = phase === "preparing" || phase === "signing";

  useEffect(() => {
    generation.current += 1; abort.current?.abort(); abort.current = null; busy.current = false;
    signedBytes.current = undefined; setRecovery(undefined); setReview(undefined); setAcknowledged(false); setTransactionHash(""); setMessage(""); setPhase("idle");
    return () => { generation.current += 1; abort.current?.abort(); signedBytes.current = undefined; };
  }, [scope]);
  useEffect(() => {
    if (!p) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    heading.current?.focus();
    return () => window.clearInterval(interval);
  }, [p]);
  useEffect(() => { if (phase === "signed" || phase === "stopped" || phase === "error") heading.current?.focus(); }, [phase]);

  async function prepareReview() {
    if (busy.current || mismatch) return;
    busy.current = true;
    const ticket = ++generation.current;
    setPhase("preparing"); setReview(undefined); setAcknowledged(false); setMessage("");
    try {
      const preparation = await prepareCosmosInjectedSigning(scope);
      if (liveScope.current !== scope || generation.current !== ticket) return;
      let blocked = "";
      try {
        if (readCosmosSigningSlot(preparation)) blocked = "This account and sequence already have signing history. Another request is blocked until that history is reconciled.";
      } catch { blocked = "Signing history could not be read reliably. Signing is blocked; do not clear browser data to bypass this check."; }
      if (preparation.hardware !== "none") blocked = "This hardware wallet's DIRECT signing path is not supported here. No alternate signing mode will be selected.";
      setReview({ scope, preparation, blocked }); setNow(Date.now()); setPhase("review");
    } catch {
      if (liveScope.current !== scope || generation.current !== ticket) return;
      setPhase("error"); setMessage("Review could not be prepared. Recheck the selected account and verify the route and simulations again. No signature was requested.");
    } finally { if (generation.current === ticket) busy.current = false; }
  }

  async function requestSignature() {
    if (busy.current || !p || !acknowledged || active?.blocked || Date.now() >= p.expiresAt || mismatch || phase !== "review") return;
    busy.current = true;
    const ticket = ++generation.current, controller = new AbortController();
    abort.current = controller;
    const confirmation = { action: "request-cosmos-direct-signature-only" as const, preparationId: p.preparationId, transactionSha256: p.transactionSha256 };
    setPhase("signing"); setMessage("Rechecking your review and reserving this transaction number before asking the wallet. No broadcast will be requested.");
    try {
      const reserved = await reserveCosmosInjectedSigning(scope);
      if (liveScope.current !== scope || generation.current !== ticket || controller.signal.aborted) return;
      if (reserved.preparation.preparationId !== p.preparationId) throw new Error("REVIEW_CHANGED");
      const result = await requestCosmosInjectedSwapSignature({ ...scope, preparation: reserved.preparation, venue: createOsmosisExactInVenue(route), confirmation }, { signal: controller.signal });
      if (liveScope.current !== scope || generation.current !== ticket || controller.signal.aborted) return;
      signedBytes.current = result.signedTransactionBase64;
      setRecovery({ scope, evidence: result.evidence, record: result.recoveryRecord });
      setTransactionHash(result.evidence.transactionHash); setPhase("signed"); setAcknowledged(false);
      setMessage("Signature accepted locally. This view did not request a broadcast. The separate read-only status check reports chain observations.");
    } catch {
      if (liveScope.current !== scope || generation.current !== ticket) return;
      signedBytes.current = undefined; setAcknowledged(false); setPhase("error");
      setMessage("No successful signing result was accepted. Check the wallet; its request may still be open. Any reservation remains blocked. No broadcast was requested.");
    } finally {
      if (generation.current === ticket) { busy.current = false; abort.current = null; }
    }
  }

  function stopWaiting() {
    generation.current += 1; abort.current?.abort(); abort.current = null; busy.current = false;
    signedBytes.current = undefined; setAcknowledged(false); setPhase("stopped");
    setMessage("Stopped waiting locally. This does not cancel the wallet request or undo a signature. Any reservation stays blocked; do not repeat the request.");
  }

  return <section className="cosmos-signing-review" aria-labelledby={titleId} aria-busy={pending}>
    <h4 id={titleId} ref={heading} tabIndex={-1}>Review swap transaction</h4>
    <p>This authorizes a swap transaction, not a login message. A signed transaction can move funds if submitted later. This view cannot broadcast it.</p>
    <p>Preparing this review only rechecks account and transaction evidence. It does not reserve a sequence or request a signature.</p>
    <p>Simulation checks do not guarantee execution or certify the wallet or route as safe.</p>
    {mismatch && <p className="cosmos-review-warning" role="alert">Select the exact account and network used by the verified transaction before preparing a review.</p>}
    <button type="button" disabled={pending || mismatch || phase === "signed" || phase === "stopped"} onClick={() => void prepareReview()}>{phase === "preparing" ? "Preparing review…" : p ? "Refresh signing review" : "Prepare signing review"}</button>
    {p && <>
      <p className="cosmos-review-warning">All amounts below are exact integer base units. Token decimal places and display symbols are not verified; no human-unit conversion is shown.</p>
      <dl className="cosmos-review-summary">
        <div><dt>Network</dt><dd>{p.chainId} · {p.walletChainId}</dd></div>
        <div><dt>Signing account</dt><dd>{p.authority}</dd></div>
        <div><dt>Recipient</dt><dd>{p.recipient}</dd></div>
        <div><dt>You send · base units</dt><dd>{p.amountInBaseUnits} {p.sourceDenom}</dd></div>
        <div><dt>Estimated receive · base units</dt><dd>{p.expectedOutBaseUnits} {p.destinationDenom}</dd></div>
        <div><dt>Minimum receive · base units</dt><dd>{p.minimumOutBaseUnits} {p.destinationDenom}</dd></div>
        <div><dt>Network fee in transaction · base units</dt><dd>{p.feeAmountBaseUnits} {p.feeDenom}</dd></div>
        <div><dt>Total debit · base units</dt><dd>{p.sourceDenom === p.feeDenom ? `${(BigInt(p.amountInBaseUnits) + BigInt(p.feeAmountBaseUnits)).toString()} ${p.sourceDenom}` : `${p.amountInBaseUnits} ${p.sourceDenom} + ${p.feeAmountBaseUnits} ${p.feeDenom}`}</dd></div>
        <div><dt>Venue / execution target</dt><dd>{p.venueId} · {p.executionTarget}</dd></div>
        <div><dt>Review expires · UTC</dt><dd>{new Date(p.expiresAt).toISOString()}</dd></div>
      </dl>
      <details className="cosmos-review-details"><summary>Transaction and verification details</summary><dl className="cosmos-review-summary">
        <div><dt>Account number / sequence</dt><dd>{p.accountNumber} / {p.sequence}</dd></div>
        <div><dt>Gas limit / simulated gas used</dt><dd>{p.gasLimit} / {p.gasUsed}</dd></div>
        <div><dt>Transaction timeout height</dt><dd>{p.timeoutHeight}</dd></div>
        <div><dt>Preparation ID</dt><dd>{p.preparationId}</dd></div>
        <div><dt>Unsigned transaction SHA-256</dt><dd>{p.transactionSha256}</dd></div>
        <div><dt>Sign document SHA-256</dt><dd>{p.signDocSha256}</dd></div>
        <div><dt>Route / read-policy fingerprints</dt><dd>{p.routeFingerprint}<br />{p.readPolicyPayloadHash}</dd></div>
      </dl></details>
      {expired && phase !== "signed" && <p className="cosmos-review-warning" role="alert">This review has expired. Re-verify the route and simulations before preparing another review.</p>}
      {active?.blocked && <p className="cosmos-review-warning" role="alert">{active.blocked}</p>}
      {phase !== "signed" && <>
        <p id={`${titleId}-risk`}>Requesting a signature reserves this account's sequence. Rejection, timeout or closing this view does not release it. Sending and reservation recovery are not available here yet.</p>
        <label className="cosmos-review-ack"><input type="checkbox" checked={acknowledged} disabled={phase !== "review" || expired || !!active?.blocked} onChange={event => setAcknowledged(event.target.checked)} /><span>I reviewed the network, account, recipient, base-unit amounts and fee. I understand this authorizes a swap, not a login, and no broadcast is included.</span></label>
        <button type="button" aria-describedby={`${titleId}-risk`} disabled={phase !== "review" || !acknowledged || expired || !!active?.blocked || mismatch} onClick={() => void requestSignature()}>Request swap signature — no broadcast</button>
      </>}
    </>}
    {phase === "signing" && <button type="button" onClick={stopWaiting}>Stop waiting locally</button>}
    <p role={phase === "error" || phase === "stopped" ? "alert" : "status"} aria-live="polite">{message}</p>
    {phase === "signed" && <div className="cosmos-review-receipt">
      <strong>Signed · not submitted by this view</strong><p>This is the local signing receipt, not a live chain status.</p><p>Transaction hash: {transactionHash}</p>
      <p>Signed data is kept only in this page's memory. Closing or changing this view discards it, but does not erase signing history or undo a signature. No submission action is available here.</p>
    </div>}
    {phase === "signed" && recovery?.scope === scope && recovery.record && <CosmosRecoveryPanel evidence={recovery.evidence} initialRecord={recovery.record} policy={props.recoveryPolicy} readHead={props.readRecoveryPolicyHead} />}
  </section>;
}
