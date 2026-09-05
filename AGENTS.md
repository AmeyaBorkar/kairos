# Working on Kairos

For anyone changing the code — human or agent. If you only want to understand the system, read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) instead; this file is about how to work in the
repository without breaking its rules.

A pnpm workspace. `packages/` is a pure core with no I/O and no clock reads, `adapters/` satisfies
its ports, `apps/` wires them together. Node ≥ 22, pnpm ≥ 11.

## The gate

```sh
pnpm install
pnpm check          # lint · dependency boundaries · typecheck · test — run this before you claim done
```

`pnpm check` is what CI runs and what a change has to pass. The individual pieces:

| Command | What it does |
|---|---|
| `pnpm test` | The suite, offline. No API key is needed for any of it. |
| `pnpm test:coverage` | The same suite under v8 coverage. **CI runs this one on Node 22** — see the trap below. |
| `pnpm typecheck` | Every package, including test configs. |
| `pnpm lint` / `pnpm lint:fix` | Biome. |
| `pnpm check:deps` | Enforces the ring boundaries — the core may not import an adapter. |
| `pnpm build` | Required before the benchmarks; they run against `dist`. |
| `pnpm bench:scorecard` | All four arms, seeded, about 29s. Writes the run every published figure comes from. |
| `pnpm bench:gate` | The same at gate size, judged against the committed baseline. |
| `pnpm demo` | The whole system under Docker Compose: Postgres, sentry, a worker fleet, the console, traffic. |

**The trap.** `pnpm check` runs vitest *without* coverage and CI runs it *with*. Instrumentation
roughly quadruples hot loops, so a test can pass the gate locally and time out in CI. If you write
something that walks a long simulation, run `pnpm test:coverage` before pushing and give it an
explicit timeout with the measurement in a comment, as `apps/traffic/src/merchant.test.ts` does.

## Commits

Conventional commits, enforced on pull requests by commitlint. The scope must be one of the list in
[`commitlint.config.js`](commitlint.config.js) and the header must be ≤ 100 characters.

**No attribution trailers.** No `Co-Authored-By`, no session links, no "generated with" lines. The
history is presented as the author's own engineering work and a trailer undercuts that.

Every commit must stand alone: it builds, it passes CI, and the history stays bisectable. No "wip",
no commits that knowingly break the build, no fixups left in the log. Stage work into coherent
units rather than one commit per file touched.

## Rules that are not style

- **This repository is public.** `*.env` and `.env.*` are gitignored; keep it that way. Never print
  a key, even masked.
- **Razorpay test mode only.** `pnpm razorpay:probe` refuses a key that does not start with
  `rzp_test_`. The failure mode of getting this wrong is a real charge to a real person.
- **Delivery is dry-run.** `recover-worker` refuses to start with `KAIROS_DELIVERY` set to anything
  else. Live delivery needs a gateway that can charge a saved token with nobody present and a
  DLT-registered sender; a repository has neither.
- **Nothing in the core reads a clock.** Time arrives through an injected `Clock` so a decision
  replays exactly. Which clock to use is not a preference —
  [ADR 0010](docs/decisions/0010-the-kernel-clock-governs-the-campaign-the-wall-clock-governs-the-world.md)
  decides it: the kernel's clock governs the campaign, the wall clock governs everything outside
  the process.
- **Nothing spends money except through `Terminus.admit`.** The executor takes a `Grant`, and
  admission is the only thing that makes one. Do not add a path around it.
- **Numbers come from the run.** Every figure in the README, on the site and in the film is
  produced by `pnpm bench:scorecard` and lives in `docs/results/`. If you change a claim, change
  the run — do not type a number.

## Where the answers are

| Question | File |
|---|---|
| What is this and how do I run it | [README.md](README.md) |
| How is it built, and why that way | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Where does every number come from, and how wide is its band | [docs/MEASUREMENT.md](docs/MEASUREMENT.md) |
| Why was this decided, and what would reverse it | [docs/decisions/](docs/decisions/) |
| What the benchmark actually produced | [docs/results/](docs/results/) |

`docs/MEASUREMENT.md` is also where the project records what it *cannot* claim. It names one metric
whose band is wider than the value it guards and says outright not to quote its point value, and it
records the arm where a simpler baseline beats Kairos. Read it before writing a summary.
