import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_INTERVAL,
  REPLAY_VERSION,
  ReplayError,
  createRecorder,
  decodeReplay,
  describeReplay,
  encodeReplay,
  scheduleOf,
} from '../src/sim/replay.ts';
import type { Replay } from '../src/sim/replay.ts';
import { createReplayPlayer, verifyReplay, PLAYBACK_SPEEDS } from '../src/replayplayer.ts';
import { createDriver, SECONDS_PER_TICK } from '../src/driver.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { CommandKind } from '../src/sim/commands.ts';
import type { SimCommand } from '../src/sim/commands.ts';
import { OrderKind, NULL_HANDLE, makeHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import * as w from '../src/sim/world.ts';
import { fromInt } from '../src/sim/fixed.ts';

const TICKS_PER_MINUTE = 20 * 60;

/**
 * Play a scripted match, recording it. The script is deliberately varied:
 * spawns, orders, combat and production all write to state the hash covers.
 */
function recordMatch(world: w.World, ticks: number): { replay: Replay; hash: number } {
  const match = createMatchFromWorld({
    world,
    seed: 0xbeef,
    playerCount: 2,
    startingWorkers: 4,
    startingDepots: 1,
    startingMinerals: 500,
    costGrid: createCostGrid(world),
  });
  const driver = createDriver(match, { world });
  const recorder = createRecorder({
    seed: 0xbeef,
    playerCount: 2,
    mapHash: w.hashWorld(world),
    startingWorkers: 4,
    startingDepots: 1,
    startingMinerals: 500,
    now: 0,
  });

  const script = new Map<number, SimCommand[]>([
    [
      10,
      [
        { kind: CommandKind.SpawnUnit, player: 0, typeId: unitTypeById('soldier').typeId, x: fromInt(30), z: fromInt(30) },
        { kind: CommandKind.SpawnUnit, player: 1, typeId: unitTypeById('soldier').typeId, x: fromInt(36), z: fromInt(30) },
      ],
    ],
    [
      40,
      [
        {
          kind: CommandKind.IssueOrders,
          player: 0,
          handles: [makeHandle(10, 1), makeHandle(11, 1)],
          order: { kind: OrderKind.Move, cell: w.cellIndex(world, 40, 40), target: NULL_HANDLE },
          queue: false,
        },
      ],
    ],
    [
      200,
      [{ kind: CommandKind.GrantResources, player: 0, minerals: 400, gas: 100 }],
    ],
    [
      260,
      [
        {
          kind: CommandKind.PlaceBuilding,
          player: 0,
          typeId: unitTypeById('barracks').typeId,
          cell: w.cellIndex(world, 30, 34),
        },
      ],
    ],
  ]);

  for (let tick = 0; tick < ticks; tick++) {
    const commands = script.get(tick) ?? [];
    recorder.record(tick, commands);
    driver.advance(SECONDS_PER_TICK, () => commands);
    recorder.checkpoint(match);
  }

  return { replay: recorder.finish(match), hash: hashMatch(match) };
}

describe('recording', () => {
  it('captures the seed, the map and the command stream', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 300);

    expect(replay.version).toBe(REPLAY_VERSION);
    expect(replay.seed).toBe(0xbeef);
    expect(replay.mapHash).toBe(w.hashWorld(world));
    expect(replay.ticks).toBe(300);
    expect(replay.commands.length).toBeGreaterThan(0);
    // Only the ticks that had commands are recorded, not every tick.
    expect(replay.commands.length).toBeLessThan(20);
  });

  it('takes a checkpoint every hundred ticks', () => {
    const { replay } = recordMatch(createTestMap(), 450);
    expect(replay.checkpoints.map((c) => c.tick)).toEqual([100, 200, 300, 400]);
    for (const checkpoint of replay.checkpoints) expect(checkpoint.hash).toBeGreaterThan(0);
  });
});

describe('playback', () => {
  it('replays a five-minute match to an identical final hash', () => {
    const world = createTestMap();
    const { replay, hash } = recordMatch(world, 5 * TICKS_PER_MINUTE);
    expect(replay.ticks).toBe(6000);

    const result = verifyReplay(replay, world);
    expect(result.ok).toBe(true);
    expect(result.finalHash).toBe(hash);
    expect(result.divergence).toBeNull();
  });

  it('runs from the commands alone, not from recorded state', () => {
    // The replay holds no positions or hit points: everything is re-derived.
    const world = createTestMap();
    const { replay } = recordMatch(world, 600);
    const serialised = encodeReplay(replay);
    expect(serialised).not.toContain('posX');
    expect(serialised).not.toContain('"hp"');

    const player = createReplayPlayer({ replay, world });
    expect(player.match.units.alive).toBeGreaterThan(0);
    expect(player.runToEnd()).toBe(replay.finalHash);
  });

  it('pauses and resumes', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 400);
    const player = createReplayPlayer({ replay, world });

    player.advance(1);
    const tick = player.match.tick;
    expect(tick).toBeGreaterThan(0);

    player.paused = true;
    player.advance(1);
    expect(player.match.tick).toBe(tick);

    player.paused = false;
    player.advance(1);
    expect(player.match.tick).toBeGreaterThan(tick);
  });

  it('plays faster and slower without changing the outcome', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 600);

    const atSpeed = (speed: number): number => {
      const player = createReplayPlayer({ replay, world });
      player.speed = speed;
      // Feed it wall time until it finishes; speed only changes how much
      // simulated time each second of wall time buys.
      let guard = 0;
      while (!player.finished() && guard++ < 100_000) player.advance(SECONDS_PER_TICK);
      return hashMatch(player.match);
    };

    expect(PLAYBACK_SPEEDS).toContain(1);
    expect(atSpeed(4)).toBe(replay.finalHash);
    expect(atSpeed(0.5)).toBe(replay.finalHash);
  });

  it('reports progress and completion', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 400);
    const player = createReplayPlayer({ replay, world });
    expect(player.progress()).toBe(0);
    expect(player.finished()).toBe(false);
    player.runToEnd();
    expect(player.finished()).toBe(true);
    expect(player.progress()).toBe(1);
  });
});

describe('divergence reporting', () => {
  it('names the exact tick a replay stopped matching', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 600);

    // Corrupt a checkpoint in the middle: playback must notice at that tick,
    // not at the end, and must not report the ones after it.
    const broken: Replay = {
      ...replay,
      checkpoints: replay.checkpoints.map((c) =>
        c.tick === 300 ? { tick: c.tick, hash: c.hash ^ 0xdeadbeef } : c,
      ),
    };

    const player = createReplayPlayer({ replay: broken, world });
    player.runToEnd();
    const divergence = player.divergence();
    expect(divergence?.tick).toBe(300);
    expect(divergence?.expected).not.toBe(divergence?.actual);
    expect(CHECKPOINT_INTERVAL).toBe(100);
  });

  it('reports a replay whose final hash is wrong', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 400);
    const result = verifyReplay({ ...replay, finalHash: replay.finalHash + 1 }, world);
    expect(result.ok).toBe(false);
  });
});

describe('replay files', () => {
  it('round-trips through text', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 300);
    const restored = decodeReplay(encodeReplay(replay), w.hashWorld(world));
    expect(restored.finalHash).toBe(replay.finalHash);
    expect(restored.commands).toEqual(replay.commands);
    expect(verifyReplay(restored, world).ok).toBe(true);
  });

  it('refuses a replay recorded on a different map', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 100);
    const other = createTestMap();
    other.tier[0] = 3;

    expect(() => decodeReplay(encodeReplay(replay), w.hashWorld(other))).toThrow(ReplayError);
    expect(() => createReplayPlayer({ replay, world: other })).toThrow(/different map/);
  });

  it('refuses a version it does not know, and junk', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 100);
    expect(() => decodeReplay(encodeReplay({ ...replay, version: 99 }))).toThrow(/version 99/);
    expect(() => decodeReplay('not json at all')).toThrow(/not a replay/);
  });

  it('buckets commands by tick for playback', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 300);
    const schedule = scheduleOf(replay);
    expect(schedule.get(10)).toHaveLength(2);
    expect(schedule.get(11)).toBeUndefined();
  });

  it('summarises itself', () => {
    const world = createTestMap();
    const { replay } = recordMatch(world, 5 * TICKS_PER_MINUTE);
    expect(describeReplay(replay)).toMatch(/^2p, 5m 0s, \d+ commands$/);
  });
});
