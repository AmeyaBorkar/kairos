import {
  type Attempt,
  type AttemptStatus,
  attemptId,
  type CustomerRef,
  type FailureDetail,
  orderId,
  PAYMENT_METHODS,
  type PaymentMethod,
  paise,
  slice,
} from "@kairos/domain";

/**
 * A Razorpay payment, read the way Kairos needs it.
 *
 * The mirror of `checkout.ts`: that one turns a steering plan into the config Razorpay Checkout
 * takes, this one turns what Razorpay reports back into an {@link Attempt} the detector and the
 * classifier consume. Between them they are the whole integration surface, and this is the
 * direction that matters more — steering is advice, but an outcome misread is a wrong number in
 * every measurement downstream of it.
 *
 * ## Personal data stops here
 *
 * A payment entity carries `email` and `contact`, and Kairos handles neither. Everything past this
 * function sees a {@link CustomerRef}, which is a keyed hash, and the key never leaves the caller.
 * So pseudonymisation is a required argument rather than an option with a default: a default would
 * be a way to accidentally put a phone number into the detector, the ledger and a model prompt, and
 * "we intended to configure that" is not a defence anybody wants to make afterwards.
 *
 * ## An unreadable payment is dropped, not guessed
 *
 * `null` for anything whose method Kairos does not model or whose fields do not parse. The
 * alternative — inventing a slice, defaulting an amount — puts a fabricated observation into a
 * detector whose entire job is to notice when a rail's numbers move.
 */
export interface InboundOptions {
  /**
   * Turns a Razorpay identifier for a person into a reference Kairos may hold.
   *
   * Must be a keyed hash, and must produce at least sixteen characters — the boundary schema
   * enforces that length precisely so a raw phone number cannot pass for a reference.
   */
  readonly pseudonymise: (raw: string) => CustomerRef;
  /**
   * Told why a payment was dropped, when one is.
   *
   * Optional, and worth wiring. "Not readable" is a sentence that ends an investigation rather than
   * starting one: a gateway's entity has a dozen fields any of which can refuse, and a caller that
   * cannot say which is left bisecting domain constructors against a silent null.
   */
  readonly onDrop?: (reason: string) => void;
}

/** The subset of a Razorpay payment entity this reads. Everything else is ignored. */
export interface RazorpayPayment {
  readonly [key: string]: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function methodOf(entity: RazorpayPayment): PaymentMethod | null {
  const raw = text(entity["method"])?.toLowerCase() ?? null;
  if (raw === null) return null;
  // `emi` and `paylater` arrive under their own names; everything else Razorpay reports is a method
  // Kairos does not model, and modelling it by guessing is worse than not modelling it.
  return (PAYMENT_METHODS as readonly string[]).includes(raw) ? (raw as PaymentMethod) : null;
}

/**
 * Which institution and which instrument, per method.
 *
 * The pair is what makes a slice worth watching: "UPI is fine, UPI through this one bank is not" is
 * the observation the whole detector exists to make, and it is unavailable if an outcome is filed
 * under its method alone.
 *
 * UPI is the awkward one. Razorpay does not report the payer's app, and the closest honest signal
 * is the VPA handle — `name@okhdfcbank` is HDFC's PSP — so the handle is the issuer and the app is
 * left unknown rather than inferred from it.
 *
 * ## An instrument without an issuer is not a slice
 *
 * The domain refuses it, and is right to: the key is a hierarchy, and "Visa, bank unknown" cannot
 * sit under a bank. Razorpay reports exactly that shape — `network: "Visa"` with `issuer: null` —
 * for any card whose issuer it cannot identify, which is common.
 *
 * So the refinement is dropped rather than the observation. `card||` is a true thing to say about a
 * payment whose bank we do not know, and inventing an issuer to keep the network would be a
 * fabricated slice in the one component whose job is noticing when a slice's numbers move.
 */
function sliceOf(entity: RazorpayPayment, method: PaymentMethod) {
  const bank = text(entity["bank"])?.toLowerCase() ?? null;
  const wallet = text(entity["wallet"])?.toLowerCase() ?? null;
  const card = (entity["card"] ?? {}) as Record<string, unknown>;

  /** One place enforces the hierarchy, so no branch below has to remember it. */
  const under = (issuer: string | null, instrument: string | null) =>
    slice(method, issuer, issuer === null ? null : instrument);

  if (method === "card" || method === "emi") {
    return under(
      (text(card["issuer"]) ?? bank)?.toLowerCase() ?? null,
      text(card["network"])?.toLowerCase() ?? null,
    );
  }
  if (method === "upi") {
    const handle = text(entity["vpa"])?.split("@")[1]?.toLowerCase() ?? null;
    return under(bank ?? handle, null);
  }
  if (method === "wallet") return under(wallet, null);
  return under(bank, null);
}

/**
 * The failure, in Razorpay's own vocabulary.
 *
 * Passed through rather than translated. `source`, `step` and `reason` are the triple the recovery
 * classifier reads, and re-coding them into a private enum here would put a lossy mapping between
 * the gateway's account of what went wrong and the decision made about it. A code Kairos has never
 * seen falls through to the residual path, which is what that path is for.
 */
function failureOf(entity: RazorpayPayment): FailureDetail | null {
  const code = text(entity["error_code"]);
  if (code === null) return null;
  return {
    code,
    source: text(entity["error_source"]) ?? "unknown",
    step: text(entity["error_step"]) ?? "unknown",
    reason: text(entity["error_reason"]) ?? "unknown",
    description: text(entity["error_description"]) ?? "",
  };
}

const STATUSES: Record<string, AttemptStatus> = {
  created: "created",
  authorized: "authorized",
  captured: "captured",
  failed: "failed",
  // A refund is not a failed payment. It succeeded, and something happened afterwards that this
  // stream has nothing to say about — counting it as a casualty would chase a customer whose money
  // has already been returned.
};

export function attemptFrom(entity: RazorpayPayment, options: InboundOptions): Attempt | null {
  const id = text(entity["id"]);
  const order = text(entity["order_id"]);
  const method = methodOf(entity);
  const status = STATUSES[text(entity["status"])?.toLowerCase() ?? ""];
  const amount = entity["amount"];
  const createdAt = entity["created_at"];

  const drop = (reason: string): null => {
    options.onDrop?.(reason);
    return null;
  };

  if (id === null) return drop("no payment id");
  if (method === null)
    return drop(`method ${JSON.stringify(entity["method"])} is not one Kairos models`);
  if (status === undefined)
    return drop(`status ${JSON.stringify(entity["status"])} is not an attempt outcome`);
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    return drop("amount is not a whole number of paise");
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return drop("created_at is not a timestamp");
  }

  // Contact before email: a phone number identifies an Indian customer across checkouts where an
  // email often does not, and the two must not disagree about who this is. Either is hashed before
  // it goes anywhere, and a payment with neither is still a real observation about a rail.
  const who = text(entity["contact"]) ?? text(entity["email"]) ?? `anonymous:${id}`;

  try {
    return {
      id: attemptId(id),
      // Razorpay allows a payment with no order. Its own id then stands in, which keeps the
      // reference unique and honest rather than empty.
      orderId: orderId(order ?? id),
      customer: options.pseudonymise(who),
      amount: paise(amount),
      slice: sliceOf(entity, method),
      status,
      failure: failureOf(entity),
      // Razorpay counts in seconds. Everything in Kairos counts in milliseconds, and a timestamp
      // out by a factor of a thousand lands every observation in 1970 — where a rolling window
      // silently contains nothing at all.
      at: Math.round(createdAt * 1000),
    };
  } catch (error) {
    // A domain constructor refused. Dropped for the same reason an unknown method is — but the
    // reason is passed on, because "not readable" is a sentence that ends an investigation.
    return drop(error instanceof Error ? error.message : "a domain constructor refused it");
  }
}

/** The payment inside a `payment.*` webhook, or `null` if this event carries none. */
export function paymentFrom(event: unknown): RazorpayPayment | null {
  if (typeof event !== "object" || event === null) return null;
  const payload = (event as Record<string, unknown>)["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payment = (payload as Record<string, unknown>)["payment"];
  if (typeof payment !== "object" || payment === null) return null;
  const entity = (payment as Record<string, unknown>)["entity"];
  return typeof entity === "object" && entity !== null ? (entity as RazorpayPayment) : null;
}
