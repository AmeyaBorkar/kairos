#!/usr/bin/env node

/**
 * Render a scene to a PNG, without a browser.
 *
 * Every scene draws through exactly one primitive — a filled rectangle on an integer grid — so a
 * twenty-line stand-in for `CanvasRenderingContext2D` is enough to run the real code and get the
 * real picture out. That matters more here than it would elsewhere: pixel art is the one thing you
 * genuinely cannot review by reading the source, and "does the perspective read as a track or as a
 * triangle" is not a question a typechecker has an opinion about.
 *
 *   pnpm --filter @kairos/site run preview            # every scene, at t=1
 *   pnpm --filter @kairos/site run preview hero 0.35  # one scene, part-way through
 *   pnpm --filter @kairos/site run preview hero 0 900  # in motion, at a given frame
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const APP = join(ROOT, "public", "app");
const OUT = join(ROOT, "preview");

/** Razorpay, the default scheme, as the artwork would read it back from CSS. */
const PALETTE = {
  bg: "#060f24",
  panel: "#0d1b34",
  panel2: "#142544",
  line: "#24457a",
  ink: "#e2ecff",
  inkDim: "#7d95bd",
  accent: "#3395ff",
  good: "#3ddc97",
  warn: "#ffc93c",
  bad: "#ff6161",
};

function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** The whole of the canvas API the scenes use. */
class Surface {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = Buffer.alloc(w * h * 4);
    this.fillStyle = "#000000";
    this.imageSmoothingEnabled = false;
  }

  fillRect(x, y, w, h) {
    const [r, g, b] = rgb(this.fillStyle);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let pxx = x0; pxx < x1; pxx += 1) {
        const i = (py * this.w + pxx) * 4;
        this.data[i] = r;
        this.data[i + 1] = g;
        this.data[i + 2] = b;
        this.data[i + 3] = 255;
      }
    }
  }

  clearRect(x, y, w, h) {
    const keep = this.fillStyle;
    this.fillStyle = PALETTE.bg;
    this.fillRect(x, y, w, h);
    this.fillStyle = keep;
  }
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Nearest-neighbour upscale, the same thing the page's blit does in the other direction. */
function scaleUp(surface, factor) {
  const w = surface.w * factor;
  const h = surface.h * factor;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = (((y / factor) | 0) * surface.w + ((x / factor) | 0)) * 4;
      surface.data.copy(out, (y * w + x) * 4, src, src + 4);
    }
  }
  return png(w, h, out);
}

const load = (name) => import(pathToFileURL(join(APP, "scenes", `${name}.js`)).href);
const hero = await load("hero");
const street = await load("street");
const railway = await load("railway");
const holdout = await load("holdout");
const placement = await load("placement");
const wipe = await import(pathToFileURL(join(APP, "transition.js")).href);

const SCENES = {
  hero: [320, 200, (a) => hero.drawHero(a)],
  street: [320, 170, (a) => street.drawStreet(a)],
  interlocking: [320, 160, (a) => railway.drawInterlocking(a)],
  "signal-box": [320, 150, (a) => railway.drawSignalBox(a, 4)],
  chart: [320, 120, (a) => railway.drawChart(a)],
  signal: [320, 130, (a) => railway.drawSignal(a)],
  holdout: [320, 150, (a) => holdout.drawHoldout(a)],
  placement: [320, 150, (a) => placement.drawPlacement(a)],
  // The tab transition, where `t` is how far shut the aperture is.
  wipe: [320, 180, (a) => wipe.paintAperture(a.ctx, 320, 180, a.t, a.p)],
};

const [wanted, atRaw, tickRaw] = process.argv.slice(2);
const t = atRaw === undefined ? 1 : Number.parseFloat(atRaw);
// A tick puts the scene in motion; without one it renders the still frame, which is what a reader
// who has asked for reduced motion actually sees.
const tick = tickRaw === undefined ? 40 : Number.parseInt(tickRaw, 10);
const still = tickRaw === undefined;
const names = wanted === undefined ? Object.keys(SCENES) : [wanted];

mkdirSync(OUT, { recursive: true });
for (const name of names) {
  const entry = SCENES[name];
  if (entry === undefined) {
    process.stderr.write(`unknown scene ${name}; try one of ${Object.keys(SCENES).join(", ")}\n`);
    process.exit(2);
  }
  const [w, h, draw] = entry;
  const ctx = new Surface(w, h);
  draw({ ctx, p: PALETTE, t, tick, still });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, scaleUp(ctx, 3));
  process.stderr.write(`${name.padEnd(14)} ${w}×${h} @t=${t} → ${file}\n`);
}
