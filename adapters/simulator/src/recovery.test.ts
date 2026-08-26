import { describe, expect, it } from "vitest";
import { generate, generateLabelled, type SimulatorConfig } from "./generate.js";
import { INDIA_PROFILES } from "./profiles.js";
import {
  type ActionContext,
  type CasualtyClass,
  DEFAULT_RECOVERY_WORLD,
  RecoveryWorld,
} from "./recovery.js";

const AT = Date.UTC(2026, 7, 25, 4, 30);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const world = new RecoveryWorld(20260825);

function context(o: Partial<ActionContext> = {}): ActionContext {
  return {
    casualtyId: "cas_1",
    casualtyClass: "transient",
    occurredAt: AT,
    at: AT + HOUR,
    railHealthy: true,
    pastPayday: false,
    ordinal: 0,
    guidance: 0,
    legible: true,
    ...o,
  };
}

const ids = (n: number, prefix = "cas"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}_${i}`);

describe("determinism", () => {
  it("gives a casualty the same fate however many others were drawn first", () => {
    // Without this, two arms running the same casualties in a different order diverge for reasons
    // that have nothing to do with the policy being measured, and every comparison is noise.
    const first = world.counterfactual("cas_1234", "transient", AT);

    for (const id of ids(500, "noise")) world.counterfactual(id, "timed", AT);
    for (const id of ids(500, "more")) world.contact(context({ casualtyId: id }), "contact-sms");

    expect(world.counterfactual("cas_1234", "transient", AT)).toEqual(first);
  });

  it("gives two worlds with different seeds different answers", () => {
    const a = new RecoveryWorld(1);
    const b = new RecoveryWorld(2);
    const differ = ids(200).filter(
      (id) =>
        a.counterfactual(id, "transient", AT).spontaneousAt !==
        b.counterfactual(id, "transient", AT).spontaneousAt,
    );
    expect(differ.length).toBeGreaterThan(50);
  });
});

describe("the counterfactual", () => {
  it("returns customers unprompted at roughly the configured rate", () => {
    for (const klass of ["transient", "timed", "customer-action", "customer-retry"] as const) {
      const returned = ids(4000, klass).filter(
        (id) => world.counterfactual(id, klass, AT).spontaneousAt !== null,
      ).length;
      const expected = DEFAULT_RECOVERY_WORLD.spontaneousReturn[klass];
      expect(returned / 4000).toBeGreaterThan(expected - 0.03);
      expect(returned / 4000).toBeLessThan(expected + 0.03);
    }
  });

  it("brings a cancelled checkout back sooner than an expired card", () => {
    // The ordering is the part that is not a guess. Someone who cancelled a payment ninety seconds
    // ago is standing at a checkout; someone whose card expired has to go and find another one.
    const median = (klass: CasualtyClass): number => {
      const delays = ids(3000, klass)
        .map((id) => world.counterfactual(id, klass, AT).spontaneousAt)
        .filter((at): at is number => at !== null)
        .map((at) => at - AT)
        .sort((a, b) => a - b);
      return delays[Math.floor(delays.length / 2)] ?? 0;
    };

    expect(median("customer-retry")).toBeLessThan(median("transient"));
    expect(median("transient")).toBeLessThan(median("customer-action"));
  });

  it("never returns anybody after the horizon", () => {
    for (const id of ids(2000)) {
      const { spontaneousAt } = world.counterfactual(id, "timed", AT);
      if (spontaneousAt !== null) {
        expect(spontaneousAt).toBeLessThanOrEqual(AT + DEFAULT_RECOVERY_WORLD.horizonMs);
      }
    }
  });
});

describe("retry", () => {
  it("succeeds when the rail has healed and fails while it is broken", () => {
    // The premise of scheduling on a recovery edge. If a retry worked equally well mid-outage,
    // waiting would be a pointless delay.
    const healed = ids(500).filter(
      (id) => world.retry(context({ casualtyId: id, railHealthy: true })).recovered,
    ).length;
    const broken = ids(500).filter(
      (id) => world.retry(context({ casualtyId: id, railHealthy: false })).recovered,
    ).length;

    expect(healed).toBe(500);
    expect(broken).toBe(0);
  });

  it("recovers far more after a payday than before one", () => {
    const rate = (pastPayday: boolean): number =>
      ids(3000, `t${String(pastPayday)}`).filter(
        (id) =>
          world.retry(context({ casualtyId: id, casualtyClass: "timed", pastPayday })).recovered,
      ).length / 3000;

    expect(rate(true)).toBeGreaterThan(rate(false) * 3);
  });

  it("never recovers a dead failure", () => {
    const any = ids(500).some(
      (id) => world.retry(context({ casualtyId: id, casualtyClass: "dead" })).recovered,
    );
    expect(any).toBe(false);
  });
});

describe("contact", () => {
  /** What an untouched casualty does: comes back on its own, and only then if it can succeed. */
  function controlRate(klass: CasualtyClass, sample: readonly string[]): number {
    const recovered = sample.filter((id) => {
      const { spontaneousAt } = world.counterfactual(id, klass, AT);
      if (spontaneousAt === null) return false;
      return world.wouldSucceed(
        context({ casualtyId: id, casualtyClass: klass, at: spontaneousAt, pastPayday: true }),
      );
    }).length;
    return recovered / sample.length;
  }

  it("recovers people a control arm would not have", () => {
    // The whole point of sending anything. Treated recovery has to exceed the base rate, and the
    // gap is the only part worth paying for.
    const sample = ids(4000, "uplift");
    for (const klass of ["transient", "timed"] as const) {
      const treated =
        sample.filter(
          (id) =>
            world.contact(
              context({ casualtyId: id, casualtyClass: klass, at: AT + DAY, pastPayday: true }),
              "contact-sms",
            ).recovered,
        ).length / sample.length;

      expect(treated).toBeGreaterThan(controlRate(klass, sample) + 0.05);
    }
  });

  it("finds a message about an expired card nearly worthless the next day", () => {
    // The sharpest thing the model says, and it is a fact about the world rather than about the
    // policy. Nobody has replaced their card in a day, so a message that arrives then reaches a
    // customer who still cannot pay: 1.5% recover with no help, 1.6% with a message. Give it three
    // days and tell them specifically what is wrong, and it is 13%.
    //
    // A dunning ladder that fires at +1h and +24h spends its whole budget in the window where this
    // class cannot respond, which is what classification is for.
    const sample = ids(4000, "uplift");
    const base = controlRate("customer-action", sample);

    const hasty =
      sample.filter(
        (id) =>
          world.contact(
            context({ casualtyId: id, casualtyClass: "customer-action", at: AT + DAY }),
            "contact-sms",
          ).recovered,
      ).length / sample.length;

    const patient =
      sample.filter(
        (id) =>
          world.contact(
            context({
              casualtyId: id,
              casualtyClass: "customer-action",
              at: AT + 3 * DAY,
              guidance: 1,
            }),
            "contact-sms",
          ).recovered,
      ).length / sample.length;

    expect(hasty - base).toBeLessThan(0.01);
    expect(patient - base).toBeGreaterThan(0.08);
  });

  it("flags the recoveries that were coming anyway", () => {
    // Without this the arm reports the sum of its own effect and the customer's, and claims both.
    // On the largest class of all — a customer who simply has to try again — nearly nine in ten of
    // the recoveries a message appears to produce were already on their way. It is the whole
    // argument for the spontaneous window, and for asking exactly once.
    const recovered = ids(3000, "attrib")
      .map((id) =>
        world.contact(
          context({ casualtyId: id, casualtyClass: "customer-retry", at: AT + HOUR }),
          "contact-whatsapp",
        ),
      )
      .filter((o) => o.recovered);

    const free = recovered.filter((o) => o.wasAlreadyComing).length;
    expect(recovered.length).toBeGreaterThan(100);
    expect(free / recovered.length).toBeGreaterThan(0.8);
  });

  it("works less well the more times it has already been sent", () => {
    const rate = (ordinal: number): number =>
      ids(3000, `ord${ordinal}`).filter(
        (id) =>
          world.contact(
            context({ casualtyId: id, casualtyClass: "customer-action", at: AT + DAY, ordinal }),
            "contact-sms",
          ).recovered,
      ).length / 3000;

    expect(rate(0)).toBeGreaterThan(rate(1));
    expect(rate(1)).toBeGreaterThan(rate(3));
  });

  it("moves fewer people when they cannot read it", () => {
    // The mechanism the whole multilingual case rests on, and it lives here rather than in the
    // scorer. A message in the wrong script still arrives, still costs its segments and still
    // spends a contact from the cap — it just persuades fewer people to come back. Before this, an
    // illegible message pulled exactly as many people as a legible one and was merely slightly
    // worse at helping them, which is not a model of anything.
    const rate = (legible: boolean): number =>
      ids(4000, `leg${legible}`).filter(
        (id) =>
          world.contact(
            context({ casualtyId: id, casualtyClass: "timed", at: AT + 8 * DAY, legible }),
            "contact-sms",
          ).recovered,
      ).length / 4000;

    expect(rate(true)).toBeGreaterThan(rate(false));
  });

  it("charges the penalty once, on the response, and not again on the outcome", () => {
    // The property that stops the multilingual arm from being flattered by construction. Guidance
    // and legibility are separate inputs, so an illegible message with perfect content is penalised
    // exactly as much as an illegible message with none — the content score is not docked a second
    // time for the script it arrived in.
    const illegible = new RecoveryWorld(20260825, {
      ...DEFAULT_RECOVERY_WORLD,
      illegiblePenalty: 0,
    });
    const outcomes = ids(500, "once").map((id) =>
      illegible.contact(
        context({
          casualtyId: id,
          casualtyClass: "customer-action",
          at: AT + 3 * DAY,
          guidance: 1,
          legible: false,
        }),
        "contact-sms",
      ),
    );

    // At a penalty of zero nobody who was not already coming back responds at all, whatever the
    // copy said. Every recovery left is somebody the message did not earn.
    expect(outcomes.filter((o) => o.recovered && !o.wasAlreadyComing)).toHaveLength(0);
  });

  it("recovers more when it says what to fix than when it says a payment failed", () => {
    // Why a specific fix-link is worth more than a reminder, and the reason classification pays for
    // itself twice: once by picking the right moment and once by picking the right words.
    const rate = (guidance: number): number =>
      ids(4000, `g${String(guidance)}`).filter(
        (id) =>
          world.contact(
            context({
              casualtyId: id,
              casualtyClass: "customer-action",
              at: AT + 2 * DAY,
              guidance,
            }),
            "contact-sms",
          ).recovered,
      ).length / 4000;

    expect(rate(1)).toBeGreaterThan(rate(0) * 1.5);
  });

  it("scales with how good the copy is, rather than switching on a flag", () => {
    // The reason the field stopped being a boolean. Copy is not guided or unguided: it names the
    // bank or it does not, says what to do or does not, arrives in a script the reader uses or does
    // not. A message with some of those is worth more than one with none and less than one with all.
    const rate = (guidance: number): number =>
      ids(3000, `scale${String(guidance)}`).filter(
        (id) =>
          world.contact(
            context({
              casualtyId: id,
              casualtyClass: "customer-action",
              at: AT + 2 * DAY,
              guidance,
            }),
            "contact-sms",
          ).recovered,
      ).length / 3000;

    const none = rate(0);
    const half = rate(0.5);
    const full = rate(1);
    expect(half).toBeGreaterThan(none);
    expect(full).toBeGreaterThan(half);
  });

  it("fails to deliver, and costs consent, at the configured rates", () => {
    const outcomes = ids(5000, "deliver").map((id) =>
      world.contact(context({ casualtyId: id, casualtyClass: "customer-action" }), "contact-email"),
    );

    const undelivered = outcomes.filter((o) => !o.delivered).length / 5000;
    const optedOut =
      outcomes.filter((o) => o.optedOut).length / outcomes.filter((o) => o.delivered).length;

    expect(undelivered).toBeCloseTo(DEFAULT_RECOVERY_WORLD.undeliverableRate["contact-email"], 1);
    expect(optedOut).toBeCloseTo(DEFAULT_RECOVERY_WORLD.optOutRate["contact-email"], 2);
  });

  it("never recovers a message that did not arrive", () => {
    const undelivered = ids(5000, "deliver")
      .map((id) =>
        world.contact(
          context({ casualtyId: id, casualtyClass: "customer-action" }),
          "contact-email",
        ),
      )
      .filter((o) => !o.delivered);

    expect(undelivered.length).toBeGreaterThan(0);
    expect(undelivered.every((o) => !o.recovered)).toBe(true);
  });

  it("brings back nobody whose failure is dead", () => {
    const any = ids(1000, "dead")
      .map((id) => world.contact(context({ casualtyId: id, casualtyClass: "dead" }), "contact-sms"))
      .some((o) => o.recovered);
    expect(any).toBe(false);
  });
});

describe("the labelled stream", () => {
  const config: SimulatorConfig = {
    seed: 7,
    startAt: AT,
    durationMs: 45 * 60_000,
    attemptsPerMinute: 240,
    profiles: INDIA_PROFILES,
    degradations: [],
  };

  it("produces exactly the attempts the plain generator produces", () => {
    // The property that let this be added without invalidating a single published benchmark: the
    // retry capability is drawn from the attempt's own id, not from the shared generator, so no
    // number downstream of it moved.
    const plain = [...generate(config)];
    const labelled = [...generateLabelled(config)].map((l) => l.attempt);
    expect(labelled).toEqual(plain);
    expect(plain.length).toBeGreaterThan(1000);
  });

  it("makes only a minority of payments chargeable again without the customer", () => {
    // The number that decides how much of the recovery arm exists at all. A tool assuming most
    // payments are retryable would report an arm that does not exist for the merchants most likely
    // to want one.
    const labelled = [...generateLabelled(config)];
    const autonomous = labelled.filter((l) => l.retry === "autonomous").length;
    expect(autonomous / labelled.length).toBeCloseTo(0.14, 1);
  });

  it("labels which failures the outage caused", () => {
    const degraded: SimulatorConfig = {
      ...config,
      degradations: [
        {
          slice: { method: "upi", issuer: "hdfc", instrument: null },
          onsetAt: AT + 10 * 60_000,
          rampMs: 0,
          peakFailureRate: 0.7,
          holdMs: 20 * 60_000,
          recoveryMs: 0,
        },
      ],
    };

    const labelled = [...generateLabelled(degraded)];
    const caused = labelled.filter((l) => l.fromDegradation);

    expect(caused.length).toBeGreaterThan(50);
    expect(caused.every((l) => l.attempt.slice.issuer === "hdfc")).toBe(true);
    expect(caused.every((l) => l.attempt.status === "failed")).toBe(true);
  });
});
