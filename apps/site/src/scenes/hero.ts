/**
 * The hero: a train crossing the frame, left to right, at 14:14.
 *
 * Side elevation rather than perspective. A receding track has to earn its depth from sleeper
 * spacing and rail taper, and is still ambiguous at 320 pixels wide; an elevation is unmistakable
 * from the first glance and spends every pixel it has on detail instead of on convincing you where
 * the ground is.
 *
 * Four planes, each moving at its own rate: stars fixed, skyline drifting on scroll, catenary masts
 * passing behind the train, and the train itself on a free-running clock so the scene is alive
 * before anybody has scrolled anything. The signal ahead of it stands at danger, which is the story
 * the rest of the page is about.
 */

import type { Palette } from "../palette.js";
import { dither, glyphs, px, rng } from "../pixel/raster.js";
import type { SceneArgs } from "../pixel/surface.js";

const W = 320;
const H = 200;

/* The datums everything hangs from. Named, because a drawing this dense becomes unmaintainable the
   moment its numbers are anonymous. */
const WIRE_Y = 76; // the contact wire the pantograph runs against
const SKYLINE_Y = 142; // where the far side of the cutting meets the buildings
const RAIL_Y = 160; // top of rail — the wheels stand on this
const ROOF_Y = 104;
const BODY_Y = 108;
const BODY_H = 30;
const SOLEBAR_Y = BODY_Y + BODY_H;
const WHEEL_R = 5;
const WHEEL_CY = RAIL_Y - WHEEL_R;

const LOCO_LEN = 96;
const COACH_LEN = 64;
const COACH_GAP = 5;
const COACHES = 3;
const TRAIN_LEN = LOCO_LEN + COACHES * (COACH_LEN + COACH_GAP);

/* ── The world behind ──────────────────────────────────────────────────── */

interface Star {
  readonly x: number;
  readonly y: number;
  readonly phase: number;
}
interface Block {
  readonly x: number;
  readonly w: number;
  readonly h: number;
  readonly lit: number;
}

const starRandom = rng(20260826);
const stars: Star[] = [];
for (let i = 0; i < 90; i += 1) {
  stars.push({ x: (starRandom() * W) | 0, y: (starRandom() * 66) | 0, phase: starRandom() });
}

const skyRandom = rng(77);
const far: Block[] = [];
const near: Block[] = [];
for (let i = 0; i < 30; i += 1) {
  far.push({ x: i * 12, w: 8 + ((skyRandom() * 6) | 0), h: 22 + ((skyRandom() * 30) | 0), lit: 0 });
}
for (let i = 0; i < 18; i += 1) {
  near.push({
    x: i * 20,
    w: 14 + ((skyRandom() * 9) | 0),
    h: 26 + ((skyRandom() * 40) | 0),
    lit: skyRandom(),
  });
}

/* ── Rolling stock ─────────────────────────────────────────────────────── */

/**
 * A wheel, ten pixels across, with a spoke pattern that turns.
 *
 * At this size rotation cannot be drawn as an angle, so it is drawn as two states — a cross and an
 * X — chosen by how far the train has travelled. The eye reads the alternation as turning and never
 * counts the frames.
 */
function wheel(ctx: CanvasRenderingContext2D, p: Palette, cx: number, travelled: number): void {
  px(ctx, cx - WHEEL_R, WHEEL_CY - WHEEL_R + 1, WHEEL_R * 2, WHEEL_R * 2 - 1, p.inkDim);
  px(ctx, cx - WHEEL_R + 1, WHEEL_CY - WHEEL_R, WHEEL_R * 2 - 2, WHEEL_R * 2 + 1, p.inkDim);
  px(ctx, cx - 3, WHEEL_CY - 3, 6, 6, p.bg);
  px(ctx, cx - 4, WHEEL_CY - 2, 8, 4, p.bg);
  px(ctx, cx - 2, WHEEL_CY - 4, 4, 8, p.bg);

  if (Math.abs(Math.floor(travelled / 3)) % 2 === 0) {
    px(ctx, cx - 3, WHEEL_CY, 7, 1, p.inkDim);
    px(ctx, cx, WHEEL_CY - 3, 1, 7, p.inkDim);
  } else {
    for (let k = -2; k <= 2; k += 1) {
      px(ctx, cx + k, WHEEL_CY + k, 1, 1, p.inkDim);
      px(ctx, cx + k, WHEEL_CY - k, 1, 1, p.inkDim);
    }
  }
  px(ctx, cx - 1, WHEEL_CY - 1, 2, 2, p.ink);
}

/** A bogie: frame, spring hangers, and however many axles it carries. */
function bogie(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  axles: number,
  travelled: number,
): void {
  const span = axles === 3 ? 30 : 20;
  px(ctx, x, 146, span, 9, p.panel2);
  px(ctx, x, 146, span, 2, p.line);
  for (let a = 0; a < axles; a += 1) {
    const cx = x + 5 + a * ((span - 10) / Math.max(1, axles - 1));
    px(ctx, cx - 4, 143, 8, 4, p.line);
    wheel(ctx, p, cx, travelled);
  }
}

/**
 * The pantograph, reaching from the roof to the contact wire.
 *
 * A single-arm design, because a double-arm one at this scale is four pixels of ambiguity. The shoe
 * meets the wire exactly, and now and then throws a spark — the detail that says the thing is
 * drawing power rather than coasting.
 */
function pantograph(ctx: CanvasRenderingContext2D, p: Palette, x: number, spark: boolean): void {
  px(ctx, x - 12, ROOF_Y - 3, 24, 3, p.line);
  px(ctx, x - 9, ROOF_Y - 5, 4, 3, p.panel2);
  px(ctx, x + 6, ROOF_Y - 5, 4, 3, p.panel2);

  // Lower arm leaning back, upper arm returning forward to the shoe.
  for (let i = 0; i < 16; i += 1) px(ctx, x - 6 - (i >> 1), ROOF_Y - 6 - i, 2, 1, p.inkDim);
  for (let i = 0; i < 10; i += 1) px(ctx, x - 14 + i, ROOF_Y - 22 - (i >> 1), 2, 1, p.inkDim);

  px(ctx, x - 10, WIRE_Y + 1, 18, 2, p.ink);
  if (spark) {
    px(ctx, x - 3, WIRE_Y - 2, 5, 2, p.warn);
    px(ctx, x - 1, WIRE_Y - 4, 2, 2, p.warn);
  }
}

/**
 * The locomotive, facing right: raked cab, livery band, louvre grilles, six axles on two bogies,
 * and a headlight throwing a beam down the rail ahead of it.
 */
function locomotive(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  travelled: number,
  spark: boolean,
): void {
  const nose = x + LOCO_LEN;

  px(ctx, x + 2, SOLEBAR_Y, LOCO_LEN - 4, 6, p.line);
  px(ctx, x + 8, SOLEBAR_Y + 3, 26, 6, p.panel2);
  px(ctx, x + 52, SOLEBAR_Y + 3, 20, 6, p.panel2);

  px(ctx, x, BODY_Y, LOCO_LEN, BODY_H, p.panel2);
  px(ctx, x, BODY_Y, LOCO_LEN, 2, p.inkDim);
  px(ctx, x, SOLEBAR_Y - 2, LOCO_LEN, 2, p.line);
  px(ctx, x - 2, ROOF_Y, LOCO_LEN - 4, 4, p.line); // roof, stopping short of the raked nose

  // The raked nose. Cut away, not filled: the first version drew body colour over body colour and
  // the front stayed square, which is the sort of edit that looks done and changes nothing.
  for (let i = 0; i < 5; i += 1) {
    px(ctx, nose - 10 + i * 2, ROOF_Y, 2, 4 + (i + 1) * 2, p.bg);
  }
  for (let i = 0; i < 5; i += 1) {
    px(ctx, nose - 10 + i * 2, ROOF_Y + 4 + (i + 1) * 2, 2, 2, p.inkDim);
  }

  px(ctx, x, BODY_Y + 20, LOCO_LEN - 6, 4, p.accent);
  px(ctx, x, BODY_Y + 24, LOCO_LEN - 6, 1, p.line);

  px(ctx, nose - 26, BODY_Y + 5, 18, 11, p.bg);
  px(ctx, nose - 25, BODY_Y + 6, 7, 9, p.accent);
  px(ctx, nose - 16, BODY_Y + 6, 7, 9, p.accent);
  for (let i = 0; i < 3; i += 1) px(ctx, x + 10 + i * 13, BODY_Y + 6, 8, 8, p.bg);

  // Louvre grilles: the texture that says machinery rather than box.
  for (let i = 0; i < 18; i += 1) px(ctx, x + 8 + i * 3, BODY_Y + 27, 2, 8, p.line);

  px(ctx, nose - 4, SOLEBAR_Y - 4, 4, 10, p.line);
  px(ctx, nose, SOLEBAR_Y + 1, 3, 3, p.inkDim);

  px(ctx, nose - 7, BODY_Y + 20, 5, 4, p.warn);
  for (let i = 0; i < 26; i += 1) {
    if (((i + (travelled | 0)) & 3) === 0) continue;
    px(ctx, nose + 2 + i, RAIL_Y - 2 + (i >> 3), 2, 1, p.warn);
  }
  px(ctx, x + 1, BODY_Y + 21, 3, 3, p.bad);

  glyphs(ctx, "14", x + 30, BODY_Y + 28, p.inkDim, 1);

  bogie(ctx, p, x + 8, 3, travelled);
  bogie(ctx, p, x + 58, 3, travelled);
  pantograph(ctx, p, x + 30, spark);
}

/** A coach: lit windows, a door, underfloor boxes, two bogies. */
function coach(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  index: number,
  travelled: number,
): void {
  px(ctx, x + 2, SOLEBAR_Y, COACH_LEN - 4, 6, p.line);
  px(ctx, x + 14, SOLEBAR_Y + 3, 18, 6, p.panel2);

  px(ctx, x, BODY_Y + 2, COACH_LEN, BODY_H - 2, p.panel2);
  px(ctx, x, BODY_Y + 2, COACH_LEN, 2, p.inkDim);
  px(ctx, x, SOLEBAR_Y - 2, COACH_LEN, 2, p.line);
  px(ctx, x - 1, ROOF_Y + 2, COACH_LEN + 2, 4, p.line);
  px(ctx, x, BODY_Y + 22, COACH_LEN, 3, p.accent);

  // Which windows are lit is fixed by seed, so the same coach is the same coach every lap. A train
  // whose passengers reshuffle each time round is a screensaver.
  const lamp = rng(311 + index * 97);
  for (let i = 0; i < 5; i += 1) {
    const wx = x + 6 + i * 11;
    const on = lamp() < 0.72;
    px(ctx, wx, BODY_Y + 8, 8, 10, on ? p.warn : p.bg);
    if (on && lamp() < 0.5) px(ctx, wx + 2, BODY_Y + 11, 4, 7, p.line);
  }

  px(ctx, x + COACH_LEN - 8, BODY_Y + 6, 6, 24, p.line);
  px(ctx, x + COACH_LEN - 7, BODY_Y + 8, 4, 7, p.bg);

  bogie(ctx, p, x + 6, 2, travelled);
  bogie(ctx, p, x + COACH_LEN - 26, 2, travelled);
}

/* ── The scene ─────────────────────────────────────────────────────────── */

export function drawHero({ ctx, p, t, tick, still }: SceneArgs): void {
  px(ctx, 0, 0, W, H, p.bg);

  for (const star of stars) {
    if (still || (tick * 0.02 + star.phase * 9) % 3 > 1.1) px(ctx, star.x, star.y, 1, 1, p.inkDim);
  }

  // Skyline, on scroll. Two ranks at different rates.
  const slow = -t * 12;
  const mid = -t * 26;
  for (const b of far) px(ctx, b.x + slow, SKYLINE_Y - b.h, b.w, b.h, p.panel);
  for (const b of near) {
    const bx = b.x + mid;
    px(ctx, bx, SKYLINE_Y - b.h, b.w, b.h, p.panel2);
    px(ctx, bx, SKYLINE_Y - b.h, b.w, 1, p.line);
    for (let wy = 4; wy < b.h - 4; wy += 6) {
      for (let wx = 3; wx < b.w - 3; wx += 5) {
        if (((wx * 7 + wy * 13 + b.lit * 100) | 0) % 5 < 2) {
          px(ctx, bx + wx, SKYLINE_Y - b.h + wy, 2, 2, p.accent);
        }
      }
    }
  }

  // The clock, in a window of the seventh near building. 14:14 is not decorative — it is the minute
  // the rail in the story starts failing.
  const anchor = near[6];
  if (anchor !== undefined) {
    const cx = anchor.x + mid + 3;
    const cy = SKYLINE_Y - anchor.h + 8;
    px(ctx, cx - 2, cy - 2, 27, 11, p.bg);
    px(ctx, cx - 2, cy - 2, 27, 1, p.line);
    glyphs(ctx, "14:14", cx, cy, p.accent, 1);
  }

  px(ctx, 0, SKYLINE_Y, W, RAIL_Y - SKYLINE_Y, p.panel);
  dither(ctx, 0, SKYLINE_Y, W, 6, p.panel2, 0);

  // Catenary: contact wire, messenger above it, and the masts carrying both. Drawn before the train
  // because the far side of the track is where the masts stand.
  const fast = -t * 54;
  px(ctx, 0, WIRE_Y, W, 1, p.line);
  px(ctx, 0, WIRE_Y - 12, W, 1, p.line);
  for (let i = -1; i < 5; i += 1) {
    const mx = i * 92 + (fast % 92) + 40;
    if (mx < -20 || mx > W + 20) continue;
    px(ctx, mx, WIRE_Y - 22, 4, SKYLINE_Y - WIRE_Y + 22, p.line);
    // Lattice: two verticals cross-braced, which is what a catenary mast actually looks like and
    // costs three pixels more than a post.
    px(ctx, mx + 7, WIRE_Y - 16, 2, SKYLINE_Y - WIRE_Y + 16, p.line);
    for (let k = 0; k < 6; k += 1) {
      px(ctx, mx + 4, WIRE_Y - 12 + k * 12, 4, 2, p.line);
    }
    // The bracket arm, out over the track, with a dropper holding the contact wire beneath it.
    px(ctx, mx - 30, WIRE_Y - 14, 34, 3, p.line);
    px(ctx, mx - 28, WIRE_Y - 11, 2, 11, p.line);
    px(ctx, mx - 12, WIRE_Y - 11, 2, 11, p.line);
  }

  // The signal, ahead of the train, standing at danger.
  const sigX = 288;
  px(ctx, sigX, 112, 4, SKYLINE_Y - 112 + 12, p.line);
  px(ctx, sigX - 5, 104, 14, 20, p.panel2);
  px(ctx, sigX - 5, 104, 14, 2, p.line);
  px(ctx, sigX - 2, 108, 8, 6, still || tick % 76 < 50 ? p.bad : p.panel);
  px(ctx, sigX - 2, 116, 8, 6, p.panel);

  // Ballast, sleepers and rail — laid before the stock that stands on them. Drawn afterwards, as
  // this was at first, the track buries every wheel and the whole underframe stops meaning anything.
  px(ctx, 0, RAIL_Y + 1, W, H - RAIL_Y - 1, p.panel);
  dither(ctx, 0, RAIL_Y + 1, W, 12, p.panel2, 1);
  for (let x = (fast % 9) - 9; x < W; x += 9) px(ctx, x, RAIL_Y + 2, 6, 3, p.panel2);
  px(ctx, 0, RAIL_Y, W, 2, p.inkDim);

  /* The train, on a free-running clock rather than on scroll, so the hero is moving before anybody
     has done anything — and parked somewhere legible when motion is unwelcome. */
  const cycle = W + TRAIN_LEN + 90;
  const travelled = still ? 0 : tick * 0.42;
  const head = still ? W - TRAIN_LEN - 62 : (travelled % cycle) - TRAIN_LEN;

  for (let c = COACHES - 1; c >= 0; c -= 1) {
    const cx = head + c * (COACH_LEN + COACH_GAP);
    if (cx > W + 8 || cx + COACH_LEN < -8) continue;
    coach(ctx, p, cx, c, travelled);
  }
  const locoX = head + COACHES * (COACH_LEN + COACH_GAP);
  if (locoX <= W + 8 && locoX + LOCO_LEN >= -8) {
    // The spark is rare on purpose. Every few seconds it is a detail; every frame it is a fault.
    locomotive(ctx, p, locoX, travelled, !still && tick % 190 < 4);
  }

  dither(ctx, 0, H - 16, W, 16, p.bg, 0);
}
