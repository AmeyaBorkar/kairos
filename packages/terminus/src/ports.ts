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
