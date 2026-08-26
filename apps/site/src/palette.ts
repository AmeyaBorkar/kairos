/**
 * The palette, read back out of CSS rather than duplicated in TypeScript.
 *
 * Six schemes are declared once, as custom properties on `[data-scheme]` in `tokens.css`. The
 * artwork asks the computed style for the same ten variables the chrome uses, which is why changing
 * scheme recolours the drawings and the interface together and why there is no list of hex codes in
 * this file to fall out of step with the one in the stylesheet.
 *
 * The page deliberately ignores the operating system's light/dark preference. The palette is a
 * control the reader owns; a host override would fight it, and the fight would be invisible.
 */

export interface Palette {
  readonly bg: string;
  readonly panel: string;
  readonly panel2: string;
  readonly line: string;
  readonly ink: string;
  readonly inkDim: string;
  readonly accent: string;
  readonly good: string;
  readonly warn: string;
  readonly bad: string;
}

export const SCHEMES = ["razorpay", "amber", "phosphor", "ledger", "blueprint", "cga"] as const;
export type Scheme = (typeof SCHEMES)[number];

export const DEFAULT_SCHEME: Scheme = "razorpay";

export function isScheme(value: string | null): value is Scheme {
  return value !== null && (SCHEMES as readonly string[]).includes(value);
}

const VARS: ReadonlyArray<readonly [keyof Palette, string]> = [
  ["bg", "--bg"],
  ["panel", "--panel"],
  ["panel2", "--panel-2"],
  ["line", "--line"],
  ["ink", "--ink"],
  ["inkDim", "--ink-dim"],
  ["accent", "--accent"],
  ["good", "--good"],
  ["warn", "--warn"],
  ["bad", "--bad"],
];

/**
 * A live palette object, mutated in place on every scheme change.
 *
 * Deliberately one shared object rather than a new one per read: every scene holds a reference to it
 * across animation frames, and swapping the identity would mean threading the new value through
 * every draw call for no benefit.
 */
const current: Record<keyof Palette, string> = {
  bg: "#000",
  panel: "#111",
  panel2: "#222",
  line: "#333",
  ink: "#fff",
  inkDim: "#888",
  accent: "#09f",
  good: "#0c6",
  warn: "#fc3",
  bad: "#f55",
};

export const palette: Palette = current;

/** Re-read every token from the document. Call after any change to `data-scheme`. */
export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  for (const [key, name] of VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value !== "") current[key] = value;
  }
  return palette;
}

/** Apply a scheme to the document and refresh the palette the artwork draws with. */
export function applyScheme(scheme: Scheme): void {
  document.documentElement.setAttribute("data-scheme", scheme);
  readPalette();
}
