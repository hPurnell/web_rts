# Generals content pack

A small RTS built on this engine using art and audio from a local installation
of *Command & Conquer: Generals* or *Zero Hour*.

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
pnpm gen:convert    W3D -> glTF, TGA/DDS -> KTX2, WAV/MP3 -> Ogg
```

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
grep -rn "generals/" src/      # must return nothing
```

That greps for *imports*, not the word: `src/sim/building.ts` mentions Generals
in a comment about footprint levelling, which is a design citation and fine.

The base game must also build and pass its whole suite with no installation
present. The content pack is additive: absent it, the game runs on placeholder
boxes exactly as it does today.
