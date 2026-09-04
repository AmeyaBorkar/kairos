/**
 * How fast this worker's clock is allowed to run, and when it is not allowed to run fast at all.
 *
 * The clock itself is `scaledClock` in Terminus, because it is a combinator over the port every
 * bound is measured against. What belongs here is the refusal, which needs a fact only this process
 * has: how actions are delivered.
 */

export const MAX_SPEED = 3600;

/**
 * Read the speed from the environment, and refuse the combination that would matter.
 *
 * An accelerated clock scales this process's sense of time; it does not scale the world's. A
 * contact cap of three messages a week becomes three messages per accelerated week, which against a
 * real phone is three messages every few minutes — and a rate limit the gateway agreed to in real
 * seconds is now being spent sixty times faster than it was granted. That is not a configuration to
 * warn about. It is one to refuse, here, before a pool is opened or a mandate is sealed.
 */
export function clockSpeedFrom(env: Record<string, string | undefined>, delivery: string): number {
  const raw = env["KAIROS_CLOCK_SPEED"];
  if (raw === undefined) return 1;

  const speed = Number(raw);
  if (!Number.isFinite(speed) || speed < 1 || speed > MAX_SPEED) {
    throw new Error(
      `KAIROS_CLOCK_SPEED must be between 1 and ${MAX_SPEED}, received ${JSON.stringify(raw)}`,
    );
  }
  if (speed !== 1 && delivery !== "dry-run") {
    throw new Error(
      "KAIROS_CLOCK_SPEED may only be used with dry-run delivery. An accelerated clock compresses " +
        "every contact cap and every backoff into a window the outside world never agreed to, and " +
        "the first thing it would do is message a real person sixty times faster than the mandate " +
        "intended.",
    );
  }
  return speed;
}
