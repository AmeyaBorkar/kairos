import type { ContactCap, CustomerRef } from "@kairos/domain";
import { type Decision, quota, rateLimit, type Store } from "throttlekit";
import type { Clock } from "./ports.js";

/**
 * How many messages one person may receive, and how long until that changes.
 *
 * This is the bound with the sharpest edge on it. Exceeding a budget costs the merchant money;
 * exceeding a contact cap costs a person their evening, and at scale it costs the merchant a
 * regulatory complaint. It is enforced by the same atomic primitive as the budget so that a fleet
 * of workers chasing the same cohort cannot each decide independently that this customer is due one
 * more message.
 */
export interface ContactLedger {
  /** What the cap would say, without consuming. */
  peek(customer: CustomerRef): Promise<Decision>;
  /** Consume one contact allowance. A refusal consumes nothing. */
  consume(customer: CustomerRef): Promise<Decision>;
}

export interface ContactLedgerOptions {
  readonly cap: ContactCap;
  readonly store: Store;
  readonly clock: Clock;
  /** Key namespace, so one store can hold caps for many campaigns without collision. */
  readonly prefix: string;
}

/**
 * A rolling-window contact cap.
 *
 * Rolling rather than calendar: "3 in the last 7 days" is the promise a merchant can actually make
 * to a customer. A calendar week would let someone receive three messages on Sunday night and three
 * more on Monday morning — six contacts in twelve hours, every one of them inside the cap.
 *
 * The window state is keyed per customer, and the key is already a pseudonymous reference, so the
 * cap can be enforced across the fleet without a phone number leaving the one store that holds it.
 */
export function contactLedger(options: ContactLedgerOptions): ContactLedger {
  const limiter = rateLimit({
    strategy: quota({
      limit: options.cap.limit,
      resetCadence: "rolling",
      periodMs: options.cap.windowMs,
    }),
    store: options.store,
    clock: options.clock,
    prefix: options.prefix,
  });

  const peek = limiter.peek?.bind(limiter);

  return {
    async peek(customer) {
      if (peek === undefined) {
        // A store without a non-consuming read is a configuration this kernel cannot make safe: the
        // alternative is to consume in order to look, which turns every downstream refusal into a
        // silently burned contact allowance. Refuse to guess.
        throw new Error("contact cap requires a store that supports non-consuming reads");
      }
      return peek(customer);
    },
    consume(customer) {
      return limiter.check(customer);
    },
  };
}
