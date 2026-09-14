/**
 * The simulation rate. Lives on its own so data tables and the tick loop can
 * both use it without importing each other.
 */
export const TICKS_PER_SECOND = 20;

/** Whole ticks in a number of seconds, rounded to nearest. */
export function ticksFromSeconds(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}
