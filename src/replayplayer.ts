/**
 * Replay playback.
 *
 * Sits where the driver sits during a live match, feeding the simulation the
 * recorded commands instead of the player's. Playback speed and pausing are
 * purely about how fast wall time is handed to the accumulator, so the
 * simulation itself is stepped exactly as it was recorded — which is what
 * makes the final hash match.
 *
 * Lives outside src/sim for the same reason the driver does: it deals in
 * wall-clock seconds.
 */
import type { Driver } from './driver.ts';
import { createDriver } from './driver.ts';
import type { Match } from './sim/match.ts';
import { createMatchFromWorld } from './sim/matchinit.ts';
import type { World } from './sim/world.ts';
import { hashWorld } from './sim/world.ts';
import type { CostGrid } from './nav/grid.ts';
import type { DivergenceReport, Replay } from './sim/replay.ts';
import { ReplayError, checkCheckpoint, scheduleOf } from './sim/replay.ts';
import { hashMatch } from './sim/statehash.ts';

/** Speeds the UI offers. 1 is the rate the match was played at. */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8] as const;

export interface ReplayPlayer {
  readonly replay: Replay;
  readonly driver: Driver;
  readonly match: Match;
  paused: boolean;
  speed: number;
  /** Advance by wall-clock seconds, scaled by speed. */
  advance(seconds: number, beforeTick?: () => void): number;
  /** Run to the end as fast as possible. Returns the final hash. */
  runToEnd(): number;
  /** The first checkpoint that disagreed, or null. */
  divergence(): DivergenceReport | null;
  finished(): boolean;
  progress(): number;
}

export interface ReplayPlayerInit {
  readonly replay: Replay;
  readonly world: World;
  readonly costGrid?: CostGrid;
}

export function createReplayPlayer(init: ReplayPlayerInit): ReplayPlayer {
  const { replay, world } = init;
  if (replay.mapHash !== hashWorld(world)) {
    throw new ReplayError('This replay was recorded on a different map.', 'map');
  }

  const match = createMatchFromWorld({
    world,
    seed: replay.seed,
    playerCount: replay.playerCount,
    startingWorkers: replay.startingWorkers,
    startingDepots: replay.startingDepots,
    startingMinerals: replay.startingMinerals,
    ...(init.costGrid ? { costGrid: init.costGrid } : {}),
  });

  const driver = createDriver(match, { world });
  const schedule = scheduleOf(replay);
  const seen = new Map<number, number>();
  let diverged: DivergenceReport | null = null;

  const step = (): void => {
    const report = checkCheckpoint(replay, match, seen);
    // Only the first divergence is kept: everything after it is downstream of
    // the same bug, and reporting the hundredth is no help.
    if (report && !diverged) diverged = report;
  };

  const player: ReplayPlayer = {
    replay,
    driver,
    match,
    paused: false,
    speed: 1,

    advance(seconds, beforeTick) {
      if (player.paused || player.finished()) return 0;
      return driver.advance(
        seconds * player.speed,
        (tick) => schedule.get(tick) ?? [],
        beforeTick,
        step,
      );
    },

    runToEnd() {
      // Stepped directly rather than through wall time: a five-minute replay
      // verifies in milliseconds.
      while (match.tick < replay.ticks) {
        driver.advance(1, (tick) => schedule.get(tick) ?? [], undefined, step);
      }
      return hashMatch(match);
    },

    divergence: () => diverged,
    finished: () => match.tick >= replay.ticks,
    progress: () => (replay.ticks === 0 ? 1 : Math.min(1, match.tick / replay.ticks)),
  };

  return player;
}

/**
 * Verify a replay offline: re-run it and compare the final hash.
 *
 * This is the check that keeps determinism honest between milestones, and the
 * one a desync report will run first.
 */
export function verifyReplay(
  replay: Replay,
  world: World,
  costGrid?: CostGrid,
): { ok: boolean; finalHash: number; divergence: DivergenceReport | null } {
  const player = createReplayPlayer({
    replay,
    world,
    ...(costGrid ? { costGrid } : {}),
  });
  const finalHash = player.runToEnd();
  return {
    ok: finalHash === replay.finalHash && player.divergence() === null,
    finalHash,
    divergence: player.divergence(),
  };
}
