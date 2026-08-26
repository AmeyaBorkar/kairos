/**
 * The drawing primitives every scene is built from.
 *
 * Deliberately tiny: filled rectangles, a three-by-five bitmap font, a checkerboard dither, and a
 * seeded generator. Nothing here anti-aliases, blends or curves, because the moment a scene can
 * reach for a gradient it stops being pixel art and starts being a picture with big pixels.
 */

/** Fill one rectangle on the integer grid. Coordinates are truncated, never rounded. */
export function px(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: string,
): void {
  ctx.fillStyle = colour;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

/**
 * A three-by-five font, covering digits, a colon, a space, and the handful of letters the scenes
 * actually spell. It is not a typeface and must not grow into one: labels belong in HTML, where they
 * can be read by a screen reader and translated. These glyphs exist for readouts that are part of
 * the drawing — a clock face, a lever number, a counter on a chart.
 */
const FONT: Readonly<Record<string, readonly string[]>> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ":": ["000", "010", "000", "010", "000"],
  " ": ["000", "000", "000", "000", "000"],
  A: ["111", "101", "111", "101", "101"],
  E: ["111", "100", "111", "100", "111"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  R: ["111", "101", "111", "110", "101"],
  T: ["111", "010", "010", "010", "010"],
};

/** Draw a string in the bitmap font. Unknown characters are skipped, not substituted. */
export function glyphs(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colour: string,
  scale = 1,
): void {
  for (let i = 0; i < text.length; i += 1) {
    const glyph = FONT[text.charAt(i)];
    if (glyph === undefined) continue;
    for (let row = 0; row < 5; row += 1) {
      const bits = glyph[row] ?? "";
      for (let col = 0; col < 3; col += 1) {
        if (bits.charAt(col) !== "1") continue;
        px(ctx, x + i * 4 * scale + col * scale, y + row * scale, scale, scale, colour);
      }
    }
  }
}

/**
 * A 50% checkerboard, which is how a two-colour medium makes a third tone. `phase` flips which
 * squares are filled, so two adjacent dithered bands can be told apart.
 */
export function dither(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: string,
  phase = 0,
): void {
  ctx.fillStyle = colour;
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      if (((i + j + phase) & 1) === 0) ctx.fillRect(x + i, y + j, 1, 1);
    }
  }
}

/**
 * A linear congruential generator, seeded.
 *
 * Every scene's layout — where the buildings stand, which customers give up, how long each word on
 * the departure board is — is drawn from one of these. Seeded rather than random so the page looks
 * the same on every load and in every screenshot; a hero that reshuffles itself on refresh is a hero
 * nobody can put in a slide.
 */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Where `p` sits within `[a, b]`, clamped to 0..1. The workhorse of every scene's timing. */
export function band(p: number, a: number, b: number): number {
  return clamp((p - a) / (b - a), 0, 1);
}
