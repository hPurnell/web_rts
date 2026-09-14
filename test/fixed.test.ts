import { describe, expect, it } from 'vitest';
import * as fx from '../src/sim/fixed.ts';

const { ONE, fromInt, fromRatio, toFloat } = fx;

/** Exact rational value of a Fixed, for comparing against expectations. */
const exact = (a: number): number => a / ONE;

describe('fixed-point conversion', () => {
  it('round-trips whole numbers', () => {
    for (const n of [0, 1, -1, 2, -2, 100, -100, 32767, -32768]) {
      expect(fx.toInt(fromInt(n))).toBe(n);
      expect(toFloat(fromInt(n))).toBe(n);
    }
  });

  it('rounds ratios to nearest, ties away from zero', () => {
    expect(fromRatio(1, 2)).toBe(ONE / 2);
    expect(fromRatio(-1, 2)).toBe(-ONE / 2);
    expect(fromRatio(1, 3)).toBe(21845); // 65536/3 = 21845.33 -> 21845
    expect(fromRatio(2, 3)).toBe(43691); // 43690.67 -> 43691
    expect(fromRatio(-2, 3)).toBe(-43691);
    expect(fromRatio(1, 131072)).toBe(1); // exactly half a ULP, rounds away
    expect(fromRatio(-1, 131072)).toBe(-1);
    expect(fromRatio(1, 131073)).toBe(0); // just under half, rounds to zero
  });

  it('saturates instead of producing NaN on divide by zero', () => {
    expect(fromRatio(1, 0)).toBe(fx.MAX);
    expect(fromRatio(-1, 0)).toBe(fx.MIN);
    expect(fx.div(fromInt(5), 0)).toBe(fx.MAX);
    expect(fx.div(fromInt(-5), 0)).toBe(fx.MIN);
  });
});

describe('fixed-point rounding direction', () => {
  it('floors toward negative infinity and ceils toward positive', () => {
    expect(exact(fx.floor(fromRatio(3, 2)))).toBe(1);
    expect(exact(fx.floor(fromRatio(-3, 2)))).toBe(-2);
    expect(exact(fx.ceil(fromRatio(3, 2)))).toBe(2);
    expect(exact(fx.ceil(fromRatio(-3, 2)))).toBe(-1);
    expect(exact(fx.round(fromRatio(3, 2)))).toBe(2);
    expect(exact(fx.round(fromRatio(-3, 2)))).toBe(-1); // halves go toward +inf
    expect(exact(fx.round(fromRatio(-5, 3)))).toBe(-2);
  });

  it('keeps fract non-negative', () => {
    expect(fx.fract(fromRatio(-3, 2))).toBe(ONE / 2);
    expect(fx.fract(fromRatio(3, 2))).toBe(ONE / 2);
  });

  it('truncates division toward zero', () => {
    expect(fx.div(fromInt(7), fromInt(2))).toBe(fromRatio(7, 2));
    expect(fx.toInt(fx.div(fromInt(-7), fromInt(2)))).toBe(-3);
    expect(fx.toInt(fx.div(fromInt(7), fromInt(-2)))).toBe(-3);
  });
});

describe('fixed-point multiply', () => {
  it('matches exact rational products', () => {
    const cases: [number, number, number, number][] = [
      [1, 2, 1, 2], // 0.5 * 0.5
      [-1, 2, 1, 2],
      [-1, 2, -1, 2],
      [3, 1, 7, 1],
      [-3, 1, 7, 1],
      [1, 1024, 1, 1024],
    ];
    for (const [an, ad, bn, bd] of cases) {
      const got = fx.mul(fromRatio(an, ad), fromRatio(bn, bd));
      const want = fromRatio(an * bn, ad * bd);
      expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
    }
  });

  it('is exact for whole numbers', () => {
    for (let a = -50; a <= 50; a += 7) {
      for (let b = -50; b <= 50; b += 11) {
        expect(fx.mul(fromInt(a), fromInt(b))).toBe(fromInt(a * b));
      }
    }
  });

  it('wraps rather than saturating at the 32-bit boundary', () => {
    // Documented behaviour: overflow wraps, exactly like the Int32Array it lives in.
    const huge = fromInt(30000);
    expect(fx.mul(huge, huge) | 0).toBe(fx.mul(huge, huge));
  });
});

describe('fixed-point sqrt', () => {
  it('is exact for perfect squares', () => {
    for (let n = 0; n <= 181; n++) {
      expect(fx.sqrt(fromInt(n * n))).toBe(fromInt(n));
    }
  });

  it('never overestimates', () => {
    for (let n = 1; n < 30000; n += 137) {
      const a = fromRatio(n, 7);
      const r = fx.sqrt(a);
      expect(fx.mul(r, r)).toBeLessThanOrEqual(a);
      const next = r + 1;
      expect(fx.mul(next, next)).toBeGreaterThan(a - 2);
    }
  });

  it('clamps non-positive input to zero', () => {
    expect(fx.sqrt(0)).toBe(0);
    expect(fx.sqrt(fromInt(-4))).toBe(0);
  });

  it('computes vector length', () => {
    expect(fx.length(fromInt(3), fromInt(4))).toBe(fromInt(5));
    expect(fx.length(0, 0)).toBe(0);
  });
});

describe('fixed-point invariants', () => {
  it('add and sub are exact inverses', () => {
    for (let i = -1000; i <= 1000; i += 37) {
      const a = fromRatio(i, 13);
      const b = fromRatio(i * 3 - 7, 5);
      expect(fx.sub(fx.add(a, b), b)).toBe(a);
    }
  });

  it('abs, min, max and clamp behave', () => {
    expect(fx.abs(fromInt(-7))).toBe(fromInt(7));
    expect(fx.abs(fromInt(7))).toBe(fromInt(7));
    expect(fx.abs(0)).toBe(0);
    expect(fx.min(fromInt(-7), fromInt(3))).toBe(fromInt(-7));
    expect(fx.max(fromInt(-7), fromInt(3))).toBe(fromInt(3));
    expect(fx.clamp(fromInt(9), fromInt(0), fromInt(5))).toBe(fromInt(5));
    expect(fx.clamp(fromInt(-9), fromInt(0), fromInt(5))).toBe(fromInt(0));
    expect(fx.sign(fromInt(-9))).toBe(-1);
  });

  it('lerp hits both endpoints', () => {
    const a = fromInt(10);
    const b = fromInt(20);
    expect(fx.lerp(a, b, 0)).toBe(a);
    expect(fx.lerp(a, b, ONE)).toBe(b);
    expect(fx.lerp(a, b, ONE / 2)).toBe(fromInt(15));
  });
});
