#!/usr/bin/env node
/**
 * Record a run of the real console, and compact it into what the site replays.
 *
 * A published page cannot reach `apps/console`'s server: a reader is not running this repository,
 * and a static host has nothing to proxy to. So the site ships a recording — and it has to be a
 * recording of the actual kernel, because inventing plausible-looking audit records is precisely the
 * thing the rest of this project spends its argument refusing to do.
 *
 * Nothing here derives or adjusts a value. Floats are rounded to the precision the interface
 * displays, static fields are hoisted out of the per-frame arrays, and ledger entries — which repeat
 * in every frame's window — are stored once against the frame they first appear in.
 *
 *   pnpm --filter @kairos/console run build     # the recording needs the console built
 *   pnpm --filter @kairos/site run capture
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConsoleRun } from "@kairos/console/run.js";
import { scenarioNamed } from "@kairos/console/scenario.js";
import { DEFAULT_DETECTOR_CONFIG, withThreshold } from "@kairos/detect";
import { mandateId, paise } from "@kairos/domain";
import { sealMandate } from "@kairos/terminus";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "assets", "data", "console-run.json");

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Pinned rather than `Date.now()`, and this is a correctness requirement.
 *
 * Incident identifiers are derived from the moment they open, so a capture starting at the wall
 * clock produces a different payload on every run — a diff that is entirely noise, on a file that is
 * committed. Pinned, re-running the capture against unchanged code produces byte-identical output,
 * which is what makes a change to it worth reading.
 */
const START = 1_756_000_000_000;

/** Capture-only. The recording holds no authority; it is a transcript of one that did. */
const SECRET = "capture-only-secret-not-used-in-production-0123456789";

/** 30s per step, so 470 steps sits just inside each scenario's four hours of traffic. */
const STEPS = 470;
/** Keep every tenth, which is a frame per five simulated minutes — enough to scrub, small enough to ship. */
const EVERY = 10;

const NAMES = [
  "calm",
  "issuer-outage",
  "invisible-issuer",
  "two-at-once",
  "budget-exhaustion",
  "kill-switch",
];

const STATES = ["healthy", "watching", "degraded"];
const STEERS = ["none", "demoted", "suppressed"];
const round = (v, n) => Number(v.toFixed(n));

function mandateFor(scenario) {
  return sealMandate(
    {
      id: mandateId("mnd_console"),
      merchantId: "console",
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

async function record(name) {
  const scenario = scenarioNamed(name, START);
  if (scenario === null) throw new Error(`unknown scenario ${name}`);

  const run = new ConsoleRun({
    scenario,
    mandate: mandateFor(scenario),
    secret: SECRET,
    detector: { ...withThreshold(DEFAULT_DETECTOR_CONFIG, 12), rollup: true },
  });

  const snapshots = [];
  for (let i = 0; i < STEPS; i += 1) {
    await run.step();
    if (i % EVERY === 0) snapshots.push(run.snapshot());
  }
  snapshots.push(run.snapshot());

  const first = snapshots[0];
  const seen = new Set();
  const ledger = [];

  /*
   * Rails come and go: one with no attempts in the current window is absent from the snapshot
   * entirely, so the array is not a stable list and its indices mean nothing across frames. Every
   * reading therefore carries an index into a dictionary of every rail the run ever saw. The first
   * version of this keyed by position and silently mislabelled — or dropped — every rail that
   * appeared after the opening frame.
   */
  const railIndex = new Map();
  const railKeys = [];
  for (const snapshot of snapshots) {
    for (const rail of snapshot.rails) {
      if (railIndex.has(rail.key)) continue;
      railIndex.set(rail.key, railKeys.length);
      railKeys.push([rail.key, rail.method, rail.issuer]);
    }
  }

  const frames = snapshots.map((snapshot, i) => {
    // `recent` is a window, so the same record appears in many frames. Keep the first sighting only;
    // the player filters on it, which is what makes scrubbing backwards genuinely un-write records.
    for (const entry of [...snapshot.ledger.recent].reverse()) {
      const key = `${entry.at}|${entry.action}|${entry.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ledger.push([i, entry.at, entry.action, entry.allowed ? 1 : 0, entry.reason, entry.binding]);
    }
    return {
      at: snapshot.provenance.at,
      rails: snapshot.rails.map((r) => [
        railIndex.get(r.key),
        r.attempts,
        round(r.failureRate, 3),
        STATES.indexOf(r.state),
        round(r.statistic, 2),
        STEERS.indexOf(r.steer),
      ]),
      inc: snapshot.incidents.map((x) => [
        x.id,
        x.slice,
        x.openedAt,
        x.closedAt,
        x.detectionLatencyMs,
        round(x.peakFailureRate, 3),
        x.casualties,
      ]),
      bounds: snapshot.bounds.map((b) => [round(b.utilisation, 3), b.refusals, b.current]),
      records: snapshot.ledger.records,
      verified: snapshot.ledger.verified ? 1 : 0,
    };
  });

  return {
    premise: scenario.premise,
    watchFor: scenario.watchFor,
    budgetPaise: scenario.budgetPaise,
    seed: first.provenance.seed,
    threshold: first.rails[0]?.threshold ?? 12,
    railKeys,
    boundAxes: first.bounds.map((b) => [b.axis, b.limit]),
    ledger,
    frames,
  };
}

const out = { tickMs: 30_000, keptEvery: EVERY, scenarios: {} };
for (const name of NAMES) {
  out.scenarios[name] = await record(name);
  const s = out.scenarios[name];
  const last = s.frames[s.frames.length - 1];
  process.stderr.write(
    `${name.padEnd(18)} frames=${String(s.frames.length).padStart(3)}  ` +
      `records=${String(last.records).padStart(4)}  ledger=${String(s.ledger.length).padStart(4)}\n`,
  );
}

const json = JSON.stringify(out);
writeFileSync(OUT, json);
process.stderr.write(`wrote ${OUT} (${Math.round(json.length / 1024)} KB)\n`);
