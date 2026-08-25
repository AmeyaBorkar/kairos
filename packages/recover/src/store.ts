import type { Casualty, CasualtyId, CustomerRef } from "@kairos/domain";

/**
 * Where casualties live between the moment they are lost and the moment they are given up on.
 *
 * A port, because in production it is a Postgres table and in the harness it is a map, and the
 * worker must not be able to tell. The interesting method is {@link CasualtyStore.claim}.
 */
export interface CasualtyStore {
  /** Casualties due at or before `at`, oldest first. */
  due(at: number, limit: number): Promise<readonly Casualty[]>;

  /**
   * Take exclusive right to work this casualty until `until`, or fail because somebody else has it.
   *
   * **This is not the same protection Terminus provides, and the difference is worth being precise
   * about.** A Terminus reservation is idempotent on its action key, so a worker that crashes after
   * reserving and restarts will replay into the same reservation rather than taking a second one —
   * that is what makes a crash safe. But two workers running *concurrently* derive the same key,
   * and both are handed the same grant, and both would then send. Idempotent authority prevents
   * double-spending the budget; it does not prevent double-sending the message.
   *
   * So the lease is what makes the fleet safe, and it must be atomic — a read followed by a write
   * lets both workers see it free. It expires rather than being released, because a worker that
   * dies holding one must not strand the casualty for ever. `now` is passed rather than read,
   * because a store that expires leases on its own clock while its caller runs on another is a
   * store whose leases expire at times nobody intended.
   */
  claim(id: CasualtyId, now: number, until: number): Promise<boolean>;

  /** Persist a casualty and when to look at it again. `null` means never. */
  save(casualty: Casualty, dueAt: number | null): Promise<void>;

  get(id: CasualtyId): Promise<Casualty | null>;
}

/**
 * The customer's actual contact details, behind a port.
 *
 * §13's PII minimisation, made structural rather than promised. Everything else in Kairos handles a
 * {@link CustomerRef} — a keyed hash — and this is the single place a real name or a payment token
 * is resolved. A component that has not been handed this interface cannot obtain personal data no
 * matter what it decides it needs, which is a much stronger guarantee than a convention about which
 * fields to log.
 */
export interface CustomerDirectory {
  lookup(customer: CustomerRef): Promise<CustomerProfile | null>;
}

export interface CustomerProfile {
  /** Used only to address a message. Never written to the ledger. */
  readonly firstName: string | null;
  /**
   * The token or mandate this customer's payments can be charged against, if any.
   *
   * `null` for most customers, and that is the shape of the problem rather than missing data. A
   * casualty whose payment has no standing consent cannot be retried at all, however healthy its
   * rail becomes — the customer has to be present, and asking them to be present is a message.
   */
  readonly token: string | null;
}

interface Entry {
  casualty: Casualty;
  dueAt: number | null;
  leasedUntil: number;
}

/**
 * A `CasualtyStore` for one process.
 *
 * Enough for the harness and a single instance. The lease is genuinely atomic here because
 * JavaScript gives it that for free — the check and the write happen in one synchronous block with
 * no await between them, which is exactly the property the Postgres implementation has to buy with
 * `SELECT ... FOR UPDATE SKIP LOCKED`.
 */
export class MemoryCasualtyStore implements CasualtyStore {
  readonly #entries = new Map<string, Entry>();

  due(at: number, limit: number): Promise<readonly Casualty[]> {
    const ready: Entry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.dueAt === null || entry.dueAt > at) continue;
      if (entry.leasedUntil > at) continue;
      ready.push(entry);
    }
    ready.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
    return Promise.resolve(ready.slice(0, limit).map((e) => e.casualty));
  }

  claim(id: CasualtyId, now: number, until: number): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return Promise.resolve(false);
    if (entry.leasedUntil > now) return Promise.resolve(false);
    // No await between the check and the write, which is what makes this atomic here and what
    // `SELECT ... FOR UPDATE SKIP LOCKED` has to buy in Postgres.
    entry.leasedUntil = until;
    return Promise.resolve(true);
  }

  save(casualty: Casualty, dueAt: number | null): Promise<void> {
    const existing = this.#entries.get(casualty.id);
    this.#entries.set(casualty.id, {
      casualty,
      dueAt,
      leasedUntil: existing?.leasedUntil ?? 0,
    });
    return Promise.resolve();
  }

  get(id: CasualtyId): Promise<Casualty | null> {
    return Promise.resolve(this.#entries.get(id)?.casualty ?? null);
  }

  /** Everything held, for the harness's final accounting. Not part of the port. */
  all(): readonly Casualty[] {
    return [...this.#entries.values()].map((e) => e.casualty);
  }

  get size(): number {
    return this.#entries.size;
  }
}
