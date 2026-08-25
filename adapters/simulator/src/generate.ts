import {
  type Attempt,
  attemptId,
  customerRef,
  orderId,
  paise,
  type Slice,
  sliceCovers,
  stableDraw,
} from "@kairos/domain";
import { drawFailure } from "./failures.js";
import type { SliceProfile } from "./profiles.js";
import { Rng } from "./rng.js";

/**
 * An injected rail degradation with a known onset — the ground truth detection latency is measured
 * against.
 *
 * `slice` may be coarser than any profile: a degradation on `{upi, hdfc}` hits every app under that
 * issuer at once, which is the shape a real issuer outage takes and the case hierarchical rollup
 * exists to handle.
 */
export interface Degradation {
  readonly slice: Slice;
  /** The moment the rail starts going wrong. Latency is measured from here, not from the plateau. */
  readonly onsetAt: number;
  /** Time to reach the plateau. Zero is a cliff; minutes is a slow bleed, which is far harder. */
  readonly rampMs: number;
  readonly peakFailureRate: number;
  readonly holdMs: number;
  readonly recoveryMs: number;
}

export interface SimulatorConfig {
  readonly seed: number;
  readonly startAt: number;
  readonly durationMs: number;
  readonly attemptsPerMinute: number;
  readonly profiles: readonly SliceProfile[];
  readonly degradations: readonly Degradation[];
  /** Distinct customers in circulation. Repeat customers matter once contact caps exist. */
  readonly customerPool?: number;
  /**
   * Share of payments made against a token or a mandate, and therefore chargeable again in silence.
   *
   * The single number that decides how much of the recovery arm is available. Subscriptions,
   * saved-card checkouts with consent and UPI Autopay can be retried by a server; a one-off UPI or
   * card payment cannot, because the customer has to enter a PIN or an OTP. A merchant with no
   * recurring business has no autonomous retries at all and a recovery arm made entirely of
   * messages.
   */
  readonly mandatedShare?: number;
}

export function degradationEndsAt(d: Degradation): number {
  return d.onsetAt + d.rampMs + d.holdMs + d.recoveryMs;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, t));
}

/** The failure rate one degradation imposes on a covered slice at `at`. */
function degradedRate(d: Degradation, base: number, at: number): number {
  const rampEnd = d.onsetAt + d.rampMs;
  const holdEnd = rampEnd + d.holdMs;
  const end = holdEnd + d.recoveryMs;

  if (at < d.onsetAt || at >= end) return base;
  if (at < rampEnd) {
    return d.rampMs === 0
      ? d.peakFailureRate
      : lerp(base, d.peakFailureRate, (at - d.onsetAt) / d.rampMs);
  }
  if (at < holdEnd) return d.peakFailureRate;
  return d.recoveryMs === 0 ? base : lerp(d.peakFailureRate, base, (at - holdEnd) / d.recoveryMs);
}

/**
 * True failure rate for a slice at a moment, across every degradation covering it.
 *
 * The worst covering degradation wins rather than the sum. Two overlapping outages on the same rail
 * do not make failure twice as likely — the rail is already broken, and adding rates would push
 * past 1 and produce a rate that means nothing.
 */
export function failureRateAt(config: SimulatorConfig, profile: SliceProfile, at: number): number {
  let rate = profile.baseFailureRate;
  for (const d of config.degradations) {
    if (sliceCovers(d.slice, profile.slice)) {
      rate = Math.max(rate, degradedRate(d, profile.baseFailureRate, at));
    }
  }
  return Math.min(0.999, rate);
}

/** Whether a slice is being actively degraded at `at`, above its own baseline. */
export function isDegraded(config: SimulatorConfig, profile: SliceProfile, at: number): boolean {
  return failureRateAt(config, profile, at) > profile.baseFailureRate + 1e-9;
}

const DEFAULT_CUSTOMER_POOL = 20_000;

/**
 * A mixed Indian merchant: some subscriptions and saved cards, mostly one-off checkouts.
 *
 * Deliberately not generous. A tool that assumes most payments are retryable would report a
 * recovery arm that does not exist for the merchants most likely to want one.
 */
const DEFAULT_MANDATED_SHARE = 0.14;

/** Pseudonymous, deterministic, and long enough to satisfy the CustomerRef invariant. */
function customerAt(index: number): string {
  return `c${index.toString(16).padStart(23, "0")}`;
}

/**
 * One generated attempt, with the fact the system is not allowed to see.
 *
 * `fromDegradation` is ground truth: whether this failure was caused by the injected outage or
 * would have happened on a perfectly healthy rail. Nothing in Kairos may read it — it exists so the
 * harness can score the classifier against what actually happened rather than against itself.
 */
export interface LabelledAttempt {
  readonly attempt: Attempt;
  readonly fromDegradation: boolean;
  /** Whether this payment could be charged again with nobody present. */
  readonly retry: "autonomous" | "requires-customer";
}

/**
 * Generate the attempt stream.
 *
 * Arrivals are Poisson — exponential gaps rather than a fixed cadence — because burstiness is what
 * makes a detector's false-alarm behaviour interesting. Evenly spaced traffic makes any detector
 * look better than it is.
 *
 * A generator rather than an array: a day of traffic at a realistic rate is millions of attempts,
 * and the harness only ever needs one at a time.
 */
export function* generate(config: SimulatorConfig): Generator<Attempt> {
  for (const labelled of generateLabelled(config)) yield labelled.attempt;
}

/**
 * The same stream, carrying the ground truth alongside each attempt.
 *
 * Split from {@link generate} rather than folded into the {@link Attempt} type, because a field on
 * the domain object would be a fact about the world sitting in a struct the detector reads, and
 * sooner or later something would read it. Ground truth belongs beside the data, never inside it.
 */
export function* generateLabelled(config: SimulatorConfig): Generator<LabelledAttempt> {
  const rng = new Rng(config.seed);
  const poolSize = config.customerPool ?? DEFAULT_CUSTOMER_POOL;
  const meanGapMs = 60_000 / config.attemptsPerMinute;
  const endAt = config.startAt + config.durationMs;

  let at = config.startAt;
  let sequence = 0;

  while (at < endAt) {
    at += rng.exponential(meanGapMs);
    if (at >= endAt) return;

    const profile = rng.pick(config.profiles, (p) => p.share);
    const rate = failureRateAt(config, profile, at);
    const base = profile.baseFailureRate;

    const roll = rng.next();
    const failed = roll < rate;
    // Below the baseline it is an ordinary failure; the band above it is the degradation's doing.
    // That split is what makes the excess failures during an incident overwhelmingly retryable.
    const fromDegradation = failed && roll >= base;

    const amount = paise(
      Math.round(Math.min(200_000, Math.max(50, rng.logNormal(6.4, 0.85)))) * 100,
    );

    sequence++;
    const id = `pay_${sequence.toString(36).padStart(9, "0")}`;

    // Whether this payment could be charged again with nobody present. A token, a UPI Autopay
    // mandate or an e-mandate can; a one-off checkout payment cannot, because UPI needs a PIN and a
    // card needs an OTP. The share is a stated assumption about the merchant's mix, and it decides
    // how much of the recovery arm is available at all.
    //
    // Drawn from the attempt's own id rather than from the main generator, so adding this fact left
    // every previously published benchmark reproducible from its seed. A new draw in the shared
    // stream would have shifted every subsequent number in the run.
    const autonomous =
      stableDraw("mandated", String(config.seed), id) <
      (config.mandatedShare ?? DEFAULT_MANDATED_SHARE);

    yield {
      attempt: {
        id: attemptId(id),
        orderId: orderId(`order_${sequence.toString(36).padStart(9, "0")}`),
        customer: customerRef(customerAt(rng.int(poolSize))),
        amount,
        slice: profile.slice,
        status: failed ? "failed" : "captured",
        failure: failed ? drawFailure(rng, profile.slice.method, fromDegradation) : null,
        at: Math.round(at),
      },
      fromDegradation,
      retry: autonomous ? "autonomous" : "requires-customer",
    };
  }
}
