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
import { groundHeightAt, terrainNormalAt } from './units.ts';

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
        const ground = groundHeightAt(world, overrides, x, z);
        // Comfortably outside the hull, so the ring reads as a ring.
        const radius = toFloat(UNIT_TYPES[store.typeId[index] as number]?.radius ?? 0) * 2.1;

        // A flat ring on sloped ground buries its uphill edge and floats its
        // downhill one, and the wider the ring the worse it looks. Tilting it
        // into the surface is what makes it read as painted on the ground
        // rather than hovering over it, and the lift goes along the normal for
        // the same reason.
        const up = terrainNormalAt(world, overrides, x, z);
        const dot = up.z;
        let fx = -up.x * dot;
        let fy = -up.y * dot;
        let fz = 1 - up.z * dot;
        const flen = Math.hypot(fx, fy, fz) || 1;
        fx /= flen;
        fy /= flen;
        fz /= flen;

        const offset = written * FLOATS_PER_MATRIX;
        data[offset] = (up.y * fz - up.z * fy) * radius;
        data[offset + 1] = (up.z * fx - up.x * fz) * radius;
        data[offset + 2] = (up.x * fy - up.y * fx) * radius;
        data[offset + 3] = 0;
        data[offset + 4] = up.x;
        data[offset + 5] = up.y;
        data[offset + 6] = up.z;
        data[offset + 7] = 0;
        data[offset + 8] = fx * radius;
        data[offset + 9] = fy * radius;
        data[offset + 10] = fz * radius;
        data[offset + 11] = 0;
        data[offset + 12] = x + up.x * LIFT;
        data[offset + 13] = ground + up.y * LIFT;
        data[offset + 14] = z + up.z * LIFT;
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
