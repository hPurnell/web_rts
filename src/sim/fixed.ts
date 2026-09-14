/**
 * Q16.16 fixed-point arithmetic — the only numeric representation the
 * simulation is allowed to use (invariant 2).
 *
 * A `Fixed` is a plain 32-bit signed integer holding value * 65536. Every
 * operation here is closed over Int32 and free of floats, so results are
 * bit-identical on every engine and platform.
 *
 * Range: [-32768, 32767.99998]. Resolution: 1/65536 ~= 0.0000153.
 */

export type Fixed = number;

export const SHIFT = 16;
export const ONE: Fixed = 1 << SHIFT; // 65536
export const HALF: Fixed = ONE >> 1;
export const ZERO: Fixed = 0;
export const MAX: Fixed = 0x7fffffff;
export const MIN: Fixed = -0x80000000;
/** Smallest representable step. */
export const EPSILON: Fixed = 1;

export const PI: Fixed = 205887; // round(PI * 65536)
export const TAU: Fixed = 411775; // round(2*PI * 65536)
export const HALF_PI: Fixed = 102944; // round(PI/2 * 65536)

/** Whole number -> Fixed. Wraps on overflow, like every other operation here. */
export function fromInt(n: number): Fixed {
  return (n << SHIFT) | 0;
}

/** Exact rational -> Fixed, rounded to nearest, ties away from zero. */
export function fromRatio(numerator: number, denominator: number): Fixed {
  const n = numerator | 0;
  const d = denominator | 0;
  if (d === 0) return n >= 0 ? MAX : MIN;
  // n * ONE is at most 2^47, inside the exact-integer range of a double, so
  // everything below is integer arithmetic that happens to live in a Number.
  const p = n * ONE;
  const q = exactTrunc(p, d);
  const rem = p - q * d;
  if (rem === 0) return q | 0;
  // Round half away from zero: compare 2*|rem| against |d| without dividing.
  const twiceRem = rem < 0 ? -rem - rem : rem + rem;
  const absD = d < 0 ? -d : d;
  if (twiceRem < absD) return q | 0;
  const away = (p < 0) === (d < 0) ? 1 : -1;
  return (q + away) | 0;
}

/** Fixed -> float. Renderer only; never call this inside the simulation. */
export function toFloat(a: Fixed): number {
  return a / ONE;
}

/** Fixed -> whole number, truncated toward zero. */
export function toInt(a: Fixed): number {
  return a >= 0 ? a >>> SHIFT : -((-a) >>> SHIFT);
}

export function add(a: Fixed, b: Fixed): Fixed {
  return (a + b) | 0;
}

export function sub(a: Fixed, b: Fixed): Fixed {
  return (a - b) | 0;
}

export function neg(a: Fixed): Fixed {
  return -a | 0;
}

export function abs(a: Fixed): Fixed {
  const mask = a >> 31;
  return ((a + mask) ^ mask) | 0;
}

export function min(a: Fixed, b: Fixed): Fixed {
  return a < b ? a : b;
}

export function max(a: Fixed, b: Fixed): Fixed {
  return a > b ? a : b;
}

export function clamp(a: Fixed, lo: Fixed, hi: Fixed): Fixed {
  return a < lo ? lo : a > hi ? hi : a;
}

export function sign(a: Fixed): number {
  return a > 0 ? 1 : a < 0 ? -1 : 0;
}

/** Largest Fixed <= a that is a whole number (floors toward negative infinity). */
export function floor(a: Fixed): Fixed {
  return a & ~(ONE - 1);
}

export function ceil(a: Fixed): Fixed {
  return ((a + (ONE - 1)) & ~(ONE - 1)) | 0;
}

/** Nearest whole-number Fixed, halves rounding toward positive infinity. */
export function round(a: Fixed): Fixed {
  return ((a + HALF) & ~(ONE - 1)) | 0;
}

/** Fractional part in [0, ONE), always non-negative. */
export function fract(a: Fixed): Fixed {
  return a & (ONE - 1);
}

/**
 * Multiply. The 64-bit intermediate is built from two 32-bit halves with
 * Math.imul, so no precision is lost and no float is involved. Truncates
 * toward negative infinity, matching the arithmetic shift.
 */
export function mul(a: Fixed, b: Fixed): Fixed {
  const aLo = a & 0xffff;
  const aHi = a >> 16; // arithmetic: carries the sign
  const bLo = b & 0xffff;
  const bHi = b >> 16;

  // (aHi*2^16 + aLo) * (bHi*2^16 + bLo) >> 16
  //   = aHi*bHi*2^16 + aHi*bLo + aLo*bHi + (aLo*bLo >> 16)
  const lowCarry = (Math.imul(aLo, bLo) >>> 16) | 0;
  const cross = (Math.imul(aHi, bLo) + Math.imul(aLo, bHi)) | 0;
  const high = Math.imul(Math.imul(aHi, bHi), 1 << 16) | 0;
  return (high + cross + lowCarry) | 0;
}

/**
 * Divide, truncating toward zero. Division by zero saturates, which keeps the
 * simulation running deterministically rather than producing NaN.
 */
export function div(a: Fixed, b: Fixed): Fixed {
  if (b === 0) return a >= 0 ? MAX : MIN;
  return exactTrunc(a * ONE, b) | 0;
}

/**
 * Integer quotient of p/d truncated toward zero, where p is an exact integer
 * below 2^53. IEEE division is correctly rounded rather than truncated, so the
 * raw quotient can sit one off across an integer boundary; both corrections
 * below move at most one step and are exact, because q*d stays near p.
 */
function exactTrunc(p: number, d: number): number {
  let q = Math.trunc(p / d);
  let rem = p - q * d;
  if (rem !== 0) {
    const absRem = rem < 0 ? -rem : rem;
    const absD = d < 0 ? -d : d;
    if (absRem >= absD) {
      // q landed too close to zero.
      q += Math.trunc(rem / d);
      rem = p - q * d;
    }
    if (rem !== 0 && rem < 0 !== p < 0) {
      // q landed too far from zero: the remainder must match the dividend.
      q += q > 0 ? -1 : 1;
    }
  }
  return q;
}

/**
 * Square root, truncated toward zero. Exact for perfect squares.
 *
 * sqrt(a/2^16) * 2^16 == isqrt(a * 2^16), so this binary-searches the integer
 * square root of a 47-bit value. The largest Fixed is just under 2^15, whose
 * root is under 2^8, so the answer never exceeds 2^24 and `trial * trial`
 * stays under 2^48 — exact in a double, no 64-bit emulation needed.
 */
export function sqrt(a: Fixed): Fixed {
  if (a <= 0) return 0;
  const n = a * ONE;
  let root = 0;
  for (let bit = 1 << 23; bit !== 0; bit >>= 1) {
    const trial = root + bit;
    if (trial * trial <= n) root = trial;
  }
  return root | 0;
}

/**
 * Integer square root of a plain non-negative integer, truncated.
 *
 * For whole-number quantities such as a cell distance or a unit count. The
 * search is 16 bits wide, so the input must be under 2^32 and the result under
 * 65536 — do not reach for this to take the root of a Q16.16 value, which is
 * what `sqrt` is for.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let root = 0;
  for (let bit = 1 << 15; bit !== 0; bit >>= 1) {
    const trial = root + bit;
    if (trial * trial <= n) root = trial;
  }
  return root;
}

/** Linear interpolation. `t` is Fixed in [0, ONE]. */
export function lerp(a: Fixed, b: Fixed, t: Fixed): Fixed {
  return (a + mul(sub(b, a), t)) | 0;
}

/** Euclidean length of a 2D vector. */
export function length(x: Fixed, z: Fixed): Fixed {
  return sqrt(add(mul(x, x), mul(z, z)));
}

/** Squared length. Cheaper than `length` and enough for radius comparisons. */
export function lengthSq(x: Fixed, z: Fixed): Fixed {
  return add(mul(x, x), mul(z, z));
}
