import { describe, expect, it } from 'vitest';
import { ACQUIRE_INTERVAL_TICKS, acquireTarget, applyDamage } from '../src/sim/combat.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { updateFog } from '../src/sim/fog.ts';
import { NULL_HANDLE, forEachUnit, resolve, spawnUnit } from '../src/sim/units.ts';
import type { UnitHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import * as w from '../src/sim/world.ts';
import { ONE, fromInt } from '../src/sim/fixed.ts';

function setup(world = createTestMap()) {
  const match = createMatchFromWorld({
    world,
    seed: 1,
    playerCount: 2,
    startingWorkers: 0,
    startingDepots: 0,
    costGrid: createCostGrid(world),
  });
  return { world, match, context: { world } };
}

function spawnAt(
  match: ReturnType<typeof createMatchFromWorld>,
  owner: number,
  x: number,
  z: number,
  type = 'soldier',
): UnitHandle {
  return spawnUnit(match.units, {
    type: unitTypeById(type),
    ownerId: owner,
    x: fromInt(x) + ONE / 2,
    z: fromInt(z) + ONE / 2,
  });
}

const run = (match: ReturnType<typeof createMatchFromWorld>, context: { world: w.World }, ticks: number): void => {
  for (let i = 0; i < ticks; i++) stepMatch(match, [], context);
};

describe('target acquisition', () => {
  it('finds the nearest visible enemy in range', () => {
    const { match, world, context } = setup();
    const shooter = spawnAt(match, 0, 30, 30);
    spawnAt(match, 1, 36, 30); // further
    const near = spawnAt(match, 1, 32, 30);
    expect(shooter).toBeGreaterThan(0);

    stepMatch(match, [], context);
    const acquired = acquireTarget(match, world, 0, unitTypeById('soldier').sightRadius);
    expect(acquired).toBe(near);
  });

  it('will not target what the owner cannot see', () => {
    // Range does not grant knowledge. A siege tank outranges its own sight,
    // which is exactly why spotters exist.
    const world = w.createWorld({ width: 64, height: 64 });
    const { match, context } = setup(world);
    const tank = spawnAt(match, 0, 30, 30, 'siege');
    spawnAt(match, 1, 40, 30); // inside weapon range, outside sight
    expect(tank).toBeGreaterThan(0);

    stepMatch(match, [], context);
    expect(acquireTarget(match, world, 0, unitTypeById('siege').attackRange)).toBe(NULL_HANDLE);
    run(match, context, 60);
    expect(match.units.hp[1]).toBe(unitTypeById('soldier').maxHp);
  });

  it('will not target friendly units', () => {
    const { match, world, context } = setup();
    spawnAt(match, 0, 30, 30);
    spawnAt(match, 0, 32, 30);
    stepMatch(match, [], context);
    expect(acquireTarget(match, world, 0, unitTypeById('soldier').sightRadius)).toBe(NULL_HANDLE);
  });

  it('breaks ties toward the lower slot, so clients agree', () => {
    const { match, world, context } = setup();
    spawnAt(match, 0, 30, 30);
    const first = spawnAt(match, 1, 34, 30);
    spawnAt(match, 1, 26, 30); // exactly as far away
    stepMatch(match, [], context);
    expect(acquireTarget(match, world, 0, unitTypeById('soldier').sightRadius)).toBe(first);
  });

  it('drops a target that dies or leaves vision', () => {
    const { match, context } = setup();
    spawnAt(match, 0, 30, 30);
    const victim = spawnAt(match, 1, 32, 30);
    run(match, context, ACQUIRE_INTERVAL_TICKS + 1);
    expect(match.units.targetHandle[0]).toBe(victim);

    // Teleport the victim out of sight.
    match.units.posX[1] = fromInt(62) + ONE / 2;
    match.units.posZ[1] = fromInt(62) + ONE / 2;
    run(match, context, 10);
    expect(match.units.targetHandle[0]).toBe(NULL_HANDLE);
  });
});

describe('firing', () => {
  it('damages a target in range and respects the cooldown', () => {
    const { match, context } = setup();
    spawnAt(match, 0, 30, 30);
    spawnAt(match, 1, 32, 30);
    const type = unitTypeById('soldier');
    const startHp = match.units.hp[1] as number;

    run(match, context, ACQUIRE_INTERVAL_TICKS + 1);
    expect(match.units.hp[1]).toBeLessThan(startHp);

    // One shot per cooldown, not one per tick.
    const afterFirst = match.units.hp[1] as number;
    run(match, context, type.cooldown - 2);
    expect(match.units.hp[1]).toBe(afterFirst);
    run(match, context, 3);
    expect(match.units.hp[1]).toBeLessThan(afterFirst);
  });

  it('does not fire out of range', () => {
    const { match, context } = setup();
    spawnAt(match, 0, 30, 30);
    spawnAt(match, 1, 37, 30); // inside sight, outside a soldier's 5-cell reach
    const startHp = match.units.hp[1] as number;
    run(match, context, 40);
    expect(match.units.hp[1]).toBe(startHp);
    expect(match.units.targetHandle[0]).not.toBe(NULL_HANDLE); // it sees it
  });

  it('kills a unit and frees its slot', () => {
    const { match, context } = setup();
    spawnAt(match, 0, 30, 30);
    // A depot cannot shoot back, so this measures one unit killing another
    // rather than two soldiers trading until both fall over.
    const victim = spawnAt(match, 1, 32, 30, 'depot');
    run(match, context, 900);
    expect(resolve(match.units, victim)).toBe(-1);
    expect(match.units.alive).toBe(1);
  });

  it('lets two units kill each other on the same tick', () => {
    // Symmetry matters: resolving deaths in examination order would make the
    // lower slot win every mutual kill.
    const { match, context } = setup();
    spawnAt(match, 0, 30, 30);
    spawnAt(match, 1, 31, 30);
    match.units.hp[0] = 1;
    match.units.hp[1] = 1;
    applyDamage(match, 0, 5);
    applyDamage(match, 1, 5);
    stepMatch(match, [], context);
    expect(match.units.alive).toBe(0);
  });

  it('units that cannot attack never do', () => {
    const { match, context } = setup();
    spawnAt(match, 0, 30, 30, 'depot');
    spawnAt(match, 1, 31, 30);
    const startHp = match.units.hp[1] as number;
    run(match, context, 60);
    expect(match.units.hp[1]).toBe(startHp);
    expect(unitTypeById('depot').canAttack).toBe(false);
  });
});

describe('projectiles', () => {
  it('a travelling shot takes time to arrive', () => {
    const world = w.createWorld({ width: 64, height: 64 });
    const { match, context } = setup(world);
    spawnAt(match, 0, 30, 30, 'siege');
    // The spotter is a depot: it has eyes but no weapon, so the only damage
    // in this test is the tank's shell.
    spawnAt(match, 0, 36, 30, 'depot');
    spawnAt(match, 1, 36, 31);
    const startHp = match.units.hp[2] as number;

    updateFog(match, world);
    run(match, context, ACQUIRE_INTERVAL_TICKS + 1);
    // The shell is in flight, and has not landed yet.
    expect(match.projectiles.alive).toBeGreaterThan(0);
    expect(match.units.hp[2]).toBe(startHp);

    run(match, context, 30);
    expect(match.units.hp[2]).toBeLessThan(startHp);
    expect(unitTypeById('siege').projectileSpeed).toBeGreaterThan(0);
  });

  it('a hitscan shot lands the tick it is fired', () => {
    const { match, context } = setup();
    spawnAt(match, 0, 30, 30);
    spawnAt(match, 1, 32, 30);
    const startHp = match.units.hp[1] as number;
    run(match, context, ACQUIRE_INTERVAL_TICKS + 1);
    expect(match.units.hp[1]).toBeLessThan(startHp);
    expect(match.projectiles.alive).toBe(0);
    expect(unitTypeById('soldier').projectileSpeed).toBe(0);
  });

  it('a shot whose target dies in flight expires rather than re-targeting', () => {
    const world = w.createWorld({ width: 64, height: 64 });
    const { match, context } = setup(world);
    spawnAt(match, 0, 30, 30, 'siege');
    spawnAt(match, 0, 36, 30, 'depot');
    const victim = spawnAt(match, 1, 36, 31);
    spawnAt(match, 1, 36, 32); // a second enemy the shell must not adopt
    const bystanderHp = match.units.hp[3] as number;

    updateFog(match, world);
    run(match, context, ACQUIRE_INTERVAL_TICKS + 1);
    expect(match.projectiles.alive).toBeGreaterThan(0);

    match.units.hp[resolve(match.units, victim)] = 0;
    stepMatch(match, [], context);
    run(match, context, 5);
    expect(match.projectiles.alive).toBe(0);
    expect(match.units.hp[3]).toBe(bystanderHp);
  });
});

describe('a battle', () => {
  function battle(seed: number): { hash: number; survivors: number[] } {
    const world = w.createWorld({ width: 64, height: 64 });
    const match = createMatchFromWorld({
      world,
      seed,
      playerCount: 2,
      startingWorkers: 0,
    startingDepots: 0,
      costGrid: createCostGrid(world),
    });
    const context = { world };

    for (let i = 0; i < 8; i++) {
      spawnAt(match, 0, 28 + (i % 4), 28 + ((i / 4) | 0));
      spawnAt(match, 1, 32 + (i % 4), 28 + ((i / 4) | 0));
    }
    for (let tick = 0; tick < 1200 && match.units.alive > 0; tick++) {
      stepMatch(match, [], context);
    }

    const survivors = [0, 0];
    forEachUnit(match.units, (i) => {
      survivors[match.units.ownerId[i] as number]!++;
    });
    return { hash: hashMatch(match), survivors };
  }

  it('fights to a conclusion', () => {
    const { survivors } = battle(7);
    // Sixteen units enter; the fight resolves rather than stalling forever.
    expect(survivors[0]! + survivors[1]!).toBeLessThan(16);
  });

  it('reaches an identical conclusion from the same seed', () => {
    const a = battle(7);
    const b = battle(7);
    expect(a.hash).toBe(b.hash);
    expect(a.survivors).toEqual(b.survivors);
  });
});
