import { useEffect, useId, useRef, useState } from "react";
import type { CctpAssetReleaseEvidence } from "./cctp-asset-release";
import { verifySignedCctpAssetReleaseManifest, type CctpAssetReleaseHead } from "./cctp-asset-release-policy";
import { verifyCctpDeploymentMetadataReview } from "./cctp-deployment-metadata-review";

const DAY = 86_400_000;
const MAX_BYTES = 256_000;
const KEYS = ["source", "releaseManifest", "verificationArtifact", "metadataReview", "deploymentReport"] as const;
type Bundle = Record<typeof KEYS[number], unknown>;
type Checked = ReturnType<typeof verifyCctpDeploymentMetadataReview>;
type Result = { checked: Checked; evidence: CctpAssetReleaseEvidence; fingerprint: string; bundle: Bundle; deadline: number };

export default function CctpReleaseReviewPanel({ evidence }: { evidence?: CctpAssetReleaseEvidence }) {
  const id = useId();
  const [fingerprint, setFingerprint] = useState("");
  const [bundle, setBundle] = useState<Bundle>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Result>();
  const generation = useRef(0);
  const heads = useRef(new Map<string, CctpAssetReleaseHead>());
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => { setResult(undefined); setMessage(""); }, [evidence]);
  useEffect(() => {
    if (!result) return;
    const remaining = result.deadline - Date.now();
    const timer = window.setTimeout(() => { setResult(undefined); setMessage("Evidence expired — verify again."); }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [result]);
  const visibleResult = result && result.evidence === evidence && result.fingerprint === fingerprint && result.bundle === bundle && result.deadline > Date.now() ? result : undefined;
  const pinValid = /^0x[0-9a-f]{64}$/.test(fingerprint);
  const ready = Boolean(evidence && pinValid && bundle && !loading);

  const importBundle = async (file?: File) => {
    const request = ++generation.current;
    setResult(undefined); setBundle(undefined); setMessage(""); setLoading(false);
    if (!file) return;
    if (file.size > MAX_BYTES) { setMessage("Review rejected. Use a JSON bundle no larger than 256 KB."); return; }
    setLoading(true);
    try {
      const text = await file.text();
      if (request !== generation.current) return;
      if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("TOO_LARGE");
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(parsed, key))) throw new Error("INVALID_BUNDLE");
      setBundle(parsed as Bundle);
    } catch {
      if (request === generation.current) setMessage("Review rejected. Check the bundle format and size; no evidence was accepted.");
    } finally { if (request === generation.current) setLoading(false); }
  };

  const verify = () => {
    setResult(undefined); setMessage("");
    if (!evidence || !bundle || !pinValid || loading) return;
    try {
      const now = Date.now();
      const parent = verifySignedCctpAssetReleaseManifest(bundle.releaseManifest, bundle.source, fingerprint, evidence, bundle.verificationArtifact, { now, previousHead: heads.current.get(fingerprint) });
      heads.current.set(fingerprint, { revision: parent.manifest.revision, payloadHash: parent.payloadHash });
      const checked = verifyCctpDeploymentMetadataReview(bundle.metadataReview, bundle.deploymentReport, parent, fingerprint, evidence, now);
      const deadline = Math.min(Date.parse(parent.manifest.expiresAt), Date.parse(checked.manifest.expiresAt), Date.parse(checked.report.observedAt) + DAY, evidence.observedAt + DAY);
      if (!Number.isFinite(deadline) || deadline <= now) throw new Error("EXPIRED");
      setResult({ checked, evidence, fingerprint, bundle, deadline });
    } catch { setMessage("Review rejected. Check the trusted reviewer, signatures, current identity and evidence dates. CCTP remains disabled."); }
  };

  return <details className="cctp-review-panel">
    <summary>Review signed evidence <span>Read-only</span></summary>
    <div className="cctp-review-content">
      <p id={`${id}-notice`}>Verify an existing reviewer signature locally. This does not connect a wallet, request a signature, send assets or enable CCTP.</p>
      <label htmlFor={`${id}-pin`}>Trusted reviewer fingerprint</label>
      <input id={`${id}-pin`} value={fingerprint} spellCheck={false} autoComplete="off" placeholder="0x… (64 hexadecimal characters)" aria-describedby={`${id}-pin-help`} onChange={event => { setFingerprint(event.target.value); setResult(undefined); setMessage(""); }} />
      <small id={`${id}-pin-help`}>Obtain this fingerprint through a trusted channel outside the bundle. It is never filled from the uploaded file.</small>
      <label htmlFor={`${id}-file`}>Signed review bundle JSON</label>
      <input id={`${id}-file`} type="file" accept=".json,application/json" aria-describedby={`${id}-file-help`} onChange={event => { void importBundle(event.target.files?.[0]); event.target.value = ""; }} />
      <small id={`${id}-file-help`}>Up to 256 KB. Public evidence only — never private keys or seed phrases. The file is not uploaded or saved to browser storage.</small>
      <details className="cctp-review-format"><summary>Bundle format</summary><p>Include exactly these five JSON objects:</p><code>source, releaseManifest, verificationArtifact, metadataReview, deploymentReport</code><p>The source describes the reviewer; the two signed reviews bind the original bytecode artifact and the full-runtime report. No observation from the file is trusted.</p></details>
      <p className="cctp-review-prerequisites" aria-live="polite">{loading ? "Reading local bundle…" : !evidence ? "First recheck current USDC identity using the two pinned RPCs above." : !pinValid ? "Enter a trusted reviewer fingerprint to continue." : !bundle ? "Choose a signed review bundle to continue." : "Bundle loaded, not yet verified. Check the evidence below."}</p>
      <button className="secondary-button" type="button" onClick={verify} disabled={!ready} aria-describedby={`${id}-notice`}>Verify review evidence</button>
      {message && <p className="cctp-review-error" role="alert">{message}</p>}
      {visibleResult && <div className="cctp-review-result" role="status">
        <strong>Evidence reviewed — CCTP remains disabled</strong>
        <p>Three contract runtimes and metadata match the pinned deployment profile, and the reviewer signatures match this observation. This is not a security audit or release approval.</p>
        <dl><div><dt>Report SHA-256</dt><dd>{visibleResult.checked.reportSha256}</dd></div><div><dt>Parent review hash</dt><dd>{visibleResult.checked.releasePayloadHash}</dd></div><div><dt>Valid until</dt><dd>{new Date(visibleResult.deadline).toISOString()}</dd></div></dl>
      </div>}
      <small>Evidence checks and revision tracking here are limited to this open panel. They do not provide a durable release history or enable a route.</small>
    </div>
  </details>;
}
