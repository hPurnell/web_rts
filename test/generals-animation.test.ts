/**
 * W3D animation, read the way the source game reads it.
 *
 * Each rule here is `HRawAnimClass` or `BitChannelClass` in the game's own
 * source, and each is one a plausible reimplementation gets wrong: bit order,
 * what a channel holds outside its keyed range, and whether a missing channel
 * means hidden or shown.
 */
import { describe, expect, it } from 'vitest';
import { rotationAt, translationAt, visibleAt } from '../generals/tools/w3d.ts';
import type { PivotMotion } from '../generals/tools/w3d.ts';

describe('visibility channels', () => {
  const blinking = (bits: number[], first = 0, fallback = false): PivotMotion => ({
    visibility: { first, last: first + bits.length * 8 - 1, fallback, bits: new Uint8Array(bits) },
  });

  it('reads bits least-significant first', () => {
    // BitChannelClass::Get_Bit masks with 1 << (bit % 8): frame 0 is bit 0.
    const motion = blinking([0b00000101]);
    expect([0, 1, 2, 3].map((f) => visibleAt(motion, f))).toEqual([true, false, true, false]);
  });

  it('runs on into the next byte', () => {
    const motion = blinking([0x00, 0b00000001]);
    expect(visibleAt(motion, 7)).toBe(false);
    expect(visibleAt(motion, 8)).toBe(true);
  });

  it('counts from the channel start, not from frame zero', () => {
    const motion = blinking([0b00000001], 10);
    expect(visibleAt(motion, 10)).toBe(true);
    expect(visibleAt(motion, 11)).toBe(false);
  });

  it('holds the default outside its keyed range', () => {
    expect(visibleAt(blinking([0xff], 10, false), 3)).toBe(false);
    expect(visibleAt(blinking([0x00], 10, true), 3)).toBe(true);
  });

  it('shows a pivot with no visibility channel at all', () => {
    // HRawAnimClass::Get_Visibility: "default to always visible".
    expect(visibleAt(undefined, 5)).toBe(true);
    expect(visibleAt({}, 5)).toBe(true);
  });
});

describe('motion channels', () => {
  it('rotates by identity outside the keyed range', () => {
    const motion: PivotMotion = {
      rotation: { first: 5, values: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0]) },
    };
    expect(rotationAt(motion, 4)).toEqual([0, 0, 0, 1]);
    expect(rotationAt(motion, 5)).toEqual([0, 0, 1, 0]);
    expect(rotationAt(motion, 6)).toEqual([0, 1, 0, 0]);
    expect(rotationAt(motion, 7)).toEqual([0, 0, 0, 1]);
  });

  it('translates each axis from its own channel, and not at all outside it', () => {
    const motion: PivotMotion = {
      x: { first: 0, values: new Float32Array([1, 2]) },
      z: { first: 1, values: new Float32Array([5]) },
    };
    expect(translationAt(motion, 0)).toEqual({ x: 1, y: 0, z: 0 });
    expect(translationAt(motion, 1)).toEqual({ x: 2, y: 0, z: 5 });
    expect(translationAt(motion, 2)).toEqual({ x: 0, y: 0, z: 0 });
  });
});
