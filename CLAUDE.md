# web_rts — working notes

A browser RTS built to [PLAN.md](PLAN.md). Read PLAN.md's **Architecture
Invariants** before changing anything under `src/sim/` or `src/nav/`.

## The four rules that actually bite

1. **The simulation is integer-only.** `src/sim/**`, `src/nav/grid.ts` and
   `src/nav/flowfield.ts` are linted by `rts/no-nondeterminism`: no `Math.*`
   beyond the integer helpers, no `Date.now`, no float literals. Use
   `src/sim/fixed.ts`. `sqrt` takes a Q16.16 value; `isqrt` takes a whole
   number and saturates above 2^32 — mixing them up cost a real bug in M24.
2. **The simulation never touches the renderer or the DOM**, enforced by
   `rts/no-renderer-import`.
3. **World state and match state are separate.** The editor writes world state;
   a match reads it and writes only match state. `hashWorld` must not change
   while a match runs.
4. **Every mutation is a command** applied at a tick boundary.

`test/invariants.test.ts` asserts rules 1 and 2 still fail the build.

## When you change the simulation

The golden hash in `test/golden/sim.json` will change. That is expected **only**
when you meant to change simulation behaviour. Extend `SCRIPT` in
`test/determinism.ts` to cover what you added, run `pnpm gen:golden-sim`, and
say so in the commit. A hash that changed without a matching script change is a
desync introduced by that commit.

## Babylon's tree-shaken build

Some methods only exist if you import a module for its side effect. This has
bitten twice and fails silently — nothing throws, the thing just does nothing:

- `scene.createPickingRay` needs `@babylonjs/core/Culling/ray`
- `mesh.thinInstance*` needs `@babylonjs/core/Meshes/thinInstanceMesh`

If a renderer change makes nothing appear, check the side-effect import first.

## Verifying

`pnpm test` runs the suite and then the serial performance budgets. The budgets
are separate because wall-clock assertions inside a parallel runner measure how
busy the machine is.

Looking at the thing matters — several bugs here typechecked and passed tests:

```
pnpm shot out.png --keys "F5:300" --after 20000   # screenshot the running game
pnpm check:browser        # production build in a real browser, fails on any console error
pnpm check:multiplayer    # two browsers against a local relay, asserts no desync
pnpm check:bundle         # editor stays code-split, Inspector never ships
pnpm stress               # M33 performance profile
```

## Known gaps

- **M28–M29 (art) are not done**: they need the asset collection PLAN.md refers
  to, which is not in the repository. Everything renders as placeholder boxes,
  which is what PLAN.md intends until then.
- **60fps is unverified.** The only browser here is headless SwiftShader, which
  rasterises in software. `test/golden/perf.json` records the CPU half of the
  frame separately and says so.
- **Over-saturated mining degrades**, rather than merely flattening. Measured
  and documented at `HARVEST_SLOTS` in `src/sim/economy.ts`.
