/**
 * Uniform spatial hash over unit positions.
 *
 * Separation asks "which units are within a metre of me" for every unit, every
 * tick. Done naively that is quadratic — 200 units is 40,000 distance tests,
 * 2,000 units is four million. A uniform grid turns it into a scan of nine
 * buckets, because RTS units are spread over a map rather than clustered in
 * one place.
 *
 * The structure is rebuilt from scratch each tick rather than maintained
 * incrementally: units move every tick anyway, and a rebuild is a linear pass
 * over two typed arrays with no allocation.
 */
import type { Fixed } from './fixed.ts';
import { toInt } from './fixed.ts';
import type { UnitStore } from './units.ts';

/** Bucket edge length in whole world units. One bucket per two cells. */
export const BUCKET_SIZE = 2;

export interface SpatialHash {
  readonly width: number;
  readonly height: number;
  /** Start offset of each bucket into `entries`. Length is buckets + 1. */
  readonly starts: Int32Array;
  /** Unit indices, grouped by bucket. */
  readonly entries: Int32Array;
  /** Scratch used while building; kept to avoid reallocating each tick. */
  readonly counts: Int32Array;
}

export function createSpatialHash(worldWidth: number, worldHeight: number): SpatialHash {
  const width = Math.ceil(worldWidth / BUCKET_SIZE) + 1;
  const height = Math.ceil(worldHeight / BUCKET_SIZE) + 1;
  const buckets = width * height;
  return {
    width,
    height,
    starts: new Int32Array(buckets + 1),
    entries: new Int32Array(0),
    counts: new Int32Array(buckets),
  };
}

function bucketOf(hash: SpatialHash, x: Fixed, z: Fixed): number {
  const bx = Math.max(0, Math.min(hash.width - 1, (toInt(x) / BUCKET_SIZE) | 0));
  const bz = Math.max(0, Math.min(hash.height - 1, (toInt(z) / BUCKET_SIZE) | 0));
  return bz * hash.width + bx;
}

/**
 * Rebuild the hash from the live units.
 *
 * Counting sort: one pass to count per bucket, a prefix sum, then one pass to
 * place. That keeps every unit's bucket contiguous, which is what makes the
 * neighbour scan cache-friendly, and it is completely deterministic.
 */
export function rebuildSpatialHash(hash: SpatialHash, store: UnitStore): SpatialHash {
  const buckets = hash.counts.length;
  hash.counts.fill(0);

  let live = 0;
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    live++;
    const bucket = bucketOf(hash, store.posX[i] as number, store.posZ[i] as number);
    hash.counts[bucket] = (hash.counts[bucket] as number) + 1;
  }

  let running = 0;
  for (let b = 0; b < buckets; b++) {
    hash.starts[b] = running;
    running += hash.counts[b] as number;
  }
  hash.starts[buckets] = running;

  const entries = hash.entries.length >= live ? hash.entries : new Int32Array(Math.max(64, live * 2));
  const cursor = hash.counts; // reused as the write cursor
  for (let b = 0; b < buckets; b++) cursor[b] = hash.starts[b] as number;

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    const bucket = bucketOf(hash, store.posX[i] as number, store.posZ[i] as number);
    entries[cursor[bucket] as number] = i;
    cursor[bucket] = (cursor[bucket] as number) + 1;
  }

  return entries === hash.entries ? hash : { ...hash, entries };
}

/**
 * Visit every unit in the nine buckets around a position.
 *
 * The caller still does the exact distance test; this only narrows the field.
 */
export function forEachNeighbour(
  hash: SpatialHash,
  x: Fixed,
  z: Fixed,
  visit: (unitIndex: number) => void,
): void {
  const bx = Math.max(0, Math.min(hash.width - 1, (toInt(x) / BUCKET_SIZE) | 0));
  const bz = Math.max(0, Math.min(hash.height - 1, (toInt(z) / BUCKET_SIZE) | 0));

  for (let oz = -1; oz <= 1; oz++) {
    const row = bz + oz;
    if (row < 0 || row >= hash.height) continue;
    for (let ox = -1; ox <= 1; ox++) {
      const column = bx + ox;
      if (column < 0 || column >= hash.width) continue;
      const bucket = row * hash.width + column;
      const start = hash.starts[bucket] as number;
      const end = hash.starts[bucket + 1] as number;
      for (let i = start; i < end; i++) visit(hash.entries[i] as number);
    }
  }
}

/** Units in a bucket, for tests. */
export function bucketContents(hash: SpatialHash, bucket: number): number[] {
  const start = hash.starts[bucket] as number;
  const end = hash.starts[bucket + 1] as number;
  return Array.from(hash.entries.subarray(start, end));
}
