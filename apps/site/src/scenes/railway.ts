/**
 * The four railway scenes that answer the four questions.
 *
 * `interlocking` is the one doing real argumentative work: pulling one lever slides a bar that
 * physically jams the other, which is the difference between a limit that is arithmetic and a limit
 * that is policy. The rest illustrate a claim the copy is already making.
 */

import { band, clamp, dither, glyphs, lerp, px } from "../pixel/raster.js";
import type { SceneArgs } from "../pixel/surface.js";

/* ── The interlocking ──────────────────────────────────────────────────── */

const LOCK_W = 320;
const LOCK_H = 160;

export interface LockState {
  /** True once the locking bar has arrived and lever two can no longer move. */
  readonly jammed: boolean;
}

export function drawInterlocking({ ctx, p, t }: SceneArgs): LockState {
  const q = band(t, 0.1, 0.62);

  px(ctx, 0, 0, LOCK_W, LOCK_H, p.bg);
  px(ctx, 0, 108, LOCK_W, LOCK_H - 108, p.panel);
  px(ctx, 0, 108, LOCK_W, 3, p.line);

  const l1x = 92;
  const l2x = 208;
  const base = 108;
  const pull = q * 26;

  // Lever one, being pulled over. Drawn as a stack of one-pixel rows so it leans rather than
  // rotates: a rotated rectangle in a pixel medium is a smear.
  px(ctx, l1x - 3, base - 4, 12, 8, p.panel2);
  for (let s = 0; s < 56; s += 1) {
    px(ctx, (l1x + (pull * s) / 56) | 0, base - 6 - s, 5, 1, p.accent);
  }
  px(ctx, l1x + pull - 2, base - 68, 9, 9, p.accent);

  const jammed = q > 0.72;
  const l2 = jammed ? p.bad : p.inkDim;
  px(ctx, l2x - 3, base - 4, 12, 8, p.panel2);
  px(ctx, l2x, base - 62, 5, 56, l2);
  px(ctx, l2x - 2, base - 71, 9, 9, l2);

  // The locking bar, sliding right as lever one comes over.
  const barX = 60 + q * 118;
  px(ctx, 40, 124, 240, 3, p.line);
  px(ctx, barX, 118, 74, 12, p.panel2);
  px(ctx, barX, 118, 74, 2, p.line);
  px(ctx, barX, 128, 74, 2, p.line);
  px(ctx, barX + 58, 116, 12, 6, jammed ? p.bad : p.line);

  px(ctx, l1x + 2 + pull, base - 6, 2, 14, p.line);
  px(ctx, l1x + 2 + pull, 120, Math.max(2, barX - l1x - pull), 2, p.line);

  if (jammed) {
    px(ctx, l2x - 5, base - 12, 15, 9, p.bad);
    dither(ctx, l2x - 5, base - 12, 15, 9, p.bg, 0);
  }

  dither(ctx, 0, 132, LOCK_W, 8, p.panel2, 0);
  return { jammed };
}

/* ── The signal box ────────────────────────────────────────────────────── */

const BOX_W = 320;
const BOX_H = 150;

/** How many of the four levers are standing pulled. */
export function drawSignalBox({ ctx, p }: SceneArgs, pulled: number): void {
  px(ctx, 0, 0, BOX_W, BOX_H, p.bg);
  px(ctx, 0, 0, BOX_W, 96, p.panel);
  px(ctx, 0, 96, BOX_W, BOX_H - 96, p.panel2);
  px(ctx, 0, 96, BOX_W, 3, p.line);

  // The window on the night line.
  px(ctx, 92, 14, 136, 56, p.bg);
  px(ctx, 92, 14, 136, 3, p.line);
  px(ctx, 92, 67, 136, 3, p.line);
  px(ctx, 92, 14, 3, 56, p.line);
  px(ctx, 225, 14, 3, 56, p.line);
  px(ctx, 150, 14, 2, 56, p.line);
  for (let i = 0; i < 26; i += 1) {
    px(ctx, 98 + ((i * 37) % 124), 22 + ((i * 53) % 40), 1, 1, p.inkDim);
  }
  px(ctx, 100, 58, 122, 1, p.line);
  px(ctx, 100, 62, 122, 1, p.line);

  // The empty stool, and a clock on the wall. Nobody is at the frame; that is the premise.
  px(ctx, 34, 104, 16, 3, p.line);
  px(ctx, 38, 107, 3, 14, p.line);
  px(ctx, 45, 107, 3, 14, p.line);
  px(ctx, 268, 20, 3, 5, p.line);
  px(ctx, 262, 25, 15, 22, p.panel2);

  px(ctx, 96, 118, 128, 6, p.line);
  for (let i = 0; i < 4; i += 1) {
    const lx = 106 + i * 30;
    const on = i < pulled;
    px(ctx, lx, 78, 6, 42, on ? p.bad : p.line);
    px(ctx, lx - 2, 72, 10, 8, on ? p.bad : p.inkDim);
    glyphs(ctx, String(i + 1), lx + 1, 126, on ? p.bad : p.inkDim, 1);
  }
}

/* ── The chart recorder ────────────────────────────────────────────────── */

const CHART_W = 320;
const CHART_H = 120;

/**
 * One incident, as a failure rate over time: quiet, a ramp, a plateau, a recovery, quiet again.
 *
 * Hand-shaped rather than sampled from a run, because it has to fit 320 pixels and read at a glance.
 * The numbers on the page come from the benchmark; this is the shape of them.
 */
function trace(x: number): number {
  if (x < 0.34) return 0.1 + Math.sin(x * 60) * 0.03;
  if (x < 0.42) return lerp(0.1, 0.78, band(x, 0.34, 0.42));
  if (x < 0.62) return 0.72 + Math.sin(x * 90) * 0.06;
  if (x < 0.7) return lerp(0.75, 0.12, band(x, 0.62, 0.7));
  return 0.11 + Math.sin(x * 60) * 0.03;
}

export interface ChartState {
  /** The rate under the pen right now. */
  readonly rate: number;
}

/**
 * Tuned so the pen spikes on "three minutes from the changepoint" and returns to baseline on "six
 * hours after the rail recovers" — leaving the last lines to be read against a healthy rail with the
 * incident marker still lit, which is the whole of question four.
 */
export function drawChart({ ctx, p, t }: SceneArgs): ChartState {
  const q = band(t, 0.02, 0.45);

  px(ctx, 0, 0, CHART_W, CHART_H, p.panel);
  for (let x = 0; x < CHART_W; x += 8) px(ctx, x, 0, 1, CHART_H, p.panel2);
  for (let y = 0; y < CHART_H; y += 8) px(ctx, 0, y, CHART_W, 1, p.panel2);
  px(ctx, 0, 98, CHART_W, 1, p.line);

  const upto = q * CHART_W;
  for (let x = 0; x < upto; x += 1) {
    const v = trace(x / CHART_W);
    px(ctx, x, 98 - v * 80, 1, 2, v > 0.5 ? p.bad : p.accent);
  }

  if (upto > 2) {
    const now = trace(clamp(upto - 1, 0, CHART_W - 1) / CHART_W);
    const penY = 98 - now * 80;
    px(ctx, upto - 2, 6, 3, penY - 8, p.line);
    px(ctx, upto - 4, penY - 3, 7, 7, p.ink);
  }

  return { rate: trace(clamp(upto - 1, 0, CHART_W - 1) / CHART_W) };
}

/* ── The home signal ───────────────────────────────────────────────────── */

const SIGNAL_W = 320;
const SIGNAL_H = 130;

export interface SignalState {
  readonly clear: boolean;
}

export function drawSignal({ ctx, p, t }: SceneArgs): SignalState {
  const q = band(t, 0.15, 0.7);

  px(ctx, 0, 0, SIGNAL_W, SIGNAL_H, p.bg);
  px(ctx, 0, 74, SIGNAL_W, 22, p.panel);
  dither(ctx, 0, 66, SIGNAL_W, 8, p.panel, 0);
  px(ctx, 0, 96, SIGNAL_W, 12, p.panel2);
  dither(ctx, 0, 92, SIGNAL_W, 5, p.panel2, 1);
  px(ctx, 0, 108, SIGNAL_W, SIGNAL_H - 108, p.bg);
  dither(ctx, 0, 108, SIGNAL_W, 5, p.panel, 0);

  const postX = 152;
  px(ctx, postX, 24, 6, 86, p.line);
  px(ctx, postX - 8, 106, 22, 5, p.line);

  // The arm drops from horizontal to inclined, and the lamp changes with it.
  const clear = q > 0.5;
  for (let i = 0; i < 40; i += 1) {
    px(ctx, postX + 6 + i, 34 + i * 0.62 * q, 1, 5, clear ? p.good : p.bad);
  }
  px(ctx, postX + 40, 34 + 24 * q, 5, 7, p.ink);
  px(ctx, postX - 1, 44, 8, 8, clear ? p.good : p.bad);
  px(ctx, postX + 1, 46, 4, 4, p.ink);

  px(ctx, 0, 118, SIGNAL_W, 2, p.line);
  px(ctx, 0, 124, SIGNAL_W, 2, p.line);
  for (let x = 0; x < SIGNAL_W; x += 10) px(ctx, x, 116, 4, 12, p.panel2);

  return { clear };
}
