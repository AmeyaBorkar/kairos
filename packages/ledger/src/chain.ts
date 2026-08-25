import { createHash } from "node:crypto";
import { canonicalize, type JsonValue } from "./canonical.js";

/**
 * One audited event. Written for **every** decision Kairos makes, allowed or denied — a refusal
 * is as much a fact about the system as an action.
 */
export interface AuditRecord {
  /** Position in the chain, from 0. Gaps and reorderings are detectable. */
  readonly seq: number;
  /** Epoch milliseconds, from the injected clock. */
  readonly at: number;
  /** Which component decided, e.g. `recover-worker/3`. */
  readonly actor: string;
  /** What was proposed, from the closed action vocabulary. */
  readonly action: string;
  /** What it was about — a casualty, incident, or slice reference. Never raw personal data. */
  readonly target: string;
  /** Whether it was admitted. */
  readonly allowed: boolean;
  /** One line of why, in plain language. */
  readonly reason: string;
  /**
   * Which limit was binding, e.g. `contact-cap` or `campaign-budget`.
   *
   * This is the field that turns "the system declined to message this customer" into "declined:
   * this customer had already received 3 contacts in 7 days, cap 3". It is what makes the bound
   * explainable rather than merely enforced.
   */
  readonly binding: string | null;
  /** Gateway or provider request id, so an entry can be traced to the outside world. */
  readonly externalRef: string | null;
  /** What actually happened, once known. */
  readonly outcome: string | null;
  /** Structured detail. Must be canonicalizable. */
  readonly meta: Readonly<Record<string, JsonValue>>;
}

/** An {@link AuditRecord} sealed into the chain. */
export interface ChainedRecord extends AuditRecord {
  readonly prevHash: string;
  readonly hash: string;
}

/** The chain's anchor. A record claiming this as `prevHash` asserts it is the first. */
export const GENESIS_HASH = "0".repeat(64);

function recordToJson(r: AuditRecord): JsonValue {
  return {
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    action: r.action,
    target: r.target,
    allowed: r.allowed,
    reason: r.reason,
    binding: r.binding,
    externalRef: r.externalRef,
    outcome: r.outcome,
    meta: r.meta as { [key: string]: JsonValue },
  };
}

/**
 * `H(prevHash ‖ canonical(record))`.
 *
 * Including the previous hash is what chains it: altering any record changes its hash, which
 * invalidates every hash after it. A tamperer must rewrite the entire suffix, and if the head
 * hash has been published anywhere they cannot rewrite that.
 */
export function hashRecord(prevHash: string, record: AuditRecord): string {
  return createHash("sha256")
    .update(prevHash, "utf8")
    .update("\n", "utf8")
    .update(canonicalize(recordToJson(record)), "utf8")
    .digest("hex");
}

/** Seal a record against the current head, returning the new tail. */
export function chainRecord(prevHash: string, record: AuditRecord): ChainedRecord {
  return { ...record, prevHash, hash: hashRecord(prevHash, record) };
}

export type VerifyResult =
  | { readonly valid: true; readonly head: string; readonly length: number }
  | { readonly valid: false; readonly brokenAt: number; readonly detail: string };

/**
 * Walk a chain and confirm nothing has been altered, removed, or reordered.
 *
 * Checks three independent things, because they fail differently: hash integrity catches edits to
 * content, `prevHash` linkage catches removal and splicing, and sequence monotonicity catches
 * reordering that happens to preserve the links.
 */
export function verifyChain(records: readonly ChainedRecord[]): VerifyResult {
  let prev = GENESIS_HASH;
  let expectedSeq = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r === undefined) {
      return { valid: false, brokenAt: i, detail: "missing record" };
    }

    if (r.seq !== expectedSeq) {
      return {
        valid: false,
        brokenAt: i,
        detail: `sequence expected ${expectedSeq}, found ${r.seq}`,
      };
    }

    if (r.prevHash !== prev) {
      return {
        valid: false,
        brokenAt: i,
        detail: `link broken: expected prevHash ${prev.slice(0, 12)}…, found ${r.prevHash.slice(0, 12)}…`,
      };
    }

    const recomputed = hashRecord(r.prevHash, r);
    if (recomputed !== r.hash) {
      return {
        valid: false,
        brokenAt: i,
        detail: `content altered: hash ${r.hash.slice(0, 12)}… does not match ${recomputed.slice(0, 12)}…`,
      };
    }

    prev = r.hash;
    expectedSeq++;
  }

  return { valid: true, head: prev, length: records.length };
}

/**
 * An in-memory chain head. Durable sinks wrap this and persist each {@link ChainedRecord};
 * keeping the sealing logic here means every sink chains identically.
 */
export class Chain {
  #head: string;
  #length: number;

  constructor(head: string = GENESIS_HASH, length = 0) {
    this.#head = head;
    this.#length = length;
  }

  get head(): string {
    return this.#head;
  }

  get length(): number {
    return this.#length;
  }

  /** Seal the next record, assigning its sequence number and advancing the head. */
  append(record: Omit<AuditRecord, "seq">): ChainedRecord {
    const sealed = chainRecord(this.#head, { ...record, seq: this.#length });
    this.#head = sealed.hash;
    this.#length++;
    return sealed;
  }
}
