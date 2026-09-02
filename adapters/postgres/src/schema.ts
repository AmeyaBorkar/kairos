import { assertTableName, type SqlClient } from "./sql.js";

/**
 * The queue's DDL, as statements rather than a script.
 *
 * A list rather than one string because {@link SqlClient} is the extended protocol — one statement
 * per round trip — and splitting a script on semicolons is a parser nobody wants to own. Joined
 * back together by {@link schemaSql} for an operator who runs migrations with their own tool.
 *
 * ## The shape, and why it is this shape
 *
 * `payload` is the casualty and everything else is derived from it. The alternative — a column per
 * field — has a failure mode this does not: add a field to `Casualty`, forget the column, and the
 * field is silently dropped on the next save. Here a forgotten column costs a stale index, which
 * an operator notices, rather than lost state, which nobody does.
 *
 * The derived columns exist because a queue nobody can query is a queue nobody can operate. They
 * are rewritten from the payload on every save, so they cannot drift, and nothing in the read path
 * depends on them being right.
 */
export function schemaStatements(table = "kairos_casualty"): readonly string[] {
  const t = assertTableName(table);
  const index = t.replace(".", "_");
  return [
    `create table if not exists ${t} (
  id                          text primary key,
  payload                     jsonb not null,

  -- Everything below is derived from payload on every save. Indexes and operator ergonomics,
  -- never the authority.
  kind                        text not null,
  customer                    text not null,
  order_id                    text not null,
  slice_method                text not null,
  slice_issuer                text,
  slice_instrument            text,
  amount_paise                bigint not null,
  occurred_at                 bigint not null,
  retry                       text not null,
  recoverability              text not null,
  recovered                   boolean not null,
  opted_out                   boolean not null,
  disputed                    boolean not null,
  consecutive_hard_declines   integer not null,
  attempt_count               integer not null,

  -- When to look at this casualty again. NULL means never: recovered, given up on, or stopped.
  due_at                      bigint,

  -- The lease. A worker holds one until this instant, and this column is the entire fleet-safety
  -- story: see PostgresCasualtyStore.claim.
  leased_until                bigint not null default 0,

  updated_at                  bigint not null
)`,
    // Partial, because most casualties end their life with due_at NULL and an index that carries
    // them is an index mostly made of rows the queue will never look at again.
    `create index if not exists ${index}_due
  on ${t} (due_at, id)
  where due_at is not null`,
    // For the operator question this table gets asked most: what has been done to this person.
    `create index if not exists ${index}_customer on ${t} (customer)`,
  ];
}

/** The DDL as one script, for `psql -f` or a migration tool that wants a file. */
export function schemaSql(table = "kairos_casualty"): string {
  return `${schemaStatements(table).join(";\n\n")};\n`;
}

/**
 * Apply the DDL.
 *
 * Idempotent — every statement is `if not exists` — so it is safe to call on every boot, which is
 * what a single-service deployment will do and what the tests do. A fleet with a migration tool
 * should use {@link schemaSql} instead and keep schema changes out of the application's hands.
 */
export async function migrate(sql: SqlClient, table = "kairos_casualty"): Promise<void> {
  for (const statement of schemaStatements(table)) {
    await sql.query(statement);
  }
}
