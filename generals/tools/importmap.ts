/**
 * Importing a Generals map into this engine's own world format.
 *
 * Usage:
 *   pnpm gen:map --list                list the maps in your installation
 *   pnpm gen:map "Alpine Assault"      import one
 *
 * The output is a `.rtsmap` written into `generals/assets/maps/`, plus a
 * side-car JSON carrying the things the engine's world format has no room for:
 * the map's lighting, and the doodads for the renderer.
 *
 * Nothing invents a second world format. The engine's heights live on cell
 * corners and Generals' live on samples, and those line up exactly: a Generals
 * heightmap of w x h samples is a world of w-1 x h-1 cells.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS_DIR, findInstall, runTool } from './config.ts';
import { findByBasename, indexArchives, readEntry, readIndexed } from './big.ts';
import type { AssetIndex } from './big.ts';
import { Reader, findMapChunk, findMapChunks, readMap } from './map.ts';
import { encodeMap } from '../../src/editor/mapfile.ts';
import { createWorld, setFlags, BUILDABLE, VISION_BLOCKER, WALKABLE } from '../../src/sim/world.ts';
import type { World } from '../../src/sim/world.ts';
import { cornerStride } from '../../src/sim/terrain.ts';
import { loadTexture } from './convert.ts';

/**
 * Generals world units per cell, and height units per world unit.
 *
 * Generals lays its terrain out ten units to a cell and quantises height to a
 * sixteenth of that, so a height byte is `value / 16` of this engine's cells.
 * A full-scale byte of 255 is just under sixteen cells, which sits comfortably
 * inside the engine's 32-cell ceiling.
 */
const XY_PER_CELL = 10;
const HEIGHT_PER_CELL = 16;

/**
 * Object flags marking a road spline control point rather than a model.
 *
 * A road is stored as a run of paired points, one bit for each end of a
 * segment. Testing only one of them keeps half of every road.
 */
const ROAD_SEGMENT = (1 << 1) | (1 << 2);

/** Objects whose type name marks them as a player's start position. */
const START_WAYPOINT = /^Player_(\d+)_Start$/i;

/** Type names that should block sight: the tree and rock families. */
const BLOCKS_SIGHT = /(tree|forest|bush|shrub|rock|boulder|cliff)/i;

export interface ImportedObject {
  readonly type: string;
  /** Position in engine cells. */
  readonly x: number;
  readonly z: number;
  /** Facing in radians. */
  readonly angle: number;
  /** Empty unless the object is a waypoint. Start positions live here. */
  readonly waypointName: string;
}

export interface MapLighting {
  /** Direction the sun points, normalised, in engine axes. */
  readonly sun: { x: number; y: number; z: number };
  readonly sunColor: { r: number; g: number; b: number };
  readonly ambient: { r: number; g: number; b: number };
}

interface HeightMap {
  readonly width: number;
  readonly height: number;
  readonly borderWidth: number;
  readonly samples: Buffer;
}

function readHeightMap(data: Buffer): HeightMap {
  const r = new Reader(data);
  const width = r.uint32();
  const height = r.uint32();
  const borderWidth = r.uint32();
  const borders = r.uint32();
  // Each border is a corner of the playable area. Only the count matters here;
  // the crop is derived from borderWidth, which every shipped map agrees with.
  for (let i = 0; i < borders; i++) {
    r.uint32();
    r.uint32();
  }
  const length = r.uint32();
  return { width, height, borderWidth, samples: data.subarray(r.at, r.at + length) };
}

/**
 * The objects placed on the map.
 *
 * Each is a position, an angle, a type name and a property list. The
 * properties matter: a start position is not a distinct object type but an
 * ordinary waypoint carrying `waypointName = "Player_1_Start"`, so a map
 * imported without reading them arrives with no start positions at all.
 *
 * A property is a `uint8` type, a `uint24` index into the file's name
 * dictionary, and a value whose width the type gives: bool is one byte, int
 * and float are four, and a string is length-prefixed.
 */
function readObjects(
  chunks: readonly { name: string; data: Buffer }[],
  names: ReadonlyMap<number, string>,
): ImportedObject[] {
  const objects: ImportedObject[] = [];

  for (const chunk of chunks) {
    const r = new Reader(chunk.data);
    try {
      const x = r.float();
      const y = r.float();
      r.float(); // z, which the engine takes from the terrain instead
      const angle = r.float();
      const flags = r.uint32();
      const type = r.string();

      // Roads are stored in the object list but are not objects: they are
      // spline control points the source engine draws as a terrain overlay,
      // and they have no model to import. Verified across the shipped maps —
      // every road, rail and pavement point carries one of these bits, and no
      // tree, rock or building carries either.
      if ((flags & ROAD_SEGMENT) !== 0) continue;

      const properties = new Map<string, string | number | boolean>();
      const count = r.uint16();
      for (let i = 0; i < count && !r.done; i++) {
        const kind = r.uint8();
        const index = r.uint8() | (r.uint8() << 8) | (r.uint8() << 16);
        const key = names.get(index) ?? `#${index}`;
        if (kind === 0) properties.set(key, r.uint8() !== 0);
        else if (kind === 1) properties.set(key, r.uint32());
        else if (kind === 2) properties.set(key, r.float());
        else if (kind === 3) properties.set(key, r.string());
        else break; // an encoding we do not know: stop rather than misread
      }

      objects.push({
        type,
        x: x / XY_PER_CELL,
        // Generals' y is north; this engine's z is north.
        z: y / XY_PER_CELL,
        angle,
        waypointName: String(properties.get('waypointName') ?? ''),
      });
    } catch {
      // A malformed entry should not lose the rest of the map.
      continue;
    }
  }

  return objects;
}

/**
 * The map's own sun.
 *
 * `GlobalLighting` is a `uint32` time of day and then four blocks, one per
 * time of day, of **six** lights of nine floats each: an ambient colour, a
 * diffuse colour and a direction. Three of the six light the terrain and three
 * light objects, and within each set the first is the sun and the other two
 * are fill that this renderer has no equivalent for.
 *
 * Getting the block size wrong lands on a different time of day's fill light,
 * which on this map is pure black — and black ambient and black diffuse look
 * exactly like a parser that failed rather than one that read the wrong row.
 */
const LIGHTS_PER_TIME_OF_DAY = 6;
const FLOATS_PER_LIGHT = 9;

function readLighting(data: Buffer): MapLighting {
  const r = new Reader(data);
  const timeOfDay = r.uint32();
  const index = Math.max(0, Math.min(3, timeOfDay - 1));
  r.at = 4 + index * LIGHTS_PER_TIME_OF_DAY * FLOATS_PER_LIGHT * 4;

  const colour = (): { r: number; g: number; b: number } => ({
    r: r.float(),
    g: r.float(),
    b: r.float(),
  });

  const ambient = colour();
  const sunColor = colour();
  const direction = { x: r.float(), y: r.float(), z: r.float() };

  // Generals is Z-up with Y north; the engine is Y-up with Z north.
  const sun = { x: direction.x, y: direction.z, z: direction.y };
  const length = Math.hypot(sun.x, sun.y, sun.z) || 1;

  return {
    sun: { x: sun.x / length, y: sun.y / length, z: sun.z / length },
    sunColor,
    ambient,
  };
}

/**
 * A ground and cliff colour taken from the terrain textures the map uses.
 *
 * Full terrain texturing is **G7** — splat weights, slope blending, triplanar
 * projection — and this is not that. It reads the texture names out of
 * `BlendTileData`, loads them, and averages them into the two colours the
 * existing terrain shader already takes. That is enough for a snow map to read
 * as snow instead of as the engine's default green, which is most of the
 * difference between a map you recognise and one you do not.
 *
 * There is an indirection to get through first: `BlendTileData` names *terrain
 * types*, not files, and the mapping from one to the other lives in
 * `Data/INI/Terrain.ini`. Names the pattern picks up that are not terrain
 * types drop out rather than becoming a colour.
 */
/** Terrain type name to texture file, from `Data/INI/Terrain.ini`. */
let terrainTypeCache: Map<string, string> | null = null;

function terrainTypes(index: AssetIndex): Map<string, string> {
  if (terrainTypeCache) return terrainTypeCache;
  const types = new Map<string, string>();
  try {
    const ini = readIndexed(index, 'data/ini/terrain.ini').toString('latin1');
    for (const entry of ini.matchAll(/Terrain\s+(\w+)\s*\r?\n\s*Texture\s*=\s*([\w.]+)/gi)) {
      types.set((entry[1] as string).toLowerCase(), entry[2] as string);
    }
  } catch {
    // No Terrain.ini: the palette falls back to the engine's own colours.
  }
  terrainTypeCache = types;
  return types;
}

/**
 * The textures a map paints its ground with, and how much of it each covers.
 *
 * `BlendTileData` is a per-cell tile index array followed by a table of
 * texture records. Each record is `firstTile`, `tileCount`, the square root of
 * that count, a zero, and a length-prefixed name; `firstTile` accumulates
 * across the table, which both identifies where the table starts and proves it
 * was read correctly.
 *
 * The array is what makes the palette worth anything. Averaging the *list*
 * weights a texture used on four cells the same as one used on a third of the
 * map, and on a map with eleven incidental grass variants and one dominant
 * cliff it produces a colour that appears nowhere on it.
 */
export function readTerrainCoverage(data: Buffer): { name: string; share: number }[] {
  const cells = data.readUInt32LE(0);
  // Four uint16 arrays per cell — tile, blend, extra blend and cliff indices —
  // so the table cannot start before them.
  const afterArrays = 4 + cells * 2 * 4;

  let start = -1;
  for (let at = afterArrays; at + 22 < data.length; at++) {
    if (data.readUInt32LE(at) !== 0) continue; // the first record's firstTile
    const count = data.readUInt32LE(at + 4);
    const side = data.readUInt32LE(at + 8);
    const length = data.readUInt16LE(at + 16);
    if (count !== side * side || data.readUInt32LE(at + 12) !== 0) continue;
    if (length < 3 || length > 32) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(data.toString('latin1', at + 18, at + 18 + length))) continue;
    start = at;
    break;
  }
  if (start < 0) return [];

  const records: { name: string; first: number; count: number }[] = [];
  let at = start;
  let expected = 0;
  while (at + 18 < data.length) {
    const first = data.readUInt32LE(at);
    const count = data.readUInt32LE(at + 4);
    const side = data.readUInt32LE(at + 8);
    const length = data.readUInt16LE(at + 16);
    // The chain is the check: a record that does not continue where the last
    // one ended means the table is over, or was never really there.
    if (first !== expected || count !== side * side || length < 3 || length > 32) break;
    records.push({ name: data.toString('latin1', at + 18, at + 18 + length), first, count });
    expected = first + count;
    at += 18 + length;
  }

  const used = new Map<number, number>();
  for (let i = 0; i < cells; i++) {
    const tile = data.readUInt16LE(4 + i * 2);
    used.set(tile, (used.get(tile) ?? 0) + 1);
  }

  return records.map((record) => {
    let count = 0;
    for (const [tile, n] of used) {
      if (tile >= record.first && tile < record.first + record.count) count += n;
    }
    return { name: record.name, share: count / cells };
  });
}

function readTerrainPalette(
  data: Buffer,
  index: AssetIndex,
): { ground: number[]; cliff: number[]; names: string[] } {
  const types = terrainTypes(index);
  const coverage = readTerrainCoverage(data).sort((a, b) => b.share - a.share);
  const groundPixels: number[] = [0, 0, 0];
  const cliffPixels: number[] = [0, 0, 0];
  let groundWeight = 0;
  let cliffWeight = 0;
  const found: string[] = [];

  for (const { name, share } of coverage) {
    if (share <= 0) continue;
    const file = types.get(name.toLowerCase());
    if (!file) continue;
    const image = loadTexture(index, file);
    if (!image) continue;
    found.push(name);

    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    // Every sixteenth pixel: an average does not need all of them.
    for (let i = 0; i < image.data.length; i += 64) {
      r += image.data[i] as number;
      g += image.data[i + 1] as number;
      b += image.data[i + 2] as number;
      n++;
    }
    if (n === 0) continue;

    const cliff = /cliff|rock/i.test(name);
    const target = cliff ? cliffPixels : groundPixels;
    target[0] = (target[0] as number) + (r / n) * share;
    target[1] = (target[1] as number) + (g / n) * share;
    target[2] = (target[2] as number) + (b / n) * share;
    if (cliff) cliffWeight += share;
    else groundWeight += share;
  }

  const average = (sum: number[], weight: number, fallback: number[]): number[] =>
    weight === 0 ? fallback : sum.map((v) => v / weight / 255);

  return {
    ground: average(groundPixels, groundWeight, [0.21, 0.29, 0.2]),
    cliff: average(cliffPixels, cliffWeight, [0.3, 0.27, 0.24]),
    names: found,
  };
}

export interface ImportResult {
  readonly world: World;
  readonly lighting: MapLighting;
  readonly doodads: readonly ImportedObject[];
  readonly skipped: number;
  readonly palette: { ground: number[]; cliff: number[]; names: string[] };
}

export function importMap(buffer: Buffer, name: string, index: AssetIndex): ImportResult {
  const map = readMap(buffer);

  const heightChunk = findMapChunk(map.chunks, 'HeightMapData');
  if (!heightChunk) throw new Error(`${name}: no HeightMapData`);
  const heights = readHeightMap(heightChunk.data);

  // Crop the border away. It is scenery the player can never reach, and
  // carrying it costs nav grid and fog for ground nobody visits.
  const border = heights.borderWidth;
  const cells = {
    width: Math.max(1, heights.width - border * 2 - 1),
    height: Math.max(1, heights.height - border * 2 - 1),
  };

  const world = createWorld({ width: cells.width, height: cells.height });
  const stride = cornerStride(world);
  const rows = world.height + 1;

  const raw = new Float64Array(stride * rows);
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < stride; cx++) {
      const sx = Math.min(heights.width - 1, cx + border);
      const sy = Math.min(heights.height - 1, cz + border);
      raw[cz * stride + cx] = (heights.samples[sy * heights.width + sx] ?? 0) / HEIGHT_PER_CELL;
    }
  }

  // One smoothing pass over the corners.
  //
  // Generals quantises height to a byte, so its terrain arrives as a staircase
  // of sixteenth-cell steps. Its own movement rules tolerate gradients this
  // engine calls cliffs, and imported raw a quarter of a map comes out
  // impassable with dozens of stranded pockets. A single 3x3 average keeps the
  // landform and takes the quantisation off it.
  const smoothed = new Float64Array(raw.length);
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < stride; cx++) {
      let total = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= stride || z >= rows) continue;
          total += raw[z * stride + x] as number;
          count++;
        }
      }
      smoothed[cz * stride + cx] = total / Math.max(1, count);
    }
  }

  for (let i = 0; i < smoothed.length; i++) {
    world.heights[i] = Math.round((smoothed[i] as number) * 65536);
  }

  // Everything starts walkable and buildable; doodads take buildability away.
  for (let cell = 0; cell < world.flags.length; cell++) {
    world.flags[cell] = WALKABLE | BUILDABLE;
  }

  const objects = readObjects(findMapChunks(map.chunks, 'Object'), map.names);
  const doodads: ImportedObject[] = [];
  let skipped = 0;

  for (const object of objects) {
    // Object positions are already in playable-area space; only the heightmap
    // samples carry the border. Subtracting the border from both puts half the
    // map's scenery, and one of the two start positions, off the edge.
    const start = START_WAYPOINT.exec(object.waypointName);
    const cx = Math.round(object.x);
    const cz = Math.round(object.z);
    if (cx < 0 || cz < 0 || cx >= world.width || cz >= world.height) {
      skipped++;
      continue;
    }

    if (start) {
      world.startLocations.push({ cell: cz * world.width + cx });
      continue;
    }

    // Waypoints are navigation markers, not scenery.
    if (object.type.startsWith('*Waypoints')) continue;
    doodads.push({ ...object, x: cx, z: cz });
    if (BLOCKS_SIGHT.test(object.type)) {
      const cell = cz * world.width + cx;
      setFlags(world, cell, ((world.flags[cell] as number) & ~BUILDABLE) | VISION_BLOCKER);
    }
  }

  const lightingChunk = findMapChunk(map.chunks, 'GlobalLighting');
  const lighting = lightingChunk
    ? readLighting(lightingChunk.data)
    : {
        sun: { x: -0.45, y: -1, z: 0.6 },
        sunColor: { r: 1, g: 0.97, b: 0.9 },
        ambient: { r: 0.3, g: 0.3, b: 0.35 },
      };

  const blend = findMapChunk(map.chunks, 'BlendTileData');
  const palette = blend
    ? readTerrainPalette(blend.data, index)
    : { ground: [0.21, 0.29, 0.2], cliff: [0.3, 0.27, 0.24], names: [] };

  return { world, lighting, doodads, skipped, palette };
}

/** Every `.map` in the installation, by display name. */
export function listMaps(index: AssetIndex): Map<string, string> {
  const maps = new Map<string, string>();
  for (const entry of index.entries.values()) {
    if (!entry.key.endsWith('.map')) continue;
    const file = entry.key.split('/').pop() ?? entry.key;
    maps.set(file.replace(/\.map$/, ''), entry.key);
  }
  return maps;
}

async function main(): Promise<void> {
  const install = findInstall();
  const index = indexArchives(install.archives);
  const maps = listMaps(index);

  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (process.argv.includes('--list') || wanted.length === 0) {
    for (const name of [...maps.keys()].sort()) console.log(`  ${name}`);
    console.log(`\n${maps.size} maps`);
    return;
  }

  mkdirSync(join(ASSETS_DIR, 'maps'), { recursive: true });
  const imported: { name: string; slug: string; width: number; height: number }[] = [];

  for (const name of wanted) {
    const found = findByBasename(index, `${name}.map`);
    if (found.length === 0) {
      console.error(`  not found: ${name}`);
      process.exitCode = 1;
      continue;
    }
    const entry = found[0]!;
    const buffer = readEntry(index.archivePaths.get(entry.archive)!, entry);
    const result = importMap(buffer, name, index);

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    writeFileSync(join(ASSETS_DIR, 'maps', `${slug}.rtsmap`), encodeMap(result.world));
    writeFileSync(
      join(ASSETS_DIR, 'maps', `${slug}.json`),
      `${JSON.stringify(
        {
          name,
          lighting: result.lighting,
          palette: result.palette,
          doodads: result.doodads,
        },
        null,
        1,
      )}\n`,
    );

    imported.push({ name, slug, width: result.world.width, height: result.world.height });

    console.log(
      `  ${name}: ${result.world.width}x${result.world.height} cells,` +
        ` ${result.world.startLocations.length} starts,` +
        ` ${result.doodads.length} doodads` +
        (result.skipped > 0 ? `, ${result.skipped} outside the playable area` : '') +
        `, ${result.palette.names.length} terrain textures`,
    );
  }

  // The first map imported becomes the one the game opens on. Written beside
  // the models so the app has a single file to ask for.
  if (imported.length > 0) {
    writeFileSync(
      join(ASSETS_DIR, 'maps', 'index.json'),
      `${JSON.stringify({ maps: imported, default: imported[0]?.slug }, null, 1)}\n`,
    );
  }
}

if (process.argv[1]?.endsWith('importmap.ts')) void runTool(main);
