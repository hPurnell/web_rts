import { describe, expect, it } from 'vitest';
import {
  FOG_INTERVAL_TICKS,
  VISIBLE,
  canSeeUnit,
  createFogGrids,
  visionRays,
  isExplored,
  isVisible,
  rememberedStructure,
  updateFog,
} from '../src/sim/fog.ts';
import { cornerStride } from '../src/sim/terrain.ts';
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
    startingDepots: 0,
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

describe('vision rays', () => {
  it('stays inside the disc, and is cached by radius', () => {
    const rays = visionRays(3);
    expect(visionRays(3)).toBe(rays); // same table, not recomputed

    for (let i = 0; i < rays.dx.length; i++) {
      const dx = rays.dx[i] as number;
      const dz = rays.dz[i] as number;
      expect(dx * dx + dz * dz).toBeLessThanOrEqual(9);
      // The run is that distance in 1/256 of a cell.
      expect(rays.run[i]).toBeCloseTo(Math.sqrt(dx * dx + dz * dz) * 256, -1);
    }
  });

  it('covers every cell of the disc', () => {
    // The point of one ray per perimeter cell: no cell inside the radius is
    // missed, so flat ground reveals a disc exactly as the old stamp did.
    const radius = 6;
    const rays = visionRays(radius);
    const seen = new Set<string>();
    for (let i = 0; i < rays.dx.length; i++) seen.add(`${rays.dx[i]},${rays.dz[i]}`);

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        if (dx === 0 && dz === 0) continue; // the centre is revealed directly
        expect(seen.has(`${dx},${dz}`)).toBe(true);
      }
    }
  });

  it('gets denser with radius, as a circumference does', () => {
    const rayCount = (radius: number): number => visionRays(radius).starts.length - 1;
    expect(rayCount(6)).toBeGreaterThan(rayCount(3));
    expect(visionRays(0).dx.length).toBe(0); // only the centre, revealed directly
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

  it('sees down a cliff, and only the face of it from below', () => {
    // The high-ground rule, which used to be a tier comparison and is now a
    // consequence of the horizon sweep: what the low unit can see of the
    // plateau is its edge, because the edge is what its line of sight meets.
    const world = w.createWorld({ width: 32, height: 8 });
    const stride = cornerStride(world);
    for (let cz = 0; cz <= 8; cz++) {
      for (let cx = 16; cx <= 32; cx++) world.heights[cz * stride + cx] = fromInt(8);
    }
    const { match } = setup(world);

    const high = spawnAt(match, 0, 16, 4);
    const low = spawnAt(match, 1, 14, 4);
    expect(high).toBeGreaterThan(0);
    expect(low).toBeGreaterThan(0);
    updateFog(match, world);

    // The unit at the lip sees the low ground below and beyond it.
    expect(isVisible(match.fog, 0, w.cellIndex(world, 14, 4))).toBe(true);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 12, 4))).toBe(true);

    // The unit below sees the cliff and its lip, and nothing behind it: the
    // lip raises the horizon above everything further back.
    expect(isVisible(match.fog, 1, w.cellIndex(world, 12, 4))).toBe(true);
    expect(isVisible(match.fog, 1, w.cellIndex(world, 16, 4))).toBe(true);
    expect(isVisible(match.fog, 1, w.cellIndex(world, 18, 4))).toBe(false);
    expect(isVisible(match.fog, 1, w.cellIndex(world, 20, 4))).toBe(false);
  });

  it('leaves a shadow behind a ridge', () => {
    // A ridge with low ground on both sides. A unit on one side sees up to
    // the crest and no further, which is what a heightfield buys that a tier
    // comparison never could.
    const world = w.createWorld({ width: 40, height: 8 });
    const stride = cornerStride(world);
    for (let cz = 0; cz <= 8; cz++) world.heights[cz * stride + 20] = fromInt(10);
    const { match } = setup(world);

    spawnAt(match, 0, 14, 4);
    updateFog(match, world);

    expect(isVisible(match.fog, 0, w.cellIndex(world, 18, 4))).toBe(true);
    expect(isVisible(match.fog, 0, w.cellIndex(world, 22, 4))).toBe(false);
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
    startingDepots: 0,
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

describe('remembered structures', () => {
  it('remembers a scouted structure after the scout leaves', () => {
    const { match, world } = setup();
    const structureCell = w.cellIndex(world, 40, 40);
    spawnAt(match, 1, 40, 40, 'depot');
    const scout = spawnAt(match, 0, 38, 40);

    updateFog(match, world);
    expect(rememberedStructure(match.fog, 0, structureCell)).toEqual({
      typeId: unitTypeById('depot').typeId,
      ownerId: 1,
    });

    // The scout dies; the memory stays.
    despawnUnit(match.units, scout);
    updateFog(match, world);
    expect(isVisible(match.fog, 0, structureCell)).toBe(false);
    expect(rememberedStructure(match.fog, 0, structureCell)?.ownerId).toBe(1);
  });

  it('keeps a memory that has gone stale until the player looks again', () => {
    // The memory is what you saw, not what is there. A base demolished out of
    // sight stays on your map, which is the behaviour players rely on.
    const { match, world } = setup();
    const structureCell = w.cellIndex(world, 40, 40);
    const structure = spawnAt(match, 1, 40, 40, 'depot');
    const scout = spawnAt(match, 0, 38, 40);
    updateFog(match, world);

    despawnUnit(match.units, scout);
    updateFog(match, world);
    despawnUnit(match.units, structure);
    updateFog(match, world);
    expect(rememberedStructure(match.fog, 0, structureCell)).not.toBeNull();

    // Look again, and the memory corrects itself.
    spawnAt(match, 0, 38, 40);
    updateFog(match, world);
    expect(rememberedStructure(match.fog, 0, structureCell)).toBeNull();
  });

  it('does not remember units that move', () => {
    const { match, world } = setup();
    spawnAt(match, 1, 40, 40, 'soldier');
    spawnAt(match, 0, 38, 40);
    updateFog(match, world);
    expect(rememberedStructure(match.fog, 0, w.cellIndex(world, 40, 40))).toBeNull();
  });

  it('is per player', () => {
    const { match, world } = setup();
    spawnAt(match, 1, 40, 40, 'depot');
    spawnAt(match, 0, 38, 40);
    updateFog(match, world);
    expect(rememberedStructure(match.fog, 0, w.cellIndex(world, 40, 40))).not.toBeNull();
    // Player 1 owns it and sees it, so it is remembered for them too.
    expect(rememberedStructure(match.fog, 1, w.cellIndex(world, 40, 40))).not.toBeNull();
    // A third player who has seen nothing remembers nothing.
    expect(rememberedStructure(match.fog, 2, w.cellIndex(world, 40, 40))).toBeNull();
  });
});
