import { describe, expect, it } from 'vitest';
import {
  canPlace,
  footprintCells,
  footprintCentre,
  placeBuilding,
  productionBuildings,
  startProduction,
} from '../src/sim/building.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { CommandKind } from '../src/sim/commands.ts';
import {
  UnitState,
  isUnderConstruction,
  makeHandle,
  listProduction,
  productionCount,
  resolve,
} from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid, isPassable } from '../src/nav/grid.ts';
import { computeFlowField, isReachable } from '../src/nav/flowfield.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import * as w from '../src/sim/world.ts';
import { fromInt, toFloat } from '../src/sim/fixed.ts';
import { cornerStride } from '../src/sim/terrain.ts';

const barracks = unitTypeById('barracks');
const depot = unitTypeById('depot');
const worker = unitTypeById('worker');

function setup(world = w.createWorld({ width: 48, height: 48 }), minerals = 1000) {
  world.startLocations.push({ cell: w.cellIndex(world, 24, 24) });
  const match = createMatchFromWorld({
    world,
    seed: 1,
    playerCount: 2,
    startingWorkers: 0,
    startingDepots: 0,
    startingMinerals: minerals,
    costGrid: createCostGrid(world),
  });
  return { world, match, context: { world } };
}

const run = (match: ReturnType<typeof createMatchFromWorld>, context: { world: w.World }, ticks: number): void => {
  for (let i = 0; i < ticks; i++) stepMatch(match, [], context);
};

describe('placement', () => {
  it('covers a square footprint anchored at the given cell', () => {
    const { world } = setup();
    const cells = footprintCells(world, barracks, w.cellIndex(world, 10, 10));
    expect(cells).toHaveLength(9);
    expect(cells).toContain(w.cellIndex(world, 12, 12));
    expect(cells).not.toContain(w.cellIndex(world, 13, 10));

    const centre = footprintCentre(world, barracks, w.cellIndex(world, 10, 10));
    expect(toFloat(centre.x)).toBeCloseTo(11.5, 4);
    expect(toFloat(centre.z)).toBeCloseTo(11.5, 4);
  });

  it('refuses unbuildable ground, steep ground and the map edge', () => {
    const { world, match } = setup();
    w.setFlags(world, w.cellIndex(world, 11, 10), w.WALKABLE);
    expect(canPlace(match, world, 0, barracks, w.cellIndex(world, 10, 10)).reason).toMatch(
      /not buildable/,
    );

    // Tiers made this "all four cells on the same tier". A heightfield never
    // has two cells at exactly the same height, so what is refused is ground
    // steeper than a building can sit on.
    const stride = cornerStride(world);
    world.heights[20 * stride + 21] = fromInt(3);
    expect(canPlace(match, world, 0, barracks, w.cellIndex(world, 20, 20)).reason).toMatch(
      /too steep/,
    );

    expect(canPlace(match, world, 0, barracks, w.cellIndex(world, 47, 47)).reason).toMatch(
      /does not fit/,
    );
    expect(canPlace(match, world, 0, worker, w.cellIndex(world, 10, 10)).reason).toMatch(
      /not a building/,
    );
  });

  it('refuses to build on top of another building', () => {
    const { world, match, context } = setup();
    placeBuilding(match, world, 0, depot, w.cellIndex(world, 10, 10));
    run(match, context, depot.buildTicks + 2);
    expect(canPlace(match, world, 0, barracks, w.cellIndex(world, 9, 9)).reason).toMatch(
      /already there/,
    );
  });

  it('refuses what the player cannot afford, and charges for what they can', () => {
    const { world, match } = setup(undefined, 100);
    expect(canPlace(match, world, 0, barracks, w.cellIndex(world, 10, 10)).reason).toMatch(
      /not enough minerals/,
    );
    expect(placeBuilding(match, world, 0, depot, w.cellIndex(world, 10, 10))).toBeGreaterThan(0);
    expect(match.minerals[0]).toBe(100 - depot.mineralCost);
  });
});

describe('construction', () => {
  it('starts weak and finishes at full strength', () => {
    const { world, match, context } = setup();
    const handle = placeBuilding(match, world, 0, depot, w.cellIndex(world, 10, 10));
    const index = resolve(match.units, handle);

    expect(isUnderConstruction(match.units, index)).toBe(true);
    expect(match.units.hp[index]).toBeLessThan(depot.maxHp / 2);
    expect(match.units.state[index]).toBe(UnitState.Building);

    const half = match.units.hp[index] as number;
    run(match, context, Math.floor(depot.buildTicks / 2));
    expect(match.units.hp[index]).toBeGreaterThan(half);
    expect(isUnderConstruction(match.units, index)).toBe(true);

    run(match, context, depot.buildTicks);
    expect(isUnderConstruction(match.units, index)).toBe(false);
    expect(match.units.hp[index]).toBe(depot.maxHp);
    expect(match.units.state[index]).toBe(UnitState.Idle);
  });

  it('blocks pathing the tick it completes, and not before', () => {
    const { world, match, context } = setup();
    const cell = w.cellIndex(world, 10, 10);
    placeBuilding(match, world, 0, depot, cell);

    // Under construction, the ground is still walkable.
    expect(isPassable(match.costGrid!, cell)).toBe(true);
    run(match, context, depot.buildTicks - 1);
    expect(isPassable(match.costGrid!, cell)).toBe(true);

    run(match, context, 1);
    expect(isPassable(match.costGrid!, cell)).toBe(false);
    expect(isPassable(match.costGrid!, w.cellIndex(world, 11, 11))).toBe(false);
    expect(isPassable(match.costGrid!, w.cellIndex(world, 12, 10))).toBe(true);
  });

  it('makes a walled-off area genuinely unreachable', () => {
    // A corridor two cells wide, plugged by a 2x2 depot.
    const world = w.createWorld({ width: 16, height: 16 });
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (x === 8 && y !== 6 && y !== 7) w.setFlags(world, w.cellIndex(world, x, y), 0);
      }
    }
    const { match, context } = setup(world);
    const behind = w.cellIndex(world, 12, 8);
    const before = computeFlowField(match.costGrid!, behind);
    expect(isReachable(before, w.cellIndex(world, 2, 8))).toBe(true);

    placeBuilding(match, world, 0, depot, w.cellIndex(world, 8, 6));
    run(match, context, depot.buildTicks + 2);

    const after = computeFlowField(match.costGrid!, behind);
    expect(isReachable(after, w.cellIndex(world, 2, 8))).toBe(false);
  });

  it('throws away cached flow fields when a building completes', () => {
    const { world, match, context } = setup();
    match.fields.fields.set(1, {
      width: world.width,
      height: world.height,
      goalCell: 1,
      integration: new Uint16Array(1),
      flow: new Int8Array(1),
      gridVersion: match.costGrid!.version,
    });
    placeBuilding(match, world, 0, depot, w.cellIndex(world, 10, 10));
    run(match, context, depot.buildTicks + 2);
    expect(match.fields.fields.size).toBe(0);
  });
});

describe('production', () => {
  function withBarracks() {
    const { world, match, context } = setup();
    const handle = placeBuilding(match, world, 0, barracks, w.cellIndex(world, 10, 10));
    const index = resolve(match.units, handle);
    for (let i = 0; i < barracks.buildTicks + 2; i++) stepMatch(match, [], context);
    return { world, match, context, index, handle };
  }

  it('queues, charges, and produces a unit', () => {
    const { match, context, index } = withBarracks();
    const soldier = unitTypeById('soldier');
    const before = match.minerals[0] as number;

    expect(startProduction(match, 0, index, soldier.typeId)).toBe(true);
    expect(productionCount(match.units, index)).toBe(1);
    // Charged when queued, like SC2.
    expect(match.minerals[0]).toBe(before - soldier.mineralCost);

    const unitsBefore = match.units.alive;
    run(match, context, soldier.buildTicks + 2);
    expect(match.units.alive).toBe(unitsBefore + 1);
    expect(productionCount(match.units, index)).toBe(0);
  });

  it('refuses what the building cannot make, and what is unaffordable', () => {
    const { match, index } = withBarracks();
    // A barracks does not make workers.
    expect(startProduction(match, 0, index, worker.typeId)).toBe(false);
    // Nor anyone else's units.
    expect(startProduction(match, 1, index, unitTypeById('soldier').typeId)).toBe(false);
    match.minerals[0] = 0;
    expect(startProduction(match, 0, index, unitTypeById('soldier').typeId)).toBe(false);
  });

  it('will not produce from a building that is still going up', () => {
    const { world, match } = setup();
    const handle = placeBuilding(match, world, 0, barracks, w.cellIndex(world, 10, 10));
    const index = resolve(match.units, handle);
    expect(startProduction(match, 0, index, unitTypeById('soldier').typeId)).toBe(false);
  });

  it('produces a queue in order and bounds its length', () => {
    const { match, context, index } = withBarracks();
    const soldier = unitTypeById('soldier');
    const raider = unitTypeById('raider');
    match.minerals[0] = 5000;
    match.gas[0] = 5000;

    startProduction(match, 0, index, soldier.typeId);
    startProduction(match, 0, index, raider.typeId);
    expect(listProduction(match.units, index)).toEqual([soldier.typeId, raider.typeId]);

    for (let i = 0; i < 20; i++) startProduction(match, 0, index, soldier.typeId);
    expect(productionCount(match.units, index)).toBeLessThanOrEqual(5);

    run(match, context, soldier.buildTicks + 2);
    expect(listProduction(match.units, index)[0]).toBe(raider.typeId);
  });

  it('sends what it makes to the rally point', () => {
    const { world, match, context, index, handle } = withBarracks();
    const rally = w.cellIndex(world, 30, 30);
    stepMatch(
      match,
      [{ kind: CommandKind.SetRally, player: 0, handles: [handle], cell: rally }],
      context,
    );
    expect(match.units.rallyCell[index]).toBe(rally);

    const soldier = unitTypeById('soldier');
    startProduction(match, 0, index, soldier.typeId);
    run(match, context, soldier.buildTicks + 2);

    const produced = match.units.count - 1;
    expect(match.units.goalCell[produced]).toBe(rally);
    run(match, context, 600);
    const cell = w.cellFromWorld(
      world,
      match.units.posX[produced] as number,
      match.units.posZ[produced] as number,
    );
    expect(Math.hypot(w.cellX(world, cell) - 30, w.cellY(world, cell) - 30)).toBeLessThan(4);
  });

  it('handles a rally point it cannot reach without hanging', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    // An island the produced unit has no route to.
    for (let y = 0; y < 32; y++) w.setFlags(world, w.cellIndex(world, 20, y), 0);
    const { match, context } = setup(world);
    const handle = placeBuilding(match, world, 0, barracks, w.cellIndex(world, 5, 5));
    const index = resolve(match.units, handle);
    run(match, context, barracks.buildTicks + 2);

    match.units.rallyCell[index] = w.cellIndex(world, 28, 28);
    const soldier = unitTypeById('soldier');
    startProduction(match, 0, index, soldier.typeId);
    run(match, context, soldier.buildTicks + 2);

    const produced = match.units.count - 1;
    expect(() => run(match, context, 200)).not.toThrow();
    // It gives up rather than spinning: the order ends and the unit stands.
    expect(match.units.state[produced]).toBe(UnitState.Idle);
  });

  it('puts produced units beside the building, not inside it', () => {
    const { world, match, context, index } = withBarracks();
    const soldier = unitTypeById('soldier');
    startProduction(match, 0, index, soldier.typeId);
    run(match, context, soldier.buildTicks + 2);

    const produced = match.units.count - 1;
    const cell = w.cellFromWorld(
      world,
      match.units.posX[produced] as number,
      match.units.posZ[produced] as number,
    );
    // It appears on ground it can stand on, not inside the footprint.
    expect(isPassable(match.costGrid!, cell)).toBe(true);
    expect(footprintCells(world, barracks, w.cellIndex(world, 10, 10))).not.toContain(cell);
  });

  it('lists the buildings a player can produce from', () => {
    const { match, index } = withBarracks();
    expect(productionBuildings(match.units, 0)).toContain(index);
    expect(productionBuildings(match.units, 1)).toEqual([]);
  });
});

describe('building determinism', () => {
  it('the same commands produce the same state', () => {
    const once = (): number => {
      const world = w.createWorld({ width: 48, height: 48 });
      const { match, context } = setup(world, 2000);
      const barracksCell = w.cellIndex(world, 10, 10);
      stepMatch(
        match,
        [
          { kind: CommandKind.PlaceBuilding, player: 0, typeId: barracks.typeId, cell: barracksCell },
          { kind: CommandKind.PlaceBuilding, player: 0, typeId: depot.typeId, cell: w.cellIndex(world, 20, 20) },
        ],
        context,
      );
      run(match, context, barracks.buildTicks + 5);

      const building = makeHandle(0, match.units.generation[0] as number);
      stepMatch(
        match,
        [
          { kind: CommandKind.SetRally, player: 0, handles: [building], cell: w.cellIndex(world, 30, 30) },
          { kind: CommandKind.QueueProduction, player: 0, building, typeId: unitTypeById('soldier').typeId },
        ],
        context,
      );
      run(match, context, 500);
      return hashMatch(match);
    };
    expect(once()).toBe(once());
  });

  it('a placement the rules refuse changes nothing', () => {
    // Compared against a match that was simply stepped, since a tick always
    // advances the tick counter and so always changes the hash.
    const build = () => {
      const world = w.createWorld({ width: 48, height: 48 });
      return setup(world, 10);
    };
    const refused = build();
    const untouched = build();

    stepMatch(
      refused.match,
      [
        // Too expensive, off the map, wrong player, and a type that does not
        // exist: each must be ignored identically on every client.
        { kind: CommandKind.PlaceBuilding, player: 0, typeId: barracks.typeId, cell: w.cellIndex(refused.world, 10, 10) },
        { kind: CommandKind.PlaceBuilding, player: 0, typeId: barracks.typeId, cell: -5 },
        { kind: CommandKind.PlaceBuilding, player: 9, typeId: barracks.typeId, cell: w.cellIndex(refused.world, 10, 10) },
        { kind: CommandKind.PlaceBuilding, player: 0, typeId: 999, cell: w.cellIndex(refused.world, 10, 10) },
      ],
      refused.context,
    );
    stepMatch(untouched.match, [], untouched.context);
    expect(hashMatch(refused.match)).toBe(hashMatch(untouched.match));
  });
});
