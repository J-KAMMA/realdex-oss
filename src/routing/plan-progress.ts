import { routeDescriptorFingerprint } from "./engine";
import type { ExecutionGuardStorage } from "./execution-guard";
import type { RoutePlan } from "./plan";
import type { RouteDescriptor, RouteExecutionReceipt } from "./types";

// Walking a plan is not the same as counting its legs. A leg is only behind the
// holder once its value has actually arrived on the other side — a bridge that
// has been submitted but not attested is money in flight, and starting the next
// leg against it would be spending something that is not there yet.
//
// The other half is what happens when a walk stops. It matters a great deal
// whether nothing moved, or whether the first leg went through and the holder is
// now sitting on the intermediate asset: the first is a retry, the second is a
// position someone has to decide what to do with. Saying "failed" for both would
// hide the only part that costs anything.
const SCHEMA = "realdex.route-plan-progress.v1" as const;
const FINGERPRINT = /^0x[0-9a-f]{64}$/;
const MAXIMUM_LEGS = 8;

export type RoutePlanLegOutcome = {
  legIndex: number;
  routeFingerprint: string;
  quoteId: string;
  receipt: RouteExecutionReceipt;
};

export type RoutePlanState =
  /** The next leg may be started. */
  | { kind: "ready"; legIndex: number; route: RouteDescriptor; heldAsset: string }
  /** Submitted, not yet arrived. Nothing may start against it. */
  | { kind: "awaiting-settlement"; legIndex: number; route: RouteDescriptor; stage: string }
  /** Every leg arrived. */
  | { kind: "complete"; destinationAsset: string }
  /** The walk stopped before any value left the holder's hands. */
  | { kind: "stopped-before-any-value-moved"; legIndex: number; heldAsset: string; code: string }
  /** A leg went through and the next did not. The holder is sitting on this. */
  | { kind: "holding-intermediate"; legIndex: number; heldAsset: string; code: string }
  /** The outcome cannot be read as either done or undone. Nothing may proceed. */
  | { kind: "indeterminate"; legIndex: number; heldAsset: string }
  /** The route this plan was built on is not the route on offer any more. */
  | { kind: "plan-superseded"; legIndex: number; heldAsset: string };

/** The assets the holder holds before each leg, plus the final destination. */
export function routePlanAssetsInOrder(plan: RoutePlan): string[] {
  return [plan.sourceAsset, ...plan.intermediateAssets, plan.destinationAsset];
}

/** True once a leg's value has actually arrived, not merely been submitted. */
function routePlanLegHasSettled(route: RouteDescriptor, receipt: RouteExecutionReceipt): boolean {
  if (receipt.state !== "confirmed") return false;
  // A bridge without a finality record has not been observed arriving, whatever
  // its own receipt claims. A swap settles with its own transaction.
  if (route.operation === "bridge") return receipt.finality?.stage === "destination-confirmed";
  return receipt.finality === undefined || receipt.finality.stage === "destination-confirmed";
}

export function routePlanState(plan: RoutePlan, outcomes: readonly RoutePlanLegOutcome[]): RoutePlanState {
  assertOutcomeSequence(plan, outcomes);
  const assets = routePlanAssetsInOrder(plan);

  for (const outcome of outcomes) {
    const index = outcome.legIndex;
    const route = plan.legs[index];
    const heldAsset = assets[index];
    if (outcome.routeFingerprint !== routeDescriptorFingerprint(route)) return { kind: "plan-superseded", legIndex: index, heldAsset };
    const receipt = outcome.receipt;
    if (receipt.quoteId !== outcome.quoteId) return { kind: "plan-superseded", legIndex: index, heldAsset };

    if (routePlanLegHasSettled(route, receipt)) continue;
    if (receipt.state === "confirmed" || receipt.state === "pending") {
      return { kind: "awaiting-settlement", legIndex: index, route, stage: receipt.finality?.stage ?? "source-submitted" };
    }
    if (receipt.state === "unknown") return { kind: "indeterminate", legIndex: index, heldAsset };
    // Failed. A revert moves nothing, so whichever leg fell over, the holder is
    // still holding whatever that leg was about to spend.
    const code = receipt.failureProof?.type ?? "unknown-failure";
    return index === 0
      ? { kind: "stopped-before-any-value-moved", legIndex: index, heldAsset, code }
      : { kind: "holding-intermediate", legIndex: index, heldAsset, code };
  }

  if (outcomes.length === plan.legs.length) return { kind: "complete", destinationAsset: plan.destinationAsset };
  const legIndex = outcomes.length;
  return { kind: "ready", legIndex, route: plan.legs[legIndex], heldAsset: assets[legIndex] };
}

function assertOutcomeSequence(plan: RoutePlan, outcomes: readonly RoutePlanLegOutcome[]): void {
  if (!plan.legs.length || plan.legs.length > MAXIMUM_LEGS) throw new Error("ROUTE_PLAN_PROGRESS_INVALID");
  if (outcomes.length > plan.legs.length) throw new Error("ROUTE_PLAN_PROGRESS_INVALID");
  // Contiguous from the first leg. A gap would mean a leg ran unobserved.
  outcomes.forEach((outcome, position) => {
    if (outcome.legIndex !== position) throw new Error("ROUTE_PLAN_PROGRESS_INVALID");
    if (!outcome.quoteId.trim()) throw new Error("ROUTE_PLAN_PROGRESS_INVALID");
    if (!FINGERPRINT.test(outcome.routeFingerprint)) throw new Error("ROUTE_PLAN_PROGRESS_INVALID");
  });
}

/**
 * The same answer, from a walk that was written down rather than one held in
 * memory. The record keeps a summary — there is no receipt in it — so reading a
 * stopped walk back needed its own way in. Without this the record could be
 * written and re-read and still not say what to do next, which is most of why it
 * exists.
 */
export function routePlanStateFromRecord(plan: RoutePlan, record: RoutePlanProgressRecord): RoutePlanState {
  if (!routePlanProgressMatchesPlan(record, plan)) {
    return { kind: "plan-superseded", legIndex: 0, heldAsset: plan.sourceAsset };
  }
  const assets = routePlanAssetsInOrder(plan);
  for (const leg of record.legs) {
    const index = leg.legIndex;
    const heldAsset = assets[index];
    if (leg.settled) continue;
    if (leg.receiptState === "confirmed" || leg.receiptState === "pending") {
      return { kind: "awaiting-settlement", legIndex: index, route: plan.legs[index], stage: leg.finalityStage ?? "source-submitted" };
    }
    if (leg.receiptState === "unknown") return { kind: "indeterminate", legIndex: index, heldAsset };
    return index === 0
      ? { kind: "stopped-before-any-value-moved", legIndex: index, heldAsset, code: "recorded-failure" }
      : { kind: "holding-intermediate", legIndex: index, heldAsset, code: "recorded-failure" };
  }
  if (record.legs.length === plan.legs.length) return { kind: "complete", destinationAsset: plan.destinationAsset };
  const legIndex = record.legs.length;
  return { kind: "ready", legIndex, route: plan.legs[legIndex], heldAsset: assets[legIndex] };
}

// ---------------------------------------------------------------- persistence

export type RoutePlanProgressLeg = {
  legIndex: number;
  routeFingerprint: string;
  quoteId: string;
  receiptState: RouteExecutionReceipt["state"];
  finalityStage?: string;
  settled: boolean;
};

export type RoutePlanProgressRecord = {
  schema: typeof SCHEMA;
  progressKey: string;
  planId: string;
  sourceAsset: string;
  destinationAsset: string;
  amountInBaseUnits: string;
  legFingerprints: string[];
  legs: RoutePlanProgressLeg[];
  updatedAt: number;
};

export function routePlanProgressKey(planId: string): string {
  if (!FINGERPRINT.test(planId)) throw new Error("ROUTE_PLAN_PROGRESS_KEY_INVALID");
  return `localswap:route-plan-progress:${planId}`;
}

export function createRoutePlanProgressRecord(plan: RoutePlan, outcomes: readonly RoutePlanLegOutcome[], updatedAt = Date.now()): RoutePlanProgressRecord {
  assertOutcomeSequence(plan, outcomes);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new Error("ROUTE_PLAN_PROGRESS_TIMESTAMP_INVALID");
  return {
    schema: SCHEMA,
    progressKey: routePlanProgressKey(plan.planId),
    planId: plan.planId,
    sourceAsset: plan.sourceAsset,
    destinationAsset: plan.destinationAsset,
    // Base units are bigint and JSON cannot hold one; a decimal string can.
    amountInBaseUnits: plan.amountInBaseUnits.toString(),
    legFingerprints: plan.legs.map((leg) => routeDescriptorFingerprint(leg)),
    legs: outcomes.map((outcome) => ({
      legIndex: outcome.legIndex,
      routeFingerprint: outcome.routeFingerprint,
      quoteId: outcome.quoteId,
      receiptState: outcome.receipt.state,
      ...(outcome.receipt.finality ? { finalityStage: outcome.receipt.finality.stage } : {}),
      settled: routePlanLegHasSettled(plan.legs[outcome.legIndex], outcome.receipt)
    })),
    updatedAt
  };
}

export function assertRoutePlanProgressRecord(value: unknown, expectedKey?: string): asserts value is RoutePlanProgressRecord {
  if (!isObject(value) || !exactKeys(value, ["schema", "progressKey", "planId", "sourceAsset", "destinationAsset", "amountInBaseUnits", "legFingerprints", "legs", "updatedAt"])) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
  if (value.schema !== SCHEMA || typeof value.planId !== "string" || !FINGERPRINT.test(value.planId)) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
  if (typeof value.sourceAsset !== "string" || typeof value.destinationAsset !== "string" || typeof value.amountInBaseUnits !== "string" || !/^[1-9]\d*$/.test(value.amountInBaseUnits)) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
  if (!Array.isArray(value.legFingerprints) || !value.legFingerprints.length || value.legFingerprints.length > MAXIMUM_LEGS || value.legFingerprints.some((entry) => typeof entry !== "string" || !FINGERPRINT.test(entry))) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
  // Held in a local so the narrowing survives into the callback below.
  const fingerprints: string[] = value.legFingerprints;
  if (!Array.isArray(value.legs) || value.legs.length > fingerprints.length) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
  value.legs.forEach((leg: unknown, position: number) => {
    if (!isObject(leg) || leg.legIndex !== position || typeof leg.quoteId !== "string" || !leg.quoteId.trim()) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
    if (typeof leg.routeFingerprint !== "string" || leg.routeFingerprint !== fingerprints[position]) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_CHANGED");
    if (!["pending", "confirmed", "failed", "unknown"].includes(String(leg.receiptState)) || typeof leg.settled !== "boolean") throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
    if (leg.finalityStage !== undefined && (typeof leg.finalityStage !== "string" || !leg.finalityStage.trim())) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
    // A settled leg that never confirmed would let a resume skip live money.
    if (leg.settled && leg.receiptState !== "confirmed") throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
  });
  if (!Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) <= 0) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_INVALID");
  const derived = routePlanProgressKey(value.planId);
  if (value.progressKey !== derived || (expectedKey !== undefined && value.progressKey !== expectedKey)) throw new Error("ROUTE_PLAN_PROGRESS_RECORD_CHANGED");
}

export function persistRoutePlanProgress(storage: ExecutionGuardStorage, record: RoutePlanProgressRecord): void {
  assertRoutePlanProgressRecord(record);
  storage.setItem(record.progressKey, JSON.stringify(record));
}

/** Reads a stopped walk back. An unreadable or altered record is not a walk. */
export function readRoutePlanProgress(storage: ExecutionGuardStorage, planId: string): RoutePlanProgressRecord | null {
  const key = routePlanProgressKey(planId);
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { return null; }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    assertRoutePlanProgressRecord(value, key);
    return value;
  } catch {
    return null;
  }
}

/** True when the stored walk was built on the plan it is being resumed against. */
export function routePlanProgressMatchesPlan(record: RoutePlanProgressRecord, plan: RoutePlan): boolean {
  const fingerprints = plan.legs.map((leg) => routeDescriptorFingerprint(leg));
  return record.planId === plan.planId
    && record.legFingerprints.length === fingerprints.length
    && record.legFingerprints.every((entry, index) => entry === fingerprints[index]);
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
