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
| `pnpm test` | Vitest |
| `pnpm test:determinism` | The determinism harness alone |
| `pnpm lint` | ESLint, including the invariant rules |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm check:browser` | Builds, then loads the page in headless Chromium and fails on any console error |
| `pnpm gen:trig` | Regenerates the committed trig lookup tables |
| `pnpm gen:golden-sim` | Regenerates the determinism harness golden hash (deliberate act only) |

## Deployment

Pushing to `main` runs CI and publishes `dist/` to GitHub Pages
(`.github/workflows/deploy.yml`). Pages must be set to the **GitHub Actions**
source once in the repository settings. Vite's `base` is `/web_rts/`; override
it with the `VITE_BASE` environment variable when serving from elsewhere.

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
