import { describe, expect, it } from 'vitest';
import * as rng from '../src/sim/rand.ts';
import { ONE } from '../src/sim/fixed.ts';
import { fnv1a32 } from '../src/sim/hash.ts';
import { RAND_GOLDEN_HASH } from '../src/dev/selfcheck.ts';

/**
 * Golden hash of the first 10,000 draws from seed 12345. Committed so any
 * change to the generator is a deliberate, reviewable act: the same hash on
 * another engine is the cross-platform reproducibility guarantee.
 */
const GOLDEN_SEED = 12345;
const GOLDEN_COUNT = 10_000;
const GOLDEN_HASH = RAND_GOLDEN_HASH;

function draw(seed: number, count: number): Uint32Array {
  const state = rng.makeRand(seed);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = rng.nextU32(state);
  return out;
}

describe('xoshiro128**', () => {
  it('reproduces an identical 10,000-value sequence for a seed', () => {
    const a = draw(GOLDEN_SEED, GOLDEN_COUNT);
    const b = draw(GOLDEN_SEED, GOLDEN_COUNT);
    expect(a).toEqual(b);
  });

  it('matches the committed golden hash', () => {
    const hash = fnv1a32(new Uint8Array(draw(GOLDEN_SEED, GOLDEN_COUNT).buffer));
    expect(hash >>> 0).toBe(GOLDEN_HASH);
  });

  it('gives unrelated streams for neighbouring seeds', () => {
    const a = draw(1, 64);
    const b = draw(2, 64);
    let shared = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) shared++;
    expect(shared).toBe(0);
  });

  it('never reaches the all-zero state', () => {
    const state = rng.makeRand(0);
    for (let i = 0; i < 1000; i++) {
      rng.nextU32(state);
      expect(state.some((w) => w !== 0)).toBe(true);
    }
  });

  it('has balanced output bits', () => {
    const values = draw(7, 20_000);
    for (let bit = 0; bit < 32; bit++) {
      let ones = 0;
      for (const v of values) if ((v >>> bit) & 1) ones++;
      const ratio = ones / values.length;
      expect(ratio, `bit ${bit}`).toBeGreaterThan(0.47);
      expect(ratio, `bit ${bit}`).toBeLessThan(0.53);
    }
  });
});

describe('derived draws', () => {
  it('nextRange stays in bounds and covers them', () => {
    const state = rng.makeRand(99);
    const counts = new Int32Array(6);
    for (let i = 0; i < 60_000; i++) {
      const v = rng.nextRange(state, 0, 6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      counts[v] = (counts[v] as number) + 1;
    }
    for (const c of counts) {
      expect(c).toBeGreaterThan(9000); // 10,000 expected; generous band
      expect(c).toBeLessThan(11_000);
    }
  });

  it('nextRange handles negative and degenerate spans', () => {
    const state = rng.makeRand(5);
    for (let i = 0; i < 100; i++) {
      const v = rng.nextRange(state, -10, -3);
      expect(v).toBeGreaterThanOrEqual(-10);
      expect(v).toBeLessThan(-3);
    }
    expect(rng.nextRange(state, 4, 4)).toBe(4);
    expect(rng.nextRange(state, 4, 1)).toBe(4);
  });

  it('nextFixed01 stays inside [0, ONE)', () => {
    const state = rng.makeRand(31337);
    let lo = ONE;
    let hi = 0;
    for (let i = 0; i < 20_000; i++) {
      const v = rng.nextFixed01(state);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(ONE);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeLessThan(ONE / 100); // reaches both ends of the range
    expect(hi).toBeGreaterThan(ONE - ONE / 100);
  });

  it('nextFixedRange stays inside its span', () => {
    const state = rng.makeRand(4242);
    for (let i = 0; i < 5000; i++) {
      const v = rng.nextFixedRange(state, -3 * ONE, 5 * ONE);
      expect(v).toBeGreaterThanOrEqual(-3 * ONE);
      expect(v).toBeLessThan(5 * ONE);
    }
  });

  it('shuffle is a permutation and is seed-reproducible', () => {
    const make = (): Int32Array => Int32Array.from({ length: 200 }, (_, i) => i);
    const a = make();
    const b = make();
    rng.shuffle(rng.makeRand(8), a);
    rng.shuffle(rng.makeRand(8), b);
    expect(a).toEqual(b);
    expect(Array.from(a).sort((x, y) => x - y)).toEqual(Array.from(make()));
    const c = make();
    rng.shuffle(rng.makeRand(9), c);
    expect(c).not.toEqual(a);
  });
});

describe('state serialization', () => {
  it('round-trips through bytes', () => {
    const state = rng.makeRand(777);
    for (let i = 0; i < 50; i++) rng.nextU32(state);
    const restored = rng.randFromBytes(rng.randToBytes(state));
    expect(restored).toEqual(state);
    const fromOriginal = Array.from({ length: 20 }, () => rng.nextU32(state));
    const fromRestored = Array.from({ length: 20 }, () => rng.nextU32(restored));
    expect(fromRestored).toEqual(fromOriginal);
  });

  it('clones diverge independently', () => {
    const state = rng.makeRand(3);
    const copy = rng.cloneRand(state);
    rng.nextU32(state);
    expect(copy).not.toEqual(state);
  });

  it('rejects malformed byte lengths', () => {
    expect(() => rng.randFromBytes(new Uint8Array(8))).toThrow(/16 bytes/);
  });
});
