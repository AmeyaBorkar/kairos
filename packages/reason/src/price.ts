/**
 * What a model call costs, so that Terminus can govern it like everything else.
 *
 * An inference call spends money. A system whose entire thesis is that no rupee leaves without a
 * signed mandate cannot have one channel of spend that nobody counts, and "it is only a few cents"
 * is the argument every unbounded cost begins with.
 *
 * ## Priced at list rate even when the invoice says nothing
 *
 * Development runs on a provider's free tier. The accounting does not. A call billed at zero would
 * make `reason.spentPaise` a true statement about this month and a false one about the first month
 * anybody deployed it, and the number a merchant needs is what this costs at their volume rather
 * than what it costs at ours. So every call is priced at the model's published rate, whoever is
 * paying.
 *
 * A free tier's real constraint is not money, it is requests per minute — and that is a rate limit
 * rather than a budget, so it is ThrottleKit's problem at the adapter rather than Terminus's here.
 * Two bounds, two mechanisms, both of which already existed.
 */

import { type Paise, paise } from "@kairos/domain";

/** What a provider reported the call actually consumed. Never an estimate — see {@link priceOf}. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Input tokens served from the provider's prompt cache, where it reports them.
   *
   * Counted separately because they are billed at a fraction of the rate, and because a cache hit
   * rate that silently falls to zero is the most common way a carefully-ordered prompt stops paying
   * for itself. A provider that does not report this leaves it zero, which prices the call as if
   * nothing was cached — wrong in the safe direction.
   */
  readonly cachedInputTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

/**
 * A model's published price, in paise per million tokens.
 *
 * Stated in paise rather than converted from dollars at call time, so that a rate is a reviewable
 * constant in a file rather than a floating-point exchange rate baked into an audit record. The
 * conversion each entry was derived at is recorded beside it: get the rate wrong and the mistake is
 * visible in a diff instead of drifting silently with the currency market.
 */
export interface ModelPrice {
  readonly model: string;
  readonly inputPaisePerMillion: number;
  readonly outputPaisePerMillion: number;
  /** What a cached input token costs, as a share of a fresh one. */
  readonly cacheReadShare: number;
  /** How this entry was arrived at, so it can be checked and re-derived. */
  readonly derivation: string;
}

/**
 * Convert a dollar-per-million-tokens figure to paise, at a stated rate.
 *
 * Exported so a price table can be re-derived rather than hand-edited when either the provider's
 * pricing or the exchange rate moves, and so the arithmetic is testable.
 */
export function usdPerMillionToPaise(usdPerMillion: number, rupeesPerUsd: number): number {
  return Math.round(usdPerMillion * rupeesPerUsd * 100);
}

/**
 * What one call cost.
 *
 * Takes reported usage rather than an estimate of it, for the same reason `Messenger.send` returns
 * the actual cost of a message rather than accepting a quoted one: the price depends on what the
 * model wrote, and you find out what it wrote after it has written it. Terminus reserves a ceiling
 * and reconciles against this.
 *
 * Rounded up. A fraction of a paise that rounds down is a fraction of a paise the budget never sees,
 * and a bound that leaks is not a bound.
 */
export function priceOf(usage: Usage, price: ModelPrice): Paise {
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const inputPaise =
    (fresh * price.inputPaisePerMillion +
      usage.cachedInputTokens * price.inputPaisePerMillion * price.cacheReadShare) /
    1_000_000;
  const outputPaise = (usage.outputTokens * price.outputPaisePerMillion) / 1_000_000;
  return paise(Math.ceil(inputPaise + outputPaise), "model call");
}

/**
 * The ceiling a call could reach, for the reservation taken before it is made.
 *
 * The input side is known exactly — the prompt exists before the call does. The output side is not,
 * so it is priced at `maxOutputTokens`, which is the only number anybody can promise. That is the
 * whole shape of a reservation: bound what you cannot know, reconcile when you do.
 */
export function reservationFor(
  inputTokens: number,
  maxOutputTokens: number,
  price: ModelPrice,
): Paise {
  return priceOf({ inputTokens, outputTokens: maxOutputTokens, cachedInputTokens: 0 }, price);
}
