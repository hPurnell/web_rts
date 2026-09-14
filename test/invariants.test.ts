import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Invariants 2 and 3 are only real if breaking them fails the build.
 * This lints a virtual file inside src/sim/ and asserts each violation is caught.
 */
const VIOLATIONS = `
import { Engine } from 'babylonjs';
import { makeMesh } from '../render/terrain';
export const a = Math.random();
export const b = Math.sin(1);
export const c = 0.5;
export const d = Date.now();
export const e = performance.now();
export const f = window.innerWidth;
export const g = document.body;
export const h = [Engine, makeMesh];
`;

async function ruleIdsFor(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, {
    filePath: 'src/sim/__invariant_fixture__.ts',
    warnIgnored: false,
  });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '');
}

describe('architecture invariants are lint-enforced', () => {
  it('rejects non-determinism and renderer dependencies in src/sim', async () => {
    const ids = await ruleIdsFor(VIOLATIONS);
    expect(ids.filter((id) => id === 'rts/no-nondeterminism').length).toBeGreaterThanOrEqual(5);
    expect(ids.filter((id) => id === 'rts/no-renderer-import').length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('accepts deterministic integer code', async () => {
    const ids = await ruleIdsFor(
      'export const mul = (a: number, b: number): number => (Math.imul(a, b) | 0) + 1;\n',
    );
    expect(ids.filter((id) => id?.startsWith('rts/'))).toEqual([]);
  }, 30_000);
});
