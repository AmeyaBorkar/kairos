/**
 * The street: one shop, one afternoon, and the customers who walk away.
 *
 * The only scene on the site with people in it, and the only one about the loss rather than the
 * machinery. Roughly a third of the walkers reach the counter and fail — the same one-in-three the
 * story opens with — and they leave greyed out, carrying nothing.
 */

import type { Palette } from "../palette.js";
import { dither, px, rng } from "../pixel/raster.js";
import type { SceneArgs } from "../pixel/surface.js";

const W = 320;
const H = 170;
const GROUND = 132;

/** How far a walker travels across the whole arc, in scene pixels. */
const TRAVEL = 300;

interface Walker {
  readonly start: number;
  /** True for the ones whose payment will fail. Fixed by seed, not by chance at draw time. */
  readonly fails: boolean;
  readonly bob: number;
}

const walkRandom = rng(4242);
const WALKERS: Walker[] = [];
for (let i = 0; i < 16; i += 1) {
  WALKERS.push({
    start: -30 + i * 27,
    fails: walkRandom() < 0.34,
    bob: (walkRandom() * 6) | 0,
  });
}

/** Eleven pixels tall, and still able to be sad and to be carrying a bag. */
function person(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  y: number,
  colour: string,
  sad: boolean,
  bag: boolean,
): void {
  px(ctx, x + 1, y, 3, 3, colour);
  px(ctx, x + 1, y + 4, 3, 5, colour);
  px(ctx, x, y + 5, 1, 3, colour);
  px(ctx, x + 4, y + 5, 1, 3, colour);
  px(ctx, x + 1, y + 9, 1, 2, colour);
  px(ctx, x + 3, y + 9, 1, 2, colour);
  if (sad) px(ctx, x + 1, y + 3, 3, 1, colour);
  if (bag) px(ctx, x + 5, y + 6, 3, 3, p.accent);
}

export interface StreetState {
  /** Customers who have reached the counter and failed. Only ever climbs. */
  readonly lost: number;
}

export function drawStreet({ ctx, p, t, tick, still }: SceneArgs): StreetState {
  px(ctx, 0, 0, W, H, p.bg);
  px(ctx, 0, GROUND, W, H - GROUND, p.panel);
  dither(ctx, 0, GROUND, W, 4, p.panel2, 0);

  // The shopfront.
  const sx = 26;
  const sy = 40;
  const sw = 108;
  const sh = 92;
  px(ctx, sx, sy, sw, sh, p.panel2);
  px(ctx, sx, sy, sw, 3, p.line);
  px(ctx, sx, sy + sh - 3, sw, 3, p.line);
  px(ctx, sx, sy, 3, sh, p.line);
  px(ctx, sx + sw - 3, sy, 3, sh, p.line);

  for (let i = 0; i < sw; i += 8) px(ctx, sx + i, sy - 9, 4, 9, p.accent);
  px(ctx, sx - 2, sy - 11, sw + 4, 3, p.line);

  px(ctx, sx + 10, sy + 16, 54, 44, p.panel);
  px(ctx, sx + 10, sy + 16, 54, 2, p.line);
  for (let i = 0; i < 3; i += 1) px(ctx, sx + 12 + i * 18, sy + 20, 14, 22, p.bg);

  // The card machine, with its light ticking over.
  px(ctx, sx + 72, sy + 46, 26, 14, p.line);
  px(ctx, sx + 80, sy + 38, 9, 9, p.panel);
  px(ctx, sx + 82, sy + 40, 5, 3, still || ((tick / 22) | 0) % 2 === 0 ? p.warn : p.bg);

  px(ctx, sx + 78, sy + 62, 20, 30, p.bg);
  px(ctx, sx + 94, sy + 76, 2, 3, p.accent);

  const counterX = sx + 78;
  let lost = 0;

  for (const walker of WALKERS) {
    const x = walker.start + t * TRAVEL;
    const passed = x > counterX;
    const failed = passed && walker.fails;

    // Counted before the visibility test, so the tally only ever climbs. Counting after it made the
    // readout fall as the earliest customers left the frame, which is the opposite of the point.
    if (failed) lost += 1;
    if (x < -12 || x > W + 12) continue;

    const colour = failed ? p.inkDim : passed ? p.ink : p.inkDim;
    const bob = still ? 0 : (((x | 0) + walker.bob) >> 2) & 1;
    person(ctx, p, x, GROUND - 11 + bob, colour, failed, passed && !walker.fails);

    if (failed && x < counterX + 26) {
      const cx = x + 1;
      const cy = GROUND - 24;
      px(ctx, cx, cy, 2, 2, p.bad);
      px(ctx, cx + 4, cy, 2, 2, p.bad);
      px(ctx, cx + 2, cy + 2, 2, 2, p.bad);
      px(ctx, cx, cy + 4, 2, 2, p.bad);
      px(ctx, cx + 4, cy + 4, 2, 2, p.bad);
    }
  }

  px(ctx, 0, GROUND + 16, W, 2, p.line);
  return { lost };
}
