/**
 * The bounds on steering, and the two beliefs about customers that steering cannot avoid holding.
 *
 * The first group are limits. The second group — `switchElasticity` and `abandonmentOnSuppress` —
 * are *assumptions*, and they are the ones that decide whether a steer helps or hurts. They are
 * given names and defaults here rather than hidden inside the arithmetic, because a number that
 * changes the sign of a decision deserves to be argued with, and the measurement harness sweeps
 * both rather than picking a flattering pair.
 */
export interface SteeringConfig {
  /**
   * Share of customers held back as controls, per incident.
   *
   * Without this there is no lift number, only a story. It costs real money — a tenth of the
   * customers in an outage are deliberately left on the failing rail — and that cost is the price
   * of being able to say what the other nine tenths were worth.
   */
  readonly holdoutFraction: number;
  /**
   * Never leave a customer with fewer than this many ways to pay.
   *
   * The bound worth defending hardest. Every other limit here caps damage; this one prevents a
   * category of failure where the remediation *is* the outage — a checkout with nothing on it is
   * worse than the degradation that prompted it.
   */
  readonly methodFloor: number;
  /** Steering expires and must be re-affirmed by continuing evidence. A stale steer is an outage. */
  readonly maxIncidentDurationMs: number;
  /** Never steer on a single observation. */
  readonly minEvidenceWindows: number;
  /** Global blast radius: how many incidents may be steered on at once. */
  readonly maxConcurrentSteers: number;
  /**
   * Fraction of customers who follow a demotion.
   *
   * Demotion reorders the checkout; it removes nothing. So its effect is bounded by how many people
   * take the top option rather than hunting for their usual one. A pure guess, swept in §14.
   */
  readonly switchElasticity: number;
  /**
   * Fraction of customers who abandon rather than switch when their instrument is suppressed.
   *
   * This is what makes suppression expensive. Taking away the button someone came to press does not
   * reliably move them to another button — some of them leave, and a lost checkout is a total loss
   * where a failed payment is at least retryable. Also a guess, also swept.
   */
  readonly abandonmentOnSuppress: number;
  /**
   * The improvement a steer must clear to be worth making, in failure probability per attempt.
   *
   * Not zero, because the estimates feeding the decision are noisy and a steer that is break-even
   * in expectation is a coin flip with a customer's checkout.
   */
  readonly minBenefitPerAttempt: number;
}

export const DEFAULT_STEERING_CONFIG: SteeringConfig = {
  holdoutFraction: 0.1,
  methodFloor: 2,
  maxIncidentDurationMs: 30 * 60_000,
  minEvidenceWindows: 2,
  maxConcurrentSteers: 3,
  switchElasticity: 0.35,
  abandonmentOnSuppress: 0.08,
  minBenefitPerAttempt: 0.0005,
};

/** The complement of the holdout: the most traffic that may ever be treated. */
export function maxSteeredFraction(config: SteeringConfig): number {
  return 1 - config.holdoutFraction;
}
