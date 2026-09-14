/**
 * Replays.
 *
 * A replay is the initial seed, the map it was played on, and the command
 * stream — nothing else. Playback re-runs the simulation from those commands,
 * which is only possible because the simulation is deterministic, and is
 * exactly why this comes before netcode: it is the same machinery, it is
 * testable entirely offline, and it turns a future desync from a mystery into
 * a bug report with a tick number attached.
 */
import type { ScheduledCommand, SimCommand } from './commands.ts';
import type { Match } from './match.ts';
import { hashMatch } from './statehash.ts';

export const REPLAY_VERSION = 1;
/** Ticks between recorded state hashes. */
export const CHECKPOINT_INTERVAL = 100;

export interface ReplayCheckpoint {
  readonly tick: number;
  readonly hash: number;
}

export interface Replay {
  readonly version: number;
  readonly seed: number;
  readonly playerCount: number;
  /** hashWorld of the map, so a replay cannot be played on the wrong one. */
  readonly mapHash: number;
  readonly startingWorkers: number;
  readonly startingDepots: number;
  readonly startingMinerals: number;
  readonly ticks: number;
  readonly commands: readonly ScheduledCommand[];
  readonly checkpoints: readonly ReplayCheckpoint[];
  readonly finalHash: number;
  /** Wall-clock start, for display only. Never fed to the simulation. */
  readonly recordedAt: number;
}

export interface ReplayRecorder {
  /** Record the commands applied on a tick. Call before stepping it. */
  record(tick: number, commands: readonly SimCommand[]): void;
  /** Take a checkpoint if this tick is due one. Call after stepping. */
  checkpoint(match: Match): void;
  /** Finish and return the replay. */
  finish(match: Match): Replay;
  commandCount(): number;
}

export interface RecorderInit {
  readonly seed: number;
  readonly playerCount: number;
  readonly mapHash: number;
  readonly startingWorkers?: number;
  readonly startingDepots?: number;
  readonly startingMinerals?: number;
  /** Injected so a recording is reproducible in a test. */
  readonly now?: number;
}

export function createRecorder(init: RecorderInit): ReplayRecorder {
  const commands: ScheduledCommand[] = [];
  const checkpoints: ReplayCheckpoint[] = [];

  return {
    record(tick, tickCommands) {
      for (const command of tickCommands) commands.push({ tick, command });
    },

    checkpoint(match) {
      // Checkpoints are the difference between "the replay diverged" and "the
      // replay diverged at tick 3,400", which is the difference between a
      // mystery and a bug report.
      if (match.tick % CHECKPOINT_INTERVAL !== 0) return;
      checkpoints.push({ tick: match.tick, hash: hashMatch(match) });
    },

    commandCount: () => commands.length,

    finish(match) {
      return {
        version: REPLAY_VERSION,
        seed: init.seed,
        playerCount: init.playerCount,
        mapHash: init.mapHash,
        startingWorkers: init.startingWorkers ?? 6,
        startingDepots: init.startingDepots ?? 1,
        startingMinerals: init.startingMinerals ?? 50,
        ticks: match.tick,
        commands: [...commands],
        checkpoints: [...checkpoints],
        finalHash: hashMatch(match),
        recordedAt: init.now ?? 0,
      };
    },
  };
}

export class ReplayError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

/** Commands bucketed by tick, ready to feed a driver. */
export function scheduleOf(replay: Replay): Map<number, SimCommand[]> {
  const schedule = new Map<number, SimCommand[]>();
  for (const { tick, command } of replay.commands) {
    const list = schedule.get(tick);
    if (list) list.push(command);
    else schedule.set(tick, [command]);
  }
  return schedule;
}

export interface DivergenceReport {
  /** The first tick whose hash disagreed, or -1 when none did. */
  readonly tick: number;
  readonly expected: number;
  readonly actual: number;
}

export const NO_DIVERGENCE: DivergenceReport = { tick: -1, expected: 0, actual: 0 };

/**
 * Compare a live match against a replay's checkpoints as it plays back.
 *
 * Returns the first disagreement, which is the tick the bug is in — not the
 * tick where it became visible.
 */
export function checkCheckpoint(
  replay: Replay,
  match: Match,
  found: Map<number, number>,
): DivergenceReport | null {
  if (match.tick % CHECKPOINT_INTERVAL !== 0) return null;
  const hash = hashMatch(match);
  found.set(match.tick, hash);
  const expected = replay.checkpoints.find((c) => c.tick === match.tick);
  if (!expected || expected.hash === hash) return null;
  return { tick: match.tick, expected: expected.hash, actual: hash };
}

/** Serialize. JSON, because a replay is a few hundred small objects and being
 * able to read one in a text editor is worth more than the bytes. */
export function encodeReplay(replay: Replay): string {
  return JSON.stringify(replay);
}

export function decodeReplay(text: string, mapHash?: number): Replay {
  let parsed: Replay;
  try {
    parsed = JSON.parse(text) as Replay;
  } catch {
    throw new ReplayError('That file is not a replay.', 'parse');
  }

  if (parsed.version !== REPLAY_VERSION) {
    throw new ReplayError(
      `This replay is version ${parsed.version}, but this build plays version ${REPLAY_VERSION}.`,
      'version',
    );
  }
  if (!Array.isArray(parsed.commands)) {
    throw new ReplayError('This replay has no command stream.', 'commands');
  }
  if (mapHash !== undefined && parsed.mapHash !== mapHash) {
    // Playing a replay on the wrong map produces nonsense that looks like a
    // desync, so it is refused rather than attempted.
    throw new ReplayError('This replay was recorded on a different map.', 'map');
  }
  return parsed;
}

/** A short human summary, for a replay list. */
export function describeReplay(replay: Replay): string {
  const seconds = Math.round(replay.ticks / 20);
  const minutes = Math.floor(seconds / 60);
  return `${replay.playerCount}p, ${minutes}m ${seconds % 60}s, ${replay.commands.length} commands`;
}
