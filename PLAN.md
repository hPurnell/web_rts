# Browser RTS — Build Plan

A 3D real-time strategy game running in the browser. TypeScript, deterministic
lockstep simulation, continuous sculpted terrain in the style of C&C Generals
and Tiberium Wars, fog of war with real line of sight, and an in-game map
editor.

This document is written for a coding agent. Each milestone is atomic,
independently verifiable, and ends with something demonstrable. Work them in
order unless a milestone explicitly says otherwise.

> **Terrain model.** An earlier revision of this plan used SC2-style discrete
> cliff tiers: a small integer height per cell, cliffs as hard tier boundaries,
> and ramps as authored objects bridging exactly one tier. This revision
> replaces that with a continuous heightfield. The consequences are not
> cosmetic — connectivity, vision, picking, the editor's whole toolset and the
> terrain mesh all change. See **Migration** at the end for what that means for
> a build that already implements the tiered version.

---

## Architecture Invariants

These rules hold for the entire project. Breaking one is a bug even if tests
pass. Re-read this section before starting any milestone.

1. **The simulation is 2D over a heightfield.** Units have `x` and `z` only.
   Terrain height is a real value the simulation *reads* — for slope, movement
   cost and line of sight — but never *integrates over*: nothing has a Y
   velocity, nothing falls, and a unit's height is always whatever the terrain
   under it says. Y as a coordinate the simulation owns does not exist.

2. **Terrain height is fixed-point, like everything else.** Heights are Q16.16
   in an `Int32Array`. This is the rule most easily broken by the new terrain
   model: a heightfield invites floats, and a float in a height is a float in a
   slope, which is a float in a path cost, which is a desync. Slopes are
   compared as squared rationals so the common case needs no square root.

3. **The simulation is deterministic.** All sim arithmetic is fixed-point Q16.16
   over `Int32Array`. Inside `src/sim/**` the following are banned and enforced
   by lint rule: `Math.random`, `Math.sin`, `Math.cos`, `Math.tan`, `Math.pow`,
   `Math.exp`, `Math.log`, `Date.now`, `performance.now`, and all float
   literals. Randomness comes from the seeded PRNG only. Trig comes from the
   lookup tables only.

4. **The simulation never imports the renderer.** `src/sim/**` must not import
   from `src/render/**`, `babylonjs`, or any DOM API. Enforced by lint rule.
   The renderer reads sim state; it never writes to it.

5. **World state and match state are separate.**
   - *World state*: the authored heightfield, walkability and buildability
     flags, doodads, resource node positions, start locations. Authored by the
     editor, saved to disk.
   - *Match state*: units, buildings, fog grids, player resources, projectiles,
     **and any terrain the match itself has changed**.

   The editor mutates world state only. The simulation mutates match state
   only. Continuous terrain makes this rule matter more than it did with
   tiers, because a match now has reasons to change the ground: levelling a
   building footprint, and later craters. Those go in a match-owned height
   override layer (M4), never into the authored heightfield. This keeps the
   editor's Test/Stop toggle nearly free and keeps map files stable.

6. **All mutations flow through commands.** Both the editor and the game apply
   changes as discrete command objects at tick boundaries. This single decision
   gives undo/redo, replays, and lockstep netcode for almost no extra work.

7. **No `SharedArrayBuffer`.** The game ships on GitHub Pages, which cannot send
   COOP/COEP headers, so `crossOriginIsolated` is always false. Worker
   communication uses `postMessage` with transferable `ArrayBuffer`s. Do not
   add the `coi-serviceworker` workaround.

8. **Every milestone ends green.** Typecheck passes, tests pass, `pnpm build`
   succeeds, and the deployed Pages build loads without console errors. Do not
   start the next milestone otherwise.

---

## The terrain model, in one place

Everything downstream depends on these choices, so they are stated once here
rather than repeated in each milestone.

**Heights live on cell corners.** A map of `width × height` cells has a
`(width + 1) × (height + 1)` grid of corner heights. Corners rather than
centres, because corners are shared: adjacent cells cannot disagree about where
their shared edge is, so the surface has no cracks by construction, and each
cell has four corners from which its slope is exactly defined.

**A cell is two triangles**, split along one diagonal chosen by a fixed rule
(always north-west to south-east). The rule has to be fixed and shared: the
renderer, the picker and the sim's height sampling must all agree about which
triangle a point is in, or a unit will stand a few centimetres off the ground it
is being shot on.

**Slope replaces tiers.** There are no tiers, no tier boundaries, no ramps as
objects. A cell's slope is the largest height difference across it divided by
the cell size. Traversability is a threshold on that: at or below
`MAX_TRAVERSABLE_SLOPE` a cell is passable, above it a cliff. A ramp is just
ground someone sculpted gently enough to walk up, which is exactly how ramps
work in Generals — and it means the editor never needs a ramp tool, only a
sculpting tool that can make gentle slopes.

**Movement cost rises with slope**, so units prefer flat ground and route
around hills without being told to. This is the single change that makes
continuous terrain feel different from a flat plane with obstacles.

**Line of sight replaces the high-ground rule.** With tiers, vision was
`tier[cell] <= tier[unitCell]`. With a heightfield the honest equivalent is a
radial horizon sweep: walk outward along each ray from the unit, track the
greatest elevation angle seen so far, and a cell is visible only if it rises
above that horizon. High ground still sees further and into more, but now it
does so because of the shape of the ground rather than because of a rule.

**Constants** (all Q16.16, all in `src/sim/terrain.ts`):

| Name | Meaning |
|---|---|
| `MAX_TRAVERSABLE_SLOPE` | Rise over run above which ground is a cliff. Start at 0.55 (~29°). |
| `SLOPE_COST_SCALE` | How much a unit of slope adds to movement cost. |
| `MAX_BUILD_SLOPE` | Flattest-ground requirement for a building footprint. Start at 0.12. |
| `HEIGHT_MIN`, `HEIGHT_MAX` | Range the editor may sculpt within, so heights stay well inside Q16.16. |

Per-unit-type slope limits (infantry climbing what vehicles cannot) are a
natural extension and a deliberate non-goal for now: each distinct limit needs
its own cost grid and its own flow fields, and that cost should be paid when
the gameplay asks for it, not before. `src/nav/` is written so adding a second
movement class is adding a second grid, not a redesign.

---

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, `strict: true` | `noUncheckedIndexedAccess` on |
| Build | Vite | `base` must match the Pages path |
| Package manager | pnpm | |
| Renderer | Babylon.js | Thin instances, runtime Inspector |
| Entities | Hand-rolled SoA over typed arrays | See M14 |
| Tests | Vitest | |
| Hosting | GitHub Pages via Actions | See M0 |
| Netcode (later) | Cloudflare Durable Objects | See M31 |

Babylon is isolated behind `src/render/`. If it is ever swapped for Three.js,
nothing outside that directory should change.

## Directory Layout

```
src/
  sim/            deterministic simulation — no DOM, no Babylon, no floats
    fixed.ts      Q16.16 arithmetic
    rand.ts       seeded PRNG
    terrain.ts    heightfield sampling, slope, normals
    world.ts      world state (authored heightfield, flags, authored data)
    match.ts      match state (units, fog, resources, height overrides)
    commands.ts   command definitions and application
    tick.ts       the fixed-step loop body
  nav/            pathfinding — runs in a worker
    worker.ts
    flowfield.ts
  render/         Babylon — reads sim, never writes
  editor/         DOM overlay, dynamically imported
  ui/             in-game HUD, DOM overlay
  net/            lockstep transport (added at M31)
test/
tools/            offline scripts: asset conversion, map validation
```

---

# Phase 0 — Foundation

## M0. Repository scaffold and live deployment

Vite + TypeScript strict + pnpm + Vitest + ESLint. Create the directory layout
above with placeholder index files. Add a GitHub Actions workflow using
`actions/checkout`, `actions/configure-pages`, `actions/upload-pages-artifact`,
and `actions/deploy-pages`. Set Vite's `base` to `/<repo-name>/`.

Add two custom ESLint rules (or a `no-restricted-imports` /
`no-restricted-globals` config) enforcing invariants 3 and 4.

**Done when:** a page saying the project name is live at the GitHub Pages URL,
deployed by pushing to `main`. `pnpm test`, `pnpm lint`, `pnpm build` all pass.
Deliberately violating an invariant rule produces a lint error.

## M1. Fixed-point math

`src/sim/fixed.ts`. Q16.16 over `Int32Array`. Implement `add`, `sub`, `mul`
(64-bit intermediate via `Math.imul` pairs or `BigInt`-free shift trick), `div`,
`sqrt` (integer Newton or binary search), `abs`, `min`, `max`, `floor`, `lerp`,
and conversion helpers `fromInt`, `fromRatio`, `toFloat` (renderer only).

Generate a 4096-entry sine table at build time into a `const Int32Array`. Derive
`cos` by phase offset and `atan2` by a fixed-point CORDIC or a table-driven
octant approach.

**Done when:** unit tests cover overflow boundaries, negative operands, and
rounding direction. `sqrt` is exact for perfect squares. Trig results match a
golden table committed to the repo. Property test: `mul(a, div(b, a))` recovers
`b` to within the precision the operations actually permit, and the test states
that bound rather than asserting a bound the arithmetic cannot deliver.

## M2. Seeded PRNG

`src/sim/rand.ts`. PCG32 or xoshiro128\*\*. Explicit state passed in and out, or
held in a class that can be cloned and serialized. Provide `nextU32`,
`nextRange(min, max)`, and `nextFixed01`.

**Done when:** a given seed reproduces an identical 10,000-value sequence across
runs and across Node and browser. State serializes to and from bytes.

## M3. Determinism harness

`test/determinism.ts`. A function that hashes match state: FNV-1a or xxHash32
over every sim typed array in a fixed order. A test runner that constructs a
match from a fixed seed, applies a scripted command list, steps N ticks, and
asserts the final hash equals a golden value committed to the repo.

Add a `pnpm test:determinism` script and wire it into CI.

**Done when:** the harness runs against the (currently near-empty) match state
and passes. A deliberately introduced float operation in a sim function makes
the hash change and the test fail.

> This milestone looks like overhead. It is the single highest-value thing in
> this plan. Every subsequent milestone extends the scripted command list, so
> desyncs are caught by the commit that causes them rather than three months
> later in a multiplayer match.

---

# Phase 1 — World and Rendering

## M4. World state and the heightfield

`src/sim/terrain.ts` and `src/sim/world.ts`.

`src/sim/terrain.ts` owns the heightfield and everything derived from it, and
is the module the whole rest of the project asks about the ground:

- `heights: Int32Array` — Q16.16, `(width + 1) × (height + 1)` corner samples
- `heightAt(x, z)` — bilinear sample within a cell, using the fixed diagonal
  split so it agrees exactly with the mesh and the picker
- `cellSlope(cell)` — the cell's steepest rise over run, as a squared rational
  so the common comparison needs no square root
- `cellNormal(cell)` — fixed-point normal, for slope-aware costs and for the
  sim's line-of-sight sweep
- `isTraversable(cell)` — `cellSlope <= MAX_TRAVERSABLE_SLOPE` and `WALKABLE`

`src/sim/world.ts` holds a `World`:

- `width`, `height` in cells, `cellSize` in fixed-point world units
- `heights` as above
- `flags: Uint8Array` — bitfield: `WALKABLE`, `BUILDABLE`, `VISION_BLOCKER`
  (there is no `RAMP` flag any more; a ramp is a shape, not a marking)
- `resourceNodes: { cell, type, amount }[]`
- `startLocations: { cell }[]`

Plus helper accessors (`cellIndex`, `cellFromWorld`, `worldFromCell`) and a
`validate()` that reports unreachable start locations and regions of passable
ground that no unit can get to.

Match state gains a **height override layer**: a sparse map of cell corner to
height, empty at match start, written only by the simulation (M26 levels a
building footprint into it). `heightAt` takes the match's overrides into account
when one is passed, and reads the authored heightfield when it is not. This is
invariant 5 made concrete.

Include a hand-authored 128×128 test map as a fixture: a central basin, two
raised plateaus reachable by sculpted slopes, one ridge too steep to climb,
four resource clusters, two start locations.

**Done when:** the fixture loads, `validate()` passes on it, `heightAt` agrees
with the corner data at corners and interpolates between them, `cellSlope`
identifies the steep ridge as impassable and the sculpted slopes as passable,
and tests cover bounds handling at map edges.

## M5. Babylon bootstrap and RTS camera

`src/render/`. Engine, scene, a directional light, a flat ground plane. Camera
at a fixed pitch (start at 55°) with:

- WASD and arrow-key pan
- Screen-edge pan when the pointer is within 8px of an edge and the window has
  focus
- Middle-drag pan
- Wheel zoom clamped to a min/max height
- Pan bounds clamped so the camera cannot leave the map

**Done when:** the camera moves smoothly at 60fps, cannot escape the map, and
zoom does not fight pan. Babylon's Inspector is reachable behind a dev-only
keybind.

## M6. Heightfield mesh

`src/render/terrain.ts`. Generate geometry from the heightfield:

- Two triangles per cell, on the same fixed diagonal the sim uses
- **Smooth vertex normals** averaged from adjacent faces — this is what makes
  continuous terrain read as landscape rather than as low-poly facets, and it
  is the visual difference from the tiered model
- Chunk the mesh into 32×32-cell blocks so edits later rebuild one chunk rather
  than the world. Chunk seams share corner heights, so they cannot crack; the
  *normals* at a seam still need the neighbouring chunk's heights, or a visible
  lighting seam appears where none should be
- Emit UVs suitable for a tiling texture and a second UV channel addressing the
  whole map (needed for the fog texture in M23)
- A skirt around the map edge so the horizon is not an open hole

**Done when:** the M4 fixture renders as readable landscape — hills read as
hills, the steep ridge reads as a cliff — at or under 8 draw calls for terrain,
a chunk can be rebuilt in isolation, and there is no visible lighting seam
between chunks.

## M7. Terrain picking

`src/render/pick.ts`. The tiered version could intersect a handful of flat
planes. A heightfield cannot, so: march the camera ray across the grid with a
DDA, and for each cell the ray crosses, test its two triangles. The first hit
wins, and the march stops there.

Do not raycast the terrain mesh. A DDA visits a few dozen cells for a screen-
centre ray and is bounded by the map size in the worst case, where mesh picking
costs a full acceleration-structure traversal over hundreds of thousands of
triangles.

Add a dev overlay showing hovered cell index, height, slope and flags.

**Done when:** hovering reports the correct cell and a height that matches
`heightAt` at that point, across flat ground, slopes and the steep ridge,
including at grazing camera angles where a ray crosses many cells. The overlay
updates at frame rate with no measurable cost.

---

# Phase 2 — The Editor

Built early and deliberately: you need maps before you need units, and this is
also the debugging tool for everything that follows.

## M8. Editor shell

`src/editor/`. A DOM overlay on the canvas — panels, tool palette, status bar.
Loaded via dynamic `import()` so it is code-split out of the game bundle. Route
or keybind toggles between Game and Editor mode.

**Done when:** the editor UI appears and disappears cleanly, the editor chunk is
absent from the initial bundle (verify with `rollup-plugin-visualizer`), and
toggling modes does not leak listeners.

## M9. Editor command queue with undo/redo

`src/editor/commands.ts`. An `EditorCommand` interface with `apply(world)` and
`invert(world)`. A history stack with undo, redo, and coalescing for continuous
drags (one brush stroke is one undo entry, not four hundred).

A sculpt stroke touches many corner heights many times. The command records
each corner's height **once, when the stroke first touches it**, and the final
height when the stroke ends. Anything else either loses the original height or
stores four hundred copies of it.

**Done when:** a scripted sequence of 100 commands, fully undone, restores a
world byte-identical to the original by hash. Redo restores the mutated state
identically.

## M10. Sculpting tools

The heart of the editor, and the milestone that most replaces its tiered
predecessor. A brush with an adjustable radius and falloff curve, and these
modes:

- **Raise / lower** — add or subtract height, scaled by the falloff
- **Smooth** — pull each corner toward the average of its neighbours
- **Flatten** — pull toward the height sampled when the stroke began, which is
  how you make a buildable plateau
- **Ramp** — drag a line; corners near it are pulled toward the linear
  interpolation between the drag's two ends. This is the only "ramp tool" the
  game needs, and what it produces is ordinary ground that happens to be
  walkable
- **Noise** — seeded fractal displacement, for making ground that does not look
  extruded

All of it clamps to `HEIGHT_MIN`/`HEIGHT_MAX` and rebuilds only the affected
terrain chunks, plus the one-cell margin their normals depend on.

**Done when:** sculpting at 60fps on a 256×256 map, a raise stroke followed by
a smooth stroke produces terrain with no visible faceting, the ramp tool
produces a slope the M18 nav grid agrees is traversable, chunk seams stay
seamless and unlit-seam-free, and undo restores both data and mesh.

## M11. Flag tools and terrain overlays

Brushes for the `BUILDABLE` and `VISION_BLOCKER` flags, each with a toggleable
debug overlay colouring affected cells.

Plus the overlay that matters most for this terrain model: a **slope overlay**
that shades every cell by its traversability — passable, near the limit,
cliff. Sculpted terrain has no tier boundary to look at, so without this the
editor gives you no way to see where the edge of walkable actually is, and you
find out by watching a unit refuse to move.

**Done when:** painting `VISION_BLOCKER` shows in its overlay; the slope overlay
marks the fixture's steep ridge as cliff and its sculpted slopes as passable,
and updates live as you sculpt.

## M12. Map save and load

Versioned binary format: header (magic, version, dimensions), then raw typed
array blocks, then a JSON tail for resource nodes and start locations. Saving
is close to a memcpy.

The heightfield is `(w+1) × (h+1)` `Int32` values — four bytes a corner where
the tiered format used one byte a cell. A 512×512 map is about a megabyte of
heights. That is fine uncompressed, and the format should not get clever about
it before there is a reason.

- Primary: File System Access API (`showSaveFilePicker`)
- Fallback: Blob download and `<input type="file">`
- Autosave to IndexedDB every 30 seconds, offered on next load

**Done when:** a map round-trips through save and load with an identical hash,
the fallback path works in a browser without File System Access, and a
version-mismatched file is rejected with a clear message.

## M13. Resource nodes and start locations

Placement tools with snapping, a validation pass flagging start locations that
are too close together, unreachable, or on ground too steep to build a base on,
and distinct editor-only gizmos.

**Done when:** the M4 fixture can be fully reauthored from a flat map using
only the editor, saved, reloaded, and rendered identically.

> **Checkpoint.** At this point you can sculpt landscape in the browser and
> walk a camera over it. This is the first genuinely demonstrable artifact.
> Record a short capture before moving on.

---

# Phase 3 — Simulation Core

## M14. Entity storage

`src/sim/match.ts`. Structure-of-arrays over typed arrays with a free-list
allocator and generational handles (`index | generation << 20`) so stale
references are detectable.

Per-unit arrays: `posX`, `posZ` (fixed), `velX`, `velZ`, `hp`, `maxHp`,
`typeId`, `ownerId`, `state`, `targetHandle`, `cooldown`, `facing`.

There is deliberately no `posY`. A unit's height is `heightAt(posX, posZ)`,
sampled when something needs it. Storing it would mean maintaining it, and
maintaining it would mean a second source of truth about where the ground is.

Unit type definitions live in a separate data table loaded from JSON:
`speed`, `hp`, `sightRadius`, `attackRange`, `damage`, `cooldown`, `radius`.

**Done when:** 10,000 spawns and despawns leave no fragmentation, handles to
dead units resolve to null, and the whole store serializes into the determinism
hash.

## M15. Fixed-tick loop

`src/sim/tick.ts` plus a driver in the app shell. Accumulator-based stepping at
20Hz, decoupled from `requestAnimationFrame`. Expose an interpolation alpha for
rendering. Cap catch-up at 5 ticks to avoid spiral-of-death.

Match init builds match state from world state. Match teardown discards match
state, leaving world state untouched — including the height override layer,
which is why levelling ground for a building cannot leak into the map.

**Done when:** the sim runs at a constant 20 ticks per second regardless of
render framerate (verify at 30fps and 144fps), and Test/Stop in the editor
starts and ends a match leaving the world hash unchanged.

## M16. Instanced unit rendering

`src/render/units.ts`. One Babylon thin-instance buffer per unit type. Each
frame, write instance matrices from interpolated sim positions, with height
sampled from the terrain so units sit on the ground. Use placeholder geometry: a
box hull and a smaller box turret, two separate instance buffers per type so the
turret can rotate independently. No skinning anywhere.

Units on a slope should **tilt to the terrain normal**. On tiered terrain every
unit stood on a level surface and this question never arose; on sculpted terrain
an untilted unit on a hillside is immediately, obviously wrong. Blend the
normal over a few ticks or a unit crossing a ridge snaps.

**Done when:** 2,000 units render at 60fps in under 15 draw calls total, motion
between ticks is visibly smooth rather than stepped, and units driving over a
ridge lean into it rather than intersecting it.

## M17. Selection

- Drag box: project unit positions to screen space on the CPU from the typed
  arrays, test against the rect. Do not raycast.
- Click select, shift-add, ctrl-click and double-click for select-all-of-type
  on screen
- Control groups 0–9, with set, add, and recall
- Selection rendered as an instanced ground decal ring. On sculpted terrain a
  flat ring intersects the hillside it is drawn on, so either project the ring
  onto the surface or lift and tilt it to the local normal

**Done when:** box-selecting 500 units costs under 1ms, selection survives unit
death without dangling handles, control groups behave like SC2, and selection
rings on a slope sit on the ground rather than through it.

---

# Phase 4 — Movement

## M18. Navigation grid

`src/nav/grid.ts`. Build a connectivity graph from world state. This is where
the terrain model has its largest effect on gameplay:

- A cell is passable if it is `WALKABLE`, unoccupied, and its slope is at or
  below `MAX_TRAVERSABLE_SLOPE`
- Two cells are neighbours if both are passable **and the slope of the step
  between them** is within the limit. A cell can be flat and its neighbour flat
  while the step between them is a cliff face; checking only the cells would
  let units walk off ledges
- Movement cost rises with the slope of the step, so paths prefer flat ground
  and curve around hills without being told to
- Diagonals additionally require both orthogonal neighbours to be passable, so
  units cannot clip the corner of a cliff

Produce a compact cost grid as a transferable `Uint8Array`. Rebuild
incrementally when the editor sculpts, or when a match levels ground.

**Done when:** a path cannot cross the fixture's steep ridge but can climb its
sculpted slopes, verified by tests; a path between two points on opposite sides
of a hill goes around it when going around is cheaper; and a terrain edit
rebuilds only affected regions.

## M19. Flow field pathfinder in a worker

`src/nav/worker.ts`. Protocol: main thread posts `{ requestId, goalCell,
costGridVersion }`, worker returns a transferable `Int8Array` of flow directions
plus the integration field. Coalesce concurrent requests for the same goal.
Cache the last N fields keyed by goal.

Brushfire integration from the goal, then one pass deriving direction per cell.
Slope-weighted costs mean the integration is a weighted flood rather than a
uniform one, so use a bucket queue sized from the grid's actual cost range.

**Done when:** a field for a 256×256 map solves in under 15ms off the main
thread, the main thread never blocks, and identical inputs produce identical
fields (it feeds the determinism hash).

## M20. Steering and local avoidance

Units sample the flow field, apply separation against neighbours found via a
uniform spatial hash, clamp to max speed, and arrive without oscillating.
Formation spread at the destination so 50 units do not stack on one cell.

Two things the heightfield adds:

- **A step is rejected if the slope between the unit's cell and its next cell
  exceeds the limit**, the same rule the nav grid uses. Separation can shove a
  unit sideways into a cliff face, and the nav grid does not get a say in that;
  this check is what makes walking off a ledge impossible rather than unlikely
- **Speed scales with slope** — slower uphill, a little faster downhill, within
  clamps. Cheap, entirely deterministic, and it is most of what makes an army
  crossing a ridge look like it is crossing a ridge

**Done when:** 200 units ordered across a map with two chokepoints arrive
without permanent deadlock, without jitter at rest, and without ending up on
ground the nav grid calls impassable.

## M21. Order dispatch

Right-click resolves what is under the cursor and dispatches by priority: enemy
unit → attack, resource node → gather, friendly transport → load, ground → move.
Shift queues orders. Orders are commands applied at tick boundaries.

**Done when:** clicking around feels responsive at 20Hz sim rate with render
interpolation, and a queued sequence of five move orders executes in sequence.

> **Checkpoint.** This is a playable toy: sculpt a map, spawn units, click them
> around real landscape with hills and cliffs. Record a capture.

---

# Phase 5 — Vision

## M22. Fog of war simulation

`src/sim/fog.ts`. Per player: `visible: Uint8Array` and `explored: Uint8Array`
at cell resolution. Recompute `visible` from scratch every 4 ticks.

With tiers this was a disc stamp plus a one-line height comparison. With a
heightfield it is a **radial horizon sweep**, which is the part of this plan
that gains the most real cost and the most real gameplay:

```
for each ray from the unit, at a fixed set of angles:
    horizon = -infinity                      # greatest elevation angle so far
    walk outward along the ray, cell by cell:
        angle = (heightAt(cell) - eyeHeight) / distance
        if angle >= horizon:
            visible[cell] = 255              # it rises above everything nearer
            horizon = angle
        # else it is in the shadow of something closer, and stays dark
```

Ray angles and step offsets are precomputed per sight radius, exactly as the
disc offsets were. Elevation angles are compared as fixed-point rationals —
cross-multiplied, never divided — so the sweep needs no division and no
square root in its inner loop.

Cells flagged `VISION_BLOCKER` are opaque: they are revealed, and they raise the
horizon behind them. `explored` is OR-accumulated and never cleared.

This lives in the sim because it gates targeting and ability range. All players'
grids are computed; only the local player's is uploaded to the GPU.

**Done when:** a unit on a hilltop sees over the terrain around it and a unit in
a valley does not see out of it; a ridge casts a visible shadow that units
behind it hide in; 200 units at radius 9 update in under 6ms — a larger budget
than the tiered model's 2ms, because a horizon sweep is genuinely more work than
a disc stamp, and pretending otherwise would mean cutting the ray count until
the shadows look wrong — and the fog grids are part of the determinism hash.

## M23. Fog rendering

Upload the local player's grids as a single RG8 texture (R = visible,
G = explored) with `LINEAR` filtering. Sample in the terrain shader: full
brightness on visible, dimmed on explored-only, black otherwise. Blur slightly
in the shader for soft edges.

Units skip rendering entirely when their cell is not visible. Buildings need a
per-player "last seen" snapshot list so enemy structures persist in explored
fog at their last known state.

**Done when:** fog reads like a modern C&C at normal zoom, terrain shadows from
the M22 sweep are visible as unlit pockets behind ridges, enemy units vanish at
the fog boundary, a scouted enemy building remains visible in fog after the
scout dies, and texture upload costs under 0.5ms.

---

# Phase 6 — Gameplay

## M24. Combat

Attack orders, target acquisition within range, range and target validity gated
by the vision grid, cooldowns in ticks, damage application, death and corpse
handling. Both hitscan and travelling projectiles as separate sim entities.

Range is measured in 2D. Terrain affects what you can *see*, which already
gates what you can shoot; adding a second, three-dimensional range rule on top
buys very little and costs a square root per check.

**Done when:** a unit cannot attack a target it cannot see, two groups fight to
a deterministic conclusion reproducible from the same seed, and the fight is in
the determinism harness.

## M25. Resources and workers

Gather loop: move to node, harvest over N ticks, return to nearest drop-off,
deposit, repeat. Node depletion. Per-player resource counters. Worker saturation
behaviour when multiple workers target one node.

**Done when:** eight workers on four nodes sustain a stable income rate, and
resource counts are identical across two runs of the same seed.

## M26. Buildings and production

Placement validation against `BUILDABLE` flags, footprint collision, and — new
with this terrain model — **maximum slope across the footprint**. Ground gentle
enough to build on is now something a player has to find or make.

On placement, the footprint is **levelled into the match's height override
layer**, not into the world. This is what makes the invariant-5 split earn its
keep: a base flattens the hillside it sits on for the duration of the match, the
map file never changes, and the same map replays identically.

Construction progress. Production queues with rally points. Buildings occupy
nav-grid cells and trigger an incremental cost grid rebuild — which now must
also account for the levelling, since flattening ground changes what is
traversable around the site.

**Done when:** a building cannot be placed on a slope above `MAX_BUILD_SLOPE`,
placing one on gentle ground levels its footprint and the terrain mesh shows it,
the building blocks pathing the tick it completes, units produced from it walk
to the rally point, a blocked rally path is handled gracefully, and stopping the
match restores the terrain exactly.

## M27. Command card and minimap

DOM overlay HUD: selection portrait group, context-sensitive command card with
hotkeys, resource readout, production queue display. Minimap rendering terrain,
fog, units as coloured dots, and the camera viewport rect — click and drag to
move the camera.

Minimap terrain is shaded by height and slope rather than by tier colour, which
is what makes a continuous map legible at a glance: hillsides read as hillsides.

**Done when:** the game is playable with keyboard and mouse without touching a
debug overlay, and minimap rendering costs under 1ms.

---

# Phase 7 — Art Integration

The existing asset collection comes in here. Everything before this used
placeholder boxes deliberately, so this phase is a swap rather than a rewrite.

## M28. Asset pipeline

`tools/`. A script converting source assets to glTF with meshopt compression.
Document and enforce the rigid-part unit convention: each unit is a hull mesh
plus optionally a turret mesh with a named attach point, no skinned meshes.
Produce an asset manifest JSON consumed by the loader. Add a loading screen with
real progress.

**Done when:** one real asset from the collection converts, loads, renders on an
instanced unit, and the total asset payload is reported at build time against a
stated budget.

## M29. Full asset swap and terrain texturing

Replace placeholder geometry for all unit and building types. Turret rotation
toward targets, muzzle flash effects, ground shadow decals (one instanced quad
per unit, no cascaded shadow maps), doodad placement in the editor.

Terrain texturing is a larger job than it was with tiers, and is most of this
milestone. There are no cliff faces to texture separately any more, so:

- **Splat map**: four terrain materials blended per-vertex or through a weight
  texture, painted with an editor brush
- **Slope-based blending**: rock where the ground is steep, grass where it is
  flat, blended over a band rather than switched at a threshold. This is what
  makes sculpted terrain look deliberate rather than stretched
- **Triplanar projection on steep ground**, or cliffs show obvious UV stretching
  — the characteristic artefact of heightfield terrain, and the reason
  projected texturing exists

**Done when:** the game looks like a game, a sculpted cliff shows rock rather
than stretched grass, frame time is unchanged from M16 within 20%, and total
download stays under the stated budget.

> **Budget note.** GitHub Pages allows a 1GB published site and 100GB/month of
> soft bandwidth. A 40MB build means roughly 2,500 plays per month before that
> becomes a conversation. Track payload size in CI and fail the build above the
> budget.

---

# Phase 8 — Multiplayer

## M30. Replay system

Record the command stream plus the initial seed and map hash. Playback re-runs
the sim from the commands alone. Add a state-hash checkpoint every 100 ticks;
a mismatch during playback reports the exact tick of divergence.

The map hash must cover the heightfield. A replay recorded on a map whose
terrain was sculpted since is not a replay of anything.

**Done when:** a five-minute recorded match replays to an identical final hash,
and playback supports pause, speed control, and free camera.

> Do this before netcode. It is 90% of the lockstep machinery, it is testable
> entirely offline, and it turns future desyncs from mysteries into bug reports
> with a tick number attached.

## M31. Lockstep netcode

`src/net/`. A Cloudflare Durable Object per match relaying commands over
WebSocket. Turn scheduling with ~100ms input delay (two ticks at 20Hz). Clients
buffer local commands, send them tagged with the target tick, and step only when
all players' commands for that tick have arrived. State hash exchanged every 100
ticks; divergence halts the match with a diagnostic.

Lobby and matchmaking as a separate Durable Object.

**Done when:** two browsers play a full match to completion without desync,
a deliberately introduced float in a sim path is caught by hash comparison, and
a dropped connection is handled without hanging the other client.

---

# Phase 9 — Depth

## M32. Skirmish AI

A bot that builds workers, expands, produces an army, and attacks. Runs inside
the sim as a command source, so it is deterministic and replay-compatible.

It needs one thing the tiered model gave for free: somewhere flat to build. Have
it evaluate candidate sites by slope across the footprint rather than assuming
any walkable cell will do.

**Done when:** the bot plays a complete match without stalling, and a bot-vs-bot
match is fully reproducible from its seed.

## M33. Performance pass

Profile against a stress map: 1,000 units, active combat, full fog updates.
Address whatever dominates. With this terrain model the likely candidates, in
order: the fog horizon sweep, instance buffer writes, flow field request churn,
spatial hash rebuild.

If unit animation beyond rigid parts is wanted, add vertex animation textures
here — bake clips to a position texture in Blender, sample in the vertex shader
with a per-instance time offset. Not before.

**Done when:** the stress map holds 60fps on mid-range hardware, sim tick time
stays under 8ms, and a documented performance baseline is committed for
regression comparison.

---

## Migration from the tiered build

If a build already implements the tiered model, these are the milestones whose
work is genuinely redone rather than extended. Everything not listed is
unaffected.

| Milestone | What changes |
|---|---|
| M4 | `tier: Uint8Array` → corner `heights: Int32Array`; `RAMP` flag removed; new `src/sim/terrain.ts`; match-owned height override layer; fixture resculpted |
| M6 | Flat quads + cliff walls + ramp geometry → one heightfield surface with smooth normals |
| M7 | Tier-plane intersection → DDA ray march over cells |
| M10 | Tier painting with cascade repair → sculpt brushes (raise, lower, smooth, flatten, ramp, noise) |
| M11 | Ramp placement tool removed entirely; slope overlay added |
| M12 | Format version bump: 1 byte per cell → 4 bytes per corner |
| M16 | Units gain terrain-normal tilt |
| M17 | Selection decals must follow the surface |
| M18 | Tier connectivity + ramp bridging → slope thresholds on both cells and the step between them; slope-weighted costs |
| M20 | Step rejection by slope; speed scales with slope |
| M22 | Disc stamp + high-ground rule → radial horizon sweep; budget rises from 2ms to 6ms |
| M26 | Footprint slope check; footprint levelling into the override layer |
| M29 | Cliff-wall materials → splat maps, slope blending, triplanar projection |

Two things are worth doing in this order specifically: **M4 and M18 before
anything else**, because the nav grid is what tells you whether your terrain
model is coherent; and **M22 after M18**, because the horizon sweep and the
slope rules should agree about what a cliff is.

The determinism golden hash changes at M4 and again at every milestone in this
table that touches sim state. That is expected and deliberate — regenerate it
with the milestone that causes it, and say so in the commit.

---

## Working Notes for the Agent

- **One milestone per branch, one PR per milestone.** The PR description states
  which acceptance criteria are met and how they were verified.
- **Extend the determinism harness in every sim milestone.** New systems get
  added to the scripted command list and the golden hash regenerated
  deliberately, never silently.
- **When a milestone is ambiguous, prefer the simpler implementation and note
  the tradeoff** in the PR rather than inventing scope.
- **Do not add a dependency without stating what it replaces.** The stack above
  is deliberately small.
- **Do not skip ahead to art.** Placeholder boxes through Phase 6 are
  intentional; they keep rendering cost and asset churn out of the way while the
  systems that are hard to change are being built.
- **Height is fixed-point.** The most likely way this project acquires a desync
  is someone writing `height * 0.5` in a slope calculation because the
  heightfield felt like a float. The lint rule catches it inside `src/sim/`;
  nothing catches it in `src/nav/` unless that rule is extended there too.
