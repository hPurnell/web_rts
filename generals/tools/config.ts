/**
 * Where your Command & Conquer: Generals installation lives.
 *
 * Ground rule 2 from PLAN.md: the pipeline reads from your installation and
 * never from the repository, and with no installation configured every tool
 * here exits saying so rather than half-running against a partial cache.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `generals/`, resolved from this file rather than from the process cwd. */
export const GENERALS_DIR = fileURLToPath(new URL('..', import.meta.url));

export const CONFIG_PATH = join(GENERALS_DIR, 'generals.local.json');
export const CACHE_DIR = join(GENERALS_DIR, '.cache');
export const ASSETS_DIR = join(GENERALS_DIR, 'assets');
export const MANIFEST_DIR = join(GENERALS_DIR, 'manifest');

export interface GeneralsInstall {
  /** The directory holding the .big archives. */
  readonly root: string;
  /** Every archive found there, newest-precedence last. */
  readonly archives: readonly string[];
  /** True when Zero Hour archives are present. */
  readonly zeroHour: boolean;
}

export class MissingInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingInstallError';
  }
}

/** The configured install directory, or null when there is none. */
export function configuredDir(): string | null {
  const fromEnv = process.env['GENERALS_DIR'];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { installDir?: unknown };
    return typeof parsed.installDir === 'string' ? parsed.installDir : null;
  } catch (error) {
    throw new MissingInstallError(
      `${CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Archives load in a fixed order and later ones win.
 *
 * The game layers Zero Hour over base Generals, and a patch archive over both.
 * A `Textures.big` entry and a `TexturesZH.big` entry with the same name are
 * different art, and taking the wrong one is the kind of mistake that shows up
 * as one vehicle looking subtly wrong three milestones later.
 */
const ARCHIVE_ORDER = ['', 'patch', 'zh'] as const;

function archiveRank(name: string): number {
  const lower = name.toLowerCase();
  if (lower.startsWith('patch')) return ARCHIVE_ORDER.indexOf('patch');
  if (lower.includes('zh')) return ARCHIVE_ORDER.indexOf('zh');
  return 0;
}

/**
 * Find the installation, looking in the configured directory and one level
 * below it.
 *
 * A Zero Hour install is usually a parent folder holding two game folders, so
 * pointing at either the parent or the game folder itself both work.
 */
export function findInstall(): GeneralsInstall {
  const dir = configuredDir();
  if (!dir) {
    throw new MissingInstallError(
      [
        'No Command & Conquer: Generals installation configured.',
        '',
        `Create ${CONFIG_PATH}:`,
        '',
        '  { "installDir": "/mnt/c/Program Files/EA Games/Command and Conquer Generals Zero Hour" }',
        '',
        'or set GENERALS_DIR in the environment. See generals/README.md.',
      ].join('\n'),
    );
  }
  if (!existsSync(dir)) {
    throw new MissingInstallError(`Configured installDir does not exist: ${dir}`);
  }

  const roots: string[] = [dir];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(join(dir, entry.name));
  }

  const archives: string[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.big')) {
        archives.push(join(root, entry.name));
      }
    }
  }

  if (archives.length === 0) {
    throw new MissingInstallError(
      `No .big archives found under ${dir}. Is that the game's install directory?`,
    );
  }

  archives.sort((a, b) => {
    const rank = archiveRank(a.split(/[\\/]/).pop() ?? '') - archiveRank(b.split(/[\\/]/).pop() ?? '');
    return rank !== 0 ? rank : a.localeCompare(b);
  });

  return {
    root: dir,
    archives,
    zeroHour: archives.some((a) => /zh\.big$/i.test(a)),
  };
}

/** Run a tool, turning a missing install into a clean exit rather than a stack. */
export async function runTool(main: () => Promise<void> | void): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof MissingInstallError) {
      console.error(`\n${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
