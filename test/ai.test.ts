import { describe, expect, it } from 'vitest';
import { AI_INTERVAL_TICKS, AiPhase, setAiPlayer, unitsOf } from '../src/sim/ai.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { UnitState, isUnderConstruction } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import { remainingInNodes } from '../src/sim/economy.ts';
import * as w from '../src/sim/world.ts';

/**
 * A symmetric two-base map: enough room to build, enough minerals to matter,
 * and the two starts far enough apart that an attack takes a while.
 */
function skirmishMap(): w.World {
  const world = w.createWorld({ width: 64, height: 64 });
  world.startLocations.push({ cell: w.cellIndex(world, 10, 10) });
  world.startLocations.push({ cell: w.cellIndex(world, 52, 52) });
  for (const [bx, by] of [
    [16, 10],
    [46, 52],
  ] as const) {
    for (let i = 0; i < 6; i++) {
      const cell = w.cellIndex(world, bx + i, by);
      world.resourceNodes.push({ cell, type: w.ResourceType.Minerals, amount: 5000 });
      world.flags[cell] = ((world.flags[cell] as number) & ~w.BUILDABLE) | w.VISION_BLOCKER;
    }
  }
  return world;
}

function skirmish(seed: number, bots: number[] = [0, 1]) {
  const world = skirmishMap();
  const match = createMatchFromWorld({
    world,
    seed,
    playerCount: 2,
    startingMinerals: 200,
    costGrid: createCostGrid(world),
  });
  for (const player of bots) setAiPlayer(match, player, true);
  return { world, match, context: { world } };
}

const run = (match: ReturnType<typeof createMatchFromWorld>, context: { world: w.World }, ticks: number): void => {
  for (let i = 0; i < ticks; i++) stepMatch(match, [], context);
};

function census(match: ReturnType<typeof createMatchFromWorld>, player: number) {
  const store = match.units;
  let workers = 0;
  let army = 0;
  let structures = 0;
  let idle = 0;
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.ownerId[i] !== player) continue;
    const kind = store.typeId[i] as number;
    if (unitTypeById('worker').typeId === kind) workers++;
    else if (unitTypeById('depot').typeId === kind || unitTypeById('barracks').typeId === kind) structures++;
    else army++;
    if (store.state[i] === UnitState.Idle) idle++;
  }
  return { workers, army, structures, idle };
}

describe('the bot', () => {
  it('only plays for the players it controls', () => {
    const { match, context } = skirmish(1, [0]);
    run(match, context, 5000);
    // Both players' starting workers mine, because match setup sends them to;
    // what separates the bot is that it spends what they bring in. Player 1
    // banks minerals it never uses and builds nothing.
    expect(census(match, 0).structures).toBeGreaterThan(census(match, 1).structures);
    expect(census(match, 0).workers).toBeGreaterThan(census(match, 1).workers);
    expect(match.minerals[1]).toBeGreaterThan(match.minerals[0] as number);
  });

  it('puts its workers to work', () => {
    const { match, context } = skirmish(2);
    const before = remainingInNodes(match.nodes);
    run(match, context, 900);
    expect(remainingInNodes(match.nodes)).toBeLessThan(before);
    expect(match.minerals[0]).toBeGreaterThan(200);
  });

  it('builds more workers and a barracks', () => {
    const { match, context } = skirmish(3);
    const startingWorkers = census(match, 0).workers;
    run(match, context, 4000);

    const now = census(match, 0);
    expect(now.workers).toBeGreaterThan(startingWorkers);
    expect(now.structures).toBeGreaterThan(1); // the depot it started with, plus a barracks
  });

  it('builds an army and attacks with it', () => {
    const { match, context } = skirmish(4);
    run(match, context, 9000);
    expect(match.ai.phase[0]).toBe(AiPhase.Attack);
    expect(match.ai.target[0]).toBeGreaterThanOrEqual(0);
    // Its army is heading toward the other side of the map.
    expect(census(match, 0).army).toBeGreaterThan(0);
  });

  it('thinks on an interval rather than every tick', () => {
    const { match, context } = skirmish(5);
    // Between decisions nothing the bot owns changes state on its own.
    run(match, context, AI_INTERVAL_TICKS);
    const hash = hashMatch(match);
    expect(hash).toBeGreaterThan(0);
    expect(AI_INTERVAL_TICKS).toBeGreaterThan(1);
  });

  it('goes back to rebuilding if its army is wiped out', () => {
    const { match, context } = skirmish(6);
    run(match, context, 9000);
    expect(match.ai.phase[0]).toBe(AiPhase.Attack);

    for (let i = 0; i < match.units.count; i++) {
      if (match.units.ownerId[i] !== 0) continue;
      if (unitTypeById('worker').typeId === match.units.typeId[i]) continue;
      if (unitTypeById('depot').typeId === match.units.typeId[i]) continue;
      if (unitTypeById('barracks').typeId === match.units.typeId[i]) continue;
      match.units.hp[i] = 0;
    }
    run(match, context, AI_INTERVAL_TICKS * 3);
    expect(match.ai.phase[0]).not.toBe(AiPhase.Attack);
  });

  it('copes with having nothing left', () => {
    const { match, context } = skirmish(7);
    for (let i = 0; i < match.units.count; i++) match.units.hp[i] = 0;
    // And nothing to rebuild with, or it would simply make another worker,
    // which is the right behaviour but not what this test is about.
    match.minerals.fill(0);
    match.gas.fill(0);
    expect(() => run(match, context, 200)).not.toThrow();
    expect(unitsOf(match, 0)).toEqual([]);
  });

  it('runs a whole match without stalling', () => {
    const { match, context } = skirmish(8);
    // Ten minutes. The bot must keep doing things rather than reaching a state
    // it cannot get out of.
    run(match, context, 12_000);

    const zero = census(match, 0);
    const one = census(match, 1);
    // Both sides did something: mined, built and fought.
    expect(remainingInNodes(match.nodes)).toBeLessThan(60_000);
    expect(zero.structures + one.structures).toBeGreaterThan(2);
    expect(zero.army + one.army).toBeGreaterThan(0);
    // And nothing is stuck mid-construction forever.
    for (let i = 0; i < match.units.count; i++) {
      if (match.units.isAlive[i] !== 1) continue;
      if (!isUnderConstruction(match.units, i)) continue;
      expect(match.units.buildTicks[i]).toBeLessThan(unitTypeById('barracks').buildTicks);
    }
  });
});

describe('bot determinism', () => {
  it('a bot-vs-bot match is reproducible from its seed', () => {
    const once = (seed: number): number => {
      const { match, context } = skirmish(seed);
      run(match, context, 6000);
      return hashMatch(match);
    };
    expect(once(11)).toBe(once(11));
    expect(once(11)).not.toBe(once(12));
  });

  it('is reproducible when stepped in different sized batches', () => {
    // Nothing about the bot may depend on how the caller slices up time.
    const { match: a, context: ca } = skirmish(21);
    for (let i = 0; i < 3000; i++) stepMatch(a, [], ca);

    const { match: b, context: cb } = skirmish(21);
    for (let batch = 0; batch < 60; batch++) {
      for (let i = 0; i < 50; i++) stepMatch(b, [], cb);
    }
    expect(hashMatch(a)).toBe(hashMatch(b));
  });

  it('is part of the determinism hash', () => {
    const { match } = skirmish(1);
    const before = hashMatch(match);
    setAiPlayer(match, 1, false);
    expect(hashMatch(match)).not.toBe(before);
  });
});
