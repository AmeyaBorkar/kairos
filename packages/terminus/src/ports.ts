import type { Mandate } from "@kairos/domain";
import type { AuditRecord } from "@kairos/ledger";

/**
 * Time, injected.
 *
 * Nothing in Terminus reads the clock directly. Every bound that involves time — reservation
 * expiry, mandate validity, quiet hours, the contact window — is therefore replayable: a test can
 * drive a week of campaign in a millisecond, and a decision from last month can be reproduced
 * exactly by supplying the timestamp it was made at (P4).
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock a test drives by hand. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }

  set(at: number): void {
    this.#now = at;
  }
}

/**
 * A clock that runs at a multiple of another, starting from the same instant.
 *
 * Here rather than in an application because it is a combinator over this port and every bound
 * Terminus enforces reads through it — so scaling it scales reservation TTLs, contact windows,
 * quiet hours and mandate validity *together*, in one consistent frame, rather than opening a gap
 * between two of them that a caller assembling this themselves could easily miss.
 *
 * It exists for demonstrations. Recovery is slow on purpose: backoff rungs measured in half-hours,
 * quiet hours that hold a message until morning, a wait for the moment a customer is likely to have
 * money. Those are decisions the system is right to make and none of them is watchable in real
 * time, so the honest way to show them is to move the clock rather than to shorten the rules.
 *
 * It scales the process's sense of time and not the world's: a gateway's rate limit, a provider's
 * throughput and a person's patience are all still in real seconds. Anything that can reach a
 * customer must therefore refuse to run against one of these, and that refusal belongs at the edge
 * where delivery is configured, because only there is it known.
 */
export function scaledClock(speed: number, base: Clock = systemClock): Clock {
  if (speed === 1) return base;

  const startedAt = base.now();
  return { now: () => startedAt + Math.round((base.now() - startedAt) * speed) };
}

/**
 * Where audit records go. The sequence number is assigned by the chain, not the caller.
 *
 * A rejected promise is not a logging inconvenience: per P8 it means the decision is unrecorded,
 * and an unrecorded decision must not become an action.
 */
export interface AuditSink {
  append(record: Omit<AuditRecord, "seq">): Promise<void>;
}

/**
 * The out-of-band stop.
 *
 * Separate from the mandate's own `killSwitch` flag on purpose. The signed flag cannot be cleared
 * by anyone who cannot sign; this one can be flipped in the shared store and takes effect fleet-wide
 * on the next admission, with no redeploy and no re-signing. Either one stops everything.
 *
 * A read that *fails* counts as engaged. That is P2 applied to the stop itself: if we cannot tell
 * whether we have been told to stop, we have been told to stop.
 */
export interface KillSwitch {
  engaged(mandate: Mandate): Promise<boolean>;
}

/** The kill switch nobody has flipped. */
export const openKillSwitch: KillSwitch = { engaged: () => Promise.resolve(false) };
