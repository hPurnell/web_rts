/**
 * The fixed-step loop body. One call is one simulation tick.
 *
 * The accumulator-driven driver that calls this at a fixed rate arrives in
 * M15; this is the pure step, so tests and replays can drive it directly.
 */
import type { SimCommand } from './commands.ts';
import { applyCommand } from './commands.ts';
import type { Match } from './match.ts';
import { ensureField } from './navcache.ts';
import { stepMovement } from './movement.ts';
import { stepOrders } from './orders.ts';
import { FOG_INTERVAL_TICKS, updateFog } from './fog.ts';
import { stepCombat } from './combat.ts';
import { stepEconomy } from './economy.ts';
import { stepBuildings } from './building.ts';
import type { World } from './world.ts';

export { TICKS_PER_SECOND } from './ticks.ts';

/**
 * Everything a tick needs that is not match state.
 *
 * The world is read-only here (invariant 4) and the navigation grid is derived
 * from it, so both are inputs rather than part of the state being advanced.
 */
export interface TickContext {
  readonly world: World;
}

/**
 * Advance the match by one tick.
 *
 * Commands are applied first, in the order given, so that every client sees the
 * same ordering; systems then run in a fixed sequence. The tick counter
 * increments last, so a command scheduled for tick N sees `match.tick === N`.
 */
export function stepMatch(
  match: Match,
  commands: readonly SimCommand[] = [],
  context?: TickContext,
): void {
  for (const command of commands) applyCommand(match, command, context?.world);

  // Systems run in a fixed order. Later milestones fill in the rest:
  // orders -> movement -> combat -> gathering -> production -> fog.
  if (context && match.costGrid) {
    const grid = match.costGrid;
    stepOrders(match, context);
    stepBuildings(match, context);
    stepEconomy(match, context);
    match.spatialHash = stepMovement(match, {
      world: context.world,
      grid,
      hash: match.spatialHash,
      field: (goalCell) => ensureField(match.fields, grid, goalCell),
    });

    stepCombat(match, context);

    // Vision last: it reports where units ended up this tick, and combat reads
    // it next tick.
    if (match.tick % FOG_INTERVAL_TICKS === 0) updateFog(match, context.world);
  }

  match.tick = (match.tick + 1) | 0;
}
