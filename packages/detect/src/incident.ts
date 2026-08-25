import { type Incident, type IncidentId, incidentId, sliceKey } from "@kairos/domain";
import type { DetectedIncident } from "./engine.js";

/**
 * A stable id for one incident.
 *
 * Derived from the slice and the estimated onset rather than generated, so that the same outage
 * gets the same id in every process that observes it — which is what lets two `sentry` instances
 * agree on a holdout assignment without coordinating, since the assignment is a hash of the
 * customer and this id.
 *
 * The onset estimate can move as evidence accumulates, and when it does the id moves with it. That
 * is a real limitation: a customer could in principle change arms mid-incident if the changepoint
 * is revised. It is bounded by the fact that the estimate only moves before the incident opens —
 * once opened, the onset recorded here is frozen.
 */
export function idFor(detected: DetectedIncident): IncidentId {
  const key = sliceKey(detected.slice).replace(/\|/g, "_");
  return incidentId(`inc_${key}_${detected.onsetAt.toString(36)}`);
}

/**
 * Lift a detector's finding into the domain incident the rest of the system reasons about.
 *
 * The detector reports what it saw; the domain type carries what the incident *is*. Keeping the
 * conversion in one place means `sentry` and the measurement harness cannot disagree about it —
 * and they must not, because the id it produces is what the holdout assignment hashes.
 */
export function incidentFrom(detected: DetectedIncident): Incident {
  return {
    id: idFor(detected),
    slice: detected.slice,
    onsetAt: detected.onsetAt,
    detectedAt: detected.detectedAt,
    resolvedAt: null,
    state: "open",
    baselineFailureRate: detected.baselineRate,
    peakFailureRate: detected.peakRate,
    gatewayDeclaredAt: null,
  };
}
