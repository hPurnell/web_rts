/**
 * Deterministic hash of match state.
 *
 * Used three ways: the offline harness asserts a scripted match ends on a
 * committed golden hash, replays checkpoint every 100 ticks, and lockstep
 * clients compare hashes to detect desync. All three need the same function,
 * so it lives in the simulation.
 */
import { fnv1a32, hashArray, hashU32 } from './hash.ts';
import type { Match } from './match.ts';
import { hashableArrays, hashableScalars } from './match.ts';

export function hashMatch(match: Match): number {
  let hash = 0x811c9dc5;
  for (const { value } of hashableScalars(match)) hash = hashU32(value | 0, hash);
  for (const { data } of hashableArrays(match)) hash = hashArray(data, hash);
  return hash >>> 0;
}

/** Per-component hashes, for reporting *what* diverged rather than only that it did. */
export function hashComponents(match: Match): Map<string, number> {
  const out = new Map<string, number>();
  for (const { name, value } of hashableScalars(match)) {
    out.set(name, hashU32(value | 0, 0x811c9dc5));
  }
  for (const { name, data } of hashableArrays(match)) {
    out.set(
      name,
      fnv1a32(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    );
  }
  return out;
}

/** Names of the components that differ between two states. Empty means identical. */
export function diffComponents(a: Match, b: Match): string[] {
  const left = hashComponents(a);
  const right = hashComponents(b);
  const names: string[] = [];
  for (const [name, value] of left) {
    if (right.get(name) !== value) names.push(name);
  }
  return names;
}
