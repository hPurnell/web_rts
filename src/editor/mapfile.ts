/**
 * The .rtsmap binary format.
 *
 * Header, then the two terrain grids as raw bytes, then a JSON tail for the
 * authored lists. The grids dominate the file and are copied straight in and
 * out, so saving a 512x512 map is two memcpys rather than half a million
 * JSON numbers.
 *
 *   offset  size  field
 *        0     4  magic "RTSM"
 *        4     2  format version (uint16 LE)
 *        6     2  reserved, must be zero
 *        8     2  width  (uint16 LE)
 *       10     2  height (uint16 LE)
 *       12     4  cellSize, Q16.16 (int32 LE)
 *       16     4  JSON tail length in bytes (uint32 LE)
 *       20   w*h  tier grid
 *   20+w*h   w*h  flag grid
 *        …     …  JSON tail: resource nodes and start locations
 */
import type { ResourceNode, StartLocation, World } from '../sim/world.ts';
import { MAX_DIMENSION, createWorld } from '../sim/world.ts';
import { ONE } from '../sim/fixed.ts';

export const MAGIC = 'RTSM';
/** Bump when the layout changes; decode refuses anything it does not know. */
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 20;
export const MAP_EXTENSION = '.rtsmap';

interface JsonTail {
  readonly resourceNodes: ResourceNode[];
  readonly startLocations: StartLocation[];
}

export class MapFormatError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'MapFormatError';
  }
}

export function encodeMap(world: World): Uint8Array {
  const cells = world.width * world.height;
  const tail: JsonTail = {
    resourceNodes: world.resourceNodes.map((n) => ({ ...n })),
    startLocations: world.startLocations.map((s) => ({ ...s })),
  };
  const json = new TextEncoder().encode(JSON.stringify(tail));

  const bytes = new Uint8Array(HEADER_BYTES + cells * 2 + json.length);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < 4; i++) bytes[i] = MAGIC.charCodeAt(i);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, world.width, true);
  view.setUint16(10, world.height, true);
  view.setInt32(12, world.cellSize, true);
  view.setUint32(16, json.length, true);

  bytes.set(world.tier, HEADER_BYTES);
  bytes.set(world.flags, HEADER_BYTES + cells);
  bytes.set(json, HEADER_BYTES + cells * 2);
  return bytes;
}

export function decodeMap(bytes: Uint8Array): World {
  if (bytes.length < HEADER_BYTES) {
    throw new MapFormatError('This file is too short to be a map.', 'truncated');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) {
      throw new MapFormatError('This is not an RTS map file.', 'magic');
    }
  }

  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) {
    throw new MapFormatError(
      `This map was saved in format version ${version}, but this build reads version ${FORMAT_VERSION}.`,
      'version',
    );
  }

  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new MapFormatError(`Map dimensions ${width}x${height} are out of range.`, 'dimensions');
  }

  const cellSize = view.getInt32(12, true) || ONE;
  const jsonLength = view.getUint32(16, true);
  const cells = width * height;
  const expected = HEADER_BYTES + cells * 2 + jsonLength;
  if (bytes.length !== expected) {
    throw new MapFormatError(
      `This map file is ${bytes.length} bytes but its header describes ${expected}.`,
      'truncated',
    );
  }

  const world = createWorld({ width, height, cellSize });
  world.tier.set(bytes.subarray(HEADER_BYTES, HEADER_BYTES + cells));
  world.flags.set(bytes.subarray(HEADER_BYTES + cells, HEADER_BYTES + cells * 2));

  if (jsonLength > 0) {
    const text = new TextDecoder().decode(bytes.subarray(HEADER_BYTES + cells * 2));
    let tail: Partial<JsonTail>;
    try {
      tail = JSON.parse(text) as Partial<JsonTail>;
    } catch {
      throw new MapFormatError('The map file has a corrupt data section.', 'json');
    }
    world.resourceNodes = sanitizeNodes(tail.resourceNodes, cells);
    world.startLocations = sanitizeStarts(tail.startLocations, cells);
  }

  return world;
}

/**
 * A map file is untrusted input: a hand-edited or corrupt tail must not put
 * out-of-range cell indices into world state, where every consumer would then
 * have to defend against them.
 */
function sanitizeNodes(nodes: unknown, cells: number): ResourceNode[] {
  if (!Array.isArray(nodes)) return [];
  const out: ResourceNode[] = [];
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue;
    const node = raw as Partial<ResourceNode>;
    const cell = Number(node.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell >= cells) continue;
    out.push({
      cell,
      type: node.type === 1 ? 1 : 0,
      amount: Math.max(0, Math.trunc(Number(node.amount) || 0)),
    });
  }
  return out;
}

function sanitizeStarts(starts: unknown, cells: number): StartLocation[] {
  if (!Array.isArray(starts)) return [];
  const out: StartLocation[] = [];
  for (const raw of starts) {
    if (typeof raw !== 'object' || raw === null) continue;
    const cell = Number((raw as Partial<StartLocation>).cell);
    if (!Number.isInteger(cell) || cell < 0 || cell >= cells) continue;
    out.push({ cell });
  }
  return out;
}

/** A filename that sorts sensibly and cannot collide by accident. */
export function suggestFilename(name = 'map'): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${name}-${stamp}${MAP_EXTENSION}`;
}
