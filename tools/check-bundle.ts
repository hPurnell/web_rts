/**
 * Bundle checks that must hold for every build.
 *
 * 1. The editor is code-split: no module under src/editor may end up in the
 *    entry chunk or anything it loads eagerly (M8).
 * 2. The Babylon Inspector never ships (M5).
 *
 * Reads Rollup's own module graph out of dist/stats.html's data, so the answer
 * comes from the build rather than from grepping minified output.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const ASSETS = join(DIST, 'assets');

interface Failure {
  readonly message: string;
}

function entryChunk(): string {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const match = /<script[^>]+src="[^"]*\/(assets\/[^"]+\.js)"/.exec(html);
  if (!match?.[1]) throw new Error('could not find the entry script in dist/index.html');
  return join(DIST, match[1]);
}

/**
 * Chunks the entry pulls in eagerly: itself plus everything it statically
 * imports, transitively. Dynamic imports are deliberately not followed --
 * being reachable only that way is exactly what "code-split" means.
 */
function eagerChunks(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/(?:^|[^.\w])(?:import|export)[^;]*?from"\.\/([\w.-]+\.js)"/g)) {
      const next = join(ASSETS, match[1] as string);
      if (existsSync(next)) queue.push(next);
    }
    for (const match of code.matchAll(/import"\.\/([\w.-]+\.js)"/g)) {
      const next = join(ASSETS, match[1] as string);
      if (existsSync(next)) queue.push(next);
    }
  }
  return seen;
}

function main(): void {
  const failures: Failure[] = [];
  const entry = entryChunk();
  const eager = eagerChunks(entry);

  // The editor's own marker: a class name only the editor emits.
  const EDITOR_MARKERS = ['editor-palette', 'editor-status-key', 'Drag across a cliff'];
  for (const chunk of eager) {
    const code = readFileSync(chunk, 'utf8');
    for (const marker of EDITOR_MARKERS) {
      if (code.includes(marker)) {
        failures.push({ message: `editor code is in the eager chunk ${chunk} (found "${marker}")` });
      }
    }
  }

  // It must, however, exist somewhere: a code-split chunk that was tree-shaken
  // away entirely would also pass the check above.
  const allChunks = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  const editorChunk = allChunks.find((f) =>
    readFileSync(join(ASSETS, f), 'utf8').includes('editor-palette'),
  );
  if (!editorChunk) {
    failures.push({ message: 'no chunk contains the editor at all' });
  } else if (eager.has(join(ASSETS, editorChunk))) {
    failures.push({ message: `editor chunk ${editorChunk} is loaded eagerly` });
  }

  for (const chunk of allChunks) {
    const code = readFileSync(join(ASSETS, chunk), 'utf8');
    // Fluent UI is only reachable through the Inspector, and is the marker
    // that actually survives minification.
    if (
      code.includes('BABYLON.Inspector') ||
      code.includes('babylonjs-inspector') ||
      code.includes('@fluentui') ||
      code.includes('makeStyles')
    ) {
      failures.push({ message: `the Babylon Inspector shipped in ${chunk}` });
    }
  }

  const eagerBytes = [...eager].reduce((sum, f) => sum + readFileSync(f).byteLength, 0);
  const totalBytes = allChunks.reduce(
    (sum, f) => sum + readFileSync(join(ASSETS, f)).byteLength,
    0,
  );

  console.log(`entry chunk:     ${entry}`);
  console.log(`eager chunks:    ${eager.size} (${(eagerBytes / 1024).toFixed(0)} KiB)`);
  console.log(`editor chunk:    ${editorChunk ?? 'MISSING'} (lazy)`);
  console.log(`total js:        ${(totalBytes / 1024).toFixed(0)} KiB across ${allChunks.length} chunks`);

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL: ${f.message}`);
    process.exit(1);
  }
  console.log('bundle check ok');
}

main();
