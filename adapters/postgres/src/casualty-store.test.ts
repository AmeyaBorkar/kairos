import { PGlite } from "@electric-sql/pglite";
import {
  type Casualty,
  casualtyId,
  customerRef,
  DomainError,
  type FailureDetail,
  mandateId,
  openCasualty,
  orderId,
  paise,
  slice,
} from "@kairos/domain";
import { MemoryLedger } from "@kairos/ledger";
import {
  type CasualtyStore,
  type CustomerDirectory,
  classify,
  DEFAULT_RECOVERY_CONFIG,
  type ExecuteRequest,
  type ExecuteResult,
  type Executor,
  MemoryCasualtyStore,
  type RailGauge,
  RecoverWorker,
  RecoveryModel,
} from "@kairos/recover";
import { ManualClock, sealMandate, Terminus } from "@kairos/terminus";
import { MemoryStore } from "throttlekit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresCasualtyStore } from "./casualty-store.js";
import { migrate, schemaSql } from "./schema.js";
import { assertTableName } from "./sql.js";

/**
 * These run against a real PostgreSQL 18 — PGlite is the actual server compiled to WebAssembly,
 * not a mock and not a dialect translator. So the SQL in this adapter is executed by the planner
 * that will execute it in production, and a syntax error, a type mismatch or a mis-numbered
 * placeholder fails here rather than at 2 a.m.
 *
 * The one thing it cannot reproduce is a second *connection*. PGlite serialises everything through
 * one, so the interleavings below prove the property the guarded `UPDATE` actually depends on — a
 * claim evaluating its `where` clause against another claim's committed value — rather than
 * genuine row-lock contention. That is the mechanism being relied upon; two backends fighting over
 * the same row reduce to it.
 */

const SECRET = "a-secret-that-lives-in-a-vault-not-a-repo";
const AT = Date.UTC(2026, 7, 25, 6, 0, 0);
const DAY = 86_400_000;
const MINUTE = 60_000;

const BANK_TIMEOUT: FailureDetail = {
  code: "GATEWAY_ERROR",
  source: "bank",
  step: "payment_authorization",
  reason: "payment_timed_out_at_bank",
  description: "Bank did not respond in time",
};

function casualty(index: number, overrides: Partial<Casualty> = {}): Casualty {
  const base = openCasualty(
    {
      id: casualtyId(`cas_${index}`),
      kind: "payment-failed",
      customer: customerRef(`cus_${index.toString().padStart(12, "0")}`),
      orderId: orderId(`order_${index}`),
      attemptId: null,
      slice: slice("upi", "hdfc", "gpay"),
      amount: paise(400_00),
      failure: BANK_TIMEOUT,
      retry: "requires-customer",
      occurredAt: AT - DAY,
      ...overrides,
    },
    classify(BANK_TIMEOUT).recoverability,
  );
  return { ...base, ...overrides, status: base.status, attempts: base.attempts };
}

let db: PGlite;
let store: PostgresCasualtyStore;

// One server for the file. Booting PostgreSQL costs a couple of seconds; emptying a table costs
// nothing, and a truncate between tests isolates them just as completely.
beforeAll(async () => {
  db = await PGlite.create();
  await migrate(db);
  store = new PostgresCasualtyStore({ sql: db });
  // Generous, and only for the boot. Starting a PostgreSQL compiled to WebAssembly costs a second
  // or two warm and rather more on a cold page cache — a CI runner that has never seen the module
  // before. Everything after this runs in milliseconds against the default timeout.
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("truncate kairos_casualty");
  await db.query("drop schema if exists billing cascade");
});

describe("the schema", () => {
  it("applies twice without complaint", async () => {
    // A single-service deployment migrates on every boot. If that were not idempotent, the second
    // boot would be the one that fails, which is the boot nobody is watching.
    await expect(migrate(db)).resolves.toBeUndefined();
  });

  it("can be printed for a migration tool that wants a file", () => {
    const sql = schemaSql("billing.kairos_casualty");
    expect(sql).toContain("create table if not exists billing.kairos_casualty");
    expect(sql).toContain("create index if not exists billing_kairos_casualty_due");
    expect(sql.trimEnd().endsWith(";")).toBe(true);
  });

  it("refuses a table name it would have to interpolate blindly", () => {
    // The one value SQL will not let us bind, so it is validated instead of escaped.
    for (const bad of ["casualties; drop table users", 'a"b', "Casualties", "a.b.c", ""]) {
      expect(() => assertTableName(bad)).toThrow(/not a table name/);
    }
    expect(assertTableName("billing.kairos_casualty")).toBe("billing.kairos_casualty");
  });

  it("stores into whichever table it was given", async () => {
    await db.query("create schema billing");
    await migrate(db, "billing.queue");
    const other = new PostgresCasualtyStore({ sql: db, table: "billing.queue" });

    await other.save(casualty(1), AT);
    expect(await other.get(casualtyId("cas_1"))).not.toBeNull();
    // ...and not into the default one.
    expect(await store.get(casualtyId("cas_1"))).toBeNull();
  });
});

describe("round trip", () => {
  it("returns a casualty indistinguishable from the one it was given", async () => {
    // Every optional field populated, because the ones that round-trip badly are the ones that are
    // usually null in a test and never null in production.
    const rich = casualty(7, {
      attemptId: "pay_abc123" as Casualty["attemptId"],
      kind: "invoice-overdue",
      retry: "autonomous",
      slice: slice("card", "icici", "visa"),
      attempts: [
        {
          kind: "contact-sms",
          at: AT,
          outcome: "delivered",
          costPaise: paise(20),
          externalRef: "sm_1",
        },
        {
          kind: "retry",
          at: AT + MINUTE,
          outcome: "declined-soft",
          costPaise: paise(0),
          externalRef: null,
        },
      ],
      status: {
        recovered: false,
        optedOut: false,
        disputed: true,
        consecutiveHardDeclines: 2,
        recoverability: "timed",
      },
    });

    await store.save(rich, AT + DAY);
    expect(await store.get(rich.id)).toEqual(rich);
  });

  it("keeps a slice with null components null, rather than turning it into an empty string", async () => {
    const bare = casualty(2, { slice: slice("netbanking") });
    await store.save(bare, null);
    const back = await store.get(bare.id);
    expect(back?.slice).toEqual({ method: "netbanking", issuer: null, instrument: null });
  });

  it("has nothing to say about a casualty it has never seen", async () => {
    expect(await store.get(casualtyId("cas_missing"))).toBeNull();
  });

  it("updates in place rather than accumulating rows", async () => {
    const c = casualty(3);
    await store.save(c, AT);
    await store.save({ ...c, status: { ...c.status, recovered: true } }, null);

    const { rows } = await db.query<{ n: string }>("select count(*) as n from kairos_casualty");
    expect(Number(rows[0]?.n)).toBe(1);
    expect((await store.get(casualtyId("cas_3")))?.status.recovered).toBe(true);
  });

  it("refuses a payload that is no longer a casualty", async () => {
    // A store is a trust boundary even when this process wrote the row. Between the write and the
    // read sit a migration, an older build, and a support engineer with psql.
    await store.save(casualty(4), AT);
    await db.query(`update kairos_casualty set payload = '{"id":"cas_4"}'::jsonb`);

    await expect(store.get(casualtyId("cas_4"))).rejects.toThrow(DomainError);
    await expect(store.due(AT, 10)).rejects.toThrow(/casualty.status/);
  });
});

describe("the queue", () => {
  it("returns what is due, oldest first", async () => {
    await store.save(casualty(1), AT + 3 * MINUTE);
    await store.save(casualty(2), AT + MINUTE);
    await store.save(casualty(3), AT + 2 * MINUTE);

    const due = await store.due(AT + 10 * MINUTE, 10);
    expect(due.map((c) => c.id)).toEqual(["cas_2", "cas_3", "cas_1"]);
  });

  it("breaks a tie on id, so a fleet agrees about what it saw first", async () => {
    for (const i of [3, 1, 2]) await store.save(casualty(i), AT);
    expect((await store.due(AT, 10)).map((c) => c.id)).toEqual(["cas_1", "cas_2", "cas_3"]);
  });

  it("does not return a casualty before it is due", async () => {
    await store.save(casualty(1), AT + MINUTE);
    expect(await store.due(AT, 10)).toEqual([]);
    expect((await store.due(AT + MINUTE, 10)).map((c) => c.id)).toEqual(["cas_1"]);
  });

  it("never returns one that is due at null — the queue's way of saying 'finished'", async () => {
    await store.save(casualty(1), null);
    expect(await store.due(AT + 10 * DAY, 10)).toEqual([]);
    // Still retrievable by id: done is not deleted.
    expect(await store.get(casualtyId("cas_1"))).not.toBeNull();
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i++) await store.save(casualty(i), AT);
    expect(await store.due(AT, 2)).toHaveLength(2);
  });
});

describe("the lease", () => {
  it("is granted once and refused to everybody else", async () => {
    await store.save(casualty(1), AT);
    const id = casualtyId("cas_1");

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claim(id, AT, AT + 5 * MINUTE)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("hides a leased casualty from the queue, and returns it when the lease expires", async () => {
    await store.save(casualty(1), AT);
    expect(await store.claim(casualtyId("cas_1"), AT, AT + 5 * MINUTE)).toBe(true);

    expect(await store.due(AT + MINUTE, 10)).toEqual([]);
    expect((await store.due(AT + 5 * MINUTE, 10)).map((c) => c.id)).toEqual(["cas_1"]);
  });

  it("expires rather than stranding the casualty when the holder dies", async () => {
    await store.save(casualty(1), AT);
    const id = casualtyId("cas_1");
    expect(await store.claim(id, AT, AT + 5 * MINUTE)).toBe(true);
    // A worker that vanished mid-action releases nothing. The next one takes over on time.
    expect(await store.claim(id, AT + MINUTE, AT + 6 * MINUTE)).toBe(false);
    expect(await store.claim(id, AT + 5 * MINUTE, AT + 10 * MINUTE)).toBe(true);
  });

  it("cannot be taken on a casualty that does not exist", async () => {
    expect(await store.claim(casualtyId("cas_nobody"), AT, AT + MINUTE)).toBe(false);
  });

  it("survives the holder saving progress on the casualty it is holding", async () => {
    // The load-bearing line in `save`. An upsert that reset the lease would hand the casualty to a
    // second worker at the exact moment the first one recorded that it had acted.
    const c = casualty(1);
    await store.save(c, AT);
    expect(await store.claim(c.id, AT, AT + 5 * MINUTE)).toBe(true);

    await store.save({ ...c, status: { ...c.status, consecutiveHardDeclines: 1 } }, AT + DAY);

    expect(await store.claim(c.id, AT + MINUTE, AT + 6 * MINUTE)).toBe(false);
    expect(await store.due(AT + MINUTE, 10)).toEqual([]);
  });
});

describe("the columns an operator queries", () => {
  it("track the payload without being the authority for it", async () => {
    await store.save(
      casualty(1, { retry: "autonomous", slice: slice("card", "hdfc", "rupay") }),
      AT + DAY,
    );

    const { rows } = await db.query<Record<string, unknown>>(
      "select customer, slice_method, slice_issuer, slice_instrument, amount_paise, retry," +
        " recoverability, recovered, attempt_count, due_at from kairos_casualty where id = $1",
      ["cas_1"],
    );
    const row = rows[0];
    expect(row?.["slice_method"]).toBe("card");
    expect(row?.["slice_issuer"]).toBe("hdfc");
    expect(row?.["slice_instrument"]).toBe("rupay");
    expect(row?.["retry"]).toBe("autonomous");
    expect(row?.["recovered"]).toBe(false);
    expect(Number(row?.["amount_paise"])).toBe(400_00);
    expect(Number(row?.["attempt_count"])).toBe(0);
    expect(Number(row?.["due_at"])).toBe(AT + DAY);
  });

  it("are rewritten on every save, so they cannot drift", async () => {
    const c = casualty(1);
    await store.save(c, AT);
    await store.save(
      {
        ...c,
        status: { ...c.status, recovered: true },
        attempts: [
          {
            kind: "contact-sms",
            at: AT,
            outcome: "recovered",
            costPaise: paise(20),
            externalRef: null,
          },
        ],
      },
      null,
    );

    const { rows } = await db.query<Record<string, unknown>>(
      "select recovered, attempt_count, due_at from kairos_casualty where id = $1",
      ["cas_1"],
    );
    expect(rows[0]?.["recovered"]).toBe(true);
    expect(Number(rows[0]?.["attempt_count"])).toBe(1);
    expect(rows[0]?.["due_at"]).toBeNull();
  });
});

/**
 * The port's contract is that the worker cannot tell which implementation it has. That is only
 * worth asserting against the implementation the whole test suite is written around.
 */
describe("agreement with the in-memory store", () => {
  it("answers a script of operations identically", async () => {
    const memory = new MemoryCasualtyStore();
    const trace: unknown[] = [];
    const both = async (label: string, run: (s: CasualtyStore) => Promise<unknown>) => {
      trace.push([label, await run(store), await run(memory)]);
    };

    const script: [string, (s: CasualtyStore) => Promise<unknown>][] = [
      ["save 1 due", (s) => s.save(casualty(1), AT)],
      ["save 2 due later", (s) => s.save(casualty(2), AT + 5 * MINUTE)],
      ["save 3 never", (s) => s.save(casualty(3), null)],
      ["due now", async (s) => (await s.due(AT, 10)).map((c) => c.id)],
      ["claim 1", (s) => s.claim(casualtyId("cas_1"), AT, AT + MINUTE)],
      ["claim 1 again", (s) => s.claim(casualtyId("cas_1"), AT, AT + MINUTE)],
      ["claim missing", (s) => s.claim(casualtyId("cas_9"), AT, AT + MINUTE)],
      ["due while leased", async (s) => (await s.due(AT, 10)).map((c) => c.id)],
      ["save 1 again", (s) => s.save(casualty(1), AT)],
      ["due still leased", async (s) => (await s.due(AT, 10)).map((c) => c.id)],
      ["due after lease", async (s) => (await s.due(AT + MINUTE, 10)).map((c) => c.id)],
      ["due limit 1", async (s) => (await s.due(AT + 10 * MINUTE, 1)).map((c) => c.id)],
      ["get 3", async (s) => (await s.get(casualtyId("cas_3")))?.id],
      ["get missing", (s) => s.get(casualtyId("cas_9"))],
    ];

    for (const [label, run] of script) await both(label, run);

    for (const [label, fromPostgres, fromMemory] of trace as [string, unknown, unknown][]) {
      expect(fromPostgres, label).toEqual(fromMemory);
    }
  });
});

/**
 * The reason this adapter exists.
 *
 * Two workers, one queue, one budget. Terminus already stops them double-*spending*; nothing
 * before this stopped them double-*sending*, because two workers derive the same idempotency key
 * and are both handed the same grant.
 */
describe("two workers, one queue", () => {
  const directory: CustomerDirectory = {
    lookup: () => Promise.resolve({ firstName: "Rohit", token: "token_1", language: "en" }),
  };
  const gauge: RailGauge = { isDegraded: () => false, recoveredAt: () => null };

  function trained(rate: number): RecoveryModel {
    const model = new RecoveryModel();
    const hits = Math.round(rate * 400);
    for (const action of ["retry", "contact-sms", "contact-whatsapp", "contact-email"] as const) {
      for (const recoverability of ["transient", "customer-action", "customer-retry"] as const) {
        for (let i = 0; i < 400; i++) {
          model.observe(
            { action, recoverability, confidence: 1, railHealthy: true, attemptOrdinal: 0 },
            i < hits,
          );
        }
      }
    }
    return model;
  }

  function worker(
    name: string,
    shared: { store: MemoryStore; ledger: MemoryLedger; calls: ExecuteRequest[] },
  ): RecoverWorker {
    const executor: Executor = {
      execute: async (request): Promise<ExecuteResult> => {
        shared.calls.push(request);
        // A real send is not instantaneous, and the window it opens is exactly the one the lease
        // is here to close. Yielding makes the two drains actually interleave.
        await Promise.resolve();
        return { outcome: "delivered", costPaise: 20, externalRef: `sm_${name}`, optedOut: false };
      },
    };

    return new RecoverWorker({
      terminus: new Terminus({
        mandate: sealMandate(
          {
            id: mandateId("mnd_recover"),
            merchantId: "acme",
            campaignId: "recovery",
            budgetPaise: paise(500_00),
            maxActionCostPaise: paise(60),
            maxInFlight: 8,
            reservationTtlMs: 60_000,
            contactCap: { limit: 3, windowMs: 7 * DAY },
            quietHours: null,
            allowedActions: ["retry", "contact-sms", "contact-whatsapp", "contact-email"],
            validFrom: AT - DAY,
            validUntil: AT + 90 * DAY,
            killSwitch: false,
          },
          SECRET,
        ),
        secret: SECRET,
        // Shared, because a budget that is not shared is not a budget.
        store: shared.store,
        audit: shared.ledger,
        actor: `recover-worker/${name}`,
        clock: new ManualClock(AT),
      }),
      store,
      directory,
      gauge,
      model: trained(0.4),
      executor,
      clock: new ManualClock(AT),
      config: { ...DEFAULT_RECOVERY_CONFIG, controlFraction: 0, explorationRate: 0 },
    });
  }

  it("acts on each casualty exactly once", async () => {
    const shared = {
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      ledger: new MemoryLedger(),
      calls: [] as ExecuteRequest[],
    };
    const a = worker("a", shared);
    const b = worker("b", shared);

    for (let i = 0; i < 12; i++) await store.save(casualty(i), AT);

    const [reportA, reportB] = await Promise.all([a.drain(), b.drain()]);

    // Both saw the same twelve — `due` does not arbitrate and does not pretend to.
    expect(reportA.considered).toBe(12);
    expect(reportB.considered).toBe(12);

    // Exactly one of them acted on each. This is the whole claim.
    const touched = shared.calls.map((c) => c.casualty.id);
    expect(new Set(touched).size).toBe(touched.length);
    expect(reportA.acted + reportB.acted).toBe(touched.length);
    expect(touched).toHaveLength(12);

    // And both of them did some of the work, or the test proved nothing about contention.
    expect(reportA.acted).toBeGreaterThan(0);
    expect(reportB.acted).toBeGreaterThan(0);
  });

  it("leaves the queue in a state a third worker can pick up", async () => {
    const shared = {
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      ledger: new MemoryLedger(),
      calls: [] as ExecuteRequest[],
    };
    for (let i = 0; i < 4; i++) await store.save(casualty(i), AT);
    await Promise.all([worker("a", shared).drain(), worker("b", shared).drain()]);

    // Every casualty is recorded as acted on, and none is left leased for ever.
    for (let i = 0; i < 4; i++) {
      const back = await store.get(casualtyId(`cas_${i}`));
      expect(back?.attempts.length, `cas_${i}`).toBe(1);
    }
    const { rows } = await db.query<{ n: string }>(
      "select count(*) as n from kairos_casualty where leased_until > $1",
      [AT + DAY],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
