/**
 * The situations worth watching a payments system get into.
 *
 * Named, seeded and reproducible, because a demo that improvises is a demo that shows something
 * different every time it is run and cannot be argued with afterwards. Each of these is a
 * `SimulatorConfig` plus the bounds the run operates under, and each exists to make one specific
 * claim visible rather than to look dramatic.
 *
 * ## Why the boring ones are here
 *
 * `calm` produces no incidents at all. It is the most important scenario in the file and the least
 * interesting to watch, because a detector is judged by what it does on a quiet afternoon: anything
 * will find a rail failing half its traffic, and the number that decides whether a merchant can
 * leave this switched on is how often it cries wolf when nothing is wrong. A console demo that only
 * ever shows the exciting cases is an advertisement.
 *
 * `budget-exhaustion` and `kill-switch` end with Kairos refusing to act. They are here for the same
 * reason: the claim this project makes is about what the system cannot do, and a bound nobody has
 * watched bind is a bound nobody has reason to believe in.
 */

import { slice } from "@kairos/domain";
import { type Degradation, INDIA_PROFILES, type SimulatorConfig } from "@kairos/simulator";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Pinned, so two people watching the same scenario are watching the same run. */
export const CONSOLE_SEED = 20260826;

export interface Scenario {
  readonly name: string;
  /** One line, shown in the UI. What this scenario is for, not what happens in it. */
  readonly premise: string;
  /** What a viewer should be looking at while it runs. */
  readonly watchFor: string;
  readonly simulator: SimulatorConfig;
  /** Campaign budget in paise. Small values make the budget bound visible. */
  readonly budgetPaise: number;
  /** Whether the mandate starts with its kill switch thrown. */
  readonly killSwitch: boolean;
}

function base(
  startAt: number,
  durationMs: number,
  degradations: readonly Degradation[],
): SimulatorConfig {
  return {
    seed: CONSOLE_SEED,
    startAt,
    durationMs,
    attemptsPerMinute: 90,
    profiles: INDIA_PROFILES,
    degradations,
    customerPool: 4_000,
  };
}

/**
 * Every scenario, built against a start time the caller supplies.
 *
 * A function rather than a constant because the start time is the one thing that should follow the
 * clock — a console showing yesterday's timestamps looks broken in a way that distracts from
 * everything else on the page.
 */
export function scenarios(startAt: number): readonly Scenario[] {
  return [
    {
      name: "calm",
      premise: "Nothing is wrong. Four hours of ordinary traffic on healthy rails.",
      watchFor:
        "That no incident opens. At h=12 this detector raises about one false alarm every five " +
        "hours, and a quiet afternoon is the measurement that decides whether it can be left on.",
      simulator: base(startAt, 4 * HOUR, []),
      budgetPaise: 500_00,
      killSwitch: false,
    },
    {
      name: "issuer-outage",
      premise:
        "HDFC netbanking starts failing about half its attempts at 00:40, and recovers 35 minutes later.",
      watchFor:
        "The gap between onset and the incident opening — roughly three minutes — and what steering " +
        "does to the rail's share while the holdout keeps collecting evidence.",
      simulator: base(startAt, 4 * HOUR, [
        {
          slice: slice("netbanking", "hdfc"),
          onsetAt: startAt + 40 * MINUTE,
          rampMs: 60_000,
          peakFailureRate: 0.55,
          holdMs: 35 * MINUTE,
          recoveryMs: 5 * MINUTE,
        },
      ]),
      budgetPaise: 500_00,
      killSwitch: false,
    },
    {
      name: "invisible-issuer",
      premise:
        "SBI's UPI handle degrades. Checkout cannot see which bank is behind a UPI payment, so the " +
        "rail cannot be suppressed — only demoted.",
      watchFor:
        "That the lever is `demoted`, not `suppressed`, and that collateral damage appears in the " +
        "steer's own price. This is the case ADR 0002 exists for and it covers most of UPI volume.",
      simulator: base(startAt, 4 * HOUR, [
        {
          slice: slice("upi", "sbi"),
          onsetAt: startAt + 30 * MINUTE,
          rampMs: 4 * MINUTE,
          peakFailureRate: 0.42,
          holdMs: 60 * MINUTE,
          recoveryMs: 8 * MINUTE,
        },
      ]),
      budgetPaise: 500_00,
      killSwitch: false,
    },
    {
      name: "two-at-once",
      premise: "Two rails break at different altitudes, overlapping in time.",
      watchFor:
        "Which bound binds first. With two incidents open the in-flight cap is three, and the " +
        "recovery queue fills faster than the contact cap will let it drain.",
      simulator: base(startAt, 4 * HOUR, [
        {
          slice: slice("netbanking", "hdfc"),
          onsetAt: startAt + 25 * MINUTE,
          rampMs: 60_000,
          peakFailureRate: 0.55,
          holdMs: 40 * MINUTE,
          recoveryMs: 5 * MINUTE,
        },
        {
          slice: slice("upi", "sbi"),
          onsetAt: startAt + 45 * MINUTE,
          rampMs: 4 * MINUTE,
          peakFailureRate: 0.48,
          holdMs: 50 * MINUTE,
          recoveryMs: 8 * MINUTE,
        },
      ]),
      budgetPaise: 500_00,
      killSwitch: false,
    },
    {
      name: "budget-exhaustion",
      premise:
        "The same outage as `issuer-outage`, against a campaign budget of ₹20 rather than ₹500.",
      watchFor:
        "The recovery arm stopping. Not slowing, not degrading — refusing, with `campaign-budget` " +
        "named as the binding axis on every subsequent record. The overspend is zero, not small.",
      simulator: base(startAt, 4 * HOUR, [
        {
          slice: slice("netbanking", "hdfc"),
          onsetAt: startAt + 20 * MINUTE,
          rampMs: 60_000,
          peakFailureRate: 0.6,
          holdMs: 45 * MINUTE,
          recoveryMs: 5 * MINUTE,
        },
      ]),
      budgetPaise: 20_00,
      killSwitch: false,
    },
    {
      name: "kill-switch",
      premise: "A live outage, with the mandate's kill switch thrown before anything starts.",
      watchFor:
        "Detection still running and every action refused. The kill switch is checked inside " +
        "admission rather than by the callers, so nothing has to remember to ask.",
      simulator: base(startAt, 2 * HOUR, [
        {
          slice: slice("netbanking", "hdfc"),
          onsetAt: startAt + 15 * MINUTE,
          rampMs: 60_000,
          peakFailureRate: 0.55,
          holdMs: 40 * MINUTE,
          recoveryMs: 5 * MINUTE,
        },
      ]),
      budgetPaise: 500_00,
      killSwitch: true,
    },
  ];
}

export function scenarioNamed(name: string, startAt: number): Scenario | null {
  return scenarios(startAt).find((scenario) => scenario.name === name) ?? null;
}
