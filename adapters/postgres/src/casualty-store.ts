import type { Casualty, CasualtyId } from "@kairos/domain";
import type { CasualtyStore } from "@kairos/recover";
import { parseCasualty } from "./codec.js";
import { assertTableName, type SqlClient } from "./sql.js";

export interface PostgresCasualtyStoreOptions {
  /** Any Postgres client. See {@link SqlClient} — a `pg.Pool` satisfies it as-is. */
  readonly sql: SqlClient;
  /** Defaults to `kairos_casualty`. Validated, because a table cannot be a bound parameter. */
  readonly table?: string;
}

interface PayloadRow {
  readonly payload: unknown;
}

/** Every column, in the order the insert binds them. Written out so the two cannot drift. */
const COLUMNS = [
  "id",
  "payload",
  "kind",
  "customer",
  "order_id",
  "slice_method",
  "slice_issuer",
  "slice_instrument",
  "amount_paise",
  "occurred_at",
  "retry",
  "recoverability",
  "recovered",
  "opted_out",
  "disputed",
  "consecutive_hard_declines",
  "attempt_count",
  "due_at",
] as const;

/**
 * Everything the upsert overwrites.
 *
 * `leased_until` is absent on purpose — see {@link PostgresCasualtyStore.save}.
 */
const REFRESHED = COLUMNS.filter((c) => c !== "id");

/** The database's own clock, in epoch milliseconds. See {@link PostgresCasualtyStore.save}. */
const DB_NOW = "(extract(epoch from clock_timestamp()) * 1000)::bigint";

/**
 * The casualty queue in Postgres.
 *
 * The difference between one worker and a fleet, and the only thing standing between them was this
 * class: everything else in the recovery arm was already written against
 * {@link CasualtyStore | the port} and cannot tell which implementation it has.
 *
 * ## What a second worker actually needs
 *
 * Two protections, and they are not the same protection.
 *
 * Terminus already stops two workers *double-spending*: a reservation is idempotent on its action
 * key, and the budget lives in a store both workers share, so the money bound holds however many
 * processes are running. What it does not stop is two workers deriving the same key, both being
 * handed the same grant, and both sending the message. Idempotent authority protects the budget;
 * it does not protect the customer's phone.
 *
 * That is what the lease is for, and it is why `claim` has to be atomic rather than merely careful.
 *
 * ## The clock, and which one is used where
 *
 * The lease runs on the *caller's* clock, because the port says so and the reason is good: a lease
 * that expires on a clock the worker cannot read expires at a time nobody intended. `updated_at`
 * runs on the *database's* clock, because it answers an operator's question about a row rather
 * than a question about a decision, and a fleet with skewed clocks should not disagree about when
 * a row last changed. Nothing in the decision path reads it.
 */
export class PostgresCasualtyStore implements CasualtyStore {
  readonly #sql: SqlClient;
  readonly #table: string;

  constructor(options: PostgresCasualtyStoreOptions) {
    this.#sql = options.sql;
    this.#table = assertTableName(options.table ?? "kairos_casualty");
  }

  /**
   * Casualties due at or before `at` and not currently leased, oldest first.
   *
   * A plain read. It does not lock, does not claim, and two workers calling it concurrently will
   * both be handed the same rows — which is correct, because {@link claim} is what arbitrates, and
   * a read that pretended to arbitrate would have to hold a transaction open across the caller's
   * entire decision.
   *
   * The `id` tiebreak is not decoration: without it two casualties queued in the same millisecond
   * come back in whatever order the plan happens to produce, and a fleet then disagrees about
   * which one it saw first. Ordering that is stable is ordering that can be reasoned about during
   * an incident.
   */
  async due(at: number, limit: number): Promise<readonly Casualty[]> {
    const { rows } = await this.#sql.query<PayloadRow>(
      `select payload from ${this.#table}
        where due_at is not null and due_at <= $1 and leased_until <= $1
        order by due_at asc, id asc
        limit $2`,
      [at, limit],
    );
    return rows.map((r) => parseCasualty(r.payload));
  }

  /**
   * Take exclusive right to work this casualty until `until`, or fail because somebody else has it.
   *
   * One statement, so there is no window between the check and the write for a second worker to
   * fit into: Postgres serialises concurrent updates of the same row, and the loser re-evaluates
   * its `where` clause against the winner's committed value and matches nothing.
   *
   * **Not `SELECT ... FOR UPDATE SKIP LOCKED`,** which is the usual queue answer and is the wrong
   * tool here. A row lock lives and dies with its transaction, and this lease has to outlive the
   * transaction by minutes — it covers a charge or a message, not a database write. The lock would
   * be released the moment the claim committed, which is precisely when the protection needs to
   * begin. So the lease is a column, the column is guarded by the `where` clause, and no
   * transaction is held open at all.
   *
   * It expires rather than being released, because a worker that dies holding one must not strand
   * the casualty for ever.
   */
  async claim(id: CasualtyId, now: number, until: number): Promise<boolean> {
    const { rows } = await this.#sql.query<{ id: string }>(
      `update ${this.#table}
        set leased_until = $3, updated_at = ${DB_NOW}
        where id = $1 and leased_until <= $2
        returning id`,
      [id, now, until],
    );
    return rows.length === 1;
  }

  /**
   * Persist a casualty and when to look at it again. `null` means never.
   *
   * An upsert that rewrites everything **except the lease**. That exclusion is the load-bearing
   * line in this method: the worker saves a casualty in the middle of a drain pass, while still
   * holding its lease, and an upsert that reset `leased_until` to its default would hand the
   * casualty to a second worker the instant the first one recorded progress on it — the exact
   * failure the lease exists to prevent, introduced by the code that respects it.
   */
  async save(casualty: Casualty, dueAt: number | null): Promise<void> {
    const placeholders = COLUMNS.map((_, i) => (i === 1 ? "$2::jsonb" : `$${i + 1}`)).join(", ");
    const refresh = REFRESHED.map((c) => `${c} = excluded.${c}`).join(", ");

    await this.#sql.query(
      `insert into ${this.#table} (${COLUMNS.join(", ")}, updated_at)
        values (${placeholders}, ${DB_NOW})
        on conflict (id) do update set ${refresh}, updated_at = ${DB_NOW}`,
      [
        casualty.id,
        // Stringified here rather than left to the driver, because whether a given driver turns an
        // object into jsonb, into a Postgres array literal, or into an error is the driver's
        // business — and this must not depend on which one the merchant passed.
        JSON.stringify(casualty),
        casualty.kind,
        casualty.customer,
        casualty.orderId,
        casualty.slice.method,
        casualty.slice.issuer,
        casualty.slice.instrument,
        casualty.amount,
        casualty.occurredAt,
        casualty.retry,
        casualty.status.recoverability,
        casualty.status.recovered,
        casualty.status.optedOut,
        casualty.status.disputed,
        casualty.status.consecutiveHardDeclines,
        casualty.attempts.length,
        dueAt,
      ],
    );
  }

  async get(id: CasualtyId): Promise<Casualty | null> {
    const { rows } = await this.#sql.query<PayloadRow>(
      `select payload from ${this.#table} where id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : parseCasualty(row.payload);
  }
}
