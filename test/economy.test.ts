import { describe, expect, it } from 'vitest';
import {
  HARVEST_SLOTS,
  HARVEST_TICKS,
  MINERAL_LOAD,
  carriedTotal,
  createNodeState,
  remainingInNodes,
} from '../src/sim/economy.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { CommandKind } from '../src/sim/commands.ts';
import { OrderKind, NULL_HANDLE, UnitState, spawnUnit } from '../src/sim/units.ts';
import type { UnitHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import * as w from '../src/sim/world.ts';
import { ONE, fromInt } from '../src/sim/fixed.ts';

/**
 * A small flat map: a base, four mineral patches near it, and nothing else to
 * get in the way of measuring income.
 */
function miningWorld(): w.World {
  const world = w.createWorld({ width: 48, height: 48 });
  world.startLocations.push({ cell: w.cellIndex(world, 24, 24) });
  world.startLocations.push({ cell: w.cellIndex(world, 44, 44) });
  for (let i = 0; i < 4; i++) {
    const cell = w.cellIndex(world, 28 + i, 20);
    world.resourceNodes.push({ cell, type: w.ResourceType.Minerals, amount: 1500 });
    world.flags[cell] = ((world.flags[cell] as number) & ~w.BUILDABLE) | w.VISION_BLOCKER;
  }
  return world;
}

function setup(world = miningWorld(), workers = 0) {
  const match = createMatchFromWorld({
    world,
    seed: 1,
    playerCount: 2,
    startingWorkers: workers,
    startingMinerals: 0,
    costGrid: createCostGrid(world),
  });
  return { world, match, context: { world } };
}

function spawnWorker(match: ReturnType<typeof createMatchFromWorld>, x: number, z: number): UnitHandle {
  return spawnUnit(match.units, {
    type: unitTypeById('worker'),
    ownerId: 0,
    x: fromInt(x) + ONE / 2,
    z: fromInt(z) + ONE / 2,
  });
}

const gather = (handles: UnitHandle[], cell: number) => ({
  kind: CommandKind.IssueOrders as const,
  player: 0,
  handles,
  order: { kind: OrderKind.Gather as const, cell, target: NULL_HANDLE },
  queue: false,
});

const run = (match: ReturnType<typeof createMatchFromWorld>, context: { world: w.World }, ticks: number): void => {
  for (let i = 0; i < ticks; i++) stepMatch(match, [], context);
};

describe('node state', () => {
  it('copies the map amounts rather than referencing them', () => {
    const world = miningWorld();
    const nodes = createNodeState(world);
    expect(remainingInNodes(nodes)).toBe(6000);
    nodes.amount[0] = 0;
    // Invariant 4: mining does not edit the map.
    expect(world.resourceNodes[0]?.amount).toBe(1500);
  });

  it('gives each player a drop-off at their start location', () => {
    const { match } = setup();
    let depots = 0;
    for (let i = 0; i < match.units.count; i++) {
      if (match.units.isAlive[i] !== 1) continue;
      if (unitTypeById('depot').typeId === match.units.typeId[i]) depots++;
    }
    expect(depots).toBe(2);
  });
});

describe('the gather loop', () => {
  it('walks to a patch, mines it, and delivers the load', () => {
    const { match, context, world } = setup();
    const worker = spawnWorker(match, 24, 26);
    const patch = world.resourceNodes[0]!.cell;

    stepMatch(match, [gather([worker], patch)], context);
    const index = match.units.count - 1;
    run(match, context, 200);

    expect(match.minerals[0]).toBeGreaterThan(0);
    expect(match.minerals[0]! % MINERAL_LOAD).toBe(0);
    expect(remainingInNodes(match.nodes)).toBeLessThan(6000);
    expect([UnitState.Gathering, UnitState.Returning]).toContain(match.units.state[index]);
  });

  it('takes resources out of the patch, not out of nowhere', () => {
    const { match, context, world } = setup();
    const worker = spawnWorker(match, 24, 26);
    stepMatch(match, [gather([worker], world.resourceNodes[0]!.cell)], context);
    run(match, context, 400);

    const mined = 6000 - remainingInNodes(match.nodes);
    expect(mined).toBeGreaterThan(0);
    expect(match.minerals[0]! + carriedTotal(match.units, 0)).toBe(mined);
  });

  it('keeps cycling rather than stopping after one trip', () => {
    const { match, context, world } = setup();
    const worker = spawnWorker(match, 24, 26);
    stepMatch(match, [gather([worker], world.resourceNodes[0]!.cell)], context);
    run(match, context, 200);
    const first = match.minerals[0] as number;
    run(match, context, 400);
    expect(match.minerals[0]).toBeGreaterThan(first);
  });

  it('moves on when its patch is mined out', () => {
    const { match, context, world } = setup();
    const worker = spawnWorker(match, 24, 26);
    match.nodes.amount[0] = MINERAL_LOAD; // one load left
    stepMatch(match, [gather([worker], world.resourceNodes[0]!.cell)], context);
    run(match, context, 600);
    expect(match.nodes.amount[0]).toBe(0);
    // It found another patch instead of going idle.
    expect(match.nodes.amount[1]).toBeLessThan(1500);
  });

  it('stops when every patch is empty', () => {
    const { match, context, world } = setup();
    const worker = spawnWorker(match, 24, 26);
    match.nodes.amount.fill(0);
    stepMatch(match, [gather([worker], world.resourceNodes[0]!.cell)], context);
    run(match, context, 60);
    const index = match.units.count - 1;
    expect(match.units.state[index]).toBe(UnitState.Idle);
  });

  it('holds its load when there is nowhere to deliver', () => {
    const { match, context, world } = setup();
    // Remove the drop-offs.
    for (let i = 0; i < match.units.count; i++) match.units.isAlive[i] = 0;
    match.units.alive = 0;
    const worker = spawnWorker(match, 28, 22);
    stepMatch(match, [gather([worker], world.resourceNodes[0]!.cell)], context);
    run(match, context, 200);
    expect(match.minerals[0]).toBe(0);
    expect(carriedTotal(match.units, 0)).toBeGreaterThan(0);
  });
});

describe('saturation', () => {
  it('lets only so many workers mine one patch at a time', () => {
    const { match, context, world } = setup();
    const workers: UnitHandle[] = [];
    for (let i = 0; i < 6; i++) workers.push(spawnWorker(match, 28 + (i % 3), 22));
    stepMatch(match, [gather(workers, world.resourceNodes[0]!.cell)], context);
    run(match, context, HARVEST_TICKS / 2);
    expect(match.nodes.harvesters[0]).toBeLessThanOrEqual(HARVEST_SLOTS);
  });

  it('stops paying for workers past the patches they can use', () => {
    // Four patches with two mining slots each are saturated by eight workers.
    // Doubling to sixteen does not come close to doubling income -- in fact it
    // currently earns less, because the traffic around the patches costs more
    // than the extra bodies bring. See HARVEST_SLOTS for the measurement and
    // why tuning that sits with M33.
    const income = (workerCount: number): number => {
      const world = miningWorld();
      const { match, context } = setup(world);
      const workers: UnitHandle[] = [];
      for (let i = 0; i < workerCount; i++) {
        workers.push(spawnWorker(match, 24 + (i % 4), 26 + ((i / 4) | 0)));
      }
      stepMatch(match, [gather(workers, world.resourceNodes[0]!.cell)], context);
      run(match, context, 1200);
      return (match.minerals[0] as number) + carriedTotal(match.units, 0);
    };

    const four = income(4);
    const eight = income(8);
    const sixteen = income(16);

    // Up to capacity, more workers earn more.
    expect(eight).toBeGreaterThan(four);
    // Past it, they do not: nothing like a linear return, and no free lunch.
    expect(sixteen).toBeLessThan(eight * 1.2);
  });

  it('sustains a stable rate with eight workers on four patches', () => {
    const world = miningWorld();
    const { match, context } = setup(world);
    const workers: UnitHandle[] = [];
    for (let i = 0; i < 8; i++) workers.push(spawnWorker(match, 24 + (i % 4), 26 + ((i / 4) | 0)));
    stepMatch(match, [gather(workers, world.resourceNodes[0]!.cell)], context);

    run(match, context, 600); // let the cycle settle
    const settled = (match.minerals[0] as number) + carriedTotal(match.units, 0);
    run(match, context, 600);
    const firstWindow = (match.minerals[0] as number) + carriedTotal(match.units, 0) - settled;
    run(match, context, 600);
    const secondWindow =
      (match.minerals[0] as number) + carriedTotal(match.units, 0) - settled - firstWindow;

    expect(firstWindow).toBeGreaterThan(0);
    // Steady state: two equal windows should produce comparable income.
    expect(secondWindow).toBeGreaterThan(firstWindow * 0.6);
    expect(secondWindow).toBeLessThan(firstWindow * 1.6);
  });
});

describe('economy determinism', () => {
  it('two runs of the same seed deliver identical totals', () => {
    const once = (): { minerals: number; hash: number } => {
      const world = miningWorld();
      const { match, context } = setup(world);
      const workers: UnitHandle[] = [];
      for (let i = 0; i < 8; i++) workers.push(spawnWorker(match, 24 + (i % 4), 26 + ((i / 4) | 0)));
      stepMatch(match, [gather(workers, world.resourceNodes[0]!.cell)], context);
      run(match, context, 1500);
      return { minerals: match.minerals[0] as number, hash: hashMatch(match) };
    };
    const a = once();
    const b = once();
    expect(a.minerals).toBe(b.minerals);
    expect(a.hash).toBe(b.hash);
    expect(a.minerals).toBeGreaterThan(0);
  });
});
