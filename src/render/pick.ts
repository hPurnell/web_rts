/**
 * Terrain picking.
 *
 * The tiered version intersected a handful of flat planes, one per tier. A
 * heightfield has no planes to intersect, so the ray is marched across the
 * grid with a DDA and the two triangles of each cell it crosses are tested in
 * order. The first hit wins and the march stops.
 *
 * The terrain mesh is still never raycast. A DDA visits a few dozen cells for
 * a screen-centre ray and is bounded by the map size at its worst, where mesh
 * picking pays for a full acceleration-structure traversal over a few hundred
 * thousand triangles — every frame the pointer moves.
 */
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { Scene } from '@babylonjs/core/scene';
// Side-effect import: Babylon's tree-shaken build only installs
// Scene.createPickingRay when the Ray module is pulled in.
import '@babylonjs/core/Culling/ray';
import type { Ray } from '@babylonjs/core/Culling/ray';

import type { World } from '../sim/world.ts';
import type { HeightOverrides } from '../sim/terrain.ts';
import { HEIGHT_MAX, HEIGHT_MIN, cellSlope, cornerHeight, cornerStride } from '../sim/terrain.ts';
import { toFloat } from '../sim/fixed.ts';

export interface PickResult {
  readonly cell: number;
  readonly cx: number;
  readonly cy: number;
  /** Terrain height at the hit, in world units. */
  readonly height: number;
  /** The cell's slope, rise over run. */
  readonly slope: number;
  readonly flags: number;
  /** Exact world-space point on the terrain surface. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PickRay {
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
}

export function rayFromBabylon(ray: Ray): PickRay {
  return {
    originX: ray.origin.x,
    originY: ray.origin.y,
    originZ: ray.origin.z,
    dirX: ray.direction.x,
    dirY: ray.direction.y,
    dirZ: ray.direction.z,
  };
}

/** Camera ray through a screen position, in CSS pixels relative to the canvas. */
export function screenRay(scene: Scene, camera: Camera, screenX: number, screenY: number): PickRay {
  return rayFromBabylon(scene.createPickingRay(screenX, screenY, Matrix.Identity(), camera));
}

/**
 * Nearest terrain cell under a ray, or null if the ray misses the map.
 *
 * `out.cells` reports how many cells the march visited, which is the number
 * that matters: it must stay small and independent of how detailed the terrain
 * is, or picking becomes a per-frame cost that grows with the map.
 */
export function pickCell(
  world: World,
  ray: PickRay,
  out?: { cells: number },
  overrides?: HeightOverrides | null,
): PickResult | null {
  const cellSize = toFloat(world.cellSize);
  const stride = cornerStride(world);
  if (out) out.cells = 0;

  // Clip the ray to the slab the terrain can occupy, so a ray aimed at the
  // horizon does not march the whole map before finding nothing.
  const lowest = toFloat(HEIGHT_MIN) - 8;
  const highest = toFloat(HEIGHT_MAX) + 8;
  let tEnter = 0;
  let tExit = Number.POSITIVE_INFINITY;
  if (Math.abs(ray.dirY) > 1e-9) {
    const t0 = (highest - ray.originY) / ray.dirY;
    const t1 = (lowest - ray.originY) / ray.dirY;
    tEnter = Math.max(tEnter, Math.min(t0, t1));
    tExit = Math.min(tExit, Math.max(t0, t1));
  } else if (ray.originY > highest || ray.originY < lowest) {
    return null;
  }
  if (tExit < tEnter) return null;

  let x = ray.originX + ray.dirX * tEnter;
  let z = ray.originZ + ray.dirZ * tEnter;

  let cx = Math.floor(x / cellSize);
  let cz = Math.floor(z / cellSize);

  const stepX = ray.dirX > 0 ? 1 : ray.dirX < 0 ? -1 : 0;
  const stepZ = ray.dirZ > 0 ? 1 : ray.dirZ < 0 ? -1 : 0;

  // Parametric distance to the next cell boundary on each axis, and between
  // boundaries — the standard grid DDA.
  const invDirX = ray.dirX !== 0 ? 1 / ray.dirX : Number.POSITIVE_INFINITY;
  const invDirZ = ray.dirZ !== 0 ? 1 / ray.dirZ : Number.POSITIVE_INFINITY;
  const deltaX = Math.abs(cellSize * invDirX);
  const deltaZ = Math.abs(cellSize * invDirZ);

  const boundaryX = (cx + (stepX > 0 ? 1 : 0)) * cellSize;
  const boundaryZ = (cz + (stepZ > 0 ? 1 : 0)) * cellSize;
  let nextX = stepX === 0 ? Number.POSITIVE_INFINITY : tEnter + (boundaryX - x) * invDirX;
  let nextZ = stepZ === 0 ? Number.POSITIVE_INFINITY : tEnter + (boundaryZ - z) * invDirZ;

  const limit = world.width + world.height + 2;
  for (let visited = 0; visited < limit; visited++) {
    if (out) out.cells = visited + 1;

    if (cx >= 0 && cz >= 0 && cx < world.width && cz < world.height) {
      const hit = hitCell(world, ray, cx, cz, stride, cellSize, overrides);
      if (hit) {
        const cell = cz * world.width + cx;
        return {
          cell,
          cx,
          cy: cz,
          height: hit.y,
          slope: toFloat(cellSlope(world, cell, overrides)),
          flags: world.flags[cell] as number,
          x: hit.x,
          y: hit.y,
          z: hit.z,
        };
      }
    } else if (visited > 0 && outsideForGood(cx, cz, stepX, stepZ, world)) {
      return null;
    }

    if (nextX < nextZ) {
      if (nextX > tExit) return null;
      cx += stepX;
      x = ray.originX + ray.dirX * nextX;
      nextX += deltaX;
    } else {
      if (nextZ > tExit) return null;
      cz += stepZ;
      z = ray.originZ + ray.dirZ * nextZ;
      nextZ += deltaZ;
    }
    if (stepX === 0 && stepZ === 0) return null;
  }
  return null;
}

/** True once the march has left the map and is heading further away. */
function outsideForGood(
  cx: number,
  cz: number,
  stepX: number,
  stepZ: number,
  world: World,
): boolean {
  if (cx < 0 && stepX <= 0) return true;
  if (cz < 0 && stepZ <= 0) return true;
  if (cx >= world.width && stepX >= 0) return true;
  if (cz >= world.height && stepZ >= 0) return true;
  return false;
}

type Point = readonly [number, number, number];

/** Test a ray against one cell's two triangles, nearest hit first. */
function hitCell(
  world: World,
  ray: PickRay,
  cx: number,
  cz: number,
  stride: number,
  cellSize: number,
  overrides?: HeightOverrides | null,
): { x: number; y: number; z: number } | null {
  const top = cz * stride + cx;
  const nw: Point = [cx * cellSize, toFloat(cornerHeight(world, top, overrides)), cz * cellSize];
  const ne: Point = [(cx + 1) * cellSize, toFloat(cornerHeight(world, top + 1, overrides)), cz * cellSize];
  const se: Point = [
    (cx + 1) * cellSize,
    toFloat(cornerHeight(world, top + stride + 1, overrides)),
    (cz + 1) * cellSize,
  ];
  const sw: Point = [cx * cellSize, toFloat(cornerHeight(world, top + stride, overrides)), (cz + 1) * cellSize];

  let best = Number.POSITIVE_INFINITY;
  // The same NW-SE split heightAt uses, wound the same way as the mesh.
  for (const tri of [
    [sw, se, nw],
    [se, ne, nw],
  ] as const) {
    const s = rayTriangle(ray, tri[0], tri[1], tri[2]);
    if (s === null || s >= best) continue;
    best = s;
  }
  if (!Number.isFinite(best)) return null;
  return {
    x: ray.originX + ray.dirX * best,
    y: ray.originY + ray.dirY * best,
    z: ray.originZ + ray.dirZ * best,
  };
}

/** Human-readable flag list, for the dev overlay. */
export function describeFlags(flags: number): string {
  const names: string[] = [];
  if (flags & 1) names.push('walk');
  if (flags & 2) names.push('build');
  if (flags & 8) names.push('blocker');
  return names.length > 0 ? names.join('+') : 'none';
}

/** Exposed so the picker can be exercised without a Babylon camera. */
export function makeRay(origin: Vector3, direction: Vector3): PickRay {
  const d = direction.normalizeToNew();
  return {
    originX: origin.x,
    originY: origin.y,
    originZ: origin.z,
    dirX: d.x,
    dirY: d.y,
    dirZ: d.z,
  };
}

/** Moller-Trumbore, double-sided. Returns the ray parameter, or null. */
function rayTriangle(ray: PickRay, a: Point, b: Point, c: Point): number | null {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];

  const px = ray.dirY * e2z - ray.dirZ * e2y;
  const py = ray.dirZ * e2x - ray.dirX * e2z;
  const pz = ray.dirX * e2y - ray.dirY * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;

  const tx = ray.originX - a[0];
  const ty = ray.originY - a[1];
  const tz = ray.originZ - a[2];

  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -1e-6 || u > 1 + 1e-6) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (ray.dirX * qx + ray.dirY * qy + ray.dirZ * qz) * invDet;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;

  const s = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return s > 1e-6 ? s : null;
}
