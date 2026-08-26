# @kairos/site

The public site. Four views in one static document: the case in four questions, a recorded console
run, the architecture, and the benchmarks.

```sh
pnpm --filter @kairos/site run build   # icons, then tsc → public/app
pnpm --filter @kairos/site run dev     # http://localhost:8080
```

`public/` is the deploy artifact. Everything it needs is inside it and nothing outside it is
required at runtime — no server, no API, no key.

## Layout

```
src/                    TypeScript, compiled to public/app as native ES modules
  pixel/                the drawing primitives, the render pipeline, and the mark
  scenes/               one module per drawing
  case/                 reading position, and the case view's animation loop
  console/              the recorded-run player and its read model
public/
  index.html            the whole document; views are sections, toggled by hash
  assets/styles/        seven stylesheets, split by concern
  assets/data/          the recorded console run
  assets/icons/         generated — see below
scripts/
  make-icons.mjs        favicon and touch icons, cut from the mark
  capture-run.mjs       re-record the console run
  serve.mjs             static server for public/
```

## No bundler

`tsc` emits ES modules with explicit `.js` specifiers, which browsers resolve natively. There is
nothing between the TypeScript and the tab: no bundle step to debug, no config to keep current, and
the file you read in `src` is the file the browser runs.

The cost is a handful of extra requests on first load, which for a page this size is not a cost.

## The mark

`src/pixel/mark.ts` holds the logo as sixteen strings. The page draws it to a canvas so it recolours
with the palette; `scripts/make-icons.mjs` parses the same array and emits the favicon, the touch
icons and the social image. There is no second copy to drift.

Four blades that pass each other rather than meet, leaving an opening in the middle. The interlock
is the bound; the opening is the moment.

## The recorded run

A published page cannot reach `apps/console` — a reader is not running this repository, and a static
host has nothing to proxy to. So the console view replays a recording of the real thing:

```sh
pnpm --filter @kairos/console run build
pnpm --filter @kairos/site run capture
```

That drives the actual `ConsoleRun` — real detector, real kernel, real ledger — over 470 steps of
each scenario and compacts the snapshots. It starts from a pinned instant, so re-running it against
unchanged code produces **byte-identical output**; a diff on `console-run.json` therefore always
means something changed.

The page says `RECORDED RUN` on it, in the provenance strip, because a dashboard of red rails and
rupee figures is exactly the artifact that ends up screenshotted into a slide.

### What the console does not show

The recovery arm is not driven by `ConsoleRun` yet — it returns `EMPTY_RECOVERY` — so `contact-cap`
and `campaign-budget` never bind, and `budget-exhaustion` never exhausts its ₹20: a steer reserves
₹3 and reconciles to zero. Only `kill-switch` produces refusals with a named binding axis. The page
states this rather than dressing around it, and closing that gap is the change that would make the
console show the whole loop.

## Accessibility and motion

Every scene holds still under `prefers-reduced-motion`, the console opens on a frame where something
is already happening rather than autoplaying, and the artwork's readouts are HTML updated from the
same state the drawing used — so a screen reader gets the numbers, not a canvas.
