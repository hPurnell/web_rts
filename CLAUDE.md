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

## Terrain is a heightfield, not tiers

Heights live on cell **corners** as Q16.16 (`src/sim/terrain.ts`), not on
cells, so neighbouring cells share their corners and cannot crack. A cell is
two triangles split NW-SE, and `heightAt` interpolates within that triangle
rather than bilinearly, so the simulation and the mesh agree exactly about
where the ground is.

Connectivity is **two** rules, not one. `cellsConnect` checks that each cell's
own slope is traversable *and* that the step between them is: two cells can
both be perfectly flat with a cliff face between them, and checking only the
cells lets units walk off a ledge.

A match never writes to `world.heights` (invariant 3). Levelling a building's
footprint writes to `match.terrain`, a corner/height pair list that is part of
match state and is hashed. Every read of the terrain during a match has to be
passed those overrides, which is why so many signatures end in an optional
`overrides` parameter.

## Selection projects units at ground height

`unitsInRect` and `unitAtPoint` transform unit positions on the CPU rather than
raycasting meshes, and they need the **world Y the unit is drawn at**, supplied
as `PickOptions.groundY`. It used to be a hard-coded 0, which was nearly
harmless over flat tiers and is badly wrong over a heightfield: a unit on a
six-unit plateau projects most of a screen below itself, and the only way to
select it is to drag a box over the whole view.

`test/selection.test.ts` had a top-down matrix with no y terms at all, so it
could not have caught this. The height-aware cases use `PITCHED` instead. If
you add a projection test, make sure the matrix actually depends on y.

## Babylon's tree-shaken build

Some methods only exist if you import a module for its side effect. This has
bitten twice and fails silently — nothing throws, the thing just does nothing:

- `scene.createPickingRay` needs `@babylonjs/core/Culling/ray`
- `mesh.thinInstance*` needs `@babylonjs/core/Meshes/thinInstanceMesh`

If a renderer change makes nothing appear, check the side-effect import first.

## Triangle winding

Babylon's default is left-handed, so a front face is clockwise as seen from the
front — which means the right-hand-rule cross product of a **visible ground
triangle points down**. Getting this backwards renders the entire map as
nothing but its edge skirt, silently, with every test still passing. It has
cost one debugging session. `test/terrain.test.ts` asserts it directly now.

## Console and main menu

The game boots into the main menu. `?menu=0` skips it, which is what `pnpm
shot` wants; `?relay=` and `?mode=editor` skip it too, because both are already
requests to be somewhere specific. All of that routing lives in one block near
the bottom of `startApp`, **below** the console's construction — joining a
relay locks cheats off, so it cannot run before the console exists. Putting it
higher up costs a temporal-dead-zone error that names `gameConsole` rather than
the URL parameter that actually caused it.

The console (backquote) is split in two on purpose: `ui/console.ts` is the
registry, parser, history and completion with no DOM at all, and
`ui/consoleview.ts` draws it. The game's own commands are in
`game/consolecommands.ts` and reach the app through `ConsoleGame`, which the
main menu uses too — that is why Settings is a view onto cvars rather than a
second place preferences live.

**A console command never writes match state.** `give`, `spawn` and `kill`
build a `SimCommand` and queue it like a mouse click would. Cheats are also
gated behind `sv_cheats`, which `joinMatch` locks off: the gate is not about
fairness, it is that one client inventing units the other never hears about is
a desync.

## Verifying

`pnpm test` runs the suite and then the serial performance budgets. The budgets
are separate because wall-clock assertions inside a parallel runner measure how
busy the machine is.

Looking at the thing matters — several bugs here typechecked and passed tests:

```
pnpm shot out.png --keys "F5:300" --after 20000   # screenshot the running game
pnpm shot out.png --path "?mode=editor" --wheel 1200   # the map with no fog over it
pnpm shot out.png --path "?menu=0"                     # straight into the game
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
- **Fog costs 3.0ms** on the 256x256 stress map, against a budget the plan
  raised from 2ms to 6ms when the disc stamp became a horizon sweep. It is the
  largest single item in a tick, and it is what buys terrain that genuinely
  occludes. `FogGrids.cellHeights` caches the whole map's heights and is keyed
  on `match.terrain.version`; refilling it every update costs as much again as
  the sweeps do.
