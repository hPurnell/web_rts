import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import rts from './eslint-rules/index.js';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', '**/*.generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  // Invariants 2 and 3: the simulation is deterministic and renderer-free.
  {
    files: ['src/sim/**/*.ts'],
    plugins: { rts },
    rules: {
      'rts/no-nondeterminism': 'error',
      'rts/no-renderer-import': 'error',
    },
  },
  // Generated tables are integer data; they live under sim but are machine-written.
  {
    files: ['src/sim/**/*.tables.ts'],
    rules: { 'rts/no-nondeterminism': 'off' },
  },
  {
    files: ['eslint-rules/**/*.js', 'tools/**/*.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
);
