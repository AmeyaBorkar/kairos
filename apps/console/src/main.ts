/**
 * The console process.
 *
 * Reads its configuration from the environment, builds a mandate per scenario, and serves the API.
 * Nothing here is clever; the interesting decisions are in `run.ts` and `scenario.ts`.
 *
 * ## The secret is required and the API key is not
 *
 * A mandate is HMAC-sealed, so the console needs `KAIROS_MANDATE_SECRET` to construct one at all —
 * without it there is no authority to display and refusing to start is honest. `GOOGLE_API_KEY` is
 * optional: everything the console shows comes from components that need no provider, and only
 * `/api/explain` does. A dashboard that would not start without a model credential would make the
 * whole demo depend on a free tier's daily quota.
 */

import { DEFAULT_DETECTOR_CONFIG, withThreshold } from "@kairos/detect";
import { type Mandate, mandateId, paise } from "@kairos/domain";
import type { Explainer } from "@kairos/reason";
import { configFromProcess, geminiReasoners } from "@kairos/reasoner-gemini";
import { sealMandate } from "@kairos/terminus";
import type { Scenario } from "./scenario.js";
import { createConsole } from "./server.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The threshold the detection study chose, not a rounder number that reads better. */
const THRESHOLD = 12;

function mandateFor(secret: string): (scenario: Scenario) => Mandate {
  return (scenario) =>
    sealMandate(
      {
        id: mandateId("mnd_console"),
        merchantId: "console",
        campaignId: scenario.name,
        budgetPaise: paise(scenario.budgetPaise),
        maxActionCostPaise: paise(300),
        // Three steers at once, which is the blast-radius bound from ARCHITECTURE §6 rather than a
        // number chosen to make the demo look busy.
        maxInFlight: 3,
        reservationTtlMs: 30 * MINUTE,
        contactCap: { limit: 3, windowMs: 7 * DAY },
        quietHours: { startMinute: 21 * 60, endMinute: 8 * 60, offsetMinutes: 330 },
        allowedActions: ["steer", "retry", "contact-sms", "contact-whatsapp", "contact-email"],
        validFrom: scenario.simulator.startAt - DAY,
        validUntil: scenario.simulator.startAt + 120 * DAY,
        killSwitch: scenario.killSwitch,
      },
      secret,
    );
}

function explainerOrNull(): Explainer | null {
  // Constructed only if a key is present, and never fatal. The console's job is to show the system,
  // and the system does not need a model to run.
  try {
    if ((process.env["GOOGLE_API_KEY"] ?? "").length === 0) return null;
    return geminiReasoners({ config: configFromProcess() }).explainer;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const secret = process.env["KAIROS_MANDATE_SECRET"] ?? "";
  if (secret.length < 32) {
    process.stderr.write(
      "set KAIROS_MANDATE_SECRET to at least 32 characters. A mandate is HMAC-sealed, so without\n" +
        "one there is no authority to display and starting anyway would be theatre.\n",
    );
    process.exit(1);
  }

  const port = Number(process.env["PORT"] ?? 8788);
  const explainer = explainerOrNull();

  const { app } = createConsole({
    mandateFor: mandateFor(secret),
    secret,
    detector: { ...withThreshold(DEFAULT_DETECTOR_CONFIG, THRESHOLD), rollup: true },
    // Scenarios start "now" so a console does not display yesterday's timestamps, which looks
    // broken in a way that distracts from everything else on the page.
    startAt: Date.now(),
    initialScenario: process.env["KAIROS_SCENARIO"] ?? "issuer-outage",
    explainer,
  });

  await app.listen({ port, host: "0.0.0.0" });
  process.stdout.write(
    `console on :${port} — explanations ${explainer === null ? "disabled (no GOOGLE_API_KEY)" : "enabled"}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
