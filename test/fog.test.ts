import { describe, expect, it } from 'vitest';
import {
  FOG_INTERVAL_TICKS,
  VISIBLE,
  canSeeUnit,
  createFogGrids,
  discOffsets,
  isExplored,
  isVisible,
  updateFog,
} from '../src/sim/fog.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { spawnUnit, despawnUnit } from '../src/sim/units.ts';
import type { UnitHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { hashableArrays } from '../src/sim/match.ts';
import { hashMatch } from '../src/sim/statehash.ts';
import * as w from '../src/sim/world.ts';
import { ONE, fromInt, toInt } from '../src/sim/fixed.ts';

function setup(world = createTestMap()) {
  const match = createMatchFromWorld({
    world,
    seed: 1,
    playerCount: 2,
    startingWorkers: 0,
    costGrid: createCostGrid(world),
  });
  return { world, match, context: { world } };
}

function spawnAt(match: ReturnType<typeof createMatchFromWorld>, owner: number, x: number, z: number, type = 'soldier'): UnitHandle {
  return spawnUnit(match.units, {
    type: unitTypeById(type),
    ownerId: owner,
    x: fromInt(x) + ONE / 2,
    z: fromInt(z) + ONE / 2,
  });
}

describe('sight discs', () => {
  it('is a filled circle, cached by radius', () => {
    const offsets = discOffsets(3);
    expect(discOffsets(3)).toBe(offsets); // same array, not recomputed
    const cells = offsets.length / 2;
    // A radius-3 disc holds 29 cells; a 7x7 square would hold 49.
    expect(cells).toBe(29);
    for (let i = 0; i < offsets.length; i += 2) {
      const dx = offsets[i] as number;
      const dy = offsets[i + 1] as number;
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(9);
    }
  });

  it('grows with the square of the radius', () => {
    expect(discOffsets(6).length).toBeGreaterThan(discOffsets(3).length * 3);
    expect(discOffsets(0).length).toBe(2); // just the centre cell
  });
});

describe('visibility', () => {
  it('reveals a disc around a unit and leaves the rest dark', () => {
    const { match, world } = setup();
    spawnAt(match, 0, 32, 32);
    updateFog(match, world);

    expect(isVisible(match.fog, 0, w.cellIndex(world, 32, 32))).toBe(true);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 36, 32))).toBe(true);
    const sight = toInt(unitTypeById('soldier').sightRadius);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 32 + sight + 2, 32))).toBe(false);
    // And the other player sees none of it.
    expect(isVisible(match.fog, 1, w.cellIndex(world, 32, 32))).toBe(false);
  });

  it('sees down a cliff but not up it', () => {
    // The high-ground rule, which is the whole point of tiered terrain.
    const world = w.createWorld({ width: 32, height: 8 });
    for (let y = 0; y < 8; y++) {
      for (let x = 16; x < 32; x++) world.tier[w.cellIndex(world, x, y)] = 2;
    }
    const { match } = setup(world);

    const high = spawnAt(match, 0, 18, 4);
    const low = spawnAt(match, 1, 14, 4);
    expect(high).toBeGreaterThan(0);
    expect(low).toBeGreaterThan(0);
    updateFog(match, world);

    // The unit on tier 2 sees the low ground beside it.
    expect(isVisible(match.fog, 0, w.cellIndex(world, 14, 4))).toBe(true);
    // The unit on tier 0 cannot see up onto the plateau at all.
    expect(isVisible(match.fog, 1, w.cellIndex(world, 18, 4))).toBe(false);
    expect(isVisible(match.fog, 1, w.cellIndex(world, 16, 4))).toBe(false);
    // But it still sees its own level.
    expect(isVisible(match.fog, 1, w.cellIndex(world, 12, 4))).toBe(true);
  });

  it('does not reveal a vision blocker', () => {
    const world = w.createWorld({ width: 32, height: 8 });
    const blocked = w.cellIndex(world, 20, 4);
    w.setFlags(world, blocked, w.WALKABLE | w.VISION_BLOCKER);
    const { match } = setup(world);
    spawnAt(match, 0, 18, 4);
    updateFog(match, world);

    expect(isVisible(match.fog, 0, w.cellIndex(world, 19, 4))).toBe(true);
    expect(isVisible(match.fog, 0, blocked)).toBe(false);
  });

  it('clears as a unit leaves, but explored never clears', () => {
    const { match, world } = setup();
    const handle = spawnAt(match, 0, 32, 32);
    updateFog(match, world);
    const cell = w.cellIndex(world, 34, 32);
    expect(isVisible(match.fog, 0, cell)).toBe(true);
    expect(isExplored(match.fog, 0, cell)).toBe(true);

    despawnUnit(match.units, handle);
    updateFog(match, world);
    expect(isVisible(match.fog, 0, cell)).toBe(false);
    // What you have seen, you remember.
    expect(isExplored(match.fog, 0, cell)).toBe(true);
  });

  it('computes every player grid, not only the local one', () => {
    const { match, world } = setup();
    spawnAt(match, 0, 10, 12);
    spawnAt(match, 1, 54, 50);
    updateFog(match, world);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 10, 12))).toBe(true);
    expect(isVisible(match.fog, 1, w.cellIndex(world, 54, 50))).toBe(true);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 54, 50))).toBe(false);
  });

  it('clamps the disc at the map edge rather than wrapping', () => {
    const { match, world } = setup();
    spawnAt(match, 0, 1, 1);
    expect(() => updateFog(match, world)).not.toThrow();
    // A wrap would light up the far corner.
    expect(isVisible(match.fog, 0, w.cellIndex(world, 63, 63))).toBe(false);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 63, 1))).toBe(false);
  });

  it('answers whether a player can see a unit', () => {
    const { match, world } = setup();
    spawnAt(match, 0, 32, 32);
    spawnAt(match, 1, 34, 32); // close enough to be spotted
    spawnAt(match, 1, 60, 60); // far away
    updateFog(match, world);

    expect(canSeeUnit(match, world, 0, 0)).toBe(true); // own unit, always
    expect(canSeeUnit(match, world, 0, 1)).toBe(true);
    expect(canSeeUnit(match, world, 0, 2)).toBe(false);
  });
});

describe('fog in the tick loop', () => {
  it('updates on the interval, not every tick', () => {
    const { match, context, world } = setup();
    spawnAt(match, 0, 32, 32);
    // Tick 0 stamps; the unit is then teleported and vision must lag.
    stepMatch(match, [], context);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 32, 32))).toBe(true);

    match.units.posX[0] = fromInt(10) + ONE / 2;
    match.units.posZ[0] = fromInt(10) + ONE / 2;
    stepMatch(match, [], context);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 32, 32))).toBe(true); // not yet

    for (let i = 0; i < FOG_INTERVAL_TICKS; i++) stepMatch(match, [], context);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 32, 32))).toBe(false);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 10, 10))).toBe(true);
  });

  it('is part of the determinism hash', () => {
    const names = hashableArrays(
      createMatchFromWorld({
        world: createTestMap(),
        seed: 1,
        playerCount: 2,
        startingWorkers: 0,
      }),
    ).map((a) => a.name);
    expect(names).toContain('fog.visible.0');
    expect(names).toContain('fog.explored.1');
  });

  it('changes the hash when vision changes', () => {
    const { match, context } = setup();
    const before = hashMatch(match);
    spawnAt(match, 0, 32, 32);
    stepMatch(match, [], context);
    expect(hashMatch(match)).not.toBe(before);
    expect(match.fog.visible[0]?.some((v) => v === VISIBLE)).toBe(true);
  });
});

describe('fog performance', () => {
  it('updates 200 units at sight radius 9 in under 2ms', () => {
    const world = w.createWorld({ width: 128, height: 128 });
    const { match } = setup(world);
    for (let i = 0; i < 200; i++) {
      spawnAt(match, i % 2, 10 + (i % 100), 10 + ((i / 100) | 0), 'siege');
    }
    expect(toInt(unitTypeById('siege').sightRadius)).toBeGreaterThanOrEqual(9);

    for (let i = 0; i < 10; i++) updateFog(match, world); // warm up
    const start = performance.now();
    const runs = 30;
    for (let i = 0; i < runs; i++) updateFog(match, world);
    const per = (performance.now() - start) / runs;
    expect(per).toBeLessThan(2);
  });

  it('shares the grids rather than allocating per update', () => {
    const { match, world } = setup();
    spawnAt(match, 0, 32, 32);
    const grid = match.fog.visible[0];
    updateFog(match, world);
    updateFog(match, world);
    expect(match.fog.visible[0]).toBe(grid);
  });
});

describe('fog grid construction', () => {
  it('sizes grids to the map and starts dark', () => {
    const fog = createFogGrids(40, 30);
    expect(fog.width).toBe(40);
    expect(fog.visible[0]).toHaveLength(1200);
    expect(fog.explored[0]?.every((v) => v === 0)).toBe(true);
    expect(isVisible(fog, 0, 5)).toBe(false);
    expect(isVisible(fog, 99, 5)).toBe(false); // out-of-range player
  });
});
