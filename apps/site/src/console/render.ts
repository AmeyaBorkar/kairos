/**
 * Painting one frame of a recorded run into the console's four panels.
 *
 * Nothing here computes anything. Every value shown came out of `apps/console` driving the real
 * detector, kernel and ledger; this file only decides where it goes and what colour it is. That
 * separation is the point — a renderer that could derive a number could derive a wrong one, and the
 * whole argument of this project is that the numbers are traceable.
 */

import {
  type BoundReading,
  type Frame,
  type LedgerRow,
  RAIL_STATES,
  railLabel,
  type Scenario,
  STEER_MODES,
  verdictOf,
} from "./types.js";

/** How many rails the grid shows. Busiest first, so it does not reshuffle as rates move. */
const RAIL_LIMIT = 16;
/** How far back the audit feed goes before it stops being a feed and starts being a file. */
const FEED_LIMIT = 90;

function pad(n: number): string {
  return (n < 10 ? "0" : "") + String(n);
}

/** The simulated clock, in UTC, because the run's timestamps are simulated instants. */
export function hhmmss(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function safe(text: string): string {
  return text.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

export function renderRails(host: HTMLElement, scenario: Scenario, frame: Frame): void {
  const rows = frame.rails
    .map((reading) => ({ reading, key: scenario.railKeys[reading[0]] }))
    .filter((row) => row.reading[1] > 0 && row.key !== undefined)
    .sort((a, b) => b.reading[3] - a.reading[3] || b.reading[1] - a.reading[1])
    .slice(0, RAIL_LIMIT);

  if (rows.length === 0) {
    host.innerHTML =
      '<p class="empty">No attempts in this window — the run has passed the end of its traffic.</p>';
    return;
  }

  host.innerHTML = rows
    .map(({ reading, key }) => {
      const state = RAIL_STATES[reading[3]] ?? "healthy";
      const steer = STEER_MODES[reading[5]] ?? "none";
      const fraction = Math.min(1, reading[4] / (scenario.threshold || 12));
      const name = safe(railLabel(key?.[0] ?? ""));
      return (
        `<div class="rail" data-state="${state}">` +
        `<b>${name}</b>` +
        `<span class="rate">${Math.round(reading[2] * 100)}% fail</span> · ${reading[1]} att<br>` +
        (steer === "none" ? state : `<span class="steer">${steer}</span>`) +
        `<span class="stat-bar"><i style="width:${(fraction * 100).toFixed(0)}%"></i></span>` +
        "</div>"
      );
    })
    .join("");
}

export function renderIncidents(host: HTMLElement, frame: Frame): void {
  if (frame.inc.length === 0) {
    host.innerHTML =
      '<p class="empty">None. On a quiet afternoon this detector raises about one false alarm ' +
      "every five hours, and that is the measurement deciding whether it can be left on.</p>";
    return;
  }

  host.innerHTML = frame.inc
    .map((row) => {
      const closed = row[3] !== null;
      const latency = row[4] === null ? "—" : `${(row[4] / 1000).toFixed(0)}s`;
      return (
        `<div class="inc${closed ? " shut" : ""}">` +
        `<b>${safe(railLabel(row[1]))} · ${closed ? "CLOSED" : "OPEN"}</b>` +
        `<span class="k">detected</span> ${latency} from onset · ` +
        `<span class="k">peak</span> ${Math.round(row[5] * 100)}% · ` +
        `<span class="k">casualties</span> ${row[6]}` +
        "</div>"
      );
    })
    .join("");
}

export function renderBounds(host: HTMLElement, scenario: Scenario, frame: Frame): void {
  host.innerHTML = frame.bounds
    .map((bound: BoundReading, i) => {
      const axis = scenario.boundAxes[i];
      if (axis === undefined) return "";
      const binding = bound[1] > 0;
      const current = bound[2] === "—" ? "" : `${safe(bound[2])} / `;
      return (
        `<div class="bound${binding ? " binding" : ""}">` +
        `<div class="bound-head"><b>${safe(axis[0])}</b>` +
        `<span>${current}${safe(axis[1])}</span></div>` +
        `<div class="bound-bar"><i style="width:${(bound[0] * 100).toFixed(0)}%"></i></div>` +
        (binding
          ? `<p class="why">refused ${bound[1]} action${bound[1] === 1 ? "" : "s"} on this bound</p>`
          : "") +
        "</div>"
      );
    })
    .join("");
}

/**
 * The audit trail, newest first, showing only what had happened by this frame.
 *
 * Filtering by frame rather than replaying a window is what makes scrubbing backwards truthful: drag
 * the scrubber left and records disappear, because at that instant they had not been written.
 */
export function renderFeed(host: HTMLElement, entries: readonly LedgerRow[]): void {
  if (entries.length === 0) {
    host.innerHTML =
      '<p class="empty">Nothing yet. An empty ledger is a real state, not a loading spinner.</p>';
    return;
  }

  host.innerHTML = entries
    .slice(0, FEED_LIMIT)
    .map((entry) => {
      const [cls, word] = verdictOf(entry[3] === 1, entry[5]);
      const bound = entry[5] === null ? "" : ` <b>[${safe(entry[5])}]</b>`;
      return (
        "<div>" +
        `<span class="t">${entry[1].slice(11, 19)}</span>` +
        `<span class="v ${cls}">${word}</span>` +
        `<span class="a">${safe(entry[2])}</span>` +
        `<span class="r">${safe(entry[4])}${bound}</span>` +
        "</div>"
      );
    })
    .join("");
}

export interface Readout {
  readonly clock: HTMLElement;
  readonly incidents: HTMLElement;
  readonly incidentsWrap: HTMLElement;
  readonly records: HTMLElement;
  readonly worst: HTMLElement;
  readonly worstWrap: HTMLElement;
  readonly steered: HTMLElement;
  readonly refusals: HTMLElement;
}

/** The live head: six numbers that go red before anything else on the page does. */
export function renderReadout(out: Readout, scenario: Scenario, frame: Frame): void {
  out.clock.textContent = hhmmss(frame.at);

  const open = frame.inc.filter((row) => row[3] === null).length;
  out.incidents.textContent = String(open);
  out.incidentsWrap.className = open > 0 ? "alarm" : "calm";

  out.records.textContent = String(frame.records);

  let worst: number | null = null;
  let worstAt = -1;
  for (const reading of frame.rails) {
    if (reading[1] > 0 && (worst === null || reading[2] > worst)) {
      worst = reading[2];
      worstAt = reading[0];
    }
  }

  if (worst !== null) {
    const rate: number = worst;
    const key = scenario.railKeys[worstAt];
    const name = railLabel(key?.[0] ?? "").split(" ")[0] ?? "";
    out.worst.textContent = `${Math.round(rate * 100)}% ${name}`;
    out.worstWrap.className = rate > 0.35 ? "alarm" : rate > 0.2 ? "" : "calm";
  } else {
    out.worst.textContent = "—";
    out.worstWrap.className = "";
  }

  out.steered.textContent = String(frame.rails.filter((r) => r[5] > 0).length);
  out.refusals.textContent = String(frame.bounds.reduce((n, b) => n + b[1], 0));
}
