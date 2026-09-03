import { readFileSync } from "node:fs";
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
import { type CheckoutConfig, defaultCheckout, renderCheckout } from "@kairos/razorpay";
import {
  type Clock,
  type KillSwitch,
  openKillSwitch,
  systemClock,
  Terminus,
} from "@kairos/terminus";
import Fastify, { type FastifyInstance } from "fastify";
import { MemoryStore, type Store } from "throttlekit";
import { z } from "zod";
import { renderSentryMetrics } from "./metrics.js";
import { registerRazorpayWebhook } from "./razorpay-webhook.js";
import { ATTEMPT_BATCH, PLAN_REQUEST } from "./schema.js";

export interface SentryOptions {
  readonly mandate: Mandate;
  readonly secret: string;
  /** The merchant's own method order. Kairos perturbs it; it never replaces it. */
  readonly defaultSequence?: readonly PaymentMethod[];
  readonly steering?: SteeringConfig;
  readonly clock?: Clock;
  /**
   * Where the bounds this service enforces actually live.
   *
   * Defaults to memory, which makes a single instance correct and a second instance a liar: the
   * blast-radius cap is `maxInFlight` inside Terminus, and two sentries with a store each hold
   * three steers *each*. Supply a shared store and the cap is one cap, taken by the same atomic
   * step, however many instances are running.
   */
  readonly store?: Store;
  /**
   * The out-of-band stop, if there is one to consult.
   *
   * Defaults to the open switch. A sentry's only power is to reorder a checkout, so this matters
   * less here than in the worker — but an operator stopping a campaign means all of it, and a
   * steering directive that survived the stop would be the one piece of Kairos still acting.
   */
  readonly killSwitch?: KillSwitch;
  /**
   * Credentials for the inbound Razorpay webhook, or absent to leave that route unmounted.
   *
   * Absent by default and unmounted rather than mounted-and-rejecting, because an endpoint that
   * exists without a secret is an endpoint somebody will eventually point a gateway at and wonder
   * why nothing arrives. `piiKey` is separate from the mandate secret on purpose: it turns a phone
   * number into a reference, and the blast radius of losing it is different.
   */
  readonly razorpayWebhook?: { readonly secret: string; readonly piiKey: string };
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

/** One suppressed instrument, in Kairos vocabulary rather than any gateway's. */
export interface SuppressedInstrument {
  /** The slice key, round-trippable through `parseSliceKey`. */
  readonly key: string;
  readonly method: PaymentMethod;
  readonly issuer: string | null;
  readonly instrument: string | null;
}

/**
 * What a checkout is told.
 *
 * Two readings of one decision. `sequence`, `suppress` and `demote` are the decision itself,
 * in no gateway's vocabulary; `checkout` is the same thing already shaped as the `config` object
 * Razorpay Checkout is handed. A merchant renders whichever they can act on, and neither is
 * derived by the caller — deriving one from the other is where a translation bug would live.
 *
 * Every field is populated on every response, including the fallbacks, so a caller never has to
 * branch on presence. The honest signal is `steered`: false means this response changes nothing
 * about the page, whether because nothing is wrong, because this customer is a control, or because
 * something in Kairos failed and it declined to guess.
 */
export interface PlanResponse {
  /** The method order to render, most preferred first. Exhaustive over what was offered. */
  readonly sequence: readonly PaymentMethod[];
  readonly suppress: readonly SuppressedInstrument[];
  readonly demote: readonly PaymentMethod[];
  readonly steered: boolean;
  /**
   * The arm to report back on this customer's outcome.
   *
   * Echoed verbatim into `POST /outcomes`. Answering it here rather than asking the merchant to
   * work it out is what keeps the holdout honest at integrations that have never heard of one.
   */
  readonly arm: "treated" | "control";
  readonly applied: readonly string[];
  readonly heldOutOf: readonly string[];
  /** The Razorpay Checkout `config` object, ready to pass through unchanged. */
  readonly checkout: CheckoutConfig;
  /** Steers that could not be expressed as a checkout instrument, and why. */
  readonly diagnostics: readonly { readonly slice: string; readonly reason: string }[];
  /**
   * How long this response may be cached.
   *
   * Steering is re-decided at most once a tick, so anything fresher is a request the service did
   * not need to answer. It is a hint and not a contract: a caller that ignores it is merely
   * spending latency, never correctness.
   */
  readonly maxAgeMs: number;
  /** Why this response says what it says, in words. Always present. */
  readonly reason: string;
}

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
    store: options.store ?? new MemoryStore({ sweepIntervalMs: 0 }),
    audit: ledger,
    actor: "sentry",
    clock,
    killSwitch: options.killSwitch ?? openKillSwitch,
  });
  const controller = new SteeringController({ terminus, config, clock, defaultSequence: sequence });

  let health = window.snapshot(clock.now());
  let nextTick = 0;

  // Counted here rather than in a metrics library, so the numbers a dashboard reads are the same
  // increments the routes below perform, with nothing holding a second copy that could disagree.
  const startedAt = clock.now();
  const counts = { ingested: 0, rejected: 0, plans: 0, fallbacks: 0 };

  const app = Fastify({ logger: options.logger ?? false });

  /**
   * Keep the bytes as well as the parse.
   *
   * Razorpay signs what it sent, and `JSON.parse` then `JSON.stringify` does not reproduce it:
   * key order, unicode escapes and number formatting all move. A verifier handed a re-serialised
   * body rejects legitimate webhooks in a way that looks like a signature problem, and the usual
   * response to that is to stop verifying. So the raw string rides along on the request.
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = body as string;
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  if (options.razorpayWebhook !== undefined) {
    registerRazorpayWebhook(app, {
      secret: options.razorpayWebhook.secret,
      piiKey: options.razorpayWebhook.piiKey,
      now: () => clock.now(),
      observe: (attempt) => {
        // The same two calls `/outcomes` makes, in the same order, so a real webhook and a
        // reported batch reach the detector by one path rather than two that could drift.
        engine.observe(attempt);
        window.observe(attempt.slice, attempt.status === "failed", attempt.at, "treated");
      },
    });
  }

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
    const outcomes = await controller.affirm(engine.openIncidents().map(incidentFrom), health);

    // Said out loud rather than discarded. Every one of these is an answer to "there is clearly an
    // incident, so why is the checkout unchanged?" — and until now the only way to find out was to
    // read the policy source. A decision not to act is a decision, and the operator who has to
    // defend it is the one who most needs to have seen it.
    for (const outcome of outcomes) {
      app.log.info(
        {
          incident: outcome.incident,
          status: outcome.status,
          detail: outcome.detail,
          ...(outcome.evaluation === null
            ? {}
            : { lever: outcome.evaluation.lever, slice: sliceKey(outcome.evaluation.slice) }),
        },
        "steering",
      );
    }
  }

  app.post("/outcomes", async (request, reply) => {
    const parsed = ATTEMPT_BATCH.safeParse(request.body);
    if (!parsed.success) {
      // Zod at the boundary, and a rejection rather than a coercion. An outcome stream that is not
      // the shape we expect is evidence about the integration, not about the rails.
      counts.rejected++;
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

    counts.ingested += accepted;
    await maybeAffirm(latest);
    return reply.send({ accepted, opened, incidents: engine.openIncidents().length });
  });

  /**
   * Turn one customer reference into a plan, or into the merchant's own configuration.
   *
   * The hot path, and the only code in Kairos with a hard latency budget. Never fails, never
   * blocks, never returns anything a checkout cannot render: a reference that does not parse, a
   * plan that throws, a budget overrun — all of them resolve to the merchant's own ordering, which
   * is exactly what the checkout would have used had Kairos never been deployed.
   *
   * Shared by both plan routes so the two cannot drift. A fallback that differed between them
   * would be the worst kind of bug here, because it would only ever appear when something else had
   * already gone wrong.
   */
  function planFor(rawCustomer: string, offered: readonly PaymentMethod[]): PlanResponse {
    const started = clock.now();
    counts.plans++;
    const fallback = (reason: string): PlanResponse => {
      // Counted at the point it is produced, so every route into the fallback is counted once and
      // no future one can be added without being counted. The ratio of these to plans served is
      // the single number that says whether the hot path is healthy.
      counts.fallbacks++;
      return fallbackPlan(reason);
    };
    const fallbackPlan = (reason: string): PlanResponse => ({
      sequence: [...offered],
      suppress: [],
      demote: [],
      steered: false,
      arm: "treated",
      applied: [],
      heldOutOf: [],
      checkout: defaultCheckout(offered),
      diagnostics: [],
      maxAgeMs: tickMs,
      reason,
    });

    let ref: CustomerRef;
    try {
      ref = customerRef(rawCustomer);
    } catch {
      return fallback("unrecognised customer reference");
    }

    try {
      const plan = controller.planFor(ref, health, offered);
      if (clock.now() - started > planBudgetMs) {
        return fallback(`plan exceeded ${planBudgetMs}ms budget`);
      }

      const rendered = renderCheckout(plan, offered);
      return {
        // The plan carries only methods policy has seen; the merchant's remaining methods are
        // appended in the order they were offered, because a reorder that silently drops a method
        // is the failure `renderCheckout` already guards against and this must agree with it.
        sequence: rendered.config.display.sequence as readonly PaymentMethod[],
        suppress: plan.suppress.map((s) => ({
          key: sliceKey(s),
          method: s.method,
          issuer: s.issuer,
          instrument: s.instrument,
        })),
        demote: [...plan.demote],
        steered: !isNeutral(plan),
        // What to echo back on this customer's outcome. A checkout that returns this verbatim gets
        // the holdout analysis right without its author having to know what a holdout is — and
        // getting it wrong is not a small error: a control counted as treated moves the measured
        // lift toward zero with nothing anywhere reporting a fault.
        arm: plan.heldOutOf.length > 0 ? "control" : "treated",
        applied: [...plan.applied],
        heldOutOf: [...plan.heldOutOf],
        checkout: rendered.config,
        diagnostics: rendered.diagnostics.map((d) => ({
          slice: sliceKey(d.slice),
          reason: d.reason,
        })),
        maxAgeMs: tickMs,
        reason: isNeutral(plan) ? "nothing in force" : "steering",
      };
    } catch {
      // Deliberately swallowed. Whatever went wrong, the checkout gets a page it can render.
      return fallback("plan unavailable");
    }
  }

  /**
   * The hot path, for a checkout in any language.
   *
   * A body rather than a path, because the method set is a property of the page being rendered and
   * only the merchant knows it. The response is Razorpay-shaped *and* plain: `checkout` is the
   * `config` object Razorpay Checkout is handed, and `sequence`/`suppress`/`demote` are the same
   * decision with no gateway vocabulary in it, so a merchant on another gateway — or rendering
   * their own method list server-side — can act on it without a translation layer.
   *
   * Always 200. Nothing a merchant can put in this body is worth failing a checkout over, so a
   * body that does not parse is answered with the merchant's own configuration and a `reason`
   * naming the offending field — visible on the first call an integrator makes, and harmless to
   * the customer waiting on the page.
   */
  app.post("/plan", async (request, reply) => {
    const parsed = PLAN_REQUEST.safeParse(request.body);
    if (parsed.success) {
      return reply.send(planFor(parsed.data.customer, parsed.data.sequence ?? sequence));
    }

    // A malformed body is answered, not refused. `POST /outcomes` rejects what it cannot parse
    // because a bad outcome would corrupt the detector's evidence; here there is nothing to
    // corrupt and a customer waiting on a page, so the safest renderable answer wins and the fault
    // is named in `reason` where an integrator will see it on the very first call.
    const raw: unknown = request.body;
    const bare =
      typeof raw === "object" && raw !== null && "customer" in raw
        ? (raw as { customer: unknown }).customer
        : undefined;
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "body"))].join(
      ", ",
    );
    const plan = planFor(typeof bare === "string" ? bare : "", sequence);
    return reply.send({ ...plan, reason: `invalid request (${fields}); ${plan.reason}` });
  });

  /**
   * The same decision, addressed by path.
   *
   * Kept because it is cacheable by anything that speaks HTTP and needs no body — a CDN, a service
   * mesh, a `curl` in a runbook. It cannot carry a method set, so it answers for the sequence this
   * service was configured with.
   */
  app.get("/plan/:customer", async (request, reply) => {
    return reply.send(planFor((request.params as { customer: string }).customer, sequence));
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

  /**
   * The operator view.
   *
   * Everything on it was already available as JSON, and a person reading `curl /ledger | jq` is a
   * person who will not check it twice. The two things a terminal makes hardest are the two worth
   * seeing: whether the audit chain still verifies, and why the checkout was left alone.
   *
   * Read from disk once at construction rather than per request — it is a static file, and a page
   * that re-read itself on every request would be a file handle per curious refresh.
   */
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  app.get("/", async (_request, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .send(page);
  });

  /**
   * The exposition.
   *
   * Text rather than JSON, and on the same port rather than an admin one: this service is already
   * an HTTP surface that answers only reads, and a second listener would be a second thing to
   * expose, firewall and forget about.
   */
  app.get("/metrics", async (_request, reply) => {
    const now = clock.now();
    const verification = ledger.verify();
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(
      renderSentryMetrics({
        outcomesIngested: counts.ingested,
        outcomesRejected: counts.rejected,
        plansServed: counts.plans,
        plansFallenBack: counts.fallbacks,
        openIncidents: engine.openIncidents().length,
        steersInForce: controller.directives().length,
        ledgerLength: ledger.length,
        ledgerValid: verification.valid,
        startedAt,
        now,
        fleet: options.store !== undefined,
        rails: window
          .snapshot(now)
          .observations.map((o) => ({ slice: sliceKey(o.slice), failureRate: o.failureRate })),
      }),
    );
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
