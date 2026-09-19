import { describe, expect, it } from 'vitest';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { CommandKind } from '../src/sim/commands.ts';
import type { SimCommand } from '../src/sim/commands.ts';
import { UnitState, forEachUnit, makeHandle, spawnUnit } from '../src/sim/units.ts';
import type { UnitHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { cellCentreHeight } from '../src/sim/terrain.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import { arrivalRadius } from '../src/sim/movement.ts';
import { createSpatialHash, rebuildSpatialHash, bucketContents, forEachNeighbour } from '../src/sim/spatialhash.ts';
import { createMatch } from '../src/sim/match.ts';
import * as w from '../src/sim/world.ts';
import { ONE, fromInt, toFloat } from '../src/sim/fixed.ts';

function setup(world = createTestMap()) {
  const costGrid = createCostGrid(world);
  const match = createMatchFromWorld({
    world,
    seed: 1,
    playerCount: 2,
    startingWorkers: 0,
    startingDepots: 0,
    costGrid,
  });
  return { world, costGrid, match, context: { world } };
}

function spawnAt(match: ReturnType<typeof createMatch>, type: string, owner: number, x: number, z: number): UnitHandle {
  return spawnUnit(match.units, {
    type: unitTypeById(type),
    ownerId: owner,
    x: fromInt(x) + ONE / 2,
    z: fromInt(z) + ONE / 2,
  });
}

const move = (player: number, handles: UnitHandle[], goalCell: number): SimCommand => ({
  kind: CommandKind.MoveUnits,
  player,
  handles,
  goalCell,
});

function run(match: ReturnType<typeof createMatch>, context: { world: w.World }, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepMatch(match, [], context);
}

describe('spatial hash', () => {
  it('buckets units and finds their neighbours', () => {
    const match = createMatch({ seed: 1, playerCount: 2 });
    for (let i = 0; i < 10; i++) spawnAt(match, 'soldier', 0, 10 + i, 10);
    const hash = rebuildSpatialHash(createSpatialHash(64, 64), match.units);

    const seen: number[] = [];
    forEachNeighbour(hash, fromInt(10), fromInt(10), (index) => seen.push(index));
    // The three buckets around x=10 cover roughly six cells of units.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(10);
    expect(seen).toContain(0);
  });

  it('places every live unit in exactly one bucket', () => {
    const match = createMatch({ seed: 1, playerCount: 2 });
    for (let i = 0; i < 50; i++) spawnAt(match, 'soldier', 0, i % 40, (i / 40) | 0);
    const hash = rebuildSpatialHash(createSpatialHash(64, 64), match.units);

    const placed = new Set<number>();
    for (let b = 0; b < hash.starts.length - 1; b++) {
      for (const index of bucketContents(hash, b)) {
        expect(placed.has(index)).toBe(false);
        placed.add(index);
      }
    }
    expect(placed.size).toBe(50);
  });

});

describe('movement', () => {
  it('walks a unit to its goal and stops there', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 'soldier', 0, 30, 30);
    const goal = w.cellIndex(world, 40, 30);

    stepMatch(match, [move(0, [handle], goal)], context);
    expect(match.units.state[0]).toBe(UnitState.Moving);

    run(match, context, 400);
    expect(match.units.state[0]).toBe(UnitState.Idle);
    expect(match.units.goalCell[0]).toBe(-1);
    expect(match.units.velX[0]).toBe(0);

    const cell = w.cellFromWorld(world, match.units.posX[0] as number, match.units.posZ[0] as number);
    const dx = Math.abs(w.cellX(world, cell) - 40);
    const dz = Math.abs(w.cellY(world, cell) - 30);
    expect(dx + dz).toBeLessThanOrEqual(2);
  });

  it('does not jitter once it has arrived', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 'soldier', 0, 30, 30);
    stepMatch(match, [move(0, [handle], w.cellIndex(world, 34, 30))], context);
    run(match, context, 200);

    const x = match.units.posX[0] as number;
    const z = match.units.posZ[0] as number;
    run(match, context, 100);
    expect(match.units.posX[0]).toBe(x);
    expect(match.units.posZ[0]).toBe(z);
  });

  it('ignores an order for a unit the player does not own', () => {
    const { match, context, world } = setup();
    const mine = spawnAt(match, 'soldier', 0, 30, 30);
    const theirs = spawnAt(match, 'soldier', 1, 32, 30);
    stepMatch(match, [move(0, [mine, theirs], w.cellIndex(world, 40, 30))], context);
    expect(match.units.state[0]).toBe(UnitState.Moving);
    expect(match.units.state[1]).toBe(UnitState.Idle);
  });

  it('ignores stale handles', () => {
    const { match, context, world } = setup();
    spawnAt(match, 'soldier', 0, 30, 30);
    expect(() =>
      stepMatch(match, [move(0, [makeHandle(500, 3)], w.cellIndex(world, 40, 30))], context),
    ).not.toThrow();
  });

  it('stops on command', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 'soldier', 0, 30, 30);
    stepMatch(match, [move(0, [handle], w.cellIndex(world, 12, 12))], context);
    run(match, context, 20);
    expect(match.units.state[0]).toBe(UnitState.Moving);

    stepMatch(match, [{ kind: CommandKind.StopUnits, player: 0, handles: [handle] }], context);
    expect(match.units.state[0]).toBe(UnitState.Idle);
    const x = match.units.posX[0] as number;
    run(match, context, 20);
    expect(match.units.posX[0]).toBe(x);
  });

  it('never walks off a cliff', () => {
    // Order a unit from the basin to a plateau cell; it must take the ramp, so
    // every position it occupies is reachable from the one before it.
    const { match, context, world } = setup();
    const handle = spawnAt(match, 'soldier', 0, 30, 30);
    const goal = world.startLocations[0]!.cell;
    stepMatch(match, [move(0, [handle], goal)], context);

    let previous = w.cellFromWorld(world, match.units.posX[0] as number, match.units.posZ[0] as number);
    for (let i = 0; i < 600; i++) {
      stepMatch(match, [], context);
      const cell = w.cellFromWorld(world, match.units.posX[0] as number, match.units.posZ[0] as number);
      expect(cell).toBeGreaterThanOrEqual(0);
      // Every cell it enters is one the terrain rules allow it to reach from
      // the one it was in. With tiers this was "the tier changed by at most
      // one, and only on a ramp"; the heightfield answers the same question
      // directly, and answers it for the diagonals too.
      if (cell !== previous) {
        expect(w.cellsConnect(world, previous, cell)).toBe(true);
      }
      previous = cell;
    }
    // It got up onto the plateau.
    expect(toFloat(cellCentreHeight(world, previous))).toBeCloseTo(6, 1);
  });

  it('stands still when the goal is unreachable', () => {
    const world = createTestMap();
    // Wall the unit into a pocket.
    for (let y = 28; y <= 34; y++) {
      w.setFlags(world, w.cellIndex(world, 34, y), 0);
      w.setFlags(world, w.cellIndex(world, 28, y), 0);
    }
    for (let x = 28; x <= 34; x++) {
      w.setFlags(world, w.cellIndex(world, x, 28), 0);
      w.setFlags(world, w.cellIndex(world, x, 34), 0);
    }
    const { match, context } = setup(world);
    const handle = spawnAt(match, 'soldier', 0, 31, 31);
    stepMatch(match, [move(0, [handle], w.cellIndex(world, 50, 50))], context);
    run(match, context, 100);
    expect(match.units.state[0]).toBe(UnitState.Idle);
    const cell = w.cellFromWorld(world, match.units.posX[0] as number, match.units.posZ[0] as number);
    expect(w.cellX(world, cell)).toBeGreaterThan(28);
    expect(w.cellX(world, cell)).toBeLessThan(34);
  });
});

describe('crowds', () => {
  it('spreads 50 units instead of stacking them on one cell', () => {
    const { match, context, world } = setup();
    const handles: UnitHandle[] = [];
    for (let i = 0; i < 50; i++) {
      handles.push(spawnAt(match, 'soldier', 0, 28 + (i % 10), 28 + ((i / 10) | 0)));
    }
    const goal = w.cellIndex(world, 40, 40);
    stepMatch(match, [move(0, handles, goal)], context);
    run(match, context, 400);

    const cells = new Set<number>();
    forEachUnit(match.units, (i) => {
      cells.add(w.cellFromWorld(world, match.units.posX[i] as number, match.units.posZ[i] as number));
    });
    // A blob, not a pile: many distinct cells, all near the goal.
    expect(cells.size).toBeGreaterThan(10);
    for (const cell of cells) {
      const distance = Math.hypot(w.cellX(world, cell) - 40, w.cellY(world, cell) - 40);
      expect(distance).toBeLessThan(10);
    }
  });

  it('widens the arrival radius with the square root of the crowd', () => {
    const r = unitTypeById('soldier').radius;
    expect(arrivalRadius(50, r)).toBeGreaterThan(arrivalRadius(6, r));
    expect(arrivalRadius(6, r)).toBeGreaterThan(arrivalRadius(1, r));
    expect(toFloat(arrivalRadius(1, r))).toBeLessThan(1);
    // Four times the units is about twice the radius, not four times.
    const grow = (n: number) => toFloat(arrivalRadius(n, r)) - toFloat(arrivalRadius(1, r));
    expect(grow(64) / grow(16)).toBeCloseTo(2, 1);
    // And it is capped, or one big move order would claim half the map.
    expect(arrivalRadius(10_000, r)).toBe(arrivalRadius(100_000, r));
  });

  it('gives a crowd of six room to stand without overlapping', () => {
    const { match, context, world } = setup();
    const handles: UnitHandle[] = [];
    for (let i = 0; i < 6; i++) handles.push(spawnAt(match, 'soldier', 0, 28 + i, 28));
    stepMatch(match, [move(0, handles, w.cellIndex(world, 40, 40))], context);
    run(match, context, 400);

    const positions: [number, number][] = [];
    forEachUnit(match.units, (i) => {
      positions.push([toFloat(match.units.posX[i] as number), toFloat(match.units.posZ[i] as number)]);
    });
    const radius = toFloat(unitTypeById('soldier').radius);
    for (let a = 0; a < positions.length; a++) {
      for (let b = a + 1; b < positions.length; b++) {
        const distance = Math.hypot(
          (positions[a] as [number, number])[0] - (positions[b] as [number, number])[0],
          (positions[a] as [number, number])[1] - (positions[b] as [number, number])[1],
        );
        // Allow a little overlap -- they stop where they are -- but not units
        // standing inside one another.
        expect(distance).toBeGreaterThan(radius);
      }
    }
  });

  it('gets 200 units through two chokepoints without deadlocking', () => {
    // A wall with two gaps: the classic case where naive steering jams.
    const world = w.createWorld({ width: 64, height: 64 });
    for (let y = 0; y < 64; y++) {
      const isGap = (y >= 20 && y <= 22) || (y >= 42 && y <= 44);
      if (!isGap) w.setFlags(world, w.cellIndex(world, 32, y), 0);
    }
    const { match, context } = setup(world);

    const handles: UnitHandle[] = [];
    for (let i = 0; i < 200; i++) {
      handles.push(spawnAt(match, 'soldier', 0, 4 + (i % 20), 20 + ((i / 20) | 0)));
    }
    const goal = w.cellIndex(world, 56, 32);
    stepMatch(match, [move(0, handles, goal)], context);
    run(match, context, 2000);

    let through = 0;
    let stillMoving = 0;
    forEachUnit(match.units, (i) => {
      const x = w.cellX(world, w.cellFromWorld(world, match.units.posX[i] as number, match.units.posZ[i] as number));
      if (x > 32) through++;
      if (match.units.state[i] === UnitState.Moving) stillMoving++;
    });

    // Not everyone has to have arrived, but the great majority must be
    // through, and nobody may be permanently wedged with nowhere to go.
    expect(through).toBeGreaterThan(180);
    expect(stillMoving).toBeLessThan(20);
  });
});

describe('movement determinism', () => {
  it('two runs of the same orders hash identically', () => {
    const runOnce = (): number => {
      const { match, context, world } = setup();
      const handles: UnitHandle[] = [];
      for (let i = 0; i < 30; i++) handles.push(spawnAt(match, 'soldier', 0, 28 + (i % 6), 28 + ((i / 6) | 0)));
      stepMatch(match, [move(0, handles, w.cellIndex(world, 45, 45))], context);
      run(match, context, 200);
      return hashMatch(match);
    };
    expect(runOnce()).toBe(runOnce());
  });

  it('computes a field synchronously when the cache misses', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 'soldier', 0, 30, 30);
    expect(match.fields.synchronousSolves).toBe(0);
    stepMatch(match, [move(0, [handle], w.cellIndex(world, 40, 30))], context);
    stepMatch(match, [], context);
    expect(match.fields.synchronousSolves).toBe(1);
    // And reuses it rather than solving again every tick.
    run(match, context, 20);
    expect(match.fields.synchronousSolves).toBe(1);
  });
});
