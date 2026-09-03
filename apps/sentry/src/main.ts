import { mandateId, paise } from "@kairos/domain";
import { DEFAULT_STEERING_CONFIG } from "@kairos/policy";
import { scaledClock, sealMandate } from "@kairos/terminus";
import { backing } from "./backing.js";
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

/**
 * How fast this process believes time moves.
 *
 * One, unless a demonstration says otherwise. The sentry has to agree with whatever is feeding it:
 * an outcome stream stamped in an accelerated timeline arriving at a service on a real clock puts
 * every observation in the future, and a detector whose window contains nothing detects nothing.
 *
 * Unconditional here, unlike in the worker. The only thing this process can do is reorder a
 * checkout, which reaches no one and spends nothing, so there is no combination of speed and
 * delivery worth refusing.
 */
function clockSpeed(): number {
  const raw = process.env["KAIROS_CLOCK_SPEED"];
  if (raw === undefined) return 1;
  const speed = Number(raw);
  if (!Number.isFinite(speed) || speed < 1 || speed > 3600) {
    process.stderr.write(
      `KAIROS_CLOCK_SPEED must be between 1 and 3600, received ${JSON.stringify(raw)}\n`,
    );
    process.exit(1);
  }
  return speed;
}

const speed = clockSpeed();
const persistence = await backing();

const webhookSecret = process.env["RAZORPAY_WEBHOOK_SECRET"] || undefined;
const piiKey = process.env["LEDGER_PII_HASH_KEY"] || undefined;
const { app } = createSentry({
  mandate,
  secret,
  logger: true,
  clock: scaledClock(speed),
  store: persistence.store,
  killSwitch: persistence.killSwitch,
  // Mounted only when both are present. The route needs a secret to verify a delivery and a
  // separate key to pseudonymise a contact, and a route missing either would be one that either
  // trusts anything or leaks a phone number.
  ...(webhookSecret !== undefined && piiKey !== undefined
    ? { razorpayWebhook: { secret: webhookSecret, piiKey } }
    : {}),
});
const port = Number(process.env["PORT"] ?? 8080);

await app.listen({ port, host: "0.0.0.0" });
app.log.info(
  {
    bounds: persistence.name,
    fleet: persistence.name === "postgres",
    stopSwitch: persistence.name === "postgres",
    razorpayWebhook:
      webhookSecret !== undefined && piiKey !== undefined
        ? "POST /webhooks/razorpay"
        : "not mounted — needs RAZORPAY_WEBHOOK_SECRET and LEDGER_PII_HASH_KEY",
    ...(speed === 1 ? {} : { clock: `${speed}x` }),
  },
  "sentry",
);

// A steer is a held reservation, so a clean shutdown hands every one of them back rather than
// leaving checkouts steered until the TTL catches up.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => persistence.close())
      .then(() => process.exit(0));
  });
}
