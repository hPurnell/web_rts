/**
 * World state (invariant 5): terrain and authored data. Owned by the editor,
 * saved to disk, and read — never written — by the simulation.
 *
 * Terrain is a continuous heightfield: Q16.16 heights on cell corners, owned
 * by src/sim/terrain.ts, which also owns everything derived from them. This
 * module holds the authored data around it — the flags, the resource nodes,
 * the start locations — and the validation that says whether a map is
 * playable.
 */
import type { Fixed } from './fixed.ts';
import { ONE, div, fromInt, isqrt, mul, toInt } from './fixed.ts';
import { fnv1a32, hashArray, hashU32 } from './hash.ts';
import {
  HEIGHT_MAX,
  HEIGHT_MIN,
  MAX_TRAVERSABLE_SLOPE,
  slopeAtMost,
  stepSlopeAtMost,
} from './terrain.ts';

export const MAX_DIMENSION = 512;
/**
 * Minimum cell distance between two start locations. Closer than this and the
 * opening of a match is decided by whoever attacks first, which is a map bug
 * rather than a design choice.
 */
export const MIN_START_SEPARATION = 16;

/** Cell flag bits. */
export const WALKABLE = 1 << 0;
export const BUILDABLE = 1 << 1;
// Bit 2 was RAMP. Ramps are no longer authored: a ramp is ground sculpted
// gently enough to walk up, which the slope rules work out for themselves.
export const VISION_BLOCKER = 1 << 3;

export const enum ResourceType {
  Minerals = 0,
  Gas = 1,
}

export interface ResourceNode {
  /** Cell index into the terrain grids. */
  cell: number;
  type: ResourceType;
  amount: number;
}

export interface StartLocation {
  cell: number;
}

export interface WorldInit {
  readonly width: number;
  readonly height: number;
  /** Edge length of one cell in fixed-point world units. Defaults to 1. */
  readonly cellSize?: Fixed;
}

export interface World {
  readonly width: number;
  readonly height: number;
  readonly cellSize: Fixed;
  /** Q16.16 heights on cell corners: (width + 1) * (height + 1) of them. */
  readonly heights: Int32Array;
  readonly flags: Uint8Array;
  resourceNodes: ResourceNode[];
  startLocations: StartLocation[];
}

/** A fresh world: flat at height zero, walkable and buildable, nothing placed. */
export function createWorld(init: WorldInit): World {
  const { width, height } = init;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('world dimensions must be integers');
  }
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`world dimensions must be 1..${MAX_DIMENSION}, got ${width}x${height}`);
  }
  const cells = width * height;
  const flags = new Uint8Array(cells);
  flags.fill(WALKABLE | BUILDABLE);
  return {
    width,
    height,
    cellSize: init.cellSize ?? ONE,
    heights: new Int32Array((width + 1) * (height + 1)),
    flags,
    resourceNodes: [],
    startLocations: [],
  };
}

export function inBounds(world: World, cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < world.width && cy < world.height;
}

/** Cell index from grid coordinates. Returns -1 when out of bounds. */
export function cellIndex(world: World, cx: number, cy: number): number {
  return inBounds(world, cx, cy) ? cy * world.width + cx : -1;
}

export function cellX(world: World, cell: number): number {
  return cell % world.width;
}

export function cellY(world: World, cell: number): number {
  return (cell / world.width) | 0;
}

/** Flags at a cell. Out-of-bounds reads return 0 — nothing outside the map is
 * walkable, buildable or visible. */
export function flagsAt(world: World, cx: number, cy: number): number {
  return inBounds(world, cx, cy) ? (world.flags[cy * world.width + cx] as number) : 0;
}

export function hasFlag(world: World, cx: number, cy: number, flag: number): boolean {
  return (flagsAt(world, cx, cy) & flag) !== 0;
}

export function setFlags(world: World, cell: number, flags: number): void {
  if (cell >= 0 && cell < world.flags.length) world.flags[cell] = flags & 0xff;
}

/** Set a corner height, clamped to the sculptable range. */
export function setCornerHeight(world: World, corner: number, height: Fixed): void {
  if (corner < 0 || corner >= world.heights.length) return;
  world.heights[corner] = height < HEIGHT_MIN ? HEIGHT_MIN : height > HEIGHT_MAX ? HEIGHT_MAX : height;
}

/** World-space centre of a cell, in fixed-point units. */
export function worldFromCell(world: World, cell: number): { x: Fixed; z: Fixed } {
  const half = world.cellSize >> 1;
  return {
    x: (mul(fromInt(cellX(world, cell)), world.cellSize) + half) | 0,
    z: (mul(fromInt(cellY(world, cell)), world.cellSize) + half) | 0,
  };
}

/** Cell containing a world-space position. Returns -1 when outside the map. */
export function cellFromWorld(world: World, x: Fixed, z: Fixed): number {
  if (x < 0 || z < 0) return -1;
  const cx = toInt(div(x, world.cellSize));
  const cy = toInt(div(z, world.cellSize));
  return cellIndex(world, cx, cy);
}

/**
 * Whether a unit can stand on a cell at all: walkable, and not a cliff face.
 *
 * With tiers this was implied by the tier grid. With a heightfield it is a
 * threshold on the cell's own slope, and it is only half the rule — see
 * `cellsConnect` for the other half.
 */
export function isTraversable(world: World, cell: number): boolean {
  if (cell < 0 || cell >= world.flags.length) return false;
  if (((world.flags[cell] as number) & WALKABLE) === 0) return false;
  return slopeAtMost(world, cell, MAX_TRAVERSABLE_SLOPE);
}

/**
 * Whether a unit can step from one cell to an adjacent one.
 *
 * Both cells must be traversable *and* the step between them must be walkable.
 * That second condition is not implied by the first: two cells can both be
 * flat with a cliff face between them, and checking only the cells would let
 * units walk off a ledge. Used by validate() and by M18's nav grid.
 */
export function cellsConnect(world: World, aCell: number, bCell: number): boolean {
  if (!isTraversable(world, aCell) || !isTraversable(world, bCell)) return false;
  return stepSlopeAtMost(world, aCell, bCell, MAX_TRAVERSABLE_SLOPE);
}

export interface ValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly cell?: number;
}

/**
 * Reports structural problems: start locations that are unreachable from each
 * other, and stranded ground — a patch of gentle terrain surrounded by slopes
 * too steep to climb, which looks like somewhere you could stand and is not.
 * With tiers this was a plateau with no ramp; sculpted terrain produces the
 * same mistake far more easily, because nothing about a hillside tells you
 * where it stops being climbable.
 */
export function validate(world: World): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const regions = labelRegions(world);

  for (const node of world.resourceNodes) {
    if (node.cell < 0 || node.cell >= world.flags.length) {
      issues.push({ severity: 'error', code: 'node-out-of-bounds', message: `resource node at cell ${node.cell} is outside the map`, cell: node.cell });
    }
  }

  const startRegions: number[] = [];
  for (const start of world.startLocations) {
    if (start.cell < 0 || start.cell >= world.flags.length) {
      issues.push({ severity: 'error', code: 'start-out-of-bounds', message: `start location at cell ${start.cell} is outside the map`, cell: start.cell });
      continue;
    }
    if (!isTraversable(world, start.cell)) {
      issues.push({
        severity: 'error',
        code: 'start-unwalkable',
        message: `start location at cell ${start.cell} is on ground too steep or not walkable`,
        cell: start.cell,
      });
      continue;
    }
    startRegions.push(regions.labels[start.cell] as number);
  }

  for (let i = 1; i < startRegions.length; i++) {
    if (startRegions[i] !== startRegions[0]) {
      issues.push({
        severity: 'error',
        code: 'start-unreachable',
        message: `start location ${i} is not reachable from start location 0`,
        cell: world.startLocations[i]?.cell ?? -1,
      });
    }
  }

  for (let i = 0; i < world.startLocations.length; i++) {
    for (let j = i + 1; j < world.startLocations.length; j++) {
      const a = world.startLocations[i]?.cell ?? -1;
      const b = world.startLocations[j]?.cell ?? -1;
      if (a < 0 || b < 0) continue;
      const dx = (a % world.width) - (b % world.width);
      const dy = ((a / world.width) | 0) - ((b / world.width) | 0);
      // Compare squared distances: exact integers, no square root needed for
      // the decision. The message rounds down to whole cells.
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq >= MIN_START_SEPARATION * MIN_START_SEPARATION) continue;
      issues.push({
        severity: 'warning',
        code: 'starts-too-close',
        message: `start locations ${i} and ${j} are ${isqrt(distanceSq)} cells apart, under the ${MIN_START_SEPARATION} cell minimum`,
        cell: b,
      });
    }
  }

  // Stranded ground: any region that is not the largest one. A map normally
  // has one big connected area and, at most, deliberate islands; anything else
  // is usually a hillside the sculptor did not realise had become a cliff.
  if (regions.count > 1) {
    let largest = 0;
    for (let label = 1; label < regions.count; label++) {
      if ((regions.size[label] as number) > (regions.size[largest] as number)) largest = label;
    }
    for (let label = 0; label < regions.count; label++) {
      if (label === largest) continue;
      const size = regions.size[label] as number;
      // A handful of cells behind a rock is noise; a plateau is a mistake.
      if (size < STRANDED_REGION_MIN_CELLS) continue;
      issues.push({
        severity: 'warning',
        code: 'stranded-ground',
        message: `${size} cells around cell ${regions.sample[label]} cannot be reached from the rest of the map`,
        cell: regions.sample[label] as number,
      });
    }
  }

  return issues;
}

/** Below this, an isolated patch is scenery rather than a sculpting mistake. */
export const STRANDED_REGION_MIN_CELLS = 16;

interface Regions {
  /** Region label per cell, or -1 for unwalkable cells. */
  readonly labels: Int32Array;
  readonly count: number;
  readonly size: Int32Array;
  readonly sample: Int32Array;
}

/** Flood-fill traversable cells into connected regions, obeying the slope rules. */
export function labelRegions(world: World): Regions {
  const total = world.width * world.height;
  const labels = new Int32Array(total).fill(-1);
  const size: number[] = [];
  const sample: number[] = [];
  const queue = new Int32Array(total);
  let count = 0;

  for (let start = 0; start < total; start++) {
    if (labels[start] !== -1) continue;
    if (!isTraversable(world, start)) continue;

    const label = count++;
    labels[start] = label;
    sample.push(start);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    let filled = 0;

    while (head < tail) {
      const cell = queue[head++] as number;
      filled++;
      const cx = cell % world.width;
      const cy = (cell / world.width) | 0;
      for (let dir = 0; dir < 4; dir++) {
        const nx = cx + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
        const ny = cy + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
        if (!inBounds(world, nx, ny)) continue;
        const next = ny * world.width + nx;
        if (labels[next] !== -1) continue;
        if (!cellsConnect(world, cell, next)) continue;
        labels[next] = label;
        queue[tail++] = next;
      }
    }
    size.push(filled);
  }

  return { labels, count, size: Int32Array.from(size), sample: Int32Array.from(sample) };
}


/**
 * Hash of everything the editor can author.
 *
 * Undo must restore a world that is byte-identical, not merely equivalent, and
 * a map must survive a save/load round trip unchanged (M12). Both are checked
 * against this.
 */
export function hashWorld(world: World): number {
  let hash = 0x811c9dc5;
  hash = hashU32(world.width, hash);
  hash = hashU32(world.height, hash);
  hash = hashU32(world.cellSize, hash);
  hash = hashArray(world.heights, hash);
  hash = hashArray(world.flags, hash);
  hash = hashU32(world.resourceNodes.length, hash);
  for (const node of world.resourceNodes) {
    hash = hashU32(node.cell, hash);
    hash = hashU32(node.type, hash);
    hash = hashU32(node.amount, hash);
  }
  hash = hashU32(world.startLocations.length, hash);
  for (const start of world.startLocations) {
    hash = hashU32(start.cell, hash);
  }
  return fnv1a32(new Uint8Array(0), hash);
}
