/**
 * What the manifest asks for, and what your installation actually has.
 *
 * Run this before `gen:convert`: a base-Generals-only install is missing the
 * Zero Hour models, and a clear list beats a crash partway through conversion.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_DIR, findInstall, runTool } from './config.ts';
import { findByBasename, indexArchives } from './big.ts';

async function main(): Promise<void> {
  const install = findInstall();
  console.log(`install:  ${install.root}`);
  console.log(`archives: ${install.archives.length}${install.zeroHour ? ' (Zero Hour present)' : ' (base Generals only)'}`);

  const index = indexArchives(install.archives);
  console.log(`indexed:  ${index.entries.size} files\n`);

  const manifest = JSON.parse(readFileSync(join(MANIFEST_DIR, 'assets.json'), 'utf8')) as {
    vehicles: { id: string; model: string }[];
  };

  let missing = 0;
  for (const vehicle of manifest.vehicles) {
    const found = findByBasename(index, vehicle.model);
    if (found.length === 0) {
      console.log(`  MISSING  ${vehicle.id.padEnd(18)} ${vehicle.model}`);
      missing++;
    } else {
      console.log(`  ok       ${vehicle.id.padEnd(18)} ${vehicle.model}  (${found[0]!.archive})`);
    }
  }

  console.log(
    `\n${manifest.vehicles.length - missing} of ${manifest.vehicles.length} present` +
      (missing > 0 ? `, ${missing} missing` : ''),
  );
  if (missing > 0) process.exitCode = 1;
}

void runTool(main);
