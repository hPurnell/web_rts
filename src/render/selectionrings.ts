/**
 * Selection rings.
 *
 * An instanced ground decal per selected unit, not an outline pass: outlines
 * need a second render of every selected mesh, and at RTS selection sizes that
 * is hundreds of extra draws for a ring that reads better flat on the ground
 * anyway.
 */
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

import type { UnitHandle, UnitStore } from '../sim/units.ts';
import { resolve } from '../sim/units.ts';
import { UNIT_TYPES } from '../sim/unittypes.ts';
import { toFloat } from '../sim/fixed.ts';
import type { World } from '../sim/world.ts';
import type { HeightOverrides } from '../sim/terrain.ts';
import { groundHeightAt } from './units.ts';

/** Height above the terrain, enough to clear it without visibly floating. */
const LIFT = 0.05;
const FLOATS_PER_MATRIX = 16;

export interface SelectionRings {
  update(
    handles: readonly UnitHandle[],
    store: UnitStore,
    world: World,
    overrides: HeightOverrides | null,
  ): void;
  count(): number;
  /** Hide every ring, e.g. when a match ends. */
  clear(): void;
  dispose(): void;
}

export function createSelectionRings(scene: Scene): SelectionRings {
  const material = new StandardMaterial('selectionRing', scene);
  material.disableLighting = true;
  material.emissiveColor = new Color3(0.35, 0.95, 0.45);
  material.diffuseColor = new Color3(0, 0, 0);
  material.alpha = 0.85;
  material.backFaceCulling = false;
  material.zOffset = -4;

  // A unit-radius ring laid flat on the ground. Scaling is baked into each
  // instance matrix, so one mesh covers every unit size. A ring rather than a
  // filled disc: a disc the size of the unit disappears under it.
  const mesh: Mesh = CreateTorus(
    'selectionRing',
    { diameter: 2, thickness: 0.22, tessellation: 20 },
    scene,
  );
  mesh.bakeCurrentTransformIntoVertices();
  mesh.material = material;
  mesh.isPickable = false;
  mesh.thinInstanceEnablePicking = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.setEnabled(false);

  let data = new Float32Array(0);
  let written = 0;

  return {
    count: () => written,

    update(handles, store, world, overrides) {
      const needed = handles.length;
      if (needed === 0) {
        written = 0;
        mesh.setEnabled(false);
        return;
      }
      if (data.length < needed * FLOATS_PER_MATRIX) {
        let size = Math.max(16, data.length / FLOATS_PER_MATRIX || 16);
        while (size < needed) size *= 2;
        data = new Float32Array(size * FLOATS_PER_MATRIX);
      }

      written = 0;
      for (const handle of handles) {
        const index = resolve(store, handle);
        if (index < 0) continue;
        const x = toFloat(store.posX[index] as number);
        const z = toFloat(store.posZ[index] as number);
        const y = groundHeightAt(world, overrides, x, z) + LIFT;
        // Comfortably outside the hull, so the ring reads as a ring.
        const radius = toFloat(UNIT_TYPES[store.typeId[index] as number]?.radius ?? 0) * 2.1;

        // Scale on X and Z, no rotation: a ring has none to speak of.
        const offset = written * FLOATS_PER_MATRIX;
        data.fill(0, offset, offset + FLOATS_PER_MATRIX);
        data[offset] = radius;
        data[offset + 5] = 1;
        data[offset + 10] = radius;
        data[offset + 12] = x;
        data[offset + 13] = y;
        data[offset + 14] = z;
        data[offset + 15] = 1;
        written++;
      }

      if (written === 0) {
        mesh.setEnabled(false);
        return;
      }
      mesh.thinInstanceSetBuffer('matrix', data, FLOATS_PER_MATRIX, false);
      mesh.thinInstanceCount = written;
      mesh.setEnabled(true);
    },

    clear() {
      written = 0;
      mesh.setEnabled(false);
    },

    dispose() {
      mesh.dispose();
      material.dispose();
    },
  };
}
