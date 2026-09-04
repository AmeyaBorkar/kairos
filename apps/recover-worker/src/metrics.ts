import { BINDING_AXES, type BindingAxis } from "@kairos/domain";
import type { DrainReport } from "@kairos/recover";
import type { BudgetSnapshot } from "@kairos/terminus";

/**
 * What this worker has done, in numbers something can scrape.
 *
 * The drain report already says everything worth knowing about a pass; what it does not do is
 * survive the pass. A process whose entire observable state is the last line it printed cannot
 * answer "is it working?" — only "what happened forty seconds ago, if you were watching".
 *
 * ## Why the decline reasons are not here and the refusal axes are
 *
 * `refusalsByAxis` is keyed by {@link BindingAxis}, which is a closed set of eleven strings, so it
 * makes eleven series and always the same eleven. `declinesByReason` is free text composed from the
 * decision — "the best available action nets 36 paise", "rung 1 of 3" — and would make a new time
 * series per distinct sentence. That is the classic way to take down a metrics backend, and the
 * information is already in the log where its shape belongs.
 */
export interface WorkerTotals {
  passes: number;
  considered: number;
  claimed: number;
  acted: number;
  recovered: number;
  declined: number;
  refused: number;
  spentPaise: number;
  refusalsByAxis: Record<string, number>;
  lastPassAt: number | null;
}

export function emptyTotals(): WorkerTotals {
  return {
    passes: 0,
    considered: 0,
    claimed: 0,
    acted: 0,
    recovered: 0,
    declined: 0,
    refused: 0,
    spentPaise: 0,
    refusalsByAxis: {},
    lastPassAt: null,
  };
}

export function accumulate(totals: WorkerTotals, report: DrainReport, at: number): WorkerTotals {
  const refusalsByAxis = { ...totals.refusalsByAxis };
  for (const [axis, count] of Object.entries(report.refusalsByAxis)) {
    refusalsByAxis[axis] = (refusalsByAxis[axis] ?? 0) + count;
  }
  return {
    passes: totals.passes + 1,
    considered: totals.considered + report.considered,
    claimed: totals.claimed + report.claimed,
    acted: totals.acted + report.acted,
    recovered: totals.recovered + report.recovered,
    declined: totals.declined + report.declined,
    refused: totals.refused + report.refused,
    spentPaise: totals.spentPaise + report.spentPaise,
    refusalsByAxis,
    lastPassAt: at,
  };
}

export interface MetricsInput {
  readonly totals: WorkerTotals;
  /** Absent when the store could not be read. A scrape must still succeed and say so. */
  readonly budget: BudgetSnapshot | null;
  readonly stopEngaged: boolean | null;
  readonly startedAt: number;
  readonly now: number;
  readonly fleet: boolean;
  readonly delivery: string;
  readonly campaignId: string;
  readonly merchantId: string;
}

function line(name: string, help: string, type: string, samples: readonly string[]): string {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples].join("\n");
}

/** Prometheus escapes backslash, newline and double quote inside a label value, and nothing else. */
function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/**
 * The exposition, as text.
 *
 * A pure function of a snapshot rather than a registry the process mutates, because the interesting
 * property of this output is that it agrees with the drain reports — and the cheapest way to be sure
 * of that is for both to be derived from the same numbers in the same place, with no library holding
 * a second copy.
 */
export function renderMetrics(input: MetricsInput): string {
  const { totals, budget, campaignId, merchantId } = input;
  const campaign = `campaign="${label(campaignId)}",merchant="${label(merchantId)}"`;

  const blocks: string[] = [
    line("kairos_worker_up", "Always 1. Its absence is the signal.", "gauge", [
      `kairos_worker_up{${campaign},delivery="${label(input.delivery)}",fleet="${input.fleet}"} 1`,
    ]),
    line("kairos_worker_uptime_seconds", "Seconds since this worker started.", "gauge", [
      `kairos_worker_uptime_seconds ${Math.max(0, Math.round((input.now - input.startedAt) / 1000))}`,
    ]),
    line("kairos_drain_passes_total", "Drain passes completed.", "counter", [
      `kairos_drain_passes_total ${totals.passes}`,
    ]),
    line(
      "kairos_casualties_total",
      "Casualties by what became of them. considered >= claimed >= acted + declined + refused.",
      "counter",
      [
        `kairos_casualties_total{outcome="considered"} ${totals.considered}`,
        `kairos_casualties_total{outcome="claimed"} ${totals.claimed}`,
        `kairos_casualties_total{outcome="acted"} ${totals.acted}`,
        `kairos_casualties_total{outcome="recovered"} ${totals.recovered}`,
        `kairos_casualties_total{outcome="declined"} ${totals.declined}`,
        `kairos_casualties_total{outcome="refused"} ${totals.refused}`,
      ],
    ),
    line(
      "kairos_refusals_total",
      "Refusals by the axis Terminus named. The answer to why nothing happened.",
      "counter",
      // Every axis, including the zeroes. A series that only appears once it fires is a series
      // nobody can alert on the absence of, and eleven is a cheap price for that.
      BINDING_AXES.map(
        (axis: BindingAxis) =>
          `kairos_refusals_total{axis="${axis}"} ${totals.refusalsByAxis[axis] ?? 0}`,
      ),
    ),
    line("kairos_spent_paise_total", "Settled spend, in paise.", "counter", [
      `kairos_spent_paise_total{${campaign}} ${totals.spentPaise}`,
    ]),
  ];

  if (budget !== null) {
    blocks.push(
      line(
        "kairos_budget_paise",
        "The mandate's money, as Terminus accounts for it right now.",
        "gauge",
        [
          `kairos_budget_paise{${campaign},kind="ceiling"} ${budget.budgetPaise}`,
          `kairos_budget_paise{${campaign},kind="settled"} ${budget.settledPaise}`,
          `kairos_budget_paise{${campaign},kind="committed"} ${budget.committedPaise}`,
          `kairos_budget_paise{${campaign},kind="available"} ${budget.availablePaise}`,
          `kairos_budget_paise{${campaign},kind="overrun"} ${budget.overrunPaise}`,
        ],
      ),
      line("kairos_reservations", "Reservations by state.", "gauge", [
        `kairos_reservations{${campaign},state="in_flight"} ${budget.inFlight}`,
        `kairos_reservations{${campaign},state="settled"} ${budget.settledCount}`,
        `kairos_reservations{${campaign},state="expired"} ${budget.expiredCount}`,
        `kairos_reservations{${campaign},state="orphan"} ${budget.orphanCount}`,
      ]),
    );
  }

  blocks.push(
    line(
      "kairos_stop_engaged",
      "1 when the out-of-band stop is engaged, 0 when it is not, absent when there is no switch.",
      "gauge",
      input.stopEngaged === null
        ? []
        : [`kairos_stop_engaged{${campaign}} ${input.stopEngaged ? 1 : 0}`],
    ),
    line(
      "kairos_store_readable",
      "0 when the store could not be read on this scrape. The budget gauges are stale whenever this is 0.",
      "gauge",
      [`kairos_store_readable ${budget === null ? 0 : 1}`],
    ),
  );

  return `${blocks.join("\n\n")}\n`;
}
