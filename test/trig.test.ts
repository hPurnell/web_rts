import { describe, expect, it } from 'vitest';
import golden from './golden/trig.json' with { type: 'json' };
import * as fx from '../src/sim/fixed.ts';
import * as trig from '../src/sim/trig.ts';

/**
 * Budget: table entries are rounded (0.5 ULP), linear interpolation across a
 * 4096-entry turn adds under 0.02 ULP, and the interpolating multiply
 * truncates (1 ULP). atan2 additionally truncates the ratio before the lookup.
 */
const SIN_TOLERANCE = 4;
const ATAN_TOLERANCE = 8;

describe('sin and cos match the golden table', () => {
  it('sin', () => {
    let worst = 0;
    golden.angles.forEach((a, i) => {
      const err = Math.abs(trig.sin(a) - (golden.sin[i] as number));
      worst = Math.max(worst, err);
    });
    expect(worst).toBeLessThanOrEqual(SIN_TOLERANCE);
  });

  it('cos', () => {
    let worst = 0;
    golden.angles.forEach((a, i) => {
      const err = Math.abs(trig.cos(a) - (golden.cos[i] as number));
      worst = Math.max(worst, err);
    });
    expect(worst).toBeLessThanOrEqual(SIN_TOLERANCE);
  });

  it('sinCos agrees with sin and cos', () => {
    for (const a of golden.angles) {
      const { s, c } = trig.sinCos(a);
      expect(s).toBe(trig.sin(a));
      expect(c).toBe(trig.cos(a));
    }
  });

  it('hits the cardinal angles exactly', () => {
    expect(trig.sin(0)).toBe(0);
    expect(trig.cos(0)).toBe(fx.ONE);
    expect(Math.abs(trig.sin(fx.HALF_PI) - fx.ONE)).toBeLessThanOrEqual(SIN_TOLERANCE);
    expect(Math.abs(trig.cos(fx.PI) + fx.ONE)).toBeLessThanOrEqual(SIN_TOLERANCE);
  });

  it('satisfies the Pythagorean identity', () => {
    for (const a of golden.angles) {
      const { s, c } = trig.sinCos(a);
      const sum = fx.add(fx.mul(s, s), fx.mul(c, c));
      expect(Math.abs(sum - fx.ONE)).toBeLessThanOrEqual(8);
    }
  });
});

describe('atan2 matches the golden table', () => {
  it('across all quadrants and on the axes', () => {
    for (const { z, x, want } of golden.atan2) {
      const got = trig.atan2(z, x);
      // atan2 is discontinuous at PI: compare the short way round.
      const err = Math.abs(trig.angleDelta(want, got));
      expect(err, `atan2(${z}, ${x})`).toBeLessThanOrEqual(ATAN_TOLERANCE);
    }
  });

  it('inverts sinCos', () => {
    for (const a of golden.angles) {
      const { s, c } = trig.sinCos(a);
      const back = trig.atan2(s, c);
      expect(Math.abs(trig.angleDelta(a, back))).toBeLessThanOrEqual(ATAN_TOLERANCE);
    }
  });

  it('returns zero for the degenerate vector', () => {
    expect(trig.atan2(0, 0)).toBe(0);
  });
});

describe('angle helpers', () => {
  it('normalizes into [0, TAU)', () => {
    for (const a of [0, fx.PI, -fx.PI, fx.TAU, -fx.TAU, 5 * fx.TAU + 17, -7 * fx.TAU - 17]) {
      const n = trig.normalizeAngle(a);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(fx.TAU);
    }
  });

  it('takes the short way round', () => {
    const near = fx.sub(fx.TAU, fx.fromRatio(1, 10));
    expect(trig.angleDelta(near, fx.fromRatio(1, 10))).toBeGreaterThan(0);
    expect(trig.angleDelta(fx.fromRatio(1, 10), near)).toBeLessThan(0);
    expect(Math.abs(trig.angleDelta(0, fx.PI))).toBe(fx.PI);
  });

  it('rotates a vector', () => {
    const r = trig.rotate(fx.ONE, 0, fx.HALF_PI);
    expect(Math.abs(r.x)).toBeLessThanOrEqual(SIN_TOLERANCE);
    expect(Math.abs(r.z - fx.ONE)).toBeLessThanOrEqual(SIN_TOLERANCE);
  });
});

describe('mul/div round trip', () => {
  it('recovers b from mul(a, div(b, a))', () => {
    // div quantises to one ULP and mul then scales that error by |a|, so the
    // achievable bound is |a| ULP, not the flat one ULP PLAN.md suggests.
    let state = 0x9e3779b9 >>> 0;
    const nextU32 = (): number => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    };
    let worstRatio = 0;
    for (let i = 0; i < 5000; i++) {
      const a = ((nextU32() % 4_000_000) - 2_000_000) | 0;
      const b = ((nextU32() % 4_000_000) - 2_000_000) | 0;
      if (a === 0) continue;
      const got = fx.mul(a, fx.div(b, a));
      const budget = Math.abs(fx.toInt(a)) + 2;
      expect(Math.abs(got - b), `a=${a} b=${b}`).toBeLessThanOrEqual(budget);
      worstRatio = Math.max(worstRatio, Math.abs(got - b) / budget);
    }
    expect(worstRatio).toBeLessThanOrEqual(1);
  });
});
