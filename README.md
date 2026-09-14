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
| `pnpm stress` | Runs the M33 stress profile; `--write` updates the committed baseline |

## Deployment

Pushing to `main` runs CI and publishes `dist/` to GitHub Pages
(`.github/workflows/deploy.yml`). Pages must be set to the **GitHub Actions**
source once in the repository settings. Vite's `base` is `/web_rts/`; override
it with the `VITE_BASE` environment variable when serving from elsewhere.

## Progress

Milestones M0–M27 and M30 of [PLAN.md](PLAN.md) are done: foundation, world
state, renderer, editor, simulation core, movement, fog of war, combat,
economy, buildings and the HUD, plus replays. M28–M29 (art) are blocked on an
asset collection that is not in the repository. M31 (netcode) is not started.

### Performance

`test/golden/perf.json` holds the committed baseline, regenerated with
`pnpm stress --write` and guarded by a regression test. The stress scenario is
PLAN.md's: ~700 live units with 600 of them engaged, on a 256×256 map.

| | |
|---|---|
| Simulation tick | 2.4 ms (budget: 8 ms) |
| — of which movement | 2.2 ms |
| — of which fog, every 4th tick | 1.6 ms |
| Browser CPU per frame, ~850 units | ~7 ms |
| Terrain + units + rings | 11 draw calls |

The "60fps on mid-range hardware" criterion is **not verified**: the only
browser available here is headless Chromium on SwiftShader, which rasterises in
software and reports ~19fps for reasons that have nothing to do with a GPU. The
CPU half of the frame is measured separately and is what the figures above
report.

| Key | Does |
|---|---|
| F2 | Toggle the map editor |
| F3 | Cycle the flag debug overlay |
| F5 | Start or stop a test match, or stop a replay |
| F6 / F7 | Save the last match's replay / open a replay |
| Space, `[`, `]` | Pause a replay, slower, faster |
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
