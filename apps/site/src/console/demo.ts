/**
 * The walkthrough: one incident, one step at a time, for somebody who has never seen this before.
 *
 * The operator console below answers "what is happening right now" for a person who already knows
 * the system. That is the wrong question for a stranger, and a dense panel of sixteen tiles and six
 * readouts teaches nobody anything — it is a picture of a system, not an explanation of one.
 *
 * Every step therefore carries three things and not one: a headline saying what is happening in
 * plain words, the artwork, and a legend saying what the artwork *is*. The legend is the part that
 * was missing. A bar chart of twenty-four rails means nothing until somebody says that a rail is one
 * way to pay through one bank and that taller means failing more often.
 *
 * The steps are derived per scenario rather than scripted, because the six scenarios genuinely tell
 * different stories: `calm` never leaves WATCH and that is the whole point of it, `kill-switch`
 * reaches CHECK and dies there, and `issuer-outage` runs the loop and then declines a renewal
 * because the rail it would steer to is no better.
 *
 * Nothing here computes a number. Every figure is read out of the recorded run, which is the same
 * rule the renderer next door obeys.
 */

import { hhmmss } from "./render.js";
import {
  DECK,
  type Frame,
  type LedgerRow,
  RAIL_STATES,
  type RecordedRun,
  railLabel,
  type Scenario,
  STEER_MODES,
} from "./types.js";

export interface DemoElements {
  readonly nav: HTMLElement;
  readonly headline: HTMLElement;
  readonly panel: HTMLElement;
  readonly legend: HTMLElement;
  readonly prev: HTMLButtonElement;
  readonly play: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  readonly where: HTMLElement;
  readonly pick: HTMLButtonElement;
  readonly menu: HTMLElement;
}

interface Step {
  readonly title: string;
  /** What is happening, in one sentence, large. */
  readonly headline: string;
  /** The artwork. */
  readonly body: string;
  /** What the artwork *is* — the part a stranger needs and an operator does not. */
  readonly legend: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * The kernel writes its reasons in paise, because that is the unit it reserves in and rounding
 * money for a log is how money goes missing. A stranger reading a tutorial should not have to.
 */
function plain(reason: string): string {
  return reason.replace(
    /(\d+) paise of (\d+) available/,
    (_m, a: string, b: string) =>
      `₹${(Number(a) / 100).toLocaleString("en-IN")} of the ₹${(Number(b) / 100).toLocaleString("en-IN")} available`,
  );
}

function worstOf(frame: Frame): readonly number[] | null {
  let worst: readonly number[] | null = null;
  for (const r of frame.rails) {
    if (worst === null || (r[2] ?? 0) > (worst[2] ?? 0)) worst = r;
  }
  return worst;
}

function meter(fill: number, tone: "ok" | "bad", label: string, note: string): string {
  const w = Math.max(2, Math.min(1, fill) * 100);
  return (
    `<div class="mtr ${tone}"><div class="mtr-h"><b>${esc(label)}</b><span>${esc(note)}</span></div>` +
    `<div class="mtr-t"><i style="width:${w.toFixed(1)}%"></i></div></div>`
  );
}

/* ── the steps ───────────────────────────────────────────────────────────── */

function watchStep(sc: Scenario, at: number): Step {
  const frame = sc.frames[at];
  if (frame === undefined) throw new Error("no frame");
  const attempts = frame.rails.reduce((n, r) => n + (r[1] ?? 0), 0);
  const bars = frame.rails
    .slice()
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map((r) => {
      const state = RAIL_STATES[r[3] ?? 0] ?? "healthy";
      const h = Math.max(6, Math.min(1, (r[2] ?? 0) / 0.6) * 100);
      const name = railLabel(sc.railKeys[r[0] ?? 0]?.[0] ?? "");
      return (
        `<div class="wcol" title="${esc(name)} · ${pct(r[2] ?? 0)} failing">` +
        `<i class="s-${state}" style="height:${h.toFixed(0)}%"></i></div>`
      );
    })
    .join("");
  return {
    title: "Watch",
    headline: "It watches every way to pay, separately.",
    body:
      `<div class="wgrid">${bars}</div>` +
      `<div class="wfoot"><span>${frame.rails.length} payment methods</span>` +
      `<span>${attempts.toLocaleString("en-IN")} attempts in this window</span>` +
      `<span>all healthy</span></div>`,
    legend:
      "A merchant offers dozens of ways to pay — netbanking through HDFC, UPI through SBI, a Visa " +
      "card. Each one is its own machine, and each one can break on its own while every other one " +
      "looks fine. <b>Every bar here is one of them.</b> Taller means more of its payments are " +
      "failing right now. At this moment they are all short, which is what healthy looks like.",
  };
}

function detectStep(sc: Scenario, at: number): Step | null {
  const frame = sc.frames[at];
  const inc = frame?.inc[0];
  if (frame === undefined || inc === undefined) return null;
  const worst = worstOf(frame);
  const rate = worst?.[2] ?? inc[5];
  const stat = worst?.[4] ?? 0;
  const secs = inc[4] === null ? null : Math.round(inc[4] / 1000);
  return {
    title: "Detect",
    headline: `One starts failing${secs === null ? "" : `, and Kairos notices ${secs} seconds later`}.`,
    body:
      `<div class="who">${esc(railLabel(inc[1]))}</div>` +
      meter(
        rate / 0.6,
        "bad",
        `${pct(rate)} of its payments are failing`,
        "minutes ago it was under 5%",
      ) +
      meter(
        stat / (sc.threshold * 1.7),
        "bad",
        `evidence ${stat.toFixed(1)} — the line is at ${sc.threshold}`,
        "past the line, an incident opens",
      ),
    legend:
      "The top bar is <b>how many payments this method is losing</b>. The bottom bar is <b>how sure " +
      "the detector is that something has really changed</b> — not just one noisy minute. It climbs " +
      "while failures keep arriving and falls back when they stop, and when it crosses the line an " +
      "incident opens by itself. Nobody was watching a dashboard, and the clock above is counted " +
      "from the moment the method actually broke, not from when a person noticed.",
  };
}

function decideStep(who: string): Step {
  return {
    title: "Decide",
    headline: "It proposes one thing: stop sending people to the broken door.",
    body: `<div class="prop"><span>PROPOSED</span><b>Stop offering</b><em>${esc(who)}</em></div>`,
    legend:
      "Kairos cannot fix somebody else's bank. What it can do is <b>stop sending customers into a " +
      "door that is jammed</b> — move the failing method down the checkout, or off it, so people " +
      "land on one that works before they ever see an error. " +
      "<b>A proposal is not permission.</b> Everything on the next step has to clear first.",
  };
}

function checkStep(sc: Scenario, row: LedgerRow): Step {
  const frame = sc.frames[row[0]];
  const rows = sc.boundAxes
    .map((axis, i) => {
      const b = frame?.bounds[i];
      const binding = row[5] === axis[0];
      const use = (b?.[0] ?? 0) * 100;
      return (
        `<div class="bnd${binding ? " binding" : ""}">` +
        `<span>${esc(axis[0])}</span>` +
        `<i><u style="width:${use.toFixed(0)}%"></u></i>` +
        `<b>${esc(b?.[2] ?? "—")}</b><em>of ${esc(axis[1])}</em></div>`
      );
    })
    .join("");
  const allowed = row[3] === 1;
  const kind = allowed ? "ok" : row[5] === null ? "de" : "no";
  return {
    title: "Check",
    headline: "Every action is checked against a mandate the merchant signed.",
    body:
      `<div class="bnds">${rows}</div>` +
      `<div class="vd ${kind}"><span>${
        allowed ? "ALLOWED" : row[5] === null ? "DECLINED" : `REFUSED · ${esc(row[5] ?? "")}`
      }</span><b>${esc(plain(row[4]))}</b></div>`,
    legend:
      "The mandate is a document the merchant signs saying <b>exactly what Kairos may do with their " +
      "money</b>: how much it may spend in total, how often it may contact one person, whether it " +
      "may act at this hour at all, and a switch that stops everything. Each bar is how much of that " +
      "allowance is already used. <b>The action happens only if all four have room</b> — and the " +
      "check runs before the action, not after it.",
  };
}

/** The checkout, as a customer would see it, with the failing method moved. */
function actStep(sc: Scenario, at: number): Step | null {
  const frame = sc.frames[at];
  if (frame === undefined) return null;
  const steered = frame.rails.filter((r) => (r[5] ?? 0) > 0);
  if (steered.length === 0) return null;

  const rows = frame.rails
    .slice()
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .filter((r) => (r[5] ?? 0) === 0)
    .slice(0, 4)
    .map(
      (r, i) =>
        `<div class="ck"><span>${i + 1}</span>${esc(
          railLabel(sc.railKeys[r[0] ?? 0]?.[0] ?? ""),
        )}</div>`,
    )
    .join("");
  const moved = steered
    .map(
      (r) =>
        `<div class="ck gone"><span>—</span>${esc(
          railLabel(sc.railKeys[r[0] ?? 0]?.[0] ?? ""),
        )}<b>${esc(STEER_MODES[r[5] ?? 0] ?? "none")}</b></div>`,
    )
    .join("");
  return {
    title: "Act",
    headline: "The checkout changes, for the next customer who arrives.",
    body: `<div class="ckhead">CHOOSE HOW TO PAY</div><div class="cklist">${rows}${moved}</div>`,
    legend:
      "This is the whole intervention: <b>the broken method stops being offered first</b>. " +
      "<i>Demoted</i> means it moves down the list; <i>suppressed</i> means it comes off the " +
      "checkout altogether until the method recovers. Nobody already part-way through paying is " +
      "interrupted, and nobody had to approve any of it — it happened because the mandate had " +
      "already said it could.",
  };
}

function refuseStep(row: LedgerRow): Step {
  const hard = row[5] !== null;
  return {
    title: hard ? "Refuse" : "Decline",
    headline: hard
      ? "And here is one the mandate would not let it take."
      : "And here is one it decided not to take.",
    body:
      `<div class="vd ${hard ? "no" : "de"} big">` +
      `<span>${hard ? `REFUSED · ${esc(row[5] ?? "")}` : "DECLINED"}</span>` +
      `<b>${esc(plain(row[4]))}</b></div>`,
    legend: hard
      ? "It wanted to act and a bound stopped it. The one that stopped it is named above, and the " +
        "refusal goes into the same ledger as the actions it did take — <b>a refusal is a record, " +
        "not a silence.</b>"
      : "Nothing stopped this one. It had the budget, it had the authority, and it worked out that " +
        "moving customers to a different method would not actually leave them better off — so it " +
        "did nothing. <b>Knowing when not to act is the part a script cannot do</b>, and it is the " +
        "difference between an agent and a scheduled job.",
  };
}

function recordStep(sc: Scenario, at: number): Step {
  const frame = sc.frames[at];
  const rows = sc.ledger
    .filter((r) => r[0] <= at)
    .slice(-6)
    .map((r) => {
      const kind = r[3] === 1 ? "ok" : r[5] === null ? "de" : "no";
      const word = r[3] === 1 ? "allowed" : r[5] === null ? "declined" : "refused";
      return (
        `<div class="lg"><span>${hhmmss(Date.parse(r[1]))}</span>` +
        `<b class="v-${kind}">${word}</b><em>${esc(plain(r[4]))}</em></div>`
      );
    })
    .join("");
  return {
    title: "Record",
    headline: "Everything it did — and everything it refused — is written down.",
    body:
      (rows || `<p class="none">Nothing was proposed, so nothing was written.</p>`) +
      `<div class="chainline">◆ ${frame?.records ?? 0} records, hashed end to end${
        frame?.verified === 1 ? " · the chain verifies" : ""
      }</div>`,
    legend:
      "Each line is one decision and the reason for it. The file is <b>hashed end to end</b>: every " +
      "record carries a fingerprint of the one before it, so removing a line or editing one makes " +
      "every fingerprint after it stop matching. <b>That is what makes this auditable rather than " +
      "merely logged.</b>",
  };
}

export function stepsFor(sc: Scenario): readonly Step[] {
  const openAt = sc.frames.findIndex((f) => f.inc.length > 0);
  const ledger = sc.ledger.slice().sort((a, b) => a[0] - b[0]);
  const allowed = ledger.find((r) => r[3] === 1);
  /* The first `allowed:false` is usually mechanical — a controller releasing authority it no longer
     needs. The one worth showing is a real refusal if there is one, else the last decision taken. */
  const hardRefusal = ledger.find((r) => r[3] === 0 && r[5] !== null);
  const lastDecline = ledger.filter((r) => r[3] === 0).at(-1);
  const refused = hardRefusal ?? lastDecline;
  const who = railLabel(sc.frames[openAt === -1 ? 0 : openAt]?.inc[0]?.[1] ?? "");

  const out: Step[] = [
    watchStep(sc, openAt === -1 ? Math.min(6, sc.frames.length - 1) : Math.max(0, openAt - 2)),
  ];
  if (openAt !== -1) {
    const d = detectStep(sc, openAt);
    if (d !== null) out.push(d);
  }
  const first = allowed ?? ledger[0];
  if (first !== undefined) {
    out.push(decideStep(who));
    out.push(checkStep(sc, first));
  }
  if (allowed !== undefined) {
    const a = actStep(sc, Math.min(allowed[0] + 3, sc.frames.length - 1));
    if (a !== null) out.push(a);
  }
  if (refused !== undefined && refused !== first) out.push(refuseStep(refused));
  out.push(recordStep(sc, sc.frames.length - 1));
  return out;
}

/* ── the player ──────────────────────────────────────────────────────────── */

/** Long enough to read a headline, the artwork and a legend without hurrying. */
const HOLD_MS = 8000;

export class Walkthrough {
  readonly #run: RecordedRun;
  readonly #el: DemoElements;
  readonly #still: boolean;
  #steps: readonly Step[] = [];
  #name = "";
  #at = 0;
  #playing = false;
  #last = 0;
  #onPick: ((name: string) => void) | null = null;

  constructor(run: RecordedRun, el: DemoElements, still: boolean) {
    this.#run = run;
    this.#el = el;
    this.#still = still;

    el.prev.addEventListener("click", () => this.#go(this.#at - 1));
    el.next.addEventListener("click", () => this.#go(this.#at + 1));
    el.play.addEventListener("click", () => {
      this.#playing = !this.#playing;
      this.#last = performance.now();
      this.#paint();
    });
    el.pick.addEventListener("click", () => {
      const opening = el.menu.hasAttribute("hidden");
      if (opening) el.menu.removeAttribute("hidden");
      else el.menu.setAttribute("hidden", "");
      el.pick.setAttribute("aria-expanded", String(opening));
    });
    document.addEventListener("click", (ev) => {
      if (el.menu.hasAttribute("hidden")) return;
      const t = ev.target;
      if (t instanceof Node && (el.menu.contains(t) || el.pick.contains(t))) return;
      el.menu.setAttribute("hidden", "");
      el.pick.setAttribute("aria-expanded", "false");
    });
  }

  /** Told when the reader picks a scenario here, so the operator console can follow. */
  onPick(fn: (name: string) => void): void {
    this.#onPick = fn;
  }

  load(name: string): void {
    const sc = this.#run.scenarios[name];
    if (sc === undefined) return;
    this.#name = name;
    this.#steps = stepsFor(sc);
    this.#at = 0;
    this.#playing = false;
    this.#buildMenu();
    this.#paint();
  }

  step(now: number): void {
    if (!this.#playing || this.#still) return;
    if (now - this.#last < HOLD_MS) return;
    this.#last = now;
    if (this.#at >= this.#steps.length - 1) {
      this.#playing = false;
      this.#paint();
      return;
    }
    this.#go(this.#at + 1);
  }

  #buildMenu(): void {
    const el = this.#el;
    el.menu.innerHTML = DECK.filter(([n]) => this.#run.scenarios[n] !== undefined)
      .map(
        ([n, blurb]) =>
          `<button type="button" data-name="${n}"${n === this.#name ? ' class="on"' : ""}>` +
          `<b>${esc(n.replace(/-/g, " "))}</b><span>${esc(blurb)}</span></button>`,
      )
      .join("");
    for (const b of el.menu.querySelectorAll<HTMLButtonElement>("button")) {
      b.addEventListener("click", () => {
        const name = b.dataset["name"] ?? "";
        el.menu.setAttribute("hidden", "");
        el.pick.setAttribute("aria-expanded", "false");
        this.load(name);
        this.#onPick?.(name);
      });
    }
    const entry = DECK.find(([n]) => n === this.#name);
    el.pick.innerHTML =
      `<span>SHOWING</span><b>${esc((entry?.[0] ?? this.#name).replace(/-/g, " "))}</b>` +
      `<i>${esc(entry?.[1] ?? "")}</i>`;
  }

  #go(to: number): void {
    this.#at = Math.max(0, Math.min(this.#steps.length - 1, to));
    this.#paint();
  }

  #paint(): void {
    const s = this.#steps[this.#at];
    if (s === undefined) return;
    const el = this.#el;

    el.nav.innerHTML = this.#steps
      .map(
        (st, i) =>
          `<li><button type="button" data-i="${i}" class="${
            i === this.#at ? "on" : i < this.#at ? "past" : ""
          }"><span>${String(i + 1).padStart(2, "0")}</span>${esc(st.title)}</button></li>`,
      )
      .join("");
    for (const b of el.nav.querySelectorAll<HTMLButtonElement>("button")) {
      b.addEventListener("click", () => this.#go(Number(b.dataset["i"] ?? 0)));
    }

    el.headline.textContent = s.headline;
    el.panel.innerHTML = s.body;
    el.legend.innerHTML = s.legend;
    el.play.textContent = this.#playing ? "❚❚ PAUSE" : "▶ PLAY ALL";
    el.prev.disabled = this.#at === 0;
    el.next.disabled = this.#at === this.#steps.length - 1;
    el.where.textContent = `${this.#at + 1} / ${this.#steps.length}`;
  }
}
