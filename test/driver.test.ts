import { describe, expect, it } from 'vitest';
import { MAX_CATCHUP_TICKS, SECONDS_PER_TICK, createDriver } from '../src/driver.ts';
import { createMatch } from '../src/sim/match.ts';
import { createMatchFromWorld, STARTING_MINERALS, STARTING_WORKERS } from '../src/sim/matchinit.ts';
import { TICKS_PER_SECOND } from '../src/sim/ticks.ts';
import { CommandKind } from '../src/sim/commands.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import * as w from '../src/sim/world.ts';
import { forEachUnit } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';

const driverFor = () => createDriver(createMatch({ seed: 1, playerCount: 2 }));

/** Run `seconds` of wall time in frames of `frameSeconds`. */
function runAtFrameRate(seconds: number, fps: number): number {
  const driver = driverFor();
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) driver.advance(1 / fps);
  return driver.tick();
}

describe('fixed-step driver', () => {
  it('runs 20 ticks per second whatever the frame rate', () => {
    // The whole point: a 144fps machine and a 30fps machine must simulate the
    // same number of ticks over the same wall time. A single tick of slack is
    // inherent — ten seconds of frames rarely sums to exactly ten seconds, so
    // the last tick can fall either side of the boundary — but drift beyond
    // that would mean the accumulator is losing time.
    for (const fps of [30, 60, 75, 144]) {
      const ticks = runAtFrameRate(10, fps);
      expect(ticks, `${fps}fps`).toBeGreaterThanOrEqual(10 * TICKS_PER_SECOND - 1);
      expect(ticks, `${fps}fps`).toBeLessThanOrEqual(10 * TICKS_PER_SECOND);
    }
  });

  it('keeps the rate over a long match', () => {
    // Ten minutes at an awkward frame rate: the tick count must still track
    // wall time to within the one-tick boundary slack, not drift away from it.
    const ticks = runAtFrameRate(600, 61);
    expect(ticks).toBeGreaterThanOrEqual(600 * TICKS_PER_SECOND - 1);
    expect(ticks).toBeLessThanOrEqual(600 * TICKS_PER_SECOND);
  });

  it('runs the same number of ticks under an irregular frame rate', () => {
    const driver = driverFor();
    let elapsed = 0;
    // A stuttering frame time that averages out, as a real browser produces.
    const frameTimes = [1 / 60, 1 / 90, 1 / 45, 1 / 120, 1 / 30];
    let i = 0;
    while (elapsed < 10) {
      const dt = frameTimes[i++ % frameTimes.length] as number;
      driver.advance(dt);
      elapsed += dt;
    }
    expect(driver.tick()).toBeGreaterThanOrEqual(10 * TICKS_PER_SECOND - 1);
    expect(driver.tick()).toBeLessThanOrEqual(10 * TICKS_PER_SECOND + 1);
  });

  it('never runs a partial tick', () => {
    const driver = driverFor();
    expect(driver.advance(SECONDS_PER_TICK * 0.9)).toBe(0);
    expect(driver.tick()).toBe(0);
    expect(driver.advance(SECONDS_PER_TICK * 0.2)).toBe(1);
    expect(driver.tick()).toBe(1);
  });

  it('reports an interpolation alpha between ticks', () => {
    const driver = driverFor();
    expect(driver.alpha()).toBe(0);
    driver.advance(SECONDS_PER_TICK / 2);
    expect(driver.alpha()).toBeCloseTo(0.5, 6);
    driver.advance(SECONDS_PER_TICK / 2);
    expect(driver.tick()).toBe(1);
    expect(driver.alpha()).toBeCloseTo(0, 6);
  });

  it('caps catch-up and drops the backlog instead of spiralling', () => {
    const driver = driverFor();
    // A tab backgrounded for a minute comes back owing 1,200 ticks.
    const ran = driver.advance(60);
    expect(ran).toBe(MAX_CATCHUP_TICKS);
    expect(driver.droppedTicks()).toBeGreaterThan(1000);
    // And the very next frame is back to normal rather than still catching up.
    expect(driver.advance(SECONDS_PER_TICK)).toBe(1);
    expect(driver.alpha()).toBeLessThan(1);
  });

  it('ignores nonsense frame times', () => {
    const driver = driverFor();
    expect(driver.advance(0)).toBe(0);
    expect(driver.advance(-1)).toBe(0);
    expect(driver.advance(Number.NaN)).toBe(0);
    expect(driver.tick()).toBe(0);
  });

  it('resyncs without stepping', () => {
    const driver = driverFor();
    driver.advance(SECONDS_PER_TICK * 0.7);
    driver.resync();
    expect(driver.alpha()).toBe(0);
    expect(driver.tick()).toBe(0);
  });

  it('feeds each tick its own commands', () => {
    const driver = driverFor();
    const seen: number[] = [];
    driver.advance(SECONDS_PER_TICK * 3, (tick) => {
      seen.push(tick);
      return [{ kind: CommandKind.GrantResources, player: 0, minerals: 10, gas: 0 }];
    });
    expect(seen).toEqual([0, 1, 2]);
    expect(driver.match.minerals[0]).toBe(30);
  });

  it('produces an identical state whatever the frame rate', () => {
    // Frame rate must not be able to change the simulation at all: the same
    // tick number must mean the same state, however many frames it took.
    const targetTicks = 100;
    const run = (fps: number): number => {
      const driver = driverFor();
      const commands = (tick: number) =>
        tick % 7 === 0
          ? [{ kind: CommandKind.GrantResources as const, player: tick % 2, minerals: tick, gas: 1 }]
          : [];
      while (driver.tick() < targetTicks) driver.advance(1 / fps, commands);
      expect(driver.tick()).toBe(targetTicks);
      return hashMatch(driver.match);
    };
    expect(run(144)).toBe(run(30));
    expect(run(60)).toBe(run(30));
  });
});

describe('match initialisation from world state', () => {
  it('spawns a starting force for each player at its start location', () => {
    const world = createTestMap();
    const match = createMatchFromWorld({ world, seed: 5, playerCount: 2 });

    // Workers plus one drop-off structure each.
    expect(match.units.alive).toBe((STARTING_WORKERS + 1) * 2);
    expect(match.minerals[0]).toBe(STARTING_MINERALS);
    expect(match.minerals[1]).toBe(STARTING_MINERALS);

    const workerType = unitTypeById('worker');
    const byOwner = [0, 0];
    forEachUnit(match.units, (i) => {
      if (match.units.typeId[i] !== workerType.typeId) return;
      byOwner[match.units.ownerId[i] as number]!++;
    });
    expect(byOwner).toEqual([STARTING_WORKERS, STARTING_WORKERS]);
  });

  it('places workers near their start location and on the map', () => {
    const world = createTestMap();
    const match = createMatchFromWorld({ world, seed: 5, playerCount: 2 });
    forEachUnit(match.units, (i) => {
      const owner = match.units.ownerId[i] as number;
      const start = world.startLocations[owner]!;
      const centre = w.worldFromCell(world, start.cell);
      const dx = (match.units.posX[i] as number) - centre.x;
      const dz = (match.units.posZ[i] as number) - centre.z;
      // Within three cells of the start location.
      expect(Math.hypot(dx, dz)).toBeLessThan(3 * world.cellSize);
      expect(w.cellFromWorld(world, match.units.posX[i] as number, match.units.posZ[i] as number))
        .toBeGreaterThanOrEqual(0);
    });
  });

  it('leaves world state untouched, so Test/Stop is free', () => {
    // Invariant 4: match setup reads world state and never writes it.
    const world = createTestMap();
    const before = w.hashWorld(world);
    const heightCopy = world.heights.slice();
    const flagCopy = world.flags.slice();

    const driver = createDriver(createMatchFromWorld({ world, seed: 3, playerCount: 2 }));
    driver.advance(5);
    expect(w.hashWorld(world)).toBe(before);
    expect(world.heights).toEqual(heightCopy);
    expect(world.flags).toEqual(flagCopy);

    // And starting a second match over the same world behaves identically.
    const second = createMatchFromWorld({ world, seed: 3, playerCount: 2 });
    expect(hashMatch(second)).toBe(hashMatch(createMatchFromWorld({ world, seed: 3, playerCount: 2 })));
    expect(w.hashWorld(world)).toBe(before);
  });

  it('is reproducible from a seed', () => {
    const world = createTestMap();
    const a = createMatchFromWorld({ world, seed: 42, playerCount: 2 });
    const b = createMatchFromWorld({ world, seed: 42, playerCount: 2 });
    expect(hashMatch(a)).toBe(hashMatch(b));
  });

  it('copes with a map that has no start locations', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    const match = createMatchFromWorld({ world, seed: 1, playerCount: 2 });
    expect(match.units.alive).toBe(0);
    expect(match.minerals[0]).toBe(STARTING_MINERALS);
  });
});
