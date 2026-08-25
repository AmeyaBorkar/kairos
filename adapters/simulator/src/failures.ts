import type { FailureDetail, PaymentMethod } from "@kairos/domain";
import type { Rng } from "./rng.js";

export interface FailureTemplate {
  readonly weight: number;
  readonly detail: FailureDetail;
}

const f = (
  weight: number,
  code: string,
  source: string,
  step: string,
  reason: string,
  description: string,
): FailureTemplate => ({ weight, detail: { code, source, step, reason, description } });

/**
 * What failure looks like on a *healthy* rail.
 *
 * The mix matters as much as the rate. A healthy rail's failures are dominated by the customer —
 * wrong PIN, no balance, expired card — and those are the ones a retry cannot fix. Getting this
 * distribution right is what makes the recovery arm's classifier a real problem rather than a
 * formality, and it is why the simulator carries Razorpay's `source`/`step`/`reason` triple rather
 * than a boolean.
 */
export const BASELINE_FAILURES: Record<PaymentMethod, readonly FailureTemplate[]> = {
  upi: [
    f(
      34,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authentication",
      "incorrect_upi_pin",
      "Incorrect UPI PIN entered",
    ),
    f(
      26,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "insufficient_funds",
      "Insufficient balance in the account",
    ),
    f(
      14,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_initiation",
      "invalid_vpa",
      "The VPA entered does not exist",
    ),
    f(
      12,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "payment_timed_out_at_bank",
      "Bank did not respond in time",
    ),
    f(
      9,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authentication",
      "payment_cancelled_by_user",
      "Customer cancelled the collect request",
    ),
    f(
      5,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "gateway_technical_error",
      "Technical error at the gateway",
    ),
  ],
  card: [
    f(
      28,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "insufficient_funds",
      "Card has insufficient funds",
    ),
    f(
      19,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authentication",
      "incorrect_otp",
      "Incorrect OTP entered",
    ),
    f(
      14,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_initiation",
      "card_expired",
      "The card has expired",
    ),
    f(
      13,
      "BAD_REQUEST_ERROR",
      "bank",
      "payment_authorization",
      "payment_declined_by_bank",
      "Issuer declined the transaction",
    ),
    f(
      10,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "issuer_not_available",
      "Issuing bank is unreachable",
    ),
    f(
      8,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "international_transaction_not_allowed",
      "International transactions are not enabled on this card",
    ),
    f(
      5,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "card_reported_lost_or_stolen",
      "Card has been reported lost or stolen",
    ),
    f(
      3,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "gateway_technical_error",
      "Technical error at the gateway",
    ),
  ],
  netbanking: [
    f(
      38,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authentication",
      "payment_cancelled_by_user",
      "Customer abandoned the bank page",
    ),
    f(
      24,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "insufficient_funds",
      "Insufficient balance in the account",
    ),
    f(
      23,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "bank_server_down",
      "Bank's netbanking service is unavailable",
    ),
    f(
      15,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "payment_timed_out_at_bank",
      "Bank did not respond in time",
    ),
  ],
  wallet: [
    f(
      52,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "insufficient_wallet_balance",
      "Insufficient balance in the wallet",
    ),
    f(
      28,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authentication",
      "payment_cancelled_by_user",
      "Customer cancelled the payment",
    ),
    f(
      20,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "gateway_technical_error",
      "Technical error at the wallet provider",
    ),
  ],
  emi: [
    f(
      44,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "emi_not_available_on_card",
      "EMI is not available on this card",
    ),
    f(
      31,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "insufficient_funds",
      "Card has insufficient credit limit",
    ),
    f(
      25,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "issuer_not_available",
      "Issuing bank is unreachable",
    ),
  ],
  paylater: [
    f(
      49,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authorization",
      "credit_limit_exhausted",
      "Pay Later credit limit exhausted",
    ),
    f(
      29,
      "BAD_REQUEST_ERROR",
      "customer",
      "payment_authentication",
      "incorrect_otp",
      "Incorrect OTP entered",
    ),
    f(
      22,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "gateway_technical_error",
      "Technical error at the provider",
    ),
  ],
};

/**
 * What the *excess* failures during a degradation look like.
 *
 * Almost entirely bank- and gateway-sourced, because that is what a rail breaking actually is. The
 * customer's card did not expire in the same minute the issuer went down. This is the signal the
 * diagnosis layer keys on to tell "this rail is broken" apart from "these customers had a bad day",
 * and it is why an incident's casualties are overwhelmingly retryable while a healthy rail's are not.
 */
export const DEGRADATION_FAILURES: Record<PaymentMethod, readonly FailureTemplate[]> = {
  upi: [
    f(
      46,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "payment_timed_out_at_bank",
      "Bank did not respond in time",
    ),
    f(
      33,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "issuer_not_available",
      "Issuing bank is unreachable",
    ),
    f(
      21,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "gateway_technical_error",
      "Technical error at the gateway",
    ),
  ],
  card: [
    f(
      41,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "issuer_not_available",
      "Issuing bank is unreachable",
    ),
    f(
      32,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "payment_timed_out_at_bank",
      "Bank did not respond in time",
    ),
    f(
      27,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authentication",
      "authentication_service_unavailable",
      "3-D Secure service is unavailable",
    ),
  ],
  netbanking: [
    f(
      58,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "bank_server_down",
      "Bank's netbanking service is unavailable",
    ),
    f(
      42,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "payment_timed_out_at_bank",
      "Bank did not respond in time",
    ),
  ],
  wallet: [
    f(
      61,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "gateway_technical_error",
      "Technical error at the wallet provider",
    ),
    f(
      39,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "payment_timed_out_at_gateway",
      "Wallet provider did not respond in time",
    ),
  ],
  emi: [
    f(
      57,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "issuer_not_available",
      "Issuing bank is unreachable",
    ),
    f(
      43,
      "GATEWAY_ERROR",
      "bank",
      "payment_authorization",
      "payment_timed_out_at_bank",
      "Bank did not respond in time",
    ),
  ],
  paylater: [
    f(
      54,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "gateway_technical_error",
      "Technical error at the provider",
    ),
    f(
      46,
      "GATEWAY_ERROR",
      "gateway",
      "payment_authorization",
      "payment_timed_out_at_gateway",
      "Provider did not respond in time",
    ),
  ],
};

/** Draw a failure of the given flavour for the given method. */
export function drawFailure(
  rng: Rng,
  method: PaymentMethod,
  duringDegradation: boolean,
): FailureDetail {
  const table = duringDegradation ? DEGRADATION_FAILURES[method] : BASELINE_FAILURES[method];
  return rng.pick(table, (t) => t.weight).detail;
}
