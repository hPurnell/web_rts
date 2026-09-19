/**
 * Remembered structures.
 *
 * A building you scouted stays on your map after the scout leaves, drawn from
 * the per-player memory in the fog grids rather than from live match state.
 * That is deliberate: the ghost shows what was there when you last looked, so
 * a base that has since been demolished is still on your map until you check
 * again. Getting that wrong — drawing the live building through fog — would
 * quietly hand players perfect information.
 */
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

import type { Match } from '../sim/match.ts';
import type { World } from '../sim/world.ts';
import { isVisible, rememberedStructure } from '../sim/fog.ts';
import { UNIT_TYPES } from '../sim/unittypes.ts';
import { toFloat } from '../sim/fixed.ts';
import type { HeightOverrides } from '../sim/terrain.ts';
import { groundHeightAt } from './units.ts';
import { PLAYER_COLORS } from './units.ts';

const FLOATS_PER_MATRIX = 16;
/** How washed out a remembered structure looks against a live one. */
const GHOST_ALPHA = 0.55;

export interface GhostRenderer {
  update(match: Match, world: World, overrides: HeightOverrides | null, localPlayer: number): void;
  count(): number;
  /** Hide every ghost, e.g. when a match ends. */
  clear(): void;
  dispose(): void;
}

export function createGhostRenderer(scene: Scene): GhostRenderer {
  const materials = PLAYER_COLORS.map((color, i) => {
    const material = new StandardMaterial(`ghost_p${i}`, scene);
    material.diffuseColor = color.scale(0.5);
    material.emissiveColor = color.scale(0.3);
    material.alpha = GHOST_ALPHA;
    material.backFaceCulling = false;
    return material;
  });

  /** One mesh per structure type per owner, like the live unit renderer. */
  const meshes: (Mesh | null)[][] = UNIT_TYPES.map((type, typeId) =>
    PLAYER_COLORS.map((_, ownerId) => {
      if (!type.isStructure) return null;
      const size = toFloat(type.radius) * 2;
      const mesh = CreateBox(
        `ghost_t${typeId}_p${ownerId}`,
        { width: size, height: size * 0.8, depth: size },
        scene,
      );
      mesh.material = materials[ownerId] as StandardMaterial;
      mesh.isPickable = false;
      mesh.thinInstanceEnablePicking = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.setEnabled(false);
      return mesh;
    }),
  );

  const buffers = new Map<Mesh, Float32Array>();
  let written = 0;

  return {
    count: () => written,

    update(match, world, overrides, localPlayer) {
      const counts = new Map<Mesh, number>();
      written = 0;
      if (localPlayer < 0) {
        for (const row of meshes) for (const mesh of row) mesh?.setEnabled(false);
        return;
      }

      const cellSize = toFloat(world.cellSize);
      for (let cell = 0; cell < world.flags.length; cell++) {
        // A remembered structure is only drawn where the player cannot
        // currently see: where they can, the live renderer draws the real one.
        if (isVisible(match.fog, localPlayer, cell)) continue;
        const remembered = rememberedStructure(match.fog, localPlayer, cell);
        if (!remembered) continue;

        const mesh = meshes[remembered.typeId]?.[remembered.ownerId];
        if (!mesh) continue;

        let data = buffers.get(mesh);
        const index = counts.get(mesh) ?? 0;
        if (!data || data.length < (index + 1) * FLOATS_PER_MATRIX) {
          const grown = new Float32Array(Math.max(16, (index + 1) * 2) * FLOATS_PER_MATRIX);
          if (data) grown.set(data);
          data = grown;
          buffers.set(mesh, data);
        }

        const x = ((cell % world.width) + 0.5) * cellSize;
        const z = (((cell / world.width) | 0) + 0.5) * cellSize;
        const y = groundHeightAt(world, overrides, x, z);
        const offset = index * FLOATS_PER_MATRIX;
        data.fill(0, offset, offset + FLOATS_PER_MATRIX);
        data[offset] = 1;
        data[offset + 5] = 1;
        data[offset + 10] = 1;
        data[offset + 12] = x;
        data[offset + 13] = y + toFloat(UNIT_TYPES[remembered.typeId]?.radius ?? 0) * 0.8;
        data[offset + 14] = z;
        data[offset + 15] = 1;
        counts.set(mesh, index + 1);
        written++;
      }

      for (const row of meshes) {
        for (const mesh of row) {
          if (!mesh) continue;
          const count = counts.get(mesh) ?? 0;
          const data = buffers.get(mesh);
          if (count === 0 || !data) {
            mesh.setEnabled(false);
            continue;
          }
          mesh.thinInstanceSetBuffer('matrix', data, FLOATS_PER_MATRIX, false);
          mesh.thinInstanceCount = count;
          mesh.setEnabled(true);
        }
      }
    },

    clear() {
      written = 0;
      for (const row of meshes) for (const mesh of row) mesh?.setEnabled(false);
    },

    dispose() {
      for (const row of meshes) for (const mesh of row) mesh?.dispose();
      for (const material of materials) material.dispose();
      buffers.clear();
    },
  };
}
