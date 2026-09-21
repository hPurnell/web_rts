/**
 * The road pipeline: `Roads.ini` and its textures into the content pack.
 *
 * A road is not a model. The map stores control points and the source engine
 * draws a textured ribbon along them, draped over the terrain, so what this
 * has to export is a texture and the numbers needed to lay one out.
 *
 * **The straight-road strip.** A road texture is an atlas: a full-width strip
 * of straight road across the top, and below it the corner, T-junction,
 * crossroads and end-cap pieces. Only the straight strip is used here; curves
 * bend it along an arc instead of using the corner pieces, which keeps lane
 * markings continuous through a turn.
 *
 * All three numbers come from `W3DRoadBuffer::preloadRoadSegment` and
 * `loadFloat4PtSection` in the game's source, and replace ones that were
 * inferred from the texture and got two of three wrong:
 *
 * - the ribbon is `RoadWidth x RoadWidthInTexture` across — the fraction
 *   *narrows* the road, it does not widen the tile around it;
 * - one repeat of the texture runs `4 x RoadWidth` along it;
 * - across it, `v = 85/512 - offset / (4 x RoadWidth)`, which puts the strip
 *   centred at 1/6 and `RoadWidthInTexture / 4` of the texture tall.
 *
 * Dividing by the fraction instead of multiplying made every road between 11%
 * and 23% too wide and stretched its texture to match.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS_DIR, findInstall, runTool } from './config.ts';
import { indexArchives, readIndexed } from './big.ts';
import type { AssetIndex } from './big.ts';
import { loadTexture } from './convert.ts';
import { writePng } from './image.ts';

/** Generals world units per engine cell, as the map importer uses. */
const XY_PER_CELL = 10;

/** Where the straight-road strip is centred: `85 / 512` in the source. */
const STRIP_CENTRE_V = 85 / 512;
/** World units per texture unit, along and across: `U / (uScale * 4)`. */
const WIDTHS_PER_REPEAT = 4;

export interface RoadType {
  readonly id: string;
  readonly texture: string;
  /** Width of the ribbon across the road, in cells. */
  readonly width: number;
  /**
   * The road's nominal width in cells — `RoadWidth` before the in-texture
   * fraction narrows it. Curves are sized from this, not from `width`.
   */
  readonly scale: number;
  /** How far along the road one repeat of the texture covers, in cells. */
  readonly repeat: number;
  /** Texture v at the road's right-hand edge, looking along it. */
  readonly v0: number;
  /** Texture v at its left-hand edge. */
  readonly v1: number;
}

/** `Road <name>` blocks: a texture, a width, and how much of the tile is road. */
export function readRoadIni(index: AssetIndex): Map<string, { texture: string; width: number; widthInTexture: number }> {
  const out = new Map<string, { texture: string; width: number; widthInTexture: number }>();
  let text: string;
  try {
    text = readIndexed(index, 'data/ini/roads.ini').toString('latin1');
  } catch {
    return out;
  }

  for (const block of text.matchAll(/^Road\s+(\w+)\s*\r?\n([\s\S]*?)^End/gim)) {
    const body = block[2] as string;
    const texture = /^\s*Texture\s*=\s*(\S+)/im.exec(body)?.[1];
    const width = Number(/^\s*RoadWidth\s*=\s*([\d.]+)/im.exec(body)?.[1]);
    const widthInTexture = Number(/^\s*RoadWidthInTexture\s*=\s*([\d.]+)/im.exec(body)?.[1]);
    if (!texture || !Number.isFinite(width) || !Number.isFinite(widthInTexture)) continue;
    out.set((block[1] as string).toLowerCase(), { texture, width, widthInTexture });
  }
  return out;
}

interface MapMeta {
  readonly roads?: readonly { type: string }[];
}

/** Every road type the imported maps actually lay down. */
function placedTypes(): string[] {
  const listing = JSON.parse(
    readFileSync(join(ASSETS_DIR, 'maps', 'index.json'), 'utf8'),
  ) as { maps: readonly { slug: string }[] };

  const types = new Set<string>();
  for (const map of listing.maps) {
    const meta = JSON.parse(
      readFileSync(join(ASSETS_DIR, 'maps', `${map.slug}.json`), 'utf8'),
    ) as MapMeta;
    for (const road of meta.roads ?? []) types.add(road.type);
  }
  return [...types];
}

async function main(): Promise<void> {
  const index = indexArchives(findInstall().archives);
  const ini = readRoadIni(index);
  console.log(`${ini.size} road types defined\n`);

  const out: RoadType[] = [];
  const missing: string[] = [];
  mkdirSync(join(ASSETS_DIR, 'roads'), { recursive: true });

  for (const type of placedTypes().sort()) {
    const definition = ini.get(type.toLowerCase());
    if (!definition) {
      missing.push(`${type} (no Road block)`);
      continue;
    }

    const image = loadTexture(index, definition.texture);
    if (!image) {
      missing.push(`${type} (${definition.texture} not found)`);
      continue;
    }

    const file = `${type.toLowerCase()}.png`;
    writeFileSync(join(ASSETS_DIR, 'roads', file), writePng(image));

    const scale = definition.width / XY_PER_CELL;
    const width = scale * definition.widthInTexture;
    // Half the road across is widthInTexture / 2 road widths, which the source
    // divides by four road widths per texture unit.
    const halfV = definition.widthInTexture / (2 * WIDTHS_PER_REPEAT);

    out.push({
      id: type,
      texture: `roads/${file}`,
      width,
      scale,
      repeat: scale * WIDTHS_PER_REPEAT,
      // `v = centre - offset`, and the offset is positive on the left: the
      // right-hand edge takes the larger v.
      v0: STRIP_CENTRE_V + halfV,
      v1: STRIP_CENTRE_V - halfV,
    });
    console.log(
      `  ${type} -> ${definition.texture}, ${width.toFixed(2)} cells wide,` +
        ` repeating every ${(scale * WIDTHS_PER_REPEAT).toFixed(1)}`,
    );
  }

  if (missing.length > 0) console.log(`\nno texture for: ${missing.join(', ')}`);

  writeFileSync(join(ASSETS_DIR, 'roads.json'), `${JSON.stringify({ types: out }, null, 1)}\n`);
  console.log(`\n${out.length} road types converted`);
}

if (process.argv[1]?.endsWith('roads.ts')) void runTool(main);
