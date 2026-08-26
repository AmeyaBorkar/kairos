import { DEFAULT_DETECTOR_CONFIG, withThreshold } from "@kairos/detect";
import { type Mandate, mandateId, paise, slice } from "@kairos/domain";
import { sealMandate } from "@kairos/terminus";
import { describe, expect, it } from "vitest";
import { ConsoleRun } from "./run.js";
import { type Scenario, scenarioNamed, scenarios } from "./scenario.js";
import { createConsole } from "./server.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const START = 1_756_000_000_000;
const SECRET = "console-test-secret-that-is-long-enough";

const DETECTOR = { ...withThreshold(DEFAULT_DETECTOR_CONFIG, 12), rollup: true };

function mandateFor(scenario: Scenario): Mandate {
  return sealMandate(
    {
      id: mandateId("mnd_console_test"),
      merchantId: "test",
      campaignId: scenario.name,
      budgetPaise: paise(scenario.budgetPaise),
      maxActionCostPaise: paise(300),
      maxInFlight: 3,
      reservationTtlMs: 30 * MINUTE,
      contactCap: { limit: 3, windowMs: 7 * DAY },
      quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 },
      allowedActions: ["steer", "retry", "contact-sms", "contact-whatsapp", "contact-email"],
      validFrom: scenario.simulator.startAt - DAY,
      validUntil: scenario.simulator.startAt + 120 * DAY,
      killSwitch: scenario.killSwitch,
    },
    SECRET,
  );
}

function runFor(name: string): ConsoleRun {
  const scenario = scenarioNamed(name, START);
  if (scenario === null) throw new Error(`no scenario ${name}`);
  return new ConsoleRun({
    scenario,
    mandate: mandateFor(scenario),
    secret: SECRET,
    detector: DETECTOR,
  });
}

describe("the console run", () => {
  it("says on every response that its numbers are simulated", async () => {
    // A dashboard showing red rails and rupee figures is exactly the artifact that gets
    // screenshotted into a slide, and a screenshot that does not say where its numbers came from is
    // a claim about a real merchant.
    const run = runFor("calm");
    await run.step();
    expect(run.snapshot().provenance.kind).toBe("simulated");
    expect(run.snapshot().provenance.seed).toBeGreaterThan(0);
  });

  it("opens an incident on a rail that really breaks", async () => {
    const run = runFor("issuer-outage");
    await run.runToEnd();
    const incidents = run.snapshot().incidents;
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents.some((i) => i.slice.startsWith("netbanking"))).toBe(true);
  });

  it("reports one HDFC outage at the whole netbanking method, not at HDFC", async () => {
    // Rollup working, and working coarsely. One issuer failing 55% of its traffic drags the
    // method-wide rate up far enough to trip the method-level detector first, so the incident is
    // reported against every netbanking bank rather than the one that broke. The detection study
    // measures this: the right altitude is chosen 61% of the time, and this is one of the other
    // 39%. Asserted rather than worked around, because a console showing the detector's real
    // altitude is more useful than one that quietly corrects it.
    const run = runFor("issuer-outage");
    await run.runToEnd();
    const [incident] = run.snapshot().incidents;
    expect(incident?.slice).toBe("netbanking||");
  });

  it("measures detection latency from the changepoint, not from the alarm", async () => {
    // Measuring from the moment the detector noticed would make every detector instantaneous.
    const run = runFor("issuer-outage");
    await run.runToEnd();
    const [incident] = run.snapshot().incidents;
    if (incident === undefined) throw new Error("expected an incident");
    expect(incident.detectionLatencyMs).not.toBeNull();
    expect(incident.detectionLatencyMs ?? 0).toBeGreaterThan(0);
  });

  it("still shows the incident open hours after the rail recovered", async () => {
    // **This asserts a defect, deliberately.** The `issuer-outage` scenario's rail is healthy again
    // about 81 minutes in, and the incident is still open at the end of the four-hour run. Measured
    // over a longer window it resolves at about +442 minutes — a resolution latency near six hours
    // for an outage that lasted thirty-five minutes, against a detection latency of about three.
    //
    // The cause is the shape of a one-sided CUSUM. The statistic accumulates while the observed
    // rate exceeds the frozen baseline and decays only while it is *below* it; a rail that returns
    // to exactly its baseline produces a drift of roughly zero, so the statistic plateaus near its
    // peak and drifts down on noise alone. Clearing needs it under 3.6 and it is still above 10
    // three hours later.
    //
    // It matters beyond cosmetics: steering keeps diverting traffic off a healthy rail for as long
    // as the incident is open, and the recovery arm's whole timing claim is that it retries on the
    // recovery edge. Recorded as open question 19 rather than patched here, because changing the
    // detector re-baselines every published measurement.
    const run = runFor("issuer-outage");
    await run.runToEnd();
    const [incident] = run.snapshot().incidents;
    expect(incident?.closedAt).toBeNull();
  });

  it("raises no incident on a quiet afternoon", async () => {
    // The most important scenario in the file and the least interesting to watch. A detector is
    // judged by what it does when nothing is wrong.
    const run = runFor("calm");
    await run.runToEnd();
    expect(run.snapshot().incidents).toHaveLength(0);
  });

  it("shows the kill switch as the state it is in, and keeps detecting", async () => {
    // Detection is not an action and is not gated. What the switch stops is spending.
    const run = runFor("kill-switch");
    await run.runToEnd();
    const snapshot = run.snapshot();
    const killSwitch = snapshot.bounds.find((b) => b.axis === "kill-switch");
    expect(killSwitch?.current).toBe("ON");
    expect(snapshot.incidents.length).toBeGreaterThan(0);
  });

  it("re-verifies the audit chain on every read rather than remembering it", async () => {
    const run = runFor("issuer-outage");
    await run.runToEnd();
    expect(run.snapshot().ledger.verified).toBe(true);
  });

  it("reproduces exactly, because a demo that improvises cannot be argued with", async () => {
    const a = runFor("issuer-outage");
    const b = runFor("issuer-outage");
    await a.runToEnd();
    await b.runToEnd();
    expect(JSON.stringify(a.snapshot().incidents)).toBe(JSON.stringify(b.snapshot().incidents));
  });
});

describe("the console API", () => {
  it("lists scenarios with what each one is for", async () => {
    const { app } = createConsole({
      mandateFor,
      secret: SECRET,
      detector: DETECTOR,
      startAt: START,
    });
    const response = await app.inject({ method: "GET", url: "/api/scenarios" });
    const body = response.json() as { available: { name: string; watchFor: string }[] };

    expect(response.statusCode).toBe(200);
    expect(body.available.length).toBeGreaterThan(3);
    for (const entry of body.available) expect(entry.watchFor.length).toBeGreaterThan(20);
  });

  it("lets the client drive the clock", async () => {
    // The client steps rather than the server running a timer, so a recording can be paced by hand
    // and a test can assert on tick N without waiting for it.
    const { app } = createConsole({
      mandateFor,
      secret: SECRET,
      detector: DETECTOR,
      startAt: START,
    });
    const before = (await app.inject({ method: "GET", url: "/api/snapshot" })).json() as {
      provenance: { at: number };
    };
    const after = (
      await app.inject({ method: "POST", url: "/api/step", payload: { ticks: 4 } })
    ).json() as { provenance: { at: number } };

    expect(after.provenance.at).toBe(before.provenance.at + 4 * ConsoleRun.tickMs);
  });

  it("caps a single step so one request cannot run the whole scenario", async () => {
    const { app } = createConsole({
      mandateFor,
      secret: SECRET,
      detector: DETECTOR,
      startAt: START,
    });
    const after = (
      await app.inject({ method: "POST", url: "/api/step", payload: { ticks: 10_000 } })
    ).json() as { provenance: { at: number } };
    expect(after.provenance.at).toBeLessThanOrEqual(START + 60 * ConsoleRun.tickMs);
  });

  it("refuses an unknown scenario and says what it has", async () => {
    const { app } = createConsole({
      mandateFor,
      secret: SECRET,
      detector: DETECTOR,
      startAt: START,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/scenario",
      payload: { name: "does-not-exist" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { available: string[] }).available).toContain("calm");
  });

  it("answers 501 for an explanation when no model is configured", async () => {
    // Distinguished from an error: the console runs without a provider on purpose, and a route that
    // is unavailable is not a route that failed.
    const { app } = createConsole({
      mandateFor,
      secret: SECRET,
      detector: DETECTOR,
      startAt: START,
    });
    const response = await app.inject({ method: "GET", url: "/api/explain/cas_1" });
    expect(response.statusCode).toBe(501);
  });
});

describe("the scenarios themselves", () => {
  it("includes one where nothing happens and one where everything is refused", () => {
    const names = scenarios(START).map((s) => s.name);
    expect(names).toContain("calm");
    expect(names).toContain("kill-switch");
    expect(names).toContain("budget-exhaustion");
  });

  it("degrades a rail the simulator actually models", () => {
    // A scenario naming a slice no profile carries would produce a run in which nothing ever
    // happens, and would look like a detector failure rather than a configuration error.
    const modelled = new Set(
      scenarios(START)[0]?.simulator.profiles.map(
        (p) => `${p.slice.method}:${p.slice.issuer ?? ""}`,
      ),
    );
    for (const scenario of scenarios(START)) {
      for (const degradation of scenario.simulator.degradations) {
        const key = `${degradation.slice.method}:${degradation.slice.issuer ?? ""}`;
        expect(`${scenario.name} degrades ${key}`).toSatisfy(() => modelled.has(key));
      }
    }
  });

  it("gives the budget-exhaustion scenario a budget it can actually exhaust", () => {
    const scenario = scenarioNamed("budget-exhaustion", START);
    const ordinary = scenarioNamed("issuer-outage", START);
    expect(scenario?.budgetPaise ?? 0).toBeLessThan(ordinary?.budgetPaise ?? 0);
  });

  it("names a slice the domain can construct", () => {
    expect(() => slice("netbanking", "hdfc")).not.toThrow();
  });
});
