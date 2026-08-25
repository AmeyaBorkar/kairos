/**
 * The four experiments the scorecard runs, as data.
 *
 * The per-benchmark reports in `docs/results/` are deep dives: they sweep thresholds, worker counts,
 * elasticities and spontaneous windows, and they exist to answer *why* a design is the way it is.
 * This is a different job. The scorecard runs one configuration of each arm and asks a single
 * question — does this commit still meet what the project claims? — so it is deliberately narrower
 * and deliberately the same shape at both sizes.
 *
 * Two properties matter and both are structural rather than conventional:
 *
 * - **The seed is a parameter.** Everything reported runs at {@link PINNED_SEED}, so published
 *   numbers reproduce. The seed study varies it, which is the only way to find out how far these
 *   numbers move when nothing is wrong.
 * - **{@link describe} is the published record.** It is what the config hash is taken over and what
 *   is written into a public repository, so it carries the fields that define the experiment and
 *   none of the ones that would be a credential in a real deployment. Serialising the live config
 *   object would put the mandate signing secret in `docs/results/`.
 */

import { DEFAULT_DETECTOR_CONFIG, type EngineConfig, withThreshold } from "@kairos/detect";
import { mandateId, paise, slice } from "@kairos/domain";
import type { JsonValue } from "@kairos/proof";
import { DEFAULT_RECOVERY_CONFIG, worstActionCostPaise } from "@kairos/recover";
import { type Degradation, INDIA_PROFILES, type SimulatorConfig } from "@kairos/simulator";
import { sealMandate, type UnsignedMandate } from "@kairos/terminus";
import { DEFAULT_OPTIONS, type ExperimentOptions } from "./experiment.js";
import { DEFAULT_PREVENT_OPTIONS, type PreventOptions } from "./prevent.js";
import type { RecoveryRunConfig } from "./recover.js";
import { DEFAULT_SPEND_OPTIONS, type SpendOptions } from "./spend.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The one seed every published number is measured at. */
export const PINNED_SEED = 20_260_825;

/**
 * The bench mandate's signing secret.
 *
 * Real in the sense that the HMAC is really computed and really verified, and worthless in the
 * sense that it authorises a simulation. It is a constant here rather than an environment variable
 * because a benchmark that behaves differently depending on the machine's environment is not a
 * benchmark. It is excluded from {@link describe} regardless, because the habit of never
 * serialising a secret is worth more than the judgement call about this particular one.
 */
const SECRET = "bench-only-secret-that-is-long-enough-to-pass";

const START = 1_756_000_000_000;

/** The threshold Kairos ships at, and so the row the scorecard reads out of the detection sweep. */
export const OPERATING_THRESHOLD = 12;

export type ProfileName = "quick" | "full";

/**
 * Two rails break, at different altitudes and different durations.
 *
 * One is precisely detectable and heals quickly; the other runs long enough that `railPatience`
 * stops calling it transient. Between them they exercise both halves of the recovery schedule.
 */
const RECOVERY_DEGRADATIONS: readonly Degradation[] = [
  {
    slice: slice("netbanking", "hdfc"),
    onsetAt: START + 40 * MINUTE,
    rampMs: 60_000,
    peakFailureRate: 0.55,
    holdMs: 35 * MINUTE,
    recoveryMs: 5 * MINUTE,
  },
  {
    slice: slice("upi", "sbi"),
    onsetAt: START + 90 * MINUTE,
    rampMs: 4 * MINUTE,
    peakFailureRate: 0.42,
    holdMs: 60 * MINUTE,
    recoveryMs: 8 * MINUTE,
  },
];

export interface PreventScenario {
  readonly name: string;
  readonly description: string;
  readonly degradation: Degradation;
  /**
   * Whether the policy is expected to steer at all.
   *
   * The scenario that must *not* steer earns its place in the scorecard: a controller that pulls a
   * lever on every wobble is worse for a merchant than one that never pulls it, and nothing else
   * in the harness would notice it starting to.
   */
  readonly shouldSteer: boolean;
}

/**
 * The prevention scenarios, defined once.
 *
 * These were duplicated between the prevention report and this file for exactly as long as it took
 * the scorecard's first run to notice: transcribed onsets that were ten minutes later than the real
 * ones pushed the peak past the end of the quick window, and `detectionHeld` went false for a reason
 * that had nothing to do with the detector. Two harnesses measuring "the same" incident from two
 * copies of its definition is a bug waiting for someone to edit one of them.
 */
export const PREVENT_SCENARIOS: readonly PreventScenario[] = [
  {
    name: "netbanking-hdfc",
    description: "HDFC netbanking to 45% — precisely suppressible",
    shouldSteer: true,
    degradation: {
      slice: slice("netbanking", "hdfc"),
      onsetAt: START + 20 * MINUTE,
      rampMs: 30_000,
      peakFailureRate: 0.45,
      holdMs: 30 * MINUTE,
      recoveryMs: 3 * MINUTE,
    },
  },
  {
    name: "card-hdfc-visa",
    description: "HDFC Visa to 40% — precisely suppressible, on a rail already failing at 11%",
    shouldSteer: true,
    degradation: {
      slice: slice("card", "hdfc", "visa"),
      onsetAt: START + 20 * MINUTE,
      rampMs: 30_000,
      peakFailureRate: 0.4,
      holdMs: 30 * MINUTE,
      recoveryMs: 3 * MINUTE,
    },
  },
  {
    name: "upi-hdfc-severe",
    description: "HDFC UPI collapses to 55% — not addressable, only demotable",
    shouldSteer: true,
    degradation: {
      slice: slice("upi", "hdfc"),
      onsetAt: START + 20 * MINUTE,
      rampMs: 30_000,
      peakFailureRate: 0.55,
      holdMs: 30 * MINUTE,
      recoveryMs: 3 * MINUTE,
    },
  },
  {
    name: "upi-hdfc-moderate",
    description: "HDFC UPI to 14% — the case where steering should decline",
    shouldSteer: false,
    degradation: {
      slice: slice("upi", "hdfc"),
      onsetAt: START + 20 * MINUTE,
      rampMs: 60_000,
      peakFailureRate: 0.14,
      holdMs: 30 * MINUTE,
      recoveryMs: 3 * MINUTE,
    },
  },
  {
    name: "upi-wide",
    description: "UPI as a whole to 30% — a PSP-level event, demotable with no collateral",
    shouldSteer: true,
    degradation: {
      slice: slice("upi"),
      onsetAt: START + 20 * MINUTE,
      rampMs: 30_000,
      peakFailureRate: 0.3,
      holdMs: 30 * MINUTE,
      recoveryMs: 3 * MINUTE,
    },
  },
];

/**
 * The three the scorecard runs: one suppressible, one only demotable, one that must be left alone.
 *
 * The other two are variations on the first three and belong in the report, where a reader is
 * looking for the shape of the effect rather than a pass or a fail.
 */
const SCORECARD_SCENARIOS = ["netbanking-hdfc", "upi-hdfc-severe", "upi-hdfc-moderate"];

/**
 * A false alarm steers customers off a healthy rail, so the budget is deliberately tight.
 *
 * Shared with the detection report, and used as the gate's tolerance on the false-alarm rate: the
 * project has already declared what it will tolerate, and a second number invented for the gate
 * would just be a second opinion.
 */
export const FALSE_ALARM_BUDGET_PER_HOUR = 0.25;

function recoveryMandate(): UnsignedMandate {
  return {
    id: mandateId("mnd_scorecard_recovery"),
    merchantId: "bench",
    campaignId: "recovery",
    // Deliberately generous, so the comparison is between policies rather than between arms that
    // ran out of money at different moments. Bound-holding is what the spend arm measures.
    budgetPaise: paise(50_000_00),
    maxActionCostPaise: worstActionCostPaise(DEFAULT_RECOVERY_CONFIG),
    maxInFlight: 64,
    reservationTtlMs: 5 * MINUTE,
    contactCap: { limit: 3, windowMs: 7 * DAY },
    quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 },
    allowedActions: ["retry", "contact-sms", "contact-whatsapp", "contact-email"],
    validFrom: START - DAY,
    validUntil: START + 120 * DAY,
    killSwitch: false,
  };
}

export interface Profile {
  readonly name: ProfileName;
  readonly seed: number;
  readonly detect: ExperimentOptions;
  readonly spend: { readonly options: SpendOptions; readonly workerCounts: readonly number[] };
  readonly prevent: {
    readonly options: PreventOptions;
    readonly scenarios: readonly PreventScenario[];
  };
  readonly recover: RecoveryRunConfig;
  readonly detector: EngineConfig;
}

/**
 * Build a profile.
 *
 * `quick` is what the regression gate runs on every pull request, so its size is chosen by what
 * fits in a CI job rather than by what makes the prettiest number. `full` asks the same questions
 * of enough traffic to answer them well, and is what a reader should be shown.
 *
 * The seed shifts every arm together. Detection's `seedBase` offsets the whole sweep; the other
 * three take it directly, and the recovery world derives its own randomness from the simulator's.
 */
export function profile(name: ProfileName, seed: number = PINNED_SEED): Profile {
  const quick = name === "quick";

  const detector: EngineConfig = {
    ...withThreshold(DEFAULT_DETECTOR_CONFIG, OPERATING_THRESHOLD),
    rollup: true,
  };

  const simulator: SimulatorConfig = {
    seed,
    startAt: START,
    durationMs: quick ? 90 * MINUTE : 4 * HOUR,
    attemptsPerMinute: quick ? 120 : 300,
    profiles: INDIA_PROFILES,
    degradations: RECOVERY_DEGRADATIONS,
    customerPool: 12_000,
  };

  return {
    name,
    seed,
    detector,

    detect: {
      ...DEFAULT_OPTIONS,
      // The operating point must be in the sweep or there is nothing to read out of it.
      thresholds: quick ? [8, OPERATING_THRESHOLD, 17] : DEFAULT_OPTIONS.thresholds,
      seedsPerCell: quick ? 2 : DEFAULT_OPTIONS.seedsPerCell,
      warmupMs: quick ? 15 * MINUTE : DEFAULT_OPTIONS.warmupMs,
      observeMs: quick ? 25 * MINUTE : DEFAULT_OPTIONS.observeMs,
      seedBase: seed - PINNED_SEED,
    },

    spend: {
      options: {
        ...DEFAULT_SPEND_OPTIONS,
        seed,
        ...(quick ? { jobs: 1200, customers: 120 } : {}),
      },
      // One worker cannot race itself and sixty-four races constantly. The middle of the sweep is
      // interesting for the report and adds nothing to a pass/fail: the bound either holds at the
      // extremes or it does not hold.
      workerCounts: quick ? [1, 8, 64] : [1, 2, 8, 32, 64],
    },

    prevent: {
      options: {
        ...DEFAULT_PREVENT_OPTIONS,
        seed,
        ...(quick ? { observeMs: 20 * MINUTE, attemptsPerMinute: 300 } : {}),
      },
      scenarios: PREVENT_SCENARIOS.filter((s) => SCORECARD_SCENARIOS.includes(s.name)),
    },

    recover: {
      simulator,
      detector,
      mandate: sealMandate(recoveryMandate(), SECRET),
      secret: SECRET,
      tailMs: quick ? 10 * DAY : 40 * DAY,
      // No window sweep. It is a design question, answered once in the recovery report, not a
      // claim that needs re-checking on every commit.
    },
  };
}

/**
 * The publishable description of a profile, and the thing the config hash is taken over.
 *
 * Written by hand rather than derived from the objects, for two reasons that pull the same way. It
 * cannot accidentally acquire a secret when somebody adds a field to `Mandate`. And it fixes what
 * "the same experiment" means: a change to any value here invalidates the baseline and says so,
 * while a change to something absent — a label, a description, the order of a scenario list — does
 * not. Getting that boundary wrong in the generous direction makes the gate cry wolf; getting it
 * wrong in the strict direction lets a changed experiment reuse an old baseline, which is worse.
 */
export function describe(p: Profile): JsonValue {
  return {
    profile: p.name,
    seed: p.seed,
    detect: {
      thresholds: [...p.detect.thresholds],
      operatingThreshold: OPERATING_THRESHOLD,
      seedsPerCell: p.detect.seedsPerCell,
      seedBase: p.detect.seedBase,
      attemptsPerMinute: p.detect.attemptsPerMinute,
      warmupMs: p.detect.warmupMs,
      observeMs: p.detect.observeMs,
      scenarios: p.detect.scenarios.map((s) => s.name),
    },
    spend: {
      workerCounts: [...p.spend.workerCounts],
      budgetPaise: p.spend.options.budgetPaise,
      maxInFlight: p.spend.options.maxInFlight,
      contactCapLimit: p.spend.options.contactCapLimit,
      jobs: p.spend.options.jobs,
      customers: p.spend.options.customers,
      devanagariShare: p.spend.options.devanagariShare,
    },
    prevent: {
      attemptsPerMinute: p.prevent.options.attemptsPerMinute,
      warmupMs: p.prevent.options.warmupMs,
      observeMs: p.prevent.options.observeMs,
      tickMs: p.prevent.options.tickMs,
      customerPool: p.prevent.options.customerPool,
      choice: {
        switchElasticity: p.prevent.options.choice.switchElasticity,
        abandonmentOnSuppress: p.prevent.options.choice.abandonmentOnSuppress,
      },
      scenarios: p.prevent.scenarios.map((s) => ({
        name: s.name,
        shouldSteer: s.shouldSteer,
        peakFailureRate: s.degradation.peakFailureRate,
        holdMs: s.degradation.holdMs,
        rampMs: s.degradation.rampMs,
      })),
    },
    recover: {
      durationMs: p.recover.simulator.durationMs,
      attemptsPerMinute: p.recover.simulator.attemptsPerMinute,
      customerPool: p.recover.simulator.customerPool ?? null,
      tailMs: p.recover.tailMs ?? null,
      degradations: p.recover.simulator.degradations.map((d) => ({
        slice: `${d.slice.method}/${d.slice.issuer ?? "*"}`,
        peakFailureRate: d.peakFailureRate,
        holdMs: d.holdMs,
      })),
      mandate: {
        budgetPaise: p.recover.mandate.budgetPaise,
        maxActionCostPaise: p.recover.mandate.maxActionCostPaise,
        maxInFlight: p.recover.mandate.maxInFlight,
        contactCapLimit: p.recover.mandate.contactCap.limit,
      },
      // The pricing that decides every gate in the recovery arm. Named here because a change to it
      // changes what the arm is optimising, which no metric could tell you on its own.
      economics: {
        marginRate: DEFAULT_RECOVERY_CONFIG.margin,
        optOutCostPaise: DEFAULT_RECOVERY_CONFIG.optOutCostPaise,
        controlFraction: DEFAULT_RECOVERY_CONFIG.controlFraction,
        explorationRate: DEFAULT_RECOVERY_CONFIG.explorationRate,
      },
    },
    detector: {
      threshold: OPERATING_THRESHOLD,
      rollup: p.detector.rollup === true,
    },
  };
}
