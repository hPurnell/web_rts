/**
 * Map scenery: trees, rocks and civilian buildings, thin-instanced by type.
 *
 * Doodads are static. Unlike units they never move, so the instance buffers
 * are filled once when a map loads and never touched again — there is no
 * per-frame update here at all, which is what makes several hundred of them
 * affordable.
 *
 * One mesh per *type* rather than per model. A handful of types share a model
 * (`TreePalm2` and `TreePalm2short` draw the same art), so this costs a few
 * extra draw calls in exchange for the placement code never having to know
 * which names alias which.
 *
 * Like `models.ts` this knows nothing about where the art came from; the
 * Generals pipeline is one possible producer and lives outside `src/`.
 */
// Side-effect import: Babylon's tree-shaken build only defines the
// thinInstance* methods on Mesh when this module is pulled in. Without it
// nothing throws and nothing appears.
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { buildPartMesh } from './models.ts';
import type { LoadedModel } from './models.ts';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

const FLOATS_PER_MATRIX = 16;

/** Where one piece of scenery stands, in world units. */
export interface DoodadPlacement {
  readonly type: string;
  readonly x: number;
  readonly z: number;
  /** Facing, in radians, in the source map's coordinate system. */
  readonly angle: number;
}

export interface DoodadRenderer {
  /** How many pieces of scenery were placed. */
  readonly count: number;
  /** How many draw calls they cost, i.e. how many distinct types appeared. */
  readonly types: number;
  dispose(): void;
}

/**
 * Build the scenery for a map.
 *
 * Placements whose type has no model are skipped rather than substituted:
 * scenery standing in for other scenery is worse than scenery missing, since
 * a wrong tree is much harder to notice than an absent one.
 */
export function createDoodads(
  scene: Scene,
  models: ReadonlyMap<string, LoadedModel>,
  placements: readonly DoodadPlacement[],
  groundY: (x: number, z: number) => number,
): DoodadRenderer {
  const byType = new Map<string, DoodadPlacement[]>();
  for (const placement of placements) {
    if (!models.has(placement.type)) continue;
    const list = byType.get(placement.type);
    if (list) list.push(placement);
    else byType.set(placement.type, [placement]);
  }

  const meshes: Mesh[] = [];
  let count = 0;

  for (const [type, list] of byType) {
    const model = models.get(type);
    if (!model) continue;

    const mesh = buildPartMesh(scene, `doodad_${type}`, model.hull);
    const data = new Float32Array(list.length * FLOATS_PER_MATRIX);

    for (let i = 0; i < list.length; i++) {
      const placement = list[i] as DoodadPlacement;

      // The source is Z-up right-handed and the renderer is Y-up left-handed,
      // and the axis map between them reverses handedness (see the converter).
      // A rotation survives that with its sign flipped, so a doodad placed at
      // +30 degrees in the editor that made the map stands at -30 here.
      const yaw = -placement.angle;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);

      // Upright, not normal-aligned. A unit leans into a hillside because a
      // vehicle sits on its suspension; a tree grows vertically out of one,
      // and tilting it with the slope looks like it is falling over.
      const offset = i * FLOATS_PER_MATRIX;
      data[offset] = cos;
      data[offset + 2] = -sin;
      data[offset + 5] = 1;
      data[offset + 8] = sin;
      data[offset + 10] = cos;
      data[offset + 12] = placement.x;
      data[offset + 13] = groundY(placement.x, placement.z);
      data[offset + 14] = placement.z;
      data[offset + 15] = 1;
    }

    mesh.thinInstanceSetBuffer('matrix', data, FLOATS_PER_MATRIX, true);
    mesh.thinInstanceCount = list.length;
    mesh.setEnabled(true);
    meshes.push(mesh);
    count += list.length;
  }

  return {
    count,
    types: meshes.length,
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      meshes.length = 0;
    },
  };
}
