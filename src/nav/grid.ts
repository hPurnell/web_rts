/**
 * The navigation grid.
 *
 * Two byte arrays over the map: a traversal cost per cell, and a bitmask of
 * which of the eight neighbours can actually be reached from it. Both are
 * plain Uint8Arrays so they can be handed to the pathfinding worker as
 * transferable buffers (invariant 6 rules out SharedArrayBuffer).
 *
 * Connectivity, not geometry, is what makes cliffs real: two cells are
 * neighbours only if they share a tier, or if a ramp bridges exactly one tier
 * between them. A unit can therefore stand a metre from the cell below a cliff
 * and have no route to it but the ramp.
 */
import type { World } from '../sim/world.ts';
import { RAMP, WALKABLE, cellIndex, tiersConnect } from '../sim/world.ts';

/** Impassable. Every other value is a relative movement cost. */
export const BLOCKED = 0;
export const BASE_COST = 1;
/** Ramps cost a little more, so paths prefer flat ground when both work. */
export const RAMP_COST = 2;

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
    version: 0,
  };
  rebuildCostGrid(grid, world);
  return grid;
}

/** Rebuild the whole grid. */
export function rebuildCostGrid(grid: CostGrid, world: World): void {
  rebuildRegion(grid, world, 0, 0, world.width - 1, world.height - 1);
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
      grid.cost[cell] = cellCost(world, cell, blocked);
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

function cellCost(world: World, cell: number, blocked: ReadonlySet<number>): number {
  const flags = world.flags[cell] as number;
  if ((flags & WALKABLE) === 0) return BLOCKED;
  if (blocked.has(cell)) return BLOCKED;
  return (flags & RAMP) !== 0 ? RAMP_COST : BASE_COST;
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
    if (!tiersConnect(world, cell, neighbour)) continue;

    if (IS_DIAGONAL[dir]) {
      // No cutting a corner between two blocked cells, and no diagonal move
      // that would clip the edge of a cliff: both orthogonal neighbours have
      // to be passable and on a connecting tier too.
      const sideA = cellIndex(world, cx + dx, cy);
      const sideB = cellIndex(world, cx, cy + dy);
      if (sideA < 0 || sideB < 0) continue;
      if (grid.cost[sideA] === BLOCKED || grid.cost[sideB] === BLOCKED) continue;
      if (!tiersConnect(world, cell, sideA) || !tiersConnect(world, cell, sideB)) continue;
      if (!tiersConnect(world, sideA, neighbour) || !tiersConnect(world, sideB, neighbour)) continue;
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
  return {
    width: snapshot.width,
    height: snapshot.height,
    cost: new Uint8Array(snapshot.cost),
    links: new Uint8Array(snapshot.links),
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
