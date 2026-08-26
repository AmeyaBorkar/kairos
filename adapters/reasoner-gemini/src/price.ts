/**
 * What Google charges, in paise, with the arithmetic left in.
 *
 * Every entry is derived by calling {@link usdPerMillionToPaise} on the figure the pricing page
 * states, at a stated exchange rate, rather than by someone multiplying it out and typing the
 * answer. A wrong price is then a wrong *input* — visible in a diff, checkable against a URL — and
 * not a plausible integer nobody can source.
 *
 * ## Prices expire, and this table says when
 *
 * Google's Flash pricing is introductory: `$0.75` per million input tokens **through 31 December
 * 2026**, `$1.50` from 1 January 2027. A table that quietly carried the introductory number into
 * 2027 would halve every reported cost in this repository, and nothing would fail. So each entry
 * carries a {@link GeminiPrice.validUntil} and a test asserts it has not passed — the constant is
 * built to announce its own expiry rather than to rot silently.
 *
 * ## Why a free-tier key is still billed here
 *
 * These calls cost nothing on the tier this was developed on. The accounting still runs at list
 * rate, because the number a merchant needs is what this costs at their volume rather than what it
 * costs at ours — the argument in `@kairos/reason`'s `price.ts`, applied to a specific price list.
 */

import { type ModelPrice, usdPerMillionToPaise } from "@kairos/reason";

/**
 * The rate the paise figures were derived at.
 *
 * ₹95.90 on 25 August 2026, rounded up to a whole rupee. Rounding *up* is deliberate and worth the
 * 0.1%: it makes the constant a number a reviewer can hold in their head, and it errs toward
 * over-reporting a cost rather than under-reporting one.
 */
export const RUPEES_PER_USD = 96;

export interface GeminiPrice extends ModelPrice {
  /**
   * The last date this entry is known to be correct, inclusive, as `YYYY-MM-DD`.
   *
   * Not a cache expiry — nothing refetches. It is the date after which somebody has to look, and
   * the test that reads it is what makes "somebody has to look" happen.
   */
  readonly validUntil: string;
}

function entry(
  model: string,
  inputUsd: number,
  outputUsd: number,
  cacheReadUsd: number,
  validUntil: string,
  note: string,
): GeminiPrice {
  return {
    model,
    inputPaisePerMillion: usdPerMillionToPaise(inputUsd, RUPEES_PER_USD),
    outputPaisePerMillion: usdPerMillionToPaise(outputUsd, RUPEES_PER_USD),
    cacheReadShare: cacheReadUsd / inputUsd,
    derivation:
      `$${inputUsd} in / $${outputUsd} out / $${cacheReadUsd} cached, per million tokens, at ` +
      `₹${RUPEES_PER_USD}/USD. ai.google.dev/gemini-api/docs/pricing, read 2026-08-26. ${note}`,
    validUntil,
  };
}

/**
 * Standard-tier list prices.
 *
 * Standard rather than Batch: this is priced as if it ran the way it runs, and the copy library is
 * generated interactively against a per-minute rate limit. Quoting the batch price for an
 * interactive workload would be the cheaper number and the wrong one.
 */
export const GEMINI_PRICES: Readonly<Record<string, GeminiPrice>> = {
  "gemini-3.6-flash": entry(
    "gemini-3.6-flash",
    0.75,
    3.75,
    0.075,
    "2026-12-31",
    "Introductory; doubles to $1.50/$7.50 on 2027-01-01.",
  ),
  "gemini-3.7-flash": entry(
    "gemini-3.7-flash",
    0.75,
    3.75,
    0.075,
    "2026-12-31",
    "Introductory; doubles to $1.50/$7.50 on 2027-01-01.",
  ),
  "gemini-3.5-flash": entry("gemini-3.5-flash", 1.5, 9.0, 0.15, "2026-12-31", "Text tier."),
  "gemini-3.1-flash-lite": entry(
    "gemini-3.1-flash-lite",
    0.25,
    1.5,
    0.025,
    "2026-12-31",
    "Text/image/video tier; audio input is priced higher and is not used here.",
  ),
};

/**
 * The price for a model, or a refusal.
 *
 * Deliberately throws rather than defaulting. An unpriced model is not a model that costs nothing,
 * and a zero that flows into a Terminus reservation is a bound that does not bind — the one failure
 * this whole file exists to prevent. Adding a model means adding its price, in the same commit.
 */
export function priceFor(model: string): GeminiPrice {
  const price = GEMINI_PRICES[model];
  if (price === undefined) {
    const known = Object.keys(GEMINI_PRICES).sort().join(", ");
    throw new Error(
      `no price is recorded for ${model}, so its calls cannot be reserved against a budget. ` +
        `Add it to GEMINI_PRICES. Priced models: ${known}`,
    );
  }
  return price;
}
