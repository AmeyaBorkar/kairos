/**
 * The tab transition: the mark closing over the screen and opening on the next view.
 *
 * Four blades sweep in from the edges, meet, and retract. It is not a nod to the logo — the logo is
 * four blades around an opening, so the transition is the mark doing the thing it depicts. The
 * destination is named while the screen is covered, which is the one moment a transition can be
 * useful rather than merely present.
 *
 * ## Why the blades are full-length
 *
 * The mark's character comes from its offset corners: each blade passes the next rather than meeting
 * it. Drawn that way at full size the four blades leave the four corners uncovered, and a transition
 * with holes in it is a bug wearing a concept. So the blades run the full width or height and the
 * pinwheel lives in the draw order and in the lit leading edges instead — you read the interleaving
 * on the way in, and the cover is total when it needs to be.
 *
 * ## Reduced motion
 *
 * Skipped entirely. Not shortened, not faded — a reader who has asked for less motion gets the view
 * swap and nothing else.
 */

import { type Palette, palette } from "./palette.js";
import { stampMark } from "./pixel/mark.js";
import { clamp, dither, px } from "./pixel/raster.js";

/** How long the whole close-and-open takes, in milliseconds. */
export const SPEEDS = { snap: 260, moment: 400, beat: 600 } as const;
export type Speed = keyof typeof SPEEDS;

export function isSpeed(value: string | null): value is Speed {
  return value !== null && Object.hasOwn(SPEEDS, value);
}

/** Low-resolution width the wipe is drawn at, before being blitted up to the viewport. */
const BUFFER_W = 320;

/** Ease that starts fast and settles, so the close reads as a mechanism rather than a fade. */
function ease(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

export class Aperture {
  readonly #host: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #label: HTMLElement;
  #ms: number = SPEEDS.moment;
  #running = false;

  constructor(host: HTMLElement, canvas: HTMLCanvasElement, label: HTMLElement) {
    this.#host = host;
    this.#canvas = canvas;
    this.#label = label;
  }

  setSpeed(speed: Speed): void {
    this.#ms = SPEEDS[speed];
  }

  /**
   * Close over the screen, run `swap` at the moment nothing can be seen, then open.
   *
   * `swap` is called exactly once. If a transition is already running the new one is refused and the
   * swap happens immediately, because a reader hammering the nav wants the view, not the animation.
   */
  run(name: string, swap: () => void): void {
    if (this.#running) {
      swap();
      return;
    }
    this.#running = true;

    const ctx = this.#canvas.getContext("2d");
    if (ctx === null) {
      this.#running = false;
      swap();
      return;
    }

    // Match the buffer to the viewport's aspect so nothing is stretched: the mark is a square grid
    // and a square grid drawn on a stretched buffer stops being pixel art.
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const h = Math.max(120, Math.round((BUFFER_W * vh) / vw));
    this.#canvas.width = BUFFER_W;
    this.#canvas.height = h;
    ctx.imageSmoothingEnabled = false;

    this.#host.removeAttribute("hidden");
    this.#label.textContent = name;

    let start: number | null = null;
    let swapped = false;

    const frame = (now: number): void => {
      if (start === null) start = now;
      const t = clamp((now - start) / this.#ms, 0, 1);

      // 0 → 1 → 0: closed at the midpoint, which is where the view changes hands.
      const closing = t <= 0.5;
      const shut = ease(closing ? t / 0.5 : (1 - t) / 0.5);

      paintAperture(ctx, BUFFER_W, h, shut, palette);
      this.#label.style.opacity = String(clamp((shut - 0.82) / 0.18, 0, 1));

      if (!swapped && t >= 0.5) {
        swapped = true;
        swap();
      }

      if (t < 1) {
        requestAnimationFrame(frame);
        return;
      }
      this.#host.setAttribute("hidden", "");
      this.#running = false;
    };

    requestAnimationFrame(frame);
  }
}

/**
 * One frame of the aperture, as a pure function.
 *
 * `shut` runs 0 (fully open) to 1 (nothing visible behind it). Kept out of the class so it can be
 * rendered by `scripts/preview-scene.mjs` without a browser — an animation nobody can look at before
 * shipping is an animation shipped on faith.
 */
export function paintAperture(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  shut: number,
  p: Palette,
): void {
  ctx.clearRect(0, 0, w, h);
  if (shut <= 0) return;

  const halfW = Math.ceil(w * 0.53);
  const halfH = Math.ceil(h * 0.53);

  /* The lit leading edges do their work while the plates are moving — they are what makes four dark
     rectangles read as blades closing. At rest they form a bright cross through the middle and
     compete with the mark, so they go out as the aperture shuts. */
  const glow = shut < 0.9 ? p.accent : p.line;
  const edge = 3;

  /* Four plates, all one colour.
   *
   * They were two colours at first — one pair light, one pair dark — so the pinwheel would read
   * while they travelled. It does, but wherever two plates overlap the last one drawn wins, and with
   * full-length blades in pinwheel order those overlaps are not symmetric: one quadrant ends up in
   * the other colour for the whole of the closed part of the animation, and no amount of tidying the
   * resting frame fixes a thing that is wrong at every value in between.
   *
   * So the plates share a colour and the pinwheel lives entirely in the lit leading edges, each
   * travelling inward from its own side. Overlap becomes invisible because there is nothing to see
   * across it, and the field is uniform from the moment it closes to the moment it opens. */
  const plate = p.panel2;

  const top = -halfH + shut * halfH;
  px(ctx, 0, top, w, halfH, plate);
  px(ctx, 0, top + halfH - edge, w, edge, glow);

  const right = w - shut * halfW;
  px(ctx, right, 0, halfW, h, plate);
  px(ctx, right, 0, edge, h, glow);

  const bottom = h - shut * halfH;
  px(ctx, 0, bottom, w, halfH, plate);
  px(ctx, 0, bottom, w, edge, glow);

  const left = -halfW + shut * halfW;
  px(ctx, left, 0, halfW, h, plate);
  px(ctx, left + halfW - edge, 0, edge, h, glow);

  // A hint of the seams on the centre lines, once the plates have met. Lighter than the field, so it
  // says "plates" without any of them owning a region.
  if (shut > 0.96) {
    dither(ctx, 0, Math.round(h / 2) - 1, w, 3, p.line, 0);
    dither(ctx, Math.round(w / 2) - 1, 0, 3, h, p.line, 1);
  }

  // Only once the plates have very nearly met, so it never floats over the page behind.
  const show = clamp((shut - 0.86) / 0.14, 0, 1);
  if (show > 0) {
    const scale = Math.max(2, Math.round((h * 0.32) / 16));
    const size = scale * 16;
    stampMark(ctx, Math.round((w - size) / 2), Math.round(h / 2 - size / 2 - h * 0.04), scale, {
      ink: p.ink,
      accent: show > 0.45 ? p.accent : p.line,
      good: p.good,
      bad: p.bad,
    });
  }
}
