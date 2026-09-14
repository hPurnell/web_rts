/**
 * The fixed-step driver.
 *
 * The simulation advances in whole ticks at a constant rate; rendering happens
 * whenever the browser feels like it. This holds the accumulator that keeps
 * those two apart, and hands the renderer an interpolation alpha so motion
 * between ticks looks smooth rather than stepped.
 *
 * It lives outside src/sim deliberately: it is the one part of the loop that
 * deals in wall-clock seconds, and the simulation must never see them.
 */
import type { SimCommand } from './sim/commands.ts';
import type { Match } from './sim/match.ts';
import { TICKS_PER_SECOND } from './sim/ticks.ts';
import { stepMatch } from './sim/tick.ts';

export const SECONDS_PER_TICK = 1 / TICKS_PER_SECOND;

/**
 * The accumulator counts whole microseconds, not seconds.
 *
 * Not for drift: a float accumulator was measured over ten minutes at an
 * awkward frame rate and lost no more ticks than this one does. It is for the
 * boundary. With floats, an accumulator that should hold exactly one tick can
 * hold 0.049999999999999996 instead, so whether the tick runs this frame or
 * next depends on the order the frame times happened to arrive. Integers make
 * every comparison and subtraction exact, and make `alpha` exact with them.
 */
const MICROS_PER_SECOND = 1_000_000;
const MICROS_PER_TICK = MICROS_PER_SECOND / TICKS_PER_SECOND;

/**
 * Most ticks a single frame may run. Without this, a tab that was backgrounded
 * for a minute comes back owing 1,200 ticks, takes seconds to catch up, falls
 * further behind, and never recovers — the spiral of death.
 */
export const MAX_CATCHUP_TICKS = 5;

export interface Driver {
  readonly match: Match;
  /** Ticks completed since the match began. */
  tick(): number;
  /** Progress toward the next tick, 0..1, for render interpolation. */
  alpha(): number;
  /**
   * Advance by `seconds` of wall time. Returns how many ticks ran.
   * `commandsFor` supplies the commands scheduled for each tick.
   */
  advance(seconds: number, commandsFor?: (tick: number) => readonly SimCommand[]): number;
  /** Drop any accumulated time, e.g. after a pause. */
  resync(): void;
  /** Ticks dropped to the catch-up cap since the match began. */
  droppedTicks(): number;
}

export function createDriver(match: Match): Driver {
  let accumulatorMicros = 0;
  let dropped = 0;

  return {
    match,
    tick: () => match.tick,
    alpha: () => accumulatorMicros / MICROS_PER_TICK,
    droppedTicks: () => dropped,

    advance(seconds, commandsFor) {
      if (!Number.isFinite(seconds) || seconds <= 0) return 0;
      accumulatorMicros += Math.round(seconds * MICROS_PER_SECOND);

      let stepped = 0;
      while (accumulatorMicros >= MICROS_PER_TICK && stepped < MAX_CATCHUP_TICKS) {
        stepMatch(match, commandsFor?.(match.tick) ?? []);
        accumulatorMicros -= MICROS_PER_TICK;
        stepped++;
      }

      if (accumulatorMicros >= MICROS_PER_TICK) {
        // Still owed time after the cap: give up on the backlog rather than
        // carry it into the next frame, where it would only grow.
        dropped += Math.floor(accumulatorMicros / MICROS_PER_TICK);
        accumulatorMicros %= MICROS_PER_TICK;
      }
      return stepped;
    },

    resync() {
      accumulatorMicros = 0;
    },
  };
}
