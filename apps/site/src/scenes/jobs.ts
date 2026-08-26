/**
 * The three small scenes on the job cards: prevention, recovery and language.
 *
 * All 160×96, all driven by their own entry into the viewport rather than by a reading position, so
 * they play once as the card arrives and then hold.
 */

import { band, clamp, dither, glyphs, lerp, px, rng } from "../pixel/raster.js";
import type { SceneArgs } from "../pixel/surface.js";

const W = 160;
const H = 96;

/* ── Prevention: the points swing traffic off a broken rail ─────────────── */

export function drawPoints({ ctx, p, t }: SceneArgs): void {
  const q = band(t, 0.1, 0.7);

  px(ctx, 0, 0, W, H, p.panel);
  dither(ctx, 0, 66, W, 30, p.panel2, 0);

  for (let x = 0; x < W; x += 1) {
    if (x > 96 && x < 118) continue;
    px(ctx, x, 34, 1, 2, p.line);
  }
  for (let x = 0; x < W; x += 6) px(ctx, x, 30, 3, 1, p.panel2);
  px(ctx, 98, 30, 18, 10, p.bad);
  dither(ctx, 98, 30, 18, 10, p.panel, 0);

  for (let x = 60; x < W; x += 1) px(ctx, x, 60, 1, 2, p.good);
  for (let x = 60; x < W; x += 6) px(ctx, x, 56, 3, 1, p.panel2);

  // The switch blade, opening as the decision is taken.
  for (let i = 0; i < 30; i += 1) px(ctx, 32 + i, 34 + ((i * 26) / 30) * q, 2, 2, p.accent);

  const tx = 8 + q * 108;
  const ty = q > 0.5 ? lerp(34, 58, band(q, 0.5, 0.85)) : 30;
  px(ctx, tx, ty - 6, 22, 8, p.accent);
  px(ctx, tx + 22, ty - 4, 4, 4, p.warn);
  px(ctx, tx + 3, ty + 2, 3, 2, p.line);
  px(ctx, tx + 15, ty + 2, 3, 2, p.line);
}

/* ── Recovery: a later train, for the people left on the platform ───────── */

export function drawPlatform({ ctx, p, t }: SceneArgs): void {
  const q = band(t, 0.1, 0.75);

  px(ctx, 0, 0, W, H, p.panel);
  px(ctx, 0, 62, W, 34, p.panel2);
  px(ctx, 0, 62, W, 2, p.line);
  px(ctx, 0, 16, W, 4, p.line);
  for (let x = 8; x < W; x += 36) px(ctx, x, 20, 3, 42, p.line);
  px(ctx, 0, 88, W, 2, p.line);
  px(ctx, 0, 94, W, 2, p.line);

  const trainX = -70 + q * 150;
  for (let i = 0; i < 5; i += 1) {
    const wx = 22 + i * 21;
    const boarded = trainX + 60 > wx;
    const colour = boarded ? p.panel2 : p.inkDim;
    // A waiting figure, six pixels of it. Slumped until the train arrives.
    px(ctx, wx + 1, 51, 3, 3, colour);
    px(ctx, wx + 1, 55, 3, 5, colour);
    px(ctx, wx, 56, 1, 3, colour);
    px(ctx, wx + 4, 56, 1, 3, colour);
    if (!boarded) px(ctx, wx + 1, 54, 3, 1, colour);
  }

  px(ctx, trainX, 66, 64, 20, p.accent);
  px(ctx, trainX + 4, 70, 10, 8, p.bg);
  px(ctx, trainX + 20, 70, 10, 8, p.bg);
  px(ctx, trainX + 36, 70, 10, 8, p.bg);
  px(ctx, trainX + 52, 70, 8, 8, p.bg);
  px(ctx, trainX + 64, 72, 4, 5, p.warn);
}

/* ── Language: a split-flap board, in four scripts ──────────────────────── */

/**
 * Scripts are drawn by their visual signature rather than their glyphs: Devanagari by its continuous
 * head-line, Tamil by its loops, Latin by neither. A three-pixel font cannot render four writing
 * systems, and faking them badly would be worse than representing them honestly.
 */
const SCRIPTS = ["EN", "HI", "MR", "TA"] as const;

export function drawBoard({ ctx, p, t, tick, still }: SceneArgs): void {
  px(ctx, 0, 0, W, H, p.bg);
  px(ctx, 6, 6, W - 12, H - 12, p.panel2);
  px(ctx, 6, 6, W - 12, 3, p.line);
  px(ctx, 6, H - 9, W - 12, 3, p.line);

  const which = clamp(Math.floor(band(t, 0.05, 0.95) * 3.999), 0, 3);
  const flipping = !still && tick % 120 < 8;

  px(ctx, 12, 12, 20, 10, p.accent);
  glyphs(ctx, SCRIPTS[which] ?? "EN", 15, 15, p.bg, 1);

  const words = rng(900 + which * 31);
  for (let row = 0; row < 4; row += 1) {
    const y = 30 + row * 15;
    let x = 14;
    const count = 3 + ((words() * 2) | 0);
    for (let w = 0; w < count; w += 1) {
      const len = 12 + ((words() * 22) | 0);
      if (x + len > W - 16) break;

      if (flipping) {
        px(ctx, x, y + 3, len, 3, p.line);
      } else if (which === 1 || which === 2) {
        px(ctx, x, y, len, 2, p.ink);
        for (let k = 0; k < len; k += 4) px(ctx, x + k, y + 2, 3, 6, p.ink);
      } else if (which === 3) {
        for (let k = 0; k < len; k += 5) {
          px(ctx, x + k, y + 1, 4, 2, p.ink);
          px(ctx, x + k, y + 3, 1, 3, p.ink);
          px(ctx, x + k + 3, y + 3, 1, 3, p.ink);
          px(ctx, x + k, y + 6, 4, 2, p.ink);
        }
      } else {
        for (let k = 0; k < len; k += 4) {
          const height = 4 + ((k * 7 + row * 3) % 3);
          px(ctx, x + k, y + (8 - height), 3, height, p.ink);
        }
      }
      x += len + 6;
    }
  }
}
