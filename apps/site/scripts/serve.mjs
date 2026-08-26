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

createServer((req, res) => {
  const file = resolveWithin(req.url ?? "/");
  if (file === null) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    // No caching in development. A stale bundle is an hour of debugging the wrong file.
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  process.stderr.write(`kairos site on http://localhost:${PORT}\n`);
  process.stderr.write(`serving ${ROOT}\n`);
});
