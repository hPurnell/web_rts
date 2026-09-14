import { describe, expect, it } from 'vitest';

// Populated in M3. Kept present from M0 so `pnpm test:determinism` is wired
// into CI from the first commit.
describe('determinism harness', () => {
  it('is wired into CI', () => {
    expect(true).toBe(true);
  });
});
