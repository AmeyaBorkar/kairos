/**
 * The sentry's exposition.
 *
 * Separate from the worker's rather than shared, because the two processes have almost nothing in
 * common to report: one spends money against a mandate, the other reorders a checkout and holds a
 * reservation while it does. What they do share is eight lines of formatting, and eight lines
 * duplicated in two applications is a smaller thing to carry than a package that exists to hold
 * them. If a third process needs this, that is when it becomes one.
 */

export interface SentryMetrics {
  readonly outcomesIngested: number;
  readonly outcomesRejected: number;
  readonly plansServed: number;
  readonly plansFallenBack: number;
  readonly openIncidents: number;
  readonly steersInForce: number;
  readonly ledgerLength: number;
  readonly ledgerValid: boolean;
  readonly startedAt: number;
  readonly now: number;
  readonly fleet: boolean;
  /** Failure rate per slice, as the rolling window currently sees it. */
  readonly rails: ReadonlyArray<{ readonly slice: string; readonly failureRate: number }>;
}

function line(name: string, help: string, type: string, samples: readonly string[]): string {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples].join("\n");
}

function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function renderSentryMetrics(m: SentryMetrics): string {
  return `${[
    line("kairos_sentry_up", "Always 1. Its absence is the signal.", "gauge", [
      `kairos_sentry_up{fleet="${m.fleet}"} 1`,
    ]),
    line("kairos_sentry_uptime_seconds", "Seconds since this sentry started.", "gauge", [
      `kairos_sentry_uptime_seconds ${Math.max(0, Math.round((m.now - m.startedAt) / 1000))}`,
    ]),
    line("kairos_outcomes_total", "Payment outcomes offered to the detector.", "counter", [
      `kairos_outcomes_total{result="ingested"} ${m.outcomesIngested}`,
      `kairos_outcomes_total{result="rejected"} ${m.outcomesRejected}`,
    ]),
    line(
      "kairos_plans_total",
      "Plan requests. A fallback is a plan that resolved to the merchant's own ordering — the " +
        "correct answer to every failure on this path, and one worth watching the rate of.",
      "counter",
      [
        `kairos_plans_total{result="served"} ${m.plansServed}`,
        `kairos_plans_total{result="fallback"} ${m.plansFallenBack}`,
      ],
    ),
    line("kairos_incidents_open", "Degradations the detector currently reports.", "gauge", [
      `kairos_incidents_open ${m.openIncidents}`,
    ]),
    line("kairos_steers_in_force", "Steering directives currently held.", "gauge", [
      `kairos_steers_in_force ${m.steersInForce}`,
    ]),
    line("kairos_ledger_records", "Records in this instance's audit chain.", "gauge", [
      `kairos_ledger_records ${m.ledgerLength}`,
    ]),
    line(
      "kairos_ledger_valid",
      "1 while the hash chain verifies. A 0 here means the audit trail has been altered.",
      "gauge",
      [`kairos_ledger_valid ${m.ledgerValid ? 1 : 0}`],
    ),
    line(
      "kairos_rail_failure_rate",
      "Failure rate per slice over the rolling window, as the steering decision sees it.",
      "gauge",
      m.rails.map(
        (r) => `kairos_rail_failure_rate{slice="${label(r.slice)}"} ${r.failureRate.toFixed(4)}`,
      ),
    ),
  ].join("\n\n")}\n`;
}
