/**
 * The case view's animation loop.
 *
 * Each act owns one scene, and each scene is handed the reading position of the act it belongs to.
 * Everything the artwork says in words — the clock, the counters, the frame captions — is HTML
 * updated from the same state the drawing used, so the two can never disagree.
 */

import { palette } from "../palette.js";
import { paintMark } from "../pixel/mark.js";
import { clamp } from "../pixel/raster.js";
import { blit, type SceneArgs, type Surface, surface } from "../pixel/surface.js";
import { drawHero } from "../scenes/hero.js";
import { drawHoldout } from "../scenes/holdout.js";
import { drawBoard, drawPlatform, drawPoints } from "../scenes/jobs.js";
import { drawPlacement } from "../scenes/placement.js";
import { drawChart, drawInterlocking, drawSignal, drawSignalBox } from "../scenes/railway.js";
import { drawStreet } from "../scenes/street.js";
import { actState, entryProgress, heroProgress, nearViewport } from "./scroll.js";

function text(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el !== null) el.textContent = value;
}

function html(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el !== null) el.innerHTML = value;
}

export class Stage {
  readonly #still: boolean;
  #tick = 0;

  readonly #hero: Surface | null;
  readonly #street: Surface | null;
  readonly #lock: Surface | null;
  readonly #holdout: Surface | null;
  readonly #box: Surface | null;
  readonly #chart: Surface | null;
  readonly #signal: Surface | null;
  readonly #points: Surface | null;
  readonly #platform: Surface | null;
  readonly #board: Surface | null;
  readonly #placement: Surface | null;

  /** Question posters: the same scenes, held at one representative instant. */
  readonly #posters: ReadonlyArray<readonly [Surface | null, (a: SceneArgs) => unknown]>;

  readonly #acts: Readonly<Record<string, HTMLElement | null>>;
  readonly #logo: HTMLCanvasElement | null;
  readonly #seams: readonly HTMLCanvasElement[];

  constructor(still: boolean) {
    this.#still = still;

    this.#hero = surface("c-hero", 320, 200);
    this.#street = surface("c-street", 320, 170);
    this.#lock = surface("c-lock", 320, 160);
    this.#holdout = surface("c-holdout", 320, 150);
    this.#box = surface("c-box", 320, 150);
    this.#chart = surface("c-chart", 320, 120);
    this.#signal = surface("c-signal", 320, 130);
    this.#points = surface("c-points", 160, 96);
    this.#platform = surface("c-platform", 160, 96);
    this.#board = surface("c-board", 160, 96);
    this.#placement = surface("c-placement", 320, 150);

    this.#posters = [
      [surface("c-q1", 320, 160), drawInterlocking],
      [surface("c-q2", 320, 150), drawHoldout],
      [surface("c-q3", 320, 150), (a) => drawSignalBox(a, 4)],
      [surface("c-q4", 320, 120), drawChart],
    ];

    this.#acts = {
      pro: document.querySelector('.act[data-act="pro"]'),
      q1: document.querySelector('.act[data-act="q1"]'),
      q2: document.querySelector('.act[data-act="q2"]'),
      q3: document.querySelector('.act[data-act="q3"]'),
      q4: document.querySelector('.act[data-act="q4"]'),
    };

    const logo = document.getElementById("c-logo");
    this.#logo = logo instanceof HTMLCanvasElement ? logo : null;
    this.#seams = [...document.querySelectorAll<HTMLCanvasElement>("canvas.c-seam")];
  }

  #args(s: Surface, t: number): SceneArgs {
    return { ctx: s.ctx, p: palette, t, tick: this.#tick, still: this.#still };
  }

  /**
   * Repaint everything that is drawn once rather than every frame: the mark and the four posters.
   * Called at startup, on every palette or pixel change, and on every view switch.
   */
  repaintStatic(): void {
    for (const [s, draw] of this.#posters) {
      if (s === null) continue;
      draw(this.#args(s, 1));
      blit(s);
    }

    // Section seams carry the mark at one pixel a cell, dimmed: a divider that is also the logo.
    for (const seam of this.#seams) {
      const ctx = seam.getContext("2d");
      if (ctx === null) continue;
      seam.width = 16;
      seam.height = 16;
      paintMark(ctx, 1, {
        ink: palette.line,
        accent: palette.accent,
        good: palette.good,
        bad: palette.bad,
      });
    }

    if (this.#logo !== null) {
      const scale = 4;
      this.#logo.width = 16 * scale;
      this.#logo.height = 16 * scale;
      const ctx = this.#logo.getContext("2d");
      if (ctx !== null) {
        paintMark(ctx, scale, {
          ink: palette.ink,
          accent: palette.accent,
          good: palette.good,
          bad: palette.bad,
        });
      }
    }
  }

  /** One frame of the case view. Called only while the case view is showing. */
  frame(): void {
    if (!this.#still) this.#tick += 1;
    const vh = window.innerHeight || 800;

    if (this.#hero !== null && window.scrollY < vh * 1.4) {
      drawHero(this.#args(this.#hero, heroProgress()));
      blit(this.#hero);
    }

    this.#prologue();
    this.#placementDiagram();
    this.#jobs();
    this.#overspend();
    this.#helped();
    this.#audit();
    this.#unknown();
    this.#closing();
  }

  #prologue(): void {
    const act = this.#acts["pro"];
    if (act == null || this.#street === null) return;
    const state = actState(act);
    if (!state.onscreen) return;

    const { lost } = drawStreet(this.#args(this.#street, state.t));
    blit(this.#street);

    // Seven walked away for every one the scene had room to draw.
    text("lost", String(lost * 7));
    const minute = 14 + Math.floor(state.t * 40);
    text("clock", `14:${minute < 10 ? "0" : ""}${minute}`);
    text(
      "street-cap",
      lost === 0 ? "TRADING NORMALLY" : lost < 4 ? "SOMETHING IS WRONG" : "NOBODY HAS NOTICED",
    );
  }

  #placementDiagram(): void {
    if (this.#placement === null || !nearViewport(this.#placement.el)) return;
    const { sealed } = drawPlacement(
      this.#args(this.#placement, entryProgress(this.#placement.el)),
    );
    blit(this.#placement);
    text("placement-cap", sealed ? "BOUNDED BY A SEALED MANDATE" : "UNBOUNDED");
  }

  #jobs(): void {
    const cards: ReadonlyArray<readonly [Surface | null, (a: SceneArgs) => void]> = [
      [this.#points, drawPoints],
      [this.#platform, drawPlatform],
      [this.#board, drawBoard],
    ];
    for (const [s, draw] of cards) {
      if (s === null || !nearViewport(s.el)) continue;
      draw(this.#args(s, entryProgress(s.el)));
      blit(s);
    }
  }

  #overspend(): void {
    const act = this.#acts["q1"];
    if (act == null || this.#lock === null) return;
    const state = actState(act);
    if (!state.onscreen) return;

    const { jammed } = drawInterlocking(this.#args(this.#lock, state.t));
    blit(this.#lock);

    html(
      "lock-tag",
      jammed ? "LEVER 2 · <b>LOCKED</b>" : 'LEVER 2 · <b style="color:var(--accent)">FREE</b>',
    );
    text("lock-cap", jammed ? "CONFLICT IMPOSSIBLE" : "BOTH LEVERS FREE");
    document.getElementById("lock-frame")?.classList.toggle("lit", jammed);
  }

  #helped(): void {
    const act = this.#acts["q2"];
    if (act == null || this.#holdout === null) return;
    const state = actState(act);
    if (!state.onscreen) return;

    const { through, held, gap } = drawHoldout(this.#args(this.#holdout, state.t));
    blit(this.#holdout);

    html("holdout-tag", gap > 0 ? `GAP <b style="color:var(--good)">${gap}</b>` : "GAP <b>—</b>");
    text("holdout-cap", gap > 0 ? `THROUGH ${through} · HELD BACK ${held}` : "BOTH ARMS EQUAL");
  }

  #audit(): void {
    const act = this.#acts["q3"];
    if (act == null || this.#box === null) return;
    const state = actState(act);
    if (!state.onscreen) return;

    const pulled = clamp(state.step + 2, 0, 4);
    drawSignalBox(this.#args(this.#box, state.t), pulled);
    blit(this.#box);

    text("box-count", String(pulled));
    text("box-cap", `${pulled} OF 4 · ALL RECORDED`);
  }

  #unknown(): void {
    const act = this.#acts["q4"];
    if (act == null || this.#chart === null) return;
    const state = actState(act);
    if (!state.onscreen) return;

    const { rate, wide } = drawChart(this.#args(this.#chart, state.t));
    blit(this.#chart);

    /* One trace and the envelope around it. Question four is not what went wrong — it is what
       the measurement is unable to say, and the widening band is that made visible. */
    html(
      "chart-tag",
      rate > 0.5
        ? '<b style="color:var(--bad)">RAIL DEGRADED</b>'
        : wide
          ? '<b style="color:var(--warn)">BAND &gt; VALUE</b>'
          : "SEEDED RUN",
    );
    text(
      "chart-cap",
      rate > 0.5 ? "RATE 72% · MEASURED" : wide ? "cv 37.6% · REPORTED" : "RATE 10% · QUIET",
    );
  }

  #closing(): void {
    if (this.#signal === null || !nearViewport(this.#signal.el)) return;

    /* Driven by the canvas, not the section around it. The section's top sits 146px above the
       artwork, which was enough to push the whole arm-drop off the bottom of the screen. */
    const { clear } = drawSignal(this.#args(this.#signal, entryProgress(this.#signal.el)));
    blit(this.#signal);

    html(
      "signal-tag",
      clear
        ? 'SIGNAL <b style="color:var(--good)">CLEAR</b>'
        : 'SIGNAL AT <b style="color:var(--bad)">DANGER</b>',
    );
    text("signal-cap", clear ? "CLEAR" : "DANGER");
  }
}
