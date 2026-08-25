/**
 * A claim that is either true or the product is broken.
 *
 * The distinction from a metric is not one of importance, it is one of *kind*. A metric is an
 * estimate: it has a sampling distribution, so it has a band, and a band is the honest way to read
 * it. An invariant is not an estimate. "Spend never exceeded the budget" is a property of a
 * particular run, exactly true or exactly false, and putting a tolerance on it would be saying the
 * kernel may overspend a little. It may not.
 *
 * Two consequences fall out, and both matter:
 *
 * 1. **Invariants are never blessed.** There is nothing to update. A failing invariant is fixed in
 *    the code, not in the baseline.
 * 2. **Invariants survive a change of experiment.** A metric measured under one configuration says
 *    nothing about a run under another, so changing the harness invalidates every band. It does not
 *    invalidate "the ledger verified" — that holds whatever traffic you point at it. So when the
 *    config hash moves, {@link file://./compare.ts} stops comparing metrics and keeps checking
 *    these.
 *
 * The `positive` kind exists for a failure mode that no other check catches: a control arm that
 * stops being a control. If the naive arm in the spend benchmark stopped overspending — because the
 * harness broke, rather than because the race it demonstrates went away — every claim about the
 * kernel would still pass while proving nothing. An experiment has to be able to fail before its
 * success means anything.
 */

export type InvariantKind =
  /** A number that must be exactly zero. Overspend, orphaned reservations, unclassified failures. */
  | "zero"
  /** A number that must be greater than zero. Guards against an experiment that measured nothing. */
  | "positive"
  /** A boolean that must hold. Chain verification, detection coverage. */
  | "true"
  /** A number that must equal a stated value. Config arithmetic — trial counts, arms present. */
  | "exact";

export interface InvariantObservation {
  readonly id: string;
  readonly kind: InvariantKind;
  readonly value: number | boolean;
  /** Only meaningful for `exact`; `null` everywhere else. */
  readonly expected: number | null;
  /** What breaks if this is false, for somebody reading a red build. */
  readonly label: string;
}

export interface InvariantCheck {
  readonly ok: boolean;
  /** Why it failed, phrased so it can be read without the source open. `null` when it held. */
  readonly reason: string | null;
}

const HELD: InvariantCheck = { ok: true, reason: null };

/**
 * Check one invariant.
 *
 * A kind applied to the wrong type of value is itself a failure rather than a thrown error: the
 * scorecard is assembled from four independent harnesses, and one of them emitting a boolean where
 * a count belongs should show up as a red line in the report, not as a crash that hides the other
 * nineteen results.
 */
export function checkInvariant(observation: InvariantObservation): InvariantCheck {
  const { kind, value, expected } = observation;

  switch (kind) {
    case "zero":
      if (typeof value !== "number") return wrongType("zero", value);
      return value === 0 ? HELD : { ok: false, reason: `expected 0, observed ${value}` };

    case "positive":
      if (typeof value !== "number") return wrongType("positive", value);
      if (!Number.isFinite(value)) return { ok: false, reason: `observed ${value}` };
      return value > 0
        ? HELD
        : { ok: false, reason: `expected a value above zero, observed ${value}` };

    case "true":
      if (typeof value !== "boolean") return wrongType("true", value);
      return value ? HELD : { ok: false, reason: "expected true, observed false" };

    case "exact":
      if (typeof value !== "number") return wrongType("exact", value);
      if (expected === null) {
        return { ok: false, reason: "declared `exact` but carries no expected value" };
      }
      return value === expected
        ? HELD
        : { ok: false, reason: `expected ${expected}, observed ${value}` };
  }
}

function wrongType(kind: InvariantKind, value: unknown): InvariantCheck {
  return {
    ok: false,
    reason: `\`${kind}\` needs a ${kind === "true" ? "boolean" : "number"}, received ${typeof value}`,
  };
}

/** Convenience constructors, so a harness declares intent rather than assembling a record. */
export const invariant = {
  zero: (id: string, label: string, value: number): InvariantObservation => ({
    id,
    kind: "zero",
    value,
    expected: null,
    label,
  }),
  positive: (id: string, label: string, value: number): InvariantObservation => ({
    id,
    kind: "positive",
    value,
    expected: null,
    label,
  }),
  holds: (id: string, label: string, value: boolean): InvariantObservation => ({
    id,
    kind: "true",
    value,
    expected: null,
    label,
  }),
  exact: (id: string, label: string, value: number, expected: number): InvariantObservation => ({
    id,
    kind: "exact",
    value,
    expected,
    label,
  }),
} as const;
