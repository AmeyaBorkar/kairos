import { DEFAULT_DETECTOR_CONFIG, DetectionEngine, incidentFrom } from "@kairos/detect";
import {
  attemptId,
  type CustomerRef,
  customerRef,
  type IncidentId,
  mandateId,
  orderId,
  type PaymentMethod,
  paise,
  type Slice,
  sliceCovers,
  sliceKey,
} from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import {
  DEFAULT_STEERING_CONFIG,
  isHeldOut,
  RailWindow,
  type SteeringConfig,
  SteeringController,
} from "@kairos/policy";
import {
  type ChoiceModel,
  chooseUnderPlan,
  type Degradation,
  failureRateAt,
  INDIA_PROFILES,
  Rng,
  type SimulatorConfig,
  type SliceProfile,
} from "@kairos/simulator";
import { ManualClock, sealMandate, Terminus } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";

const MINUTE = 60_000;
const DAY = 86_400_000;
const SECRET = "bench-secret";
const START = 1_756_000_000_000;

const DEFAULT_SEQUENCE: readonly PaymentMethod[] = [
  "upi",
  "card",
  "netbanking",
  "wallet",
  "paylater",
  "emi",
];

export interface PreventOptions {
  readonly seed: number;
  readonly attemptsPerMinute: number;
  /** Quiet lead-in, so baselines and the rail window are established before anything degrades. */
  readonly warmupMs: number;
  readonly observeMs: number;
  /** How often the controller re-decides. Bounds how quickly a steer can start or stop. */
  readonly tickMs: number;
  readonly customerPool: number;
  /** What the policy believes about customers. */
  readonly steering: SteeringConfig;
  /** What customers actually do. Deliberately separable from what the policy believes. */
  readonly choice: ChoiceModel;
}

export const DEFAULT_PREVENT_OPTIONS: PreventOptions = {
  seed: 20_260_825,
  attemptsPerMinute: 400,
  warmupMs: 20 * MINUTE,
  observeMs: 45 * MINUTE,
  tickMs: 15_000,
  customerPool: 20_000,
  steering: DEFAULT_STEERING_CONFIG,
  choice: { switchElasticity: 0.35, abandonmentOnSuppress: 0.08 },
};

/** One arm's tally, within one incident's steering window. */
interface ArmTally {
  attempts: number;
  lost: number;
  lostPaise: number;
  volumePaise: number;
  abandoned: number;
}

const emptyTally = (): ArmTally => ({
  attempts: 0,
  lost: 0,
  lostPaise: 0,
  volumePaise: 0,
  abandoned: 0,
});

export interface ArmResult {
  readonly attempts: number;
  readonly lost: number;
  readonly lossRate: number;
  readonly abandoned: number;
  readonly lostPaise: number;
  readonly volumePaise: number;
}

/** One arm-versus-arm comparison, over some population of attempts. */
export interface Comparison {
  readonly treated: ArmResult;
  readonly control: ArmResult;
  /** Control loss rate minus treated loss rate. Positive means steering helped. */
  readonly lossRateDelta: number;
  /** Half-width of a 95% interval on that difference. */
  readonly confidenceHalfWidth: number;
  readonly significant: boolean;
  /** Loss the treated arm avoided relative to the control arm, in paise. */
  readonly savedPaise: number;
}

export interface IncidentResult {
  readonly incident: IncidentId;
  readonly slice: string;
  readonly lever: string;
  readonly steeredMs: number;
  /**
   * How many times the chosen lever or target changed while the steer was in force.
   *
   * Flapping is the failure mode of a control loop that cannot see past its own intervention, and
   * a checkout that rearranges itself every few seconds is worse for a merchant than one that never
   * steered at all. Reported so it cannot happen quietly.
   */
  readonly leverChanges: number;
  /**
   * Customers whose preferred rail was the one degrading — the people the outage was going to hurt.
   *
   * This is the headline comparison, and it is a legitimate subgroup rather than a flattering one:
   * a customer's preference is drawn before any treatment and is independent of which arm they land
   * in, so both arms are filtered identically. Comparing arms across *all* traffic instead divides
   * the effect by the failing rail's share of volume, which on a 5%-of-volume slice buries a real
   * effect under the noise of the other 95%.
   */
  readonly affected: Comparison;
  /**
   * Customers on the same method whose own rail was fine, and who were moved anyway.
   *
   * The cost side of demotion, and the number that decides whether the lever should have been
   * pulled at all. A positive `savedPaise` here would mean the collateral traffic also benefited,
   * which happens only when the destination is genuinely healthier than where they started.
   */
  readonly collateral: Comparison;
  /** Everything, which is what a merchant's own dashboard would show. */
  readonly overall: Comparison;
}

export interface PreventResult {
  readonly scenario: string;
  readonly options: PreventOptions;
  readonly incidents: readonly IncidentResult[];
  /** Steers the policy considered and refused, by reason. */
  readonly declines: Readonly<Record<string, number>>;
  readonly steersIssued: number;
  readonly steersRefused: number;
  /** Whether the detector kept the incident open for the whole degradation. */
  readonly detectionHeld: boolean;
  readonly ledgerVerified: boolean;
  readonly totalAttempts: number;
}

function compare(treated: ArmTally, control: ArmTally): Comparison {
  const t = tallyToResult(treated);
  const c = tallyToResult(control);
  const delta = c.lossRate - t.lossRate;
  const half = halfWidth(t, c);
  const averagePaise = t.attempts === 0 ? 0 : t.volumePaise / t.attempts;

  return {
    treated: t,
    control: c,
    lossRateDelta: delta,
    confidenceHalfWidth: half,
    significant: Number.isFinite(half) && Math.abs(delta) > half,
    savedPaise: Math.round(delta * t.attempts * averagePaise),
  };
}

function tallyToResult(tally: ArmTally): ArmResult {
  return {
    attempts: tally.attempts,
    lost: tally.lost,
    lossRate: tally.attempts === 0 ? 0 : tally.lost / tally.attempts,
    abandoned: tally.abandoned,
    lostPaise: tally.lostPaise,
    volumePaise: tally.volumePaise,
  };
}

/**
 * A 95% interval on the difference of two proportions, by normal approximation.
 *
 * Reported rather than a bare point estimate because §18 flagged the risk directly: a short
 * incident may not accumulate enough control-arm volume for the difference to mean anything, and a
 * lift number with no interval around it cannot be distinguished from noise. Where the interval
 * spans zero the honest answer is that this incident did not measure anything, and the harness says
 * so rather than quoting the midpoint.
 */
function halfWidth(a: ArmResult, b: ArmResult): number {
  if (a.attempts === 0 || b.attempts === 0) return Number.POSITIVE_INFINITY;
  const va = (a.lossRate * (1 - a.lossRate)) / a.attempts;
  const vb = (b.lossRate * (1 - b.lossRate)) / b.attempts;
  return 1.96 * Math.sqrt(va + vb);
}

function steerMandate(config: SteeringConfig) {
  return sealMandate(
    {
      id: mandateId("mnd_steer"),
      merchantId: "bench",
      campaignId: "steering",
      budgetPaise: paise(100_000),
      maxActionCostPaise: paise(1),
      maxInFlight: config.maxConcurrentSteers,
      reservationTtlMs: config.maxIncidentDurationMs,
      contactCap: { limit: 999, windowMs: DAY },
      quietHours: null,
      allowedActions: ["steer"],
      validFrom: START - DAY,
      validUntil: START + 30 * DAY,
      killSwitch: false,
    },
    SECRET,
  );
}

function profileFor(profiles: readonly SliceProfile[], slice: Slice): SliceProfile {
  const key = sliceKey(slice);
  const found = profiles.find((p) => sliceKey(p.slice) === key);
  if (found === undefined) throw new Error(`no profile for ${key}`);
  return found;
}

function customerAt(index: number): CustomerRef {
  return customerRef(`c${index.toString(16).padStart(23, "0")}`);
}

/**
 * Run one degradation end to end, with steering live and a holdout in force.
 *
 * The detector observes the *actual* attempts, not the counterfactual ones, which matters more than
 * it sounds: steering moves traffic off the failing rail, so the evidence that justified the steer
 * starts to disappear the moment it takes effect. What keeps the signal alive is the holdout — the
 * control arm goes on using the failing rail, so the detector keeps seeing it fail. That is a
 * second, independent reason to run a control group, beyond being able to measure anything.
 */
export async function runPrevention(
  scenario: string,
  degradation: Degradation,
  options: PreventOptions = DEFAULT_PREVENT_OPTIONS,
): Promise<PreventResult> {
  const rng = new Rng(options.seed);
  const clock = new ManualClock(START);
  const ledger = new MemoryLedger();

  const simulation: SimulatorConfig = {
    seed: options.seed,
    startAt: START,
    durationMs: options.warmupMs + options.observeMs,
    attemptsPerMinute: options.attemptsPerMinute,
    profiles: INDIA_PROFILES,
    degradations: [degradation],
  };

  const engine = new DetectionEngine({ ...DEFAULT_DETECTOR_CONFIG, rollup: true });
  const window = new RailWindow();
  const terminus = new Terminus({
    mandate: steerMandate(options.steering),
    secret: SECRET,
    store: new MemoryStore({ sweepIntervalMs: 0 }),
    audit: ledger,
    actor: "bench-sentry",
    clock,
  });
  const controller = new SteeringController({
    terminus,
    config: options.steering,
    clock,
    defaultSequence: DEFAULT_SEQUENCE,
  });

  type Arms = { treated: ArmTally; control: ArmTally };
  type Populations = { affected: Arms; collateral: Arms; overall: Arms };
  const emptyArms = (): Arms => ({ treated: emptyTally(), control: emptyTally() });
  const emptyPopulations = (): Populations => ({
    affected: emptyArms(),
    collateral: emptyArms(),
    overall: emptyArms(),
  });
  const tallies = new Map<IncidentId, Populations>();
  const steerWindows = new Map<
    IncidentId,
    { slice: string; lever: string; ms: number; changes: number }
  >();
  const declines: Record<string, number> = {};
  let steersIssued = 0;
  let steersRefused = 0;
  let totalAttempts = 0;
  let openDuringPeak = false;

  const meanGapMs = 60_000 / options.attemptsPerMinute;
  const endAt = START + simulation.durationMs;
  const peakAt = degradation.onsetAt + degradation.rampMs + degradation.holdMs / 2;

  let at = START;
  let nextTick = START;
  let sequence = 0;
  let health = window.snapshot(at);

  while (at < endAt) {
    at += rng.exponential(meanGapMs);
    if (at >= endAt) break;
    clock.set(Math.round(at));

    if (at >= nextTick) {
      nextTick = at + options.tickMs;
      health = window.snapshot(at);
      const open = engine.openIncidents().map(incidentFrom);
      const outcomes = await controller.affirm(open, health);

      for (const outcome of outcomes) {
        if (outcome.status === "steering" && !steerWindows.has(outcome.incident)) steersIssued++;
        if (outcome.status === "refused") steersRefused++;
        if (outcome.status === "declined") {
          declines[outcome.detail] = (declines[outcome.detail] ?? 0) + 1;
        }
      }

      for (const directive of controller.directives()) {
        const existing = steerWindows.get(directive.incident);
        const slice = sliceKey(directive.slice);
        const changed =
          existing !== undefined &&
          (existing.slice !== slice || existing.lever !== directive.lever);
        steerWindows.set(directive.incident, {
          slice,
          lever: directive.lever,
          ms: (existing?.ms ?? 0) + options.tickMs,
          changes: (existing?.changes ?? 0) + (changed ? 1 : 0),
        });
      }
    }

    if (Math.abs(at - peakAt) < meanGapMs * 5 && engine.openIncidents().length > 0) {
      openDuringPeak = true;
    }

    const customer = customerAt(rng.int(options.customerPool));
    const preferred = rng.pick(INDIA_PROFILES, (p) => p.share);
    const plan = controller.planFor(customer, health);
    const choice = chooseUnderPlan(rng, preferred, INDIA_PROFILES, plan, options.choice);

    const amount = paise(
      Math.round(Math.min(200_000, Math.max(50, rng.logNormal(6.4, 0.85)))) * 100,
    );

    let failed: boolean;
    if (choice.slice === null) {
      // Abandonment is a total loss, and a worse one than a failed payment: there is no casualty to
      // recover, no error code to classify, and nothing to retry.
      failed = true;
    } else {
      const profile = profileFor(INDIA_PROFILES, choice.slice);
      const rate = failureRateAt(simulation, profile, at);
      failed = rng.next() < rate;

      // Only real attempts reach the detector. An abandoned checkout produces no payment, which is
      // exactly why an outage that drives people away is harder to see than one that fails loudly.
      sequence++;
      engine.observe({
        id: attemptId(`pay_${sequence.toString(36).padStart(9, "0")}`),
        orderId: orderId(`order_${sequence.toString(36).padStart(9, "0")}`),
        customer,
        amount,
        slice: choice.slice,
        status: failed ? "failed" : "captured",
        failure: null,
        at: Math.round(at),
      });
      // A customer whose checkout was left entirely alone is a control observation: their outcome
      // measures the world in which nothing was done, which is the quantity the next steering
      // decision needs and the one a blended estimate cannot see once a steer is in force.
      const untouched = plan.applied.length === 0 && plan.heldOutOf.length > 0;
      window.observe(choice.slice, failed, at, untouched ? "control" : "treated");
    }

    totalAttempts++;

    // Attribute this attempt to every incident being steered on right now. A customer sees one
    // checkout, so the same attempt is evidence for each steer in force — partitioned by the arm
    // that customer was assigned to for that particular incident.
    // Which population this customer belongs to is decided by what they *wanted* to pay with,
    // which is fixed before any steering happens and is independent of their arm.
    const wasExposed = sliceCovers(degradation.slice, choice.preferred);
    const wasCollateral = !wasExposed && choice.preferred.method === degradation.slice.method;

    for (const directive of controller.directives()) {
      const populations = tallies.get(directive.incident) ?? emptyPopulations();
      const held = isHeldOut(customer, directive.incident, options.steering.holdoutFraction);

      const record = (arms: Arms): void => {
        const arm = held ? arms.control : arms.treated;
        arm.attempts++;
        arm.volumePaise += amount;
        if (failed) {
          arm.lost++;
          arm.lostPaise += amount;
          if (choice.slice === null) arm.abandoned++;
        }
      };

      record(populations.overall);
      if (wasExposed) record(populations.affected);
      else if (wasCollateral) record(populations.collateral);

      tallies.set(directive.incident, populations);
    }
  }

  await controller.revokeAll("run complete");

  const incidents: IncidentResult[] = [];
  for (const [id, populations] of tallies) {
    const window_ = steerWindows.get(id);
    incidents.push({
      incident: id,
      slice: window_?.slice ?? "unknown",
      lever: window_?.lever ?? "unknown",
      steeredMs: window_?.ms ?? 0,
      leverChanges: window_?.changes ?? 0,
      affected: compare(populations.affected.treated, populations.affected.control),
      collateral: compare(populations.collateral.treated, populations.collateral.control),
      overall: compare(populations.overall.treated, populations.overall.control),
    });
  }

  return {
    scenario,
    options,
    incidents,
    declines,
    steersIssued,
    steersRefused,
    detectionHeld: openDuringPeak,
    ledgerVerified: ledger.verify().valid,
    totalAttempts,
  };
}
