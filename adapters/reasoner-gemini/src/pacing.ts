/**
 * Two bounds on how often we may call, enforced by two different mechanisms, because they are two
 * different kinds of thing.
 *
 * **Requests per minute is a rate.** You do not exceed it, you wait for it — so it is a shaper, and
 * the wait is the whole mechanism. Measured on a free-tier key: fifteen. Firing eighteen concurrent
 * requests produced sixteen answers and two refusals, and the refusals cost as much quota as the
 * answers did.
 *
 * **Requests per day is a budget.** Waiting it out means waiting until tomorrow, which is not
 * waiting, it is stopping. So it is a limiter, a refusal is final for this run, and the caller is
 * expected to come back tomorrow and resume — which is exactly why generating the copy library is
 * built to be resumable rather than atomic.
 *
 * That is the same distinction `price.ts` draws between a budget and a rate limit, arriving from the
 * other side: Terminus governs the money, this governs the requests, and neither can stand in for
 * the other.
 *
 * ## Rolling, not calendar
 *
 * The daily quota is a trailing twenty-four hours rather than a reset at a stated hour. Google's
 * free-tier day almost certainly ends at midnight in a timezone we would have to guess, and a
 * rolling window can only ever be more conservative than a calendar one: it never permits a burst
 * the calendar boundary would have refused. Guessing the boundary wrong in the other direction
 * spends a day's quota in an hour. Same argument as the contact cap, for the same reason.
 */

import { type Clock, leakyBucket, MemoryStore, quota, rateLimit, type Store } from "throttlekit";
import { GeminiError, type QuotaViolation } from "./errors.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface PacingOptions {
  /** The published per-minute ceiling. Corrected downward by {@link Pace.learn} if the server disagrees. */
  readonly requestsPerMinute: number;
  readonly requestsPerDay: number;
  /** How long a call may wait its turn before being refused instead. */
  readonly maxQueueMs?: number;
  readonly store?: Store;
  readonly clock?: Clock;
  readonly prefix?: string;
  /** Injected so a test can pace a thousand calls in no time at all. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Pace {
  /**
   * Wait until it is this call's turn.
   *
   * Throws a `throttled` {@link GeminiError} when the day's quota is spent or the queue is longer
   * than the caller is willing to wait for. Resolves — after however long the rate requires — when
   * the call may be made.
   */
  take(key: string): Promise<void>;
  /**
   * Correct the rate from a limit the server named in a 429.
   *
   * Only ever downward. A server reporting a *higher* limit than we configured is not permission to
   * speed up: our number was chosen, theirs is whatever tier we happen to be on today, and a pacer
   * that ratchets open on good news is a pacer that eventually finds the ceiling by hitting it.
   *
   * Returns whether anything changed.
   */
  learn(violation: QuotaViolation): boolean;
  /** The rate currently in force, which is not always the one configured. */
  readonly requestsPerMinute: number;
  /** Calls left in the trailing day, without consuming one. */
  remaining(key: string): Promise<number>;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** Requests per minute below which the pacer refuses to operate rather than crawl. */
const MIN_RPM = 1;

export function pacer(options: PacingOptions): Pace {
  const store = options.store ?? new MemoryStore();
  const prefix = options.prefix ?? "gemini";
  const sleep = options.sleep ?? defaultSleep;
  const maxQueueMs = options.maxQueueMs ?? 5 * MINUTE;

  let rpm = Math.max(MIN_RPM, Math.floor(options.requestsPerMinute));

  const buildShaper = (rate: number) =>
    leakyBucket({
      ratePerSec: rate / 60,
      maxQueueMs,
      store,
      prefix: `${prefix}:rpm:${rate}`,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });

  let shaper = buildShaper(rpm);

  const daily = rateLimit({
    // Consumed once per call and never released: a refused call still counted against the day, as
    // the two 429s in the probe run did. Pretending otherwise would overrun the quota by exactly
    // the number of times we got it wrong.
    strategy: quota({ limit: options.requestsPerDay, resetCadence: "rolling", periodMs: DAY }),
    store,
    prefix: `${prefix}:rpd`,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const peek = daily.peek?.bind(daily);

  return {
    get requestsPerMinute() {
      return rpm;
    },

    async take(key) {
      // The shaper first, because reserving a slot is free and reversible in effect — the worst it
      // does is leave a gap in the pacing. Consuming the day's quota is neither.
      const slot = await shaper.reserve(key);
      if (!slot.accepted) {
        throw new GeminiError(
          `paced out: the queue is longer than ${maxQueueMs}ms at ${rpm} requests/minute`,
          { kind: "throttled", retryAfterMs: slot.delayMs },
        );
      }

      const day = await daily.check(key);
      if (!day.allowed) {
        throw new GeminiError(
          `the day's quota of ${options.requestsPerDay} requests is spent; resume when it rolls over`,
          { kind: "throttled", retryAfterMs: day.retryAfterMs },
        );
      }

      await sleep(slot.delayMs);
    },

    learn(violation) {
      if (violation.limit === null || violation.limit >= rpm) return false;
      rpm = Math.max(MIN_RPM, violation.limit);
      // A new shaper starts with an empty queue, which is correct here and only here: we arrive in
      // this branch having *already* been refused, so there is no pending departure worth keeping,
      // and the caller is about to wait out the server's own retry hint anyway.
      shaper = buildShaper(rpm);
      return true;
    },

    async remaining(key) {
      if (peek === undefined) {
        throw new Error("pacing requires a store that supports non-consuming reads");
      }
      return (await peek(key)).remaining;
    },
  };
}
