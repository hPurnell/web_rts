import { defineConfig } from 'vitest/config';

/**
 * Performance budgets, run on their own.
 *
 * These assert wall-clock costs from PLAN.md, and wall-clock numbers are
 * meaningless when thirty test files are competing for the same cores: the fog
 * update measures 0.5ms alone and occasionally 2ms+ under a parallel run. They
 * therefore run serially, with the rest of the suite excluded.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.perf.test.ts'],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
