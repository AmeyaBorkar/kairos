#!/usr/bin/env node
/**
 * Fail if any workspace package imports something it does not declare.
 *
 * This exists because that mistake is invisible locally and fatal in CI. pnpm gives each package a
 * `node_modules` containing only its declared dependencies, but a stale directory on a developer
 * machine — left behind by an earlier install with different dependencies — will happily resolve an
 * undeclared import, and Windows path resolution is more forgiving than Linux besides. The result is
 * a package that works for the person who wrote it, passes every local check including a
 * commit-by-commit bisect on the same machine, and fails the moment CI installs from a frozen
 * lockfile.
 *
 * A tsconfig `paths` entry makes it worse, because the *typechecker* resolves the import from the
 * repository root while the *runtime* resolves it from the package. So the build is green and the
 * tests cannot start.
 *
 * The check is deliberately crude: a regular expression over `from "..."`, restricted to the
 * workspace's own packages and its handful of runtime dependencies. Anything cleverer would need a
 * module graph, and the failure this catches is not subtle enough to be worth one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WATCHED = /^(@kairos\/[a-z-]+|throttlekit|fastify|zod)$/;
const IMPORT = /(?:from|import)\s+"([^"]+)"/g;
const ROOTS = ["packages", "adapters", "apps"];

function tsFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...tsFiles(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

const problems = [];

for (const root of ROOTS) {
  let packages;
  try {
    packages = readdirSync(root);
  } catch {
    continue;
  }

  for (const name of packages) {
    const manifestPath = join(root, name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }

    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);

    const used = new Set();
    for (const file of tsFiles(join(root, name, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1];
        if (WATCHED.test(specifier)) used.add(specifier);
      }
    }

    for (const specifier of [...used].sort()) {
      if (!declared.has(specifier)) {
        problems.push(`${manifest.name}: imports ${specifier} but does not declare it`);
      }
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.stderr.write(
    "\nAdd each to the package's dependencies (or devDependencies, if only its tests use it).\n",
  );
  process.exit(1);
}

process.stdout.write("every workspace import is declared\n");
