/**
 * Editor-only markers for resource nodes and start locations.
 *
 * Thin instances of two small meshes, so the whole set costs two draw calls no
 * matter how many patches a map has. They are not part of the game scene: M29
 * replaces resource patches with real art, and start locations never render
 * during a match at all.
 */
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

import type { World } from '../sim/world.ts';
import { ResourceType } from '../sim/world.ts';
import { toFloat } from '../sim/fixed.ts';
import type { HeightOverrides } from '../sim/terrain.ts';
import { cellCornerY } from './terrain.ts';

export interface Gizmos {
  visible(): boolean;
  setVisible(visible: boolean): void;
  /** Re-read the world. Cheap enough to call on every edit. */
  rebuild(overrides: HeightOverrides | null): void;
  dispose(): void;
}

function flatMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.emissiveColor = color.scale(0.45);
  material.specularColor = new Color3(0.1, 0.1, 0.1);
  return material;
}

/** Average of a cell's corner heights: the marker sits on the surface. */
function surfaceHeight(world: World, overrides: HeightOverrides | null, cell: number): number {
  const h = cellCornerY(world, cell, overrides);
  return ((h[0] as number) + (h[1] as number) + (h[2] as number) + (h[3] as number)) / 4;
}

/** How far above the surface each marker floats. */
const MINERAL_LIFT = 0.45;
const GAS_LIFT = 0.65;
const START_LIFT = 0.12;

export interface GizmoPlacements {
  readonly minerals: [number, number, number][];
  readonly gas: [number, number, number][];
  readonly starts: [number, number, number][];
}

/**
 * Where every marker goes, in world space. Separated from the Babylon plumbing
 * below so the placement itself is testable without a render.
 */
export function gizmoPlacements(world: World, overrides: HeightOverrides | null): GizmoPlacements {
  const cellSize = toFloat(world.cellSize);
  const placements: GizmoPlacements = { minerals: [], gas: [], starts: [] };

  const at = (cell: number, lift: number): [number, number, number] => [
    ((cell % world.width) + 0.5) * cellSize,
    surfaceHeight(world, overrides, cell) + lift,
    (((cell / world.width) | 0) + 0.5) * cellSize,
  ];

  for (const node of world.resourceNodes) {
    if (node.type === ResourceType.Gas) placements.gas.push(at(node.cell, GAS_LIFT));
    else placements.minerals.push(at(node.cell, MINERAL_LIFT));
  }
  for (const location of world.startLocations) {
    placements.starts.push(at(location.cell, START_LIFT));
  }
  return placements;
}

export function createGizmos(scene: Scene, getWorld: () => World): Gizmos {
  const mineralMaterial = flatMaterial(scene, 'gizmoMineral', new Color3(0.36, 0.68, 0.95));
  const gasMaterial = flatMaterial(scene, 'gizmoGas', new Color3(0.38, 0.85, 0.45));
  const startMaterial = flatMaterial(scene, 'gizmoStart', new Color3(0.98, 0.76, 0.24));

  const makeCrystal = (name: string, material: StandardMaterial, size: number): Mesh => {
    const mesh = CreateBox(name, { width: size, height: size * 1.6, depth: size }, scene);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.rotation.y = Math.PI / 4;
    mesh.bakeCurrentTransformIntoVertices();
    mesh.thinInstanceEnablePicking = false;
    mesh.setEnabled(false);
    return mesh;
  };

  const minerals = makeCrystal('gizmoMinerals', mineralMaterial, 0.55);
  const gas = makeCrystal('gizmoGas', gasMaterial, 0.8);

  const start = CreateTorus('gizmoStart', { diameter: 3.4, thickness: 0.35, tessellation: 24 }, scene);
  start.material = startMaterial;
  start.isPickable = false;
  start.thinInstanceEnablePicking = false;
  start.setEnabled(false);

  let shown = false;

  const writeInstances = (mesh: Mesh, matrices: Matrix[]): void => {
    if (matrices.length === 0) {
      mesh.thinInstanceCount = 0;
      mesh.setEnabled(false);
      return;
    }
    const buffer = new Float32Array(matrices.length * 16);
    matrices.forEach((matrix, i) => matrix.copyToArray(buffer, i * 16));
    mesh.thinInstanceSetBuffer('matrix', buffer, 16, true);
    // A static buffer does not update the count on its own.
    mesh.thinInstanceCount = matrices.length;
    mesh.setEnabled(shown);
  };

  const upright = Quaternion.Identity();
  // The torus is built in the XY plane; this lays it flat on the ground.
  const flat = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI / 2);

  const toMatrices = (
    points: readonly [number, number, number][],
    rotation: Quaternion,
  ): Matrix[] =>
    points.map((p) =>
      Matrix.Compose(Vector3.One(), rotation, new Vector3(p[0], p[1], p[2])),
    );

  const rebuild = (overrides: HeightOverrides | null): void => {
    const placements = gizmoPlacements(getWorld(), overrides);
    writeInstances(minerals, toMatrices(placements.minerals, upright));
    writeInstances(gas, toMatrices(placements.gas, upright));
    writeInstances(start, toMatrices(placements.starts, flat));
  };

  return {
    visible: () => shown,
    setVisible(visible) {
      shown = visible;
      for (const mesh of [minerals, gas, start]) {
        mesh.setEnabled(visible && mesh.thinInstanceCount > 0);
      }
    },
    rebuild,
    dispose() {
      for (const mesh of [minerals, gas, start]) mesh.dispose();
      mineralMaterial.dispose();
      gasMaterial.dispose();
      startMaterial.dispose();
    },
  };
}
