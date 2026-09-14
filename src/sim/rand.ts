/**
 * xoshiro128** — the simulation's only source of randomness (invariant 2).
 *
 * 128 bits of state in four u32 words, all arithmetic in Int32/Uint32, so a
 * seed reproduces the same sequence on every engine. State is explicit: it can
 * be cloned for speculative work and serialized into a replay or a save.
 */
import type { Fixed } from './fixed.ts';

export const STATE_BYTES = 16;

export type RandState = Uint32Array; // length 4

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Expand a 32-bit seed into 128 bits of state with SplitMix32, so that
 * neighbouring seeds produce unrelated streams and the all-zero state (which
 * xoshiro cannot escape) is never produced.
 */
export function makeRand(seed: number): RandState {
  const state = new Uint32Array(4);
  let z = seed >>> 0;
  for (let i = 0; i < 4; i++) {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    state[i] = (t ^ (t >>> 15)) >>> 0;
  }
  if (state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0) {
    state[0] = 0x9e3779b9;
  }
  return state;
}

export function cloneRand(state: RandState): RandState {
  return state.slice();
}

/** Next 32 random bits, advancing the state in place. */
export function nextU32(state: RandState): number {
  const s0 = state[0] as number;
  const s1 = state[1] as number;
  const s2 = state[2] as number;
  const s3 = state[3] as number;

  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;

  const t = (s1 << 9) >>> 0;
  let n2 = (s2 ^ s0) >>> 0;
  let n3 = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ n2) >>> 0;
  const n0 = (s0 ^ n3) >>> 0;
  n2 = (n2 ^ t) >>> 0;
  n3 = rotl(n3, 11);

  state[0] = n0;
  state[1] = n1;
  state[2] = n2;
  state[3] = n3;
  return result;
}

/**
 * Uniform integer in [min, max). Uses Lemire's multiply-shift rejection method,
 * which is unbiased and, unlike a modulo, consumes a predictable number of
 * draws — important because the draw count is part of the determinism hash.
 */
export function nextRange(state: RandState, min: number, max: number): number {
  const span = (max - min) | 0;
  if (span <= 0) return min | 0;
  const limit = 0x100000000 % span; // values below this would bias the result
  let value: number;
  do {
    value = nextU32(state);
  } while (value < limit);
  return (min + (value % span)) | 0;
}

/** Uniform Fixed in [0, ONE). The top 16 bits are the highest-quality ones. */
export function nextFixed01(state: RandState): Fixed {
  return nextU32(state) >>> 16;
}

/** Uniform Fixed in [min, max). */
export function nextFixedRange(state: RandState, min: Fixed, max: Fixed): Fixed {
  const span = (max - min) | 0;
  if (span <= 0) return min;
  // Scale a 32-bit draw down to the span without a 64-bit multiply.
  const hi = (nextU32(state) >>> 16) & 0xffff;
  return (min + Math.trunc((span * hi) / 0x10000)) | 0;
}

/** Fisher-Yates over an index array; deterministic given the state. */
export function shuffle(state: RandState, items: Int32Array): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = nextRange(state, 0, i + 1);
    const tmp = items[i] as number;
    items[i] = items[j] as number;
    items[j] = tmp;
  }
}

/** Serialize to little-endian bytes. */
export function randToBytes(state: RandState): Uint8Array {
  const bytes = new Uint8Array(STATE_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) view.setUint32(i * 4, state[i] as number, true);
  return bytes;
}

/** Deserialize from little-endian bytes. */
export function randFromBytes(bytes: Uint8Array): RandState {
  if (bytes.length !== STATE_BYTES) {
    throw new Error(`PRNG state must be ${STATE_BYTES} bytes, got ${bytes.length}`);
  }
  const state = new Uint32Array(4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 4; i++) state[i] = view.getUint32(i * 4, true);
  return state;
}
