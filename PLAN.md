# Browser RTS — Build Plan

A 3D real-time strategy game running in the browser. TypeScript, deterministic
lockstep simulation, SC2-style discrete cliff terrain, fog of war with
high-ground vision, and an in-game map editor.

This document is written for a coding agent. Each milestone is atomic,
independently verifiable, and ends with something demonstrable. Work them in
order unless a milestone explicitly says otherwise.

---

## Architecture Invariants

These rules hold for the entire project. Breaking one is a bug even if tests
pass. Re-read this section before starting any milestone.

1. **The simulation is 2D.** Units have `x` and `z`. Terrain height is a
   per-cell tier index used for pathing connectivity and vision, never a
   continuous value the sim integrates over. Y coordinates exist only in the
   renderer.

2. **The simulation is deterministic.** All sim arithmetic is fixed-point
   Q16.16 over `Int32Array`. Inside `src/sim/**` the following are banned and
   enforced by lint rule: `Math.random`, `Math.sin`, `Math.cos`, `Math.tan`,
   `Math.pow`, `Math.exp`, `Math.log`, `Date.now`, `performance.now`, and all
   float literals. Randomness comes from the seeded PRNG only. Trig comes from
   the lookup tables only.

3. **The simulation never imports the renderer.** `src/sim/**` must not import
   from `src/render/**`, `babylonjs`, or any DOM API. Enforced by lint rule.
   The renderer reads sim state; it never writes to it.

4. **World state and match state are separate.**
   - *World state*: tiers, walkability flags, ramps, doodads, resource node
     positions, start locations. Authored by the editor, saved to disk.
   - *Match state*: units, buildings, fog grids, player resources, projectiles.
     Generated from world state at match init, discarded at match end.

   The editor mutates world state only. The simulation mutates match state
   only. Nothing writes across the line. This makes the editor's Test/Stop
   toggle nearly free and keeps map files stable.

5. **All mutations flow through commands.** Both the editor and the game apply
   changes as discrete command objects at tick boundaries. This single decision
   gives undo/redo, replays, and lockstep netcode for almost no extra work.

6. **No `SharedArrayBuffer`.** The game ships on GitHub Pages, which cannot send
   COOP/COEP headers, so `crossOriginIsolated` is always false. Worker
   communication uses `postMessage` with transferable `ArrayBuffer`s. Do not
   add the `coi-serviceworker` workaround.

7. **Every milestone ends green.** Typecheck passes, tests pass, `pnpm build`
   succeeds, and the deployed Pages build loads without console errors. Do not
   start the next milestone otherwise.

---

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, `strict: true` | `noUncheckedIndexedAccess` on |
| Build | Vite | `base` must match the Pages path |
| Package manager | pnpm | |
| Renderer | Babylon.js | Thin instances, runtime Inspector |
| Entities | Hand-rolled SoA over typed arrays | See M13 |
| Tests | Vitest | |
| Hosting | GitHub Pages via Actions | See M0 |
| Netcode (later) | Cloudflare Durable Objects | See M30 |

Babylon is isolated behind `src/render/`. If it is ever swapped for Three.js,
nothing outside that directory should change.

## Directory Layout

```
src/
  sim/            deterministic simulation — no DOM, no Babylon, no floats
    fixed.ts      Q16.16 arithmetic
    rand.ts       seeded PRNG
    world.ts      world state (terrain, authored data)
    match.ts      match state (units, fog, resources)
    commands.ts   command definitions and application
    tick.ts       the fixed-step loop body
  nav/            pathfinding — runs in a worker
    worker.ts
    flowfield.ts
  render/         Babylon — reads sim, never writes
  editor/         DOM overlay, dynamically imported
  ui/             in-game HUD, DOM overlay
  net/            lockstep transport (added at M30)
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
`no-restricted-globals` config) enforcing invariants 2 and 3.

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
golden table committed to the repo. Property test: `mul(a, div(b, a))` is within
one ULP of `b` across a few thousand seeded pairs.

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

## M4. World state

`src/sim/world.ts`. A `World` holding:

- `width`, `height` in cells, `cellSize` in fixed-point world units
- `tier: Uint8Array` — discrete cliff level, 0..3
- `flags: Uint8Array` — bitfield: `WALKABLE`, `BUILDABLE`, `RAMP`,
  `VISION_BLOCKER`
- `resourceNodes: { cell, type, amount }[]`
- `startLocations: { cell }[]`

Plus helper accessors (`tierAt`, `flagsAt`, `cellIndex`, `cellFromWorld`) and a
`validate()` that reports unreachable start locations and orphaned tiers.

Include a hand-authored 64×64 test map as a fixture: three tiers, two ramps,
four resource clusters, two start locations.

**Done when:** the fixture loads, `validate()` passes on it, and tests cover
bounds handling at map edges.

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

## M6. Terrain mesh from world state

`src/render/terrain.ts`. Generate geometry from `World`:

- One flat quad surface per tier region, at `tierHeight * tier`
- Vertical cliff wall quads at every tier boundary
- Ramp geometry as sloped quads connecting adjacent tiers

Chunk the mesh into 32×32-cell blocks so edits later rebuild one chunk rather
than the world. Emit UVs suitable for a tiling texture and a second UV channel
addressing the whole map (needed for the fog texture in M22).

**Done when:** the M4 fixture renders with clearly readable cliffs and walkable
ramps, at or under 8 draw calls for terrain, and a chunk can be rebuilt in
isolation.

## M7. Cell picking

`src/render/pick.ts`. Given a screen position, intersect the camera ray with
each tier's horizontal plane, keep the nearest hit whose cell actually sits at
that tier. Do not raycast the terrain mesh.

Add a dev overlay showing hovered cell index, tier, and flags.

**Done when:** hovering reports the correct cell across all three tiers,
including near cliff edges, and the overlay updates at frame rate with no
measurable cost.

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

**Done when:** a scripted sequence of 100 commands, fully undone, restores a
world byte-identical to the original by hash. Redo restores the mutated state
identically.

## M10. Tier painting

Brush tool: adjustable radius, raise and lower tier, with automatic cliff-wall
regeneration and incremental rebuild of only the affected terrain chunks.
Enforce that tier changes cannot produce geometrically impossible configurations
(a single cell two tiers above all neighbours).

**Done when:** painting at 60fps on a 256×256 map, cliffs regenerate correctly
including at chunk seams, and undo restores both data and mesh.

## M11. Ramp and flag tools

Ramp placement connecting two adjacent tiers, with validation that both ends are
walkable and the span is legal. Separate brushes for `BUILDABLE` and
`VISION_BLOCKER` flags, each with a toggleable debug overlay colouring affected
cells.

**Done when:** a ramp placed between tiers 1 and 2 is marked walkable, renders
as a slope, and shows in the debug overlay.

## M12. Map save and load

Versioned binary format: header (magic, version, dimensions), then raw typed
array blocks, then a JSON tail for resource nodes and start locations. Saving
is close to a memcpy.

- Primary: File System Access API (`showSaveFilePicker`)
- Fallback: Blob download and `<input type="file">`
- Autosave to IndexedDB every 30 seconds, offered on next load

**Done when:** a map round-trips through save and load with an identical hash,
the fallback path works in a browser without File System Access, and a
version-mismatched file is rejected with a clear message.

## M13. Resource nodes and start locations

Placement tools with snapping, a validation pass flagging start locations that
are too close together or unreachable, and distinct editor-only gizmos.

**Done when:** the M4 fixture can be fully reauthored from an empty map using
only the editor, saved, reloaded, and rendered identically.

> **Checkpoint.** At this point you can author SC2-style maps in the browser
> and walk a camera over them. This is the first genuinely demonstrable
> artifact. Record a short capture before moving on.

---

# Phase 3 — Simulation Core

## M14. Entity storage

`src/sim/match.ts`. Structure-of-arrays over typed arrays with a free-list
allocator and generational handles (`index | generation << 20`) so stale
references are detectable.

Per-unit arrays: `posX`, `posZ` (fixed), `velX`, `velZ`, `hp`, `maxHp`,
`typeId`, `ownerId`, `state`, `targetHandle`, `cooldown`, `facing`.

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
state, leaving world state untouched.

**Done when:** the sim runs at a constant 20 ticks per second regardless of
render framerate (verify at 30fps and 144fps), and Test/Stop in the editor
starts and ends a match leaving the world hash unchanged.

## M16. Instanced unit rendering

`src/render/units.ts`. One Babylon thin-instance buffer per unit type. Each
frame, write instance matrices from interpolated sim positions. Use placeholder
geometry: a box hull and a smaller box turret, two separate instance buffers per
type so the turret can rotate independently. No skinning anywhere.

**Done when:** 2,000 units render at 60fps in under 15 draw calls total, and
motion between ticks is visibly smooth rather than stepped.

## M17. Selection

- Drag box: project unit positions to screen space on the CPU from the typed
  arrays, test against the rect. Do not raycast.
- Click select, shift-add, ctrl-click and double-click for select-all-of-type
  on screen
- Control groups 0–9, with set, add, and recall
- Selection rendered as an instanced ground decal ring, not an outline pass

**Done when:** box-selecting 500 units costs under 1ms, selection survives unit
death without dangling handles, and control groups behave like SC2.

---

# Phase 4 — Movement

## M18. Navigation grid

`src/nav/grid.ts`. Build a connectivity graph from world state: cells are
neighbours only if same tier, or if one is a `RAMP` bridging the two. Produce a
compact cost grid as a transferable `Uint8Array`. Rebuild incrementally when the
editor edits terrain.

**Done when:** a path cannot cross a cliff except via a ramp, verified by tests
on the fixture map, and a terrain edit rebuilds only affected regions.

## M19. Flow field pathfinder in a worker

`src/nav/worker.ts`. Protocol: main thread posts `{ requestId, goalCell,
costGridVersion }`, worker returns a transferable `Int8Array` of flow directions
plus the integration field. Coalesce concurrent requests for the same goal.
Cache the last N fields keyed by goal.

Brushfire integration from the goal, then one pass deriving direction per cell.

**Done when:** a field for a 256×256 map solves in under 15ms off the main
thread, the main thread never blocks, and identical inputs produce identical
fields (it feeds the determinism hash).

## M20. Steering and local avoidance

Units sample the flow field, apply separation against neighbours found via a
uniform spatial hash, clamp to max speed, and arrive without oscillating.
Formation spread at the destination so 50 units do not stack on one cell.

**Done when:** 200 units ordered across a map with two chokepoints arrive
without permanent deadlock, without jitter at rest, and without passing through
cliffs.

## M21. Order dispatch

Right-click resolves what is under the cursor and dispatches by priority: enemy
unit → attack, resource node → gather, friendly transport → load, ground → move.
Shift queues orders. Orders are commands applied at tick boundaries.

**Done when:** clicking around feels responsive at 20Hz sim rate with render
interpolation, and a queued sequence of five move orders executes in sequence.

> **Checkpoint.** This is a playable toy: author a map, spawn units, click them
> around real terrain with cliffs and ramps. Record a capture.

---

# Phase 5 — Vision

## M22. Fog of war simulation

`src/sim/fog.ts`. Per player: `visible: Uint8Array` and `explored: Uint8Array`
at cell resolution. Recompute `visible` from scratch every 4 ticks — clear, then
for each unit stamp a precomputed circular offset table for its sight radius.

The high-ground rule, inside the stamp loop:

```ts
if (tier[cell] <= tier[unitCell]) visible[cell] = 255;
```

Cells flagged `VISION_BLOCKER` reject the write. `explored` is OR-accumulated
and never cleared.

This lives in the sim because it gates targeting and ability range. All players'
grids are computed; only the local player's is uploaded to the GPU.

**Done when:** a unit on tier 2 sees down a cliff but a unit on tier 1 cannot
see up, 200 units at radius 9 update in under 2ms, and the fog grids are part of
the determinism hash.

## M23. Fog rendering

Upload the local player's grids as a single RG8 texture (R = visible,
G = explored) with `LINEAR` filtering. Sample in the terrain shader: full
brightness on visible, dimmed on explored-only, black otherwise. Blur slightly
in the shader for soft edges.

Units skip rendering entirely when their cell is not visible. Buildings need a
per-player "last seen" snapshot list so enemy structures persist in explored
fog at their last known state.

**Done when:** fog reads like SC2 at normal zoom, enemy units vanish at the fog
boundary, a scouted enemy building remains visible in fog after the scout dies,
and texture upload costs under 0.5ms.

---

# Phase 6 — Gameplay

## M24. Combat

Attack orders, target acquisition within range, range and target validity gated
by the vision grid, cooldowns in ticks, damage application, death and corpse
handling. Both hitscan and travelling projectiles as separate sim entities.

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

Placement validation against `BUILDABLE` flags and footprint collision.
Construction progress. Production queues with rally points. Buildings occupy
nav-grid cells and trigger an incremental cost grid rebuild.

**Done when:** a building blocks pathing the tick it completes, units produced
from it walk to the rally point, and a blocked rally path is handled gracefully.

## M27. Command card and minimap

DOM overlay HUD: selection portrait group, context-sensitive command card with
hotkeys, resource readout, production queue display. Minimap rendering terrain,
fog, units as coloured dots, and the camera viewport rect — click and drag to
move the camera.

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

## M29. Full asset swap

Replace placeholder geometry for all unit and building types. Turret rotation
toward targets, muzzle flash effects, ground shadow decals (one instanced quad
per unit, no cascaded shadow maps), terrain texturing, cliff wall materials,
doodad placement in the editor.

**Done when:** the game looks like a game, frame time is unchanged from M16
within 20%, and total download stays under the stated budget.

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

**Done when:** the bot plays a complete match without stalling, and a bot-vs-bot
match is fully reproducible from its seed.

## M33. Performance pass

Profile against a stress map: 1,000 units, active combat, full fog updates.
Address whatever dominates. Likely candidates in order: instance buffer writes,
spatial hash rebuild, flow field request churn.

If unit animation beyond rigid parts is wanted, add vertex animation textures
here — bake clips to a position texture in Blender, sample in the vertex shader
with a per-instance time offset. Not before.

**Done when:** the stress map holds 60fps on mid-range hardware, sim tick time
stays under 8ms, and a documented performance baseline is committed for
regression comparison.

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
