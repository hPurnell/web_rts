/**
 * World state (invariant 4): terrain and authored data. Owned by the editor,
 * saved to disk, and read — never written — by the simulation.
 *
 * Terrain height is a discrete tier index, not a continuous value. The
 * simulation uses it for pathing connectivity and vision only; the renderer is
 * the only thing that turns a tier into a Y coordinate.
 */
import type { Fixed } from './fixed.ts';
import { ONE, div, fromInt, mul, toInt } from './fixed.ts';
import { fnv1a32, hashArray, hashU32 } from './hash.ts';

export const MAX_TIER = 3;
export const MAX_DIMENSION = 512;

/** Cell flag bits. */
export const WALKABLE = 1 << 0;
export const BUILDABLE = 1 << 1;
export const RAMP = 1 << 2;
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
  readonly tier: Uint8Array;
  readonly flags: Uint8Array;
  resourceNodes: ResourceNode[];
  startLocations: StartLocation[];
}

/** A fresh world: tier 0 everywhere, walkable and buildable, nothing placed. */
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
    tier: new Uint8Array(cells),
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

/** Tier at a cell. Out-of-bounds reads return the edge tier, so vision and
 * pathing at the map border behave as if the terrain continued. */
export function tierAt(world: World, cx: number, cy: number): number {
  const x = cx < 0 ? 0 : cx >= world.width ? world.width - 1 : cx;
  const y = cy < 0 ? 0 : cy >= world.height ? world.height - 1 : cy;
  return world.tier[y * world.width + x] as number;
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

export function setTier(world: World, cell: number, tier: number): void {
  if (cell < 0 || cell >= world.tier.length) return;
  world.tier[cell] = tier < 0 ? 0 : tier > MAX_TIER ? MAX_TIER : tier;
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

/** Two cells are navigably adjacent when they share a tier, or a ramp bridges
 * exactly one tier of difference. Used by validate() and by M18's nav grid. */
export function tiersConnect(world: World, aCell: number, bCell: number): boolean {
  const aTier = world.tier[aCell] as number;
  const bTier = world.tier[bCell] as number;
  if (aTier === bTier) return true;
  const diff = aTier > bTier ? aTier - bTier : bTier - aTier;
  if (diff !== 1) return false;
  const aFlags = world.flags[aCell] as number;
  const bFlags = world.flags[bCell] as number;
  return ((aFlags | bFlags) & RAMP) !== 0;
}

export interface ValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly cell?: number;
}

/**
 * Reports structural problems: start locations that are unreachable from each
 * other, and orphaned tiers — raised regions with no ramp connecting them to
 * anything, which look like terrain but are unreachable.
 */
export function validate(world: World): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const regions = labelRegions(world);

  for (const node of world.resourceNodes) {
    if (node.cell < 0 || node.cell >= world.tier.length) {
      issues.push({ severity: 'error', code: 'node-out-of-bounds', message: `resource node at cell ${node.cell} is outside the map`, cell: node.cell });
    }
  }

  const startRegions: number[] = [];
  for (const start of world.startLocations) {
    if (start.cell < 0 || start.cell >= world.tier.length) {
      issues.push({ severity: 'error', code: 'start-out-of-bounds', message: `start location at cell ${start.cell} is outside the map`, cell: start.cell });
      continue;
    }
    if (((world.flags[start.cell] as number) & WALKABLE) === 0) {
      issues.push({ severity: 'error', code: 'start-unwalkable', message: `start location at cell ${start.cell} is not walkable`, cell: start.cell });
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

  // An orphaned tier is a walkable region raised above tier 0 that connects to
  // no other region: terrain you can see but never stand on.
  for (let label = 0; label < regions.count; label++) {
    const sample = regions.sample[label] as number;
    if ((world.tier[sample] as number) === 0) continue;
    if ((regions.size[label] as number) === 0) continue;
    if (regions.count === 1) break;
    if (!regionHasRamp(world, regions, label)) {
      issues.push({
        severity: 'warning',
        code: 'orphaned-tier',
        message: `raised region of ${regions.size[label]} cells at cell ${sample} has no ramp connecting it`,
        cell: sample,
      });
    }
  }

  return issues;
}

interface Regions {
  /** Region label per cell, or -1 for unwalkable cells. */
  readonly labels: Int32Array;
  readonly count: number;
  readonly size: Int32Array;
  readonly sample: Int32Array;
}

/** Flood-fill walkable cells into connected regions, obeying the tier rule. */
export function labelRegions(world: World): Regions {
  const total = world.width * world.height;
  const labels = new Int32Array(total).fill(-1);
  const size: number[] = [];
  const sample: number[] = [];
  const queue = new Int32Array(total);
  let count = 0;

  for (let start = 0; start < total; start++) {
    if (labels[start] !== -1) continue;
    if (((world.flags[start] as number) & WALKABLE) === 0) continue;

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
        if (((world.flags[next] as number) & WALKABLE) === 0) continue;
        if (!tiersConnect(world, cell, next)) continue;
        labels[next] = label;
        queue[tail++] = next;
      }
    }
    size.push(filled);
  }

  return { labels, count, size: Int32Array.from(size), sample: Int32Array.from(sample) };
}

function regionHasRamp(world: World, regions: Regions, label: number): boolean {
  for (let cell = 0; cell < regions.labels.length; cell++) {
    if (regions.labels[cell] !== label) continue;
    if (((world.flags[cell] as number) & RAMP) !== 0) return true;
  }
  return false;
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
  hash = hashArray(world.tier, hash);
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
