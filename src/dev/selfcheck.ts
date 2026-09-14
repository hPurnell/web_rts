/**
 * Cross-environment determinism self-check.
 *
 * The simulation's guarantee is that the same seed yields the same bytes on
 * every engine. CI proves that for Node; this runs the identical golden vector
 * in the browser at boot so the claim is verified where the game actually
 * ships. It costs well under a millisecond.
 */
import { fnv1a32 } from '../sim/hash.ts';
import { makeRand, nextU32 } from '../sim/rand.ts';
import * as fx from '../sim/fixed.ts';
import { atan2, sin } from '../sim/trig.ts';

/** Must match GOLDEN_HASH in test/rand.test.ts. */
export const RAND_GOLDEN_SEED = 12345;
export const RAND_GOLDEN_COUNT = 10_000;
export const RAND_GOLDEN_HASH = 0x6d23c938;

export interface SelfCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function runSelfChecks(): SelfCheck[] {
  const checks: SelfCheck[] = [];

  const state = makeRand(RAND_GOLDEN_SEED);
  const values = new Uint32Array(RAND_GOLDEN_COUNT);
  for (let i = 0; i < values.length; i++) values[i] = nextU32(state);
  const hash = fnv1a32(new Uint8Array(values.buffer));
  checks.push({
    name: 'prng golden sequence',
    ok: hash === RAND_GOLDEN_HASH,
    detail: `0x${hash.toString(16)} (expected 0x${RAND_GOLDEN_HASH.toString(16)})`,
  });

  const sqrtExact = fx.sqrt(fx.fromInt(144)) === fx.fromInt(12);
  checks.push({ name: 'fixed sqrt exact', ok: sqrtExact, detail: sqrtExact ? '12' : 'mismatch' });

  const quarter = sin(fx.HALF_PI);
  checks.push({
    name: 'trig table',
    ok: Math.abs(quarter - fx.ONE) <= 4 && atan2(fx.ONE, 0) === fx.HALF_PI,
    detail: `sin(pi/2)=${quarter}`,
  });

  return checks;
}
