/**
 * Debug overlay colouring cells by their flags.
 *
 * One mesh of flat quads sitting just above the terrain surface, with vertex
 * colours per flag. It reuses the terrain's own corner heights so the overlay
 * follows overrides rather than floating over them, and it is rebuilt only when
 * asked, so leaving it on costs one draw call and nothing per frame.
 */
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';

import type { World } from '../sim/world.ts';
import { BUILDABLE, VISION_BLOCKER, WALKABLE } from '../sim/world.ts';
import { toFloat } from '../sim/fixed.ts';
import type { HeightOverrides } from '../sim/terrain.ts';
import { MAX_BUILD_SLOPE, MAX_TRAVERSABLE_SLOPE, cellSlope } from '../sim/terrain.ts';
import { cellCornerY } from './terrain.ts';

/** How far above the surface the overlay sits, to avoid z-fighting. */
const LIFT = 0.06;

export interface FlagLayer {
  readonly id: string;
  readonly label: string;
  /** The flag this layer highlights, or 0 when it uses `shade` instead. */
  readonly flag: number;
  readonly color: Color4;
  /** When true, cells *without* the flag are highlighted instead. */
  readonly invert?: boolean;
  /**
   * Colour for one cell, for layers that are about a measurement rather than a
   * flag. Returning null leaves the cell uncoloured.
   */
  readonly shade?: (world: World, cell: number, overrides: HeightOverrides | null) => Color4 | null;
}

export const FLAG_LAYERS: readonly FlagLayer[] = [
  { id: 'walkable', label: 'Unwalkable', flag: WALKABLE, color: new Color4(0.9, 0.25, 0.3, 0.45), invert: true },
  { id: 'buildable', label: 'Buildable', flag: BUILDABLE, color: new Color4(0.3, 0.65, 1, 0.4) },
  { id: 'blocker', label: 'Vision blocker', flag: VISION_BLOCKER, color: new Color4(0.95, 0.7, 0.2, 0.45) },
  {
    id: 'slope',
    label: 'Slope',
    flag: 0,
    color: new Color4(1, 1, 1, 0.45),
    shade: shadeBySlope,
  },
];

/**
 * Colour a cell by how steep it is.
 *
 * This replaces the old ramp overlay, and answers a question the tiered build
 * never had to ask: where exactly does ground stop being walkable? Green is
 * flat enough to build on, yellow through orange is walkable but not
 * buildable, and red is a cliff. The thresholds are the simulation's own, so
 * what this draws is what the nav grid and the placement check will do.
 */
function shadeBySlope(world: World, cell: number, overrides: HeightOverrides | null): Color4 | null {
  const slope = cellSlope(world, cell, overrides);
  if (slope >= MAX_TRAVERSABLE_SLOPE) return new Color4(0.95, 0.2, 0.2, 0.5);
  if (slope <= MAX_BUILD_SLOPE) return new Color4(0.3, 0.85, 0.4, 0.35);
  const t = (slope - MAX_BUILD_SLOPE) / (MAX_TRAVERSABLE_SLOPE - MAX_BUILD_SLOPE);
  return new Color4(0.95, 0.85 - 0.5 * t, 0.2, 0.4);
}

export interface FlagOverlay {
  /** Layer id currently shown, or null for off. */
  current(): string | null;
  show(layerId: string | null): void;
  /** Step to the next layer, wrapping back to off. */
  cycle(): string | null;
  rebuild(overrides: HeightOverrides | null): void;
  dispose(): void;
}

export function createFlagOverlay(scene: Scene, world: World): FlagOverlay {
  const material = new StandardMaterial('flagOverlay', scene);
  material.disableLighting = true;
  material.emissiveColor.set(1, 1, 1);
  material.alpha = 1; // per-vertex alpha carries the transparency
  material.backFaceCulling = false;
  material.needDepthPrePass = false;
  material.zOffset = -2;

  let mesh: Mesh | null = null;
  let activeId: string | null = null;
  let lastOverrides: HeightOverrides | null = null;

  const build = (overrides: HeightOverrides | null): void => {
    mesh?.dispose();
    mesh = null;
    const layer = FLAG_LAYERS.find((l) => l.id === activeId);
    if (!layer) return;

    const cellSize = toFloat(world.cellSize);
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (let cell = 0; cell < world.flags.length; cell++) {
      let color = layer.color;
      if (layer.shade) {
        const shaded = layer.shade(world, cell, overrides);
        if (!shaded) continue;
        color = shaded;
      } else {
        const has = ((world.flags[cell] as number) & layer.flag) !== 0;
        if (has === Boolean(layer.invert)) continue;
      }

      const cx = cell % world.width;
      const cy = (cell / world.width) | 0;
      const h = cellCornerY(world, cell, overrides);
      const x0 = cx * cellSize;
      const x1 = (cx + 1) * cellSize;
      const z0 = cy * cellSize;
      const z1 = (cy + 1) * cellSize;
      const base = positions.length / 3;

      // NW, NE, SE, SW, split NW-SE and wound exactly as the terrain's top
      // faces are. On a cell whose four corners are no longer coplanar — which
      // is now every cell — splitting the other way would crease the overlay
      // against the ground it is meant to lie on.
      positions.push(
        x0, (h[0] as number) + LIFT, z0,
        x1, (h[1] as number) + LIFT, z0,
        x1, (h[2] as number) + LIFT, z1,
        x0, (h[3] as number) + LIFT, z1,
      );
      for (let i = 0; i < 4; i++) {
        colors.push(color.r, color.g, color.b, color.a);
      }
      indices.push(base, base + 2, base + 3, base, base + 1, base + 2);
    }

    if (positions.length === 0) return;

    mesh = new Mesh('flagOverlay', scene);
    const data = new VertexData();
    data.positions = positions;
    data.colors = colors;
    data.indices = indices;
    data.applyToMesh(mesh, false);
    mesh.material = material;
    mesh.hasVertexAlpha = true;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
  };

  return {
    current: () => activeId,
    show(layerId) {
      activeId = layerId;
      build(lastOverrides);
    },
    cycle() {
      const index = FLAG_LAYERS.findIndex((l) => l.id === activeId);
      const next = FLAG_LAYERS[index + 1];
      activeId = index < 0 ? (FLAG_LAYERS[0]?.id ?? null) : (next?.id ?? null);
      build(lastOverrides);
      return activeId;
    },
    rebuild(overrides) {
      lastOverrides = overrides;
      if (activeId !== null) build(overrides);
    },
    dispose() {
      mesh?.dispose();
      mesh = null;
      material.dispose();
    },
  };
}
