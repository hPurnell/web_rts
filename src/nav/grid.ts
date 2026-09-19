/**
 * The navigation grid.
 *
 * Two byte arrays over the map: a traversal cost per cell, and a bitmask of
 * which of the eight neighbours can actually be reached from it. Both are
 * plain Uint8Arrays so they can be handed to the pathfinding worker as
 * transferable buffers (invariant 6 rules out SharedArrayBuffer).
 *
 * Connectivity, not geometry, is what makes cliffs real. With a heightfield
 * that takes two rules, and both are needed:
 *
 *   - a cell is passable if its own slope is gentle enough, and
 *   - a step between two cells is passable if the slope *between them* is.
 *
 * The second does not follow from the first. Two cells can each be perfectly
 * flat with a cliff face between them, which is precisely the shape the top
 * and bottom of a drop have; checking only the cells would let units walk off
 * ledges. A ramp is not a special case here — it is simply ground where both
 * rules happen to pass.
 */
import type { World } from '../sim/world.ts';
import { WALKABLE, cellIndex } from '../sim/world.ts';
import type { HeightOverrides } from '../sim/terrain.ts';
import {
  MAX_TRAVERSABLE_SLOPE,
  cellRelief,
  slopeAtMost,
  stepSlopeAtMost,
} from '../sim/terrain.ts';
import { div, mul } from '../sim/fixed.ts';

/** Impassable. Every other value is a relative movement cost. */
export const BLOCKED = 0;
export const BASE_COST = 1;
/**
 * Cost of the steepest ground a unit will still walk on.
 *
 * Cost rises with slope between these, so a path over a hill is only taken
 * when going around it is genuinely longer. This is the single rule that makes
 * continuous terrain feel different from a flat plane with obstacles: armies
 * follow the valleys without anyone telling them to.
 */
export const MAX_SLOPE_COST = 8;

/** Neighbour directions, in bit order. */
export const DIRECTIONS: readonly [number, number][] = [
  [0, -1], // 0 N
  [1, -1], // 1 NE
  [1, 0], // 2 E
  [1, 1], // 3 SE
  [0, 1], // 4 S
  [-1, 1], // 5 SW
  [-1, 0], // 6 W
  [-1, -1], // 7 NW
];

/** True for the four diagonal directions. */
export const IS_DIAGONAL: readonly boolean[] = [false, true, false, true, false, true, false, true];

export interface CostGrid {
  readonly width: number;
  readonly height: number;
  /** Traversal cost per cell; BLOCKED means impassable. */
  readonly cost: Uint8Array;
  /** Bit i set means DIRECTIONS[i] is reachable from this cell. */
  readonly links: Uint8Array;
  /**
   * Cells blocked by something standing on them rather than by the terrain:
   * buildings, and anything else a match puts in the way. Kept separate from
   * `cost` so a rebuild can recompute terrain without losing them, and so the
   * editor's grid and a match's grid differ only here.
   */
  readonly occupied: Uint8Array;
  /** Bumped on every rebuild, so the worker can tell its cache is stale. */
  version: number;
}

export function createCostGrid(world: World): CostGrid {
  const cells = world.width * world.height;
  const grid: CostGrid = {
    width: world.width,
    height: world.height,
    cost: new Uint8Array(cells),
    links: new Uint8Array(cells),
    occupied: new Uint8Array(cells),
    version: 0,
  };
  rebuildCostGrid(grid, world);
  return grid;
}

/** Rebuild the whole grid. */
export function rebuildCostGrid(
  grid: CostGrid,
  world: World,
  overrides?: HeightOverrides | null,
): void {
  rebuildRegion(grid, world, 0, 0, world.width - 1, world.height - 1, overrides);
}

/**
 * Rebuild a rectangle of cells.
 *
 * A cell's links depend on its neighbours, so the rebuilt area is grown by one
 * cell in each direction: editing a cell changes whether its neighbours can
 * reach *it*, not just what it can reach.
 */
export function rebuildRegion(
  grid: CostGrid,
  world: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  /** A match's terrain changes, when rebuilding during a match rather than in
   * the editor. Levelling a building footprint changes what is traversable
   * around it, so the grid has to see the same ground the units will. */
  overrides?: HeightOverrides | null,
): number {
  const blocked = occupiedCells(world);

  const left = Math.max(0, Math.min(x0, x1) - 1);
  const top = Math.max(0, Math.min(y0, y1) - 1);
  const right = Math.min(world.width - 1, Math.max(x0, x1) + 1);
  const bottom = Math.min(world.height - 1, Math.max(y0, y1) + 1);

  // Costs first, for the whole rebuilt area plus its margin: link tests read
  // neighbouring costs, so they must all be current before links are written.
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const cell = y * world.width + x;
      grid.cost[cell] = cellCost(world, grid, cell, blocked, overrides);
    }
  }

  let rebuilt = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const cell = y * world.width + x;
      grid.links[cell] = cellLinks(world, grid, x, y);
      rebuilt++;
    }
  }

  grid.version++;
  return rebuilt;
}

/** Cells made impassable by something standing on them. */
function occupiedCells(world: World): Set<number> {
  // Resource patches block ground movement, the way a mineral line does.
  const blocked = new Set<number>();
  for (const node of world.resourceNodes) blocked.add(node.cell);
  return blocked;
}

/**
 * Cost of standing on a cell, or BLOCKED.
 *
 * Interpolates from BASE_COST on the flat to MAX_SLOPE_COST at the steepest
 * ground a unit will still walk on. Staying in integers keeps the result a
 * small byte the flow field can bucket on.
 */
function cellCost(
  world: World,
  grid: CostGrid,
  cell: number,
  blocked: ReadonlySet<number>,
  overrides?: HeightOverrides | null,
): number {
  const flags = world.flags[cell] as number;
  if ((flags & WALKABLE) === 0) return BLOCKED;
  if (blocked.has(cell)) return BLOCKED;
  if ((grid.occupied[cell] as number) !== 0) return BLOCKED;
  if (!slopeAtMost(world, cell, MAX_TRAVERSABLE_SLOPE, overrides)) return BLOCKED;

  const limit = mul(MAX_TRAVERSABLE_SLOPE, world.cellSize);
  if (limit <= 0) return BASE_COST;
  const steepness = div(cellRelief(world, cell, overrides), limit); // 0..1 in Q16.16
  const cost = BASE_COST + ((steepness * (MAX_SLOPE_COST - BASE_COST)) >> 16);
  return cost > MAX_SLOPE_COST ? MAX_SLOPE_COST : cost;
}

/**
 * Mark or clear cells blocked by something standing on them, and rebuild the
 * affected region so links agree with the new costs.
 */
export function setOccupied(
  grid: CostGrid,
  world: World,
  cells: readonly number[],
  occupied: boolean,
): void {
  if (cells.length === 0) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const cell of cells) {
    if (cell < 0 || cell >= grid.occupied.length) continue;
    grid.occupied[cell] = occupied ? 1 : 0;
    const cx = cell % grid.width;
    const cy = (cell / grid.width) | 0;
    if (cx < x0) x0 = cx;
    if (cy < y0) y0 = cy;
    if (cx > x1) x1 = cx;
    if (cy > y1) y1 = cy;
  }
  if (x0 === Infinity) return;
  rebuildRegion(grid, world, x0, y0, x1, y1);
}

function cellLinks(world: World, grid: CostGrid, cx: number, cy: number): number {
  const cell = cy * world.width + cx;
  if (grid.cost[cell] === BLOCKED) return 0;

  let links = 0;
  for (let dir = 0; dir < DIRECTIONS.length; dir++) {
    const [dx, dy] = DIRECTIONS[dir] as [number, number];
    const neighbour = cellIndex(world, cx + dx, cy + dy);
    if (neighbour < 0) continue;
    if (grid.cost[neighbour] === BLOCKED) continue;
    // The step itself, not just the two cells.
    if (!stepSlopeAtMost(world, cell, neighbour, MAX_TRAVERSABLE_SLOPE)) continue;

    if (IS_DIAGONAL[dir]) {
      // No cutting a corner between two blocked cells, and no diagonal move
      // that would clip the edge of a cliff: both orthogonal neighbours have
      // to be passable and on a connecting tier too.
      const sideA = cellIndex(world, cx + dx, cy);
      const sideB = cellIndex(world, cx, cy + dy);
      if (sideA < 0 || sideB < 0) continue;
      if (grid.cost[sideA] === BLOCKED || grid.cost[sideB] === BLOCKED) continue;
      if (
        !stepSlopeAtMost(world, cell, sideA, MAX_TRAVERSABLE_SLOPE) ||
        !stepSlopeAtMost(world, cell, sideB, MAX_TRAVERSABLE_SLOPE)
      ) {
        continue;
      }
      if (
        !stepSlopeAtMost(world, sideA, neighbour, MAX_TRAVERSABLE_SLOPE) ||
        !stepSlopeAtMost(world, sideB, neighbour, MAX_TRAVERSABLE_SLOPE)
      ) {
        continue;
      }
    }

    links |= 1 << dir;
  }
  return links;
}

export function isPassable(grid: CostGrid, cell: number): boolean {
  return cell >= 0 && cell < grid.cost.length && grid.cost[cell] !== BLOCKED;
}

export function isLinked(grid: CostGrid, cell: number, direction: number): boolean {
  return ((grid.links[cell] as number) & (1 << direction)) !== 0;
}

/** The neighbours reachable from a cell, as cell indices. */
export function neighboursOf(grid: CostGrid, cell: number): number[] {
  const links = grid.links[cell] as number;
  if (links === 0) return [];
  const cx = cell % grid.width;
  const cy = (cell / grid.width) | 0;
  const out: number[] = [];
  for (let dir = 0; dir < DIRECTIONS.length; dir++) {
    if ((links & (1 << dir)) === 0) continue;
    const [dx, dy] = DIRECTIONS[dir] as [number, number];
    out.push((cy + dy) * grid.width + (cx + dx));
  }
  return out;
}

/** A copy of the grid's buffers, ready to transfer to the worker. */
export interface CostGridSnapshot {
  readonly width: number;
  readonly height: number;
  readonly version: number;
  readonly cost: ArrayBuffer;
  readonly links: ArrayBuffer;
}

export function snapshotCostGrid(grid: CostGrid): CostGridSnapshot {
  return {
    width: grid.width,
    height: grid.height,
    version: grid.version,
    cost: grid.cost.slice().buffer,
    links: grid.links.slice().buffer,
  };
}

export function gridFromSnapshot(snapshot: CostGridSnapshot): CostGrid {
  const cost = new Uint8Array(snapshot.cost);
  return {
    width: snapshot.width,
    height: snapshot.height,
    cost,
    links: new Uint8Array(snapshot.links),
    // Occupancy is already baked into the costs that were sent; the worker
    // only reads the grid, so it needs no separate overlay.
    occupied: new Uint8Array(cost.length),
    version: snapshot.version,
  };
}

/**
 * Flood-fill the grid into connected components.
 *
 * Used to answer "is this destination reachable at all" before a path is
 * requested, and by tests asserting that cliffs actually separate regions.
 */
export function labelComponents(grid: CostGrid): { labels: Int32Array; count: number } {
  const labels = new Int32Array(grid.cost.length).fill(-1);
  const queue = new Int32Array(grid.cost.length);
  let count = 0;

  for (let start = 0; start < grid.cost.length; start++) {
    if (labels[start] !== -1 || grid.cost[start] === BLOCKED) continue;
    const label = count++;
    labels[start] = label;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const cell = queue[head++] as number;
      for (const neighbour of neighboursOf(grid, cell)) {
        if (labels[neighbour] !== -1) continue;
        labels[neighbour] = label;
        queue[tail++] = neighbour;
      }
    }
  }
  return { labels, count };
}
