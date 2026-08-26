/**
 * The two controls the reader owns: palette and pixel size.
 *
 * Both are permanent features rather than a chooser to be dismissed, and both persist. They live
 * behind one button in the navigation because a bar full of controls reads as a control panel, and
 * the bar has to read as a way in.
 */

import { applyScheme, DEFAULT_SCHEME, isScheme, type Scheme } from "./palette.js";
import { setPixelScale } from "./pixel/surface.js";
import { isSpeed, type Speed } from "./transition.js";

/** Bumped when a default changes, so a stale choice does not silently outlive it. */
const PALETTE_KEY = "kairos-palette-v2";
const PIXEL_KEY = "kairos-pixel";
const WIPE_KEY = "kairos-wipe";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private windows and blocked site data both throw here. Neither is an error worth surfacing.
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* see readStored */
  }
}

function group(id: string): HTMLButtonElement[] {
  const host = document.getElementById(id);
  if (host === null) return [];
  return [...host.querySelectorAll<HTMLButtonElement>(".btn")];
}

function select(buttons: readonly HTMLButtonElement[], chosen: HTMLButtonElement): void {
  for (const b of buttons) b.setAttribute("aria-pressed", String(b === chosen));
}

/**
 * Wire both controls and restore what was chosen last time.
 *
 * `onChange` fires after every change including the initial restore, so the caller can repaint
 * anything drawn rather than styled.
 */
export function mountSettings(onChange: () => void, onSpeed: (speed: Speed | null) => void): void {
  const cog = document.getElementById("cog");
  const sheet = document.getElementById("sheet");

  if (cog !== null && sheet !== null) {
    const open = (want: boolean): void => {
      cog.setAttribute("aria-expanded", String(want));
      if (want) sheet.removeAttribute("hidden");
      else sheet.setAttribute("hidden", "");
    };
    cog.addEventListener("click", (ev) => {
      ev.stopPropagation();
      open(cog.getAttribute("aria-expanded") !== "true");
    });
    sheet.addEventListener("click", (ev) => ev.stopPropagation());
    document.addEventListener("click", () => open(false));
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") open(false);
    });
  }

  const palette = group("palette-group");
  const pixel = group("pixel-group");

  for (const button of palette) {
    button.addEventListener("click", () => {
      const scheme = button.dataset["set"];
      if (!isScheme(scheme ?? null)) return;
      select(palette, button);
      applyScheme(scheme as Scheme);
      store(PALETTE_KEY, scheme as string);
      onChange();
    });
  }

  for (const button of pixel) {
    button.addEventListener("click", () => {
      const value = button.dataset["px"] ?? "1";
      select(pixel, button);
      setPixelScale(Number.parseFloat(value));
      store(PIXEL_KEY, value);
      onChange();
    });
  }

  const wipe = group("wipe-group");
  for (const button of wipe) {
    button.addEventListener("click", () => {
      const value = button.dataset["wipe"] ?? "moment";
      select(wipe, button);
      store(WIPE_KEY, value);
      onSpeed(isSpeed(value) ? value : null);
    });
  }

  const savedScheme = readStored(PALETTE_KEY);
  const scheme: Scheme = isScheme(savedScheme) ? savedScheme : DEFAULT_SCHEME;
  const schemeButton = palette.find((b) => b.dataset["set"] === scheme) ?? palette[0];
  if (schemeButton !== undefined) select(palette, schemeButton);
  applyScheme(scheme);

  const savedPixel = readStored(PIXEL_KEY) ?? "1";
  const pixelButton =
    pixel.find((b) => b.dataset["px"] === savedPixel) ??
    pixel.find((b) => b.dataset["px"] === "1") ??
    pixel[0];
  if (pixelButton !== undefined) {
    select(pixel, pixelButton);
    setPixelScale(Number.parseFloat(pixelButton.dataset["px"] ?? "1"));
  }

  const savedWipe = readStored(WIPE_KEY) ?? "moment";
  const wipeButton =
    wipe.find((b) => b.dataset["wipe"] === savedWipe) ??
    wipe.find((b) => b.dataset["wipe"] === "moment") ??
    wipe[0];
  if (wipeButton !== undefined) {
    select(wipe, wipeButton);
    const value = wipeButton.dataset["wipe"] ?? "moment";
    onSpeed(isSpeed(value) ? value : null);
  }

  onChange();
}
