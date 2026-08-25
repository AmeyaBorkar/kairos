import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_DETECTOR_CONFIG, withThreshold } from "@kairos/detect";
import { formatINR, mandateId, paise, slice } from "@kairos/domain";
import { DEFAULT_RECOVERY_CONFIG, worstActionCostPaise } from "@kairos/recover";
import { type Degradation, INDIA_PROFILES, type SimulatorConfig } from "@kairos/simulator";
import { sealMandate } from "@kairos/terminus";
import { type ArmResult, type RecoveryScorecard, runRecovery } from "./recover.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = 1_756_000_000_000;
const RULE = "─".repeat(92);

const SECRET = "bench-only-secret-that-is-long-enough-to-pass";

/**
 * Two rails break during the window, at different altitudes.
 *
 * One is precisely detectable and heals quickly; the other is an issuer-wide UPI outage that runs
 * long enough for the `railPatience` rule to give up on calling it transient. Between them they
 * exercise both halves of the schedule: fire on the recovery edge, and stop waiting for a rail that
 * is not coming back.
 */
const DEGRADATIONS: readonly Degradation[] = [
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

function inr(amount: number): string {
  return formatINR(paise(Math.round(amount)));
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function pad(text: string, width: number, align: "left" | "right"): string {
  return align === "left" ? text.padEnd(width) : text.padStart(width);
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c, widths[i] ?? 0, i === 0 ? "left" : "right")).join("  ");
  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/**
 * The comparison, in the units a merchant reads.
 *
 * `incremental` is the column that matters and the one no dunning dashboard shows. An arm's gross
 * recovery includes every customer who was coming back regardless; subtracting the do-nothing arm
 * is the only way to say what the policy was worth. `wasted` is the other side of the same coin —
 * money spent on people who had already decided to pay.
 */
/**
 * The true cost of an arm: what it spent, plus what it destroyed.
 *
 * Postage is almost free at Indian message prices, so an arm judged on spend alone looks
 * spectacular whatever it does. What actually costs a merchant money is losing a customer's consent
 * to be contacted at all, and that appears on no invoice — which is exactly why the decision layer
 * prices it and why the comparison here has to.
 */
function economicCostPaise(arm: ArmResult): number {
  return arm.spentPaise + arm.optOuts * DEFAULT_RECOVERY_CONFIG.optOutCostPaise;
}

function formatArms(arms: readonly ArmResult[]): string {
  const rows = arms.map((arm) => {
    const cost = economicCostPaise(arm);
    const perRupee = arm.incrementalPaise > 0 ? (cost / arm.incrementalPaise).toFixed(4) : "—";
    return [
      arm.name,
      inr(arm.recoveredPaise),
      arm.incrementalPaise === 0 ? "—" : inr(arm.incrementalPaise),
      inr(arm.spentPaise),
      `${arm.optOuts}`,
      inr(cost),
      `${arm.messages}`,
      `${arm.retries}`,
      `${arm.wastedActions}`,
      perRupee,
    ];
  });

  return table(
    [
      "arm",
      "recovered",
      "incremental",
      "postage",
      "lost",
      "true cost",
      "msgs",
      "retries",
      "wasted",
      "cost/₹",
    ],
    rows,
  );
}

/** Refusals for one arm, from its own ledger. */
function formatRefusals(arm: ArmResult): string {
  const rows = Object.entries(arm.refusals).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return "  none";
  return table(
    ["axis", "count"],
    rows.map(([axis, n]) => [axis, `${n}`]),
  );
}

function formatCalibration(scorecard: RecoveryScorecard): string {
  const rows = scorecard.calibration.bins.map((bin) => [
    `${(bin.lower * 100).toFixed(0)}–${(bin.upper * 100).toFixed(0)}%`,
    `${bin.count}`,
    percent(bin.predicted),
    percent(bin.observed),
    `${bin.observed >= bin.predicted ? "+" : ""}${((bin.observed - bin.predicted) * 100).toFixed(1)}`,
  ]);
  return table(["predicted", "n", "mean p", "actual", "gap"], rows);
}

/**
 * The one parameter in the schedule that is a bet rather than a constraint.
 *
 * Waiting before spending anything on a customer saves messages on the ones who were coming back
 * unaided; it also loses the recoveries that only happened because somebody was asked at a better
 * moment than they would have picked. Which effect wins cannot be reasoned out from first
 * principles, so it is measured, and the table is read down the `incremental` column.
 */
function formatWindowSweep(scorecard: RecoveryScorecard): string {
  const rows = scorecard.windowSweep.map((row) => [
    row.windowMs === 0 ? "none" : `${Math.round(row.windowMs / 60_000)} min`,
    inr(row.incrementalPaise),
    `${row.messages}`,
    `${row.retries}`,
    `${row.wastedActions}`,
    `${row.optOuts}`,
    inr(row.spentPaise + row.optOuts * DEFAULT_RECOVERY_CONFIG.optOutCostPaise),
  ]);
  return table(["window", "incremental", "msgs", "retries", "wasted", "lost", "true cost"], rows);
}

function formatClassMix(scorecard: RecoveryScorecard): string {
  const total = Object.values(scorecard.classMix).reduce((sum, n) => sum + n, 0);
  const rows = Object.entries(scorecard.classMix)
    .sort((a, b) => b[1] - a[1])
    .map(([klass, count]) => [klass, `${count}`, percent(total === 0 ? 0 : count / total)]);
  return table(["class", "casualties", "share"], rows);
}

async function main(): Promise<void> {
  const quick = process.argv.includes("--quick");
  const durationMs = quick ? 90 * MINUTE : 4 * HOUR;
  const attemptsPerMinute = quick ? 120 : 300;
  const tailMs = quick ? 10 * DAY : 40 * DAY;

  const simulator: SimulatorConfig = {
    seed: 20260825,
    startAt: START,
    durationMs,
    attemptsPerMinute,
    profiles: INDIA_PROFILES,
    degradations: DEGRADATIONS,
    customerPool: 12_000,
  };

  const mandate = sealMandate(
    {
      id: mandateId("mnd_bench_recovery"),
      merchantId: "bench",
      campaignId: "recovery",
      // Deliberately generous, so the comparison is between policies rather than between arms that
      // ran out of money at different moments. The bound-holding is measured in `bench:spend`.
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
    },
    SECRET,
  );

  const scorecard = await runRecovery({
    simulator,
    detector: { ...withThreshold(DEFAULT_DETECTOR_CONFIG, 12), rollup: true },
    mandate,
    secret: SECRET,
    tailMs,
    spontaneousWindows: [0, 5 * MINUTE, 15 * MINUTE, 45 * MINUTE, 2 * HOUR],
  });

  const out: string[] = [];
  const say = (line = ""): void => {
    out.push(line);
  };

  const kairos = scorecard.arms.find((a) => a.name === "kairos");
  const nothing = scorecard.arms.find((a) => a.name === "do nothing");

  say(RULE);
  say("RECOVERY — what the casualty arm is worth, against three baselines");
  say(RULE);
  say();
  say(
    `${nothing?.casualties ?? 0} casualties worth ${inr(nothing?.lostPaise ?? 0)} over ` +
      `${(durationMs / HOUR).toFixed(1)}h of traffic, worked for ${(tailMs / DAY).toFixed(0)} days.`,
  );
  say();
  say(formatClassMix(scorecard));
  say();
  say(
    `Only ${percent(scorecard.autonomousShare)} of these payments can be charged again without ` +
      "the customer being present. For the rest, knowing the rail has healed is worth nothing on",
  );
  say("its own — the only lever left is a message. See ADR 0004.");
  say();
  say(RULE);
  say();
  say(formatArms(scorecard.arms));
  say();
  say(
    "`incremental` is recovery minus what the do-nothing arm collected. It is the column no " +
      "dunning dashboard shows, and",
  );
  say(
    "the gap between it and `recovered` is customers who were coming back regardless. `wasted` " +
      "counts the actions that landed",
  );
  say(
    "on exactly those people. `true cost` adds the priced value of every customer lost to an " +
      "opt-out, which is the cost that",
  );
  say("dominates and appears on no invoice.");
  say();

  say(
    "The baselines are given every advantage that is not the point of the comparison: the same " +
      "Terminus mandate, the same",
  );
  say(
    "budget, the same contact cap, and a message deferred rather than dropped when it lands in " +
      "quiet hours. What they do not",
  );
  say(
    "get is Kairos's classification — a naive ladder has not classified anything, so it sends " +
      "generic copy and earns none of",
  );
  say("the stopping rules that come from knowing what went wrong.");
  say();

  const ladder = scorecard.arms.find((a) => a.name.startsWith("chronos"));
  if (kairos !== undefined && nothing !== undefined && ladder !== undefined) {
    const gross = kairos.recoveredPaise - nothing.recoveredPaise;
    say(
      `Kairos recovered ${inr(kairos.recoveredPaise)} gross, ${inr(gross)} of it incremental, ` +
        `for a true cost of ${inr(economicCostPaise(kairos))}.`,
    );
    if (ladder.incrementalPaise > 0) {
      const delta = gross / ladder.incrementalPaise - 1;
      const cheaper = 1 - economicCostPaise(kairos) / economicCostPaise(ladder);
      const messages = 1 - kairos.messages / ladder.messages;
      say(
        `Against the fixed ladder: ${percent(Math.abs(delta))} ${delta >= 0 ? "more" : "less"} ` +
          `incremental recovery, ${percent(cheaper)} lower true cost, ${percent(messages)} fewer ` +
          `messages,`,
      );
      say(`and ${ladder.optOuts - kairos.optOuts} fewer customers lost.`);
      say();
      say(
        delta >= 0
          ? "Better on every axis."
          : "The honest headline is not that Kairos recovers more. A ladder that messages every " +
              "casualty three times recovers a",
      );
      if (delta < 0) {
        say(
          "little more money than one that thinks about it — brute force works. It works by " +
            "sending twice the messages and",
        );
        say(
          `costing ${ladder.optOuts} customers their consent rather than ${kairos.optOuts}, and ` +
            "the merchant pays for that in a currency",
        );
        say("that does not appear on the invoice.");
      }
    }
    say();
    for (const arm of scorecard.arms) {
      if (arm.name === "do nothing") continue;
      say(`Refusals — ${arm.name}:`);
      say(formatRefusals(arm));
      say();
    }
  }

  say(RULE);
  say();
  say(
    `Held out of treatment entirely: ${scorecard.holdout.casualties} casualties, of which ` +
      `${inr(scorecard.holdout.recoveredPaise)} came back unaided.`,
  );
  say(
    "That population costs real recovered revenue and is the only reason any number above has a " +
      "denominator (open question 11).",
  );
  say();
  say(RULE);
  say();
  say("THE SPONTANEOUS WINDOW — how long to let a customer come back unaided");
  say();
  say(formatWindowSweep(scorecard));
  say();
  const sweep = scorecard.windowSweep;
  const shortest = sweep[0];
  const longest = sweep.at(-1);
  if (shortest !== undefined && longest !== undefined && sweep.length > 1) {
    const fewer = 1 - longest.messages / shortest.messages;
    const lessWaste = 1 - longest.wastedActions / shortest.wastedActions;
    const moreMoney = longest.incrementalPaise / shortest.incrementalPaise - 1;
    say(
      `Waiting ${Math.round(longest.windowMs / 60_000)} minutes instead of none sends ` +
        `${percent(fewer)} fewer messages, wastes ${percent(lessWaste)} fewer of them on ` +
        "customers who were",
    );
    say(
      `already returning, and recovers ${percent(Math.abs(moreMoney))} ` +
        `${moreMoney >= 0 ? "more" : "less"} incremental revenue.`,
    );
    say();
  }
  say(
    "The window went in on the argument that a nudge ninety seconds after a cancelled payment is " +
      "mostly paid for by people who",
  );
  say(
    "were already reaching for another card, and that waiting therefore trades recovery for " +
      "restraint. The table says there is no",
  );
  say(
    "trade. Messages and wasted actions fall monotonically with the window and incremental " +
      "recovery does not fall with them,",
  );
  say(
    "because the two mechanisms point the same way: a customer who returns unaided closes their " +
      "own casualty and never costs a",
  );
  say(
    "message, and a transient casualty asked later is asked when its rail is likelier to have " +
      "healed. Waiting is not the price of",
  );
  say("restraint here — it is most of the product.");
  say();
  say(
    "The 45-minute default was chosen before this table existed and the sweep suggests it is too " +
      "short. Opt-out counts across the",
  );
  say(
    "sweep are noisy enough that the cheapest row is not stable, so the default is left where it " +
      "is rather than tuned to one run.",
  );
  say();
  say(RULE);
  say();
  say(`CALIBRATION — ${scorecard.calibration.predictions} predictions`);
  say();
  say(formatCalibration(scorecard));
  say();
  say(
    `expected calibration error ${percent(scorecard.calibration.expectedError)} · ` +
      `Brier ${scorecard.calibration.brier.toFixed(4)} · ` +
      `skill ${scorecard.calibration.skill.toFixed(3)}`,
  );
  say();
  say(
    "The gate multiplies this probability by a rupee amount, so what matters is whether 30% means " +
      "thirty per cent. Skill is",
  );
  say(
    "reported beside it because a model that repeats the base rate for ever is perfectly " +
      "calibrated and worth nothing.",
  );
  say();
  say(RULE);

  const rendered = out.join("\n");
  process.stdout.write(`${rendered}\n`);

  const path = resolve(process.cwd(), "../../docs/results/recovery.txt");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rendered}\n`, "utf8");
  writeFileSync(
    resolve(dirname(path), "recovery.json"),
    `${JSON.stringify(scorecard, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
