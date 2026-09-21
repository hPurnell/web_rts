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

## CSS pixels vs the drawing buffer

`render/engine.ts` calls `setHardwareScalingLevel(1 / devicePixelRatio)`, so on
a HiDPI display **the drawing buffer is larger than the canvas**:
`engine.getRenderWidth()` is 2560 where `getBoundingClientRect().width` is 1280.

Every pointer coordinate in the app is a CSS pixel — `canvasPoint` and
`input.pointer` both come from `getBoundingClientRect()`. So anything that
projects world positions to the screen, or divides a pixel delta into world
units, must use the **CSS size** (`viewportSize()` in `app.ts`), never
`getRenderWidth()`. Mixing them scales every projected unit by the device pixel
ratio and box selection misses entirely.

Babylon's `createPickingRay` takes CSS pixels and multiplies by
`1 / getHardwareScalingLevel()` itself, which is why terrain picking was
unaffected — and why this hid for so long.

It is invisible at ratio 1, which is what all the headless tooling runs at, so
`check:browser` opens a second page at `deviceScaleFactor: 2` purely to box
select and confirm it catches something.

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

## Scenery is fogged by a material plugin

Terrain fogs itself in `terrainMaterial.ts`; scenery and roads use Babylon's
`StandardMaterial`, which `render/sceneryfog.ts` extends with a material plugin
doing the same lookup by world position. `setTerrainFog` drives both, so
nothing can turn the ground's fog off and leave the scenery's on. Pass a
material through `fogMaterial` to opt it in. Units deliberately do not: they
are hidden outright, not dimmed.

Shadows follow the same pattern: `castShadow(mesh)` / `receiveShadow(mesh)`
in `render/shadows.ts`, which owns the one `ShadowGenerator` and fits it to
the camera's ground footprint every frame, snapped to its texels so shadows do
not crawl as the view pans. The terrain samples the map itself in
`terrainMaterial.ts`, and only the sun term is shadowed. `r_shadows 0` turns it
all off. In the headless SwiftShader checks shadows cost about a third of the
frame; most of that is filling a 2048² map in software.

Enabling a plugin on a material that has already compiled does **not** dirty
its defines. The define is set, nothing recompiles, and the fog silently never
appears; `setEnabled` calls `markAllDefinesAsDirty()` for that reason.

## The follow camera

**F** (or the Follow cam button) on a selected mobile unit hands the camera
to `render/chasecamera.ts`; **F** again, **Esc** or a minimap click hands it
back. It follows the unit *as drawn* (`UnitRenderer.poseOf`, interpolated
between ticks), so it must run after the unit renderer each frame and before
shadows are fitted — the frame loop calls `updateChase` there, not beside
`camera.update`. The smoothing is critically damped springs, and the tests in
`test/chasecamera.test.ts` pin what "smooth" means: no cut, no jolt, no snap.

While following, the view is framed above the HUD panel with a lens shift: an
off-centre projection frozen onto the camera. Picking and selection read the
camera's projection, so they agree with it. Babylon does **not** recompute a
projection when you unfreeze it — it keeps returning the frozen one — so
`setLens(0)` forces `getProjectionMatrix(true)`.

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

A local game starts with `sv_cheats 1` and `r_fog 0`, for development. Locking
cheats also puts every cheat cvar with a `fair` value back to it, which is what
turns fog on for a networked match; before that the lock left a cheat set
beforehand in force.

## The Generals source is checked out, and settles these questions

`CnC_Generals_Zero_Hour/` is the game's own source, gitignored. Reach for it
before reverse-engineering a format or matching a look by eye — it has already
settled two things that days of measurement could not.

`GeneralsMD/Code/GameEngineDevice/Source/W3DDevice/GameClient/` is the part
that matters: `WorldHeightMap.cpp` for the map format and terrain UVs,
`BaseHeightMap.cpp` and `HeightMap.cpp` for how the ground is lit and drawn.

## A terrain tile index is a tile *and* a quarter

The low two bits of a `BlendTileData` index are a quadrant, not part of the
index: `WorldHeightMap::getUVForNdx` takes `tileNdx >> 2` as the 64x64 source
tile, bit 0 picks the left or right half and bit 1 the top or bottom, because
one tile covers two cells each way.

Matching the raw index against a texture class's `[firstTile, +numTiles)`
range therefore puts most of the map on the wrong texture: on Tournament
Desert it matched 69,000 of 91,800 cells and every one of them wrongly. With
the shift, all 91,800 match.

Their tile rows run bottom-up — the loader walks the TGA in file order and a
TGA starts at the bottom — so the row is flipped into the top-down space our
decoder produces.

## Terrain lighting is literal, and is not doubled

`BaseHeightMapRenderObjClass::doTheLight` sums `ambient + N.L * diffuse` over
the three global lights, clamps to 1, and the terrain shader modulates the
texture by it with `GRADIENT_MODULATE` — a plain modulate, not the 2x this era
often used. Only the *first* light contributes ambient. A warm morning desert
really is drawn at about three quarters of its texture's own brightness, so do
not "fix" that by brightening. `r_lightscale` exists for taste, and because
the game applies two passes this does not: a cloud layer and a macro
noise/lightmap.

## A W3D mesh's first texture is usually not the one it draws with

A mesh can have several material passes. When it has more than one, the first
carries a reflection or detail map and the *last* carries the diffuse:
`LAKEDUSK.tga`, a photograph of a sky, is the first pass of 395 of the 768
multi-pass meshes in the shipped art. Taking the first `TEXTURE_NAME` in the
chunk tree wallpapers every two-pass building and vehicle with clouds.

`readMeshes` takes the texture *and* the coordinates from the same pass,
searching last-first, which is the invariant that matters: whatever UVs are
used are the ones authored for the texture used.

## Object definitions come in three forms

`Object`, `ChildObject` and `ObjectReskin`. The third is not a footnote — 235
blocks use it and it is where every numbered bush, fence and wall variant
lives. `ObjectCreationList` starts with the same six letters and is an effect
list, not an object. A header line may also carry a trailing comment.

## Aircraft are a separate movement system

`src/sim/flight.ts`, not `movement.ts`. An aircraft ignores the flow field, the
navigation grid and every other unit, and carries an `altitude` and an
`airState` in the unit store — both hashed. Ground movement skips them and so
does separation, or a helicopter ploughs a furrow through the infantry below.

Its physics are **rate-limited**: an acceleration and a turn rate, rather than
the instant top speed a ground unit gets. That is deliberate, and the renderer
depends on it — bank and pitch are derived from the change in velocity between
two ticks, not animated, so they are not stored and not hashed.

The determinism script drives the gunships by **explicit handles**, not a
range: they land in slots that are neither contiguous nor all at generation 1,
and `MoveUnits` silently drops handles it cannot resolve. A range looked fine
and quietly ordered nothing. `test/determinism.test.ts` asserts the handles are
live aircraft of the right owner, so the next slot shift fails loudly.

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
