import { DomainError } from "./brand.js";

/** Payment methods Kairos observes. Mirrors Razorpay's `method` field. */
export const PAYMENT_METHODS = ["upi", "card", "netbanking", "wallet", "emi", "paylater"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: string): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * The unit of health. Failure rates are tracked per slice, because "payments are failing" is not
 * actionable and "HDFC's UPI handle is failing" is.
 *
 * - `issuer` — the bank or issuing institution (`hdfc`, `sbi`, …), or `null` when unattributable.
 * - `instrument` — the network for cards (`visa`, `rupay`), the app for UPI (`phonepe`, `gpay`).
 *
 * Coarser slices are reachable through {@link sliceParents}, which is what lets a low-volume slice
 * borrow a baseline from its parent and what lets a broad outage roll up into one incident rather
 * than four hundred correlated alarms.
 */
export interface Slice {
  readonly method: PaymentMethod;
  readonly issuer: string | null;
  readonly instrument: string | null;
}

const SEP = "|";

/** Field values may not contain the key separator, or keys would not round-trip. */
function assertComponent(value: string | null, field: string): void {
  if (value === null) return;
  if (value.length === 0) {
    throw new DomainError(field, "expected a non-empty value or null");
  }
  if (value.includes(SEP)) {
    throw new DomainError(field, `may not contain ${JSON.stringify(SEP)}`);
  }
}

export function slice(
  method: PaymentMethod,
  issuer: string | null = null,
  instrument: string | null = null,
): Slice {
  assertComponent(issuer, "slice.issuer");
  assertComponent(instrument, "slice.instrument");
  if (issuer === null && instrument !== null) {
    throw new DomainError("slice.instrument", "cannot be set when issuer is null");
  }
  return { method, issuer, instrument };
}

/** Stable string key for storage and map lookup. Round-trips through {@link parseSliceKey}. */
export function sliceKey(s: Slice): string {
  return [s.method, s.issuer ?? "", s.instrument ?? ""].join(SEP);
}

export function parseSliceKey(key: string): Slice {
  const parts = key.split(SEP);
  if (parts.length !== 3) {
    throw new DomainError("sliceKey", `expected 3 components, received ${parts.length}`);
  }
  const [method, issuer, instrument] = parts as [string, string, string];
  if (!isPaymentMethod(method)) {
    throw new DomainError("sliceKey.method", `unknown payment method ${JSON.stringify(method)}`);
  }
  return slice(method, issuer === "" ? null : issuer, instrument === "" ? null : instrument);
}

/**
 * Ancestors from most to least specific, excluding the slice itself.
 *
 * `{upi, hdfc, phonepe}` → `[{upi, hdfc, null}, {upi, null, null}]`
 *
 * Used for empirical-Bayes shrinkage (a slice doing three attempts a minute borrows its parent's
 * baseline instead of firing on noise) and for hierarchical alarm rollup.
 */
export function sliceParents(s: Slice): Slice[] {
  const parents: Slice[] = [];
  if (s.instrument !== null) {
    parents.push({ method: s.method, issuer: s.issuer, instrument: null });
  }
  if (s.issuer !== null) {
    parents.push({ method: s.method, issuer: null, instrument: null });
  }
  return parents;
}

/** How specific a slice is: 0 for method-only, 2 for fully qualified. */
export function sliceDepth(s: Slice): 0 | 1 | 2 {
  if (s.instrument !== null) return 2;
  if (s.issuer !== null) return 1;
  return 0;
}

export function sliceEquals(a: Slice, b: Slice): boolean {
  return a.method === b.method && a.issuer === b.issuer && a.instrument === b.instrument;
}

/** Whether `ancestor` is `s` itself or one of its parents. */
export function sliceCovers(ancestor: Slice, s: Slice): boolean {
  if (sliceEquals(ancestor, s)) return true;
  return sliceParents(s).some((p) => sliceEquals(ancestor, p));
}

/** Human-readable, e.g. `upi · hdfc · phonepe`. */
export function formatSlice(s: Slice): string {
  return [s.method, s.issuer, s.instrument].filter((x): x is string => x !== null).join(" · ");
}
