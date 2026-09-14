/**
 * Unit rendering.
 *
 * One thin-instance buffer per unit type per part, so 2,000 units cost a
 * handful of draw calls rather than 2,000. Hull and turret are separate
 * buffers because the turret tracks its target independently of where the hull
 * is pointing — that is also why there is no skinning anywhere: every unit is
 * rigid parts, which M28 formalises as the asset convention.
 *
 * Positions are interpolated between the last two simulation ticks. At 20Hz a
 * unit moves a visible distance per tick, so without interpolation movement
 * reads as stepping rather than walking.
 */
// Side-effect import: Babylon's tree-shaken build only installs the
// thinInstance* methods on Mesh when this module is pulled in. Without it the
// meshes render nothing and say nothing about why.
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

import type { Match } from '../sim/match.ts';
import type { World } from '../sim/world.ts';
import { cellFromWorld } from '../sim/world.ts';
import { isVisible } from '../sim/fog.ts';
import { UNIT_TYPES } from '../sim/unittypes.ts';
import { toFloat } from '../sim/fixed.ts';
import type { RampSlopes } from './terrain.ts';
import { cornerHeights } from './terrain.ts';

/** Player colours, indexed by owner id. */
export const PLAYER_COLORS: readonly Color3[] = [
  new Color3(0.29, 0.56, 0.93),
  new Color3(0.91, 0.35, 0.31),
  new Color3(0.35, 0.78, 0.45),
  new Color3(0.85, 0.66, 0.24),
  new Color3(0.66, 0.42, 0.86),
  new Color3(0.31, 0.76, 0.8),
  new Color3(0.93, 0.53, 0.27),
  new Color3(0.8, 0.8, 0.85),
];

/** Placeholder proportions, replaced wholesale in M29. */
interface PartShape {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly lift: number;
}

function hullShape(radius: number, footprint = 0): PartShape {
  if (footprint > 0) {
    // A structure fills its footprint and stands tall enough to read as a
    // building rather than a very large tank.
    const side = footprint * 0.85;
    const height = footprint * 0.8;
    return { width: side, height, depth: side, lift: height / 2 };
  }
  const size = radius * 2;
  return { width: size, height: size * 0.7, depth: size * 1.25, lift: size * 0.35 };
}

function turretShape(radius: number): PartShape {
  const size = radius * 1.1;
  return { width: size, height: size * 0.55, depth: size * 1.15, lift: radius * 1.05 };
}

interface InstanceGroup {
  readonly hull: Mesh;
  /** Null for types whose weapon does not rotate, such as workers. */
  readonly turret: Mesh | null;
  /** Scratch buffers, grown on demand and reused between frames. */
  hullData: Float32Array;
  turretData: Float32Array;
  /** Per-instance RGBA, so one mesh serves every player. */
  colorData: Float32Array;
  count: number;
}

export interface UnitRenderer {
  /**
   * Write instance matrices for the current frame.
   * `alpha` is the driver's interpolation factor, 0..1.
   * `localPlayer` decides what fog hides; pass -1 to see everything.
   */
  update(
    match: Match,
    world: World,
    ramps: RampSlopes,
    alpha: number,
    localPlayer?: number,
  ): void;
  /** Remember this tick's positions as the basis for interpolation. */
  captureTick(match: Match): void;
  /** Live instances written by the last update, for the dev overlay. */
  instanceCount(): number;
  /** Hide everything, e.g. when a match ends. */
  clear(): void;
  dispose(): void;
}

const FLOATS_PER_MATRIX = 16;

function makePart(
  scene: Scene,
  name: string,
  shape: PartShape,
  material: StandardMaterial,
): Mesh {
  const mesh = CreateBox(
    name,
    { width: shape.width, height: shape.height, depth: shape.depth },
    scene,
  );
  mesh.material = material;
  mesh.isPickable = false;
  mesh.thinInstanceEnablePicking = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.setEnabled(false);
  return mesh;
}

export function createUnitRenderer(scene: Scene): UnitRenderer {
  // One material for every unit. Player colour rides on a per-instance colour
  // buffer instead of a material per player, so the draw-call count depends on
  // how many unit *types* are on screen and not on how many players are in the
  // match — six types across eight players is eight draws, not forty-eight.
  const material = new StandardMaterial('unit', scene);
  material.diffuseColor = new Color3(1, 1, 1);
  material.emissiveColor = new Color3(0.22, 0.22, 0.22);
  material.specularColor = new Color3(0.15, 0.15, 0.16);

  /** One group per unit type; owner is a per-instance colour. */
  const groups: InstanceGroup[] = UNIT_TYPES.map((type, typeId) => {
    const radius = toFloat(type.radius);
    return {
      hull: makePart(scene, `hull_t${typeId}`, hullShape(radius, type.footprint), material),
      turret: type.hasTurret
        ? makePart(scene, `turret_t${typeId}`, turretShape(radius), material)
        : null,
      hullData: new Float32Array(0),
      turretData: new Float32Array(0),
      colorData: new Float32Array(0),
      count: 0,
    };
  });

  // Previous-tick positions, so a frame can interpolate rather than snap.
  let prevX = new Int32Array(0);
  let prevZ = new Int32Array(0);
  let prevFacing = new Int32Array(0);
  let prevTick = -1;
  let written = 0;

  const ensure = (group: InstanceGroup, needed: number): void => {
    const floats = needed * FLOATS_PER_MATRIX;
    if (group.hullData.length >= floats) return;
    // Grow in powers of two so a steadily rising army does not reallocate
    // every single frame.
    let size = Math.max(16, group.hullData.length / FLOATS_PER_MATRIX || 16);
    while (size < needed) size *= 2;
    group.hullData = new Float32Array(size * FLOATS_PER_MATRIX);
    group.turretData = new Float32Array(size * FLOATS_PER_MATRIX);
    group.colorData = new Float32Array(size * 4);
  };

  /**
   * Write a translation-plus-Y-rotation matrix directly.
   *
   * Composing a Matrix per unit per frame allocates and costs more than the
   * arithmetic does; a unit only ever yaws, so eight of the sixteen entries
   * are constant.
   */
  const writeMatrix = (
    out: Float32Array,
    offset: number,
    x: number,
    y: number,
    z: number,
    sin: number,
    cos: number,
  ): void => {
    out[offset] = cos;
    out[offset + 1] = 0;
    out[offset + 2] = -sin;
    out[offset + 3] = 0;
    out[offset + 4] = 0;
    out[offset + 5] = 1;
    out[offset + 6] = 0;
    out[offset + 7] = 0;
    out[offset + 8] = sin;
    out[offset + 9] = 0;
    out[offset + 10] = cos;
    out[offset + 11] = 0;
    out[offset + 12] = x;
    out[offset + 13] = y;
    out[offset + 14] = z;
    out[offset + 15] = 1;
  };

  return {
    captureTick(match) {
      const units = match.units;
      if (prevX.length < units.count) {
        prevX = new Int32Array(units.posX.length);
        prevZ = new Int32Array(units.posZ.length);
        prevFacing = new Int32Array(units.facing.length);
      }
      prevX.set(units.posX);
      prevZ.set(units.posZ);
      prevFacing.set(units.facing);
      prevTick = match.tick;
    },

    instanceCount: () => written,

    update(match, world, ramps, alpha, localPlayer = -1) {
      const units = match.units;
      // Before the first captured tick there is nothing to interpolate from.
      const blend = prevTick >= 0 ? Math.max(0, Math.min(1, alpha)) : 1;

      for (const group of groups) group.count = 0;

      const hidden = (index: number): boolean => {
        if (localPlayer < 0) return false;
        if (units.ownerId[index] === localPlayer) return false;
        const cell = cellFromWorld(
          world,
          units.posX[index] as number,
          units.posZ[index] as number,
        );
        // An enemy unit exists only where you can currently see it. Explored
        // ground is not enough: that is what makes scouting matter.
        return !isVisible(match.fog, localPlayer, cell);
      };

      for (let i = 0; i < units.count; i++) {
        if (units.isAlive[i] !== 1) continue;
        if (hidden(i)) continue;
        const group = groups[units.typeId[i] as number];
        if (!group) continue;
        group.count++;
      }

      for (const group of groups) {
        if (group.count > 0) ensure(group, group.count);
        group.count = 0;
      }

      written = 0;
      for (let i = 0; i < units.count; i++) {
        if (units.isAlive[i] !== 1) continue;
        if (hidden(i)) continue;
        const group = groups[units.typeId[i] as number];
        if (!group) continue;

        const nowX = toFloat(units.posX[i] as number);
        const nowZ = toFloat(units.posZ[i] as number);
        const fromX = prevTick >= 0 ? toFloat(prevX[i] as number) : nowX;
        const fromZ = prevTick >= 0 ? toFloat(prevZ[i] as number) : nowZ;
        const x = fromX + (nowX - fromX) * blend;
        const z = fromZ + (nowZ - fromZ) * blend;

        const nowFacing = toFloat(units.facing[i] as number);
        const fromFacing = prevTick >= 0 ? toFloat(prevFacing[i] as number) : nowFacing;
        // Interpolate the short way round, or a unit crossing the wrap point
        // spins the long way once per lap.
        let delta = nowFacing - fromFacing;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const facing = fromFacing + delta * blend;
        const sin = Math.sin(facing);
        const cos = Math.cos(facing);

        const y = groundHeightAt(world, ramps, x, z);
        const offset = group.count * FLOATS_PER_MATRIX;
        const unitKind = UNIT_TYPES[units.typeId[i] as number];
        const radius = toFloat(unitKind?.radius ?? 0);
        const lift = hullShape(radius, unitKind?.footprint ?? 0).lift;
        writeMatrix(group.hullData, offset, x, y + lift, z, sin, cos);
        if (group.turret) {
          writeMatrix(group.turretData, offset, x, y + turretShape(radius).lift, z, sin, cos);
        }

        const color = PLAYER_COLORS[units.ownerId[i] as number] ?? PLAYER_COLORS[0];
        const colorOffset = group.count * 4;
        group.colorData[colorOffset] = color?.r ?? 1;
        group.colorData[colorOffset + 1] = color?.g ?? 1;
        group.colorData[colorOffset + 2] = color?.b ?? 1;
        group.colorData[colorOffset + 3] = 1;

        group.count++;
        written++;
      }

      for (const group of groups) {
        if (group.count === 0) {
          group.hull.setEnabled(false);
          group.turret?.setEnabled(false);
          continue;
        }
        group.hull.thinInstanceSetBuffer('matrix', group.hullData, FLOATS_PER_MATRIX, false);
        group.hull.thinInstanceSetBuffer('color', group.colorData, 4, false);
        group.hull.thinInstanceCount = group.count;
        group.hull.setEnabled(true);
        if (group.turret) {
          group.turret.thinInstanceSetBuffer('matrix', group.turretData, FLOATS_PER_MATRIX, false);
          group.turret.thinInstanceSetBuffer('color', group.colorData, 4, false);
          group.turret.thinInstanceCount = group.count;
          group.turret.setEnabled(true);
        }
      }
    },

    clear() {
      written = 0;
      prevTick = -1;
      for (const group of groups) {
        group.count = 0;
        group.hull.setEnabled(false);
        group.turret?.setEnabled(false);
      }
    },

    dispose() {
      for (const group of groups) {
        group.hull.dispose();
        group.turret?.dispose();
      }
      material.dispose();
    },
  };
}

/** Terrain height under a world-space point, following ramp slopes. */
export function groundHeightAt(world: World, ramps: RampSlopes, x: number, z: number): number {
  const cellSize = toFloat(world.cellSize);
  const cell = cellFromWorld(world, Math.round(x * 65536), Math.round(z * 65536));
  if (cell < 0) return 0;
  const h = cornerHeights(world, ramps, cell);
  // Bilinear across the cell, so a unit walking a ramp rises smoothly rather
  // than stepping at each cell boundary.
  const fx = x / cellSize - Math.floor(x / cellSize);
  const fz = z / cellSize - Math.floor(z / cellSize);
  const north = (h[0] as number) + ((h[1] as number) - (h[0] as number)) * fx;
  const south = (h[3] as number) + ((h[2] as number) - (h[3] as number)) * fx;
  return north + (south - north) * fz;
}
