/**
 * The console's HTTP surface: JSON in, JSON out, nothing rendered.
 *
 * Deliberately a data API with no view layer. The UI is built against these shapes and can be
 * replaced entirely without touching anything here, which is the arrangement that lets a designer
 * and an engineer work at the same time — and the reason this file exists before any HTML does.
 *
 * ## Read-only, and structurally so
 *
 * There is no route here that mutates anything except `POST /api/scenario`, which chooses which
 * simulation is running. Nothing can send a message, authorise a spend, or steer a checkout through
 * this server, because it holds no ports that could — the run it observes owns those. An operator
 * console that could act would need its own mandate and its own audit actor; this one is a window.
 */

import type { EngineConfig } from "@kairos/detect";
import type { Mandate } from "@kairos/domain";
import { describeBounds, explain, type RecordSource } from "@kairos/explain";
import type { Explainer } from "@kairos/reason";
import Fastify, { type FastifyInstance } from "fastify";
import type { ConsoleSnapshot } from "./model.js";
import { ConsoleRun } from "./run.js";
import { type Scenario, scenarioNamed, scenarios } from "./scenario.js";

export interface ConsoleOptions {
  readonly mandateFor: (scenario: Scenario) => Mandate;
  readonly secret: string;
  readonly detector: EngineConfig;
  readonly startAt: number;
  readonly initialScenario?: string;
  /**
   * The model behind `/api/explain`, or `null` to leave that route returning 501.
   *
   * Optional because the console must run with no API key: everything else it shows comes from
   * components that need none, and a dashboard that refuses to start without a provider credential
   * would make the whole demo depend on a free tier's daily quota.
   */
  readonly explainer?: Explainer | null;
}

export function createConsole(options: ConsoleOptions): {
  readonly app: FastifyInstance;
  readonly run: () => ConsoleRun;
} {
  const app = Fastify({ logger: false });

  let scenario =
    scenarioNamed(options.initialScenario ?? "issuer-outage", options.startAt) ??
    (scenarios(options.startAt)[0] as Scenario);
  let run = build(scenario);

  function build(chosen: Scenario): ConsoleRun {
    return new ConsoleRun({
      scenario: chosen,
      mandate: options.mandateFor(chosen),
      secret: options.secret,
      detector: options.detector,
    });
  }

  app.get("/api/scenarios", () => ({
    current: scenario.name,
    available: scenarios(options.startAt).map((s) => ({
      name: s.name,
      premise: s.premise,
      watchFor: s.watchFor,
    })),
  }));

  /**
   * Choose a scenario, which restarts the run from its beginning.
   *
   * A restart rather than a transition, because a detector's state is a function of everything it
   * has seen and splicing one scenario onto another would produce a run that reproduces nothing.
   */
  app.post<{ Body: { name?: string } }>("/api/scenario", (request, reply) => {
    const name = request.body?.name ?? "";
    const chosen = scenarioNamed(name, options.startAt);
    if (chosen === null) {
      return reply.code(400).send({
        error: "unknown scenario",
        available: scenarios(options.startAt).map((s) => s.name),
      });
    }
    scenario = chosen;
    run = build(chosen);
    return reply.send({ started: chosen.name, premise: chosen.premise });
  });

  app.get("/api/snapshot", (): ConsoleSnapshot => run.snapshot());

  /**
   * Advance the simulation and return the state that results.
   *
   * The client drives the clock rather than the server running a timer, so a viewer can step
   * through an incident at their own pace, a screen recording can be paced by hand, and a test can
   * assert on tick N without waiting for it. `ticks` is capped so one request cannot run the whole
   * scenario and block the process.
   */
  app.post<{ Body: { ticks?: number } }>("/api/step", async (request) => {
    const asked = Number(request.body?.ticks ?? 1);
    const ticks = Math.max(1, Math.min(60, Number.isFinite(asked) ? asked : 1));
    for (let at = 0; at < ticks && !run.finished; at++) await run.step();
    return run.snapshot();
  });

  app.get("/api/scenario", () => ({
    name: scenario.name,
    premise: scenario.premise,
    watchFor: scenario.watchFor,
    finished: run.finished,
    tickMs: ConsoleRun.tickMs,
  }));

  /**
   * Why the system treated one subject the way it did.
   *
   * Returns 422 rather than 200 when the answer failed its honesty check. A caller receiving prose
   * on a 200 will render it; the whole point of the check is that unverifiable prose must not reach
   * a screen, and the status code is what makes that hard to get wrong in a client.
   */
  app.get<{ Params: { target: string }; Querystring: { q?: string } }>(
    "/api/explain/:target",
    async (request, reply) => {
      if (options.explainer === undefined || options.explainer === null) {
        return reply.code(501).send({
          error: "no explainer configured",
          detail: "set GOOGLE_API_KEY and restart to enable explanations",
        });
      }

      const result = await explain({
        source: run.ledger as RecordSource,
        explainer: options.explainer,
        bounds: describeBounds(options.mandateFor(scenario)),
        target: request.params.target,
        ...(request.query.q === undefined ? {} : { question: request.query.q }),
      });

      if (!result.ok) {
        return reply.code(result.why === "no-records" ? 404 : 422).send(result);
      }
      return reply.send(result);
    },
  );

  return { app, run: () => run };
}
