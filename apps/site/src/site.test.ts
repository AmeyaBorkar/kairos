/**
 * Guards for the failures a static site fails at silently.
 *
 * None of this tests how the page looks. It tests the joins — the places where two files have to
 * agree and nothing enforces it: a canvas the code draws into that the markup does not declare, a
 * stylesheet the document links that nobody shipped, a recorded run whose shape has drifted from the
 * types that read it. Every one of those renders a blank rectangle in a browser and passes a
 * typecheck, which is the worst combination available.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DECK, RAIL_STATES, type RailReading, STEER_MODES } from "./console/types.js";
import { MARK, MARK_SIZE } from "./pixel/mark.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");

const html = readFileSync(join(PUBLIC, "index.html"), "utf8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const sources = sourceFiles(join(ROOT, "src")).map((f) => readFileSync(f, "utf8"));

describe("the mark", () => {
  it("is a square grid at favicon size", () => {
    expect(MARK).toHaveLength(MARK_SIZE);
    for (const row of MARK) expect(row).toHaveLength(MARK_SIZE);
  });

  it("uses only characters the painter knows", () => {
    for (const row of MARK) expect(row).toMatch(/^[.#/ox]+$/);
  });

  it("leaves an opening, which is the whole idea", () => {
    // Accent cells are the aperture. Without them the mark is a rectangle with a hole and no
    // reason to be this one rather than any other.
    const lit = MARK.join("")
      .split("")
      .filter((c) => c === "/").length;
    expect(lit).toBeGreaterThan(0);
  });
});

describe("the document and the code agree", () => {
  it("declares every canvas the code draws into", () => {
    const wanted = new Set<string>();
    for (const source of sources) {
      for (const m of source.matchAll(/surface\("([^"]+)"/g)) wanted.add(m[1] ?? "");
      for (const m of source.matchAll(/getElementById\("(c-[^"]+)"\)/g)) wanted.add(m[1] ?? "");
    }
    expect(wanted.size).toBeGreaterThan(8);
    for (const id of wanted) expect(html, `missing canvas #${id}`).toContain(`id="${id}"`);
  });

  it("declares every element the code writes text into", () => {
    const wanted = new Set<string>();
    for (const source of sources) {
      for (const m of source.matchAll(/\b(?:text|html)\("([a-z][a-z0-9-]*)"/g)) {
        wanted.add(m[1] ?? "");
      }
    }
    expect(wanted.size).toBeGreaterThan(5);
    for (const id of wanted) expect(html, `missing element #${id}`).toContain(`id="${id}"`);
  });

  it("ships every local asset it links", () => {
    const refs = [...html.matchAll(/(?:href|src)="(?!https?:)([^"#][^"]*)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs) {
      // The compiled bundle is a build artifact and is not in the tree until `pnpm build` runs.
      if (ref.startsWith("app/")) continue;
      expect(() => readFileSync(join(PUBLIC, ref)), `missing asset ${ref}`).not.toThrow();
    }
  });

  it("offers a view for every nav link, and a nav link for every view", () => {
    const links = [...html.matchAll(/nav-link" data-view="([a-z]+)"/g)].map((m) => m[1]);
    const views = [...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]);
    expect(links.sort()).toEqual(views.sort());
  });

  it("sends every hand-off to a view that exists", () => {
    const views = new Set([...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/data-goto="([a-z]+)"/g)) {
      expect(views, `data-goto="${m[1]}" goes nowhere`).toContain(m[1]);
    }
  });
});

describe("the stylesheets", () => {
  const styles = readdirSync(join(PUBLIC, "assets", "styles"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, readFileSync(join(PUBLIC, "assets", "styles", f), "utf8")] as const);

  it("ships something for every sheet the document links", () => {
    expect(styles.length).toBeGreaterThan(4);
    for (const [name, css] of styles) {
      expect(html, `${name} is not linked`).toContain(`assets/styles/${name}`);
      expect(css.length, `${name} is empty`).toBeGreaterThan(0);
    }
  });

  it("contains no C1 control characters", () => {
    // `content: "C"` lost its backslash somewhere between being written and being formatted,
    // and the escape resolved to U+0081 followed by a stray capital C. Every question on the site
    // rendered as "CHow do I know…D" and nothing complained: it is valid CSS, it typechecks, and it
    // only shows up by reading the page. Characters, not escapes, and this catches the next one.
    for (const [name, css] of styles) {
      const found = [...css].filter((c) => c.charCodeAt(0) >= 0x80 && c.charCodeAt(0) <= 0x9f);
      expect(found, `${name} carries a control character, probably a mangled escape`).toEqual([]);
    }
  });

  it("closes every rule it opens", () => {
    for (const [name, css] of styles) {
      const open = (css.match(/\{/g) ?? []).length;
      const close = (css.match(/\}/g) ?? []).length;
      expect(close, `${name} has unbalanced braces`).toBe(open);
    }
  });
});

describe("the recorded run", () => {
  const run = JSON.parse(
    readFileSync(join(PUBLIC, "assets", "data", "console-run.json"), "utf8"),
  ) as Record<string, unknown>;

  const scenarios = run["scenarios"] as Record<string, Record<string, unknown>>;

  it("carries every scenario the console offers", () => {
    for (const [name] of DECK) expect(Object.keys(scenarios)).toContain(name);
  });

  it("indexes its ledger against frames that exist", () => {
    for (const [name, scenario] of Object.entries(scenarios)) {
      const frames = scenario["frames"] as unknown[];
      for (const row of scenario["ledger"] as Array<[number]>) {
        expect(row[0], `${name}: ledger row points past the last frame`).toBeLessThan(
          frames.length,
        );
      }
    }
  });

  it("only uses rail states and steer modes the renderer can name", () => {
    for (const [name, scenario] of Object.entries(scenarios)) {
      for (const frame of scenario["frames"] as Array<Record<string, unknown>>) {
        for (const rail of frame["rails"] as Array<RailReading>) {
          expect(RAIL_STATES[rail[3]], `${name}: unknown rail state ${rail[3]}`).toBeDefined();
          expect(STEER_MODES[rail[5]], `${name}: unknown steer mode ${rail[5]}`).toBeDefined();
        }
      }
    }
  });

  it("names every rail it reports", () => {
    // Rails come and go from the window, so a reading's position says nothing about which rail it
    // is. This is the assertion that caught the first capture indexing them by position.
    for (const [name, scenario] of Object.entries(scenarios)) {
      const keys = (scenario["railKeys"] as unknown[]).length;
      for (const frame of scenario["frames"] as Array<Record<string, unknown>>) {
        for (const rail of frame["rails"] as Array<RailReading>) {
          expect(rail[0], `${name}: reading points at rail ${rail[0]} of ${keys}`).toBeLessThan(
            keys,
          );
          expect(rail[0]).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("keeps one reading per declared bound", () => {
    for (const [name, scenario] of Object.entries(scenarios)) {
      const bounds = (scenario["boundAxes"] as unknown[]).length;
      for (const frame of scenario["frames"] as Array<Record<string, unknown>>) {
        expect((frame["bounds"] as unknown[]).length, `${name}: bound count drifted`).toBe(bounds);
      }
    }
  });

  it("says it is simulated, everywhere it could be mistaken for collected", () => {
    // A dashboard of red rails and rupee figures is exactly the artifact that ends up screenshotted
    // into a slide. The page has to carry its provenance with it.
    expect(html).toContain("RECORDED RUN");
    expect(html.toLowerCase()).toContain("simulated");
  });

  it("still hashes end to end in every frame", () => {
    for (const [name, scenario] of Object.entries(scenarios)) {
      for (const frame of scenario["frames"] as Array<Record<string, unknown>>) {
        expect(frame["verified"], `${name}: a frame recorded an unverified ledger`).toBe(1);
      }
    }
  });
});

describe("known gaps", () => {
  it("records that the console does not drive recovery yet", () => {
    // Asserted rather than merely written down, so the day it is fixed this test fails and the
    // paragraph on the page explaining the gap gets deleted in the same change.
    const bound = new Set<string>();
    for (const scenario of Object.values(
      (
        JSON.parse(readFileSync(join(PUBLIC, "assets", "data", "console-run.json"), "utf8")) as {
          scenarios: Record<
            string,
            { ledger: Array<[number, string, string, number, string, string | null]> }
          >;
        }
      ).scenarios,
    )) {
      for (const row of scenario.ledger) if (row[5] !== null) bound.add(row[5]);
    }
    expect(
      [...bound].sort(),
      "a money bound started binding — the console now drives recovery, so update the page",
    ).toEqual(["kill-switch"]);
  });
});
