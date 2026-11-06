import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CosmosInjectedSignedSwapEvidence } from "./cosmos-injected-signed-swap-evidence";
import { revalidateCosmosReadPolicy, type CosmosReadPolicyHead, type VerifiedCosmosReadPolicy } from "./cosmos-read-policy";
import { COSMOS_SWAP_RECOVERY_ID, type CosmosSwapRecoveryRecord } from "./cosmos-swap-recovery";
import { refreshPolicyBoundCosmosRecovery } from "./cosmos-policy-bound-recovery";

type Props = {
  evidence: CosmosInjectedSignedSwapEvidence;
  initialRecord: CosmosSwapRecoveryRecord;
  policy?: VerifiedCosmosReadPolicy;
  readHead?: (fingerprint: string) => CosmosReadPolicyHead | undefined;
};
type Observation = Awaited<ReturnType<typeof refreshPolicyBoundCosmosRecovery>>;

export default function CosmosRecoveryPanel({ evidence, initialRecord, policy, readHead }: Props) {
  const titleId = useId();
  const scope = useMemo(() => ({ evidence, initialRecord }), [evidence, initialRecord]);
  const context = useMemo(() => ({ scope, policy, readHead }), [scope, policy, readHead]);
  const live = useRef(context); live.current = context;
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; observation: Observation }>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0), busy = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const action = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const observation = snapshot?.scope === scope ? snapshot.observation : undefined;
  // Canonical snapshot binds displayed URLs to the policy handed to the service.
  // This local check grants no authority; the service rechecks everything at IO.
  const inspected = useMemo(() => {
    if (!policy) return { reason: "Lookup unavailable — recovery read policy missing." };
    try { return { policy: revalidateCosmosReadPolicy(policy, Date.now()), reason: "" }; }
    catch { return { reason: "Lookup unavailable — read policy is invalid or expired." }; }
  }, [policy]);
  const approved = inspected.policy;
  function blockedAt(time: number): string {
    if (!approved) return inspected.reason;
    if (!Number.isSafeInteger(time) || time < initialRecord.updatedAt || time >= Date.parse(approved.policy.expiresAt)) return "Lookup unavailable — read policy expired or clock invalid.";
    if (approved.policy.recoveryBoundaryId !== COSMOS_SWAP_RECOVERY_ID) return "Lookup unavailable — simulation-only policy does not authorize recovery reads.";
    if (approved.policy.chainId !== initialRecord.chainId || approved.sourceFingerprint !== evidence.readPolicySourceFingerprint) return "Lookup unavailable — policy network or reviewer does not match this signed transaction.";
    try {
      const head = readHead?.(approved.sourceFingerprint);
      if (!head || Object.keys(head).length !== 2 || !Object.hasOwn(head, "revision") || !Object.hasOwn(head, "payloadHash") || !Number.isSafeInteger(head.revision) || head.revision <= 0 || typeof head.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(head.payloadHash)) return "Lookup unavailable — current accepted policy head is missing or unreadable.";
      if (head.revision !== approved.policy.revision || head.payloadHash !== approved.payloadHash) return "Lookup unavailable — current accepted policy head changed.";
    } catch { return "Lookup unavailable — current accepted policy head is missing or unreadable."; }
    return "";
  }
  const blocked = blockedAt(now);
  function stopLookup(note: string) {
    ++generation.current; abort.current?.abort(); abort.current = null; busy.current = false;
    setPending(false); setMessage(note);
  }
  useEffect(() => {
    setSnapshot(undefined); setMessage("");
  }, [scope]);
  useEffect(() => {
    setPending(false);
    if (pending) setMessage("Lookup stopped because its transaction or policy context changed. Any previous observation is historical.");
    return () => { ++generation.current; abort.current?.abort(); abort.current = null; busy.current = false; };
  }, [context]);
  useEffect(() => {
    // Local expiry/head monitoring only. Never performs a network lookup.
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1_000);
    window.addEventListener("storage", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("storage", tick); };
  }, []);
  useEffect(() => {
    if (blocked && busy.current) stopLookup("Lookup stopped because its read policy is no longer current. Any previous observation is historical.");
  }, [blocked]);
  useEffect(() => {
    if (!pending && restoreFocus.current) { restoreFocus.current = false; action.current?.focus(); }
  }, [pending]);

  async function lookup() {
    if (busy.current || !approved || !readHead) return;
    const reason = blockedAt(Date.now());
    if (reason) { setNow(Date.now()); setMessage(reason); return; }
    busy.current = true;
    const ticket = ++generation.current, controller = new AbortController();
    abort.current = controller; setPending(true); setMessage("Checking transaction status…");
    try {
      const result = await refreshPolicyBoundCosmosRecovery({ evidence, record: observation?.record ?? initialRecord, policy: approved, readHead }, { signal: controller.signal });
      if (live.current !== context || ticket !== generation.current || controller.signal.aborted) return;
      setSnapshot({ scope, observation: result }); setMessage("Observation updated. This lookup sent no transaction; signing history remains blocked.");
    } catch {
      if (live.current !== context || ticket !== generation.current || controller.signal.aborted) return;
      setMessage("Lookup failed. No new observation was accepted. Any previous observation below is historical; this is not evidence of transaction failure. Check the read policy and endpoint availability before another lookup.");
    } finally {
      if (live.current === context && ticket === generation.current) {
        busy.current = false; abort.current = null; setPending(false);
      }
    }
  }

  const record = observation?.record;
  const status = !record ? "Not checked" : record.stage === "committed-success" ? "Transaction committed · success reported" : record.stage === "committed-failed" ? "Transaction committed · failure reported" : record.stage === "expired-unresolved" ? "Timeout height passed · unresolved" : "No transaction found · unresolved";
  return <section className="cosmos-recovery-panel" aria-labelledby={titleId}>
    <h5 id={titleId}>Transaction status · read only</h5>
    <p>No automatic polling. This lookup cannot sign, send, resend or release signing history.</p>
    <dl className="cosmos-review-summary">
      <div><dt>Chain</dt><dd>{initialRecord.chainId}</dd></div>
      <div><dt>Transaction hash</dt><dd>{initialRecord.transactionHash}</dd></div>
      {approved && <>
        {approved.policy.restEndpoints.map((endpoint, index) => <div key={index}><dt>Read endpoint {index === 0 ? "A" : "B"}</dt><dd>{endpoint}</dd></div>)}
        <div><dt>Policy revision / expiry</dt><dd>{approved.policy.revision} · {approved.policy.expiresAt}</dd></div>
      </>}
    </dl>
    <p>Checking sends the transaction hash and network request metadata to the two displayed endpoints using read-only requests. No signature or private key is sent. Endpoint approval and agreement are not network consensus proof.</p>
    {blocked && <p className="cosmos-review-warning">{blocked}</p>}
    <button ref={action} type="button" disabled={pending || !!blocked} onClick={() => void lookup()}>{pending ? "Checking transaction status…" : observation ? "Refresh transaction status" : "Check transaction status"}</button>
    {pending && <button type="button" onClick={() => { restoreFocus.current = true; stopLookup("Lookup stopped locally. This does not cancel a transaction or release signing history. Any previous observation is historical."); }}>Stop lookup</button>}
    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
    <div className="cosmos-review-receipt">
      <strong>{status}</strong>
      {!observation ? <p>No chain observation has been accepted. A signature alone does not prove submission or completion.</p> : <>
        <p>Last accepted observation (historical) · <time dateTime={new Date(observation.checkedAt).toISOString()}>{new Date(observation.checkedAt).toISOString()}</time></p>
        <p>Observed under policy revision {observation.policyRevision}. This snapshot does not update automatically.</p>
        <p>{record?.stage === "committed-success" || record?.stage === "committed-failed" ? "Both approved readers reported this committed result. This is not an independent consensus or finality proof." : "Missing indexed history does not prove that a transaction was never submitted or that funds are safe to resend."}</p>
        <details className="cosmos-review-details"><summary>Reader observations</summary><dl className="cosmos-review-summary">
          <div><dt>Observation policy payload / reviewer fingerprints</dt><dd>{observation.policyPayloadHash}<br />{observation.policySourceFingerprint}</dd></div>
          {record?.observations.map((item, index) => <div key={index}><dt>Reader {index + 1} · {item.readerId}</dt><dd>Head: {item.blockHeight}<br />Transaction height: {item.transactionHeight ?? "not found"}<br />Code: {item.code ?? "not available"}<br />Codespace: {item.codespace || "not available"}<br />Gas wanted / used: {item.gasWanted ?? "not available"} / {item.gasUsed ?? "not available"}</dd></div>)}
        </dl></details>
      </>}
    </div>
    <p>Leaving this view discards this page-local snapshot. Persistent signing history stays blocked. No reservation release or transaction submission action is available here.</p>
  </section>;
}
