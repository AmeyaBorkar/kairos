import { createServer, type Server } from "node:http";
import { type MetricsInput, renderMetrics, type WorkerTotals } from "./metrics.js";

/**
 * Three routes and no framework.
 *
 * The worker is a loop, not a service, and until now it had no surface at all: an orchestrator could
 * tell whether the process existed and nothing about whether it was working. A worker deadlocked on
 * a pool it never gets a connection from looks exactly like a healthy one from the outside, and is
 * the failure this exists to make visible.
 *
 * Node's own `http` rather than Fastify because three routes with no bodies, no parsing and no
 * validation is not a framework's problem, and a dependency that exists only to serve `/health` is
 * a dependency in the deployment for the sake of the deployment.
 *
 * ## Liveness and readiness are different questions
 *
 * `/health` asks whether the loop is turning. It touches nothing external, because a liveness probe
 * that fails when the database is slow gets the process killed for something restarting it will not
 * fix — and a fleet that restarts itself under load is how a slow database becomes an outage.
 *
 * `/ready` asks whether this worker can do its job, which means reading the store. It is allowed to
 * fail, and a worker that fails it should stop being sent work, not be killed.
 */
export interface AdminOptions {
  readonly port: number;
  /** Everything the metrics need, read fresh per scrape. */
  readonly snapshot: () => Promise<MetricsInput>;
  /** How this worker describes itself. Static, so `/health` costs nothing. */
  readonly identity: Record<string, unknown>;
  readonly totals: () => WorkerTotals;
  readonly now: () => number;
  /**
   * How long a pass may go unfinished before the loop is considered stuck.
   *
   * Generous on purpose: several drain intervals. A liveness probe that trips on one slow pass
   * restarts a worker that was about to succeed, and loses the lease it was holding.
   */
  readonly stallAfterMs: number;
  readonly startedAt: number;
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  type: string,
  body: string,
): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function serveAdmin(options: AdminOptions): Server {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];

    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "text/plain; charset=utf-8", "read-only\n");
      return;
    }

    if (path === "/health") {
      const totals = options.totals();
      const since = totals.lastPassAt === null ? null : options.now() - totals.lastPassAt;
      // A worker that has not completed a pass yet is starting, not stuck. Only a loop that ran and
      // then stopped running is a fault this can see.
      const stalled = since !== null && since > options.stallAfterMs;
      send(
        response,
        stalled ? 503 : 200,
        "application/json",
        `${JSON.stringify({
          ok: !stalled,
          ...options.identity,
          uptimeMs: options.now() - options.startedAt,
          passes: totals.passes,
          lastPassMsAgo: since,
          ...(stalled
            ? { stalled: `no drain pass completed in ${Math.round((since ?? 0) / 1000)}s` }
            : {}),
        })}\n`,
      );
      return;
    }

    if (path === "/ready") {
      void options
        .snapshot()
        .then((input) => {
          const ready = input.budget !== null;
          send(
            response,
            ready ? 200 : 503,
            "application/json",
            `${JSON.stringify({
              ok: ready,
              store: ready ? "readable" : "unreadable",
              // Worth reporting rather than hiding: a stopped campaign is ready in every technical
              // sense and is deliberately doing nothing, and an operator staring at an idle fleet
              // should be told which of the two they are looking at.
              stopEngaged: input.stopEngaged,
            })}\n`,
          );
        })
        .catch(() => {
          send(response, 503, "application/json", `${JSON.stringify({ ok: false })}\n`);
        });
      return;
    }

    if (path === "/metrics") {
      void options
        .snapshot()
        .then((input) => {
          // Always 200. A scrape that fails tells a dashboard nothing; a scrape that succeeds with
          // `kairos_store_readable 0` tells it exactly what is wrong.
          send(response, 200, "text/plain; version=0.0.4; charset=utf-8", renderMetrics(input));
        })
        .catch(() => {
          send(response, 500, "text/plain; charset=utf-8", "# metrics unavailable\n");
        });
      return;
    }

    send(response, 404, "text/plain; charset=utf-8", "not found\n");
  });

  /**
   * A surface that cannot kill the thing it observes.
   *
   * Without this listener an `EADDRINUSE` — a second worker on one host, a port something else
   * already took — is an `error` event with nobody listening, which Node raises as a throw. The
   * process dies, and it dies because its *health endpoint* could not bind. That is exactly
   * backwards: draining the queue is the job, describing it is a courtesy, and losing the courtesy
   * is not a reason to lose the job.
   *
   * Reported loudly rather than swallowed, because a worker running unobserved is a real problem —
   * just not a fatal one.
   */
  server.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(
      `${JSON.stringify({
        admin: "unavailable",
        port: options.port,
        code: error.code ?? null,
        detail: error.message,
        note: "the worker is still draining; nothing can report on it",
      })}\n`,
    );
  });

  // Bound to every interface, unlike the mandate form: this holds no secret, answers only reads, and
  // an orchestrator's probe arrives from outside the container.
  server.listen(options.port, "0.0.0.0");
  // The loop is the process. An admin server holding the event loop open would keep a worker alive
  // after its work had stopped, which is the opposite of what a health surface is for.
  server.unref();
  return server;
}
