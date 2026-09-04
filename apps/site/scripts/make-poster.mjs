#!/usr/bin/env node

/**
 * The film's poster frame.
 *
 * A `<video>` shows its poster until somebody presses play, so it is the first thing anyone sees of
 * the film and the only thing most people will see of it. A frame grabbed out of the middle of the
 * picture says nothing about what the film is; this says the name.
 *
 * The mark is parsed out of `src/pixel/mark.ts`, the same sixteen strings the favicon and the page
 * header are cut from, so there is no second copy of the logo to fall a version behind.
 *
 *   pnpm --filter @kairos/site run poster
 *
 * ## Why this is not part of `pnpm build`
 *
 * It needs Chrome, and the build must run in CI where there is none. The output is committed for
 * the same reason the film is: generated out of band, from a script that is in the repository, so
 * anybody can regenerate it and nobody has to install a browser to build the site.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "public", "film", "poster.jpg");

/**
 * Razorpay blue, the site's default scheme, so the poster and the page it sits in agree.
 *
 * Nothing else is on the plate. The runtime is printed under the player and the domain is the site
 * serving it, so putting either on the poster is saying a thing twice — and the only place a poster
 * has to earn is the moment before somebody decides whether to press play.
 */
const INK = "#e2ecff";
const ACCENT = "#3395ff";
const DIM = "#7d95bd";
const BG = "#060f24";

function readGrid() {
  const source = readFileSync(join(ROOT, "src", "pixel", "mark.ts"), "utf8");
  const block = source.match(/export const MARK: readonly string\[\] = \[([\s\S]*?)\];/);
  if (block === null) throw new Error("could not find MARK in src/pixel/mark.ts");
  const rows = [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (rows.length !== 16) throw new Error(`expected 16 rows, found ${rows.length}`);
  return rows;
}

const COLOURS = { "#": INK, "/": ACCENT, o: "#3ddc97", x: "#ff6161" };

function markSvg(grid, size) {
  const rects = [];
  for (let row = 0; row < 16; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      const hex = COLOURS[grid[row][col]];
      if (hex !== undefined)
        rects.push(`<rect x="${col}" y="${row}" width="1" height="1" fill="${hex}"/>`);
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

const page = `<!doctype html>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=Silkscreen:wght@400;700&display=swap">
<style>
  html, body { margin: 0; width: 1920px; height: 1080px; background: ${BG}; overflow: hidden; }
  /* The same vignette the film opens and closes on, so the poster reads as a frame of it rather
     than as a title card bolted onto the front. */
  .stage {
    width: 1920px; height: 1080px; display: grid; place-items: center;
    background:
      radial-gradient(120% 90% at 50% 42%, #0d1b34 0%, ${BG} 62%, #03060f 100%);
    font-family: Archivo, system-ui, sans-serif;
  }
  .plate { display: grid; place-items: center; gap: 34px; transform: translateY(-18px); }
  .mark { filter: drop-shadow(0 0 34px rgba(51,149,255,.45)); }
  .word {
    font-family: Silkscreen, monospace; font-weight: 700;
    font-size: 104px; letter-spacing: .30em; color: ${INK};
    /* The letter-spacing puts a gap after the last letter; pull it back so the word is centred. */
    margin-right: -.30em;
  }
  .rule { width: 380px; height: 2px; background: linear-gradient(90deg, transparent, ${ACCENT}, transparent); }
  .line { font-size: 34px; font-weight: 600; color: ${DIM}; letter-spacing: .02em; }
  .line em { color: ${INK}; font-style: normal; }
  /* A scanline wash, at the strength the film uses. Enough to read as a screen, not as an effect. */
  .stage::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(0deg, rgba(0,0,0,.16) 0 1px, transparent 1px 3px);
  }
</style>
<div class="stage">
  <div class="plate">
    <div class="mark">${markSvg(readGrid(), 208)}</div>
    <div class="word">KAIROS</div>
    <div class="rule"></div>
    <div class="line">It decides <em>which losses are worth chasing.</em></div>
  </div>
</div>`;

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));
if (CHROME === undefined) {
  process.stderr.write(
    "Chrome not found. This script needs one; the committed poster.jpg does not.\n",
  );
  process.exit(2);
}

const PORT = 9355;
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1920,1080",
    `--user-data-dir=${process.env.TEMP ?? "/tmp"}/kairos-poster-chrome`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 80 && target === null; i += 1) {
  await sleep(250);
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
      (t) => t.type === "page",
    );
  } catch {
    /* not up yet */
  }
}
if (target === null) throw new Error("chrome never opened its debugging port");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => {
  ws.onopen = r;
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

await send("Emulation.setDeviceMetricsOverride", {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.enable");
await send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(page)}` });
// Long enough for the webfonts. A poster rendered in the fallback face is a poster in the wrong
// typeface, and it is not obvious from the file that anything went wrong.
await sleep(3500);

const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));
process.stderr.write(`poster: ${OUT}\n`);

ws.close();
chrome.kill();
