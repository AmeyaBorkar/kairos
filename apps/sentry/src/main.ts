import { mandateId, paise } from "@kairos/domain";
import { DEFAULT_STEERING_CONFIG } from "@kairos/policy";
import { sealMandate } from "@kairos/terminus";
import { createSentry } from "./server.js";

const DAY = 86_400_000;

/**
 * The signing key.
 *
 * Refused rather than defaulted. A development fallback here would be a key that ships to
 * production the first time someone forgets an environment variable, and every mandate signed with
 * a publicly-known key is a mandate anyone can forge.
 */
const secret = process.env["KAIROS_MANDATE_SECRET"];
if (secret === undefined || secret.length < 32) {
  process.stderr.write(
    "KAIROS_MANDATE_SECRET must be set to at least 32 characters. Refusing to start.\n",
  );
  process.exit(1);
}

const now = Date.now();
const config = DEFAULT_STEERING_CONFIG;

const mandate = sealMandate(
  {
    id: mandateId("mnd_steering_demo"),
    merchantId: process.env["KAIROS_MERCHANT_ID"] ?? "demo",
    campaignId: "steering",
    budgetPaise: paise(100_000),
    maxActionCostPaise: paise(1),
    maxInFlight: config.maxConcurrentSteers,
    reservationTtlMs: config.maxIncidentDurationMs,
    contactCap: { limit: 3, windowMs: 7 * DAY },
    quietHours: null,
    allowedActions: ["steer"],
    validFrom: now - DAY,
    validUntil: now + 30 * DAY,
    killSwitch: false,
  },
  secret,
);

const { app } = createSentry({ mandate, secret, logger: true });
const port = Number(process.env["PORT"] ?? 8080);

await app.listen({ port, host: "0.0.0.0" });

// A steer is a held reservation, so a clean shutdown hands every one of them back rather than
// leaving checkouts steered until the TTL catches up.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
