import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

/**
 * Serve a content pack in development only.
 *
 * Mounted at `/content-pack`, which is what `src/` knows about; the directory
 * behind it is this project's Generals pack. Keeping the route generic is what
 * lets `src/` stay free of any particular pack's name.
 *
 * `generals/assets/` holds art converted from a local game installation. It is
 * gitignored, and it must never reach a published build — see
 * generals/PLAN.md ground rule 4.
 *
 * Putting it in `public/` would have Vite copy it into `dist/`, and the only
 * thing stopping a deploy would be that CI happens not to have the files. This
 * serves it from the dev server instead, so a production build cannot include
 * it however it is run.
 */
function generalsAssets(): Plugin {
  const root = join(import.meta.dirname, 'generals', 'assets');
  const types: Record<string, string> = {
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.png': 'image/png',
    '.json': 'application/json',
    '.ogg': 'audio/ogg',
  };

  return {
    name: 'generals-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/content-pack', (req, res, next) => {
        const rest = (req.url ?? '/').split('?')[0] ?? '/';
        // Normalise before joining: a request for ../../etc must not escape.
        const path = join(root, normalize(rest).replace(/^(\.\.(\/|\\|$))+/, ''));
        if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
          next();
          return;
        }
        res.setHeader('content-type', types[extname(path).toLowerCase()] ?? 'application/octet-stream');
        createReadStream(path).pipe(res);
      });
    },
  };
}

// GitHub Pages serves this project from https://<user>.github.io/web_rts/
export default defineConfig({
  base: process.env.VITE_BASE ?? '/web_rts/',
  plugins: [generalsAssets()],
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
    // Performance budgets run serially, under their own config: see
    // vitest.perf.config.ts.
    exclude: ['test/**/*.perf.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
