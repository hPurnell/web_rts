/**
 * Brush maths for terrain painting. Pure functions over world state so the
 * rules are testable without a pointer, a canvas or a mesh.
 *
 * The legality rule: a cell may not stand two or more tiers away from *every*
 * one of its eight neighbours. A two-tier cliff along an edge is fine — it
 * renders as one tall wall, and the fixture map uses them — but an isolated
 * spire or pit has no approach at all, which is the configuration PLAN.md
 * calls impossible. Raising a cell therefore drags its neighbours up behind it
 * until every cell has at least one neighbour within one tier, which is why
 * the brush proposes a whole edit and then repairs it rather than writing
 * cells one at a time.
 */
import type { World } from '../sim/world.ts';
import { MAX_TIER, RAMP, cellIndex } from '../sim/world.ts';
import type { TerrainEditCommand } from './commands.ts';

export const MIN_BRUSH_RADIUS = 0;
export const MAX_BRUSH_RADIUS = 16;

/** Cells within `radius` of a centre cell, as a circular disc. */
export function brushCells(world: World, centre: number, radius: number): number[] {
  if (centre < 0 || centre >= world.tier.length) return [];
  const cx = centre % world.width;
  const cy = (centre / world.width) | 0;
  const r = Math.max(MIN_BRUSH_RADIUS, Math.min(MAX_BRUSH_RADIUS, Math.floor(radius)));
  const cells: number[] = [];
  // Half a cell of slack, so a radius of 1 is a plus shape rather than a dot.
  const limit = (r + 0.5) * (r + 0.5);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > limit) continue;
      const cell = cellIndex(world, x, y);
      if (cell >= 0) cells.push(cell);
    }
  }
  return cells;
}

/**
 * Propose new tiers for a brush stroke and repair the result so no two
 * adjacent cells differ by more than one tier.
 *
 * Returns the proposed tier for every cell that ends up changing, including
 * cells outside the brush that the cascade had to drag along.
 */
export function proposeTierEdit(
  world: World,
  cells: readonly number[],
  delta: number,
): Map<number, number> {
  const proposed = new Map<number, number>();
  for (const cell of cells) {
    const current = world.tier[cell] as number;
    const next = Math.max(0, Math.min(MAX_TIER, current + delta));
    if (next !== current) proposed.set(cell, next);
  }
  if (proposed.size === 0) return proposed;

  const tierOf = (cell: number): number => proposed.get(cell) ?? (world.tier[cell] as number);

  // Repair isolated spires and pits. Each pass can only move a neighbour one
  // tier toward the edited cell, so the frontier shrinks and this terminates.
  let frontier = [...proposed.keys()];
  let passes = 0;
  while (frontier.length > 0 && passes++ <= MAX_TIER + 1) {
    const next: number[] = [];
    for (const cell of frontier) {
      const tier = tierOf(cell);
      const neighbours = neighbourCells(world, cell);
      if (neighbours.some((n) => Math.abs(tierOf(n) - tier) <= 1)) continue;

      // Nothing is within reach: pull every neighbour to one tier away, which
      // turns the spire into a mesa (or the pit into a basin).
      for (const neighbour of neighbours) {
        const repaired = tierOf(neighbour) < tier ? tier - 1 : tier + 1;
        const clamped = Math.max(0, Math.min(MAX_TIER, repaired));
        if (clamped === tierOf(neighbour)) continue;
        proposed.set(neighbour, clamped);
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  // Drop entries the repair brought back to their original value.
  for (const [cell, tier] of proposed) {
    if (tier === world.tier[cell]) proposed.delete(cell);
  }
  return proposed;
}

/** The up-to-eight neighbours of a cell, clipped at the map edge. */
function neighbourCells(world: World, cell: number): number[] {
  const cx = cell % world.width;
  const cy = (cell / world.width) | 0;
  const out: number[] = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const neighbour = cellIndex(world, cx + ox, cy + oy);
      if (neighbour >= 0) out.push(neighbour);
    }
  }
  return out;
}

/**
 * Stage a tier edit into a command.
 *
 * A cell whose tier changes loses its RAMP flag: a ramp is only meaningful
 * against the specific pair of tiers it was placed between, and silently
 * keeping the flag would leave a ramp bridging a cliff it no longer touches.
 */
export function stageTierEdit(
  world: World,
  command: TerrainEditCommand,
  cells: readonly number[],
  delta: number,
): number {
  const proposed = proposeTierEdit(world, cells, delta);
  for (const [cell, tier] of proposed) {
    const flags = (world.flags[cell] as number) & ~RAMP;
    command.record(world, cell, tier, flags);
  }
  return proposed.size;
}

/** Stage a flag edit (set or clear a bit) across a brush. */
export function stageFlagEdit(
  world: World,
  command: TerrainEditCommand,
  cells: readonly number[],
  flag: number,
  set: boolean,
): number {
  let changed = 0;
  for (const cell of cells) {
    const current = world.flags[cell] as number;
    const next = set ? current | flag : current & ~flag;
    if (next === current) continue;
    command.record(world, cell, world.tier[cell] as number, next);
    changed++;
  }
  return changed;
}

/** True when the world contains no isolated spires or pits. */
export function isTerrainLegal(world: World): boolean {
  return illegalCells(world).length === 0;
}

/**
 * Cells that stand two or more tiers from every one of their neighbours.
 * A cell on a two-tier cliff is legal; a cell surrounded by one is not.
 */
export function illegalCells(world: World): number[] {
  const bad: number[] = [];
  for (let cell = 0; cell < world.tier.length; cell++) {
    const tier = world.tier[cell] as number;
    const neighbours = neighbourCells(world, cell);
    if (neighbours.length === 0) continue;
    if (neighbours.some((n) => Math.abs((world.tier[n] as number) - tier) <= 1)) continue;
    bad.push(cell);
  }
  return bad;
}
