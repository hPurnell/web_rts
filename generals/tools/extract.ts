/**
 * Listing and pulling files out of the game's BIG archives.
 *
 * Usage:
 *   pnpm gen:extract --list [pattern]   what is in there
 *   pnpm gen:extract <name> [...]       pull named files into .cache/
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CACHE_DIR, findInstall, runTool } from './config.ts';
import { findByBasename, indexArchives, readEntry } from './big.ts';

async function main(): Promise<void> {
  const install = findInstall();
  console.log(`install: ${install.root}`);
  console.log(`archives: ${install.archives.length}${install.zeroHour ? ' (Zero Hour present)' : ''}`);

  const index = indexArchives(install.archives);
  console.log(`indexed ${index.entries.size} files from ${index.archiveCount} archives\n`);

  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--list') {
    const pattern = args[1]?.toLowerCase();
    let shown = 0;
    let matched = 0;
    for (const entry of index.entries.values()) {
      if (pattern && !entry.key.includes(pattern)) continue;
      matched++;
      if (shown < 40) {
        console.log(`  ${entry.name}  (${entry.size} bytes, ${entry.archive})`);
        shown++;
      }
    }
    console.log(`\n${matched} matching${matched > shown ? `, showing ${shown}` : ''}`);
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  for (const name of args) {
    const found = findByBasename(index, name);
    if (found.length === 0) {
      console.error(`  not found: ${name}`);
      process.exitCode = 1;
      continue;
    }
    const entry = found[0]!;
    const archivePath = index.archivePaths.get(entry.archive)!;
    const out = join(CACHE_DIR, entry.key);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, readEntry(archivePath, entry));
    console.log(`  ${entry.name} -> ${out} (${entry.size} bytes, ${entry.archive})`);
  }
}

void runTool(main);
