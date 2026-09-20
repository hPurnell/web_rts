/**
 * Reading Generals `.map` files.
 *
 * A map is a RefPack stream (see `refpack.ts`) wrapping a `CkMp` container:
 *
 * ```
 * "CkMp"
 * uint32 count                  entries in the name dictionary
 * count x:
 *   uint8  length
 *   char   name[length]
 *   uint32 index                what chunks refer to this name by
 * chunks, to the end:
 *   uint32 nameIndex
 *   uint16 version
 *   uint32 dataLength
 *   bytes  data                 itself chunks, for container chunks
 * ```
 *
 * Verified against the shipped maps: the dictionary's indices count down from
 * the entry count to one, and every chunk's name index resolves.
 *
 * Only what this project imports is decoded — the heightfield, the object list
 * and the global lighting. Scripts, triggers and teams are walked past.
 */
import { decompressMap } from './refpack.ts';

export interface MapChunk {
  readonly name: string;
  readonly version: number;
  readonly data: Buffer;
  readonly children: readonly MapChunk[];
}

const MAGIC = 'CkMp';

/** Chunks whose payload is itself chunks rather than fields. */
const CONTAINERS = new Set(['ObjectsList', 'SidesList', 'PlayerScriptsList', 'ScriptList']);

export interface GeneralsMap {
  readonly names: ReadonlyMap<number, string>;
  readonly chunks: readonly MapChunk[];
}

export function readMap(buffer: Buffer): GeneralsMap {
  const data = decompressMap(buffer);
  if (data.toString('latin1', 0, 4) !== MAGIC) {
    throw new Error(`not a Generals map: magic ${JSON.stringify(data.toString('latin1', 0, 4))}`);
  }

  const count = data.readUInt32LE(4);
  const names = new Map<number, string>();
  let at = 8;
  for (let i = 0; i < count; i++) {
    const length = data[at] as number;
    const name = data.toString('latin1', at + 1, at + 1 + length);
    const index = data.readUInt32LE(at + 1 + length);
    names.set(index, name);
    at += 1 + length + 4;
  }

  return { names, chunks: readChunks(data, at, data.length, names) };
}

function readChunks(
  data: Buffer,
  start: number,
  end: number,
  names: ReadonlyMap<number, string>,
): MapChunk[] {
  const chunks: MapChunk[] = [];
  let at = start;

  while (at + 10 <= end) {
    const nameIndex = data.readUInt32LE(at);
    const name = names.get(nameIndex);
    if (name === undefined) break; // not a chunk boundary: stop rather than guess
    const version = data.readUInt16LE(at + 4);
    const length = data.readUInt32LE(at + 6);
    const body = at + 10;
    if (body + length > end) break;

    const payload = data.subarray(body, body + length);
    chunks.push({
      name,
      version,
      data: payload,
      children: CONTAINERS.has(name) ? readChunks(data, body, body + length, names) : [],
    });
    at = body + length;
  }

  return chunks;
}

/** Depth-first search for the first chunk with a name. */
export function findMapChunk(chunks: readonly MapChunk[], name: string): MapChunk | null {
  for (const chunk of chunks) {
    if (chunk.name === name) return chunk;
    const nested = findMapChunk(chunk.children, name);
    if (nested) return nested;
  }
  return null;
}

/** Every chunk with a name, at any depth. */
export function findMapChunks(chunks: readonly MapChunk[], name: string): MapChunk[] {
  const found: MapChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.name === name) found.push(chunk);
    found.push(...findMapChunks(chunk.children, name));
  }
  return found;
}

/** A cursor over a chunk payload, since the field types are mixed. */
export class Reader {
  at = 0;
  constructor(readonly data: Buffer) {}

  get done(): boolean {
    return this.at >= this.data.length;
  }
  uint8(): number {
    return this.data[this.at++] as number;
  }
  uint16(): number {
    const value = this.data.readUInt16LE(this.at);
    this.at += 2;
    return value;
  }
  uint32(): number {
    const value = this.data.readUInt32LE(this.at);
    this.at += 4;
    return value;
  }
  int32(): number {
    const value = this.data.readInt32LE(this.at);
    this.at += 4;
    return value;
  }
  float(): number {
    const value = this.data.readFloatLE(this.at);
    this.at += 4;
    return value;
  }
  /** A length-prefixed ASCII string, as the map format stores them. */
  string(): string {
    const length = this.uint16();
    const value = this.data.toString('latin1', this.at, this.at + length);
    this.at += length;
    return value;
  }
}
