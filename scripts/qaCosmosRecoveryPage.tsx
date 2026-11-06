// Synthetic UI fixture only. The QA server stubs all policy and lookup services.
import React from "react";
import { createRoot } from "react-dom/client";
import CosmosRecoveryPanel from "../src/swap/CosmosRecoveryPanel";
import "../src/styles.css";

const qa = window as any;
const now = Date.now();
const record = { chainId: "cosmos:osmosis-1", transactionHash: "B".repeat(64), stage: "signed-not-submitted", updatedAt: now, observations: [] };
qa.__recovery = {
  calls: 0, mode: "success", record, head: { revision: 2, payloadHash: "a".repeat(64) },
  props: {
    evidence: { readPolicySourceFingerprint: "f".repeat(64) }, initialRecord: record,
    policy: { sourceFingerprint: "f".repeat(64), payloadHash: "a".repeat(64), verifiedAt: now,
      policy: { chainId: record.chainId, revision: 2, expiresAt: new Date(now + 600_000).toISOString(), recoveryBoundaryId: "cosmos-swap-recovery-v1", restEndpoints: ["https://cosmos-rest-a.example.org/long-reviewer-approved-endpoint-path", "https://cosmos-rest-b.example.net/another-long-reviewer-approved-endpoint-path"] } },
    readHead: () => qa.__recovery.head
  },
  result: (stage = "committed-success") => ({
    record: { ...record, stage, observations: [0, 1].map(index => ({ readerId: `https://reader-${index}.example.org/observation`, blockHeight: "9876543210", transactionHeight: "9876543209", code: stage === "committed-failed" ? 5 : 0, codespace: "", gasWanted: "250000", gasUsed: "184321" })) },
    checkedAt: Date.now(), policyRevision: 2, policyPayloadHash: "a".repeat(64), policySourceFingerprint: "f".repeat(64), executionEnabled: false, broadcastEnabled: false, resendBlocked: true
  })
};
const root = createRoot(document.getElementById("qa-root")!);
qa.__renderRecovery = () => root.render(<main style={{ maxWidth: 720, margin: "16px auto", padding: "0 12px" }}>
  <p>Synthetic UI fixture — no real wallet or chain requests</p>
  <div className="cosmos-signing-review"><CosmosRecoveryPanel {...qa.__recovery.props} /></div>
</main>);
qa.__renderRecovery();
