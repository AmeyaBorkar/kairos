#!/usr/bin/env node

/**
 * A static server for `public/`, and nothing else.
 *
 * The site has no server-side anything: it is HTML, CSS, a compiled ES module bundle and one JSON
 * file. This exists so `pnpm dev` works without asking anyone to install a tool, and so the deploy
 * target is obvious — whatever this serves is exactly what a static host serves.
 *
 * Paths are resolved and then checked to be inside the root, because a dev server that will read
 * `../../../.env` is a dev server that leaks a Gemini key the first time someone port-forwards it.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "public"));
const PORT = Number.parseInt(process.env["PORT"] ?? "8080", 10);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".vtt": "text/vtt; charset=utf-8",
};

function resolveWithin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const candidate = resolve(join(ROOT, normalize(decoded)));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  try {
    return statSync(candidate).isDirectory() ? join(candidate, "index.html") : candidate;
  } catch {
    return null;
  }
}

/**
 * A single-range `Range:` reply, which is all a `<video>` asks for.
 *
 * Without this the film loads but will not seek: a browser that cannot fetch a byte range treats
 * the file as unseekable, and the chapter list does nothing. A real static host has this for free;
 * a dev server that lacks it makes the page look broken in the one place worth checking by hand.
 */
function rangeOf(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (m === null) return null;
  const [, rawStart, rawEnd] = m;
  // `bytes=-500` means the last 500 bytes; `bytes=500-` means everything from 500 on.
  const start = rawStart === "" ? size - Number(rawEnd) : Number(rawStart);
  const end = rawStart === "" || rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

createServer((req, res) => {
  const file = resolveWithin(req.url ?? "/");
  if (file === null) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return;
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const size = statSync(file).size;
  const range = rangeOf(req.headers.range, size);

  if (range !== null) {
    res.writeHead(206, {
      "content-type": type,
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
      "content-length": range.end - range.start + 1,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    createReadStream(file, range).pipe(res);
    return;
  }

  res.writeHead(200, {
    "content-type": type,
    "content-length": size,
    "accept-ranges": "bytes",
    // No caching in development. A stale bundle is an hour of debugging the wrong file.
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  process.stderr.write(`kairos site on http://localhost:${PORT}\n`);
  process.stderr.write(`serving ${ROOT}\n`);
});
