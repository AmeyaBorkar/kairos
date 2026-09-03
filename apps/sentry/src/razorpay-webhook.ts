import { createHmac } from "node:crypto";
import type { Attempt } from "@kairos/domain";
import { type CustomerRef, customerRef } from "@kairos/domain";
import { attemptFrom, memorySeenEvents, paymentFrom, verifyWebhook } from "@kairos/razorpay";
import type { FastifyInstance } from "fastify";

/**
 * Razorpay's own account of what happened, arriving from Razorpay.
 *
 * `POST /outcomes` has always existed and has always been fed by something we wrote. This route is
 * the same detector reading a stream nobody here composed: a real webhook, signed by Razorpay, with
 * real `error_source` / `error_step` / `error_reason` triples in it. The difference is not
 * cosmetic. Every failure code in the simulator was chosen by us, and a classifier evaluated only
 * against codes its authors picked has been marked by the people who set the exam.
 *
 * ## Three things must be true before this changes anything
 *
 * The signature must verify against the **raw** bytes, the event must be recent, and it must be one
 * we have not already handled. `verifyWebhook` enforces all three; this route's only job is to hand
 * it the bytes unmodified and to refuse when it says no. Fastify parses JSON before a handler runs,
 * and `JSON.parse` then `JSON.stringify` does not reproduce what Razorpay signed — key order and
 * unicode escapes both move — so the raw string is captured by a content-type parser and carried on
 * the request.
 *
 * ## Why it answers 200 to a webhook it rejected
 *
 * Razorpay retries a non-2xx for hours. A webhook we refuse is not a webhook that will become
 * acceptable on the fourth delivery — a bad signature stays bad — so retrying it wastes both sides'
 * time and buries the real failures in a queue of hopeless ones. The refusal is in the body and in
 * the log, where somebody can act on it. The one exception is a body we could not read at all,
 * which might be a transport problem worth retrying.
 */
export interface RazorpayWebhookOptions {
  readonly secret: string;
  /**
   * The key that turns a phone number into a reference Kairos may hold.
   *
   * Separate from the mandate's signing key and required rather than defaulted. Everything past the
   * boundary sees a hash, and a missing key here would either crash the route or — much worse —
   * tempt somebody into passing the raw contact through.
   */
  readonly piiKey: string;
  /** How old a delivery may be. Razorpay signs `created_at`, so this cannot be moved by a caller. */
  readonly toleranceMs?: number;
  readonly now: () => number;
  /** What to do with an attempt we managed to read. The detector, in practice. */
  readonly observe: (attempt: Attempt) => void;
  /**
   * Told when a delivery was refused, and why.
   *
   * Worth counting separately from a bad request. A rising refusal rate means a rotated secret or
   * somebody probing the endpoint, and both are invisible if the only evidence is a log line.
   */
  readonly onRefused?: (reason: string) => void;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * A keyed hash, truncated to something a person can read in a log without it being a person.
 *
 * Thirty-two hex characters clears the boundary schema's sixteen-character floor with room to
 * spare, and the floor exists precisely so a raw phone number cannot be mistaken for a reference.
 */
export function pseudonymiser(piiKey: string): (raw: string) => CustomerRef {
  return (raw: string) =>
    customerRef(`rzp_${createHmac("sha256", piiKey).update(raw).digest("hex").slice(0, 32)}`);
}

export function registerRazorpayWebhook(
  app: FastifyInstance,
  options: RazorpayWebhookOptions,
): void {
  const pseudonymise = pseudonymiser(options.piiKey);
  // One process, so one Set. A fleet needs Redis here, and the port exists for that reason: two
  // instances behind a load balancer would each be seeing a redelivery for the first time.
  const seen = memorySeenEvents(options.now);

  app.post("/webhooks/razorpay", async (request, reply) => {
    const raw = request.rawBody;
    if (raw === undefined) {
      // The one case worth a retry: we never got the bytes, which may be transport rather than us.
      return reply.code(400).send({ ok: false, reason: "no raw body" });
    }

    const verdict = await verifyWebhook(
      raw,
      (request.headers["x-razorpay-signature"] as string | undefined) ?? null,
      {
        secret: options.secret,
        toleranceMs: options.toleranceMs ?? 5 * 60_000,
        seen,
        now: options.now,
      },
    );

    if (!verdict.ok) {
      options.onRefused?.(verdict.reason);
      app.log.warn({ reason: verdict.reason }, "razorpay webhook refused");
      return reply.code(200).send({ ok: false, reason: verdict.reason });
    }

    const payment = paymentFrom(request.body);
    if (payment === null) {
      // A signed event we have nothing to do with — a settlement, a subscription. Acknowledged.
      app.log.info({ event: verdict.event }, "razorpay webhook carried no payment");
      return reply.send({ ok: true, event: verdict.event, observed: false });
    }

    const attempt = attemptFrom(payment, { pseudonymise });
    if (attempt === null) {
      // A method Kairos does not model, or fields that did not parse. Dropped rather than guessed:
      // a fabricated observation in a detector whose job is noticing when numbers move is worse
      // than a missing one.
      app.log.info(
        { event: verdict.event, method: payment["method"] },
        "razorpay payment not readable as an attempt",
      );
      return reply.send({ ok: true, event: verdict.event, observed: false });
    }

    options.observe(attempt);
    app.log.info(
      {
        event: verdict.event,
        eventId: verdict.eventId,
        // The slice and the failure, which is what makes this worth having. No amount, no
        // reference, nothing that identifies the payment or the person.
        method: attempt.slice.method,
        issuer: attempt.slice.issuer,
        status: attempt.status,
        failure:
          attempt.failure === null
            ? null
            : {
                code: attempt.failure.code,
                source: attempt.failure.source,
                step: attempt.failure.step,
                reason: attempt.failure.reason,
              },
      },
      "razorpay webhook observed",
    );

    return reply.send({
      ok: true,
      event: verdict.event,
      observed: true,
      slice: `${attempt.slice.method}|${attempt.slice.issuer ?? ""}|${attempt.slice.instrument ?? ""}`,
      status: attempt.status,
      failure: attempt.failure,
    });
  });
}
