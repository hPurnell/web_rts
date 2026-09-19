/**
 * Reading Westwood BIG archives.
 *
 * The container Generals ships its content in. Uncompressed, so reading one is
 * a header walk and a slice — no decompression, and an entry can be pulled out
 * without touching the rest of a 300MB file.
 *
 * Layout, verified against the shipped archives rather than from documentation:
 *
 * ```
 * 0  "BIGF"
 * 4  uint32 LE   total archive size
 * 8  uint32 BE   number of entries
 * 12 uint32 BE   header size, which is also the first entry's data offset
 * 16 entries[]:  uint32 BE offset, uint32 BE size, NUL-terminated name
 * ```
 *
 * The mixed endianness is not a mistake in this description: the total size is
 * little-endian and everything else is big-endian. Entry names use backslashes
 * (`Data\INI\AIData.ini`) and are normalised to forward slashes here so lookups
 * do not have to care.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export interface BigEntry {
  /** Normalised, lower-cased path used for lookup: `data/ini/aidata.ini`. */
  readonly key: string;
  /** The name exactly as stored, backslashes and all. */
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  /** Which archive this came from, for reporting. */
  readonly archive: string;
}

export interface BigArchive {
  readonly path: string;
  readonly entries: ReadonlyMap<string, BigEntry>;
}

const MAGIC = 0x42494746; // 'BIGF'

/** Normalise a stored name into a lookup key. */
export function bigKey(name: string): string {
  return name.replace(/\\/g, '/').toLowerCase();
}

/**
 * Read an archive's table of contents.
 *
 * Only the header is read, not the payload: the table of a 300MB archive is a
 * few hundred kilobytes, and nothing is paid for entries that are never asked
 * for.
 */
export function readBig(path: string): BigArchive {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.allocUnsafe(16);
    if (readSync(fd, head, 0, 16, 0) !== 16) {
      throw new Error(`${basename(path)}: too short to be a BIG archive`);
    }
    if (head.readUInt32BE(0) !== MAGIC) {
      throw new Error(
        `${basename(path)}: expected a BIGF magic, found ${JSON.stringify(head.toString('latin1', 0, 4))}`,
      );
    }

    const count = head.readUInt32BE(8);
    const headerSize = head.readUInt32BE(12);
    const fileSize = statSync(path).size;
    if (headerSize > fileSize) {
      throw new Error(`${basename(path)}: header size ${headerSize} exceeds the file`);
    }

    // The whole table in one read. Seeking per entry would be thousands of
    // syscalls for a table that is comfortably small enough to hold.
    const table = Buffer.allocUnsafe(headerSize - 16);
    readSync(fd, table, 0, table.length, 16);

    const entries = new Map<string, BigEntry>();
    const archive = basename(path);
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 8 > table.length) {
        throw new Error(`${archive}: entry table ended after ${i} of ${count} entries`);
      }
      const offset = table.readUInt32BE(cursor);
      const size = table.readUInt32BE(cursor + 4);
      cursor += 8;

      const end = table.indexOf(0, cursor);
      if (end < 0) throw new Error(`${archive}: unterminated name at entry ${i}`);
      const name = table.toString('latin1', cursor, end);
      cursor = end + 1;

      entries.set(bigKey(name), { key: bigKey(name), name, offset, size, archive });
    }

    return { path, entries };
  } finally {
    closeSync(fd);
  }
}

/** Pull one entry's bytes out of its archive. */
export function readEntry(archivePath: string, entry: BigEntry): Buffer {
  const fd = openSync(archivePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(entry.size);
    const read = readSync(fd, buffer, 0, entry.size, entry.offset);
    if (read !== entry.size) {
      throw new Error(`${entry.name}: read ${read} of ${entry.size} bytes`);
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

export interface AssetIndex {
  /** Every entry across every archive, later archives having won. */
  readonly entries: ReadonlyMap<string, BigEntry>;
  /** Archive path by name, for reading an entry back out. */
  readonly archivePaths: ReadonlyMap<string, string>;
  readonly archiveCount: number;
}

/**
 * Index every archive into one lookup, layering them in load order.
 *
 * Later archives overwrite earlier ones, which is how Zero Hour replaces base
 * Generals content and how a patch replaces both. `findInstall` returns them
 * already sorted into that order.
 */
export function indexArchives(archivePaths: readonly string[]): AssetIndex {
  const entries = new Map<string, BigEntry>();
  const byName = new Map<string, string>();

  for (const path of archivePaths) {
    let archive: BigArchive;
    try {
      archive = readBig(path);
    } catch (error) {
      // A malformed archive should not stop the others: some installs carry
      // stub or zero-length .big files next to the real ones.
      console.warn(`  skipped ${basename(path)}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    byName.set(basename(path), path);
    for (const [key, entry] of archive.entries) entries.set(key, entry);
  }

  return { entries, archivePaths: byName, archiveCount: byName.size };
}

/** Read an indexed entry by its normalised key. */
export function readIndexed(index: AssetIndex, key: string): Buffer {
  const entry = index.entries.get(bigKey(key));
  if (!entry) throw new Error(`not found in any archive: ${key}`);
  const archivePath = index.archivePaths.get(entry.archive);
  if (!archivePath) throw new Error(`archive missing for ${key}: ${entry.archive}`);
  return readEntry(archivePath, entry);
}

/**
 * Entries whose base name matches, ignoring directories.
 *
 * The manifest names assets the way the INI files do — `AVCrusader.w3d` — but
 * the archives store them under a directory tree that varies by faction and
 * patch. Matching on the base name is what makes a manifest entry portable
 * between a base and a Zero Hour install.
 */
export function findByBasename(index: AssetIndex, name: string): BigEntry[] {
  const wanted = name.replace(/\\/g, '/').toLowerCase();
  const found: BigEntry[] = [];
  for (const entry of index.entries.values()) {
    if (entry.key.endsWith(`/${wanted}`) || entry.key === wanted) found.push(entry);
  }
  return found;
}
