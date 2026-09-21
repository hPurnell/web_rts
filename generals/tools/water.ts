/**
 * Water: lakes, seas and rivers, which a Generals map stores as polygons.
 *
 * Water is not painted into the terrain. It is a `PolygonTrigger` flagged as a
 * water area — the same chunk that carries a map's script trigger zones —
 * with a surface height on its points, and a river is one of those with a
 * second flag and the index its flow starts from. Everything here follows
 * `PolygonTrigger.cpp`, `TerrainLogic.cpp` and `W3DWater.cpp`.
 *
 * Three things come out of it:
 *
 * - **The surfaces**, in cells, for the renderer to draw.
 * - **Which cells are water**, which the simulation must not drive into.
 *   `AIPathfind.cpp` classifies a cell as water when any one of its four
 *   corners is under the surface, and so does this.
 * - **How it looks**: the colour the game lights it with and how quickly it
 *   turns opaque with depth, from `Water.ini` and the map's own lighting.
 */
import { Reader } from './map.ts';
import type { MapChunk } from './map.ts';

/** Generals units per cell, across and up. */
const UNITS_PER_CELL = 10;

/** One water polygon as the map stores it, in Generals units. */
export interface WaterPolygon {
  readonly name: string;
  readonly river: boolean;
  /** For a river, the point its flow starts from. */
  readonly riverStart: number;
  readonly points: readonly { x: number; y: number; z: number }[];
}

/** `PolygonTrigger::ParsePolygonTriggersDataChunk`, keeping only water. */
export function readWaterPolygons(chunk: MapChunk): WaterPolygon[] {
  const r = new Reader(chunk.data);
  let count = r.int32();
  const out: WaterPolygon[] = [];
  while (count-- > 0) {
    const name = r.string();
    if (chunk.version >= 4) r.string(); // layer name
    r.int32(); // trigger id
    const water = chunk.version >= 2 ? r.uint8() !== 0 : false;
    let river = false;
    let riverStart = 0;
    if (chunk.version >= 3) {
      river = r.uint8() !== 0;
      riverStart = r.int32();
    }
    const numPoints = r.int32();
    const points: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < numPoints; i++) points.push({ x: r.int32(), y: r.int32(), z: r.int32() });
    // The game discards a polygon of under two points, and draws nothing
    // with under three.
    if (water && numPoints >= 3) out.push({ name, river, riverStart, points });
  }
  return out;
}

/** `PolygonTrigger::pointInTrigger`: a crossing test that skips horizontal edges. */
export function pointInPolygon(polygon: WaterPolygon, x: number, y: number): boolean {
  const points = polygon.points;
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as { x: number; y: number };
    const b = points[(i + 1) % points.length] as { x: number; y: number };
    if (a.y === b.y) continue;
    if (a.y < y && b.y < y) continue;
    if (a.y >= y && b.y >= y) continue;
    if (a.x < x && b.x < x) continue;
    const crossing = a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
    if (crossing >= x) inside = !inside;
  }
  return inside;
}

/**
 * The surface height over a point, or null if it is dry.
 *
 * `TerrainLogic::getWaterHandle`: of the water polygons containing the point,
 * the highest wins, and a polygon's height is its first point's. That is true
 * of rivers too, although they are drawn sloping.
 */
export function waterHeightAt(polygons: readonly WaterPolygon[], x: number, y: number): number | null {
  const ix = Math.floor(x + 0.5);
  const iy = Math.floor(y + 0.5);
  let best: number | null = null;
  for (const polygon of polygons) {
    if (!pointInPolygon(polygon, ix, iy)) continue;
    const z = (polygon.points[0] as { z: number }).z;
    if (best === null || z >= best) best = z;
  }
  return best;
}

/**
 * Which cells are water, as a list of cell indices.
 *
 * A cell is water when any of its corners is below the surface over it —
 * `PathfindCell::CELL_WATER`, set from the four corners in `AIPathfind.cpp`.
 * `cornerHeight` is in cells, and the map's corner heights are used rather
 * than the game's own because they are what this engine's units stand on.
 */
export function underwaterCells(
  polygons: readonly WaterPolygon[],
  width: number,
  height: number,
  cornerHeight: (cx: number, cz: number) => number,
): number[] {
  if (polygons.length === 0) return [];
  const stride = width + 1;
  const wet = new Uint8Array(stride * (height + 1));
  for (let cz = 0; cz <= height; cz++) {
    for (let cx = 0; cx <= width; cx++) {
      const surface = waterHeightAt(polygons, cx * UNITS_PER_CELL, cz * UNITS_PER_CELL);
      if (surface !== null && cornerHeight(cx, cz) * UNITS_PER_CELL < surface) {
        wet[cz * stride + cx] = 1;
      }
    }
  }
  const cells: number[] = [];
  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const at = cz * stride + cx;
      if (wet[at] || wet[at + 1] || wet[at + stride] || wet[at + stride + 1]) {
        cells.push(cz * width + cx);
      }
    }
  }
  return cells;
}

/** A water surface for the renderer, in cells: x and z across, y up. */
export interface WaterSurface {
  readonly river: boolean;
  readonly riverStart: number;
  readonly points: readonly { x: number; y: number; z: number }[];
}

export function toSurface(polygon: WaterPolygon): WaterSurface {
  return {
    river: polygon.river,
    riverStart: polygon.riverStart,
    points: polygon.points.map((p) => ({
      x: p.x / UNITS_PER_CELL,
      y: p.z / UNITS_PER_CELL,
      z: p.y / UNITS_PER_CELL,
    })),
  };
}

/** What `Water.ini` says, for the parts this draws. */
export interface WaterIni {
  /** `DiffuseColor` per time of day, morning first, 0..1 with alpha. */
  readonly diffuse: readonly (readonly [number, number, number, number])[];
  readonly transparentDepth: number;
  readonly minOpacity: number;
  /** `StandingWaterColor`; white means "light it like the terrain". */
  readonly standingColor: readonly [number, number, number];
  readonly texture: string;
}

const DEFAULT_INI: WaterIni = {
  diffuse: [
    [175 / 255, 175 / 255, 175 / 255, 1],
    [185 / 255, 185 / 255, 185 / 255, 1],
    [225 / 255, 225 / 255, 225 / 255, 1],
    [100 / 255, 100 / 255, 100 / 255, 1],
  ],
  transparentDepth: 3,
  minOpacity: 1,
  standingColor: [1, 1, 1],
  texture: 'TWWater01.tga',
};

/** The `WaterSet` blocks and the `WaterTransparency` block of `Water.ini`. */
export function readWaterIni(text: string | null): WaterIni {
  if (!text) return DEFAULT_INI;
  const clean = text.replace(/;.*$/gm, '');
  const colour = (body: string, key: string): number[] | null => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*R:(\\d+)\\s+G:(\\d+)\\s+B:(\\d+)(?:\\s+A:(\\d+))?`, 'im').exec(body);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 255)].map((v) => v / 255) : null;
  };
  const diffuse = ['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT'].map((tod, i) => {
    const block = new RegExp(`^WaterSet\\s+${tod}\\b([\\s\\S]*?)^End`, 'im').exec(clean)?.[1] ?? '';
    return (colour(block, 'DiffuseColor') ?? DEFAULT_INI.diffuse[i]) as unknown as [number, number, number, number];
  });
  const block = /^WaterTransparency\b([\s\S]*?)^End/im.exec(clean)?.[1] ?? '';
  const real = (key: string, fallback: number): number => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*([\\d.]+)`, 'im').exec(block);
    return m ? Number(m[1]) : fallback;
  };
  const standing = colour(block, 'StandingWaterColor');
  return {
    diffuse,
    transparentDepth: real('TransparentWaterDepth', DEFAULT_INI.transparentDepth),
    minOpacity: real('TransparentWaterMinOpacity', DEFAULT_INI.minOpacity),
    standingColor: standing ? [standing[0] ?? 1, standing[1] ?? 1, standing[2] ?? 1] : DEFAULT_INI.standingColor,
    texture: /^\s*StandingWaterTexture\s*=\s*(\S+)/im.exec(block)?.[1] ?? DEFAULT_INI.texture,
  };
}

/** How a map's water is lit, split so the sun's part can be shadowed. */
export interface WaterLook {
  /** The ambient part of the water's colour, 0..1. */
  readonly ambient: readonly [number, number, number];
  /** The sun's part, before any shadow takes it away. */
  readonly sun: readonly [number, number, number];
  /** Opacity of the surface itself, before depth fades it at the shore. */
  readonly alpha: number;
  /** Depth, in cells, at which the water reaches `minOpacity`. */
  readonly transparentDepth: number;
  readonly minOpacity: number;
}

interface Light {
  readonly direction: { x: number; y: number; z: number };
  readonly color: { r: number; g: number; b: number };
}

/**
 * The water's colour, as `drawTrapezoidWater` and `drawRiverWater` light it.
 *
 * Unless `StandingWaterColor` overrides it, water is lit like the terrain:
 * the first light's ambient plus, for every terrain light shining down, its
 * colour times how steeply it shines, all times the time of day's
 * `DiffuseColor`. Lighting here is y-up, so "steeply" is `-direction.y`.
 */
export function waterLook(
  ini: WaterIni,
  timeOfDay: number,
  ambient: { r: number; g: number; b: number },
  terrainLights: readonly Light[],
): WaterLook {
  const tint = ini.diffuse[Math.max(0, Math.min(3, timeOfDay - 1))] ?? DEFAULT_INI.diffuse[0]!;
  const [sr, sg, sb] = ini.standingColor;
  const overridden = !(sr === 1 && sg === 1 && sb === 1);
  const depth = {
    alpha: tint[3],
    transparentDepth: ini.transparentDepth / UNITS_PER_CELL,
    minOpacity: ini.minOpacity,
  };
  if (overridden) {
    return { ambient: [sr, sg, sb], sun: [0, 0, 0], ...depth };
  }
  const sun: [number, number, number] = [0, 0, 0];
  for (const light of terrainLights) {
    const down = -light.direction.y;
    if (down <= 0) continue;
    sun[0] += down * light.color.r * tint[0];
    sun[1] += down * light.color.g * tint[1];
    sun[2] += down * light.color.b * tint[2];
  }
  return {
    ambient: [ambient.r * tint[0], ambient.g * tint[1], ambient.b * tint[2]],
    sun,
    ...depth,
  };
}
