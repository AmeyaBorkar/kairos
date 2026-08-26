/**
 * Where Kairos sits.
 *
 * The one diagram the site was missing: the payment attempt stream coming in, Kairos in the middle,
 * the four things it is allowed to reach, and the mandate underneath holding all of it. A reader who
 * sees this knows what the product is before they have read a sentence, which is more than the four
 * questions were ever going to manage on their own.
 *
 * The centre is drawn as the mark — blades passing each other around a lit opening — because the
 * logo is the architecture. The mandate is a locking bar, tied up into the frame: the outputs light
 * one after another as the diagram builds, and then the bar arrives and the whole thing is bounded.
 * That order is the argument. Authority first, limits second, is how you get a system nobody can
 * deploy.
 */

import { stampMark } from "../pixel/mark.js";
import { band, px } from "../pixel/raster.js";
import type { SceneArgs } from "../pixel/surface.js";

const W = 320;
const H = 150;

/* The mark, stamped at five pixels a cell. Its blades occupy grid columns 2..13 and rows 2..13, so
   the frame the diagram wires into runs from MARK_X + 10 to MARK_X + 70. */
const MARK_X = 106;
const MARK_Y = 20;
const MARK_S = 5;
const FRAME_L = MARK_X + 2 * MARK_S;
const FRAME_R = MARK_X + 14 * MARK_S;
const FRAME_B = MARK_Y + 14 * MARK_S;

/** The four ports, in the order the reader meets them. */
const PORTS_Y = [42, 58, 74, 90] as const;
const PORT_END = 300;

const BAR_Y = 112;

/** An arrowhead pointing right, four pixels of it. */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, colour: string): void {
  px(ctx, x, y - 3, 2, 7, colour);
  px(ctx, x + 2, y - 2, 2, 5, colour);
  px(ctx, x + 4, y - 1, 2, 3, colour);
}

export interface PlacementState {
  /** How many of the four ports have been reached. */
  readonly ports: number;
  /** True once the mandate bar has arrived and the frame is bounded. */
  readonly sealed: boolean;
}

export function drawPlacement({ ctx, p, t, tick, still }: SceneArgs): PlacementState {
  const q = band(t, 0.04, 0.86);
  px(ctx, 0, 0, W, H, p.bg);

  // A faint grid, so the diagram reads as a drawing rather than as a photograph of one.
  for (let x = 0; x < W; x += 8) px(ctx, x, 0, 1, H, p.panel);
  for (let y = 0; y < H; y += 8) px(ctx, 0, y, W, 1, p.panel);

  /* The attempt stream, entering from the left. Blocks on a conveyor: the drift is free-running so
     the diagram is never completely still, and the count is fixed so it never reads as a load. */
  const drift = still ? 0 : (tick * 0.35) % 13;
  px(ctx, 0, 60, FRAME_L - 6, 2, p.line);
  for (let i = 0; i < 8; i += 1) {
    const x = (i * 13 + drift) % (FRAME_L - 10);
    px(ctx, x, 54, 7, 5, i % 3 === 0 ? p.bad : p.inkDim);
  }
  arrow(ctx, FRAME_L - 8, 61, p.inkDim);

  /* The centre is the mark, stamped rather than approximated — the logo and the architecture are
     the same object, and a hand-drawn lookalike would drift from it by a pixel a month. Unlit, the
     aperture takes the panel colour: the frame is there, the opening is not yet open. */
  const live = q > 0.16;
  stampMark(ctx, MARK_X, MARK_Y, MARK_S, {
    ink: p.ink,
    accent: live ? p.accent : p.panel2,
    good: p.good,
    bad: p.bad,
  });

  /* The four ports. Each is a line out of the frame to a terminal, lit in turn — the diagram builds
     rather than arriving, which is the only way four parallel arrows are ever read in order. */
  let reached = 0;
  for (let i = 0; i < PORTS_Y.length; i += 1) {
    const y = PORTS_Y[i] ?? 0;
    const on = q > 0.28 + i * 0.11;
    if (on) reached += 1;

    const colour = on ? p.accent : p.line;
    // Out of the frame's right edge, then a step to the port's own height.
    px(ctx, FRAME_R - 6, y, PORT_END - 12 - (FRAME_R - 6), 2, colour);
    arrow(ctx, PORT_END - 12, y + 1, colour);

    px(ctx, PORT_END - 4, y - 5, 12, 12, on ? p.panel2 : p.panel);
    px(ctx, PORT_END - 4, y - 5, 12, 2, colour);
    if (on) px(ctx, PORT_END - 1, y - 2, 6, 6, i === 3 ? p.good : p.accent);
  }

  /* The mandate. It arrives last and from below, and until it does the frame is unbounded — which is
     exactly the state the rest of the page argues nobody should ship. */
  const sealed = q > 0.76;
  const barX = BAR_Y + (sealed ? 0 : Math.round((1 - band(q, 0.6, 0.76)) * 22));
  const edge = sealed ? p.accent : p.line;

  px(ctx, 50, barX, 220, 14, p.panel2);
  px(ctx, 50, barX, 220, 3, edge);
  px(ctx, 50, barX + 11, 220, 3, edge);
  for (let i = 0; i < 8; i += 1) px(ctx, 60 + i * 26, barX + 5, 12, 4, p.panel);

  // The ties up into the frame. Solid once sealed; dashed while the bar is still travelling.
  for (const tieX of [128, 158]) {
    for (let y = FRAME_B; y < barX; y += 1) {
      if (!sealed && (y & 3) > 1) continue;
      px(ctx, tieX, y, 3, 1, edge);
    }
    px(ctx, tieX - 3, barX - 4, 9, 4, edge);
  }

  if (sealed) {
    // The seal itself: a small lit block on the bar, which is the only green in the diagram besides
    // the ledger, and both mean the same thing — this was recorded and it checks out.
    px(ctx, 150, barX + 3, 20, 8, p.good);
    px(ctx, 154, barX + 5, 12, 4, p.bg);
  }

  return { ports: reached, sealed };
}
