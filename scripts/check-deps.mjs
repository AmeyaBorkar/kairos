#!/usr/bin/env node
/**
 * Two checks, both answering the same question: does this repository resolve in a clean checkout?
 *
 * Both mistakes they catch are invisible on a developer machine and fatal in CI, and both have
 * happened here. pnpm gives each package a `node_modules` containing only its declared
 * dependencies, but a stale directory left by an earlier install will happily resolve an undeclared
 * import, and Windows path resolution is more forgiving than Linux besides. A leftover `dist` does
 * the same for the typechecker. The result either way is a package that works for the person who
 * wrote it, passes every local check including a commit-by-commit bisect on the same machine, and
 * fails the moment CI installs from a frozen lockfile into an empty tree.
 *
 * The checks are deliberately crude — a regular expression over `from "..."`, restricted to the
 * workspace's own packages and its handful of runtime dependencies. Anything cleverer would need a
 * module graph, and neither failure is subtle enough to be worth one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WATCHED = /^(@kairos\/[a-z-]+|throttlekit|fastify|zod)$/;
const WORKSPACE = /^@kairos\/[a-z-]+$/;
const IMPORT = /(?:from|import)\s+"([^"]+)"/g;
const ROOTS = ["packages", "adapters", "apps"];

function tsFiles(dir, includeTests = true) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      found.push(...tsFiles(path, includeTests));
    } else if (entry.endsWith(".ts")) {
      if (!includeTests && entry.endsWith(".test.ts")) continue;
      found.push(path);
    }
  }
  return found;
}

function importsIn(files, filter) {
  const used = new Set();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match[1];
      if (filter.test(specifier)) used.add(specifier);
    }
  }
  return used;
}

/** Every workspace package: its manifest, its source directory, and its tsconfig. */
function workspace() {
  const packages = new Map();
  for (const root of ROOTS) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(root, name);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      let paths = {};
      try {
        // Comments are legal in a tsconfig and illegal in JSON.
        const raw = readFileSync(join(dir, "tsconfig.json"), "utf8").replace(/\/\/.*$/gm, "");
        paths = JSON.parse(raw).compilerOptions?.paths ?? {};
      } catch {
        // A package with no tsconfig is not typechecked; nothing to verify.
      }
      packages.set(manifest.name, { dir, src: join(dir, "src"), manifest, paths });
    }
  }
  return packages;
}

const packages = workspace();
const problems = [];

// ── 1. Every import is declared ───────────────────────────────────────────────────────────────
for (const [name, pkg] of packages) {
  const declared = new Set([
    ...Object.keys(pkg.manifest.dependencies ?? {}),
    ...Object.keys(pkg.manifest.devDependencies ?? {}),
  ]);

  for (const specifier of [...importsIn(tsFiles(pkg.src), WATCHED)].sort()) {
    if (!declared.has(specifier)) {
      problems.push(`${name}: imports ${specifier} but does not declare it`);
    }
  }
}

// ── 2. Every tsconfig `paths` closure is complete ─────────────────────────────────────────────
//
// A `paths` entry points the typechecker at another package's *source*, so it also inherits that
// package's own imports — and those need entries too. Miss one and the typechecker falls back to
// the dependency's `dist`, which exists on a machine that has built before and nowhere else. That
// is exactly how `recover-worker` shipped green and failed on a clean checkout: it mapped
// `@kairos/razorpay` to source, and that source imports `@kairos/policy`.
//
// Tests are excluded here because nothing imports a test file, so a test-only dependency never
// enters the typechecker's graph through a `paths` entry.
for (const [name, pkg] of packages) {
  const mapped = new Set(Object.keys(pkg.paths));
  if (mapped.size === 0) continue;

  const needed = new Set();
  const seen = new Set([name]);
  const queue = [name];

  while (queue.length > 0) {
    const current = queue.pop();
    const source = packages.get(current)?.src;
    if (source === undefined) continue;
    for (const specifier of importsIn(tsFiles(source, false), WORKSPACE)) {
      needed.add(specifier);
      if (!seen.has(specifier)) {
        seen.add(specifier);
        queue.push(specifier);
      }
    }
  }
  needed.delete(name);

  for (const specifier of [...needed].sort()) {
    if (!mapped.has(specifier)) {
      problems.push(
        `${name}: tsconfig paths reaches ${specifier} transitively but has no entry for it`,
      );
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.stderr.write(
    "\nAdd each import to the package's dependencies (or devDependencies, if only its tests use " +
      "it), and each transitively-reached package to its tsconfig `paths`.\n",
  );
  process.exit(1);
}

process.stdout.write(
  "every workspace import is declared and every tsconfig path closure is complete\n",
);
