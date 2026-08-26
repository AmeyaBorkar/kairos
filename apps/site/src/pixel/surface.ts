/**
 * The render pipeline, and the one idea that makes the PIXEL control cheap.
 *
 * Every scene draws into an offscreen buffer at its own native resolution — 320×170, say — and is
 * then blitted down onto the visible canvas with smoothing off. CSS scales that small canvas up to
 * whatever width the layout gives it, and because the browser is told not to interpolate, each
 * source pixel lands as a hard square.
 *
 * The PIXEL setting changes only the divisor on that blit. Coarser means fewer, larger squares
 * across the same width. Drawing straight onto a resized canvas would mean re-tuning every
 * coordinate in every scene for every setting, which is the version of this that does not ship.
 */

import type { Palette } from "../palette.js";

export interface Surface {
  /** The canvas in the document. Its backing store is resized by the blit, not by CSS. */
  readonly el: HTMLCanvasElement;
  /** Where the scene is actually drawn, always at native resolution. */
  readonly ctx: CanvasRenderingContext2D;
  readonly w: number;
  readonly h: number;
}

interface Internal extends Surface {
  readonly buffer: HTMLCanvasElement;
}

/** Grid coarseness, as a divisor on the blit. 1 is native; larger is chunkier. */
let pixelScale = 1;

export function setPixelScale(value: number): void {
  pixelScale = Number.isFinite(value) && value > 0 ? value : 1;
}

export function getPixelScale(): number {
  return pixelScale;
}

/**
 * Bind a canvas in the document to an offscreen buffer of the given native size.
 *
 * Returns null when the element is absent, so a view that does not exist on this page costs nothing
 * rather than throwing. Every caller is expected to skip a null surface.
 */
export function surface(id: string, w: number, h: number): Surface | null {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLCanvasElement)) return null;

  const buffer = document.createElement("canvas");
  buffer.width = w;
  buffer.height = h;
  const ctx = buffer.getContext("2d");
  if (ctx === null) return null;
  ctx.imageSmoothingEnabled = false;

  const made: Internal = { el, ctx, w, h, buffer };
  return made;
}

/** Copy the buffer onto the visible canvas at the current coarseness. */
export function blit(s: Surface): void {
  const { buffer } = s as Internal;
  const dw = Math.max(24, Math.round(s.w / pixelScale));
  const dh = Math.max(16, Math.round(s.h / pixelScale));
  if (s.el.width !== dw || s.el.height !== dh) {
    s.el.width = dw;
    s.el.height = dh;
  }
  const out = s.el.getContext("2d");
  if (out === null) return;
  out.imageSmoothingEnabled = false;
  out.clearRect(0, 0, dw, dh);
  out.drawImage(buffer, 0, 0, dw, dh);
}

/** What every scene is handed: somewhere to draw, the palette, and how far through it is. */
export interface SceneArgs {
  readonly ctx: CanvasRenderingContext2D;
  readonly p: Palette;
  /** 0 to 1 through this scene's own arc. */
  readonly t: number;
  /** A free-running frame counter, for atmosphere that is not tied to scroll. */
  readonly tick: number;
  /** True when the reader has asked for less motion; scenes must hold still. */
  readonly still: boolean;
}
