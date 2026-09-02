# 8. The casualty lease is a column, not a row lock

- **Status** — accepted
- **Date** — 2026-09-03
- **Constrains** — `adapters/postgres`'s implementation of `CasualtyStore`, and therefore whether
  `apps/recover-worker` may be run more than once

## Context

`CasualtyStore` has always been a port with two implementations in mind: a map for the harness and a
table for a deployment. Only the map existed, so the recovery worker was a single instance holding
its own queue, and the port's `claim` method — the thing that makes a fleet safe — had never been
implemented against a database.

It is worth being exact about what `claim` is for, because Terminus already provides a protection
that looks similar and is not.

A Terminus reservation is idempotent on its action key. A worker that crashes after reserving and
restarts replays into the same reservation rather than taking a second one, so the budget bound
holds across a crash. But two workers running *concurrently* derive the same key from the same
casualty, and both are handed the same grant, and both would then send. **Idempotent authority
prevents double-spending the budget; it does not prevent double-sending the message.** One protects
the merchant's money, the other protects a customer's phone, and only the second one is missing.

So the queue needs a mutual exclusion that a second worker cannot talk its way past, and the obvious
answer — the one the port's own docstring reached for — is the standard Postgres work-queue pattern:

```sql
BEGIN;
SELECT id FROM queue WHERE due_at <= now FOR UPDATE SKIP LOCKED LIMIT 64;
UPDATE queue SET claimed_by = $worker WHERE id = ANY($ids);
COMMIT;
```

## Decision

**The lease is a `leased_until` column, taken by a single guarded `UPDATE`, and no row lock is held
at all.**

```sql
UPDATE kairos_casualty
   SET leased_until = $until, updated_at = <db clock>
 WHERE id = $1 AND leased_until <= $2
RETURNING id;
```

A claim succeeds when it returns a row and fails when it returns none. Postgres serialises concurrent
updates of the same row, so the loser re-evaluates its `WHERE` clause against the winner's committed
value, matches nothing, and is told so.

## Why `FOR UPDATE SKIP LOCKED` is the wrong tool here

**A row lock lives and dies with its transaction, and this lease has to outlive the transaction by
minutes.** The lease does not cover a database write. It covers a charge against a saved token or a
message to a person — work that happens outside the database, takes seconds to minutes, and must not
be started twice. `SKIP LOCKED` would release its protection at `COMMIT`, which is exactly the
instant the protection needs to begin.

The standard pattern works around this by writing a `claimed_by` or `claimed_until` column *inside*
the locked transaction — at which point the column is doing the work and the lock is only serialising
two writers who were going to serialise anyway. Taking the column and dropping the lock removes a
moving part and a transaction, and leaves the same guarantee.

**It also keeps `due` honest.** The port splits reading from claiming, and there is no way to hold a
`SELECT ... FOR UPDATE` open across the caller's whole decision — that decision is a classification,
a model prediction, an admission and an execution. So `due` is a plain read that does not arbitrate
and does not pretend to; two workers get the same batch and exactly one wins each row. The wasted
work is bounded by the batch size and is the price of not holding a transaction open across a
network call to a payment gateway.

**The lease expires rather than being released.** A worker that dies holding one must not strand a
casualty for ever, and a dead worker cannot release anything. `now` is the caller's clock, not the
database's, for the reason the port gives: a store that expires leases on a clock its caller cannot
read expires them at times nobody intended.

## What the row holds, and what is authoritative

The casualty itself is a `jsonb` payload; every other column is derived from it on each save. The
alternative — a column per field — has a failure mode this does not: add a field to `Casualty`,
forget the column, and the field is silently dropped on the next write. Here a forgotten column costs
a stale index, which an operator notices, rather than lost state, which nobody does.

The derived columns exist because a queue nobody can query is a queue nobody can operate. Nothing in
the read path depends on them.

Reading is a validation boundary even though this process wrote the row. Between the write and the
read sit a schema migration, an older build of the service, a support engineer with `psql`, and a
restore from a backup taken mid-deploy. A casualty that comes back subtly wrong does not announce
itself — it becomes a slice the detector cannot reason about, or a status the stopping rules read as
"keep going" — so every field goes back through the domain's own constructors rather than a cast.

## Consequences

**The recovery worker is horizontally scalable, and one environment variable is the difference.**
With `KAIROS_DATABASE_URL` set, the queue and the spend authority both live in Postgres. Without it
both live in memory and the worker is a single instance by construction, which is a legitimate way to
run it and much better than a second copy quietly sharing nothing.

**The adapter has no runtime dependency.** It talks to a `SqlClient` port whose shape is the
intersection of every Postgres client in common use, so a `pg.Pool` satisfies it as-is and the driver
stays the merchant's choice. That is also what lets the SQL be tested against a real PostgreSQL 18 —
PGlite, the server compiled to WebAssembly — in the ordinary unit suite, with no daemon and no
service container.

**The audit ledger is still per-process.** A fleet shares its queue and its budget but produces one
hash chain per worker: each internally verifiable, none of them the whole story. Nothing is lost and
nothing is forgeable, but "show me everything done under this mandate" has to be answered by
interleaving N chains. A shared appender is the remaining piece and it is not built.
