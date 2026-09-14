/**
 * Fixed-point trigonometry. Table-driven with linear interpolation between
 * entries — no Math.sin anywhere in the simulation (invariant 2).
 *
 * Angles are Q16.16 radians. Positive rotation goes from +X toward +Z.
 */
import type { Fixed } from './fixed.ts';
import { HALF_PI, ONE, PI, TAU, abs, add, div, mul, sub } from './fixed.ts';
import { ATAN_BITS, ATAN_TABLE, SIN_SIZE, SIN_TABLE } from './trig.tables.ts';

/** Q16.16 index step: one table entry covers TAU / SIN_SIZE radians. */
const RAD_TO_INDEX: Fixed = div(SIN_SIZE * ONE, TAU);
const INDEX_MASK = SIN_SIZE - 1;
const ATAN_SCALE = 1 << ATAN_BITS;

/** Reduce an angle to [0, TAU). */
export function normalizeAngle(a: Fixed): Fixed {
  let r = a % TAU;
  if (r < 0) r += TAU;
  return r | 0;
}

/** Reduce an angle to (-PI, PI] — the short way round, for turn rates. */
export function angleDelta(from: Fixed, to: Fixed): Fixed {
  let d = normalizeAngle(sub(to, from));
  if (d > PI) d = sub(d, TAU);
  return d | 0;
}

function sampleSin(indexFixed: number): Fixed {
  const i = (indexFixed >> 16) & INDEX_MASK;
  const frac = indexFixed & 0xffff;
  const a = SIN_TABLE[i] as number;
  const b = SIN_TABLE[(i + 1) & INDEX_MASK] as number;
  return (a + mul(b - a, frac)) | 0;
}

export function sin(angle: Fixed): Fixed {
  // mul() would overflow for large angles, so scale through the exact path.
  return sampleSin(indexOf(angle));
}

export function cos(angle: Fixed): Fixed {
  return sampleSin(indexOf(angle) + ((SIN_SIZE >> 2) << 16));
}

/** Angle -> Q16.16 table index, wrapped into the table's range. */
function indexOf(angle: Fixed): number {
  const norm = normalizeAngle(angle);
  // norm < TAU (~2^18 in Q16.16) and RAD_TO_INDEX is ~652, so this product
  // exceeds 32 bits: do the scaling exactly and mask afterwards.
  const scaled = (norm * RAD_TO_INDEX) / ONE;
  return Math.trunc(scaled) % (SIN_SIZE << 16);
}

/** sin and cos together, for rotating a vector. */
export function sinCos(angle: Fixed): { s: Fixed; c: Fixed } {
  const i = indexOf(angle);
  return { s: sampleSin(i), c: sampleSin(i + ((SIN_SIZE >> 2) << 16)) };
}

/** atan(t) for t in [0, ONE], from the quarter-octant table. */
function atanUnit(t: Fixed): Fixed {
  const scaled = t * ATAN_SCALE; // t <= ONE, so this stays below 2^27
  const i = Math.trunc(scaled / ONE);
  if (i >= ATAN_SCALE) return ATAN_TABLE[ATAN_SCALE] as number;
  const frac = Math.trunc(scaled - i * ONE);
  const a = ATAN_TABLE[i] as number;
  const b = ATAN_TABLE[i + 1] as number;
  return (a + mul(b - a, frac)) | 0;
}

/**
 * Four-quadrant arctangent in Q16.16 radians, result in (-PI, PI].
 * Folded into the first octant so only a 0..1 ratio table is needed.
 */
export function atan2(z: Fixed, x: Fixed): Fixed {
  if (x === 0 && z === 0) return 0;
  const ax = abs(x);
  const az = abs(z);
  let angle: Fixed;
  if (az <= ax) {
    angle = atanUnit(div(az, ax));
  } else {
    angle = sub(HALF_PI, atanUnit(div(ax, az)));
  }
  if (x < 0) angle = sub(PI, angle);
  return (z < 0 ? -angle : angle) | 0;
}

/** Rotate a vector by an angle. */
export function rotate(x: Fixed, z: Fixed, angle: Fixed): { x: Fixed; z: Fixed } {
  const { s, c } = sinCos(angle);
  return { x: sub(mul(x, c), mul(z, s)), z: add(mul(x, s), mul(z, c)) };
}
