/**
 * The holdout.
 *
 * Two identical streams of traffic. The upper one is switched away from the broken rail; the lower
 * one is deliberately left on it, because the difference between them is the only number that means
 * anything. The bracket on the right measures that difference, and it exists only because somebody
 * chose to pay for the lower track.
 *
 * The scene reports counts of what it actually drew rather than a percentage. A diagram may show a
 * gap; it may not invent a lift figure — those come from the benchmark or they do not appear.
 */

import { band, dither, glyphs, px } from "../pixel/raster.js";
import type { SceneArgs } from "../pixel/surface.js";

const W = 320;
const H = 150;
const BREAK_X = 150;
const BREAK_W = 26;

export interface HoldoutState {
  /** Treated traffic that got past the break. */
  readonly through: number;
  /** Holdout traffic still moving, before it piles up. */
  readonly held: number;
  /** The difference the bracket is measuring. */
  readonly gap: number;
}

export function drawHoldout({ ctx, p, t }: SceneArgs): HoldoutState {
  const q = band(t, 0.08, 0.78);

  px(ctx, 0, 0, W, H, p.panel);
  dither(ctx, 0, 120, W, 30, p.panel2, 0);

  // Upper track: treated. Broken ahead, and the points throw before it.
  for (let x = 0; x < W; x += 1) {
    if (x > BREAK_X && x < BREAK_X + BREAK_W) continue;
    px(ctx, x, 44, 1, 2, p.line);
  }
  for (let x = 0; x < W; x += 7) px(ctx, x, 40, 3, 1, p.panel2);
  px(ctx, BREAK_X, 40, BREAK_W, 10, p.bad);
  dither(ctx, BREAK_X, 40, BREAK_W, 10, p.panel, 0);

  // The diversion, drawn only as far as the points have actually thrown.
  for (let i = 0; i < 34; i += 1) {
    if (i / 34 > q) break;
    px(ctx, 116 + i, 44 + (((i * 16) / 34) | 0), 2, 2, p.accent);
  }
  if (q > 0.3) {
    for (let x = 150; x < W; x += 1) px(ctx, x, 60, 1, 2, p.good);
  }

  // Lower track: the holdout. Never switched, and it meets the same break.
  for (let x = 0; x < W; x += 1) px(ctx, x, 104, 1, 2, p.line);
  for (let x = 0; x < W; x += 7) px(ctx, x, 100, 3, 1, p.panel2);
  px(ctx, BREAK_X, 100, BREAK_W, 10, p.bad);
  dither(ctx, BREAK_X, 100, BREAK_W, 10, p.panel, 0);

  let through = 0;
  let held = 0;
  for (let i = 0; i < 9; i += 1) {
    const x = -40 + i * 30 + q * 210;
    if (x > -14 && x < W) {
      const diverted = q > 0.32 && x > 120;
      px(ctx, x, diverted ? 54 : 38, 12, 6, diverted ? p.good : p.accent);
      if (x > BREAK_X + BREAK_W) through += 1;
    }
    if (x > -14 && x < W) {
      const stuck = x > BREAK_X - 14;
      px(ctx, stuck ? BREAK_X - 14 - (i % 3) * 15 : x, 98, 12, 6, stuck ? p.inkDim : p.ink);
      if (!stuck) held += 1;
    }
  }

  // The bracket: the measurement, and the point of the whole scene.
  px(ctx, 296, 52, 3, 58, p.inkDim);
  px(ctx, 292, 52, 8, 3, p.inkDim);
  px(ctx, 292, 107, 8, 3, p.inkDim);
  const gap = Math.max(0, through - held);
  glyphs(ctx, String(gap), 284, 74, gap > 0 ? p.good : p.inkDim, 2);

  px(ctx, 0, H - 4, W, 2, p.line);
  return { through, held, gap };
}
