/**
 * The determinism harness.
 *
 * Builds a match from a fixed seed, applies a scripted command list, steps N
 * ticks and hashes the result. Every simulation milestone extends SCRIPT and
 * regenerates the golden hash deliberately (`pnpm gen:golden-sim`), never
 * silently — a hash that changes without a matching script change is a desync
 * introduced by that commit.
 */
import type { Match } from '../src/sim/match.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { cellIndex } from '../src/sim/world.ts';
import type { ScheduledCommand, SimCommand } from '../src/sim/commands.ts';
import { CommandKind } from '../src/sim/commands.ts';
import { fromInt, fromRatio } from '../src/sim/fixed.ts';
import { makeHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import { stepMatch } from '../src/sim/tick.ts';

/**
 * The script runs on the fixture map, so movement has real terrain to path
 * over: cliffs, ramps and chokepoints are exactly where a desync would hide.
 */
export const SCRIPT_WORLD = createTestMap();
export const SCRIPT_SEED = 0xc0ffee;
export const SCRIPT_PLAYERS = 2;
export const SCRIPT_TICKS = 600; // 30 seconds at 20Hz

/**
 * The scripted command list. Append to it in every simulation milestone; do not
 * reorder or renumber existing entries, since the golden hash depends on both
 * the content and the order.
 */
export const SCRIPT: readonly ScheduledCommand[] = [
  { tick: 0, command: { kind: CommandKind.GrantResources, player: 0, minerals: 50, gas: 0 } },
  { tick: 0, command: { kind: CommandKind.GrantResources, player: 1, minerals: 50, gas: 0 } },
  { tick: 5, command: { kind: CommandKind.Noop } },
  { tick: 37, command: { kind: CommandKind.GrantResources, player: 0, minerals: 125, gas: 25 } },
  { tick: 37, command: { kind: CommandKind.GrantResources, player: 1, minerals: -10, gas: 0 } },
  // Out-of-range player: must be ignored identically on every client.
  { tick: 40, command: { kind: CommandKind.GrantResources, player: 7, minerals: 999, gas: 999 } },
  { tick: 120, command: { kind: CommandKind.GrantResources, player: 1, minerals: 300, gas: 0 } },
  { tick: 121, command: { kind: CommandKind.GrantResources, player: 0, minerals: -1000, gas: 0 } },
  { tick: 480, command: { kind: CommandKind.GrantResources, player: 0, minerals: 75, gas: 75 } },
  { tick: 599, command: { kind: CommandKind.GrantResources, player: 1, minerals: 1, gas: 1 } },

  // M14: unit storage. Spawns cover both players and several types, at
  // fractional positions so a float creeping into a coordinate shows up.
  ...spawnWave(10, 0, 'worker', 6, 8, 12),
  ...spawnWave(10, 1, 'worker', 6, 44, 44),
  ...spawnWave(60, 0, 'soldier', 4, 14, 20),
  ...spawnWave(60, 1, 'soldier', 4, 40, 36),
  ...spawnWave(90, 0, 'raider', 2, 18, 24),
  ...spawnWave(90, 1, 'siege', 1, 38, 32),
  // Kill some of them, so slot reuse and generation bumps are hashed too.
  { tick: 140, command: { kind: CommandKind.DespawnUnit, handle: makeHandle(2, 1) } },
  { tick: 140, command: { kind: CommandKind.DespawnUnit, handle: makeHandle(13, 1) } },
  { tick: 141, command: { kind: CommandKind.DespawnUnit, handle: makeHandle(2, 1) } }, // already dead
  // Respawns must land in the recycled slots with new generations.
  ...spawnWave(200, 0, 'soldier', 3, 22, 26),
  // Commands every client must ignore identically.
  { tick: 210, command: { kind: CommandKind.SpawnUnit, player: 5, typeId: 0, x: 0, z: 0 } },
  { tick: 210, command: { kind: CommandKind.SpawnUnit, player: 0, typeId: 99, x: 0, z: 0 } },
  { tick: 210, command: { kind: CommandKind.DespawnUnit, handle: makeHandle(9000, 3) } },

  // M20: movement. Marching two armies across the map exercises flow fields,
  // separation, cliff rejection and the stuck rule, all of which write to
  // state the hash covers.
  {
    tick: 220,
    command: {
      kind: CommandKind.MoveUnits,
      player: 0,
      handles: handleRange(0, 12),
      goalCell: cellIndex(SCRIPT_WORLD, 40, 40),
    },
  },
  {
    tick: 220,
    command: {
      kind: CommandKind.MoveUnits,
      player: 1,
      handles: handleRange(12, 24),
      goalCell: cellIndex(SCRIPT_WORLD, 20, 18),
    },
  },
  // A second order mid-march, which must reset progress tracking.
  {
    tick: 320,
    command: {
      kind: CommandKind.MoveUnits,
      player: 0,
      handles: handleRange(0, 6),
      goalCell: cellIndex(SCRIPT_WORLD, 8, 12),
    },
  },
  { tick: 420, command: { kind: CommandKind.StopUnits, player: 1, handles: handleRange(12, 18) } },
  // An order from the wrong player, which must be ignored identically.
  {
    tick: 430,
    command: {
      kind: CommandKind.MoveUnits,
      player: 1,
      handles: handleRange(0, 4),
      goalCell: cellIndex(SCRIPT_WORLD, 60, 60),
    },
  },
];

/** Handles for slots [from, to), all at generation 1. */
function handleRange(from: number, to: number): number[] {
  const handles: number[] = [];
  for (let i = from; i < to; i++) handles.push(makeHandle(i, 1));
  return handles;
}

/**
 * A row of units spawned on one tick. Positions are offset by an exact
 * fraction of a cell so the coordinates are not all whole numbers.
 */
function spawnWave(
  tick: number,
  player: number,
  typeId: string,
  count: number,
  x: number,
  z: number,
): ScheduledCommand[] {
  const type = unitTypeById(typeId);
  const commands: ScheduledCommand[] = [];
  for (let i = 0; i < count; i++) {
    commands.push({
      tick,
      command: {
        kind: CommandKind.SpawnUnit,
        player,
        typeId: type.typeId,
        x: fromInt(x + i) + fromRatio(1, 3),
        z: fromInt(z) + fromRatio(i, 7),
        facing: fromRatio(i, 4),
      },
    });
  }
  return commands;
}

/** Bucket the script by tick, so stepping is a lookup rather than a scan. */
function byTick(script: readonly ScheduledCommand[]): Map<number, SimCommand[]> {
  const map = new Map<number, SimCommand[]>();
  for (const { tick, command } of script) {
    const list = map.get(tick);
    if (list) list.push(command);
    else map.set(tick, [command]);
  }
  return map;
}

export interface RunOptions {
  readonly seed?: number;
  readonly players?: number;
  readonly ticks?: number;
  readonly script?: readonly ScheduledCommand[];
  /** Called after every tick — used to sample intermediate hashes. */
  readonly onTick?: (match: Match) => void;
}

/** Run the scripted match and return the final state. */
export function runScript(options: RunOptions = {}): Match {
  const world = SCRIPT_WORLD;
  const match = createMatchFromWorld({
    world,
    seed: options.seed ?? SCRIPT_SEED,
    playerCount: options.players ?? SCRIPT_PLAYERS,
    // The script spawns everything itself, so the opening position does not
    // silently shift the hash when starting forces change.
    startingWorkers: 0,
  });
  const context = { world };
  const schedule = byTick(options.script ?? SCRIPT);
  const ticks = options.ticks ?? SCRIPT_TICKS;
  for (let t = 0; t < ticks; t++) {
    stepMatch(match, schedule.get(t) ?? [], context);
    options.onTick?.(match);
  }
  return match;
}

/** Final state hash of the scripted match. */
export function runScriptHash(options: RunOptions = {}): number {
  return hashMatch(runScript(options));
}

/** Hash checkpoints every `interval` ticks, for locating a divergence. */
export function runScriptCheckpoints(interval = 100, options: RunOptions = {}): number[] {
  const checkpoints: number[] = [];
  runScript({
    ...options,
    onTick: (match) => {
      if (match.tick % interval === 0) checkpoints.push(hashMatch(match));
    },
  });
  return checkpoints;
}
