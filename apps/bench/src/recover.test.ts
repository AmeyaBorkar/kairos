import { DEFAULT_DETECTOR_CONFIG, withThreshold } from "@kairos/detect";
import { mandateId, paise, slice } from "@kairos/domain";
import { DEFAULT_RECOVERY_CONFIG, worstActionCostPaise } from "@kairos/recover";
import { INDIA_PROFILES, type SimulatorConfig } from "@kairos/simulator";
import { sealMandate } from "@kairos/terminus";
import { describe, expect, it } from "vitest";
import { type RecoveryScorecard, runRecovery } from "./recover.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const START = 1_756_000_000_000;
const SECRET = "test-only-secret-that-is-long-enough-to-pass";

const simulator: SimulatorConfig = {
  seed: 4242,
  startAt: START,
  durationMs: 25 * MINUTE,
  attemptsPerMinute: 90,
  profiles: INDIA_PROFILES,
  degradations: [
    {
      slice: slice("netbanking", "hdfc"),
      onsetAt: START + 6 * MINUTE,
      rampMs: 30_000,
      peakFailureRate: 0.5,
      holdMs: 8 * MINUTE,
      recoveryMs: 60_000,
    },
  ],
  customerPool: 4_000,
};

const mandate = sealMandate(
  {
    id: mandateId("mnd_test"),
    merchantId: "test",
    campaignId: "recovery",
    budgetPaise: paise(500_00),
    maxActionCostPaise: worstActionCostPaise(DEFAULT_RECOVERY_CONFIG),
    maxInFlight: 32,
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

async function run(): Promise<RecoveryScorecard> {
  return await runRecovery({
    simulator,
    detector: { ...withThreshold(DEFAULT_DETECTOR_CONFIG, 12), rollup: true },
    mandate,
    secret: SECRET,
    tailMs: 6 * DAY,
    spontaneousWindows: [0, 45 * MINUTE],
  });
}

describe("the recovery harness", () => {
  it("is reproducible from its seed", async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.arms).toEqual(b.arms);
    expect(a.windowSweep).toEqual(b.windowSweep);
  });

  it("gives every arm the same casualties and the same counterfactual", async () => {
    // The comparison is only meaningful if a casualty's fate under no intervention is the same fact
    // in all four arms. Different populations would make every difference between them noise.
    const scorecard = await run();
    const counts = new Set(scorecard.arms.map((a) => a.casualties));
    const losses = new Set(scorecard.arms.map((a) => a.lostPaise));

    expect(counts.size).toBe(1);
    expect(losses.size).toBe(1);
    expect([...counts][0]).toBeGreaterThan(100);
  });

  it("spends nothing on the arm that does nothing", async () => {
    const scorecard = await run();
    const nothing = scorecard.arms.find((a) => a.name === "do nothing");

    expect(nothing?.spentPaise).toBe(0);
    expect(nothing?.messages).toBe(0);
    expect(nothing?.incrementalPaise).toBe(0);
    expect(nothing?.recoveredPaise).toBeGreaterThan(0);
  });

  it("measures incremental recovery against that arm rather than gross", async () => {
    // The number every dunning dashboard reports is the gross figure, which includes every customer
    // who was coming back regardless.
    const scorecard = await run();
    const nothing = scorecard.arms.find((a) => a.name === "do nothing");
    const kairos = scorecard.arms.find((a) => a.name === "kairos");
    if (nothing === undefined || kairos === undefined) throw new Error("missing arm");

    expect(kairos.incrementalPaise).toBe(kairos.recoveredPaise - nothing.recoveredPaise);
    expect(kairos.incrementalPaise).toBeLessThan(kairos.recoveredPaise);
  });

  it("holds a population out of treatment entirely", async () => {
    const scorecard = await run();
    expect(scorecard.holdout.casualties).toBeGreaterThan(0);
  });

  it("reports a probability that means something", async () => {
    // The gate multiplies this by a rupee amount, so the property that matters is not accuracy but
    // whether the number is honest. Anything above a few points of calibration error would make
    // every expected-value comparison in the system wrong by that much.
    const scorecard = await run();
    expect(scorecard.calibration.predictions).toBeGreaterThan(100);
    expect(scorecard.calibration.expectedError).toBeLessThan(0.1);
  });

  it("finds most casualties impossible to retry without the customer", async () => {
    // The finding that shapes the whole arm: for the great majority, knowing the rail has healed is
    // worth nothing on its own.
    const scorecard = await run();
    expect(scorecard.autonomousShare).toBeLessThan(0.25);
    expect(scorecard.autonomousShare).toBeGreaterThan(0.02);
  });

  it("wastes fewer actions the longer it waits", async () => {
    // The mechanism the spontaneous window exists for, isolated: a customer who returns unaided
    // closes their own casualty and never costs a message.
    const scorecard = await run();
    const [none, waited] = scorecard.windowSweep;
    if (none === undefined || waited === undefined) throw new Error("missing sweep row");

    expect(waited.wastedActions).toBeLessThan(none.wastedActions);
    expect(waited.messages).toBeLessThanOrEqual(none.messages);
  });
});
