/**
 * The only thing this adapter needs from a database.
 *
 * A port rather than a dependency on `pg`, for the same reason `Gateway` and `Messenger` are ports:
 * the driver is the merchant's choice, and Kairos importing one would make it Kairos's. The shape
 * is deliberately the intersection of every Postgres client in common use — `pg.Pool`, `pg.Client`,
 * a `pg` pool wrapped in tracing, PGlite, a Neon or Supabase serverless client — so a merchant
 * passes the pool they already have and nothing needs adapting:
 *
 * ```ts
 * import { Pool } from "pg";
 * const store = new PostgresCasualtyStore({ sql: new Pool({ connectionString }) });
 * ```
 *
 * It is also the whole reason this package has no runtime dependencies and its tests run against a
 * real PostgreSQL without a daemon.
 */
export interface SqlResult<R> {
  readonly rows: readonly R[];
}

export interface SqlClient {
  query<R>(text: string, values?: readonly unknown[]): Promise<SqlResult<R>>;
}

/**
 * A table name that is safe to interpolate, because parameters cannot carry one.
 *
 * Every value in this adapter is bound; the table is the single exception SQL does not allow to be
 * bound, so it is validated instead of escaped. Lower-case identifiers only, optionally
 * schema-qualified, which is a narrower rule than Postgres's own — an operator who wants
 * `"Weird Name"` can have a view.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function assertTableName(name: string): string {
  const parts = name.split(".");
  if (parts.length > 2 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new Error(
      `${JSON.stringify(name)} is not a table name this adapter will interpolate. Expected ` +
        "`table` or `schema.table`, lower-case, starting with a letter or underscore.",
    );
  }
  return name;
}
