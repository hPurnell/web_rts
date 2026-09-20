# Generals content pack

A small RTS built on this engine using art and audio from a local installation
of *Command & Conquer: Generals* or *Zero Hour*.

Two factions, **NATO** and the **Eastern Axis**, with everything named after the
real vehicle it most resembles rather than its Generals original — an Abrams,
an HMMWV, a T-54, a BM-21 Grad. The Eastern Axis mixes the game's China and GLA
art on purpose, so Soviet-pattern armour fights alongside improvised
technicals. See [PLAN.md](PLAN.md#the-two-factions) and
`manifest/assets.json`.

**This is for personal use and is never published.** Nothing derived from the
game enters this repository: `assets/`, `.cache/` and `generals.local.json` are
all gitignored, and the GitHub Pages deploy builds the base game only. A
converted mesh is still derived from the original — it does not become
committable by passing through a converter.

See [PLAN.md](PLAN.md) for the build plan.

## Pointing it at your installation

Create `generals/generals.local.json` (gitignored):

```json
{ "installDir": "/path/to/Command and Conquer Generals Zero Hour" }
```

or set `GENERALS_DIR` in the environment. With neither, every tool here exits
non-zero and says so; nothing runs against a partial cache.

```
pnpm gen:verify     what the manifest asks for, and what your install has
pnpm gen:extract    pull the manifest's files out of the .big archives
pnpm gen:convert    W3D -> glTF, TGA/DDS -> PNG
pnpm gen:map --list                 the maps in your installation
pnpm gen:map "Tournament Tundra"    import one; the first becomes the default
pnpm gen:doodads    the scenery every imported map places, W3D -> glTF
pnpm gen:roads      the road textures those maps use, and their widths
```

An imported map brings its terrain, its start positions, its own sun and a
palette taken from the terrain textures it was built with, weighted by how much
of the map each one actually covers. The game opens on whichever map
`generals/assets/maps/index.json` names as the default.

`gen:doodads` and `gen:roads` run **after** `gen:map`, since they convert
exactly what the imported maps place and nothing else. A road is not a model:
the map stores control points, so `gen:roads` exports a texture and a width
and the renderer builds the ribbon over whatever terrain is under it. It prints anything it could not find
a model for; expect ground decals and the odd wall, and see PLAN.md's G17 for
why the trees need a naming convention rather than the game's own INI.

## What is committed

`manifest/assets.json` lists source files **by name** — a reference to a file on
your disk, the way a `.gitignore` entry is, with no content. It makes an
extraction reproducible and reviewable.

`manifest/roster.json` holds unit stats in *this project's* format, authored by
hand. Generals' own numbers are deliberately not parsed: they would become
simulation state, and the determinism harness hashes simulation state, so
committing them breaks the rule above while gitignoring them would stop
`pnpm test:determinism` running on a clean clone. Art from the game, rules from
us — see PLAN.md.

## The rule that keeps this separable

`generals/` never leaks into `src/`. The engine gains generic extension points —
a model registry, a content-pack loader — that know nothing about Generals, and
everything game-specific lives here. The check is mechanical:

```
grep -rn "from '.*generals" src/    # must return nothing
```

That greps for *imports*, not the word. Comments may mention Generals and two
already do: `src/sim/building.ts` cites it as the precedent for footprint
levelling, and `src/app.ts` cites this plan for the content pack fallback.

The base game must also build and pass its whole suite with no installation
present. The content pack is additive: absent it, the game runs on placeholder
boxes exactly as it does today.
