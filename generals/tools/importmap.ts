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
import { writePng } from './image.ts';
import type { Image } from './image.ts';

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
const ROAD_POINT_START = 1 << 1;
const ROAD_POINT_END = 1 << 2;
const ROAD_SEGMENT = ROAD_POINT_START | ROAD_POINT_END;

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

/** One point on a road: where it is, and how the road turns there. */
export interface RoadPoint {
  readonly x: number;
  readonly z: number;
  /** The author asked for a sharp corner here rather than a curve. */
  readonly angled?: boolean;
  /** The author asked for a tight curve: a third of the usual radius. */
  readonly tight?: boolean;
}

/** A road, rail line or pavement, as a chain of points in cells. */
export interface RoadPolyline {
  readonly type: string;
  readonly points: readonly RoadPoint[];
}

/** `FLAG_ROAD_CORNER_ANGLED` in `MapObject.h`: a corner, not a curve. */
const ROAD_CORNER_ANGLED = 0x08;
/** `FLAG_ROAD_CORNER_TIGHT`: a curve of half a road width, not one and a half. */
const ROAD_CORNER_TIGHT = 0x40;

/** One directional light: where it points, and what colour it casts. */
export interface MapLight {
  readonly direction: { x: number; y: number; z: number };
  readonly color: { r: number; g: number; b: number };
}

export interface MapLighting {
  /** Direction the primary sun points, normalised, in engine axes. */
  readonly sun: { x: number; y: number; z: number };
  readonly sunColor: { r: number; g: number; b: number };
  readonly ambient: { r: number; g: number; b: number };
  /** The three lights the ground is lit by, primary first. */
  readonly terrain: readonly MapLight[];
  /** The three lights units and scenery are lit by, primary first. */
  readonly object: readonly MapLight[];
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
 * The roads, rails and pavements.
 *
 * These share the object list with the scenery but are a different kind of
 * thing: a road is a run of **paired** control points, one flag for each end
 * of a segment, which the source engine draws as a textured ribbon draped over
 * the terrain. There is no model to import.
 *
 * Segments arrive in order and share their endpoints, so they chain back into
 * the polylines the map's author drew. Chaining matters for more than tidiness:
 * a ribbon built per segment has a visible notch at every corner, where one
 * built along a polyline can mitre the join.
 *
 * Positions stay fractional here, unlike the scenery, which rounds to a cell.
 * A road that snapped to cell centres would visibly zigzag.
 */
function readRoads(chunks: readonly { name: string; data: Buffer }[]): RoadPolyline[] {
  interface Point {
    readonly type: string;
    readonly x: number;
    readonly z: number;
    readonly flags: number;
  }

  const points: Point[] = [];
  for (const chunk of chunks) {
    const r = new Reader(chunk.data);
    try {
      const x = r.float();
      const y = r.float();
      r.float();
      r.float(); // angle, which a road point does not use
      const flags = r.uint32();
      const type = r.string();
      if ((flags & ROAD_SEGMENT) === 0) continue;
      points.push({ type, x: x / XY_PER_CELL, z: y / XY_PER_CELL, flags });
    } catch {
      continue;
    }
  }

  // Pair them up. A start followed by an end is a segment; anything else is
  // skipped rather than guessed at.
  const segments: { type: string; a: Point; b: Point }[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    if ((a.flags & ROAD_POINT_START) === 0 || (b.flags & ROAD_POINT_END) === 0) continue;
    if (a.type !== b.type) continue;
    segments.push({ type: a.type, a, b });
    i++;
  }

  // Chain segments that share an endpoint into polylines, per road type. The
  // key is quantised because the shared endpoint is the same stored float on
  // both segments, but nothing in the format promises that.
  const key = (p: Point): string => `${Math.round(p.x * 1000)},${Math.round(p.z * 1000)}`;
  const polylines: RoadPolyline[] = [];

  for (const type of new Set(segments.map((segment) => segment.type))) {
    const mine = segments.filter((segment) => segment.type === type);
    const cornerFlags = new Map<string, number>();
    for (const segment of mine) {
      for (const end of [segment.a, segment.b]) {
        cornerFlags.set(key(end), (cornerFlags.get(key(end)) ?? 0) | end.flags);
      }
    }
    const used = new Set<number>();
    const at = new Map<string, number[]>();
    for (let i = 0; i < mine.length; i++) {
      for (const end of [(mine[i] as (typeof mine)[number]).a, (mine[i] as (typeof mine)[number]).b]) {
        const list = at.get(key(end));
        if (list) list.push(i);
        else at.set(key(end), [i]);
      }
    }

    /** The one unused segment continuing from a point, if it is unambiguous. */
    const next = (from: Point): number => {
      const candidates = (at.get(key(from)) ?? []).filter((i) => !used.has(i));
      // A junction has three or more ways on. Stopping there keeps each
      // polyline a single unbranched run, which is all the ribbon can draw.
      return candidates.length === 1 ? (candidates[0] as number) : -1;
    };

    for (let i = 0; i < mine.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const seed = mine[i] as (typeof mine)[number];
      const chain: Point[] = [seed.a, seed.b];

      for (const forward of [true, false]) {
        for (;;) {
          const end = forward ? (chain[chain.length - 1] as Point) : (chain[0] as Point);
          const found = next(end);
          if (found < 0) break;
          used.add(found);
          const segment = mine[found] as (typeof mine)[number];
          const other = key(segment.a) === key(end) ? segment.b : segment.a;
          if (forward) chain.push(other);
          else chain.unshift(other);
        }
      }

      polylines.push({
        type,
        points: chain.map((p) => {
          // A corner is stored twice, once as the end of one segment and once
          // as the start of the next, each copy with its own flags. Either
          // copy asking for a sharp or a tight corner is taken at its word.
          const flags = cornerFlags.get(key(p)) ?? 0;
          return {
            x: p.x,
            z: p.z,
            ...((flags & ROAD_CORNER_ANGLED) !== 0 ? { angled: true } : {}),
            ...((flags & ROAD_CORNER_TIGHT) !== 0 ? { tight: true } : {}),
          };
        }),
      });
    }
  }

  return polylines;
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
  const timeOfDay = data.readUInt32LE(0);
  const index = Math.max(0, Math.min(3, timeOfDay - 1));
  const base = 4 + index * LIGHTS_PER_TIME_OF_DAY * FLOATS_PER_LIGHT * 4;

  /** One light: ambient RGB, diffuse RGB, then a direction. */
  const read = (slot: number): { ambient: { r: number; g: number; b: number }; light: MapLight } => {
    const at = base + slot * FLOATS_PER_LIGHT * 4;
    const f = (k: number): number => data.readFloatLE(at + k * 4);
    // Generals is Z-up with Y north; the engine is Y-up with Z north.
    const direction = { x: f(6), y: f(8), z: f(7) };
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    return {
      ambient: { r: f(0), g: f(1), b: f(2) },
      light: {
        direction: {
          x: direction.x / length,
          y: direction.y / length,
          z: direction.z / length,
        },
        color: { r: f(3), g: f(4), b: f(5) },
      },
    };
  };

  // Six lights per time of day, interleaved: terrain and object share each
  // slot, so the ground is lit by 0, 2 and 4 and everything standing on it by
  // 1, 3 and 5. Verified across the shipped maps, where light 0 always matches
  // light 1, light 2 matches light 4 and light 3 matches light 5 — which only
  // holds if the two sets are interleaved rather than laid end to end.
  //
  // Reading the first light and stopping, which is what this did, drops two
  // thirds of the illumination on every map that uses fill lights.
  const terrain = [read(0), read(2), read(4)];
  const object = [read(1), read(3), read(5)];
  const lit = (entry: (typeof terrain)[number]): boolean =>
    entry.light.color.r + entry.light.color.g + entry.light.color.b > 0;

  /**
   * Identical lights count once.
   *
   * Every shipped map writes its two fills as the same light — slot 2 always
   * matches slot 4, and slot 3 slot 5 — so applying both doubles a fill that
   * was only ever meant to be cast once. On Alpine Assault, whose fill is
   * magenta, doubling it turns the whole town pink and blows the ground out.
   */
  const distinct = (entries: typeof terrain): MapLight[] => {
    const out: MapLight[] = [];
    for (const { light } of entries.filter(lit)) {
      const same = out.some(
        (other) =>
          other.color.r === light.color.r &&
          other.color.g === light.color.g &&
          other.color.b === light.color.b &&
          other.direction.x === light.direction.x &&
          other.direction.y === light.direction.y &&
          other.direction.z === light.direction.z,
      );
      if (!same) out.push(light);
    }
    return out;
  };

  const primary = terrain[0] as (typeof terrain)[number];
  return {
    sun: primary.light.direction,
    sunColor: primary.light.color,
    // Only the primary carries an ambient; the fills are pure diffuse.
    ambient: primary.ambient,
    terrain: distinct(terrain),
    object: distinct(object),
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

/** One entry of the map's blend table: a texture tile laid over the base, and its shape. */
export interface BlendTile {
  /** A tile index like a base cell's: a source tile shifted left two, plus a quadrant. */
  readonly tile: number;
  readonly horizontal: boolean;
  readonly vertical: boolean;
  readonly rightDiagonal: boolean;
  readonly leftDiagonal: boolean;
  readonly inverted: boolean;
  readonly longDiagonal: boolean;
  /** An edge texture class supplying the alpha, or -1 for the vertex fade. */
  readonly customEdge: number;
}

export interface BlendTiles {
  /** Cells across one row of the *uncropped* grid. */
  readonly stride: number;
  /** One tile index per cell, row-major over the uncropped grid. */
  readonly tiles: Uint16Array;
  /** Per cell, an index into `blends`, or 0 for none. */
  readonly blend: Uint16Array;
  /** Per cell, a second blend over the first: the source game's 3-way blend. */
  readonly extraBlend: Uint16Array;
  /** The texture table: each owns *source tiles* [first, first + count). */
  readonly records: readonly { name: string; first: number; count: number; side: number }[];
  /** The blend table. Entry 0 is "no blend" and is never read from the file. */
  readonly blends: readonly (BlendTile | null)[];
  /** Per cell, an index into `cliffs`, or 0 for an ordinary cell. */
  readonly cliff: Uint16Array;
  /**
   * Hand-fitted texture coordinates for cliff cells, entry 0 unused. Four
   * corners, in texture-width units from the class's lower-left corner; see
   * `WorldHeightMap::getUVForTileIndex`.
   */
  readonly cliffs: readonly ({ tile: number; u: number[]; v: number[]; flip: boolean } | null)[];
}

/** Written after every blend table entry, and checked, by the source game. */
const BLEND_SENTINEL = 0x7ada0000;

/**
 * Decode `BlendTileData`, following `WorldHeightMap::ParseBlendTileData`.
 *
 * This used to find the texture table by scanning for something that looked
 * like one. It no longer needs to: the game's own parser gives the exact
 * layout, which depends on the chunk version —
 *
 * ```
 * int32  cell count
 * int16  tile index per cell
 * int16  blend index per cell
 * int16  extra blend index per cell      version 6+
 * int16  cliff info index per cell       version 5+
 * bytes  cliff flags, a bit per cell     version 7+
 * int32  bitmap tiles, blended tiles, cliff infos (5+), texture classes
 *        per class: first, count, width, a legacy int, a string
 * int32  edge tiles, edge classes        version 4+
 *        per class: first, count, width, a string
 *        per blended tile after the first: tile, five flag bytes,
 *        long diagonal (3+), custom edge class (4+), and 0x7ADA0000
 * ```
 *
 * The sentinel after each blend entry is the check that the whole walk is
 * aligned, and it is asserted rather than trusted.
 *
 * The grid is the heightfield's and does not carry its own width, so callers
 * pass it. Assuming a square grid is right for a square map and shears every
 * other one.
 */
export function readBlendTiles(data: Buffer, rowStride: number, version = 8): BlendTiles | null {
  const r = new Reader(data);
  try {
    const cells = r.int32();
    const stride = rowStride > 0 ? rowStride : Math.round(Math.sqrt(cells));
    const rows = Math.floor(cells / stride);
    const shorts = (): Uint16Array => {
      const out = new Uint16Array(cells);
      for (let i = 0; i < cells; i++) out[i] = r.uint16();
      return out;
    };

    const tiles = shorts();
    const blend = shorts();
    const extraBlend = version >= 6 ? shorts() : new Uint16Array(cells);
    const cliff = version >= 5 ? shorts() : new Uint16Array(cells);
    if (version >= 7) {
      // Version 7 was written with a byte width one short; the parser keeps
      // reading it the way it was written.
      const byteWidth = version === 7 ? (stride + 1) >> 3 : (stride + 7) >> 3;
      r.at += rows * byteWidth;
    }

    r.int32(); // bitmap tiles
    const blendedTiles = r.int32();
    const cliffCount = version >= 5 ? r.int32() : 1;
    const classCount = r.int32();
    const records: BlendTiles['records'][number][] = [];
    for (let i = 0; i < classCount; i++) {
      const first = r.int32();
      const count = r.int32();
      const side = r.int32();
      r.int32(); // legacy
      records.push({ first, count, side, name: r.string() });
    }

    if (version >= 4) {
      r.int32(); // edge tiles
      const edgeClasses = r.int32();
      for (let i = 0; i < edgeClasses; i++) {
        r.int32();
        r.int32();
        r.int32();
        r.string();
      }
    }

    const blends: (BlendTile | null)[] = [null];
    for (let i = 1; i < blendedTiles; i++) {
      const tile = r.int32();
      const horizontal = r.uint8() !== 0;
      const vertical = r.uint8() !== 0;
      const rightDiagonal = r.uint8() !== 0;
      const leftDiagonal = r.uint8() !== 0;
      const inverted = r.uint8();
      const longDiagonal = version >= 3 ? r.uint8() !== 0 : false;
      const customEdge = version >= 4 ? r.int32() : -1;
      if (r.uint32() !== BLEND_SENTINEL) return null;
      blends.push({
        tile,
        horizontal,
        vertical,
        rightDiagonal,
        leftDiagonal,
        // Bit 0 is the inversion. Bit 1 forces a triangle flip for 3-way
        // blends, which only matters to a renderer that splits cells into
        // triangles the way the source game does; this one interpolates the
        // four corners bilinearly.
        inverted: (inverted & 1) !== 0,
        longDiagonal,
        customEdge,
      });
    }

    const cliffs: BlendTiles['cliffs'][number][] = [null];
    if (version >= 5) {
      for (let i = 1; i < cliffCount; i++) {
        const tile = r.int32();
        const corners: number[] = [];
        for (let k = 0; k < 8; k++) corners.push(r.float());
        const flip = r.uint8() !== 0;
        r.uint8(); // mutant
        cliffs.push({
          tile,
          u: [corners[0], corners[2], corners[4], corners[6]] as number[],
          v: [corners[1], corners[3], corners[5], corners[7]] as number[],
          flip,
        });
      }
    }

    return { stride, tiles, blend, extraBlend, records, blends, cliff, cliffs };
  } catch {
    return null;
  }
}

/**
 * The textures a map paints its ground with, and how much of it each covers.
 *
 * The per-cell array is what makes this worth anything. Averaging the *list*
 * weights a texture used on four cells the same as one used on a third of the
 * map, and on a map with eleven incidental grass variants and one dominant
 * cliff it produces a colour that appears nowhere on it.
 */
export function readTerrainCoverage(
  data: Buffer,
  rowStride: number,
  version = 8,
): { name: string; share: number }[] {
  const blend = readBlendTiles(data, rowStride, version);
  if (!blend) return [];

  const used = new Map<number, number>();
  for (const tile of blend.tiles) used.set(tile, (used.get(tile) ?? 0) + 1);

  return blend.records.map((record) => {
    let count = 0;
    for (const [tile, n] of used) {
      const base = tile >> 2;
      if (base >= record.first && base < record.first + record.count) count += n;
    }
    return { name: record.name, share: count / blend.tiles.length };
  });
}

function readTerrainPalette(
  data: Buffer,
  index: AssetIndex,
  rowStride: number,
  version: number,
): { ground: number[]; cliff: number[]; names: string[] } {
  const types = terrainTypes(index);
  const coverage = readTerrainCoverage(data, rowStride, version).sort((a, b) => b.share - a.share);
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

/**
 * The ground texturing, as the renderer wants it.
 *
 * Two images. The **atlas** holds every terrain texture the map uses, one per
 * slot in a grid; the **index map** holds one texel per cell saying which slot
 * that cell is painted with and how many cells that texture spans before it
 * repeats.
 *
 * Splitting it this way is what keeps the ground a single draw call. The
 * alternative — a mesh chunk per texture — is how a terrain renderer ends up
 * with thirty draw calls for the floor.
 */
export interface TerrainTextures {
  readonly atlas: Image;
  readonly index: Image;
  /** The blend laid over the base, per cell; see `encodeBlends`. */
  readonly blend: Image;
  /** A second blend over the first, where three ground types meet. */
  readonly extraBlend: Image;
  /** How far each steep cell stretches its texture, to stop it smearing. */
  readonly stretch: Image;
  readonly columns: number;
  readonly rows: number;
  /** Side of one atlas slot's usable area, in pixels. */
  readonly slot: number;
  /** Padding around each slot, in pixels. */
  readonly pad: number;
  readonly names: readonly string[];
}

/** Which texture a cell shows, and which cell-sized square of it. */
export interface TileSquare {
  /** Index into the map's texture classes. */
  readonly record: number;
  /** Column of the square, left to right. */
  readonly subX: number;
  /** Row of the square, top to bottom as the decoder presents the texture. */
  readonly subY: number;
  /** Squares across the texture: two per source tile. */
  readonly span: number;
}

/**
 * Turn a map tile index into a texture and a square of it.
 *
 * The low two bits of a tile index are a quadrant, not part of the index:
 * `WorldHeightMap::getUVForNdx` takes `tileNdx >> 2` as the 64x64 source
 * tile, bit 0 picking the left or right half and bit 1 the top or bottom,
 * because a tile covers two cells each way. Matching the raw index against
 * the class ranges puts three quarters of the map on the wrong texture.
 *
 * Their tile rows run bottom-up — the loader walks the TGA in file order and
 * a TGA starts at the bottom — so the row is flipped into the top-down space
 * the decoder hands us. That makes `subY` *fall* as a map's z rises, which is
 * why the shader's position within a cell has to fall with z too.
 */
export function squareOf(
  tile: number,
  records: readonly { first: number; count: number; side: number }[],
): TileSquare | null {
  const base = tile >> 2;
  const record = records.findIndex(
    (candidate) => base >= candidate.first && base < candidate.first + candidate.count,
  );
  if (record < 0) return null;
  const entry = records[record] as (typeof records)[number];
  const side = Math.max(1, entry.side);
  const local = base - entry.first;
  const quadrant = tile & 3;
  const subX = (local % side) * 2 + (quadrant & 1);
  const theirRow = Math.floor(local / side) * 2 + ((quadrant >> 1) & 1);
  return { record, subX, subY: side * 2 - 1 - theirRow, span: side * 2 };
}

/**
 * Side of one atlas slot.
 *
 * A cell samples a 32x32 pixel quarter-tile of the source, so a class of
 * `side` tiles needs `side * 64` pixels to be pixel-exact — 640 for the widest
 * cliff sets. 256 is the compromise: about 21 pixels a cell on a six-tile
 * texture, which is close to how big a cell is on screen at normal zoom.
 */
const TERRAIN_SLOT = 256;
/**
 * Padding around each slot, filled by continuing the texture's own tiling.
 *
 * Without it a bilinear tap at a slot edge reaches into the neighbouring
 * texture, which shows up as a bright fringe wherever two ground types meet.
 * Eight pixels also keeps the first few mip levels clean.
 */
const TERRAIN_PAD = 8;

/** The most textures one map's atlas will hold. */
const MAX_TERRAIN_TEXTURES = 64;

/**
 * Build the ground atlas and the per-cell index map.
 *
 * Cropped to the playable area exactly as the heightfield is, so cell (x, z)
 * means the same thing in both.
 */
function readTerrainTextures(
  data: Buffer,
  index: AssetIndex,
  border: number,
  width: number,
  height: number,
  rowStride: number,
  version: number,
  cornerHeight: (cx: number, cz: number) => number,
): TerrainTextures | null {
  const blend = readBlendTiles(data, rowStride, version);
  if (!blend) return null;
  const types = terrainTypes(index);

  /** The texture class a cell is painted with, and where in it to look. */
  const lookup = (tile: number): TileSquare | null => squareOf(tile, blend.records);

  // Only the textures this map actually paints with, commonest first, so a
  // map using more than the atlas holds loses the ones nobody will notice.
  const usage = new Map<number, number>();
  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const cell = (cz + border) * blend.stride + (cx + border);
      const found = lookup(blend.tiles[cell] as number);
      if (found) usage.set(found.record, (usage.get(found.record) ?? 0) + 1);
      // A texture that only ever appears blended over another still has to be
      // in the atlas, or the blend has nothing to draw.
      for (const layer of [blend.blend, blend.extraBlend]) {
        const entry = blend.blends[layer[cell] as number];
        const over = entry ? lookup(entry.tile) : null;
        if (over) usage.set(over.record, (usage.get(over.record) ?? 0) + 1);
      }
    }
  }

  const chosen: { record: number; image: Image; side: number; name: string }[] = [];
  for (const [record] of [...usage].sort((a, b) => b[1] - a[1])) {
    if (chosen.length >= MAX_TERRAIN_TEXTURES) break;
    const entry = blend.records[record];
    if (!entry) continue;
    const file = types.get(entry.name.toLowerCase());
    const image = file ? loadTexture(index, file) : null;
    if (!image) continue;
    chosen.push({ record, image, side: Math.max(1, entry.side), name: entry.name });
  }
  if (chosen.length === 0) return null;

  const slotOf = new Map<number, number>();
  chosen.forEach((entry, slot) => slotOf.set(entry.record, slot));

  const columns = Math.ceil(Math.sqrt(chosen.length));
  const rows = Math.ceil(chosen.length / columns);
  const cell = TERRAIN_SLOT + TERRAIN_PAD * 2;
  const atlas: Image = {
    width: columns * cell,
    height: rows * cell,
    data: Buffer.alloc(columns * cell * rows * cell * 4),
  };

  for (let i = 0; i < chosen.length; i++) {
    const { image } = chosen[i] as (typeof chosen)[number];
    const originX = (i % columns) * cell;
    const originY = Math.floor(i / columns) * cell;
    // Sampled with wrap-around on the source, so the padding continues the
    // texture rather than smearing its edge: these tile in world space, and a
    // clamped border would show as a seam every few cells.
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x - TERRAIN_PAD) / TERRAIN_SLOT;
        const v = (y - TERRAIN_PAD) / TERRAIN_SLOT;
        const sx = ((Math.floor(u * image.width) % image.width) + image.width) % image.width;
        const sy = ((Math.floor(v * image.height) % image.height) + image.height) % image.height;
        const from = (sy * image.width + sx) * 4;
        const to = ((originY + y) * atlas.width + originX + x) * 4;
        atlas.data[to] = image.data[from] as number;
        atlas.data[to + 1] = image.data[from + 1] as number;
        atlas.data[to + 2] = image.data[from + 2] as number;
        atlas.data[to + 3] = 255;
      }
    }
  }

  // One texel per cell: which atlas slot, which cell-sized square of it, and
  // how many of those squares the texture is divided into. Integers rather
  // than pre-divided fractions, because eight bits of a fraction is half a
  // pixel of misalignment at the widest textures and that shows as a seam.
  const indexMap: Image = { width, height, data: Buffer.alloc(width * height * 4) };
  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const found = lookup(blend.tiles[(cz + border) * blend.stride + (cx + border)] as number);
      const slot = found ? slotOf.get(found.record) : undefined;
      const at = (cz * width + cx) * 4;
      indexMap.data[at] = slot ?? 0;
      indexMap.data[at + 1] = found && slot !== undefined ? found.subX : 0;
      indexMap.data[at + 2] = found && slot !== undefined ? found.subY : 0;
      indexMap.data[at + 3] = found && slot !== undefined ? found.span : 1;
    }
  }

  /**
   * One blend layer as an image: which texture square to lay over the base,
   * and which of the cell's four corners it is opaque at.
   *
   * That is the whole of the source game's terrain blending. It is not an
   * alpha mask but a vertex fade — `WorldHeightMap::getAlphaUVData` sets each
   * of a cell's four corners to 0 or 255 from the blend's shape flags, and the
   * card interpolates between them. A horizontal edge is two opaque corners on
   * one side, a short diagonal one corner, a long diagonal three. None of the
   * 1.09 million blend entries across the shipped maps uses the custom edge
   * textures, so this is the whole job.
   *
   * Red is the slot, 255 for none; green and blue the square, as the base map
   * has them; alpha packs the texture's side in its high four bits and the
   * corner mask in its low four. Corners run 0 (x, z), 1 (x+1, z),
   * 2 (x+1, z+1), 3 (x, z+1), the vertex order `HeightMap.cpp` builds cells in.
   */
  const encodeBlends = (layer: Uint16Array): Image => {
    const image: Image = { width, height, data: Buffer.alloc(width * height * 4) };
    for (let cz = 0; cz < height; cz++) {
      for (let cx = 0; cx < width; cx++) {
        const at = (cz * width + cx) * 4;
        image.data[at] = 255;
        const entry = blend.blends[layer[(cz + border) * blend.stride + (cx + border)] as number];
        if (!entry || entry.customEdge >= 0) continue;
        const found = lookup(entry.tile);
        const slot = found ? slotOf.get(found.record) : undefined;
        if (!found || slot === undefined) continue;

        let corners = 0;
        const set = (...indices: number[]): void => {
          for (const i of indices) corners |= 1 << i;
        };
        if (entry.horizontal) {
          if (entry.inverted) set(0, 3);
          else set(1, 2);
        }
        if (entry.vertical) {
          if (entry.inverted) set(0, 1);
          else set(2, 3);
        }
        if (entry.rightDiagonal) {
          if (entry.inverted) {
            set(1);
            if (entry.longDiagonal) set(0, 2);
          } else {
            set(2);
            if (entry.longDiagonal) set(1, 3);
          }
        }
        if (entry.leftDiagonal) {
          if (entry.inverted) {
            set(0);
            if (entry.longDiagonal) set(1, 3);
          } else {
            set(3);
            if (entry.longDiagonal) set(0, 2);
          }
        }

        image.data[at] = slot;
        image.data[at + 1] = found.subX;
        image.data[at + 2] = found.subY;
        image.data[at + 3] = ((found.span >> 1) << 4) | corners;
      }
    }
    return image;
  };

  /**
   * The source game's cliff correction, per cell.
   *
   * A cell's texture square is laid on it as if the ground were flat, so on a
   * cliff face one cell of texture is smeared down several cells of rock, and
   * every row of cells restarts it — which draws a cliff as a stack of
   * horizontal streaks. `WorldHeightMap::getUVForTileIndex` fixes that at run
   * time for any map without hand-fitted cliff UVs, which is most of them: it
   * widens the cell's slice of texture by the surface's true length along the
   * slope, sqrt(1 + rise^2), so the rock stays rock-sized.
   *
   * Its thresholds are kept: nothing happens on a cell rising less than 1.5
   * cells in total (STRETCH_LIMIT), an axis is only stretched past 1.5 either,
   * and never past four tiles (TILE_LIMIT). Below those the seam a stretch
   * introduces costs more than the smear it removes. The game fiddles one
   * corner at a time for cells with one high or one low corner; this takes
   * the average rise along each axis instead, which is what those cases
   * approximate.
   *
   * Encoded 1..4 as 0..255, red along x and green along z.
   */
  const STRETCH_LIMIT = 1.5;
  const TILE_LIMIT = 4;
  const stretch: Image = { width, height, data: Buffer.alloc(width * height * 4) };
  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const h0 = cornerHeight(cx, cz);
      const h1 = cornerHeight(cx + 1, cz);
      const h2 = cornerHeight(cx + 1, cz + 1);
      const h3 = cornerHeight(cx, cz + 1);
      const at = (cz * width + cx) * 4;
      stretch.data[at + 3] = 255;
      if (Math.max(h0, h1, h2, h3) - Math.min(h0, h1, h2, h3) < STRETCH_LIMIT) continue;
      const along = (rise: number): number => {
        const length = Math.sqrt(1 + rise * rise);
        return length < STRETCH_LIMIT ? 1 : Math.min(TILE_LIMIT, length);
      };
      const sx = along((h1 - h0 + (h2 - h3)) / 2);
      const sz = along((h3 - h0 + (h2 - h1)) / 2);
      stretch.data[at] = Math.round(((sx - 1) / (TILE_LIMIT - 1)) * 255);
      stretch.data[at + 1] = Math.round(((sz - 1) / (TILE_LIMIT - 1)) * 255);
    }
  }

  return {
    atlas,
    index: indexMap,
    blend: encodeBlends(blend.blend),
    extraBlend: encodeBlends(blend.extraBlend),
    stretch,
    columns,
    rows,
    slot: TERRAIN_SLOT,
    pad: TERRAIN_PAD,
    names: chosen.map((entry) => entry.name),
  };
}

export interface ImportResult {
  readonly world: World;
  readonly lighting: MapLighting;
  readonly doodads: readonly ImportedObject[];
  readonly roads: readonly RoadPolyline[];
  readonly skipped: number;
  readonly palette: { ground: number[]; cliff: number[]; names: string[] };
  /** The ground atlas and index map, or null for a map with no blend data. */
  readonly terrain: TerrainTextures | null;
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

  const objectChunks = findMapChunks(map.chunks, 'Object');
  const objects = readObjects(objectChunks, map.names);
  const roads = readRoads(objectChunks);
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
    // The exact position, not the cell it falls in. Rounding put every piece
    // of scenery up to half a cell off, which is invisible on a lone tree and
    // obvious anywhere things are meant to line up: fence panels stopped
    // meeting and rows of houses stopped being parallel to their road. The
    // cell is still what the simulation's vision flags are set on, below.
    doodads.push(object);
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
        terrain: [],
        object: [],
      };

  const blend = findMapChunk(map.chunks, 'BlendTileData');
  const palette = blend
    ? readTerrainPalette(blend.data, index, heights.width, blend.version)
    : { ground: [0.21, 0.29, 0.2], cliff: [0.3, 0.27, 0.24], names: [] };
  // The palette stays even with the atlas in hand: it is what the fixture map
  // and anything without blend data falls back to, and it is what the minimap
  // draws with.
  const terrain = blend
    ? readTerrainTextures(
        blend.data,
        index,
        border,
        world.width,
        world.height,
        heights.width,
        blend.version,
        (cx, cz) => (world.heights[cz * cornerStride(world) + cx] ?? 0) / 65536,
      )
    : null;

  return { world, lighting, doodads, roads, skipped, palette, terrain };
}

/**
 * How many start positions a map has.
 *
 * A start is an ordinary waypoint carrying `waypointName = "Player_N_Start"`,
 * not an object type of its own, which is why this has to walk the property
 * lists rather than count objects.
 */
function startCount(
  chunks: readonly { name: string; data: Buffer }[],
  names: ReadonlyMap<number, string>,
): number {
  let found = 0;
  for (const object of readObjects(chunks, names)) {
    if (START_WAYPOINT.test(object.waypointName)) found++;
  }
  return found;
}

/** A map name as the content pack files it. */
function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

  let wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  // `--skirmish` takes every map that can actually be played, which is a
  // question for the data rather than for the file names: the installation's
  // 150 maps are mostly campaign missions, and a skirmish map is one with two
  // or more `Player_N_Start` waypoints on it. Name-matching the campaign
  // prefixes would need updating for every expansion; this does not.
  if (process.argv.includes('--skirmish')) {
    wanted = [...maps.keys()]
      .filter((name) => {
        try {
          const entry = index.entries.get(maps.get(name) as string);
          if (!entry) return false;
          const map = readMap(readEntry(index.archivePaths.get(entry.archive) as string, entry));
          return startCount(findMapChunks(map.chunks, 'Object'), map.names) >= 2;
        } catch {
          return false;
        }
      })
      .sort();
    console.log(`${wanted.length} skirmish maps\n`);
  }

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

    // One map that will not import must not take the other sixty-three with
    // it. The engine caps a world at 512 cells a side and a couple of the
    // eight-player maps are larger, which is a refusal rather than a fault.
    let result: ImportResult;
    try {
      result = importMap(buffer, name, index);
    } catch (error) {
      console.error(`  skipped ${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const slug = slugOf(name);
    writeFileSync(join(ASSETS_DIR, 'maps', `${slug}.rtsmap`), encodeMap(result.world));
    if (result.terrain) {
      writeFileSync(join(ASSETS_DIR, 'maps', `${slug}.terrain.png`), writePng(result.terrain.atlas));
      writeFileSync(join(ASSETS_DIR, 'maps', `${slug}.tiles.png`), writePng(result.terrain.index));
      writeFileSync(join(ASSETS_DIR, 'maps', `${slug}.blend.png`), writePng(result.terrain.blend));
      writeFileSync(join(ASSETS_DIR, 'maps', `${slug}.blend2.png`), writePng(result.terrain.extraBlend));
      writeFileSync(join(ASSETS_DIR, 'maps', `${slug}.stretch.png`), writePng(result.terrain.stretch));
    }
    writeFileSync(
      join(ASSETS_DIR, 'maps', `${slug}.json`),
      `${JSON.stringify(
        {
          name,
          lighting: result.lighting,
          palette: result.palette,
          doodads: result.doodads,
          roads: result.roads,
          ...(result.terrain
            ? {
                terrain: {
                  atlas: `maps/${slug}.terrain.png`,
                  index: `maps/${slug}.tiles.png`,
                  blend: `maps/${slug}.blend.png`,
                  extraBlend: `maps/${slug}.blend2.png`,
                  stretch: `maps/${slug}.stretch.png`,
                  columns: result.terrain.columns,
                  rows: result.terrain.rows,
                  slot: result.terrain.slot,
                  pad: result.terrain.pad,
                  names: result.terrain.names,
                },
              }
            : {}),
        },
        null,
        1,
      )}\n`,
    );

    imported.push({ name, slug, width: result.world.width, height: result.world.height });

    console.log(
      `  ${name}: ${result.world.width}x${result.world.height} cells,` +
        ` ${result.world.startLocations.length} starts,` +
        ` ${result.doodads.length} doodads,` +
        ` ${result.roads.length} roads` +
        (result.skipped > 0 ? `, ${result.skipped} outside the playable area` : '') +
        `, ${result.palette.names.length} terrain textures`,
    );
  }

  // Which map the game opens on. `--default <name>` names it; otherwise the
  // first imported wins, which is what a single-map import wants.
  if (imported.length > 0) {
    const flag = process.argv.indexOf('--default');
    const named = flag >= 0 ? slugOf(process.argv[flag + 1] ?? '') : '';
    const fallback = imported[0]?.slug;
    const chosen = imported.some((entry) => entry.slug === named) ? named : fallback;
    if (named && chosen !== named) console.error(`  default not imported: ${named}`);
    writeFileSync(
      join(ASSETS_DIR, 'maps', 'index.json'),
      `${JSON.stringify({ maps: imported, default: chosen }, null, 1)}\n`,
    );
  }
}

if (process.argv[1]?.endsWith('importmap.ts')) void runTool(main);
