#!/usr/bin/env node

/**
 * Emit the favicon and touch icons from the same grid the page draws.
 *
 * The mark lives in `src/pixel/mark.ts` as sixteen strings, and this script parses that file rather
 * than keeping a second copy. Two copies of a logo drift, and the drift is invisible until somebody
 * notices the tab icon is a version behind the header.
 *
 * ## Why hand-rolled PNG encoding
 *
 * A pixel mark is the one image where an encoder's convenience features are all hazards: any
 * resampling, any anti-aliasing, any colour management turns crisp squares into grey mush at exactly
 * the size that matters. Writing the IDAT directly is about forty lines with `node:zlib`, needs no
 * dependency, and guarantees the bytes are the squares we asked for.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "public", "assets", "icons");

/** Razorpay is the default scheme, so the icons are cut in its colours. */
const COLOURS = {
  "#": "#e2ecff", // ink
  "/": "#3395ff", // accent
  o: "#3ddc97", // good
  x: "#ff6161", // bad
};
const BACKDROP = "#060f24";

function readGrid() {
  const source = readFileSync(join(ROOT, "src", "pixel", "mark.ts"), "utf8");
  const block = source.match(/export const MARK: readonly string\[\] = \[([\s\S]*?)\];/);
  if (block === null) throw new Error("could not find MARK in src/pixel/mark.ts");
  const rows = [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (rows.length !== 16 || rows.some((r) => r.length !== 16)) {
    throw new Error(`MARK must be 16 rows of 16 characters, got ${rows.length}`);
  }
  return rows;
}

function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
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

/**
 * Encode RGBA pixels as a PNG with filter type 0 on every row.
 *
 * No filtering heuristics: a 16-colour pixel grid compresses to nothing either way, and a filter
 * chosen per row is one more thing that could be wrong.
 */
function png(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rasterise the grid at an integer scale. `backdrop` null leaves the ground transparent. */
function raster(grid, scale, backdrop) {
  const size = 16 * scale;
  const rgba = Buffer.alloc(size * size * 4);
  if (backdrop !== null) {
    const [r, g, b] = rgb(backdrop);
    for (let i = 0; i < size * size; i += 1) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
  }
  for (let row = 0; row < 16; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      const hex = COLOURS[grid[row][col]];
      if (hex === undefined) continue;
      const [r, g, b] = rgb(hex);
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = ((row * scale + dy) * size + (col * scale + dx)) * 4;
          rgba[i] = r;
          rgba[i + 1] = g;
          rgba[i + 2] = b;
          rgba[i + 3] = 255;
        }
      }
    }
  }
  return png(size, size, rgba);
}

/**
 * The SVG favicon, one rect per lit cell.
 *
 * `shape-rendering="crispEdges"` is the whole reason this works: without it a browser scaling a
 * 16-unit viewBox to a 17-pixel tab softens every edge, and the mark stops being pixel art.
 */
function svg(grid) {
  const rects = [];
  for (let row = 0; row < 16; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      const hex = COLOURS[grid[row][col]];
      if (hex === undefined) continue;
      rects.push(`<rect x="${col}" y="${row}" width="1" height="1" fill="${hex}"/>`);
    }
  }
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges" role="img" aria-labelledby="t">',
    '<title id="t">Kairos</title>',
    `<rect width="16" height="16" fill="${BACKDROP}"/>`,
    ...rects,
    "</svg>",
    "",
  ].join("\n");
}

const grid = readGrid();
mkdirSync(OUT, { recursive: true });

writeFileSync(join(OUT, "mark.svg"), svg(grid));
writeFileSync(join(OUT, "favicon-32.png"), raster(grid, 2, BACKDROP));
writeFileSync(join(OUT, "favicon-64.png"), raster(grid, 4, BACKDROP));
writeFileSync(join(OUT, "apple-touch-icon.png"), raster(grid, 12, BACKDROP));
writeFileSync(join(OUT, "mark-512.png"), raster(grid, 32, null));

process.stderr.write("icons: mark.svg, favicon-32, favicon-64, apple-touch-icon, mark-512\n");
