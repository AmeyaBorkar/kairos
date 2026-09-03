import { migrate } from "@kairos/postgres";
import { type KillSwitch, openKillSwitch, StopSwitch } from "@kairos/terminus";
import { Pool } from "pg";
import { MemoryStore, type Store } from "throttlekit";
import { PostgresStore } from "throttlekit/postgres";

/**
 * Where this sentry's bounds live, and therefore how many of it may run at once.
 *
 * The service is stateless in the sense that matters — the detector state and the rail window are
 * estimates that rebuild themselves from traffic, and an instance that restarts simply steers
 * nothing until it has an opinion. What is *not* rebuildable is the blast-radius cap: `maxInFlight`
 * inside Terminus is the "at most three steers at once" bound from the architecture, and two
 * sentries each holding their own store hold three steers **each**.
 *
 * So without a database this is one instance by construction, and with one it is a fleet sharing a
 * single cap taken by the same atomic step. The same environment variable that turns the recovery
 * worker into a fleet does it here, for the same reason and against the same database.
 */
export interface SentryBacking {
  readonly name: string;
  readonly store: Store;
  readonly killSwitch: KillSwitch;
  close(): Promise<void>;
}

export async function backing(
  env: Record<string, string | undefined> = process.env,
): Promise<SentryBacking> {
  const url = env["KAIROS_DATABASE_URL"];

  if (url === undefined) {
    return {
      name: "memory",
      // Sweeping is off because every key here has a TTL Terminus already respects, and a timer in
      // a request-driven service is background work it does not otherwise have.
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      // Nothing to consult. A per-process stop switch could only stop the process holding it, and
      // an operator who ran one command expecting the fleet to halt would be worse off than one
      // who knows there is no switch here at all.
      killSwitch: openKillSwitch,
      close: () => Promise.resolve(),
    };
  }

  const pool = new Pool({ connectionString: url, max: 10 });
  if (env["KAIROS_DB_MIGRATE"] !== "off") await migrate(pool);

  const store = new PostgresStore({ pool, table: "kairos_throttle" });
  return {
    name: "postgres",
    store,
    killSwitch: new StopSwitch(store),
    close: async () => {
      // ThrottleKit does not end a pool it does not own, so the order matters: stop its sweep
      // first, then close the pool underneath it.
      await store.close();
      await pool.end();
    },
  };
}
