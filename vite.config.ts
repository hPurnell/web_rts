import { defineConfig } from 'vitest/config';
import { visualizer } from 'rollup-plugin-visualizer';

// GitHub Pages serves this project from https://<user>.github.io/web_rts/
export default defineConfig({
  base: process.env.VITE_BASE ?? '/web_rts/',
  build: {
    target: 'es2022',
    // Source maps for a Babylon build cost more time than the whole rest of
    // the build; opt in with VITE_SOURCEMAP=1 when actually debugging one.
    sourcemap: process.env.VITE_SOURCEMAP === '1',
    rollupOptions: {
      // The Inspector is a dev tool that must never ship. Dead-code
      // elimination already dropped it, but Rollup still parsed the whole
      // dependency (Fluent UI and all) to find that out, which was slow and
      // noisy. Marking it external makes the exclusion structural: if the
      // dev-only guard around it ever stops working, the build fails loudly
      // on an unresolvable import instead of quietly shipping megabytes.
      external: ['@babylonjs/inspector'],
      plugins: [
        visualizer({ filename: 'dist/stats.html', gzipSize: true, template: 'treemap' }),
      ],
    },
  },
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
