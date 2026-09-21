# Generals Content Pack — Build Plan

A small RTS built on this engine, using art and audio from a local installation
of *Command & Conquer: Generals* (or *Zero Hour*). **Personal use only. Nothing
derived from the game is ever committed or published.**

This document is written for a coding agent, in the same style as the root
[PLAN.md](../PLAN.md), and assumes its Architecture Invariants still hold. Every
milestone here is atomic and ends with something you can look at.

---

## What this is, and what it is not

The root plan parks M28 (asset pipeline) and M29 (full asset swap and terrain
texturing) as **blocked on an asset collection that is not in the repository**.
This plan supplies one, from a game you already own, and adds a small playable
ruleset on top of it.

It is not a Generals clone and not a remaster. The target is roughly:

- **Two factions**, around **eight vehicle types** and **six structures**
- **Two maps**, authored in this project's own editor
- Enough rules to make a twenty-minute skirmish against the existing bot

### The two factions

**NATO** and the **Eastern Axis**, and everything in them is named after the
real vehicle it most resembles rather than after its Generals original. A
Crusader is an *M1A2 Abrams*; a Humvee is an *HMMWV*; a Battlemaster is a
*T-54*. This is not only flavour — it decides what the game is about, and
"Crusader versus Scorpion" says nothing while "Abrams versus T-72" says quite a
lot.

The Eastern Axis deliberately mixes the game's China and GLA art. Soviet-pattern
armour fights alongside improvised technicals, which is what a modern war
between a conventional army and a partly-improvised one actually looks like —
Ukraine being the obvious reference. The GLA models are what make that
possible: a pickup with a ZU-23-2 bolted to the bed is not a Generals fantasy,
it is a photograph.

| Faction | Source art | Reads as |
|---|---|---|
| NATO | the game's USA models | uniform, expensive, few |
| Eastern Axis | the game's China **and** GLA models | mixed, improvised, many |

That asymmetry is the one **G10** should build on: it is already in the art, so
the rules only have to agree with it.

See `manifest/assets.json` for the mapping. Where no real counterpart is close
enough, keep the honest generic — a `VBIED` is a VBIED.

---

## Ground rules

These are not negotiable and the pipeline should enforce them mechanically
rather than relying on anyone remembering.

1. **No game bytes in the repository.** `generals/assets/` and
   `generals/.cache/` are gitignored, and so is every converted artefact. A
   converted W3D mesh is still derived from the original: it does not become
   committable by passing through a converter.
2. **The pipeline reads from your installation, never from the repo.** The
   install path comes from `generals/generals.local.json` (gitignored) or the
   `GENERALS_DIR` environment variable. With neither set, every tool exits with
   a message saying so — it must never half-run against a partial cache.
3. **The build works without the assets.** `pnpm test`, `pnpm lint`,
   `pnpm check:browser` and the determinism harness must all pass on a clean
   clone with no game installed. The content pack is *additive*: when it is
   absent the game runs exactly as it does today, on placeholder boxes.
4. **Nothing is published.** This content pack is excluded from the GitHub Pages
   deploy (`.github/workflows/deploy.yml` builds the base game only). If you
   ever want the deployed build to look different, that needs original art.
5. **`generals/` does not leak into `src/`.** The engine gains *generic*
   extension points — a model registry, a content-pack loader — that know
   nothing about Generals. All Generals-specific code lives here. The test for
   this is mechanical: `grep -rn "from '.*generals" src/` returns nothing — no
   module under `src/` may import from here. (Prose references are fine and one
   already exists: `src/sim/building.ts` cites Generals as the precedent for
   levelling a building's footprint.)

---

## Three decisions worth making up front

### Art from Generals, rules from us

The INI files define every unit's damage, range, cost and speed. It is
tempting to parse them and get a balanced game for free. **Do not.**

- Those numbers would become simulation state, and the determinism harness
  hashes simulation state. Committing them breaks rule 1; gitignoring them
  means the golden hash depends on files CI does not have, and
  `pnpm test:determinism` stops being runnable on a clean clone.
- The engine's `src/sim/data/units.json` already has a format, and the
  simulation is fixed-point — Generals' floats would need conversion and
  rounding decisions anyway.

So: **models, textures, audio and animation come from the game; every number
the simulation reads is authored by you in this project's own format.** The
roster is *inspired by* Generals and named after it locally; the balance is
yours. This also keeps `src/sim/` untouched by this entire plan.

### Vehicles and structures first, infantry later

Root PLAN.md M28 fixes the unit convention: *a hull mesh plus optionally a
turret mesh with a named attach point, **no skinned meshes***. That exists
because the renderer draws units as thin instances, and thin instances plus
skeletons do not mix without per-instance bone data.

Generals vehicles and structures are rigid W3D hierarchies and fit this
convention exactly — a Crusader is a hull and a turret, which is precisely what
the renderer already expects. Generals infantry are skinned and animated, and do
not fit at all.

Take the part that fits. Vehicles and structures are most of Generals' visual
identity anyway, and a tank game is a complete game. Infantry are **G18**,
optional, and need vertex-animation textures rather than skeletons — see that
milestone for why.

### Convert ahead of time, not in the browser

Every conversion happens in `generals/tools/` at author time, writing glTF and
compressed textures into `generals/assets/`. The browser never sees a `.big`,
a `.w3d` or a `.tga`. This keeps the runtime free of parsers for three binary
formats, keeps the payload small, and means a broken asset fails at your desk
rather than in a match.

---

## Layout

```
generals/
  PLAN.md                  this file
  README.md                how to point it at your install
  generals.local.json      your install path            (gitignored)
  .cache/                  extracted raw files          (gitignored)
  assets/                  converted glTF, ktx2, ogg    (gitignored)
  manifest/
    assets.json            which source files we want, by name — committed
    roster.json            our unit stats, our format   — committed
  tools/
    big.ts                 BIG archive reader
    w3d.ts                 W3D parser
    convert.ts             the pipeline entry point
    verify.ts              checks an extraction is complete and sane
  src/
    pack.ts                registers the content pack with the engine
    roster.ts              loads roster.json into engine unit types
    ...
```

`manifest/assets.json` is committed and contains **only file names**, not
content — a list like `"ACVehicle/AVCrusader.w3d"`. That is a reference to a
file on your disk, in the same way a `.gitignore` entry is. It makes the
extraction reproducible and reviewable.

---

## Phase A — Pipeline

### G0. Scaffolding and refusal-to-run

`generals/`, the gitignore entries, `generals.local.json` loading with a clear
error when absent, and a `generals/README.md` stating the personal-use
position. Add `pnpm gen:extract`, `pnpm gen:convert` and `pnpm gen:verify`
scripts that all fail cleanly with no install configured.

**Done when:** a clean clone with no game installed runs `pnpm test`,
`pnpm lint` and `pnpm check:browser` green, and `pnpm gen:convert` exits
non-zero with a message naming the file you need to create.

### G1. BIG archive reader

`generals/tools/big.ts`. Generals ships its content in `.big` archives — an
uncompressed container with a `BIGF` magic, a big-endian file count and total
size, then a table of entries each holding a big-endian offset, a big-endian
length and a NUL-terminated path, then the payload.

Base Generals uses `INI.big`, `W3D.big`, `Textures.big`, `Audio.big`,
`Terrain.big`, `Maps.big`; Zero Hour adds `*ZH.big` equivalents that take
precedence. Detect which is installed and layer Zero Hour over base when both
are present, the way the game does.

> Verify the format against [OpenSAGE](https://github.com/OpenSAGE/OpenSAGE)'s
> parsers rather than trusting this description. It is an open-source
> reimplementation with working readers for every format in this plan, and it
> is the reference to check when a field does not line up. EA released the
> Generals source under GPL in 2025, which is a second reference.

**Done when:** `pnpm gen:extract --list` prints a file count and a sample of
paths from a real installation, and extracting a named TGA produces a file that
opens in an image viewer.

### G2. Asset manifest and selection

`manifest/assets.json`: the explicit list of what this project wants. Not a
glob — an audited list, because "extract everything" is both slow and exactly
the thing rule 1 is about.

Structure it by logical asset, so the converter knows what belongs together:

```json
{
  "vehicles": [
    { "id": "crusader", "hull": "AVCrusader.w3d", "turret": "AVCrusader_turret" }
  ]
}
```

Include a `verify.ts` that reports which manifest entries are missing from the
installation, so a base-Generals-only install gets a clear list rather than a
crash halfway through conversion.

**Done when:** `pnpm gen:verify` reports every manifest entry as found or
missing, and names the archive each one came from.

### G3. Texture conversion

TGA and DDS out, **KTX2 with Basis compression** in — GPU-compressed textures
stay compressed in VRAM, which matters far more than download size once there
are a few hundred units on screen. Babylon loads KTX2 natively.

Build a **texture atlas per faction** while converting. The draw-call budget in
the root plan is the binding constraint here: every distinct material is a draw
call, and instancing only helps within one.

Atlasing is harder than laying the textures side by side, and all three of
these bite:

- **Scale v by the tile's height, not just u by its width.** Textures in one
  model are different sizes — a 32x32 tread strip next to a 256x256 hull — and
  leaving v alone makes the small one sample eight times past its own slot.
- **Tiling UVs cannot be remapped, only baked.** Treads run u from -10 to 9 and
  rely on REPEAT. Squeezed into a slot they wrap across the whole atlas and
  sample another vehicle. Size the slot to the range and repeat the texture
  into it, then clamp the sampler.
- **Sanity-bound the coordinates.** Unset UV slots in the shipped art carry a
  near-FLT_MAX sentinel, which is a perfectly finite float and will stretch a
  slot across the entire atlas.
- **v runs bottom-up in W3D and top-down in the renderer**, so it has to be
  flipped — before the atlas remap, or the slot arithmetic no longer lines up
  with the range the texture is used over.

A warning about how to test any of this: **fix one thing at a time and confirm
it against the texture**, not against a general impression. I A/B'd the v flip
early, while the winding and the atlas were both still wrong, so neither option
looked right, the comparison was meaningless, and I picked the wrong one and
moved on. Crop and magnify a single vehicle and hold it next to its atlas —
`avambulance.tga` is desert tan with red crosses, and anything else is a bug.

**Done when:** one Generals vehicle texture converts, loads in Babylon, and the
converter reports source and output size for each.

### G4. W3D meshes to glTF

`generals/tools/w3d.ts`. W3D is Westwood's chunk format: a `uint32` chunk type,
a `uint32` size whose high bit flags "contains sub-chunks", then the payload.
The chunks that matter here are the mesh (vertices, normals, UVs, triangles,
vertex materials, texture references) and the HLOD/hierarchy that names the
sub-objects — which is where the turret attach point comes from.

Emit glTF with meshopt compression, matching the manifest M28 already specifies.
Map the W3D hierarchy onto this engine's convention: the root mesh becomes the
hull, the node named as the turret becomes the turret, and its transform
becomes the attach point.

**Watch for:** Generals' models are Z-up and in a different scale from
Babylon's Y-up convention, but — and this is the part that cost a long
detour — they are **not** a different handedness. Generals is a DirectX game,
so its data is already left-handed, and an axis map with a determinant of +1
keeps it that way. Do not "convert right-handed glTF to left-handed Babylon"
on the way in; there is nothing to convert.

What does need flipping is the **face winding**, which is opposite to the
renderer's front-face convention. Get that wrong and every surface is
back-facing: with culling on you look straight through a vehicle's roof into
its unlit interior. It does not look like a winding bug. It looks like the
texture failed to load, and it will send you through the texture decoder, the
UV remapper, the atlas and the mipmaps before you think to turn culling off.
Turning back-face culling off for one screenshot is the two-minute test that
settles it; do that first.

**Done when:** one vehicle converts to glTF, loads, and renders on an instanced
unit in place of its placeholder box, at the correct scale and facing.

### G5. The model registry in `src/`

The engine's generic half. `src/render/models.ts`: a registry mapping a unit
type id to a loaded glTF hull and optional turret, falling back to the existing
placeholder box when no model is registered.

This is the only milestone that changes `src/`, and it must stay ignorant of
Generals: it takes a manifest URL and a mapping, and knows nothing about where
the meshes came from. Keep `createUnitRenderer`'s thin-instance path exactly as
it is — swap the *source* of the mesh, not the instancing.

**Done when:** with no content pack the game renders boxes as it does today;
with one, it renders models; and no module under `src/` imports from here. Draw
calls and frame time are within 20% of the M16 budget with 2,000 units.

### G6. Audio conversion

Generals audio is WAV and MP3. Convert to Ogg Vorbis or WebM/Opus. Scope this
narrowly: unit acknowledgements, weapon fire, explosions, building-complete.
Music is large and adds nothing to a test of the engine — leave it out.

**Done when:** selecting a unit plays its acknowledgement, and firing plays a
weapon sound positioned in the scene.

---

## Phase B — Terrain, which is most of the look

### G7. Terrain textures and splatting

This is root PLAN.md **M29**, unblocked. Generals ships tiling terrain textures
— grass, sand, rock, road — in `Terrain.big`, which is exactly what the
heightfield needs.

Implement what M29 specifies, now that there is something to specify it with:

- **Splat map**: four terrain materials blended through a weight texture,
  painted with an editor brush
- **Slope-based blending**: rock on steep ground, grass on flat, blended over a
  band rather than switched at a threshold
- **Triplanar projection on steep ground**, or cliffs show the UV stretching
  that is the characteristic artefact of heightfield terrain

**Done when:** a sculpted cliff shows rock rather than stretched grass, the
fixture map reads as landscape, and frame time is within 20% of M16.

### G8. Doodads and props

Trees, rocks and civilian structures as instanced static meshes, placed with an
editor tool. These sit on the existing `VISION_BLOCKER` flag, which already
makes a stand of trees cast a vision shadow through the fog sweep — so a tree
line becomes tactically real rather than decorative, for free.

**Done when:** the editor can place doodads, they render instanced, and they
block vision where the flag says they do.

---

## Phase C — The game

### G9. The roster

`manifest/roster.json`, in this project's own format, extending
`src/sim/data/units.json`. Two factions, around eight vehicles and six
structures. Your numbers, not Generals'.

The art is already converted and named, so this milestone is mostly deciding
what each vehicle does:

| NATO | Eastern Axis | Role |
|---|---|---|
| M1A2 Abrams | T-54, T-62, T-72B | armour |
| HMMWV | ZU-23-2 technical | scout |
| M142 HIMARS | BM-21 Grad | rocket artillery |
| M109 Paladin | 9K72 Elbrus | long range |
| — | ZSU-23-4 Shilka | anti-air |
| — | VBIED | improvised demolition |

The Eastern Axis has more entries on purpose: it should field more, cheaper,
less uniform vehicles, and the roster is where that stops being a look and
becomes a way to play.

**Done when:** the roster loads, every entry has a model and a sound, and the
determinism harness still passes — because none of this touched `src/sim/`.

### G10. Faction asymmetry

The art has already chosen the axis: NATO is uniform, expensive and few; the
Eastern Axis is mixed, improvised and many. Make the numbers agree with it and
stop there. Resist adding special abilities until the plain version is fun.

The one Eastern Axis unit worth a rule of its own is the VBIED, because a
one-shot vehicle that trades itself for a building is a *decision* rather than a
statistic, and it is the single thing that makes the faction play differently
rather than merely cost differently.

**Done when:** a bot-versus-bot match between the two factions runs to a
conclusion and the golden replay is reproducible.

### G11. Maps

Two maps authored in this project's editor with the sculpting brushes, using the
new terrain materials. One small and open for testing, one with a ridge and two
chokepoints so the horizon sweep and the nav grid have something to do.

**Done when:** both maps validate clean, both start locations connect, and a
full match plays out on each.

### G12. Tuning pass

Play it. Adjust the roster. This is the milestone that is not a programming
task, and the one most likely to be skipped — it is also the one that decides
whether the result is a game or a tech demo.

**Done when:** you have played twenty minutes without wanting to stop and fix
something.

### G14. Reading a Generals map

`generals/tools/refpack.ts` and `generals/tools/map.ts`. A `.map` is an `EAR\0`
container holding a **RefPack** stream — EA's LZ77 variant, four command forms
distinguished by the top bits of the first byte — wrapping a `CkMp` chunk file:

```
"CkMp"
uint32 count                 name dictionary entries
count x: uint8 length, char name[length], uint32 index
chunks to the end: uint32 nameIndex, uint16 version, uint32 length, bytes data
```

The chunks that matter are `HeightMapData`, `ObjectsList`, `GlobalLighting` and
`WorldInfo`; `BlendTileData` is terrain texturing and belongs with **G7**.
Scripts, triggers and teams are walked past.

**Done when:** a shipped map decompresses, its dictionary resolves every chunk
name, and the chunk sizes account for the file exactly.

### G15. Importing the heightfield

`HeightMapData` is a byte per sample: width, height, a border width, the
playable-area corners, then `width * height` bytes. Generals' horizontal cell is
ten world units to this engine's one, and its height unit is a sixteenth of
that, so a sample converts to cells by dividing by sixteen.

Import into the engine's own `.rtsmap` rather than inventing a second world
format. The engine's heights live on cell **corners** and Generals' live on
samples, which line up: a Generals heightmap of *w* x *h* samples is a world of
*w-1* x *h-1* cells.

Crop to the playable area. The border is scenery the player can never reach,
and carrying it costs nav grid and fog for ground nobody visits.

Start positions come from `ObjectsList` — the waypoints named `Player_N_Start`
— not from the map header.

**Done when:** a shipped multiplayer map loads, validates clean, both starts
connect, and a match plays on it.

### G16. Global lighting

`GlobalLighting` carries the map's sun: a direction and ambient and diffuse
colours, per time of day. Import the one the map is set to and feed it to the
terrain shader and the scene's directional light.

This is what makes a snow map read as snow rather than as a white desert — the
light on those maps is low, blue and flat, and the terrain textures alone do
not carry it.

**Done when:** two maps with different lighting look different, and the
direction the sun comes from matches where shadows fall in the source game.

### G17. Doodads: trees, rocks and civilian buildings

`ObjectsList` holds every placed object: a position, an angle, a type name and
a property list. On a multiplayer map that is a thousand-odd trees, rocks and
neutral structures.

Three parts to this:

- **Convert the models.** Tree and rock W3Ds go through the same pipeline as
  vehicles. They are rigid and mostly single-texture, so they are easier than
  the vehicles were.
- **Render them instanced.** One thin-instanced mesh per doodad type, not one
  mesh per doodad; a map with 1,700 trees is otherwise 1,700 draw calls.
- **Make them matter.** A tree already has somewhere to live in the simulation:
  the `VISION_BLOCKER` flag, which the fog sweep stops at. Importing a tree
  line as blockers turns scenery into cover for free.

Objects whose type has no converted model are skipped rather than guessed at,
and the importer reports which ones, so the manifest can grow deliberately.

**Done when:** a shipped map's trees appear where the source game puts them, a
tree line casts a vision shadow, and the frame time is within 20% of M16 with
the full doodad count on screen.

**Done**, except that the frame-time bound cannot be checked here — see below.

Three things this turned out to need that the sketch above did not anticipate.

**A map names objects; the archives hold models; the INI does not always
join them up.** Scenery resolves through `Object` blocks under `Data/INI`, but
the trees — which are most of the placements — are not defined as objects at
all. `TreePine` is drawn straight from a model called `PTPine01`. So
`objectini.ts` falls back to the art's naming convention, and generates
candidates rather than guessing one: every abbreviation of the family name,
with and without an `x` prefix, for each plausible number and seasonal suffix,
each tested against the archives. A candidate that is not a real model simply
does not match. That resolves 134 of the 136 scenery types across the five
imported maps; the two misses are a ground decal and one wall with no art.

Where a numbered variant does not exist the fallback prefers the **season**
over the number: a winter map places eight kinds of snow-laden pine and the art
ships four, and the nearest snow pine is a much better answer than the exact
green one.

**Roads are in the object list and are not objects.** They are spline control
points drawn as a terrain overlay, and there is no model to import. Bit 1 or 2
of an object's flag word marks one — verified across the shipped maps, where
every road, rail and pavement point carries one of them and no tree, rock or
building carries either. Without that filter a third of Alpine Assault's
"doodads" are road segments that can never resolve.

**Foliage is a cut-out.** A pine is a dozen flat quads with the branches
punched out in the texture's alpha channel. Drawn opaque it is solid slabs with
black corners, which reads as a broken texture rather than a missing alpha
test. The converter now measures the source textures and marks the model, and
the renderer alpha-tests those and drops back-face culling for them, since a
single-plane branch has to be visible from both sides. It is a *share* of the
texture that decides, not any transparent pixel: vehicle art carries a little
stray alpha from antialiasing (the HIMARS is 0.4% transparent) where foliage is
24% to 62%.

**On the frame-time bound.** The CPU side is free, as intended: doodads never
move, so the instance buffers are filled once when the map loads and there is
no per-frame update at all — the simulation tick is unchanged at 0.15ms. The
GPU side cannot be measured here. On Tournament Tundra the frame goes from
21ms to 36-44ms with 777 doodads on screen, but the only browser available is
headless SwiftShader, which rasterises in software, and alpha-tested foliage
with heavy overdraw is the worst case for a software rasteriser specifically.
Draw calls, which are the thing the design was actually protecting, go from 12
to 30 for those 777 objects. Treat the 20% bound as unverified for the same
reason the root PLAN.md treats 60fps as unverified.

### G19. Roads

**Done.** Roads share the map's object list with the scenery and are not
objects: a road is a run of paired control points that the source engine draws
as a textured ribbon over the terrain. See G17 above for the flag that tells
them apart, and `generals/tools/roads.ts` for where the straight-road strip
sits in a road texture and how that placement was established.

The geometry is built at load time rather than shipped, because the same
polyline over different terrain is different geometry. `src/render/roads.ts`
mitres the corners and subdivides along the length so the ribbon follows the
ground.

**Roads, corrected against the source.** Three numbers in the first version
were inferred from the texture, and the source (`W3DRoadBuffer.cpp`) showed two
of them wrong. The ribbon is `RoadWidth x RoadWidthInTexture` across — the
fraction narrows the road rather than widening a tile around it — so dividing
by it made every road 11% to 23% too wide and stretched its texture to match.
One repeat runs `4 x RoadWidth` along it, and across it `v = 85/512 - offset /
(4 x RoadWidth)`, which also mirrors which edge takes which side of the strip.

Corners are curves unless the author said otherwise. Every corner is a circular
arc of `1.5 x RoadWidth` radius tangent to both legs, or `0.5 x` with
`FLAG_ROAD_CORNER_TIGHT`, and only `FLAG_ROAD_CORNER_ANGLED` or a turn under
about 27 degrees stays sharp. The arc is cut into the centreline before the
ribbon is built, so lane markings follow the curve. Where two corners are too
close for both arcs, the radius shrinks to fit; the source mitres instead.

**Not done:** junctions. The source builds tees, Y-junctions, crossroads and
alpha joins from their own regions of the road texture. Here crossing roads
simply overlap.

### G20. A helicopter

**Done.** An aircraft is not a ground unit with the collision turned off, so
this is a simulation feature rather than a renderer one.

`src/sim/flight.ts` owns it. An aircraft ignores the flow field, the navigation
grid and every other unit, carries an **altitude** and an **air state**, and
cannot go anywhere until it has taken off — a move order on a parked helicopter
takes off first rather than being refused, because anything else makes every
order on an aircraft into two orders.

**The physics are rate-limited rather than instant**, which is the whole
difference from the ground movement next door. A ground unit reads a direction
and moves at its top speed that tick; a helicopter has an acceleration and a
turn rate, so it leans into a course change, overshoots slightly and settles,
and slides to a stop rather than halting. That lag is what the source game's
helicopters feel like.

It is also what gives the renderer something honest to work from. **Bank and
pitch are not animations**: `render/units.ts` takes the change in velocity
between two ticks, splits it into the component along the heading and the one
across it, and tips the aircraft against them — nose down to accelerate, roll
into a turn. They are a function of state the simulation already stores, so
they are not stored themselves; putting them in the unit store would mean
hashing two more arrays for a purely visual effect.

The rotor is a separate part, found in the art rather than named: a helicopter
model has several `PROPELLER`-named meshes and most are hubs and shafts that
must stay welded to the hull. The disc is the one that is *flat* — the
Comanche's is 0.2 units thick across 52, where its hubs are 16% to 68% as thick
as they are wide. It spins on wall-clock time, spools up before the aircraft
lifts, and each one starts at its own angle so a flight does not beat in
unison.

Two things worth knowing:

- **A rotor disc is alpha and a fuselage is not**, and they share one texture
  sheet. Measuring the sheet as a whole marks the aircraft a cut-out, which
  puts the *hull* on the two-sided path that `render/models.ts` already records
  as making a vehicle render almost black. The rotors carry their own material.
- **The determinism script needed real handles, not a range.** The gunships
  land in slots that are neither contiguous nor all at generation 1, and
  `MoveUnits` silently drops handles it cannot resolve — so a third of the
  flight orders did nothing while every test still passed. The handles are
  pinned and asserted now. With that fixed the golden hash moves for a change
  of one milli-radian per second in the turn rate, one milli-cell in the cruise
  altitude, and the smallest change to acceleration that survives fixed-point
  quantisation.

**Not done:** an aircraft sees over hills no better than a tank does. The fog
sweep takes its eye height from the ground, so a helicopter at altitude has no
extra line of sight. Nothing is wrong, it is simply not modelled.

### G21. Faithful map visuals

**Done.** Four things, in order of how much they changed the picture.

**The game's own source settles this, and should be reached for first.**
`CnC_Generals_Zero_Hour/` is checked out and gitignored. Two of the fixes below
were guessed at by measurement for far too long before it arrived; both fell
out of the source in minutes.

**The ground was two colours.** The shader mixed a height ramp with a cliff
tint and never sampled anything — M29's real texturing had not landed, so an
imported map arrived wearing the average of its own terrain textures. Each map
now exports **an atlas of the textures it paints with** and **a per-cell index
map** saying which one each cell uses, and the shader lays them down at the
scale the artist drew them: the green channel carries how many cells a texture
spans before it repeats, which is the side of the tile grid it was cut into.
The four cells around a fragment are cross-faded, because the source is one
texture per cell and nothing finer, so a hard lookup draws a square lattice.

Three things this cost, all worth knowing:

- **A tile index is a tile and a quarter.** The low two bits are a quadrant:
  `WorldHeightMap::getUVForNdx` takes `tileNdx >> 2` as the 64x64 source tile,
  bit 0 picking the left or right half and bit 1 the top or bottom, because a
  tile covers two cells each way. Matching the raw index against a texture
  class's tile range puts most of the map on the wrong texture — on Tournament
  Desert it matched 69,000 of 91,800 cells and every one wrongly — and tiling
  each texture continuously instead of sampling the square the map names puts
  a different part of it under every cell. With the shift all 91,800 match.
  Their tile rows run bottom-up, so the row is flipped into the top-down space
  the decoder produces.
- `BlendTileData` does not carry its own width. The grid is the heightfield's,
  and assuming it square is right for a square map and shears every other one
  — which reads as regular stripes across the ground rather than as an
  indexing bug. It took dumping the tile array as digits to see it.
- **No mipmaps on the atlas.** The shader tiles each slot with `fract()`, and
  the derivative the GPU picks a mip level from spikes wherever that wraps,
  drawing a crisp grid over the whole map. Losing mip filtering costs some
  sharpening at full zoom-out; the grid was visible at every zoom. The proper
  fix is a texture array or explicit gradients, both of which need a
  WebGL2-only shader.

**The map's lighting was read and then thrown away.** `GlobalLighting` carries
six lights per time of day and only one reached the renderer, without its
colours. Three separate faults:

- The sun's *colour* and the *ambient* never reached anything: the terrain
  shader hardcoded its own and the scene's fill light kept the engine default,
  so every map was lit like noon. That is why the tundra maps came out as
  blazing white snow instead of the moonlit blue they are.
- **The six slots are two interleaved sets of three**, terrain in 0/2/4 and
  objects in 1/3/5. `GameData.ini` settles it: it names the defaults
  `TerrainLighting*` and `TerrainObjectsLighting*` with `2` and `3` suffixes
  for the fills, in exactly that interleaved order, and Tournament Desert's
  stored values are those morning defaults verbatim — which also confirms the
  ambient, diffuse and direction fields are being read correctly.
- **Identical lights count once.** Every shipped map writes its two fills as
  the same light, so applying both doubles a fill meant to be cast once. On
  Alpine Assault, whose fill is magenta, that turned the entire town pink.

Exposure is **literal**, which the source settles and measurement could not.
`BaseHeightMapRenderObjClass::doTheLight` sums `ambient + N.L * diffuse` over
the three global lights, clamps to 1, and the terrain shader modulates the
texture by it with `GRADIENT_MODULATE` — a plain modulate, not the 2x this era
often used, and only the first light contributes ambient. A warm morning
desert really is drawn at about three quarters of its texture's own
brightness. `r_lightscale` remains, defaulting to 1, both for taste and
because the game applies two passes this does not: a cloud shadow layer and a
macro noise/lightmap.

**The blend layers.** The join between two ground types is not an alpha mask
but a *vertex fade*: `WorldHeightMap::getAlphaUVData` gives each cell a second
texture tile and sets its four corners opaque or clear from the blend's shape
— two corners on one side for a straight edge, one for a short diagonal, three
for a long one — and the card interpolates between them. Zero Hour adds a
second layer over the first where three types meet (`Use3WayTerrainBlends`
defaults on). Both are exported per cell and drawn over the base.

The chunk parser now follows `WorldHeightMap::ParseBlendTileData` exactly
instead of scanning for something that looks like the texture table. The
layout depends on the chunk version, and the game writes `0x7ADA0000` after
every blend entry, so the walk is self-checking: all 149 maps with the chunk
parse with no failures across versions 6, 7 and 8. Of their 1.09 million blend
entries none uses the custom edge textures, so the vertex fade is the whole
job; 11.9% of cells carry a blend and 0.2% a second one.

The corners are interpolated bilinearly. The game splits each cell into two
triangles, which gives a diagonal blend a slightly straighter edge.

**Scenery was missing because of one keyword.** Object definitions come in
three forms and the scanner knew two. `ObjectReskin` is the third, 235 blocks
use it, and it is where the numbered variants live — every bush, fence and wall
in the game. Adding it took the resolved share from 528 of 602 scenery types to
567, and it replaced guesswork with the game's own data: `ArborVitae01` is
`PTCypress01` and `PicketFence02` is `PMWalPckt2`, neither of which any naming
convention would have found. A header may also carry a trailing comment, which
anchoring to end-of-line silently dropped along with `GenericTree` and its 370
placements.

**Doodad buildings were wallpapered with sky.** A W3D mesh can have several
material passes, and the texture named first is not the one it draws with: a
reflection or detail map is on the first pass and the real texture on the
second. `LAKEDUSK.tga` — a photograph of a sky — is the first pass of 395 of
the 768 multi-pass meshes in the shipped art. The reader now takes the texture
and the coordinates from the *same* pass, searching last-first, which is the
invariant that was missing: whatever UVs are used, they are the ones authored
for the texture used. This fixed the town houses and the helicopter fuselage at
once.

**Map selection.** `pnpm gen:map --skirmish` imports every map that can
actually be played, which is a question for the data rather than the file
names: 62 of the installation's 150 maps have two or more `Player_N_Start`
waypoints. Two more are larger than the engine's 512-cell limit and are skipped
by name in the log. `--default <name>` picks the one the game opens on.

**Not done:** bridges. They are declared in `Roads.ini`, not as objects, and a
bridge's `BridgeModelName` is a segment tiled across the span between a pair of
bridge points — road geometry with a model, rather than a doodad with a
position. `gen:doodads` lists them separately so they do not look like
failures. About a hundred placements across the imported maps. `Scorch`, a
ground decal, is the only other thing a map places that has no model.

### G18. Infantry (optional)

Only if the vehicle game is working and you want more.

Generals infantry are skinned meshes with animation, which the thin-instance
renderer cannot draw. The approach that fits is **vertex animation textures**:
bake each animation's vertex positions into a texture at author time, and index
it per instance by time offset. Hundreds of animated units become one draw call
and no skinning cost, at the price of texture memory and no blending between
animations.

Do not attempt per-instance skeletons. It is the obvious approach and it is how
an RTS renderer ends up at 400 draw calls.

**Done when:** a squad of infantry animates, walking and firing, and the M16
draw-call budget is unchanged.

---

## Risks and unknowns, honestly

- **My description of the formats above is from memory and may be wrong in
  detail.** Chunk ids, field order and header layout should all be checked
  against OpenSAGE before writing a parser. Treat this plan's format notes as
  orientation, not specification.
- **W3D animation is the hardest part of the pipeline** and is only needed for
  G18. If infantry get dropped, the parser only needs meshes and hierarchies,
  which is perhaps a fifth of the work.
- **Draw calls are the real budget.** Generals has a material per vehicle; this
  engine wants a handful of draw calls total. Atlasing in G3 is what makes G5
  possible, and if it is skipped, G5 will look fine with ten units and fall over
  with a thousand.
- **Zero Hour versus base Generals** changes archive names and adds content. G1
  should detect rather than assume, and G2's verify step should tell you plainly
  when a manifest entry needs the expansion.
- **Scope.** Two factions and fourteen object types is already a lot of
  conversion work. The temptation will be to add a third faction before the
  first two play well. G12 exists to push back on that.

---

## Order

G0 → G1 → G2 → G3 → G4 → G5 gets one real tank on screen, and is the half of
this plan that proves the idea.

After that, **G14 → G15 → G16** is the next thing worth doing, because a
shipped multiplayer map is a better map than anything you will author by hand
in the editor, and it arrives with its own lighting. G17's doodads need G14's
reader and the vehicle pipeline, so they follow.

Everything else is content and polish and can be reordered freely — except G7,
which should come before G11, because authoring maps against placeholder
terrain textures means authoring them twice.
