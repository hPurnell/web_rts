import { beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Scene } from '@babylonjs/core/scene';

import { createUnitRenderer } from '../src/render/units.ts';
import { solveRamps } from '../src/render/terrain.ts';
import { createMatch } from '../src/sim/match.ts';
import { spawnUnit, despawnUnit, MAX_UNITS } from '../src/sim/units.ts';
import { UNIT_TYPES, unitTypeById } from '../src/sim/unittypes.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { fromInt, fromRatio } from '../src/sim/fixed.ts';
import type { World } from '../src/sim/world.ts';

const world: World = createTestMap();
const ramps = solveRamps(world);

describe('instanced unit rendering', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = new Scene(new NullEngine());
  });

  const unitMeshes = (): Mesh[] =>
    scene.meshes.filter(
      (m) => m.isEnabled() && (m.name.startsWith('hull_') || m.name.startsWith('turret_')),
    ) as Mesh[];

  const spawnMany = (match: ReturnType<typeof createMatch>, typeId: string, owner: number, count: number): void => {
    const type = unitTypeById(typeId);
    for (let i = 0; i < count; i++) {
      spawnUnit(match.units, {
        type,
        ownerId: owner,
        x: fromInt(10 + (i % 40)),
        z: fromInt(10 + ((i / 40) | 0)),
        facing: fromRatio(i, 8),
      });
    }
  };

  it('draws nothing for an empty match', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    renderer.update(match, world, ramps, 0);
    expect(unitMeshes()).toHaveLength(0);
    expect(renderer.instanceCount()).toBe(0);
    renderer.dispose();
  });

  it('writes one instance per live unit, grouped by type and owner', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnMany(match, 'soldier', 0, 30);
    spawnMany(match, 'soldier', 1, 20);
    spawnMany(match, 'raider', 0, 5);
    renderer.update(match, world, ramps, 1);

    expect(renderer.instanceCount()).toBe(55);
    const byName = new Map(unitMeshes().map((m) => [m.name, m.thinInstanceCount]));
    expect(byName.get('hull_t1_p0')).toBe(30);
    expect(byName.get('hull_t1_p1')).toBe(20);
    expect(byName.get('hull_t2_p0')).toBe(5);
    renderer.dispose();
  });

  it('gives a second buffer only to types whose weapon rotates', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnMany(match, 'worker', 0, 4);
    spawnMany(match, 'raider', 0, 4);
    renderer.update(match, world, ramps, 1);

    const names = unitMeshes().map((m) => m.name);
    expect(unitTypeById('worker').hasTurret).toBe(false);
    expect(unitTypeById('raider').hasTurret).toBe(true);
    expect(names).toContain('hull_t0_p0');
    expect(names).not.toContain('turret_t0_p0'); // workers have no turret
    expect(names).toContain('turret_t2_p0');
    renderer.dispose();
  });

  it('stays under the draw-call budget with 2,000 units', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    // Every type, both players: the worst realistic case for draw calls.
    for (const type of UNIT_TYPES) {
      spawnMany(match, type.id, 0, 250);
      spawnMany(match, type.id, 1, 250);
    }
    renderer.update(match, world, ramps, 1);

    expect(renderer.instanceCount()).toBe(2000);
    // PLAN.md's budget is under 15 draw calls for the units.
    expect(unitMeshes().length).toBeLessThan(15);
    renderer.dispose();
  });

  it('writes 2,000 instances fast enough to do it every frame', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    for (const type of UNIT_TYPES) {
      spawnMany(match, type.id, 0, 250);
      spawnMany(match, type.id, 1, 250);
    }
    renderer.captureTick(match);

    const start = performance.now();
    const frames = 60;
    for (let i = 0; i < frames; i++) renderer.update(match, world, ramps, i / frames);
    const perFrame = (performance.now() - start) / frames;
    // A 60fps frame has 16ms for everything; instance writing must be a small
    // slice of that.
    expect(perFrame).toBeLessThan(6);
    renderer.dispose();
  });

  it('interpolates between ticks instead of snapping', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    const handle = spawnUnit(match.units, {
      type: unitTypeById('soldier'),
      ownerId: 0,
      x: fromInt(10),
      z: fromInt(10),
    });
    expect(handle).toBeGreaterThan(0);

    renderer.captureTick(match);
    match.units.posX[0] = fromInt(20);

    const xAt = (alpha: number): number => {
      renderer.update(match, world, ramps, alpha);
      const mesh = scene.meshes.find((m) => m.name === 'hull_t1_p0') as Mesh | undefined;
      const data = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
        ._thinInstanceDataStorage.matrixData;
      return data[12] as number;
    };

    expect(xAt(0)).toBeCloseTo(10, 4);
    expect(xAt(0.5)).toBeCloseTo(15, 4);
    expect(xAt(1)).toBeCloseTo(20, 4);
    renderer.dispose();
  });

  it('clamps a stale alpha rather than overshooting', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnUnit(match.units, { type: unitTypeById('soldier'), ownerId: 0, x: fromInt(10), z: fromInt(10) });
    renderer.captureTick(match);
    match.units.posX[0] = fromInt(20);
    renderer.update(match, world, ramps, 5);
    const mesh = scene.meshes.find((m) => m.name === 'hull_t1_p0') as Mesh | undefined;
    const data = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;
    expect(data[12]).toBeCloseTo(20, 4);
    renderer.dispose();
  });

  it('turns the short way round when facing wraps past zero', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnUnit(match.units, {
      type: unitTypeById('soldier'),
      ownerId: 0,
      x: fromInt(10),
      z: fromInt(10),
      facing: fromRatio(62, 10), // just under a full turn
    });
    renderer.captureTick(match);
    match.units.facing[0] = fromRatio(1, 10); // just past zero

    renderer.update(match, world, ramps, 0.5);
    const mesh = scene.meshes.find((m) => m.name === 'hull_t1_p0') as Mesh | undefined;
    const data = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;
    // Halfway between 6.2 and 0.1 the short way is about 6.33 rad, i.e. just
    // past zero: cos near 1. Going the long way would land near cos(3.15).
    expect(data[0]).toBeGreaterThan(0.9);
    renderer.dispose();
  });

  it('places units on the terrain surface, following ramps', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    // One on the tier 2 plateau, one in the tier 0 basin.
    spawnUnit(match.units, { type: unitTypeById('soldier'), ownerId: 0, x: fromInt(8), z: fromInt(8) });
    spawnUnit(match.units, { type: unitTypeById('soldier'), ownerId: 0, x: fromInt(32), z: fromInt(32) });
    renderer.update(match, world, ramps, 1);

    const mesh = scene.meshes.find((m) => m.name === 'hull_t1_p0') as Mesh | undefined;
    const data = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;
    const plateauY = data[13] as number;
    const basinY = data[16 + 13] as number;
    expect(plateauY).toBeGreaterThan(4); // tier 2 is 4 units up
    expect(basinY).toBeLessThan(1);
    renderer.dispose();
  });

  it('drops a unit from the instance buffer the frame it dies', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    const handles = [0, 1, 2].map(() =>
      spawnUnit(match.units, { type: unitTypeById('soldier'), ownerId: 0, x: fromInt(10), z: fromInt(10) }),
    );
    renderer.update(match, world, ramps, 1);
    expect(renderer.instanceCount()).toBe(3);

    despawnUnit(match.units, handles[1] as number);
    renderer.update(match, world, ramps, 1);
    expect(renderer.instanceCount()).toBe(2);
    renderer.dispose();
  });

  it('clears everything when a match ends', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnMany(match, 'soldier', 0, 10);
    renderer.update(match, world, ramps, 1);
    expect(unitMeshes().length).toBeGreaterThan(0);
    renderer.clear();
    expect(unitMeshes()).toHaveLength(0);
    expect(renderer.instanceCount()).toBe(0);
    renderer.dispose();
  });

  it('grows its buffers rather than reallocating every frame', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnMany(match, 'soldier', 0, 10);
    renderer.update(match, world, ramps, 1);
    const mesh = scene.meshes.find((m) => m.name === 'hull_t1_p0') as Mesh | undefined;
    const first = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;

    spawnMany(match, 'soldier', 0, 5); // still inside the allocated capacity
    renderer.update(match, world, ramps, 1);
    const second = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;
    expect(second).toBe(first);
    expect(MAX_UNITS).toBeGreaterThan(2000);
    renderer.dispose();
  });
});
