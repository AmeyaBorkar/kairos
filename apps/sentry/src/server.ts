import { DEFAULT_DETECTOR_CONFIG, DetectionEngine, incidentFrom } from "@kairos/detect";
import {
  type Attempt,
  attemptId,
  type CustomerRef,
  customerRef,
  type Mandate,
  orderId,
  PAYMENT_METHODS,
  type PaymentMethod,
  paise,
  slice,
  sliceKey,
} from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import {
  DEFAULT_STEERING_CONFIG,
  isNeutral,
  RailWindow,
  type SteeringConfig,
  SteeringController,
} from "@kairos/policy";
import { defaultCheckout, renderCheckout } from "@kairos/razorpay";
import { type Clock, systemClock, Terminus } from "@kairos/terminus";
import Fastify, { type FastifyInstance } from "fastify";
import { MemoryStore } from "throttlekit";
import { z } from "zod";
import { ATTEMPT_BATCH } from "./schema.js";

export interface SentryOptions {
  readonly mandate: Mandate;
  readonly secret: string;
  /** The merchant's own method order. Kairos perturbs it; it never replaces it. */
  readonly defaultSequence?: readonly PaymentMethod[];
  readonly steering?: SteeringConfig;
  readonly clock?: Clock;
  /**
   * How often steering is re-decided, at most.
   *
   * Re-deciding is driven by ingest rather than by a timer, so a `sentry` receiving no traffic
   * makes no decisions — which is correct, because it also has no evidence.
   */
  readonly tickMs?: number;
  /**
   * The budget for answering a plan request.
   *
   * The hot path is advisory. Everything that can go wrong here — a slow store, a bug, a garbage
   * collection at the wrong moment — has to resolve to the merchant's own configuration rather than
   * to an error, because the failure mode of a payment-health tool must never be "no payments".
   */
  readonly planBudgetMs?: number;
  readonly logger?: boolean;
}

const DEFAULT_SEQUENCE: readonly PaymentMethod[] = [...PAYMENT_METHODS];

export interface Sentry {
  readonly app: FastifyInstance;
  readonly ledger: MemoryLedger;
  /** Steers currently in force, for tests and for the console. */
  directives(): ReturnType<SteeringController["directives"]>;
}

/**
 * The service that turns an outcome stream into a checkout configuration.
 *
 * Stateless in the sense that matters: every bound it enforces lives in the shared store through
 * Terminus, so a second instance shares the blast radius rather than doubling it. What it holds in
 * memory — detector state, the rail window — is an estimate that rebuilds itself from traffic, and
 * an instance that restarts simply steers nothing until it has seen enough to have an opinion.
 * That is the right failure mode: a cold `sentry` is indistinguishable from no `sentry`.
 */
export function createSentry(options: SentryOptions): Sentry {
  const clock = options.clock ?? systemClock;
  const config = options.steering ?? DEFAULT_STEERING_CONFIG;
  const sequence = options.defaultSequence ?? DEFAULT_SEQUENCE;
  const tickMs = options.tickMs ?? 15_000;
  const planBudgetMs = options.planBudgetMs ?? 50;

  const ledger = new MemoryLedger();
  const engine = new DetectionEngine({ ...DEFAULT_DETECTOR_CONFIG, rollup: true });
  const window = new RailWindow();
  const terminus = new Terminus({
    mandate: options.mandate,
    secret: options.secret,
    store: new MemoryStore({ sweepIntervalMs: 0 }),
    audit: ledger,
    actor: "sentry",
    clock,
  });
  const controller = new SteeringController({ terminus, config, clock, defaultSequence: sequence });

  let health = window.snapshot(clock.now());
  let nextTick = 0;

  const app = Fastify({ logger: options.logger ?? false });

  /**
   * Re-decide steering, at most once per tick.
   *
   * Driven by ingest rather than a timer so the service has no background work and no clock of its
   * own to get wrong in a test.
   */
  async function maybeAffirm(now: number): Promise<void> {
    if (now < nextTick) return;
    nextTick = now + tickMs;
    health = window.snapshot(now);
    await controller.affirm(engine.openIncidents().map(incidentFrom), health);
  }

  app.post("/outcomes", async (request, reply) => {
    const parsed = ATTEMPT_BATCH.safeParse(request.body);
    if (!parsed.success) {
      // Zod at the boundary, and a rejection rather than a coercion. An outcome stream that is not
      // the shape we expect is evidence about the integration, not about the rails.
      return reply.code(400).send({ error: "invalid batch", detail: z.treeifyError(parsed.error) });
    }

    let accepted = 0;
    let opened = 0;
    let latest = clock.now();

    for (const raw of parsed.data.attempts) {
      const attempt = toAttempt(raw);
      for (const event of engine.observe(attempt)) {
        if (event.kind === "opened") opened++;
      }
      window.observe(attempt.slice, attempt.status === "failed", attempt.at, raw.arm ?? "treated");
      latest = Math.max(latest, attempt.at);
      accepted++;
    }

    await maybeAffirm(latest);
    return reply.send({ accepted, opened, incidents: engine.openIncidents().length });
  });

  /**
   * The hot path.
   *
   * Never fails, never blocks, never returns anything a checkout cannot render. A customer
   * reference that does not parse, a plan that throws, a budget overrun — all of them resolve to
   * the merchant's own configuration, which is exactly what the checkout would have used had Kairos
   * never been deployed.
   */
  app.get("/plan/:customer", async (request, reply) => {
    const started = clock.now();
    const fallback = { config: defaultCheckout(sequence), steered: false, reason: "default" };

    let ref: CustomerRef;
    try {
      ref = customerRef((request.params as { customer: string }).customer);
    } catch {
      return reply.send({ ...fallback, reason: "unrecognised customer reference" });
    }

    try {
      const plan = controller.planFor(ref, health);
      const elapsed = clock.now() - started;
      if (elapsed > planBudgetMs) {
        return reply.send({ ...fallback, reason: `plan exceeded ${planBudgetMs}ms budget` });
      }

      const rendered = renderCheckout(plan, sequence);
      return reply.send({
        config: rendered.config,
        steered: !isNeutral(plan),
        applied: plan.applied,
        heldOutOf: plan.heldOutOf,
        diagnostics: rendered.diagnostics.map((d) => ({
          slice: sliceKey(d.slice),
          reason: d.reason,
        })),
        reason: isNeutral(plan) ? "nothing in force" : "steering",
      });
    } catch {
      // Deliberately swallowed. Whatever went wrong, the checkout gets a page it can render.
      return reply.send({ ...fallback, reason: "plan unavailable" });
    }
  });

  app.get("/health", async (_request, reply) => {
    const now = clock.now();
    const snapshot = window.snapshot(now);
    return reply.send({
      at: now,
      rails: snapshot.observations
        .map((o) => ({
          slice: sliceKey(o.slice),
          share: Number(o.share.toFixed(2)),
          failureRate: Number(o.failureRate.toFixed(4)),
        }))
        .sort((a, b) => b.share - a.share),
      incidents: engine.openIncidents().map((i) => ({
        id: incidentFrom(i).id,
        slice: sliceKey(i.slice),
        onsetAt: i.onsetAt,
        detectedAt: i.detectedAt,
        baselineRate: Number(i.baselineRate.toFixed(4)),
        peakRate: Number(i.peakRate.toFixed(4)),
      })),
      steering: controller.directives().map((d) => ({
        incident: d.incident,
        slice: sliceKey(d.slice),
        lever: d.lever,
        reason: d.reason,
        expiresAt: d.expiresAt,
      })),
      ledger: { length: ledger.length, head: ledger.head },
    });
  });

  /** The audit trail, and proof it has not been altered. */
  app.get("/ledger", async (_request, reply) => {
    return reply.send({
      verification: ledger.verify(),
      recent: ledger.records.slice(-50),
    });
  });

  app.addHook("onClose", async () => {
    await controller.revokeAll("sentry shutting down");
  });

  return { app, ledger, directives: () => controller.directives() };
}

type RawAttempt = z.infer<typeof ATTEMPT_BATCH>["attempts"][number];

function toAttempt(raw: RawAttempt): Attempt {
  return {
    id: attemptId(raw.id),
    orderId: orderId(raw.orderId),
    customer: customerRef(raw.customer),
    amount: paise(raw.amountPaise),
    slice: slice(raw.method, raw.issuer ?? null, raw.instrument ?? null),
    status: raw.status,
    failure: null,
    at: raw.at,
  };
}
