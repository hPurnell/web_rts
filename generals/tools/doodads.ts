/**
 * The scenery pipeline: every doodad an imported map places, through the
 * vehicle converter and into the content pack.
 *
 * A map places scenery by *object name* — `TreePine`, `SnowRock01` — and the
 * vehicle pipeline takes a *model file*. Bridging the two is `resolveModel`
 * in `objectini.ts`, which is most of the work; see that file for why the
 * trees do not resolve through the INI like everything else.
 *
 * Two things are worth knowing about the output:
 *
 * - **Entries are per object name, models are per file.** Several names share
 *   one model (`TreePalm2` and `TreePalm2short` both draw `PTPalm02`), and it
 *   is converted once. The extra entries cost a map lookup, not a draw call.
 * - **`Amb_*` objects are skipped.** They are ambient sound emitters with no
 *   geometry at all, and on a snow map they are a seventh of the placements.
 *   Reporting them as failures would bury the ones that matter.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS_DIR, findInstall, runTool } from './config.ts';
import { findByBasename, indexArchives } from './big.ts';
import { readObjectModels, resolveModel } from './objectini.ts';
import { convertAnimated, convertModel } from './convert.ts';
import type { ConvertedAnimation, ConvertedModel } from './convert.ts';

/**
 * Objects a map places that are not scenery and never will be.
 *
 * Sound emitters are most of them: two naming schemes, `Amb_DesertInsects`
 * and `AmbientWindCold`, and on some maps a seventh of the placements.
 * Reporting them as failures buries the ones that matter.
 */
const NOT_SCENERY = /^(Amb_|Ambient[A-Z]|AGenericSound$|\d+MeterShroudClear)/;

/**
 * Bridges, which are declared in `Roads.ini` rather than as objects.
 *
 * A bridge's `BridgeModelName` is a *segment*, tiled across the span between
 * a pair of bridge points, so it is road geometry with a model rather than a
 * doodad with a position. Listing them separately keeps the failure report
 * about genuine misses. See generals/PLAN.md.
 */
const BRIDGE = /bridge|sectional|^(Tampico|ConcreteWide|ConcreteFourLane|Industrial|IndustrialWide|SimpleUrbanFixed)$/i;

interface MapMeta {
  readonly doodads?: readonly { type: string }[];
}

/** Every distinct scenery name across the imported maps, commonest first. */
function placedTypes(): { type: string; count: number }[] {
  const indexPath = join(ASSETS_DIR, 'maps', 'index.json');
  const listing = JSON.parse(readFileSync(indexPath, 'utf8')) as {
    maps: readonly { slug: string }[];
  };

  const counts = new Map<string, number>();
  for (const map of listing.maps) {
    const meta = JSON.parse(
      readFileSync(join(ASSETS_DIR, 'maps', `${map.slug}.json`), 'utf8'),
    ) as MapMeta;
    for (const doodad of meta.doodads ?? []) {
      if (NOT_SCENERY.test(doodad.type)) continue;
      counts.set(doodad.type, (counts.get(doodad.type) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

async function main(): Promise<void> {
  const index = indexArchives(findInstall().archives);
  const { models, extras, animatedMain } = readObjectModels(index);
  const exists = (file: string): boolean => findByBasename(index, file).length > 0;

  const types = placedTypes();
  console.log(`${types.length} scenery types placed across the imported maps\n`);

  /** Model file to what it converted to, so a shared model converts once. */
  const built = new Map<string, ConvertedModel | null>();
  /**
   * Moving parts — a derrick's flag, a hospital's lights — keyed by model and
   * animation, so the dozen tech buildings that share one flag bake it once.
   */
  const animations: Record<string, ConvertedAnimation> = {};
  let animatedParts = 0;
  const entries: Record<string, unknown>[] = [];
  const unresolved: string[] = [];
  const bridges: string[] = [];

  for (const { type, count } of types) {
    const model = resolveModel(type, models, exists);
    if (!model) {
      (BRIDGE.test(type) ? bridges : unresolved).push(`${type} (x${count})`);
      continue;
    }

    const key = model.toLowerCase();
    if (!built.has(key)) {
      const converted = convertModel(index, `doodad_${key}`, `${model}.w3d`);
      built.set(key, converted);
      if (converted) {
        console.log(`  ${type} -> ${model}, radius ${converted.radius.toFixed(2)}`);
      }
    }

    const converted = built.get(key);
    if (!converted) continue;

    // Every draw module after the first: the pieces that move on it. And the
    // first too when it moves at rest, in which case its animated version
    // replaces the still hull instead of being drawn over it.
    const extraKeys: string[] = [];
    const main = animatedMain.get(type.toLowerCase());
    let hullAnimated = false;
    for (const part of [...(main ? [main] : []), ...(extras.get(type.toLowerCase()) ?? [])]) {
      if (!exists(`${part.model}.w3d`)) continue;
      const key = `${part.model}|${part.animation ?? ''}`.toLowerCase();
      if (!(key in animations)) {
        const baked = convertAnimated(index, `anim_${part.model.toLowerCase()}`, part.model, part.animation);
        if (!baked) continue;
        animations[key] = {
          ...baked,
          parts: baked.parts.map((p) => ({
            ...p,
            gltf: `models/${p.gltf}`,
            texture: `models/${p.texture}`,
          })),
        };
        animatedParts += baked.parts.length;
      }
      extraKeys.push(key);
      if (part === main) hullAnimated = true;
    }

    entries.push({
      id: type,
      ...(converted.cutout ? { alphaTest: true } : {}),
      hull: `models/${converted.hull.gltf}`,
      texture: `models/${converted.hull.texture}`,
      ...(extraKeys.length > 0 ? { extras: extraKeys } : {}),
      ...(hullAnimated ? { hullAnimated: true } : {}),
    });
  }

  if (bridges.length > 0) {
    console.log(`\nbridges, which need span geometry: ${bridges.join(', ')}`);
  }
  if (unresolved.length > 0) {
    console.log(`\nno model for: ${unresolved.join(', ')}`);
  }

  mkdirSync(ASSETS_DIR, { recursive: true });
  // Compact, not indented: the baked matrices are most of the file, and one
  // number a line makes it five times the size for nobody's benefit.
  writeFileSync(join(ASSETS_DIR, 'doodads.json'), `${JSON.stringify({ entries, animations })}\n`);
  console.log(
    `${Object.keys(animations).length} moving pieces baked, ${animatedParts} parts between them`,
  );
  console.log(
    `\n${entries.length} of ${types.length} scenery types converted,` +
      ` from ${[...built.values()].filter(Boolean).length} models`,
  );
}

if (process.argv[1]?.endsWith('doodads.ts')) void runTool(main);
