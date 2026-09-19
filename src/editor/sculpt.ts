/**
 * Sculpting maths. Pure functions over world state, so the rules are testable
 * without a pointer, a canvas or a mesh.
 *
 * This replaces tier painting, and it is a different shape of problem. Tier
 * painting wrote a small integer per cell and had to repair the illegal
 * configurations that produced. Sculpting moves *corner heights*, continuously,
 * and there is no such thing as an illegal heightfield — only ground that
 * turns out to be too steep to walk on, which the slope rules work out for
 * themselves and the editor's slope overlay shows you.
 */
import type { Fixed } from '../sim/fixed.ts';
import { ONE, abs, add, div, fromInt, mul, sqrt, sub } from '../sim/fixed.ts';
import type { World } from '../sim/world.ts';
import { HEIGHT_MAX, HEIGHT_MIN, cornerStride } from '../sim/terrain.ts';
import type { TerrainEditCommand } from './commands.ts';

export const MIN_BRUSH_RADIUS = 1;
export const MAX_BRUSH_RADIUS = 24;

/** How much a raise or lower stroke moves the ground per sample, in units. */
export const SCULPT_RATE: Fixed = 13107; // 0.2
/** How hard one smooth sample pulls a corner toward its neighbours. */
const SMOOTH_RATE: Fixed = 19661; // 0.3
/** How hard one flatten sample pulls a corner toward the reference height. */
const FLATTEN_RATE: Fixed = 19661; // 0.3

export type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten' | 'ramp' | 'noise';

/** A corner and how strongly the brush covers it, 0..ONE. */
export interface BrushSample {
  readonly corner: number;
  readonly weight: Fixed;
}

/**
 * Corners under the brush, with a smooth falloff.
 *
 * The falloff is what separates sculpting from painting: a hard-edged brush
 * produces terraces, which is the look this whole terrain model exists to get
 * away from. Weight goes 1 at the centre to 0 at the rim, on a smoothstep.
 */
export function brushCorners(world: World, centreCorner: number, radius: number): BrushSample[] {
  const stride = cornerStride(world);
  const rows = world.height + 1;
  if (centreCorner < 0 || centreCorner >= stride * rows) return [];

  const r = Math.max(MIN_BRUSH_RADIUS, Math.min(MAX_BRUSH_RADIUS, Math.floor(radius)));
  const cx = centreCorner % stride;
  const cz = (centreCorner / stride) | 0;
  const samples: BrushSample[] = [];

  for (let z = cz - r; z <= cz + r; z++) {
    if (z < 0 || z >= rows) continue;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= stride) continue;
      const dx = x - cx;
      const dz = z - cz;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > r * r) continue;

      // t = 1 - distance / r, then smoothstepped: t * t * (3 - 2t).
      // sqrt, not isqrt: `sqrt` takes and returns Q16.16, which is what the
      // division below needs. `isqrt` would return a Q8.8 value here and the
      // falloff would collapse to a hard-edged disc.
      const distance = sqrt(fromInt(distanceSq));
      const t = sub(ONE, div(distance, fromInt(r)));
      const clamped = t < 0 ? 0 : t > ONE ? ONE : t;
      const weight = mul(mul(clamped, clamped), sub(fromInt(3), mul(fromInt(2), clamped)));
      samples.push({ corner: z * stride + x, weight });
    }
  }
  return samples;
}

/** Clamp a height into the sculptable range. */
function clampHeight(height: Fixed): Fixed {
  return height < HEIGHT_MIN ? HEIGHT_MIN : height > HEIGHT_MAX ? HEIGHT_MAX : height;
}

export interface SculptOptions {
  readonly mode: SculptMode;
  /** Height the stroke sampled when it began, for flatten. */
  readonly reference?: Fixed;
  /** Scales every sample; the session passes the brush strength. */
  readonly strength?: Fixed;
  /** Seed for the noise mode, so a stroke is reproducible. */
  readonly seed?: number;
}

/**
 * Stage a sculpt into a command.
 *
 * Returns how many corners actually moved, so a stroke that changed nothing
 * leaves no undo entry.
 */
export function stageSculpt(
  world: World,
  command: TerrainEditCommand,
  samples: readonly BrushSample[],
  options: SculptOptions,
): number {
  const strength = options.strength ?? ONE;
  let changed = 0;

  for (const sample of samples) {
    // What this command has already staged for the corner, falling back to
    // the world. A drag stages many samples before anything is applied, and a
    // ramp drag crosses the same corner from several steps along it.
    const current = command.stagedHeight(sample.corner) ?? (world.heights[sample.corner] as number);
    const amount = mul(sample.weight, strength);
    let next = current;

    switch (options.mode) {
      case 'raise':
        next = add(current, mul(amount, SCULPT_RATE));
        break;
      case 'lower':
        next = sub(current, mul(amount, SCULPT_RATE));
        break;
      case 'smooth':
        next = add(current, mul(mul(amount, SMOOTH_RATE), sub(neighbourAverage(world, sample.corner), current)));
        break;
      case 'flatten':
        next = add(
          current,
          mul(mul(amount, FLATTEN_RATE), sub(options.reference ?? current, current)),
        );
        break;
      case 'ramp':
        // The session computes the target per corner and passes it as the
        // reference; here a ramp is just a hard pull toward it.
        next = add(current, mul(amount, sub(options.reference ?? current, current)));
        break;
      case 'noise':
        next = add(current, mul(amount, valueNoise(sample.corner, options.seed ?? 0)));
        break;
    }

    next = clampHeight(next);
    if (next === current) continue;
    command.recordCorner(world, sample.corner, next);
    changed++;
  }
  return changed;
}

/** Mean height of a corner's four orthogonal neighbours, clamped at the edges. */
function neighbourAverage(world: World, corner: number): Fixed {
  const stride = cornerStride(world);
  const rows = world.height + 1;
  const cx = corner % stride;
  const cz = (corner / stride) | 0;

  const at = (x: number, z: number): Fixed => {
    const clampedX = x < 0 ? 0 : x >= stride ? stride - 1 : x;
    const clampedZ = z < 0 ? 0 : z >= rows ? rows - 1 : z;
    return world.heights[clampedZ * stride + clampedX] as number;
  };

  const sum = at(cx - 1, cz) + at(cx + 1, cz) + at(cx, cz - 1) + at(cx, cz + 1);
  return ((sum / 4) | 0) as Fixed;
}

/**
 * Deterministic value noise for one corner.
 *
 * Hashed from the corner index and the seed rather than drawn from the PRNG,
 * so a stroke produces the same terrain whatever order its samples arrive in —
 * which matters because a sculpt stroke is replayed by undo and redo.
 */
function valueNoise(corner: number, seed: number): Fixed {
  let h = (corner ^ Math.imul(seed, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  // Map to roughly -0.5 .. +0.5 world units.
  return sub((h & 0xffff) as Fixed, ONE >> 1) >> 1;
}

/** Height a ramp stroke wants at a corner, given the drag's two ends. */
export function rampTarget(
  world: World,
  corner: number,
  fromCorner: number,
  toCorner: number,
  fromHeight: Fixed,
  toHeight: Fixed,
): Fixed {
  const stride = cornerStride(world);
  const ax = fromCorner % stride;
  const az = (fromCorner / stride) | 0;
  const bx = toCorner % stride;
  const bz = (toCorner / stride) | 0;
  const px = corner % stride;
  const pz = (corner / stride) | 0;

  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz;
  if (lengthSq === 0) return fromHeight;

  // Projection of the corner onto the drag, clamped to its ends.
  const dot = (px - ax) * abx + (pz - az) * abz;
  const t = Math.max(0, Math.min(ONE, div(fromInt(dot), fromInt(lengthSq))));
  return add(fromHeight, mul(t, sub(toHeight, fromHeight)));
}

/** Stage a flag edit (set or clear a bit) across a brush's cells. */
export function stageFlagEdit(
  world: World,
  command: TerrainEditCommand,
  cells: readonly number[],
  flag: number,
  set: boolean,
): number {
  let changed = 0;
  for (const cell of cells) {
    const current = world.flags[cell] as number;
    const next = set ? current | flag : current & ~flag;
    if (next === current) continue;
    command.recordFlags(world, cell, next);
    changed++;
  }
  return changed;
}

/** Cells under a brush centred on a cell, as a disc. */
export function brushCells(world: World, centre: number, radius: number): number[] {
  if (centre < 0 || centre >= world.flags.length) return [];
  const cx = centre % world.width;
  const cz = (centre / world.width) | 0;
  const r = Math.max(0, Math.min(MAX_BRUSH_RADIUS, Math.floor(radius)));
  const cells: number[] = [];
  const limit = r * r + r; // a disc, with half a cell of slack
  for (let z = cz - r; z <= cz + r; z++) {
    if (z < 0 || z >= world.height) continue;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= world.width) continue;
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz > limit) continue;
      cells.push(z * world.width + x);
    }
  }
  return cells;
}

/** Cells whose slope makes them cliffs, for the editor's slope overlay. */
export function describeSlope(slope: Fixed, limit: Fixed): 'flat' | 'steep' | 'cliff' {
  if (slope > limit) return 'cliff';
  // Within a quarter of the limit of being unwalkable is worth flagging.
  if (mul(slope, fromInt(4)) > mul(limit, fromInt(3))) return 'steep';
  return 'flat';
}

/** Absolute difference, for tests and for reporting. */
export function heightDelta(a: Fixed, b: Fixed): Fixed {
  return abs(sub(a, b));
}
