import type { Slice } from "@kairos/domain";

/**
 * How precisely Razorpay Checkout can act on a slice.
 *
 * This is the constraint that shapes the whole prevention arm, and it is not symmetric across
 * methods. Checkout's `config.display` addresses *instruments* — things a customer picks from a
 * list — and a slice is only actionable to the extent that it corresponds to something visible at
 * the moment of choosing.
 *
 * - `precise` — Checkout can name exactly this slice. A netbanking bank, a card issuer or network,
 *   a wallet: all of these are chosen explicitly, so `hide` can remove one without touching the
 *   rest.
 * - `partial` — Checkout can name a *superset*. A UPI app can be removed from the intent flow via
 *   `apps`, but the same app reached through a collect request is still available, so suppression
 *   is leaky in one direction and over-broad in the other.
 * - `method` — only the whole method can be named. Removing it takes the healthy traffic with it.
 * - `none` — Checkout cannot see this distinction at all.
 *
 * The last case is the important one and it covers most of the volume. **A UPI payment's issuer is
 * the customer's own bank, sitting behind a VPA that has not been typed yet.** When HDFC's UPI
 * handle degrades, Checkout has no way to know which of the people looking at the payment page bank
 * with HDFC — so there is no instrument to hide, and hiding UPI outright would punish the ninety
 * per cent whose bank is fine. Around seventy per cent of the modelled traffic sits on UPI slices
 * shaped exactly like this.
 *
 * That is why suppression cannot be the primary lever, and why {@link SteerLever} has a second one.
 */
export type Addressability = "precise" | "partial" | "method" | "none";

/**
 * Wallets and pay-later providers carry their identity in the `issuer` position of a slice — a
 * `wallet/paytm` slice means the Paytm wallet, not a Paytm-issued anything — and Checkout names
 * them directly. Cards and netbanking name a real institution, also directly nameable.
 */
const ISSUER_ADDRESSABLE = new Set(["card", "netbanking", "wallet", "emi", "paylater"]);

/**
 * What Checkout can do about this slice.
 *
 * Deliberately conservative where the documentation is ambiguous: a slice is only `precise` when
 * `config.display.hide` can name it without collateral. Over-claiming here would produce a plan
 * that quietly fails to take effect, which is worse than one that declines to try — a steer that
 * silently does nothing still counts as treatment in the analysis and would bias the measured lift
 * toward zero without anyone noticing.
 */
export function checkoutAddressability(slice: Slice): Addressability {
  if (slice.issuer === null) return "method";

  if (slice.method === "upi") {
    // The app is nameable through `apps` on the intent flow; the customer's bank is not nameable
    // at all, because Checkout learns it only once a VPA has been entered or an app has returned.
    return slice.instrument === null ? "none" : "partial";
  }

  return ISSUER_ADDRESSABLE.has(slice.method) ? "precise" : "none";
}

/** Whether a slice can be removed from a checkout without taking healthy traffic with it. */
export function isSuppressible(slice: Slice): boolean {
  return checkoutAddressability(slice) === "precise";
}
