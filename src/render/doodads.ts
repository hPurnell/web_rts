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
import type { LoadedModel, LoadedPart } from './models.ts';
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

/**
 * A moving piece of scenery, baked: a matrix per frame for each part, and
 * which frames each is shown on. See `convertAnimated` in the pipeline.
 */
export interface AnimatedAsset {
  readonly frames: number;
  readonly frameRate: number;
  readonly parts: readonly {
    readonly part: LoadedPart;
    /** Sixteen floats per frame, or just sixteen for a part that never moves. */
    readonly matrices: Float32Array;
    /** 1 or 0 per frame; absent when it is always shown. */
    readonly visible?: Uint8Array;
  }[];
}

export interface DoodadRenderer {
  /** How many pieces of scenery were placed. */
  readonly count: number;
  /** How many draw calls they cost, i.e. how many distinct types appeared. */
  readonly types: number;
  /** How many of the draw calls are moving parts. */
  readonly animatedParts: number;
  /**
   * Advance the moving parts to a moment, in seconds.
   *
   * Wall-clock time, not ticks: a waving flag is scenery and reaches nothing
   * the simulation reads, so there is nothing to keep deterministic, and it
   * should look the same at any frame rate.
   */
  update(seconds: number): void;
  dispose(): void;
}

/** Babylon-layout 4x4 product: `a` applied first, then `b`. */
function multiplyInto(out: Float32Array, at: number, a: Float32Array, aAt: number, b: Float32Array, bAt: number): void {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[aAt + r * 4 + k] as number) * (b[bAt + k * 4 + c] as number);
      out[at + r * 4 + c] = sum;
    }
  }
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
  animated: ReadonlyMap<string, readonly AnimatedAsset[]> = new Map(),
  /** Types whose still hull is replaced by an animated one, and not drawn. */
  hullAnimated: ReadonlySet<string> = new Set(),
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

  /** Moving parts, rewritten every frame. */
  const moving: {
    mesh: Mesh;
    asset: AnimatedAsset;
    matrices: Float32Array;
    visible?: Uint8Array;
    placements: Float32Array;
    phases: Float32Array;
    data: Float32Array;
  }[] = [];

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

    count += list.length;
    if (hullAnimated.has(type)) {
      // The placements are still needed — the moving parts ride on them — but
      // the still hull is not: its animated version stands in its place.
      mesh.dispose();
    } else {
      mesh.thinInstanceSetBuffer('matrix', data, FLOATS_PER_MATRIX, true);
      mesh.thinInstanceCount = list.length;
      mesh.setEnabled(true);
      meshes.push(mesh);
    }

    // The moving pieces riding on this type share its placements. Each
    // instance starts at its own point in the loop, so forty derricks' flags
    // do not wave in step like one machine.
    const phases = new Float32Array(list.length);
    for (let i = 0; i < list.length; i++) phases[i] = (i * 0.6180339887) % 1;
    for (const asset of animated.get(type) ?? []) {
      for (let p = 0; p < asset.parts.length; p++) {
        const part = asset.parts[p] as AnimatedAsset['parts'][number];
        const partMesh = buildPartMesh(scene, `doodad_${type}_moving${p}`, part.part);
        const partData = new Float32Array(list.length * FLOATS_PER_MATRIX);
        // A dynamic buffer: rewritten every frame, so tell the engine so.
        partMesh.thinInstanceSetBuffer('matrix', partData, FLOATS_PER_MATRIX, false);
        partMesh.thinInstanceCount = list.length;
        partMesh.setEnabled(true);
        meshes.push(partMesh);
        moving.push({
          mesh: partMesh,
          asset,
          matrices: part.matrices,
          ...(part.visible ? { visible: part.visible } : {}),
          placements: data,
          phases,
          data: partData,
        });
      }
    }
  }

  const update = (seconds: number): void => {
    for (const piece of moving) {
      const { asset, matrices, visible, placements: placed, phases, data } = piece;
      const loop = asset.frames / asset.frameRate;
      const instances = placed.length / FLOATS_PER_MATRIX;
      const still = matrices.length === FLOATS_PER_MATRIX;
      for (let i = 0; i < instances; i++) {
        const at = i * FLOATS_PER_MATRIX;
        // Stepped, not interpolated, which is how the source plays them:
        // HTreeClass has a raw-animation path "for use by Generals" that
        // skips the blend between frames.
        const t = seconds + (phases[i] as number) * loop;
        const frame = Math.floor(t * asset.frameRate) % asset.frames;
        if (visible && visible[frame] === 0) {
          data.fill(0, at, at + FLOATS_PER_MATRIX); // a zero matrix draws nothing
          continue;
        }
        multiplyInto(data, at, matrices, still ? 0 : frame * FLOATS_PER_MATRIX, placed, at);
      }
      piece.mesh.thinInstanceBufferUpdated('matrix');
    }
  };
  update(0);

  return {
    count,
    types: meshes.length - moving.length,
    animatedParts: moving.length,
    update,
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      meshes.length = 0;
    },
  };
}
