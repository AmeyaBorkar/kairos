#!/usr/bin/env node
/**
 * Three checks, all answering the same question: does this repository resolve in a clean checkout?
 *
 * The workspace graph is declared in three separate places — each manifest's dependencies, each
 * tsconfig's `paths`, and the test runner's alias map — and every one of them can disagree with the
 * others silently. Each mistake is invisible on a developer machine and fatal in CI. pnpm gives each
 * package a `node_modules` containing only its declared
 * dependencies, but a stale directory left by an earlier install will happily resolve an undeclared
 * import, and Windows path resolution is more forgiving than Linux besides. A leftover `dist` does
 * the same for the typechecker. The result either way is a package that works for the person who
 * wrote it, passes every local check including a commit-by-commit bisect on the same machine, and
 * fails the moment CI installs from a frozen lockfile into an empty tree.
 *
 * The checks are deliberately crude — a regular expression over `from "..."`, restricted to the
 * workspace's own packages and its handful of runtime dependencies. Anything cleverer would need a
 * module graph, and none of these failures is subtle enough to be worth one.
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

// ── 3. Every core package is aliased for the test runner ──────────────────────────────────────
//
// The workspace graph is declared in three places: each manifest's dependencies, each tsconfig's
// `paths`, and the test runner's alias map. The first two are checked above. The third is what makes
// `pnpm test` run against *source*, so that a clean checkout needs no build step — and a package
// missing from it does not fail loudly. It falls through to Node resolution and finds the package's
// `dist`, which exists on a machine that has built before and nowhere else. That is the same failure
// the check above exists for, arriving through a different door.
//
// Only `packages/` and `adapters/` are covered: an app is an entry point and nothing imports one by
// name.
{
  let config = "";
  try {
    config = readFileSync("vitest.config.ts", "utf8");
  } catch {
    problems.push("vitest.config.ts is missing, so nothing pins the test runner to source");
  }
  const aliased = new Set([...config.matchAll(/"(@kairos\/[a-z-]+)"\s*:/g)].map((m) => m[1]));
  for (const [name, pkg] of packages) {
    if (!pkg.dir.startsWith("packages") && !pkg.dir.startsWith("adapters")) continue;
    if (!aliased.has(name)) {
      problems.push(
        `${name}: has no alias in vitest.config.ts, so its tests would resolve its dist`,
      );
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.stderr.write(
    "\nAdd each import to the package's dependencies (or devDependencies, if only its tests use " +
      "it), each transitively-reached package to its tsconfig `paths`, and each core package to " +
      "the alias map in vitest.config.ts.\n",
  );
  process.exit(1);
}

process.stdout.write(
  "every workspace import is declared, every tsconfig path closure is complete, and every core " +
    "package resolves to source under test\n",
);
