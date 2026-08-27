/**
 * Every claim the project makes, measured in one pass.
 *
 * The four benchmarks answer four separate questions and have always reported them four separate
 * ways. That is right for a deep dive and wrong for a gate, because a gate needs one artifact with
 * one verdict and a provenance row that says exactly which experiment produced it.
 *
 * What goes in is chosen by a rule rather than by taste. **A number is an invariant when it has no
 * sampling distribution** — spend either exceeded the budget or it did not, the chain either hashes
 * or it does not — and a metric when it does. Getting that wrong in either direction costs
 * something real: a tolerance on overspend says the kernel may overspend a little, and a hard
 * equality on a recovery total fires on every refactor until nobody reads it.
 */

import {
  type InvariantObservation,
  invariant,
  type JsonValue,
  type Observation,
  parseScorecard,
  provenance,
  type Scorecard,
} from "@kairos/proof";
import { DEFAULT_RECOVERY_CONFIG } from "@kairos/recover";
import {
  type ResolutionThresholdResult,
  runCurve,
  runResolutionStudy,
  type ThresholdResult,
} from "./experiment.js";
import { type Comparison, type PreventResult, runPrevention } from "./prevent.js";
import { describe, OPERATING_THRESHOLD, type Profile } from "./profiles.js";
import { type ArmResult as RecoveryArm, runRecovery } from "./recover.js";
import { runSpendSweep } from "./spend.js";

/** Every arm's full result, kept beside the scorecard so a failure can be read into. */
export interface ScorecardDetail {
  readonly detect: ThresholdResult;
  readonly spend: Awaited<ReturnType<typeof runSpendSweep>>;
  readonly prevent: readonly PreventResult[];
  readonly recover: Awaited<ReturnType<typeof runRecovery>>;
}

export interface ScorecardRun {
  readonly scorecard: Scorecard;
  readonly detail: ScorecardDetail;
}

function metric(
  id: string,
  label: string,
  value: number,
  direction: Observation["direction"],
  unit: Observation["unit"],
): Observation {
  return { id, label, value, direction, unit };
}

export type Progress = (arm: string) => void;

/**
 * Run all four arms and reduce them to claims.
 *
 * Sequential rather than concurrent. Three of these are CPU-bound simulations and the fourth
 * measures a race between workers, so running them together would make the spend arm's interleaving
 * depend on how busy the machine was — which is the one thing its determinism argument rests on.
 */
export async function runScorecard(p: Profile, onProgress?: Progress): Promise<ScorecardRun> {
  const started = process.hrtime.bigint();
  const metrics: Observation[] = [];
  const invariants: InvariantObservation[] = [];

  onProgress?.("detect");
  const detect = collectDetect(p, metrics, invariants);

  onProgress?.("spend");
  const spend = await collectSpend(p, metrics, invariants);

  onProgress?.("prevent");
  const prevent = await collectPrevent(p, metrics, invariants);

  onProgress?.("recover");
  const recover = await collectRecover(p, metrics, invariants);

  const config: JsonValue = describe(p);

  // Validated on the way out rather than only on the way in. Four collectors build ids from
  // template strings — one per scenario, one per arm — and a collision would not throw, it would
  // quietly shadow: the comparison indexes by id, so the second entry replaces the first and the
  // claim it carried stops being checked while still appearing to be present. Costs nothing, and a
  // malformed scorecard should never reach a file.
  const scorecard = parseScorecard({
    provenance: provenance(p.name, config),
    metrics,
    invariants,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  });

  return { scorecard, detail: { detect, spend, prevent, recover } };
}

// ── Detection ─────────────────────────────────────────────────────────────────────────────────

function collectDetect(
  p: Profile,
  metrics: Observation[],
  invariants: InvariantObservation[],
): ThresholdResult {
  const curve = runCurve(p.detect);
  const row = curve.thresholds.find((t) => t.threshold === OPERATING_THRESHOLD);
  if (row === undefined) {
    throw new Error(
      `the detection sweep does not include the operating threshold h=${OPERATING_THRESHOLD}; ` +
        "the scorecard has nothing to read out of it",
    );
  }

  // Config arithmetic, not an outcome: one healthy trial and one trial per scenario, per seed, per
  // threshold. If this stops matching, the sweep silently shrank and every rate below is measured
  // over a population nobody chose.
  const expectedTrials =
    p.detect.thresholds.length *
    (p.detect.healthySeeds + p.detect.seedsPerCell * p.detect.scenarios.length);
  const actualTrials = curve.thresholds.reduce(
    (sum, t) => sum + t.scenarios.reduce((n, s) => n + s.trials, 0) + p.detect.healthySeeds,
    0,
  );
  invariants.push(
    invariant.exact(
      "detect.trials",
      "the sweep ran the number of trials its configuration describes",
      actualTrials,
      expectedTrials,
    ),
    invariant.positive(
      "detect.healthyHours",
      "healthy traffic was observed, so the false-alarm rate has a denominator",
      row.healthyHours,
    ),
  );

  const trials = row.scenarios.reduce((sum, s) => sum + s.trials, 0);
  const rightAltitude =
    trials === 0
      ? 0
      : row.scenarios.reduce((sum, s) => sum + s.rightAltitudeRate * s.trials, 0) / trials;

  collectResolve(p, metrics, invariants);

  metrics.push(
    metric(
      "detect.falseAlarmsPerHour",
      `alarms raised per hour of healthy traffic at h=${OPERATING_THRESHOLD}`,
      row.falseAlarmsPerHour,
      "lower-is-better",
      "rate",
    ),
    metric(
      "detect.detectionRate",
      "share of injected degradations the detector opened an incident for",
      row.overallDetectionRate,
      "higher-is-better",
      "ratio",
    ),
    metric(
      "detect.medianLatencyMs",
      "median time from a rail actually breaking to an incident opening",
      row.overallMedianLatencyMs ?? Number.MAX_SAFE_INTEGER,
      "lower-is-better",
      "ms",
    ),
    metric(
      "detect.rightAltitudeRate",
      "share of incidents reported at the degraded slice rather than above or below it",
      rightAltitude,
      "higher-is-better",
      "ratio",
    ),
  );

  return row;
}

/**
 * The way back — how long an incident outlives the outage that opened it.
 *
 * Gated rather than merely reported, because this is the measurement whose absence let a six-hour
 * resolution latency sit in the repository for five phases behind a 93-second detection latency.
 * A number nothing checks is a number that drifts, and this one drifted all the way to open
 * question 19 before a console made it visible.
 */
function collectResolve(
  p: Profile,
  metrics: Observation[],
  invariants: InvariantObservation[],
): ResolutionThresholdResult {
  const study = runResolutionStudy(p.resolve);
  const row = study.thresholds.find((t) => t.threshold === OPERATING_THRESHOLD);
  if (row === undefined) {
    throw new Error(
      `the resolution study does not include the operating threshold h=${OPERATING_THRESHOLD}; ` +
        "the scorecard has nothing to read out of it",
    );
  }

  /* Only the first of these is an invariant, and the distinction is the whole point of having two
     kinds of check. That every incident closes is structural: on a healed rail the recovery
     statistic's drift is `+KL(p0 || p1) > 0`, so it reaches its threshold given traffic, and there
     is no sequence of observations where it does not.

     That cover never lapses mid-outage is *not* structural, and asserting it would be asserting
     something measured to be false. It fails where an alarm fires on a burst and freezes a claim
     the sustained traffic never supported — the incident is then correctly demolished, and cover
     lapses for one detection latency until a second incident opens with the right claim. Two trials
     in twenty, on the full profile. It belongs in a banded metric with the rest of the stochastic
     quantities, not in a list of things that cannot happen. */
  invariants.push(
    invariant.holds(
      "detect.everyIncidentCloses",
      "every incident opened against a degradation was closed once the rail recovered",
      row.opened > 0 && row.resolved === row.opened,
    ),
  );

  metrics.push(
    metric(
      "detect.medianResolutionMs",
      "median time from a rail recovering to its incident closing",
      row.medianResolutionMs ?? Number.MAX_SAFE_INTEGER,
      "lower-is-better",
      "ms",
    ),
    metric(
      "detect.p90ResolutionMs",
      "ninetieth-percentile time from a rail recovering to its incident closing",
      row.p90ResolutionMs ?? Number.MAX_SAFE_INTEGER,
      "lower-is-better",
      "ms",
    ),
    metric(
      "detect.lostCoverTrials",
      "trials where cover lapsed while the rail was still at its peak failure rate",
      row.clearedEarly,
      "lower-is-better",
      "count",
    ),
    metric(
      "detect.heldThroughPeakRate",
      "share of incidents that were open at the worst moment of the outage they describe",
      row.opened === 0 ? 0 : row.heldThroughPeak / row.opened,
      "higher-is-better",
      "ratio",
    ),
  );

  return row;
}

// ── Spend ─────────────────────────────────────────────────────────────────────────────────────

async function collectSpend(
  p: Profile,
  metrics: Observation[],
  invariants: InvariantObservation[],
): Promise<ScorecardDetail["spend"]> {
  const sweep = await runSpendSweep(p.spend.options, p.spend.workerCounts);

  // The four sizers make two different promises, and collapsing them into one number was wrong.
  //
  // `worst-case` reserves the full `maxActionCost` before every action, so its spend cannot pass
  // the budget at all: for it, zero is the claim. The adaptive sizers deliberately reserve less
  // than the worst case in order to fit more actions into the same budget, and what they buy with
  // that is a *bounded* residual — `maxInFlight x (maxActionCost - reservation)` — not the absence
  // of one. Gating them at zero would either be a lie or would forbid the feature.
  const conservative = sweep.terminus.filter((a) => a.sizer === "worst-case");
  const adaptive = sweep.terminus.filter((a) => a.sizer !== "worst-case");
  if (conservative.length === 0 || adaptive.length === 0) {
    throw new Error("the spend sweep no longer runs both a worst-case and an adaptive sizer");
  }

  const orphans = sweep.terminus.reduce((sum, a) => sum + a.orphans, 0);

  // The bound is evaluated at the smallest reservation the run actually took. A run where it is
  // unknown proved nothing, so a null bound fails here rather than being quietly skipped.
  const boundHeld = sweep.terminus.every(
    (a) => a.boundPaise !== null && a.overspendPaise <= a.boundPaise,
  );

  invariants.push(
    invariant.zero(
      "spend.worstCaseOverspendPaise",
      "reserving the worst case never authorised a rupee past the budget, at any worker count",
      Math.max(...conservative.map((a) => a.overspendPaise)),
    ),
    invariant.holds(
      "spend.boundHeld",
      "every sizer, including the ones that under-reserve on purpose, stayed inside the residual " +
        "its own reservations permit",
      boundHeld,
    ),
    invariant.zero(
      "spend.orphans",
      "no reservation was held for an action that never reported its cost",
      orphans,
    ),
    invariant.holds(
      "spend.ledgerVerified",
      "the audit chain hashes end to end for every arm",
      sweep.terminus.every((a) => a.ledgerVerified),
    ),
    // Without this the whole comparison is vacuous: a naive arm that stopped racing would let every
    // claim about the kernel pass while demonstrating nothing.
    invariant.positive(
      "spend.naiveOverspendPaise",
      "the unguarded arm really does overspend, so the kernel has something to prevent",
      Math.max(...sweep.naive.map((a) => a.overspendPaise)),
    ),
  );

  metrics.push(
    metric(
      "spend.adaptiveOverspendPaise",
      "worst residual an under-reserving sizer ran up — bounded by construction, and worth " +
        "watching because the bound is what it is allowed rather than what it should cost",
      Math.max(...adaptive.map((a) => a.overspendPaise)),
      "lower-is-better",
      "paise",
    ),
  );

  // A kernel that refuses everything holds every bound and is worthless. This is what notices.
  const contended = sweep.terminus.filter((a) => a.workers === Math.max(...p.spend.workerCounts));
  metrics.push(
    metric(
      "spend.actionsUnderContention",
      "actions the kernel admitted at the highest worker count — safety bought by refusing " +
        "everything is not safety",
      Math.max(...contended.map((a) => a.actionsTaken)),
      "higher-is-better",
      "count",
    ),
  );

  return sweep;
}

// ── Prevention ────────────────────────────────────────────────────────────────────────────────

async function collectPrevent(
  p: Profile,
  metrics: Observation[],
  invariants: InvariantObservation[],
): Promise<readonly PreventResult[]> {
  const results: PreventResult[] = [];
  for (const scenario of p.prevent.scenarios) {
    results.push(await runPrevention(scenario.name, scenario.degradation, p.prevent.options));
  }

  const steering = p.prevent.scenarios.filter((s) => s.shouldSteer).map((s) => s.name);
  const quiet = p.prevent.scenarios.filter((s) => !s.shouldSteer).map((s) => s.name);
  const find = (name: string): PreventResult | undefined =>
    results.find((r) => r.scenario === name);

  invariants.push(
    invariant.holds(
      "prevent.ledgerVerified",
      "every steering decision, taken or refused, is on a chain that still hashes",
      results.every((r) => r.ledgerVerified),
    ),
    invariant.holds(
      "prevent.detectionHeld",
      "the detector kept each incident open for the whole degradation it was steering against",
      steering.every((name) => find(name)?.detectionHeld === true),
    ),
    // A lift measured against an empty control arm is not a lift.
    invariant.positive(
      "prevent.controlAttempts",
      "customers were held out of steering, so the comparison has a control",
      results.reduce(
        (sum, r) => sum + r.incidents.reduce((n, i) => n + i.affected.control.attempts, 0),
        0,
      ),
    ),
  );

  // The scenario that must be left alone. A controller that starts pulling levers on a 14% rail is
  // worse for a merchant than one that never pulls them, and no lift metric would notice.
  for (const name of quiet) {
    invariants.push(
      invariant.zero(
        `prevent.${name}.steersIssued`,
        `steering declined on ${name}, where the rail is degraded but not enough to be worth moving`,
        find(name)?.steersIssued ?? -1,
      ),
    );
  }

  for (const name of steering) {
    const result = find(name);
    if (result === undefined) continue;

    const affected = combine(result.incidents.map((i) => i.affected));
    const collateral = combine(result.incidents.map((i) => i.collateral));

    metrics.push(
      metric(
        `prevent.${name}.lossRateDelta`,
        `loss rate avoided on ${name}, among customers whose own rail was the failing one`,
        affected.lossRateDelta,
        "higher-is-better",
        "ratio",
      ),
      metric(
        `prevent.${name}.savedPaise`,
        `payment value that did not fail on ${name} because traffic was steered`,
        affected.savedPaise,
        "higher-is-better",
        "paise",
      ),
      // Briefly an invariant, on the strength of eight quick-profile seeds that all returned zero.
      // The full profile then returned three, and it was right to: over forty-five minutes the
      // incident ramps, peaks and recovers, and the lever that suits a rail at 20% is not always
      // the one that suits it at 45%. "Never changes" was true by luck, which is precisely what a
      // one-profile study cannot tell you. What is worth guarding is flapping — a checkout that
      // rearranges itself every few seconds is worse for a merchant than one that never steered —
      // and that is a band, not a zero.
      metric(
        `prevent.${name}.leverChanges`,
        `times the lever or target changed mid-steer on ${name}`,
        result.incidents.reduce((sum, i) => sum + i.leverChanges, 0),
        "lower-is-better",
        "count",
      ),
      metric(
        `prevent.${name}.collateralDelta`,
        `what happened to customers on ${name} whose own rail was fine and who were moved anyway` +
          " — negative is the cost of the lever, not a bug",
        collateral.lossRateDelta,
        "neutral",
        "ratio",
      ),
    );
  }

  return results;
}

/**
 * Pool several incidents' comparisons into one.
 *
 * Attempt-weighted rather than averaged over incidents: an incident that saw forty attempts and one
 * that saw four thousand are not two equal opinions about the same effect.
 */
export function combine(comparisons: readonly Comparison[]): {
  lossRateDelta: number;
  savedPaise: number;
} {
  let treatedAttempts = 0;
  let treatedLost = 0;
  let controlAttempts = 0;
  let controlLost = 0;
  let savedPaise = 0;

  for (const c of comparisons) {
    treatedAttempts += c.treated.attempts;
    treatedLost += c.treated.lost;
    controlAttempts += c.control.attempts;
    controlLost += c.control.lost;
    savedPaise += c.savedPaise;
  }

  const treatedRate = treatedAttempts === 0 ? 0 : treatedLost / treatedAttempts;
  const controlRate = controlAttempts === 0 ? 0 : controlLost / controlAttempts;
  return { lossRateDelta: controlRate - treatedRate, savedPaise };
}

// ── Recovery ──────────────────────────────────────────────────────────────────────────────────

/** Postage, plus the priced value of every customer whose consent the arm spent. */
function trueCostPaise(arm: RecoveryArm): number {
  return arm.spentPaise + arm.optOuts * DEFAULT_RECOVERY_CONFIG.optOutCostPaise;
}

async function collectRecover(
  p: Profile,
  metrics: Observation[],
  invariants: InvariantObservation[],
): Promise<ScorecardDetail["recover"]> {
  const result = await runRecovery(p.recover);

  const kairos = result.arms.find((a) => a.name === "kairos + template copy");
  if (kairos === undefined) throw new Error("the recovery run produced no kairos arm");

  const generated = result.arms.find((a) => a.name === "kairos + generated copy");
  const unclassified = result.classMix["unknown"] ?? 0;
  const refusals = Object.values(kairos.refusals).reduce((sum, n) => sum + n, 0);

  invariants.push(
    invariant.positive(
      "recover.beatsDoNothing",
      "the recovery arm collected more than the customers would have returned with unaided",
      kairos.incrementalPaise,
    ),
    invariant.zero(
      "recover.unclassified",
      "no failure in our own traffic model fell through to `unknown` — a classifier that cannot " +
        "name them would be measuring its fallback",
      unclassified,
    ),
    invariant.positive(
      "recover.holdoutCasualties",
      "casualties were held out of treatment entirely, which is the only reason any recovery " +
        "figure has a denominator",
      result.holdout.casualties,
    ),
    invariant.positive(
      "recover.calibrationPredictions",
      "the probability model made predictions there were outcomes for",
      result.calibration.predictions,
    ),
    invariant.holds(
      "recover.ledgerVerified",
      "the recovery arm's audit chain hashes end to end",
      kairos.ledgerVerified,
    ),
    // Terminus refusing is Terminus working. The worker proposing something Terminus must refuse is
    // the worker wasting a pass — and that is exactly the defect the quiet-hours refusals exposed.
    invariant.zero(
      "recover.refusals",
      "nothing was proposed that the kernel then had to decline; the worker checks the schedule " +
        "before it asks",
      refusals,
    ),
    // Not "the library is good" — a gate cannot check that. This checks that the arm which claims to
    // run generated copy actually ran it. A library that failed to load, or whose segment keys
    // stopped matching what the executor looks up, would fall back to templates on every single
    // message and still report a plausible-looking number. That is the regression this catches, and
    // it is invisible in every other figure on the scorecard.
    invariant.holds(
      "recover.generatedCopyServed",
      "the generated-copy arm was actually served by the library rather than falling back to " +
        "templates on every message",
      generated === undefined || generated.copy.sent === 0
        ? false
        : generated.copy.fromLibrary / generated.copy.sent > 0.9,
    ),
  );

  metrics.push(
    metric(
      "recover.incrementalPaise",
      "recovered because of the arm, over and above what came back unaided",
      kairos.incrementalPaise,
      "higher-is-better",
      "paise",
    ),
    metric(
      "recover.trueCostPaise",
      "postage plus the priced value of every customer lost to an opt-out",
      trueCostPaise(kairos),
      "lower-is-better",
      "paise",
    ),
    metric(
      "recover.messages",
      "messages sent — the term the contact cap and the opt-out cost are both about",
      kairos.messages,
      "lower-is-better",
      "count",
    ),
    metric(
      "recover.copyLegibleRate",
      "share of the baseline's messages that reached somebody in a script they read — the size of " +
        "the problem the copy library exists to solve, measured on the arm that does not solve it",
      kairos.copy.sent === 0 ? 0 : kairos.copy.legible / kairos.copy.sent,
      "higher-is-better",
      "ratio",
    ),
    metric(
      "recover.generatedGainPaise",
      "what generated copy recovered over the same system running templates, at the default " +
        "readability penalty — a figure that goes to zero if that penalty is wrong",
      generated === undefined ? 0 : generated.incrementalPaise - kairos.incrementalPaise,
      "higher-is-better",
      "paise",
    ),
    metric(
      "recover.wastedActions",
      "actions that landed on somebody who was coming back anyway",
      kairos.wastedActions,
      "lower-is-better",
      "count",
    ),
    metric(
      "recover.calibrationError",
      "expected calibration error — whether a stated 30% means thirty per cent, which is what the " +
        "gate multiplies by a rupee amount",
      result.calibration.expectedError,
      "lower-is-better",
      "ratio",
    ),
    metric(
      "recover.calibrationSkill",
      "Brier skill over the base rate — a model that repeats the base rate for ever is perfectly " +
        "calibrated and worth nothing",
      result.calibration.skill,
      "higher-is-better",
      "rate",
    ),
    metric(
      "recover.autonomousShare",
      "share of casualties chargeable again without the customer present; a property of the " +
        "merchant's mix rather than of Kairos",
      result.autonomousShare,
      "neutral",
      "ratio",
    ),
  );

  return result;
}
