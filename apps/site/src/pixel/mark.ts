/**
 * The Kairos mark.
 *
 * Four blades that pass each other rather than meet — the corners are deliberately offset, which is
 * what makes it an interlocking frame and not a rectangle — and what they leave in the middle is an
 * opening. The limits do not merely permit the moment; they are the thing that shapes it.
 *
 * ## Why it is a grid and not an SVG path
 *
 * It is drawn at 16×16 and scaled up, never the reverse. A mark authored large and shrunk to a
 * favicon lands on fractional pixels and turns to grey mush at the one size where a logo does its
 * actual job, which is being found in a strip of twenty browser tabs. Sixteen squares across is the
 * constraint that keeps it honest.
 *
 * This grid is the single source of truth: the page draws it to a canvas, and `scripts/make-icons`
 * emits the favicon and touch icons from the same array. There is no second copy to drift.
 */

/** `#` ink, `/` accent, `o` the good colour, `x` the bad one, `.` transparent. */
export const MARK: readonly string[] = [
  "................",
  "................",
  "..########..##..",
  "..########..##..",
  "..##........##..",
  "..##........##..",
  "..##..////..##..",
  "..##..////..##..",
  "..##..////..##..",
  "..##..////..##..",
  "..##........##..",
  "..##........##..",
  "..##..########..",
  "..##..########..",
  "................",
  "................",
];

export const MARK_SIZE = 16;

export interface MarkInk {
  readonly ink: string;
  readonly accent: string;
  readonly good: string;
  readonly bad: string;
}

/** The colour a grid character takes, or null where nothing is drawn. */
export function inkFor(ch: string, colours: MarkInk): string | null {
  switch (ch) {
    case "#":
      return colours.ink;
    case "/":
      return colours.accent;
    case "o":
      return colours.good;
    case "x":
      return colours.bad;
    default:
      return null;
  }
}

/**
 * Paint the mark into a 2D context at `scale` device pixels per grid cell.
 *
 * The caller owns the canvas size; this only fills cells, so the same function serves the nav mark,
 * a hero lockup, and an offscreen buffer for icon generation.
 */
export function paintMark(ctx: CanvasRenderingContext2D, scale: number, colours: MarkInk): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, MARK_SIZE * scale, MARK_SIZE * scale);
  stampMark(ctx, 0, 0, scale, colours);
}

/**
 * Draw the mark at an origin, over whatever is already there.
 *
 * The placement diagram uses this to put the logo at the centre of the system it describes — not a
 * shape that resembles it, the same sixteen strings. The mark *is* the architecture, and a diagram
 * that redrew it by hand would drift from it by a pixel a month.
 */
export function stampMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  colours: MarkInk,
): void {
  for (let row = 0; row < MARK_SIZE; row += 1) {
    const line = MARK[row] ?? "";
    for (let col = 0; col < MARK_SIZE; col += 1) {
      const colour = inkFor(line.charAt(col), colours);
      if (colour === null) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(x + col * scale, y + row * scale, scale, scale);
    }
  }
}
