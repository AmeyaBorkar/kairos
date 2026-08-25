import { type Incident, type IncidentId, incidentId, type Slice, slice } from "@kairos/domain";
import { RailHealth, type RailObservation } from "./health.js";

/**
 * A plausible Indian merchant's rail health, in the shape the detector reports it.
 *
 * Shares and healthy rates mirror the simulator's `INDIA_PROFILES` so that policy decisions are
 * exercised against the same traffic mix the detector was calibrated on — but they are declared
 * here rather than imported, because a core package taking a dependency on an adapter to run its
 * own tests would invert the architecture to save fifteen lines.
 *
 * The shape matters more than the exact numbers. UPI carries about seventy per cent of volume and
 * fails around 2%; cards carry a fifth and fail around 12%. That gap is what makes steering off UPI
 * expensive, and it is the reason most of these decisions come out the way they do.
 */
const HEALTHY: readonly (readonly [Slice, number, number])[] = [
  [slice("upi", "hdfc", "phonepe"), 118, 0.017],
  [slice("upi", "hdfc", "gpay"), 96, 0.016],
  [slice("upi", "sbi", "phonepe"), 104, 0.043],
  [slice("upi", "sbi", "gpay"), 82, 0.041],
  [slice("upi", "icici", "gpay"), 71, 0.019],
  [slice("upi", "icici", "paytm"), 38, 0.022],
  [slice("upi", "axis", "phonepe"), 54, 0.024],
  [slice("upi", "kotak", "gpay"), 31, 0.021],
  [slice("upi", "pnb", "phonepe"), 29, 0.062],
  [slice("upi", "bob", "phonepe"), 22, 0.071],
  [slice("upi", "canara", "paytm"), 4, 0.058],
  [slice("card", "hdfc", "visa"), 47, 0.112],
  [slice("card", "hdfc", "mastercard"), 33, 0.118],
  [slice("card", "icici", "visa"), 29, 0.124],
  [slice("card", "sbi", "rupay"), 26, 0.143],
  [slice("card", "axis", "mastercard"), 18, 0.131],
  [slice("card", "kotak", "visa"), 11, 0.109],
  [slice("netbanking", "hdfc"), 21, 0.094],
  [slice("netbanking", "sbi"), 24, 0.127],
  [slice("netbanking", "icici"), 14, 0.098],
  [slice("wallet", "paytm"), 17, 0.036],
  [slice("wallet", "amazonpay"), 9, 0.031],
  [slice("paylater", "lazypay"), 7, 0.081],
  [slice("emi", "hdfc", "visa"), 6, 0.096],
];

export function healthyObservations(): RailObservation[] {
  return HEALTHY.map(([s, share, failureRate]) => ({ slice: s, share, failureRate }));
}

/** Rail health with one slice pushed to a given failure rate, as an incident would leave it. */
export function healthWith(degraded: Slice, failureRate: number): RailHealth {
  const observations = healthyObservations().map((o) =>
    covers(degraded, o.slice) ? { ...o, failureRate } : o,
  );
  return new RailHealth(observations);
}

export function healthyRails(): RailHealth {
  return new RailHealth(healthyObservations());
}

function covers(outer: Slice, inner: Slice): boolean {
  if (outer.method !== inner.method) return false;
  if (outer.issuer !== null && outer.issuer !== inner.issuer) return false;
  if (outer.instrument !== null && outer.instrument !== inner.instrument) return false;
  return true;
}

export const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

export function incidentOn(
  s: Slice,
  peakFailureRate: number,
  overrides: Partial<Incident> = {},
): Incident {
  return {
    id: incidentId(`inc_${s.method}_${s.issuer ?? "all"}_${s.instrument ?? "all"}`) as IncidentId,
    slice: s,
    onsetAt: NOW - 300_000,
    detectedAt: NOW - 240_000,
    resolvedAt: null,
    state: "open",
    baselineFailureRate: 0.02,
    peakFailureRate,
    gatewayDeclaredAt: null,
    ...overrides,
  };
}
