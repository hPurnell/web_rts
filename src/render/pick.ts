/**
 * Cell picking.
 *
 * The terrain mesh is never raycast: with thousands of triangles per chunk and
 * a pointer that moves every frame, that cost shows up immediately. Instead the
 * camera ray is intersected with each tier's horizontal plane analytically,
 * which narrows the answer to a handful of candidate cells, and those few cells
 * are then tested exactly against their own quads — which is also what makes
 * sloped ramp surfaces pick correctly rather than snapping to a tier plane.
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
import { MAX_TIER, cellIndex } from '../sim/world.ts';
import { toFloat } from '../sim/fixed.ts';
import type { RampSlopes } from './terrain.ts';
import { cornerHeights, tierHeight } from './terrain.ts';

export interface PickResult {
  readonly cell: number;
  readonly cx: number;
  readonly cy: number;
  readonly tier: number;
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
 */
export function pickCell(
  world: World,
  ramps: RampSlopes,
  ray: PickRay,
  out?: { candidates: number },
): PickResult | null {
  const cellSize = toFloat(world.cellSize);
  const candidates = new Set<number>();

  // Each tier plane the ray crosses contributes a candidate cell and its
  // neighbours; the neighbours matter because a ramp surface sits *between*
  // planes, so the plane hit lands just past the ramp cell itself.
  for (let tier = MAX_TIER; tier >= 0; tier--) {
    const planeY = tierHeight(tier);
    if (Math.abs(ray.dirY) < 1e-9) continue;
    const s = (planeY - ray.originY) / ray.dirY;
    if (s <= 0) continue;
    const px = ray.originX + ray.dirX * s;
    const pz = ray.originZ + ray.dirZ * s;
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(pz / cellSize);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cell = cellIndex(world, cx + ox, cy + oy);
        if (cell >= 0) candidates.add(cell);
      }
    }
  }

  if (out) out.candidates = candidates.size;
  if (candidates.size === 0) return null;

  let bestDistance = Infinity;
  let best: PickResult | null = null;

  for (const cell of candidates) {
    const cx = cell % world.width;
    const cy = (cell / world.width) | 0;
    const h = cornerHeights(world, ramps, cell);
    const x0 = cx * cellSize;
    const x1 = (cx + 1) * cellSize;
    const z0 = cy * cellSize;
    const z1 = (cy + 1) * cellSize;

    // Same two triangles the mesh builds, in the same winding.
    const sw: Point = [x0, h[3], z1];
    const se: Point = [x1, h[2], z1];
    const ne: Point = [x1, h[1], z0];
    const nw: Point = [x0, h[0], z0];

    for (const tri of [
      [sw, ne, se],
      [sw, nw, ne],
    ] as const) {
      const s = rayTriangle(ray, tri[0], tri[1], tri[2]);
      if (s === null || s >= bestDistance) continue;
      bestDistance = s;
      best = {
        cell,
        cx,
        cy,
        tier: world.tier[cell] as number,
        flags: world.flags[cell] as number,
        x: ray.originX + ray.dirX * s,
        y: ray.originY + ray.dirY * s,
        z: ray.originZ + ray.dirZ * s,
      };
    }
  }

  return best;
}

type Point = readonly [number, number, number];

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

/** Human-readable flag list, for the dev overlay. */
export function describeFlags(flags: number): string {
  const names: string[] = [];
  if (flags & 1) names.push('walk');
  if (flags & 2) names.push('build');
  if (flags & 4) names.push('ramp');
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
