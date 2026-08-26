/**
 * Who the customers are, as distinct from what happens to their payments.
 *
 * The simulator has always modelled *attempts* in detail and *people* not at all — a casualty had
 * an id, an amount and a rail, and every arm was told its owner read English. That was harmless
 * while every arm sent the same English template. It stops being harmless the moment one arm can
 * write Tamil: a benchmark whose entire population reads the language the baseline happens to be
 * written in cannot measure a language advantage, and would report zero for a real one.
 *
 * ## Every number in this file is a stipulation
 *
 * Nobody here has a merchant's customer-language distribution. {@link INDIA_LANGUAGE_MIX} is a
 * modelling assumption, and it is load-bearing in an obvious direction: the value of writing four
 * languages scales almost linearly with the share of customers who do not read the fifty-fifth
 * percentile of English. Halve the non-English share and you roughly halve the measured gain.
 *
 * So the mix is a parameter rather than a constant, the harness sweeps it, and the published figure
 * is quoted next to the share it assumes. A single number from a single mix would be a fact about
 * this file rather than about recovery.
 *
 * ## Language is derived, not drawn
 *
 * A customer's language comes from a hash of their reference, so it is the same in every arm of
 * every run at every seed. This is not an optimisation. Two arms that disagreed about what language
 * a given customer reads would differ by more than their copy, and the comparison would be
 * measuring the population rather than the policy.
 */

import { type CustomerRef, LANGUAGES, type Language, stableDraw } from "@kairos/domain";

/**
 * The modelled language mix of an Indian merchant's online customers.
 *
 * Shares, summing to 1. English is over-represented relative to the country because the population
 * being modelled is people transacting online with a card or a UPI app, not the general public —
 * that skew is real, and assuming otherwise would overstate the case this file exists to test.
 *
 * The four languages are the four the copy library covers, which is itself a choice: a real merchant
 * would want Bengali, Telugu and Gujarati before Marathi. Adding a language is a generation run, not
 * a code change — see `apps/scribe`.
 */
export const INDIA_LANGUAGE_MIX: Readonly<Record<Language, number>> = {
  en: 0.55,
  hi: 0.25,
  mr: 0.1,
  ta: 0.1,
};

/** Everybody reads English. The population the benchmark modelled before this file existed. */
export const ENGLISH_ONLY: Readonly<Record<Language, number>> = { en: 1, hi: 0, mr: 0, ta: 0 };

/**
 * What this customer reads.
 *
 * Deterministic in the customer reference and the mix, so it is stable across arms, runs and
 * machines. Walks the cumulative distribution in the fixed order of {@link LANGUAGES} rather than
 * in object-key order, because a distribution whose assignment depended on how a literal happened
 * to be written would silently reshuffle the whole population when somebody sorted the fields.
 */
export function languageOf(
  customer: CustomerRef,
  mix: Readonly<Record<Language, number>> = INDIA_LANGUAGE_MIX,
): Language {
  const total = LANGUAGES.reduce((sum, language) => sum + Math.max(0, mix[language]), 0);
  if (total <= 0) return "en";

  // The same helper the holdout assignment uses, for the same reason: two pieces of arithmetic that
  // divide a population must not drift apart. Purpose-tagged so a customer's language draw is
  // independent of whether they landed in the control arm.
  const draw = stableDraw(customer, "language") * total;

  let cumulative = 0;
  for (const language of LANGUAGES) {
    cumulative += Math.max(0, mix[language]);
    if (draw < cumulative) return language;
  }
  // Only reachable through floating-point drift at the very top of the range.
  return "en";
}

/**
 * The realised mix of a population, for reporting what a run actually contained.
 *
 * A stipulated distribution and the sample drawn from it are not the same thing, and at the sizes
 * the recovery benchmark runs — a few hundred customers — they differ visibly. The scorecard quotes
 * the realised shares so a reader is comparing arms over the population that existed rather than
 * the one that was asked for.
 */
export function realisedMix(
  customers: Iterable<CustomerRef>,
  mix: Readonly<Record<Language, number>> = INDIA_LANGUAGE_MIX,
): Readonly<Record<Language, number>> {
  const counts: Record<Language, number> = { en: 0, hi: 0, mr: 0, ta: 0 };
  let total = 0;
  for (const customer of customers) {
    counts[languageOf(customer, mix)]++;
    total++;
  }
  if (total === 0) return counts;
  return {
    en: counts.en / total,
    hi: counts.hi / total,
    mr: counts.mr / total,
    ta: counts.ta / total,
  };
}
