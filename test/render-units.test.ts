import { beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Scene } from '@babylonjs/core/scene';

import { createUnitRenderer } from '../src/render/units.ts';

import { createMatch } from '../src/sim/match.ts';
import { spawnUnit, despawnUnit, MAX_UNITS } from '../src/sim/units.ts';
import { UNIT_TYPES, unitTypeById } from '../src/sim/unittypes.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { fromInt, fromRatio } from '../src/sim/fixed.ts';
import type { World } from '../src/sim/world.ts';

const world: World = createTestMap();
const overrides = null;

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
    renderer.update(match, world, overrides, 0);
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
    renderer.update(match, world, overrides, 1);

    expect(renderer.instanceCount()).toBe(55);
    // One mesh per type, whoever owns the units: player colour is a
    // per-instance attribute, not a separate material.
    const byName = new Map(unitMeshes().map((m) => [m.name, m.thinInstanceCount]));
    expect(byName.get('hull_t1')).toBe(50);
    expect(byName.get('hull_t2')).toBe(5);
    renderer.dispose();
  });

  it('gives a second buffer only to types whose weapon rotates', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnMany(match, 'worker', 0, 4);
    spawnMany(match, 'raider', 0, 4);
    renderer.update(match, world, overrides, 1);

    const names = unitMeshes().map((m) => m.name);
    expect(unitTypeById('worker').hasTurret).toBe(false);
    expect(unitTypeById('raider').hasTurret).toBe(true);
    expect(names).toContain('hull_t0');
    expect(names).not.toContain('turret_t0'); // workers have no turret
    expect(names).toContain('turret_t2');
    renderer.dispose();
  });

  it('stays under the draw-call budget with 2,000 units', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    // Every type, both players: the worst realistic case for draw calls,
    // since each combination is its own instance buffer.
    const per = Math.floor(2000 / (UNIT_TYPES.length * 2));
    for (const type of UNIT_TYPES) {
      spawnMany(match, type.id, 0, per);
      spawnMany(match, type.id, 1, per);
    }
    renderer.update(match, world, overrides, 1);

    expect(renderer.instanceCount()).toBe(per * UNIT_TYPES.length * 2);
    expect(renderer.instanceCount()).toBeGreaterThanOrEqual(1900);
    // PLAN.md's budget is under 15 draw calls for the units.
    expect(unitMeshes().length).toBeLessThan(15);
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
      renderer.update(match, world, overrides, alpha);
      const mesh = scene.meshes.find((m) => m.name === 'hull_t1') as Mesh | undefined;
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
    renderer.update(match, world, overrides, 5);
    const mesh = scene.meshes.find((m) => m.name === 'hull_t1') as Mesh | undefined;
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

    renderer.update(match, world, overrides, 0.5);
    const mesh = scene.meshes.find((m) => m.name === 'hull_t1') as Mesh | undefined;
    const data = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;
    // Halfway between 6.2 and 0.1 the short way is about 6.33 rad, i.e. just
    // past zero: cos near 1. Going the long way would land near cos(3.15).
    expect(data[0]).toBeGreaterThan(0.9);
    renderer.dispose();
  });

  it('places units on the terrain surface, following the ground', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    // One up on the plateau, one down in the basin.
    spawnUnit(match.units, { type: unitTypeById('soldier'), ownerId: 0, x: fromInt(16), z: fromInt(16) });
    spawnUnit(match.units, { type: unitTypeById('soldier'), ownerId: 0, x: fromInt(70), z: fromInt(64) });
    renderer.update(match, world, overrides, 1);

    const mesh = scene.meshes.find((m) => m.name === 'hull_t1') as Mesh | undefined;
    const data = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;
    const plateauY = data[13] as number;
    const basinY = data[16 + 13] as number;
    expect(plateauY).toBeGreaterThan(5); // the plateau stands six units up
    expect(basinY).toBeLessThan(1);
    renderer.dispose();
  });

  it('drops a unit from the instance buffer the frame it dies', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    const handles = [0, 1, 2].map(() =>
      spawnUnit(match.units, { type: unitTypeById('soldier'), ownerId: 0, x: fromInt(10), z: fromInt(10) }),
    );
    renderer.update(match, world, overrides, 1);
    expect(renderer.instanceCount()).toBe(3);

    despawnUnit(match.units, handles[1] as number);
    renderer.update(match, world, overrides, 1);
    expect(renderer.instanceCount()).toBe(2);
    renderer.dispose();
  });

  it('clears everything when a match ends', () => {
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnMany(match, 'soldier', 0, 10);
    renderer.update(match, world, overrides, 1);
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
    renderer.update(match, world, overrides, 1);
    const mesh = scene.meshes.find((m) => m.name === 'hull_t1') as Mesh | undefined;
    const first = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;

    spawnMany(match, 'soldier', 0, 5); // still inside the allocated capacity
    renderer.update(match, world, overrides, 1);
    const second = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })
      ._thinInstanceDataStorage.matrixData;
    expect(second).toBe(first);
    expect(MAX_UNITS).toBeGreaterThan(2000);
    renderer.dispose();
  });
});
