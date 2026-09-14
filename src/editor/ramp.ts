/**
 * Ramp placement.
 *
 * A ramp is dragged from the high side to the low side of a cliff. The drag
 * defines an axis; the ramp is a rectangle of cells along it, set to the lower
 * of the two tiers and flagged RAMP, which is exactly the shape
 * `tiersConnect` accepts and `solveRamps` slopes.
 *
 * A ramp bridges one tier. That is not an arbitrary limit: `tiersConnect` only
 * joins cells one tier apart, so a ramp spanning two tiers would render as a
 * slope that units cannot actually walk.
 */
import type { World } from '../sim/world.ts';
import { MAX_TIER, RAMP, WALKABLE, cellIndex } from '../sim/world.ts';
import type { TerrainEditCommand } from './commands.ts';

export const DEFAULT_RAMP_WIDTH = 3;
export const MIN_RAMP_LENGTH = 2;
export const MAX_RAMP_LENGTH = 12;

export interface RampPlan {
  readonly ok: boolean;
  /** Why the ramp cannot be placed, when ok is false. */
  readonly reason: string | null;
  readonly cells: readonly number[];
  readonly highTier: number;
  readonly lowTier: number;
}

const REJECT = (reason: string): RampPlan => ({
  ok: false,
  reason,
  cells: [],
  highTier: 0,
  lowTier: 0,
});

/**
 * Work out the ramp a drag describes, without touching the world.
 *
 * `from` should be on the high side and `to` on the low side, but the two are
 * swapped automatically if the drag went the other way — insisting on a
 * direction is the kind of thing that makes an editor annoying to use.
 */
export function planRamp(
  world: World,
  from: number,
  to: number,
  width = DEFAULT_RAMP_WIDTH,
): RampPlan {
  if (from < 0 || to < 0 || from >= world.tier.length || to >= world.tier.length) {
    return REJECT('drag both ends onto the map');
  }

  let high = from;
  let low = to;
  if ((world.tier[high] as number) < (world.tier[low] as number)) {
    [high, low] = [low, high];
  }

  const highTier = world.tier[high] as number;
  const lowTier = world.tier[low] as number;
  if (highTier === lowTier) return REJECT('a ramp must join two different tiers');
  if (highTier - lowTier !== 1) return REJECT('a ramp joins tiers one step apart');

  if (((world.flags[high] as number) & WALKABLE) === 0) return REJECT('the high end is not walkable');
  if (((world.flags[low] as number) & WALKABLE) === 0) return REJECT('the low end is not walkable');

  const hx = high % world.width;
  const hy = (high / world.width) | 0;
  const lx = low % world.width;
  const ly = (low / world.width) | 0;

  const dx = lx - hx;
  const dy = ly - hy;
  const length = Math.max(Math.abs(dx), Math.abs(dy)) + 1;
  if (length < MIN_RAMP_LENGTH) return REJECT('drag further to set the ramp direction');
  if (length > MAX_RAMP_LENGTH) return REJECT(`a ramp is at most ${MAX_RAMP_LENGTH} cells long`);

  // Snap to the dominant axis: a ramp runs straight, so diagonal drags pick
  // the axis they travelled furthest along.
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const stepX = horizontal ? Math.sign(dx) : 0;
  const stepY = horizontal ? 0 : Math.sign(dy);
  const perpX = horizontal ? 0 : 1;
  const perpY = horizontal ? 1 : 0;

  const half = Math.floor(Math.max(1, width) / 2);
  const cells: number[] = [];
  for (let step = 0; step < length; step++) {
    for (let side = -half; side <= half; side++) {
      const cx = hx + stepX * step + perpX * side;
      const cy = hy + stepY * step + perpY * side;
      const cell = cellIndex(world, cx, cy);
      if (cell < 0) return REJECT('the ramp runs off the map');
      cells.push(cell);
    }
  }

  return { ok: true, reason: null, cells, highTier, lowTier };
}

/**
 * Stage a planned ramp into a command.
 *
 * Ramp cells take the lower tier and become walkable, which is what makes the
 * connectivity rule in `tiersConnect` accept them from both sides.
 */
export function stageRamp(world: World, command: TerrainEditCommand, plan: RampPlan): number {
  if (!plan.ok) return 0;
  const tier = Math.max(0, Math.min(MAX_TIER, plan.lowTier));
  let changed = 0;
  for (const cell of plan.cells) {
    const flags = ((world.flags[cell] as number) | WALKABLE | RAMP) & 0xff;
    if (world.tier[cell] === tier && world.flags[cell] === flags) continue;
    command.record(world, cell, tier, flags);
    changed++;
  }
  return changed;
}

/** Clear the RAMP flag from a brush, for erasing a mistake. */
export function stageRampErase(
  world: World,
  command: TerrainEditCommand,
  cells: readonly number[],
): number {
  let changed = 0;
  for (const cell of cells) {
    const current = world.flags[cell] as number;
    if ((current & RAMP) === 0) continue;
    command.record(world, cell, world.tier[cell] as number, current & ~RAMP);
    changed++;
  }
  return changed;
}
