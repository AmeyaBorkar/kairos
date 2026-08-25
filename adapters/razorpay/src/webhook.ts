import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay webhook verification.
 *
 * Three separate things have to be true before a webhook is allowed to change any state, and they
 * fail for different reasons: the signature has to verify, the event has to be recent, and it has
 * to be one we have not already processed. Missing any one of them turns the endpoint into a way
 * for anyone who has ever seen a valid payload to mark payments recovered.
 */

export type WebhookVerdict =
  | { readonly ok: true; readonly eventId: string; readonly event: string }
  | { readonly ok: false; readonly reason: WebhookRejection };

export type WebhookRejection =
  | "missing-signature"
  | "bad-signature"
  | "malformed-body"
  | "missing-event-id"
  | "stale"
  | "replayed";

export interface WebhookOptions {
  readonly secret: string;
  /** How old an event may be and still be acted on. */
  readonly toleranceMs: number;
  /** Remembers event ids. Injected because in production it is Redis, not a Set. */
  readonly seen: SeenEvents;
  readonly now: () => number;
}

/**
 * Whether an event id has been handled before.
 *
 * `remember` returns false if the id was already present, so the check and the record are one
 * atomic operation. Two workers receiving the same redelivered webhook simultaneously must not both
 * conclude they are the first, and a read-then-write pair cannot promise that.
 */
export interface SeenEvents {
  remember(eventId: string, expiresAt: number): Promise<boolean>;
}

/**
 * A `SeenEvents` for one process. Enough for a single instance; Redis for a fleet.
 *
 * Takes the same clock the verifier does, and that is not a stylistic preference. An earlier
 * version expired entries against `Date.now()` while the verifier ran on an injected clock, so
 * every event was purged the instant it was recorded and every replay sailed through — a
 * deduplication table that silently deduplicated nothing. Two clocks in one decision is a bug
 * whatever the clocks say.
 */
export function memorySeenEvents(now: () => number = Date.now): SeenEvents {
  const seen = new Map<string, number>();
  return {
    remember(eventId, expiresAt) {
      const at = now();
      for (const [id, expiry] of seen) if (expiry <= at) seen.delete(id);
      if (seen.has(eventId)) return Promise.resolve(false);
      seen.set(eventId, expiresAt);
      return Promise.resolve(true);
    },
  };
}

/**
 * Verify a webhook against the **raw** request body.
 *
 * The rawness is the whole thing. Razorpay signs the bytes they sent, and `JSON.parse` followed by
 * `JSON.stringify` does not reproduce them — key order, unicode escapes and number formatting all
 * move. A verifier that re-serialises will reject legitimate webhooks in ways that look like a
 * signature problem, and the usual fix for that is to stop verifying.
 *
 * Comparison is constant-time. The timing of a byte-by-byte comparison leaks the correct prefix,
 * and a signature is short enough to be recovered that way by anyone patient.
 */
export async function verifyWebhook(
  rawBody: string,
  signature: string | null,
  options: WebhookOptions,
): Promise<WebhookVerdict> {
  if (signature === null || signature.length === 0) {
    return { ok: false, reason: "missing-signature" };
  }

  const expected = createHmac("sha256", options.secret).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return { ok: false, reason: "bad-signature" };
  }

  // Length is checked first because `timingSafeEqual` throws on a mismatch rather than returning
  // false, and a thrown verifier is a verifier somebody wraps in a try/catch that returns true.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "malformed-body" };
  }

  const envelope = readEnvelope(payload);
  if (envelope === null) return { ok: false, reason: "missing-event-id" };

  // A correctly-signed webhook is still a replay if it arrives a week later. Razorpay's `created_at`
  // is inside the signed body, so an attacker cannot move it without breaking the signature.
  const age = options.now() - envelope.createdAtMs;
  if (Math.abs(age) > options.toleranceMs) return { ok: false, reason: "stale" };

  const fresh = await options.seen.remember(
    envelope.eventId,
    options.now() + options.toleranceMs * 2,
  );
  if (!fresh) return { ok: false, reason: "replayed" };

  return { ok: true, eventId: envelope.eventId, event: envelope.event };
}

interface Envelope {
  readonly eventId: string;
  readonly event: string;
  readonly createdAtMs: number;
}

/**
 * Razorpay puts the event id in a header on delivery and `created_at` in the body.
 *
 * Only the body is signed, so the id used for deduplication is derived from signed fields rather
 * than taken from the header — an id an attacker can choose is an id an attacker can use to make
 * one replay look like a hundred distinct events.
 */
function readEnvelope(payload: unknown): Envelope | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const event = record["event"];
  const createdAt = record["created_at"];
  if (typeof event !== "string" || typeof createdAt !== "number") return null;

  const entityId = readEntityId(record);
  if (entityId === null) return null;

  return { eventId: `${event}:${entityId}:${createdAt}`, event, createdAtMs: createdAt * 1000 };
}

/** The id of whatever the event is about — `payment.entity.id`, `order.entity.id`, and so on. */
function readEntityId(record: Record<string, unknown>): string | null {
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;

  for (const wrapper of Object.values(payload as Record<string, unknown>)) {
    if (typeof wrapper !== "object" || wrapper === null) continue;
    const entity = (wrapper as Record<string, unknown>)["entity"];
    if (typeof entity !== "object" || entity === null) continue;
    const id = (entity as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}
