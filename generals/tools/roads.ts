/**
 * The road pipeline: `Roads.ini` and its textures into the content pack.
 *
 * A road is not a model. The map stores control points and the source engine
 * draws a textured ribbon along them, draped over the terrain, so what this
 * has to export is a texture and the numbers needed to lay one out.
 *
 * **The straight-road tile.** A road texture is an atlas: a full-width strip
 * of straight road across the top, and below it the corner, T-junction,
 * crossroads and end-cap pieces. Only the straight strip is used here — joins
 * are mitred geometrically instead, which is a fair trade for an RTS camera
 * and avoids having to classify every junction in the map.
 *
 * The strip sits at a fixed place in every road texture: **centred at v = 1/6,
 * one quarter of the texture tall**, with `RoadWidthInTexture` of that being
 * road and the rest shoulder that fades into the terrain. That is not from
 * documentation — it is what predicts the measured extent of the opaque band
 * in `TRTwoLane.tga` (0.0542..0.2792 against 0.0547..0.2773 measured) and in
 * `TRSidewalk.tga`, which is half the size.
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

/** Where the straight-road strip sits in every road texture. */
const TILE_CENTRE_V = 1 / 6;
const TILE_HEIGHT_V = 0.25;

export interface RoadType {
  readonly id: string;
  readonly texture: string;
  /** Tile width across the road, in cells, shoulder included. */
  readonly width: number;
  /** How far along the road one repeat of the texture covers, in cells. */
  readonly repeat: number;
  readonly v0: number;
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

    // The tile is as wide as the texture and a quarter of it tall, so one
    // repeat along the road is that aspect ratio times the tile's width.
    const width = definition.width / definition.widthInTexture / XY_PER_CELL;
    const repeat = (image.width / (image.height * TILE_HEIGHT_V)) * width;

    out.push({
      id: type,
      texture: `roads/${file}`,
      width,
      repeat,
      v0: TILE_CENTRE_V - TILE_HEIGHT_V / 2,
      v1: TILE_CENTRE_V + TILE_HEIGHT_V / 2,
    });
    console.log(
      `  ${type} -> ${definition.texture}, ${width.toFixed(1)} cells wide,` +
        ` repeating every ${repeat.toFixed(1)}`,
    );
  }

  if (missing.length > 0) console.log(`\nno texture for: ${missing.join(', ')}`);

  writeFileSync(join(ASSETS_DIR, 'roads.json'), `${JSON.stringify({ types: out }, null, 1)}\n`);
  console.log(`\n${out.length} road types converted`);
}

if (process.argv[1]?.endsWith('roads.ts')) void runTool(main);
