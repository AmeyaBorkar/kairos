import type { PaymentMethod, Slice } from "@kairos/domain";
import type { SteeringPlan } from "@kairos/policy";
import { bankCode, networkCode, providerCode, upiAppCode, walletCode } from "./codes.js";

/**
 * One payment instrument, in Checkout's own vocabulary.
 *
 * The optional fields are the ones `config.display` accepts. Which of them apply depends on the
 * method: `banks` for netbanking, `issuers` and `networks` for cards, `wallets` for wallets,
 * `apps` and `flows` for UPI.
 */
export interface CheckoutInstrument {
  readonly method: string;
  readonly banks?: readonly string[];
  readonly issuers?: readonly string[];
  readonly networks?: readonly string[];
  readonly wallets?: readonly string[];
  readonly apps?: readonly string[];
  readonly flows?: readonly string[];
  readonly providers?: readonly string[];
}

export interface CheckoutDisplay {
  /** The order methods appear in. Exhaustive, because the default list is switched off. */
  readonly sequence: readonly string[];
  readonly preferences: { readonly show_default_blocks: boolean };
  readonly hide?: readonly CheckoutInstrument[];
}

export interface CheckoutConfig {
  readonly display: CheckoutDisplay;
}

/**
 * A steer that could not be expressed, and why.
 *
 * Returned rather than thrown, and returned rather than silently dropped. A suppression Checkout
 * cannot express is the worst kind of bug in this system: the customer sees an unchanged page, the
 * ledger records a steer, and the measurement counts them as treated — so the lift number quietly
 * moves toward zero with nothing anywhere reporting a fault.
 */
export interface RenderDiagnostic {
  readonly slice: Slice;
  readonly reason: string;
}

export interface RenderedCheckout {
  readonly config: CheckoutConfig;
  readonly diagnostics: readonly RenderDiagnostic[];
}

/** Translate one slice into the instrument Checkout would recognise, or explain why it cannot. */
export function instrumentFor(slice: Slice): CheckoutInstrument | RenderDiagnostic {
  const cannot = (reason: string): RenderDiagnostic => ({ slice, reason });

  switch (slice.method) {
    case "netbanking": {
      const bank = bankCode(slice.issuer);
      if (bank === null) return cannot(`no Razorpay bank code for issuer ${slice.issuer}`);
      return { method: "netbanking", banks: [bank] };
    }

    case "card":
    case "emi": {
      const issuer = bankCode(slice.issuer);
      if (issuer === null) return cannot(`no Razorpay bank code for issuer ${slice.issuer}`);
      const network = networkCode(slice.instrument);
      if (slice.instrument !== null && network === null) {
        return cannot(`no Razorpay network code for ${slice.instrument}`);
      }
      return network === null
        ? { method: slice.method, issuers: [issuer] }
        : { method: slice.method, issuers: [issuer], networks: [network] };
    }

    case "wallet": {
      const wallet = walletCode(slice.issuer);
      if (wallet === null) return cannot(`no Razorpay wallet code for ${slice.issuer}`);
      return { method: "wallet", wallets: [wallet] };
    }

    case "paylater": {
      const provider = providerCode(slice.issuer);
      if (provider === null) return cannot(`no Razorpay provider code for ${slice.issuer}`);
      return { method: "paylater", providers: [provider] };
    }

    case "upi": {
      const app = upiAppCode(slice.instrument);
      if (app === null) {
        return cannot(
          slice.instrument === null
            ? "a UPI issuer is the customer's own bank and is not visible to Checkout"
            : `no Razorpay app code for ${slice.instrument}`,
        );
      }
      // Only the intent flow names an app. The same app reached through a collect request is
      // untouched, which is why policy classifies this as partial rather than precise.
      return { method: "upi", apps: [app], flows: ["intent"] };
    }
  }
}

/**
 * Render a plan as the `config` object Razorpay Checkout is handed.
 *
 * Two levers, two mechanisms, both documented:
 *
 * - **suppression** becomes `display.hide`, which accepts instrument-level entries — a specific
 *   netbanking bank, a specific card issuer — not only whole methods.
 * - **demotion** becomes `display.sequence` with `show_default_blocks` switched off, so the order
 *   given here is the order rendered. The sequence is exhaustive for exactly that reason: with the
 *   default list suppressed, anything left out of the sequence would vanish from the checkout, and
 *   a reorder that silently removes methods is the failure the method floor exists to prevent.
 */
export function renderCheckout(
  plan: SteeringPlan,
  availableMethods: readonly PaymentMethod[],
): RenderedCheckout {
  const hide: CheckoutInstrument[] = [];
  const diagnostics: RenderDiagnostic[] = [];

  for (const slice of plan.suppress) {
    const rendered = instrumentFor(slice);
    if ("reason" in rendered) diagnostics.push(rendered);
    else hide.push(rendered);
  }

  // The plan's sequence carries only the methods policy knows about; anything the merchant offers
  // that Kairos has never seen traffic on still has to appear, or switching the default list off
  // would remove it.
  const ordered = [...plan.sequence, ...availableMethods.filter((m) => !plan.sequence.includes(m))];

  return {
    config: {
      display: {
        sequence: ordered,
        preferences: { show_default_blocks: false },
        ...(hide.length > 0 ? { hide } : {}),
      },
    },
    diagnostics,
  };
}

/**
 * The configuration a checkout falls back to.
 *
 * Every failure path resolves here: `sentry` unreachable, the 50 ms budget blown, a malformed
 * response, Kairos not deployed at all. It is the merchant's own ordering with nothing hidden,
 * which is to say it is what the checkout would have done without any of this.
 */
export function defaultCheckout(availableMethods: readonly PaymentMethod[]): CheckoutConfig {
  return {
    display: {
      sequence: [...availableMethods],
      preferences: { show_default_blocks: true },
    },
  };
}
