import { type Slice, slice } from "@kairos/domain";

export interface SliceProfile {
  readonly slice: Slice;
  /** Relative share of total volume. Need not sum to anything in particular. */
  readonly share: number;
  /** Failure rate on a healthy day, in [0,1). */
  readonly baseFailureRate: number;
}

/**
 * A plausible Indian merchant's traffic.
 *
 * Shaped from published behaviour rather than invented: UPI carries most of the volume and succeeds
 * around 99% of the time, cards sit far lower at 85–90%, and public-sector banks run visibly worse
 * technical-decline rates than private ones. The spread is the point — a detector that only works
 * when every slice behaves the same way is not a detector, and a fixed threshold that suits UPI
 * would call every card slice a permanent outage.
 *
 * These are the simulator's assumptions, not measurements of any real merchant. They are here to be
 * argued with, which is why each rate sits next to the slice it belongs to.
 */
export const INDIA_PROFILES: readonly SliceProfile[] = [
  // UPI — roughly two thirds of volume, and the healthiest rail by a wide margin.
  { slice: slice("upi", "hdfc", "phonepe"), share: 118, baseFailureRate: 0.017 },
  { slice: slice("upi", "hdfc", "gpay"), share: 96, baseFailureRate: 0.016 },
  { slice: slice("upi", "sbi", "phonepe"), share: 104, baseFailureRate: 0.043 },
  { slice: slice("upi", "sbi", "gpay"), share: 82, baseFailureRate: 0.041 },
  { slice: slice("upi", "icici", "gpay"), share: 71, baseFailureRate: 0.019 },
  { slice: slice("upi", "icici", "paytm"), share: 38, baseFailureRate: 0.022 },
  { slice: slice("upi", "axis", "phonepe"), share: 54, baseFailureRate: 0.024 },
  { slice: slice("upi", "kotak", "gpay"), share: 31, baseFailureRate: 0.021 },
  { slice: slice("upi", "pnb", "phonepe"), share: 29, baseFailureRate: 0.062 },
  { slice: slice("upi", "bob", "phonepe"), share: 22, baseFailureRate: 0.071 },
  // A deliberately thin slice. Nothing sensible can be concluded from its own data alone, so it is
  // the case that exposes a detector without shrinkage.
  { slice: slice("upi", "canara", "paytm"), share: 4, baseFailureRate: 0.058 },

  // Cards — a fifth of volume and where most of the failure lives.
  { slice: slice("card", "hdfc", "visa"), share: 47, baseFailureRate: 0.112 },
  { slice: slice("card", "hdfc", "mastercard"), share: 33, baseFailureRate: 0.118 },
  { slice: slice("card", "icici", "visa"), share: 29, baseFailureRate: 0.124 },
  { slice: slice("card", "sbi", "rupay"), share: 26, baseFailureRate: 0.143 },
  { slice: slice("card", "axis", "mastercard"), share: 18, baseFailureRate: 0.131 },
  { slice: slice("card", "kotak", "visa"), share: 11, baseFailureRate: 0.109 },

  // Netbanking — low volume, high abandonment, and the rail most prone to bank-side outages.
  { slice: slice("netbanking", "hdfc"), share: 21, baseFailureRate: 0.094 },
  { slice: slice("netbanking", "sbi"), share: 24, baseFailureRate: 0.127 },
  { slice: slice("netbanking", "icici"), share: 14, baseFailureRate: 0.098 },

  // Wallets and credit — small but not negligible.
  { slice: slice("wallet", "paytm"), share: 17, baseFailureRate: 0.036 },
  { slice: slice("wallet", "amazonpay"), share: 9, baseFailureRate: 0.031 },
  { slice: slice("paylater", "lazypay"), share: 7, baseFailureRate: 0.081 },
  { slice: slice("emi", "hdfc", "visa"), share: 6, baseFailureRate: 0.096 },
];

/** Blended failure rate across a profile set, weighted by share. Useful as a sanity check. */
export function blendedFailureRate(profiles: readonly SliceProfile[]): number {
  let weighted = 0;
  let total = 0;
  for (const p of profiles) {
    weighted += p.share * p.baseFailureRate;
    total += p.share;
  }
  return total === 0 ? 0 : weighted / total;
}
