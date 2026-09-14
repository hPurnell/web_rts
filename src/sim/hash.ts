/**
 * FNV-1a/32 over bytes. The determinism harness, the replay checkpoints and
 * the lockstep desync check all hash sim state with this, so it lives in the
 * simulation rather than in test code.
 */
export function fnv1a32(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Fold a typed array into a running hash without copying it. */
export function hashArray(
  array: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number },
  seed = 0x811c9dc5,
): number {
  return fnv1a32(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), seed);
}

/** Fold a single 32-bit value into a running hash. */
export function hashU32(value: number, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < 4; i++) {
    hash ^= (value >>> (i * 8)) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
