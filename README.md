# web_rts

A 3D real-time strategy game in the browser. TypeScript, deterministic lockstep
simulation, SC2-style discrete cliff terrain, fog of war with high-ground
vision, and an in-game map editor.

See [PLAN.md](PLAN.md) for the architecture invariants and milestone plan.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | Typecheck + production build into `dist/` |
| `pnpm test` | Vitest, then the serial performance budgets |
| `pnpm test:perf` | The performance budgets alone (see vitest.perf.config.ts) |
| `pnpm test:determinism` | The determinism harness alone |
| `pnpm lint` | ESLint, including the invariant rules |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm check:bundle` | Asserts the editor stays code-split and the Inspector never ships |
| `pnpm check:browser` | Builds, then loads the page in headless Chromium and fails on any console error |
| `pnpm shot out.png` | Screenshots the running game in headless Chromium (`--wheel`, `--keys`, `--wait`) |
| `pnpm gen:trig` | Regenerates the committed trig lookup tables |
| `pnpm gen:golden-sim` | Regenerates the determinism harness golden hash (deliberate act only) |

## Deployment

Pushing to `main` runs CI and publishes `dist/` to GitHub Pages
(`.github/workflows/deploy.yml`). Pages must be set to the **GitHub Actions**
source once in the repository settings. Vite's `base` is `/web_rts/`; override
it with the `VITE_BASE` environment variable when serving from elsewhere.

## Progress

Milestones M0–M23 of [PLAN.md](PLAN.md) are done: foundation, world state,
renderer, editor, simulation core, movement and fog of war. Phases 6–9
(combat, economy, buildings, HUD, art, replays, netcode, AI) are not started.

| Key | Does |
|---|---|
| F2 | Toggle the map editor |
| F3 | Cycle the flag debug overlay |
| F5 | Start or stop a test match |
| F9 | Babylon Inspector (dev builds only) |
| WASD / arrows / edge / middle-drag | Pan |
| Wheel | Zoom |
| Left-drag | Box select |
| Right-click | Order (shift queues) |
| 0–9 | Control groups (ctrl sets, shift adds) |

## Invariant enforcement

`eslint-rules/` holds two custom rules applied to `src/sim/**`:

- `rts/no-nondeterminism` — bans `Math.*` (except integer helpers), `Date.now`,
  `performance.now` and float literals.
- `rts/no-renderer-import` — bans importing `src/render/**` or Babylon, and DOM
  globals.

`test/invariants.test.ts` asserts both rules still fire.

## The determinism harness

`test/determinism.ts` builds a match from a fixed seed, applies a scripted
command list, steps 600 ticks and hashes the result against
`test/golden/sim.json`.

Every simulation milestone **extends** `SCRIPT` and regenerates the golden hash
with `pnpm gen:golden-sim`, and says so in the commit. A golden hash that
changes without a matching script change is a desync introduced by that commit,
not a test that needs updating.
