import {
  type Attempt,
  attemptId,
  customerRef,
  orderId,
  paise,
  type Slice,
  sliceCovers,
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

/** Pseudonymous, deterministic, and long enough to satisfy the CustomerRef invariant. */
function customerAt(index: number): string {
  return `c${index.toString(16).padStart(23, "0")}`;
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
    yield {
      id: attemptId(`pay_${sequence.toString(36).padStart(9, "0")}`),
      orderId: orderId(`order_${sequence.toString(36).padStart(9, "0")}`),
      customer: customerRef(customerAt(rng.int(poolSize))),
      amount,
      slice: profile.slice,
      status: failed ? "failed" : "captured",
      failure: failed ? drawFailure(rng, profile.slice.method, fromDegradation) : null,
      at: Math.round(at),
    };
  }
}
