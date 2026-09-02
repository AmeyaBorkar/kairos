import { PAYMENT_METHODS } from "@kairos/domain";
import { z } from "zod";

/**
 * The outcome stream, validated at the boundary.
 *
 * Rejected rather than coerced. An attempt whose method is not one Kairos knows about, or whose
 * amount is not a whole number of paise, is evidence about the integration and not about the rails
 * — and quietly accepting it would put a slice in the detector that nothing else can reason about.
 */
export const ATTEMPT = z.object({
  id: z.string().min(1).max(128),
  orderId: z.string().min(1).max(128),
  /**
   * Already pseudonymous when it arrives.
   *
   * The minimum length is a structural guard rather than a formality: a keyed hash always clears it
   * and a bare phone number never does, so a raw identifier cannot reach the detector, the ledger
   * or a model prompt by accident.
   */
  customer: z.string().min(16).max(128),
  amountPaise: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  method: z.enum(PAYMENT_METHODS),
  issuer: z.string().min(1).max(64).nullish(),
  instrument: z.string().min(1).max(64).nullish(),
  status: z.enum(["captured", "failed", "authorized", "created"]),
  at: z.int(),
  /**
   * Which arm this outcome came from, when the caller knows.
   *
   * `control` means the customer's checkout was left entirely alone, which makes their outcome an
   * unbiased measurement of the unsteered world. Optional, because an integration that is not yet
   * serving plans has no arms to report — and defaults to `treated`, the conservative reading.
   */
  arm: z.enum(["treated", "control"]).nullish(),
});

export const ATTEMPT_BATCH = z.object({
  /** Bounded so one request cannot occupy the service indefinitely. */
  attempts: z.array(ATTEMPT).min(1).max(1000),
});

export type AttemptInput = z.infer<typeof ATTEMPT>;

/**
 * A plan request.
 *
 * `POST` rather than only `GET /plan/:customer` because the interesting fields are not path
 * segments. A merchant's checkout is not one page — a subscription upgrade offers different
 * methods than a one-rupee verification — and the method set is the merchant's to state on every
 * request rather than Kairos's to remember. Everything is optional except the customer, so the
 * smallest useful body is `{"customer": "..."}` and the endpoint stays callable from a language
 * with no client library.
 */
export const PLAN_REQUEST = z.object({
  customer: z.string().min(16).max(128),
  /**
   * The methods this checkout can render, most preferred first.
   *
   * Kairos perturbs this order; it never invents a method the merchant did not offer. Omitted
   * means "the sequence this service was configured with", which is the right default for a
   * merchant with one checkout and the wrong one for a merchant with several — hence the field.
   */
  sequence: z.array(z.enum(PAYMENT_METHODS)).min(1).max(PAYMENT_METHODS.length).nullish(),
});

export type PlanRequestInput = z.infer<typeof PLAN_REQUEST>;
