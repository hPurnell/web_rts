/**
 * The fixed-step loop body. One call is one simulation tick.
 *
 * The accumulator-driven driver that calls this at a fixed rate arrives in
 * M15; this is the pure step, so tests and replays can drive it directly.
 */
import type { SimCommand } from './commands.ts';
import { applyCommand } from './commands.ts';
import type { Match } from './match.ts';

export { TICKS_PER_SECOND } from './ticks.ts';

/**
 * Advance the match by one tick.
 *
 * Commands are applied first, in the order given, so that every client sees the
 * same ordering; systems then run in a fixed sequence. The tick counter
 * increments last, so a command scheduled for tick N sees `match.tick === N`.
 */
export function stepMatch(match: Match, commands: readonly SimCommand[] = []): void {
  for (const command of commands) applyCommand(match, command);

  // Systems run here in a fixed order as later milestones add them:
  // orders -> movement -> combat -> gathering -> production -> fog.

  match.tick = (match.tick + 1) | 0;
}
