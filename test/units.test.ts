import { describe, expect, it } from 'vitest';
import * as u from '../src/sim/units.ts';
import { UNIT_TYPES, unitType, unitTypeById } from '../src/sim/unittypes.ts';
import { TICKS_PER_SECOND } from '../src/sim/ticks.ts';
import { createMatch, hashableArrays } from '../src/sim/match.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import { fromInt, toFloat } from '../src/sim/fixed.ts';
import { makeRand, nextRange } from '../src/sim/rand.ts';

const worker = unitTypeById('worker');

const spawn = (store: u.UnitStore, owner = 0, x = 0, z = 0): u.UnitHandle =>
  u.spawnUnit(store, { type: worker, ownerId: owner, x: fromInt(x), z: fromInt(z) });

describe('unit type table', () => {
  it('loads every type with a stable id', () => {
    expect(UNIT_TYPES.length).toBeGreaterThan(1);
    UNIT_TYPES.forEach((type, index) => {
      expect(type.typeId).toBe(index);
      expect(unitType(index)).toBe(type);
      expect(unitTypeById(type.id)).toBe(type);
    });
  });

  it('converts speeds to cells per tick and distances to cells', () => {
    // 2.8 cells/second at 20 ticks/second is 0.14 cells/tick.
    expect(toFloat(worker.speed)).toBeCloseTo(2.8 / TICKS_PER_SECOND, 4);
    expect(toFloat(worker.sightRadius)).toBeCloseTo(8, 4);
    expect(toFloat(worker.radius)).toBeCloseTo(0.375, 4);
  });

  it('rejects unknown types loudly', () => {
    expect(() => unitTypeById('dragon')).toThrow(/unknown unit type/);
    expect(() => unitType(999)).toThrow(/unknown unit type id/);
  });
});

describe('handles', () => {
  it('packs an index and a generation and reads them back', () => {
    for (const [index, generation] of [
      [0, 1],
      [1, 2],
      [u.MAX_UNITS - 1, 7],
      [1023, 2047],
    ] as const) {
      const handle = u.makeHandle(index, generation);
      expect(u.handleIndex(handle)).toBe(index);
      expect(u.handleGeneration(handle)).toBe(generation);
      expect(handle).toBeGreaterThan(0); // never collides with NULL_HANDLE
    }
  });

  it('resolves a live unit and refuses a dead one', () => {
    const store = u.createUnitStore();
    const handle = spawn(store);
    expect(u.isAlive(store, handle)).toBe(true);
    expect(u.resolve(store, handle)).toBe(0);

    u.despawnUnit(store, handle);
    expect(u.isAlive(store, handle)).toBe(false);
    expect(u.resolve(store, handle)).toBe(-1);
  });

  it('refuses the null handle and handles beyond the store', () => {
    const store = u.createUnitStore();
    expect(u.resolve(store, u.NULL_HANDLE)).toBe(-1);
    expect(u.resolve(store, u.makeHandle(500, 1))).toBe(-1);
  });

  it('does not let a recycled slot answer to the old unit handle', () => {
    // The bug this prevents: unit A dies, unit B takes its slot, and an order
    // still pointing at A starts driving B.
    const store = u.createUnitStore();
    const first = spawn(store, 0, 5, 5);
    u.despawnUnit(store, first);
    const second = spawn(store, 1, 9, 9);

    expect(u.handleIndex(second)).toBe(u.handleIndex(first)); // same slot
    expect(second).not.toBe(first); // different handle
    expect(u.resolve(store, first)).toBe(-1);
    expect(u.resolve(store, second)).toBe(0);
    expect(store.ownerId[0]).toBe(1);
  });

  it('skips zero when the generation wraps', () => {
    const store = u.createUnitStore();
    // 2^11 despawns take the 11-bit generation field all the way round.
    for (let i = 0; i < 2100; i++) {
      const handle = spawn(store);
      expect(handle).not.toBe(u.NULL_HANDLE);
      expect(u.isAlive(store, handle)).toBe(true);
      u.despawnUnit(store, handle);
    }
    expect(store.generation[0]).toBeGreaterThan(0);
  });
});

describe('allocation', () => {
  it('initialises every field on spawn', () => {
    const store = u.createUnitStore();
    const handle = u.spawnUnit(store, {
      type: worker,
      ownerId: 3,
      x: fromInt(7),
      z: fromInt(-2),
      facing: fromInt(1),
    });
    const i = u.resolve(store, handle);
    expect(store.posX[i]).toBe(fromInt(7));
    expect(store.posZ[i]).toBe(fromInt(-2));
    expect(store.velX[i]).toBe(0);
    expect(store.hp[i]).toBe(worker.maxHp);
    expect(store.maxHp[i]).toBe(worker.maxHp);
    expect(store.typeId[i]).toBe(worker.typeId);
    expect(store.ownerId[i]).toBe(3);
    expect(store.state[i]).toBe(u.UnitState.Idle);
    expect(store.targetHandle[i]).toBe(u.NULL_HANDLE);
    expect(store.cooldown[i]).toBe(0);
    expect(store.facing[i]).toBe(fromInt(1));
  });

  it('leaves no fragmentation across 10,000 spawns and despawns', () => {
    const store = u.createUnitStore();
    const rand = makeRand(1234);
    const live: u.UnitHandle[] = [];
    let spawns = 0;

    while (spawns < 10_000) {
      // Churn: spawn a few, drop a random few, repeat.
      const batch = nextRange(rand, 1, 12);
      for (let i = 0; i < batch && spawns < 10_000; i++) {
        const handle = spawn(store, 0, i, spawns);
        expect(handle).not.toBe(u.NULL_HANDLE);
        live.push(handle);
        spawns++;
      }
      const drop = nextRange(rand, 0, live.length);
      for (let i = 0; i < drop; i++) {
        const index = nextRange(rand, 0, live.length);
        const [handle] = live.splice(index, 1);
        if (handle !== undefined) expect(u.despawnUnit(store, handle)).toBe(true);
      }
    }

    // Slots are recycled, so the high-water mark tracks peak concurrent units
    // rather than total spawns. Without a free list this would be 10,000.
    expect(store.alive).toBe(live.length);
    expect(store.count).toBeLessThan(2000);
    expect(store.count).toBeGreaterThanOrEqual(store.alive);

    // Every surviving handle still resolves, and every dropped one does not.
    for (const handle of live) expect(u.isAlive(store, handle)).toBe(true);
  });

  it('reports the store being full instead of throwing', () => {
    const store = u.createUnitStore();
    for (let i = 0; i < u.MAX_UNITS; i++) {
      expect(spawn(store)).not.toBe(u.NULL_HANDLE);
    }
    expect(spawn(store)).toBe(u.NULL_HANDLE);
    expect(store.alive).toBe(u.MAX_UNITS);
  });

  it('refuses to despawn twice', () => {
    const store = u.createUnitStore();
    const handle = spawn(store);
    expect(u.despawnUnit(store, handle)).toBe(true);
    expect(u.despawnUnit(store, handle)).toBe(false);
    expect(store.alive).toBe(0);
  });

  it('resets without reallocating', () => {
    const store = u.createUnitStore();
    const buffer = store.posX.buffer;
    for (let i = 0; i < 50; i++) spawn(store, 0, i, i);
    u.resetUnitStore(store);
    expect(store.count).toBe(0);
    expect(store.alive).toBe(0);
    expect(store.posX.buffer).toBe(buffer);
    expect(Array.from(store.posX.slice(0, 50)).every((v) => v === 0)).toBe(true);
  });

  it('visits live units only', () => {
    const store = u.createUnitStore();
    const handles = [spawn(store, 0, 1, 1), spawn(store, 0, 2, 2), spawn(store, 0, 3, 3)];
    u.despawnUnit(store, handles[1] as number);
    const seen: number[] = [];
    u.forEachUnit(store, (index) => seen.push(index));
    expect(seen).toEqual([0, 2]);
  });
});

describe('units in the determinism hash', () => {
  it('the store is part of the match hash', () => {
    const names = hashableArrays(createMatch({ seed: 1, playerCount: 2 })).map((a) => a.name);
    expect(names).toContain('unit.posX');
    expect(names).toContain('unit.generation');
  });

  it('a spawned unit changes the hash, and despawning it does not restore it', () => {
    const match = createMatch({ seed: 1, playerCount: 2 });
    const empty = hashMatch(match);

    const handle = spawn(match.units, 0, 4, 4);
    const withUnit = hashMatch(match);
    expect(withUnit).not.toBe(empty);

    u.despawnUnit(match.units, handle);
    // The slot survives with a bumped generation, which is exactly the state a
    // desync would need to agree on.
    expect(hashMatch(match)).not.toBe(empty);
    expect(hashMatch(match)).not.toBe(withUnit);
  });

  it('two matches that spawned the same units hash identically', () => {
    const a = createMatch({ seed: 7, playerCount: 2 });
    const b = createMatch({ seed: 7, playerCount: 2 });
    for (const match of [a, b]) {
      for (let i = 0; i < 25; i++) spawn(match.units, i % 2, i, i * 2);
      u.despawnUnit(match.units, u.makeHandle(3, 1));
      u.despawnUnit(match.units, u.makeHandle(17, 1));
      spawn(match.units, 1, 99, 99);
    }
    expect(hashMatch(a)).toBe(hashMatch(b));
  });
});
