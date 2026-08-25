import {
  type Attempt,
  type Casualty,
  type CasualtyId,
  casualtyId,
  isFailure,
  openCasualty,
  type RetryCapability,
} from "@kairos/domain";
import { classify } from "./classify.js";

/**
 * A stable casualty id for one failed attempt.
 *
 * Derived rather than generated, for the same reason an incident id is: the intake runs in more
 * than one place — a webhook, a reconciliation sweep that catches what the webhook dropped, and the
 * harness — and all of them must agree that these are the same casualty. A generated id would give
 * a merchant two queue entries for one lost payment and chase them both.
 */
export function idForAttempt(attempt: Attempt): CasualtyId {
  return casualtyId(`cas_${attempt.id}`);
}

/**
 * Open a casualty from a failed payment.
 *
 * Classification happens here, once, at the moment the failure arrives, because the failure detail
 * is what it reads and that never changes afterwards. The worker re-derives it on every pass rather
 * than trusting a stored copy, so this is the *first* answer rather than the only one — and the
 * residual path, which is asynchronous and involves a model, is deliberately not run here. An
 * intake that blocks on an inference endpoint is an intake that drops payments when it is slow.
 *
 * Returns `null` for anything that is not a loss: a captured payment, an authorised one, or an
 * attempt still in flight. Counting an unresolved payment as a casualty would chase a customer
 * whose money is on its way.
 */
export function casualtyFrom(attempt: Attempt, retry: RetryCapability): Casualty | null {
  if (!isFailure(attempt) || attempt.failure === null) return null;

  return openCasualty(
    {
      id: idForAttempt(attempt),
      kind: "payment-failed",
      customer: attempt.customer,
      orderId: attempt.orderId,
      attemptId: attempt.id,
      slice: attempt.slice,
      amount: attempt.amount,
      failure: attempt.failure,
      retry,
      occurredAt: attempt.at,
    },
    classify(attempt.failure, "payment-failed").recoverability,
  );
}
