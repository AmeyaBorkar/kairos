import { type PaymentMethod, type Slice, sliceCovers, sliceKey } from "@kairos/domain";

/** One rail, as the detector currently sees it. */
export interface RailObservation {
  readonly slice: Slice;
  /** Current failure-rate estimate in `[0,1]`. */
  readonly failureRate: number;
  /** Relative volume. Only ratios matter, so any consistent unit works. */
  readonly share: number;
}

/**
 * What the detector knows about every rail right now.
 *
 * Steering needs more than "this slice is broken". It needs to know what customers moved off a
 * broken rail would move *onto*, and how much traffic that is, because a steer is only worth making
 * when the destination is better than the origin — and on Indian traffic that is very often not
 * true. UPI runs at around 2% failure and cards at 11%, so nudging people off UPI can cost more
 * than the outage it is responding to.
 */
export class RailHealth {
  readonly #byKey: ReadonlyMap<string, RailObservation>;
  readonly #observations: readonly RailObservation[];

  constructor(observations: readonly RailObservation[]) {
    this.#observations = observations;
    this.#byKey = new Map(observations.map((o) => [sliceKey(o.slice), o]));
  }

  get observations(): readonly RailObservation[] {
    return this.#observations;
  }

  /** The exact slice, if it is observed. */
  find(slice: Slice): RailObservation | null {
    return this.#byKey.get(sliceKey(slice)) ?? null;
  }

  /** Every observation the given slice covers, itself included. */
  covered(slice: Slice): readonly RailObservation[] {
    return this.#observations.filter((o) => sliceCovers(slice, o.slice));
  }

  /** Total volume, in the same relative units as {@link RailObservation.share}. */
  totalShare(): number {
    return this.#observations.reduce((sum, o) => sum + o.share, 0);
  }

  /** Volume under a slice, summed over everything it covers. */
  shareOf(slice: Slice): number {
    return this.covered(slice).reduce((sum, o) => sum + o.share, 0);
  }

  /**
   * Volume-weighted failure rate under a slice.
   *
   * Weighted rather than averaged, because the arithmetic mean of rail failure rates is a number
   * about rails and the volume-weighted one is a number about customers. Only the second predicts
   * how many payments fail.
   */
  rateOf(slice: Slice): number {
    const covered = this.covered(slice);
    let weighted = 0;
    let total = 0;
    for (const o of covered) {
      weighted += o.share * o.failureRate;
      total += o.share;
    }
    return total === 0 ? 0 : weighted / total;
  }

  /** Methods present in the snapshot, in descending order of volume. */
  methods(): readonly PaymentMethod[] {
    const shares = new Map<PaymentMethod, number>();
    for (const o of this.#observations) {
      shares.set(o.slice.method, (shares.get(o.slice.method) ?? 0) + o.share);
    }
    return [...shares.entries()].sort((a, b) => b[1] - a[1]).map(([method]) => method);
  }

  /**
   * The rate a customer lands on if they are moved off `avoid` and choose among the rest by volume.
   *
   * Modelling the destination as "everything else, in proportion to how popular it already is" is a
   * simplification, and a conservative one: a real customer displaced from UPI is more likely to
   * reach for a wallet than for netbanking. It is stated here rather than buried because the sign of
   * a steering decision can turn on it.
   */
  destinationRate(avoid: readonly PaymentMethod[]): number {
    const excluded = new Set(avoid);
    let weighted = 0;
    let total = 0;
    for (const o of this.#observations) {
      if (excluded.has(o.slice.method)) continue;
      weighted += o.share * o.failureRate;
      total += o.share;
    }
    return total === 0 ? 0 : weighted / total;
  }

  /** How many distinct methods remain once `removed` are taken away. */
  methodsRemaining(removed: readonly PaymentMethod[]): number {
    const excluded = new Set(removed);
    return this.methods().filter((m) => !excluded.has(m)).length;
  }
}
