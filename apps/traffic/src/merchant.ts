import type { Attempt, Casualty } from "@kairos/domain";
import { slice } from "@kairos/domain";
import { casualtyFrom } from "@kairos/recover";
import {
  type Degradation,
  generateLabelled,
  INDIA_PROFILES,
  type LabelledAttempt,
  type SimulatorConfig,
} from "@kairos/simulator";

/**
 * A merchant that is not there.
 *
 * The stack has always been able to run; what it has never had is anything to run *on*. The sentry
 * ingests outcomes nobody sends it and the worker drains a queue nothing fills, so a one-command
 * boot would have produced four healthy processes and no evidence that any of them did anything.
 * This is the traffic — the one part of the system that is honestly fake, and says so in its name.
 *
 * ## Why the simulator is paced rather than replayed
 *
 * `@kairos/simulator` generates a whole run in simulated time as fast as the CPU allows, and the
 * benchmark consumes it that way because it is measuring a decision rule and not a clock. A
 * demonstration cannot: a day of traffic delivered in four seconds shows a detector firing on data
 * that arrived before it could have observed anything, which misstates latency in the one direction
 * that flatters us. So simulated time advances against a wall clock at a stated multiple, and every
 * attempt is dispatched at the wall-clock moment its simulated moment maps to.
 *
 * ## Why the degradation is scheduled
 *
 * Somebody watching this has a few minutes. A seeded run that might degrade an hour in is a correct
 * simulation and a useless demonstration, so the incident is placed at a known offset from boot.
 * Its depth and ramp are the detection study's, not a steeper curve chosen to make detection look
 * fast.
 */
export interface MerchantOptions {
  readonly seed: number;
  /** Simulated milliseconds per real millisecond. 60 plays an hour of trade in a minute. */
  readonly speed: number;
  readonly attemptsPerMinute: number;
  /** Real milliseconds after boot at which the rail starts going wrong. */
  readonly degradeAfterMs: number;
  readonly bootAt: number;
}

export const DEFAULT_MERCHANT: Omit<MerchantOptions, "bootAt"> = {
  seed: 20_260_826,
  speed: 60,
  attemptsPerMinute: 900,
  degradeAfterMs: 45_000,
};

/**
 * The rails that fail, and how often.
 *
 * A single incident is the wrong shape for something anybody watches. At sixty times real speed an
 * incident of realistic length is over in half a minute, and a viewer who arrives at minute three
 * sees a healthy system and concludes — reasonably — that nothing works. So they recur: one every
 * three simulated hours, which is one every three real minutes, so no one waits long and no one
 * misses it.
 *
 * They alternate between two rails on purpose. Detection that only ever fires on the slice it was
 * demonstrated with is indistinguishable from a hard-coded answer, and the second rail is a card
 * BIN rather than a UPI handle so the two do not even share a method.
 *
 * The depth and the shape are the detection study's — 46% against a 4.3% baseline, over a four
 * minute ramp — not a cliff chosen to make detection look fast.
 */
const FAILING_RAILS = [slice("upi", "sbi", "phonepe"), slice("card", "hdfc", "visa")] as const;

/** Three simulated hours between onsets: at 60x, one incident every three minutes of watching. */
const INCIDENT_PERIOD_MS = 3 * 3_600_000;

export function degradationsFor(options: MerchantOptions): readonly Degradation[] {
  const first = options.bootAt + options.degradeAfterMs * options.speed;
  const spanMs = 30 * 86_400_000;
  const count = Math.ceil(spanMs / INCIDENT_PERIOD_MS);

  return Array.from({ length: count }, (_, i) => ({
    slice: FAILING_RAILS[i % FAILING_RAILS.length] as (typeof FAILING_RAILS)[number],
    onsetAt: first + i * INCIDENT_PERIOD_MS,
    rampMs: 4 * 60_000,
    peakFailureRate: 0.46,
    holdMs: 25 * 60_000,
    recoveryMs: 6 * 60_000,
  }));
}

/** The first incident — the one a viewer sees, and the one the tests measure. */
export function degradationFor(options: MerchantOptions): Degradation {
  const first = degradationsFor(options)[0];
  if (first === undefined) throw new Error("a merchant with no incidents demonstrates nothing");
  return first;
}

export function configFor(options: MerchantOptions): SimulatorConfig {
  return {
    seed: options.seed,
    startAt: options.bootAt,
    // Long enough that nobody watching reaches the end of it. The pacer decides what has actually
    // happened; this only bounds the generator.
    durationMs: 30 * 86_400_000,
    attemptsPerMinute: options.attemptsPerMinute,
    profiles: INDIA_PROFILES,
    degradations: degradationsFor(options),
    customerPool: 4000,
  };
}

/** One outcome in the shape `POST /outcomes` accepts. Structural, so a test can read it. */
export interface OutcomeRow {
  readonly id: string;
  readonly orderId: string;
  readonly customer: string;
  readonly amountPaise: number;
  readonly method: string;
  readonly issuer: string | null;
  readonly instrument: string | null;
  readonly status: "captured" | "failed";
  readonly at: number;
  readonly arm: "treated" | "control";
}

export function outcomeRow(attempt: Attempt, arm: "treated" | "control"): OutcomeRow {
  return {
    id: attempt.id,
    orderId: attempt.orderId,
    customer: attempt.customer,
    amountPaise: attempt.amount,
    method: attempt.slice.method,
    issuer: attempt.slice.issuer,
    instrument: attempt.slice.instrument,
    status: attempt.status === "failed" ? "failed" : "captured",
    at: attempt.at,
    arm,
  };
}

/**
 * A held-out share, decided by the customer rather than by the payment.
 *
 * Per-customer because a customer whose first attempt is steered and whose retry is not has been in
 * both arms and measures neither. Derived from the reference by FNV-1a so it is stable across
 * processes and restarts without anything having to store it.
 */
export function armFor(customer: string, holdOut: number): "treated" | "control" {
  let hash = 2_166_136_261;
  for (let i = 0; i < customer.length; i++) {
    hash ^= customer.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % 1000) / 1000 < holdOut ? "control" : "treated";
}

/** What one pass produced: what to report, and what to file. */
export interface Batch {
  readonly outcomes: readonly OutcomeRow[];
  readonly casualties: readonly Casualty[];
  /** A customer worth asking for a plan, or null when nothing failed this pass. */
  readonly askPlanFor: string | null;
  readonly simulatedTo: number;
}

/**
 * Paces the generated stream against a real clock.
 *
 * Holds exactly one attempt of lookahead, because the generator has to yield an attempt before we
 * can see whether its moment has arrived; discarding it to regenerate later would advance the RNG
 * and change the run. So it is kept and delivered on the pass its time falls in.
 */
export class Merchant {
  readonly #options: MerchantOptions;
  readonly #stream: Generator<LabelledAttempt>;
  readonly #holdOut: number;
  #peeked: LabelledAttempt | null = null;

  constructor(options: MerchantOptions, holdOut = 0.1) {
    this.#options = options;
    this.#stream = generateLabelled(configFor(options));
    this.#holdOut = holdOut;
  }

  /** Everything whose simulated moment has arrived by wall-clock `now`. */
  drain(now: number): Batch {
    const simulatedTo = this.#options.bootAt + (now - this.#options.bootAt) * this.#options.speed;
    const outcomes: OutcomeRow[] = [];
    const casualties: Casualty[] = [];
    let askPlanFor: string | null = null;

    for (;;) {
      const next = this.#peeked ?? this.#stream.next().value ?? null;
      this.#peeked = null;
      if (next === null) break;
      if (next.attempt.at > simulatedTo) {
        this.#peeked = next;
        break;
      }

      const arm = armFor(next.attempt.customer, this.#holdOut);
      outcomes.push(outcomeRow(next.attempt, arm));

      if (next.attempt.status === "failed") {
        // The attempt already carries a Razorpay source/step/reason triple drawn from the same
        // tables the benchmark uses, so the classification the worker will read is the one the
        // study measured rather than a plausible-looking detail invented here.
        const casualty = casualtyFrom(next.attempt, next.retry);
        if (casualty !== null) casualties.push(casualty);
        askPlanFor ??= next.attempt.customer;
      }
    }

    return { outcomes, casualties, askPlanFor, simulatedTo };
  }
}
