/**
 * Reading position, as a number.
 *
 * The whole layout rests on one idea: the artwork is driven by *which line is being read*, not by
 * where the canvas happens to sit. So an act reports the step under the reading line and how far
 * into it we are, and the scene is handed that rather than its own bounding box.
 */

import { clamp } from "../pixel/raster.js";

/** Where on the screen a line counts as "being read". Two-thirds up, not the middle. */
const READING_LINE = 0.58;

export interface ActState {
  /** 0 to 1 across the whole act, continuous through step boundaries. */
  readonly t: number;
  /** Index of the step under the reading line. */
  readonly step: number;
  readonly steps: number;
  /** False when the act is far enough off screen that drawing it would be waste. */
  readonly onscreen: boolean;
}

/**
 * Read an act's position, and mark the active step as a side effect.
 *
 * The side effect is deliberate and is why this is not a pure function: the dimming of inactive
 * steps and the progress handed to the scene are the same measurement, and computing it twice is how
 * they drift apart by a frame.
 */
export function actState(act: HTMLElement): ActState {
  const rect = act.getBoundingClientRect();
  const vh = window.innerHeight || 800;
  const steps = [...act.querySelectorAll<HTMLElement>(".step")];

  let index = 0;
  let within = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step === undefined) continue;
    const box = step.getBoundingClientRect();
    if (box.top < vh * READING_LINE) {
      index = i;
      within = clamp((vh * READING_LINE - box.top) / Math.max(1, box.height), 0, 1);
    }
  }

  const visible = rect.top < vh && rect.bottom > 0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step === undefined) continue;
    if (i === index && visible) step.setAttribute("data-on", "");
    else step.removeAttribute("data-on");
  }

  const total = Math.max(1, steps.length);
  return {
    t: clamp((index + within) / total, 0, 1),
    step: index,
    steps: total,
    onscreen: rect.bottom > -300 && rect.top < vh + 300,
  };
}

/** How far the reader has moved off the hero, for its parallax. */
export function heroProgress(): number {
  const vh = window.innerHeight || 800;
  return clamp(window.scrollY / Math.max(1, vh), 0, 1);
}

/** How far a standalone element has come into view. For scenes with no steps to read against. */
export function entryProgress(node: Element): number {
  const vh = window.innerHeight || 800;
  const rect = node.getBoundingClientRect();
  return clamp((vh * 0.85 - rect.top) / (vh * 0.6), 0, 1);
}

/** Whether an element is close enough to the viewport to be worth drawing. */
export function nearViewport(node: Element, margin = 200): boolean {
  const vh = window.innerHeight || 800;
  const rect = node.getBoundingClientRect();
  return rect.bottom > -margin && rect.top < vh + margin;
}
