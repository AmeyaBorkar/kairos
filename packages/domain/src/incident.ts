import type { IncidentId } from "./identifiers.js";
import type { Slice } from "./slice.js";

/**
 * Incidents are a state machine, not a boolean.
 *
 * `clearing` exists because of hysteresis: evidence has decayed below the clear threshold but the
 * minimum dwell time has not elapsed. Collapsing `clearing` into `resolved` is what makes a
 * detector flap — steering off, back on, off again every few seconds — which is worse for a
 * merchant than never having steered at all.
 */
export type IncidentState = "open" | "clearing" | "resolved";

export interface Incident {
  readonly id: IncidentId;
  readonly slice: Slice;
  /** When the degradation actually began, as estimated by the changepoint. */
  readonly onsetAt: number;
  /** When the detector alarmed. `detectedAt - onsetAt` is detection latency, the headline metric. */
  readonly detectedAt: number;
  readonly resolvedAt: number | null;
  readonly state: IncidentState;
  /** Failure rate in [0,1] before onset, frozen so the incident cannot poison its own baseline. */
  readonly baselineFailureRate: number;
  /** Worst observed failure rate in [0,1]. */
  readonly peakFailureRate: number;
  /** Whether Razorpay independently declared downtime, and when. Corroboration, never a trigger. */
  readonly gatewayDeclaredAt: number | null;
}

export function isActive(i: Incident): boolean {
  return i.state !== "resolved";
}

/**
 * Detection latency in milliseconds — how long the merchant bled before Kairos noticed.
 *
 * Measured from estimated onset rather than from the first alarm-worthy sample, because the
 * flattering version of this number is the one measured from when we started paying attention.
 */
export function detectionLatencyMs(i: Incident): number {
  return Math.max(0, i.detectedAt - i.onsetAt);
}

/** How long the incident ran, or has run so far. */
export function incidentDurationMs(i: Incident, now: number): number {
  return Math.max(0, (i.resolvedAt ?? now) - i.onsetAt);
}
