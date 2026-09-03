import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { serveAdmin } from "./admin.js";
import { emptyTotals, type MetricsInput, type WorkerTotals } from "./metrics.js";

const opened: Server[] = [];

afterEach(() => {
  for (const server of opened.splice(0)) server.close();
});

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    opened.push(server);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function inputFrom(totals: WorkerTotals, budget: MetricsInput["budget"] = null): MetricsInput {
  return {
    totals,
    budget,
    stopEngaged: null,
    startedAt: 0,
    now: 1000,
    fleet: false,
    delivery: "dry-run",
    campaignId: "recovery",
    merchantId: "acme",
  };
}

function admin(over: Partial<Parameters<typeof serveAdmin>[0]> = {}) {
  let totals = emptyTotals();
  const server = serveAdmin({
    port: 0,
    snapshot: () => Promise.resolve(inputFrom(totals)),
    identity: { backing: "memory" },
    totals: () => totals,
    now: () => 100_000,
    stallAfterMs: 20_000,
    startedAt: 0,
    ...over,
  });
  opened.push(server);
  return {
    server,
    set: (next: WorkerTotals) => {
      totals = next;
    },
  };
}

async function get(port: number, path: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
}

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function ready(server: Server): Promise<number> {
  if (server.listening) return portOf(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return portOf(server);
}

describe("a surface that cannot kill what it observes", () => {
  it("survives a port that is already taken", async () => {
    const taken = createServer(() => {});
    const port = await listen(taken);

    const server = serveAdmin({
      port,
      snapshot: () => Promise.resolve(inputFrom(emptyTotals())),
      identity: {},
      totals: emptyTotals,
      now: () => 0,
      stallAfterMs: 1000,
      startedAt: 0,
    });
    opened.push(server);

    // Asserted on the emitter rather than by waiting for the real bind to fail. Node raises an
    // `error` event with no listener as a throw, so this is the exact mechanism that kills the
    // process — and unlike a timing-dependent wait, it fails when the listener is missing instead
    // of passing because the test runner happened to absorb the crash.
    // Asserted on the emitter rather than by racing a real bind. Whether binding 0.0.0.0 collides
    // with an existing 127.0.0.1 listener is an OS policy question — Windows allows it, Linux does
    // not — so a test that waited for the collision would assert about the host rather than about
    // this file. What is always true is the mechanism: Node raises an `error` event with no
    // listener as a throw, and that throw is what kills the process.
    expect(server.listenerCount("error")).toBeGreaterThan(0);
    const refused: NodeJS.ErrnoException = Object.assign(new Error("address in use"), {
      code: "EADDRINUSE",
    });
    expect(() => server.emit("error", refused)).not.toThrow();
  });
});

describe("liveness", () => {
  it("is healthy before the first pass, because starting is not stalling", async () => {
    const { server } = admin();
    const { status, body } = await get(await ready(server), "/health");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true, passes: 0, lastPassMsAgo: null });
  });

  it("stays healthy while passes keep completing", async () => {
    const a = admin();
    a.set({ ...emptyTotals(), passes: 4, lastPassAt: 95_000 });
    const { status } = await get(await ready(a.server), "/health");
    expect(status).toBe(200);
  });

  it("reports 503 once the loop has stopped turning", async () => {
    const a = admin();
    a.set({ ...emptyTotals(), passes: 4, lastPassAt: 40_000 });
    const { status, body } = await get(await ready(a.server), "/health");
    expect(status).toBe(503);
    expect(JSON.parse(body).stalled).toMatch(/no drain pass completed/);
  });

  it("touches nothing external", async () => {
    // A liveness probe that fails when the database is slow gets the process killed for something
    // restarting it will not fix.
    let snapshots = 0;
    const { server } = admin({
      snapshot: () => {
        snapshots++;
        return Promise.resolve(inputFrom(emptyTotals()));
      },
    });
    await get(await ready(server), "/health");
    expect(snapshots).toBe(0);
  });
});

describe("readiness", () => {
  it("is ready when the store can be read", async () => {
    const { server } = admin({
      snapshot: () =>
        Promise.resolve(
          inputFrom(emptyTotals(), {
            budgetPaise: 1,
            settledPaise: 0,
            committedPaise: 0,
            availablePaise: 1,
            overrunPaise: 0,
            inFlight: 0,
            settledCount: 0,
            expiredCount: 0,
            orphanCount: 0,
          }),
        ),
    });
    const { status, body } = await get(await ready(server), "/ready");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true, store: "readable" });
  });

  it("is not ready when it is not", async () => {
    const { server } = admin();
    const { status, body } = await get(await ready(server), "/ready");
    expect(status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ ok: false, store: "unreadable" });
  });

  it("answers rather than hanging when the snapshot itself throws", async () => {
    const { server } = admin({ snapshot: () => Promise.reject(new Error("no route to host")) });
    const { status } = await get(await ready(server), "/ready");
    expect(status).toBe(503);
  });
});

describe("metrics", () => {
  it("answers 200 even with the store unreadable", async () => {
    // A scrape that fails tells a dashboard nothing; one that succeeds with store_readable 0 tells
    // it exactly what is wrong.
    const { server } = admin();
    const { status, body } = await get(await ready(server), "/metrics");
    expect(status).toBe(200);
    expect(body).toContain("kairos_store_readable 0");
  });
});

describe("the rest of the surface", () => {
  it("refuses anything that is not a read", async () => {
    const { server } = admin();
    const port = await ready(server);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("404s an unknown path", async () => {
    const { server } = admin();
    expect((await get(await ready(server), "/admin")).status).toBe(404);
  });

  it("ignores a query string rather than 404ing on it", async () => {
    const { server } = admin();
    expect((await get(await ready(server), "/health?probe=kubelet")).status).toBe(200);
  });
});
