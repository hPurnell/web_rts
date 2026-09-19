# web_rts

A 3D real-time strategy game in the browser. TypeScript, deterministic lockstep
simulation, continuous heightfield terrain in the vein of Generals or Tiberium
Wars, fog of war computed by a radial horizon sweep, an in-game map editor with
sculpting brushes, and a Quake-style console.

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
| `pnpm check:multiplayer` | Runs two browsers against a local relay and asserts they stay in sync |
| `pnpm relay [port]` | Runs the match relay locally for development |
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

Milestones M0–M27 and M30–M33 of [PLAN.md](PLAN.md) are done: foundation, world
state, renderer, editor, simulation core, movement, fog of war, combat,
economy, buildings and the HUD, plus replays, lockstep multiplayer, a skirmish
bot and a performance baseline. M28–M29 (art) are blocked on an asset collection that is not in the
repository.

### Performance

`test/golden/perf.json` holds the committed baseline, regenerated with
`pnpm stress --write` and guarded by a regression test. The stress scenario is
PLAN.md's: ~700 live units with 600 of them engaged, on a 256×256 map.

| | |
|---|---|
| Simulation tick | 2.4 ms (budget: 8 ms) |
| — of which movement | 1.8 ms |
| — of which fog, every 4th tick | 3.0 ms (budget: 6 ms) |
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

## VS Code

`.vscode/` has run profiles and tasks. Nothing launches a browser — start the
dev server and open it yourself.

- **Run and Debug** (Ctrl+Shift+D): *Dev server*, *Match relay*, *Debug all
  tests*, *Debug current test file*, *Debug performance budgets*, and *Debug
  current script (tsx)* for anything in `tools/`.
- **Run Task** (Terminal → Run Task): the same server plus `build`, `lint`,
  `typecheck`, the checks (`bundle`, `browser`, `multiplayer`), the stress
  profile and a screenshot task. Ctrl+Shift+B builds; the default test task is
  the full suite.

The dev server serves **http://localhost:5173/web_rts/** — Vite's `base`
matches the GitHub Pages path, so the bare root 404s.

## Console

Backquote opens it. `help` for help, `cmdlist` and `cvarlist` for everything;
Tab completes, up and down walk history.

```
map 42                      start a match with a seed
connect ws://host:8787      join through a relay
status / hash / where       what is going on
r_overlay slope             debug terrain overlays
bind F4 "spawn raider 4"    binds take arguments
sv_cheats 1                 unlocks give, spawn, kill, stress
```

Commands that change the match queue a `SimCommand` rather than writing state,
so they are applied at a tick boundary and recorded in the replay. Cheats are
locked off entirely in a networked match, because a client inventing units the
other never hears about is a desync rather than an unfairness.

Archived cvars and binds persist in `localStorage`.

## Multiplayer

Lockstep: only commands cross the wire, never state, so the traffic does not
grow with the size of the army. A tick does not run until every player's
commands for it have arrived — no prediction and no reconciliation — and state
hashes are exchanged every 100 ticks, halting the match with a tick number if
they ever disagree.

`src/net/room.ts` is the relay: it assigns player ids, starts the match, and
forwards turns. It never simulates anything, so it cannot be a bottleneck and
cannot desync. It runs as a Cloudflare Durable Object (`wrangler.toml`,
`src/net/worker.ts`) and, unchanged, as a local server for development
(`pnpm relay`).

To play locally: run `pnpm relay`, then open two browsers on
`?relay=ws://localhost:8787/?match=demo&match=demo`. `pnpm check:multiplayer`
does exactly that headlessly and asserts the two clients stay bit-identical.
