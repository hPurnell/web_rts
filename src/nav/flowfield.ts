/**
 * Flow field pathfinding.
 *
 * One field serves any number of units heading to the same place: instead of
 * a path per unit, every cell stores which way to step next. For an RTS that
 * is the difference between 200 A* searches and one brushfire.
 *
 * Two passes. The integration pass floods outward from the goal accumulating
 * cost; the flow pass reads each cell's neighbours and records the direction
 * of the cheapest. Both are integer-only and iterate in a fixed order, so the
 * same grid and goal always produce the same bytes — which is what lets the
 * field feed the determinism hash.
 */
import type { CostGrid } from './grid.ts';
import { BLOCKED, DIRECTIONS, IS_DIAGONAL } from './grid.ts';

/** Unreachable. Distinct from a large-but-finite cost. */
export const UNREACHABLE = 0xffff;
/** Stored in the flow field where there is nowhere to go. */
export const NO_DIRECTION = -1;

/**
 * Movement weights, scaled by ten so a diagonal can be 1.4 without a float.
 * The ratio matters more than the scale: paths that cut corners diagonally
 * must not come out cheaper than the straight route they replace.
 */
export const ORTHOGONAL_WEIGHT = 10;
export const DIAGONAL_WEIGHT = 14;

export interface FlowField {
  readonly width: number;
  readonly height: number;
  readonly goalCell: number;
  /** Accumulated cost to the goal, or UNREACHABLE. */
  readonly integration: Uint16Array;
  /** Index into DIRECTIONS, or NO_DIRECTION. */
  readonly flow: Int8Array;
  /** The cost grid version this was solved against. */
  readonly gridVersion: number;
}

/** Highest weight a single step can have on this grid. */
function maxStepWeight(grid: CostGrid): number {
  let maxCost = 1;
  for (let i = 0; i < grid.cost.length; i++) {
    const cost = grid.cost[i] as number;
    if (cost > maxCost) maxCost = cost;
  }
  return maxCost * DIAGONAL_WEIGHT;
}

/**
 * Dial's algorithm: a bucket per possible distance modulo the largest step.
 *
 * Costs here are small integers, so a bucket queue pops in O(1) where a binary
 * heap would pay a log factor on every one of a quarter of a million cells.
 * It is also completely deterministic, which a heap with tie-breaking is not.
 */
export function computeFlowField(grid: CostGrid, goalCell: number): FlowField {
  const cells = grid.cost.length;
  const integration = new Uint16Array(cells).fill(UNREACHABLE);
  const flow = new Int8Array(cells).fill(NO_DIRECTION);

  const field: FlowField = {
    width: grid.width,
    height: grid.height,
    goalCell,
    integration,
    flow,
    gridVersion: grid.version,
  };

  if (goalCell < 0 || goalCell >= cells || grid.cost[goalCell] === BLOCKED) {
    // An unreachable goal yields an empty field rather than an error: a unit
    // ordered into a cliff should stand still, not crash the match.
    return field;
  }

  // Dial's bucket count only has to exceed the largest single step, so it is
  // sized from the grid rather than from the widest cost a byte could hold:
  // a map of flat ground and ramps needs 29 buckets, not 3,571.
  const bucketCount = maxStepWeight(grid) + 1;
  const buckets: number[][] = Array.from({ length: bucketCount }, () => []);
  // Hoisted out of the loop: reading these off `grid` on every one of half a
  // million iterations is measurably slower than reading a local.
  const cost = grid.cost;
  const links = grid.links;
  const width = grid.width;
  // A settled cell already has its final distance; relaxing it again is pure
  // waste, and skipping it is what keeps the queue from churning.
  const settled = new Uint8Array(cells);

  // Neighbour offsets and step weights, precomputed per direction.
  const offsets = new Int32Array(DIRECTIONS.length);
  const weights = new Int32Array(DIRECTIONS.length);
  for (let dir = 0; dir < DIRECTIONS.length; dir++) {
    const [dx, dy] = DIRECTIONS[dir] as [number, number];
    offsets[dir] = dy * width + dx;
    weights[dir] = IS_DIAGONAL[dir] ? DIAGONAL_WEIGHT : ORTHOGONAL_WEIGHT;
  }

  let pending = 1;
  let cursor = 0;

  integration[goalCell] = 0;
  (buckets[0] as number[]).push(goalCell);

  while (pending > 0) {
    const bucket = buckets[cursor] as number[];
    if (bucket.length === 0) {
      cursor = (cursor + 1) % bucketCount;
      continue;
    }

    const cell = bucket.pop() as number;
    pending--;
    // A cell can be queued more than once at different distances; the later,
    // larger entries are stale by the time they surface.
    if (settled[cell] === 1) continue;
    const distance = integration[cell] as number;
    if (distance % bucketCount !== cursor) continue;
    settled[cell] = 1;

    const cellLinks = links[cell] as number;
    for (let dir = 0; dir < 8; dir++) {
      if ((cellLinks & (1 << dir)) === 0) continue;
      const neighbour = cell + (offsets[dir] as number);
      if (settled[neighbour] === 1) continue;

      const candidate = distance + (cost[neighbour] as number) * (weights[dir] as number);
      if (candidate >= UNREACHABLE) continue;
      if (candidate >= (integration[neighbour] as number)) continue;

      integration[neighbour] = candidate;
      (buckets[candidate % bucketCount] as number[]).push(neighbour);
      pending++;
    }
  }

  // Flow pass: each cell points at the cheapest neighbour it can actually
  // reach. Ties break toward the lower direction index, which keeps the field
  // byte-identical between runs.
  for (let cell = 0; cell < cells; cell++) {
    const here = integration[cell] as number;
    if (here === UNREACHABLE || cell === goalCell) continue;

    const cellLinks = links[cell] as number;
    let best = here;
    let bestDir = NO_DIRECTION;

    for (let dir = 0; dir < 8; dir++) {
      if ((cellLinks & (1 << dir)) === 0) continue;
      const value = integration[cell + (offsets[dir] as number)] as number;
      if (value >= best) continue;
      best = value;
      bestDir = dir;
    }
    flow[cell] = bestDir;
  }

  return field;
}

/** The direction to step from a cell, or NO_DIRECTION. */
export function flowAt(field: FlowField, cell: number): number {
  if (cell < 0 || cell >= field.flow.length) return NO_DIRECTION;
  return field.flow[cell] as number;
}

/** Cost from a cell to the goal, or UNREACHABLE. */
export function distanceAt(field: FlowField, cell: number): number {
  if (cell < 0 || cell >= field.integration.length) return UNREACHABLE;
  return field.integration[cell] as number;
}

export function isReachable(field: FlowField, cell: number): boolean {
  return distanceAt(field, cell) !== UNREACHABLE;
}

/**
 * Walk the field from a cell to the goal, for tests and debugging.
 * Returns an empty array if the goal cannot be reached.
 */
export function tracePath(field: FlowField, from: number, limit = 4096): number[] {
  if (!isReachable(field, from)) return [];
  const path = [from];
  let cell = from;
  while (cell !== field.goalCell && path.length < limit) {
    const dir = flowAt(field, cell);
    if (dir === NO_DIRECTION) return [];
    const [dx, dy] = DIRECTIONS[dir] as [number, number];
    const cx = cell % field.width;
    const cy = (cell / field.width) | 0;
    cell = (cy + dy) * field.width + (cx + dx);
    path.push(cell);
  }
  return cell === field.goalCell ? path : [];
}
