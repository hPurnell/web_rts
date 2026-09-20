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
import { convertModel } from './convert.ts';
import type { ConvertedModel } from './convert.ts';

/** Objects that are sound emitters rather than geometry. */
const AMBIENT = /^Amb_/i;

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
      if (AMBIENT.test(doodad.type)) continue;
      counts.set(doodad.type, (counts.get(doodad.type) ?? 0) + 1);
    }
  }

  return [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

async function main(): Promise<void> {
  const index = indexArchives(findInstall().archives);
  const { models } = readObjectModels(index);
  const exists = (file: string): boolean => findByBasename(index, file).length > 0;

  const types = placedTypes();
  console.log(`${types.length} scenery types placed across the imported maps\n`);

  /** Model file to what it converted to, so a shared model converts once. */
  const built = new Map<string, ConvertedModel | null>();
  const entries: Record<string, unknown>[] = [];
  const unresolved: string[] = [];

  for (const { type, count } of types) {
    const model = resolveModel(type, models, exists);
    if (!model) {
      unresolved.push(`${type} (x${count})`);
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

    entries.push({
      id: type,
      ...(converted.cutout ? { alphaTest: true } : {}),
      hull: `models/${converted.hull.gltf}`,
      texture: `models/${converted.hull.texture}`,
    });
  }

  if (unresolved.length > 0) {
    console.log(`\nno model for: ${unresolved.join(', ')}`);
  }

  mkdirSync(ASSETS_DIR, { recursive: true });
  writeFileSync(join(ASSETS_DIR, 'doodads.json'), `${JSON.stringify({ entries }, null, 1)}\n`);
  console.log(
    `\n${entries.length} of ${types.length} scenery types converted,` +
      ` from ${[...built.values()].filter(Boolean).length} models`,
  );
}

if (process.argv[1]?.endsWith('doodads.ts')) void runTool(main);
