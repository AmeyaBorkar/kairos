import type { CustomerRef, FailureDetail, OrderId, Paise } from "@kairos/domain";

/**
 * The two things Kairos can do to recover a payment, as ports.
 *
 * Both take an idempotency key rather than generating one, because the key is derived from the
 * casualty and the attempt number by Terminus — the same derivation that makes a grant replayable.
 * A worker that crashes between reserving authority and calling a gateway must, on restart, produce
 * the *same* key, or the retry it thinks is a first attempt is a second charge.
 *
 * Both report their own cost, because neither knows it in advance. A charge that never reaches
 * authorisation costs nothing; a message costs a segment count nobody can predict before the text
 * exists. Terminus reserves a ceiling and reconciles against whatever comes back here.
 */

export interface RetryRequest {
  /** Derived from the casualty and attempt number. Two calls with this key must charge once. */
  readonly idempotencyKey: string;
  readonly orderId: OrderId;
  readonly customer: CustomerRef;
  readonly amount: Paise;
  /**
   * The token or mandate to charge against.
   *
   * Not optional, and that is the point. There is no way to express "retry a one-off payment"
   * because there is no such operation: without standing consent the customer has to be present,
   * and asking them to be present is a message, not a retry.
   */
  readonly token: string;
}

export interface RetryResult {
  readonly outcome: "recovered" | "declined-soft" | "declined-hard";
  /** What it actually cost. Zero for a decline — Razorpay bills on capture, not on attempt. */
  readonly costPaise: number;
  /** Razorpay's payment id, so the record reconciles against their books. */
  readonly externalRef: string | null;
  /** The failure, when there was one. Feeds straight back into classification. */
  readonly failure: FailureDetail | null;
}

/** Charges a payment again with nobody present. */
export interface Gateway {
  readonly name: string;
  charge(request: RetryRequest): Promise<RetryResult>;
}

export type MessageChannel = "contact-sms" | "contact-whatsapp" | "contact-email";

export interface MessageRequest {
  readonly idempotencyKey: string;
  readonly channel: MessageChannel;
  readonly customer: CustomerRef;
  /** The composed text. Composition happens before dispatch so its cost can be measured first. */
  readonly text: string;
  /** Segments, for the channels that bill by them. */
  readonly segments: number;
}

export interface MessageResult {
  /** Whether it reached anybody. An undeliverable message still costs nothing and recovers nothing. */
  readonly delivered: boolean;
  readonly costPaise: number;
  readonly externalRef: string | null;
}

/** Sends a message to a customer. */
export interface Messenger {
  readonly name: string;
  send(request: MessageRequest): Promise<MessageResult>;
}
