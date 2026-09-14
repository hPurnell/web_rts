/**
 * Flow fields inside the simulation.
 *
 * The pathfinding worker is a latency optimisation, never a source of truth.
 * A field is a pure function of (cost grid, goal cell), so every client can
 * derive the same one; what must not happen is the simulation behaving
 * differently depending on whether the worker's answer had arrived yet.
 *
 * So the simulation owns a cache and computes synchronously on a miss. The
 * worker's job is to have filled that cache first — its result is byte
 * identical, so inserting it changes timing and nothing else.
 */
import type { CostGrid } from '../nav/grid.ts';
import type { FlowField } from '../nav/flowfield.ts';
import { computeFlowField } from '../nav/flowfield.ts';

/** Fields kept per match before the least recently used is dropped. */
export const FIELD_CACHE_SIZE = 24;

export interface FieldCache {
  readonly fields: Map<number, FlowField>;
  readonly limit: number;
  /** Fields computed on the simulation thread because the cache missed. */
  synchronousSolves: number;
  /** Fields supplied by the worker before they were needed. */
  prefetchedSolves: number;
}

export function createFieldCache(limit = FIELD_CACHE_SIZE): FieldCache {
  return { fields: new Map(), limit, synchronousSolves: 0, prefetchedSolves: 0 };
}

function touch(cache: FieldCache, goalCell: number, field: FlowField): void {
  cache.fields.delete(goalCell);
  cache.fields.set(goalCell, field);
  while (cache.fields.size > cache.limit) {
    const oldest = cache.fields.keys().next().value;
    if (oldest === undefined) break;
    cache.fields.delete(oldest);
  }
}

/**
 * The field for a goal, computed now if it is not cached.
 *
 * Never returns null: a goal that cannot be reached still produces a field,
 * one in which nothing is reachable, and units standing in it will stop.
 */
export function ensureField(cache: FieldCache, grid: CostGrid, goalCell: number): FlowField {
  const existing = cache.fields.get(goalCell);
  if (existing && existing.gridVersion === grid.version) {
    touch(cache, goalCell, existing);
    return existing;
  }

  const field = computeFlowField(grid, goalCell);
  cache.synchronousSolves++;
  touch(cache, goalCell, field);
  return field;
}

/**
 * Insert a field the worker solved.
 *
 * Rejected if it was solved against a different version of the terrain: an
 * out-of-date field is worse than no field, because the units following it
 * would walk into walls that now exist.
 */
export function offerField(cache: FieldCache, grid: CostGrid, field: FlowField): boolean {
  if (field.gridVersion !== grid.version) return false;
  const existing = cache.fields.get(field.goalCell);
  if (existing && existing.gridVersion === grid.version) return false;
  cache.prefetchedSolves++;
  touch(cache, field.goalCell, field);
  return true;
}

/** Drop everything, e.g. after the terrain changed. */
export function clearFieldCache(cache: FieldCache): void {
  cache.fields.clear();
}
