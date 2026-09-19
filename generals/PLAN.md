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
   this is mechanical: `grep -rn "generals/" src/` returns nothing — no module
   under `src/` may import from here. (Prose references are fine and one
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
identity anyway, and a tank game is a complete game. Infantry are **G13**,
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

**Watch for:** Generals' models are Z-up and in a different scale and winding
from Babylon's left-handed Y-up convention. Get the handedness wrong and the
models render inside-out — which, as the root plan's migration notes record,
looks like nothing rendering at all rather than like an error. Write the axis
conversion once, in one function, with a comment stating the convention.

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
with one, it renders models; and `grep -rn "generals/" src/` is empty. Draw
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

A sensible starting shape, if you want one: a cheap scout, a main battle tank, a
long-range artillery piece, an anti-air vehicle, and a transport per faction;
command centre, power plant, barracks-equivalent, war factory, defensive
structure, and a resource collector.

**Done when:** the roster loads, every entry has a model and a sound, and the
determinism harness still passes — because none of this touched `src/sim/`.

### G10. Faction asymmetry

The smallest thing that makes two factions feel different rather than recoloured.
Pick one axis and commit to it: one faction's units cost more and hit harder,
the other's are cheap and fast. Resist adding special abilities until the
symmetric version is fun.

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

### G13. Infantry (optional)

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
  G13. If infantry get dropped, the parser only needs meshes and hierarchies,
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
this plan that proves the idea. Everything after it is content and polish, and
can be reordered freely — except G7, which should come before G11, because
authoring maps against placeholder terrain textures means authoring them twice.
