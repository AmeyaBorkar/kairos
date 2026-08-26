import { DEFAULT_DETECTOR_CONFIG, withThreshold } from "@kairos/detect";
import { mandateId, paise, slice } from "@kairos/domain";
import { Copy, type CopyLibrary, makeVariant, requiredSegments, segmentKey } from "@kairos/reason";
import { DEFAULT_RECOVERY_CONFIG, worstActionCostPaise } from "@kairos/recover";
import { ENGLISH_ONLY, INDIA_PROFILES, type SimulatorConfig } from "@kairos/simulator";
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

/**
 * A complete library of deliberately trivial copy.
 *
 * Not the committed one: this asserts the *wiring*, and a test that depended on 468 real variants
 * would fail for reasons about writing rather than about plumbing. Every segment is covered so the
 * generated arm never falls back, and each body is in its segment's own script so the legibility
 * check has something true to find.
 */
const IN_SCRIPT: Record<string, string> = {
  en: "Your payment for {amount} did not go through. Finish it here: {link}",
  hi: "आपका {amount} का भुगतान पूरा नहीं हुआ। यहाँ पूरा करें: {link}",
  mr: "तुमचे {amount} चे पेमेंट पूर्ण झाले नाही. येथे पूर्ण करा: {link}",
  ta: "உங்கள் {amount} கட்டணம் முடியவில்லை. இங்கே முடிக்கவும்: {link}",
};

function testLibrary(): Copy {
  const segments = requiredSegments({
    languages: ["en", "hi", "mr", "ta"],
    methods: ["upi", "card", "netbanking", "wallet", "emi", "paylater"],
    channels: ["contact-sms", "contact-whatsapp", "contact-email"],
  });

  const library: CopyLibrary = {
    provenance: {
      model: "test-model",
      generatedAt: "2026-08-26",
      promptHash: "0000000000000000",
      spentPaise: 1,
      calls: 1,
    },
    variants: segments.map((segment) =>
      makeVariant(
        segment,
        segmentKey(segment),
        IN_SCRIPT[segment.language] ?? "",
        segment.channel === "contact-email" ? "Your payment" : null,
      ),
    ),
  };
  return new Copy(library);
}

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
    const kairos = scorecard.arms.find((a) => a.name === "kairos + template copy");
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

  it("serves the generated arm from the library rather than quietly falling back", async () => {
    // The regression this guards is invisible in every other number: if the segment keys the
    // executor looks up stopped matching the ones the library is indexed by, every message would
    // fall back to a template and the arm would still report a plausible figure.
    const scorecard = await runRecovery({
      simulator,
      detector: { ...withThreshold(DEFAULT_DETECTOR_CONFIG, 12), rollup: true },
      mandate,
      secret: SECRET,
      tailMs: 6 * DAY,
      library: testLibrary(),
    });

    const generated = scorecard.arms.find((a) => a.name === "kairos + generated copy");
    if (generated === undefined) throw new Error("missing generated arm");

    expect(generated.copy.sent).toBeGreaterThan(0);
    expect(generated.copy.fromLibrary).toBe(generated.copy.sent);
    expect(generated.copy.legible).toBe(generated.copy.sent);
  });

  it("sends the template arm into a population that cannot all read it", async () => {
    // The baseline's legibility rate is the size of the problem, and it must not be 100% or the
    // comparison has nothing to measure. It should sit near the English share of the population.
    const scorecard = await runRecovery({
      simulator,
      detector: { ...withThreshold(DEFAULT_DETECTOR_CONFIG, 12), rollup: true },
      mandate,
      secret: SECRET,
      tailMs: 6 * DAY,
      library: testLibrary(),
    });

    const templates = scorecard.arms.find((a) => a.name === "kairos + template copy");
    if (templates === undefined) throw new Error("missing template arm");

    // Tracks the English share of the population without equalling it, and the gap is real rather
    // than sampling noise: this is a rate per *message*, and customers do not all receive the same
    // number of messages. Asserting equality would be asserting something false.
    const legibleRate = templates.copy.legible / templates.copy.sent;
    expect(legibleRate).toBeGreaterThan(0.3);
    expect(legibleRate).toBeLessThan(0.7);
    expect(Math.abs(legibleRate - scorecard.languageMix["en"])).toBeLessThan(0.15);
  });

  it("finds nothing for the library to add when everybody reads English", async () => {
    // The control that shows the gain is about language and not about the harness preferring one
    // arm. With a monolingual population every template is legible, the penalty never applies, and
    // whatever is left is what generated copy is worth on its writing alone.
    const scorecard = await runRecovery({
      simulator,
      detector: { ...withThreshold(DEFAULT_DETECTOR_CONFIG, 12), rollup: true },
      mandate,
      secret: SECRET,
      tailMs: 6 * DAY,
      languageMix: ENGLISH_ONLY,
      library: testLibrary(),
    });

    const templates = scorecard.arms.find((a) => a.name === "kairos + template copy");
    const generated = scorecard.arms.find((a) => a.name === "kairos + generated copy");
    if (templates === undefined || generated === undefined) throw new Error("missing arm");

    expect(templates.copy.legible).toBe(templates.copy.sent);
    expect(generated.copy.legible).toBe(generated.copy.sent);
  });

  it("does not run a generated arm it was given no library for", async () => {
    // A missing library is an ordinary condition, not an error — the run degrades to four arms.
    const scorecard = await run();
    expect(scorecard.arms.map((a) => a.name)).not.toContain("kairos + generated copy");
    expect(scorecard.legibilitySweep).toHaveLength(0);
  });
});
