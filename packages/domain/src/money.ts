import { type Brand, DomainError } from "./brand.js";

/**
 * An integer amount in paise. **Every** monetary value in Kairos is this type.
 *
 * Money is never a float. Floating-point arithmetic on currency accumulates error that shows up
 * as a budget that does not quite reconcile, and a budget that does not reconcile is a budget
 * whose bound cannot be proven. Razorpay's API is already paise-denominated, so no conversion
 * happens until display.
 *
 * Signed, because deltas are real: `netValue = recovered - spent` may be negative, and pretending
 * otherwise would push the sign into an untyped variable somewhere else.
 */
export type Paise = Brand<number, "Paise">;

/** The zero amount. */
export const ZERO: Paise = 0 as Paise;

/**
 * Construct a {@link Paise} from a number, enforcing the integer invariant at the boundary.
 *
 * @throws {DomainError} if `n` is not a safe integer (covers NaN, Infinity, fractions, and
 * anything beyond 2^53 where integer arithmetic silently stops being exact).
 */
export function paise(n: number, field = "amount"): Paise {
  if (!Number.isSafeInteger(n)) {
    throw new DomainError(field, `expected a safe integer number of paise, received ${n}`);
  }
  return n as Paise;
}

/** Construct a {@link Paise} that must not be negative — budgets, prices, caps. */
export function nonNegativePaise(n: number, field = "amount"): Paise {
  const p = paise(n, field);
  if (p < 0) {
    throw new DomainError(field, `expected a non-negative amount, received ${n}`);
  }
  return p;
}

/** Construct a {@link Paise} from rupees. Rejects fractions finer than a paise. */
export function rupees(n: number, field = "amount"): Paise {
  const scaled = n * 100;
  if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    throw new DomainError(field, `${n} rupees is not a whole number of paise`);
  }
  return paise(Math.round(scaled), field);
}

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b, "sum");
}

export function subPaise(a: Paise, b: Paise): Paise {
  return paise(a - b, "difference");
}

/**
 * Scale an amount, rounding half away from zero.
 *
 * Half-away-from-zero rather than JavaScript's `Math.round` (which rounds half *up*, so −0.5
 * becomes −0) keeps scaling symmetric about zero: `mulPaise(-x, f) === -mulPaise(x, f)`. Without
 * that, a refund and its charge can disagree by a paise.
 */
export function mulPaise(a: Paise, factor: number, field = "product"): Paise {
  if (!Number.isFinite(factor)) {
    throw new DomainError(field, `expected a finite factor, received ${factor}`);
  }
  const scaled = a * factor;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return paise(rounded, field);
}

/** The larger of two amounts. */
export function maxPaise(a: Paise, b: Paise): Paise {
  return a >= b ? a : b;
}

/** The smaller of two amounts. */
export function minPaise(a: Paise, b: Paise): Paise {
  return a <= b ? a : b;
}

/** Sum a list. Empty sums to {@link ZERO}. */
export function sumPaise(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const a of amounts) total += a;
  return paise(total, "total");
}

/**
 * Render for humans, e.g. `₹1,23,456.78`. Indian digit grouping — the last three digits, then
 * pairs — because this is read by Indian merchants and Western grouping reads as a typo to them.
 */
export function formatINR(amount: Paise): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");

  const digits = whole.toString();
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
  }

  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}
