/**
 * The transport for a recorded run: pick a scenario, scrub, play, pause.
 *
 * It is a player and nothing more. The run is loaded as data and stepped through; no state is
 * derived, no number is recomputed. Scrubbing backwards genuinely un-writes ledger records, because
 * each one is stored against the frame it first appeared in and the feed filters on that.
 */

import { type DemoElements, Walkthrough } from "./demo.js";
import {
  type Readout,
  renderBounds,
  renderFeed,
  renderIncidents,
  renderRails,
  renderReadout,
} from "./render.js";
import { DECK, type LedgerRow, type RecordedRun, type Scenario } from "./types.js";

/** Milliseconds of wall clock per recorded frame while playing. */
const FRAME_MS = 210;

interface Elements {
  readonly deck: HTMLElement;
  readonly premise: HTMLElement;
  readonly watchFor: HTMLElement;
  readonly provenance: HTMLElement;
  readonly scrub: HTMLInputElement;
  readonly play: HTMLButtonElement;
  readonly progress: HTMLElement;
  readonly rails: HTMLElement;
  readonly incidents: HTMLElement;
  readonly bounds: HTMLElement;
  readonly feed: HTMLElement;
  readonly recordCount: HTMLElement;
  readonly readout: Readout;
}

function need<T extends HTMLElement>(id: string): T | null {
  const el = document.getElementById(id);
  return el === null ? null : (el as T);
}

/** Collect the console's elements, or null when this page has no console on it. */
function collect(): Elements | null {
  const ids = {
    deck: need("deck"),
    premise: need("premise"),
    watchFor: need("watchfor"),
    provenance: need("prov-line"),
    scrub: need<HTMLInputElement>("scrub"),
    play: need<HTMLButtonElement>("play"),
    progress: need("tprog"),
    rails: need("rails"),
    incidents: need("incidents"),
    bounds: need("bounds"),
    feed: need("feed"),
    recordCount: need("rec-count"),
    clock: need("lcd-clock"),
    lcdInc: need("lcd-inc"),
    lcdIncWrap: need("lcd-inc-wrap"),
    lcdRec: need("lcd-rec"),
    lcdWorst: need("lcd-worst"),
    lcdWorstWrap: need("lcd-worst-wrap"),
    lcdSteer: need("lcd-steer"),
    lcdRef: need("lcd-ref"),
  };
  if (Object.values(ids).some((v) => v === null)) return null;

  return {
    deck: ids.deck as HTMLElement,
    premise: ids.premise as HTMLElement,
    watchFor: ids.watchFor as HTMLElement,
    provenance: ids.provenance as HTMLElement,
    scrub: ids.scrub as HTMLInputElement,
    play: ids.play as HTMLButtonElement,
    progress: ids.progress as HTMLElement,
    rails: ids.rails as HTMLElement,
    incidents: ids.incidents as HTMLElement,
    bounds: ids.bounds as HTMLElement,
    feed: ids.feed as HTMLElement,
    recordCount: ids.recordCount as HTMLElement,
    readout: {
      clock: ids.clock as HTMLElement,
      incidents: ids.lcdInc as HTMLElement,
      incidentsWrap: ids.lcdIncWrap as HTMLElement,
      records: ids.lcdRec as HTMLElement,
      worst: ids.lcdWorst as HTMLElement,
      worstWrap: ids.lcdWorstWrap as HTMLElement,
      steered: ids.lcdSteer as HTMLElement,
      refusals: ids.lcdRef as HTMLElement,
    },
  };
}

export class ConsolePlayer {
  readonly #run: RecordedRun;
  readonly #el: Elements;
  readonly #still: boolean;

  #name: string;
  #frame = 0;
  #playing = false;
  #lastStep = 0;
  /** Told whenever the deck changes scenario, so the walkthrough can follow it. */
  #onScenario: ((name: string) => void) | null = null;

  constructor(run: RecordedRun, el: Elements, still: boolean) {
    this.#run = run;
    this.#el = el;
    this.#still = still;
    this.#name = DECK[0]?.[0] ?? Object.keys(run.scenarios)[0] ?? "";

    el.scrub.addEventListener("input", () => {
      this.#frame = Number.parseInt(el.scrub.value, 10) || 0;
      this.pause();
      this.render();
    });
    el.play.addEventListener("click", () => {
      if (this.#frame >= this.scenario.frames.length - 1) this.#frame = 0;
      if (this.#playing) this.pause();
      else this.resume();
    });

    this.buildDeck();
  }

  get scenario(): Scenario {
    const found = this.#run.scenarios[this.#name];
    if (found === undefined) throw new Error(`no recorded scenario named ${this.#name}`);
    return found;
  }

  private buildDeck(): void {
    this.#el.deck.innerHTML = "";
    for (const [name, blurb] of DECK) {
      if (this.#run.scenarios[name] === undefined) continue;
      const button = document.createElement("button");
      button.className = "btn";
      button.setAttribute("aria-pressed", String(name === this.#name));
      button.innerHTML = `${name.toUpperCase().replace(/-/g, " ")}<i>${blurb}</i>`;
      button.addEventListener("click", () => {
        this.#name = name;
        this.#frame = 0;
        this.pause();
        this.buildDeck();
        this.render();
        this.#onScenario?.(name);
      });
      this.#el.deck.appendChild(button);
    }
  }

  /** Register the walkthrough's follower. Called once, at mount. */
  follow(fn: (name: string) => void): void {
    this.#onScenario = fn;
    fn(this.#name);
  }

  /** Switch scenario from outside — the tutorial's picker uses this. */
  select(name: string): void {
    if (this.#run.scenarios[name] === undefined || name === this.#name) return;
    this.#name = name;
    this.#frame = 0;
    this.pause();
    this.buildDeck();
    this.render();
  }

  pause(): void {
    this.#playing = false;
    this.#el.play.textContent = "▶ PLAY";
  }

  resume(): void {
    if (this.#still) return;
    this.#playing = true;
    this.#el.play.textContent = "❚❚ PAUSE";
  }

  /**
   * Called when the console view opens.
   *
   * With motion allowed it starts playing from the top, because an interface that waits to be asked
   * is an interface nobody asks. With motion reduced it jumps to a frame where an incident is
   * actually open, so a reader who will not see it move still lands on something happening.
   */
  onShown(): void {
    if (this.#still) {
      if (this.#frame === 0) {
        this.#frame = Math.floor(this.scenario.frames.length * 0.45);
      }
      this.render();
      return;
    }
    this.render();
    if (this.#frame < this.scenario.frames.length - 1) this.resume();
  }

  /** Advance while playing. Driven by the page's animation loop, not its own timer. */
  step(now: number): void {
    if (!this.#playing) return;
    if (now - this.#lastStep < FRAME_MS) return;
    this.#lastStep = now;

    if (this.#frame >= this.scenario.frames.length - 1) {
      this.pause();
      return;
    }
    this.#frame += 1;
    this.render();
  }

  render(): void {
    const scenario = this.scenario;
    const frame = scenario.frames[Math.min(this.#frame, scenario.frames.length - 1)];
    if (frame === undefined) return;
    const el = this.#el;

    el.scrub.max = String(scenario.frames.length - 1);
    el.scrub.value = String(this.#frame);
    el.progress.textContent = `FRAME ${this.#frame + 1} / ${scenario.frames.length}`;
    el.premise.textContent = scenario.premise;
    el.watchFor.textContent = scenario.watchFor;

    const minutes = (this.#run.tickMs * this.#run.keptEvery) / 60_000;
    el.provenance.textContent =
      `simulated traffic · seed ${scenario.seed} · ${scenario.frames.length} frames ` +
      `at ${minutes} simulated minutes each · replayed, not live`;

    renderRails(el.rails, scenario, frame);
    renderIncidents(el.incidents, frame);
    renderBounds(el.bounds, scenario, frame);

    const entries: LedgerRow[] = scenario.ledger
      .filter((e) => e[0] <= this.#frame)
      .slice()
      .reverse();
    renderFeed(el.feed, entries);
    el.recordCount.textContent = String(frame.records);
    renderReadout(el.readout, scenario, frame);

    // Records written on this very frame land with a flash. Anything older is history and should
    // not blink for attention.
    if (!this.#still) {
      const rows = el.feed.querySelectorAll("div");
      rows.forEach((row, i) => {
        if (entries[i]?.[0] === this.#frame) row.classList.add("fresh");
      });
    }
  }
}

/**
 * Load the recorded run and wire the console, if this page has one.
 *
 * Fetched rather than bundled: two hundred kilobytes of records has no business inside the script
 * that draws the artwork, and a separate file is cached separately and replaced by re-running the
 * capture script without touching a line of code.
 */
export interface Mounted {
  readonly player: ConsolePlayer;
  readonly walkthrough: Walkthrough | null;
}

/** The walkthrough's own elements, or null when this page has no walkthrough on it. */
function collectDemo(): DemoElements | null {
  const ids = {
    nav: need("dm-nav"),
    headline: need("dm-head"),
    panel: need("dm-panel"),
    legend: need("dm-legend"),
    prev: need<HTMLButtonElement>("dm-prev"),
    play: need<HTMLButtonElement>("dm-play"),
    next: need<HTMLButtonElement>("dm-next"),
    where: need("dm-where"),
    pick: need<HTMLButtonElement>("dm-pick"),
    menu: need("dm-menu"),
  };
  if (Object.values(ids).some((v) => v === null)) return null;
  return {
    nav: ids.nav as HTMLElement,
    headline: ids.headline as HTMLElement,
    panel: ids.panel as HTMLElement,
    legend: ids.legend as HTMLElement,
    prev: ids.prev as HTMLButtonElement,
    play: ids.play as HTMLButtonElement,
    next: ids.next as HTMLButtonElement,
    where: ids.where as HTMLElement,
    pick: ids.pick as HTMLButtonElement,
    menu: ids.menu as HTMLElement,
  };
}

export async function mountConsole(still: boolean): Promise<Mounted | null> {
  const el = collect();
  if (el === null) return null;

  const response = await fetch("assets/data/console-run.json");
  if (!response.ok) {
    el.rails.innerHTML =
      '<p class="empty">The recorded run did not load. The rest of the page is unaffected.</p>';
    return null;
  }
  const run = (await response.json()) as RecordedRun;
  const player = new ConsolePlayer(run, el, still);

  const demoEl = collectDemo();
  const walkthrough = demoEl === null ? null : new Walkthrough(run, demoEl, still);
  if (walkthrough !== null) {
    // Either control can change the scenario, and the other follows. The player notifies on the
    // way in as well, which is what loads the walkthrough's first scenario.
    player.follow((name) => walkthrough.load(name));
    walkthrough.onPick((name) => player.select(name));
  }

  return { player, walkthrough };
}
