/**
 * Reading Westwood W3D models.
 *
 * A chunk tree, little-endian throughout:
 *
 * ```
 * uint32 type
 * uint32 size      bit 31 set means the payload is itself chunks
 * bytes  payload
 * ```
 *
 * Verified against the shipped models rather than from documentation. Only what
 * this project needs is decoded — meshes, their materials and textures, and the
 * HLOD that names sub-objects so a turret can be told from a hull. Animation is
 * deliberately absent: PLAN.md G18 is the milestone that would need it, and it
 * is optional.
 */
import { readFileSync } from 'node:fs';

/** Chunk ids this pipeline cares about. Everything else is walked past. */
export const CHUNK = {
  MESH: 0x00000000,
  VERTICES: 0x00000002,
  VERTEX_NORMALS: 0x00000003,
  MESH_USER_TEXT: 0x0000000c,
  VERTEX_INFLUENCES: 0x0000000e,
  MESH_HEADER3: 0x0000001f,
  TRIANGLES: 0x00000020,
  VERTEX_SHADE_INDICES: 0x00000022,
  PRELIT_UNLIT: 0x00000023,
  PRELIT_VERTEX: 0x00000024,
  MATERIAL_INFO: 0x00000028,
  SHADERS: 0x00000029,
  VERTEX_MATERIALS: 0x0000002a,
  VERTEX_MATERIAL: 0x0000002b,
  VERTEX_MATERIAL_NAME: 0x0000002c,
  VERTEX_MATERIAL_INFO: 0x0000002d,
  TEXTURES: 0x00000030,
  TEXTURE: 0x00000031,
  TEXTURE_NAME: 0x00000032,
  TEXTURE_INFO: 0x00000033,
  MATERIAL_PASS: 0x00000038,
  VERTEX_MATERIAL_IDS: 0x00000039,
  SHADER_IDS: 0x0000003a,
  DCG: 0x0000003b,
  TEXTURE_STAGE: 0x00000048,
  TEXTURE_IDS: 0x00000049,
  STAGE_TEXCOORDS: 0x0000004a,
  HIERARCHY: 0x00000100,
  HIERARCHY_HEADER: 0x00000101,
  PIVOTS: 0x00000102,
  HLOD: 0x00000700,
  HLOD_HEADER: 0x00000701,
  HLOD_LOD_ARRAY: 0x00000702,
  HLOD_SUB_OBJECT_ARRAY_HEADER: 0x00000703,
  HLOD_SUB_OBJECT: 0x00000704,
  ANIMATION: 0x00000200,
  ANIMATION_HEADER: 0x00000201,
  ANIMATION_CHANNEL: 0x00000202,
  BIT_CHANNEL: 0x00000203,
  COMPRESSED_ANIMATION: 0x00000280,
} as const;

export interface Chunk {
  readonly type: number;
  readonly data: Buffer;
  readonly children: readonly Chunk[];
}

const HAS_SUBCHUNKS = 0x80000000;

/** Walk a chunk tree out of a buffer. */
export function parseChunks(buffer: Buffer, start = 0, end = buffer.length): Chunk[] {
  const chunks: Chunk[] = [];
  let cursor = start;

  while (cursor + 8 <= end) {
    const type = buffer.readUInt32LE(cursor);
    const raw = buffer.readUInt32LE(cursor + 4);
    const size = raw & ~HAS_SUBCHUNKS;
    const body = cursor + 8;
    if (body + size > end) break; // truncated tail: take what parsed

    const data = buffer.subarray(body, body + size);
    // The subchunk flag is a hint, not a guarantee: a few chunks set it with a
    // payload that does not parse as chunks. Try, and fall back to raw bytes.
    let children: Chunk[] = [];
    if ((raw & HAS_SUBCHUNKS) !== 0) {
      try {
        children = parseChunks(buffer, body, body + size);
      } catch {
        children = [];
      }
    }

    chunks.push({ type, data, children });
    cursor = body + size;
  }

  return chunks;
}

export function readW3D(path: string): Chunk[] {
  return parseChunks(readFileSync(path));
}

/** Depth-first search for the first chunk of a type. */
export function findChunk(chunks: readonly Chunk[], type: number): Chunk | null {
  for (const chunk of chunks) {
    if (chunk.type === type) return chunk;
    const nested = findChunk(chunk.children, type);
    if (nested) return nested;
  }
  return null;
}

/** Every chunk of a type, at any depth. */
export function findChunks(chunks: readonly Chunk[], type: number): Chunk[] {
  const found: Chunk[] = [];
  for (const chunk of chunks) {
    if (chunk.type === type) found.push(chunk);
    found.push(...findChunks(chunk.children, type));
  }
  return found;
}

/** A fixed-length NUL-padded name, as W3D stores them. */
export function readName(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);
  const stop = end < 0 || end > offset + length ? offset + length : end;
  return buffer.toString('latin1', offset, stop);
}

export interface W3DVertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface W3DMesh {
  readonly name: string;
  readonly containerName: string;
  readonly vertices: readonly W3DVertex[];
  readonly normals: readonly W3DVertex[];
  /** One uv per vertex, from the first texture stage. Empty when untextured. */
  readonly uvs: readonly { u: number; v: number }[];
  /** Triangle vertex indices, three per face. */
  readonly indices: readonly number[];
  /** Texture file names referenced by this mesh, in declaration order. */
  readonly textures: readonly string[];
  /** True when the mesh carries vertex influences, i.e. it is skinned. */
  readonly skinned: boolean;
  /**
   * True when the chosen pass blends additively — destination `ONE` in its
   * W3D shader. Lights and glows are drawn this way, and drawn opaque they
   * are dull coloured cards instead of lights.
   */
  readonly additive: boolean;
}

/** `DSTBLEND_ONE` in `shader.h`: the destination kept and the fragment added. */
const DSTBLEND_ONE = 1;
/** Bytes per `W3dShaderStruct`; `DestBlend` is its fourth. */
const SHADER_SIZE = 16;
const SHADER_DEST_BLEND = 3;

/**
 * Decode the meshes in a model.
 *
 * MESH_HEADER3 is 116 bytes: version, attributes, then a 16-byte mesh name and
 * a 16-byte container name, then counts. Only the names and the skin flag are
 * taken from it; the geometry chunks carry their own counts in their sizes.
 */
export function readMeshes(chunks: readonly Chunk[]): W3DMesh[] {
  const meshes: W3DMesh[] = [];

  for (const mesh of findChunks(chunks, CHUNK.MESH)) {
    const header = findChunk(mesh.children, CHUNK.MESH_HEADER3);
    if (!header) continue;

    const attributes = header.data.readUInt32LE(4);
    const name = readName(header.data, 8, 16);
    const containerName = readName(header.data, 24, 16);

    const vertexChunk = findChunk(mesh.children, CHUNK.VERTICES);
    const normalChunk = findChunk(mesh.children, CHUNK.VERTEX_NORMALS);
    const triangleChunk = findChunk(mesh.children, CHUNK.TRIANGLES);
    if (!vertexChunk || !triangleChunk) continue;

    const vertices = readVectors(vertexChunk.data);
    const normals = normalChunk ? readVectors(normalChunk.data) : [];

    // A triangle is 32 bytes: three uint32 indices, a uint32 attribute, a
    // float3 normal and a float distance.
    const indices: number[] = [];
    for (let i = 0; i + 32 <= triangleChunk.data.length; i += 32) {
      indices.push(
        triangleChunk.data.readUInt32LE(i),
        triangleChunk.data.readUInt32LE(i + 4),
        triangleChunk.data.readUInt32LE(i + 8),
      );
    }

    // Every texture the mesh names, in declaration order. This is the table
    // a pass's TEXTURE_IDS indexes into; it is not a priority order.
    const named: string[] = [];
    for (const texture of findChunks(mesh.children, CHUNK.TEXTURE_NAME)) {
      const value = readName(texture.data, 0, texture.data.length);
      if (value.length > 0) named.push(value);
    }

    // The diffuse texture and its coordinates, taken from the *same* material
    // pass — which is the whole point of doing it this way.
    //
    // A mesh with two passes has a reflection or detail map on the first and
    // the real texture on the second: `LAKEDUSK.tga`, a photograph of a sky,
    // is the first pass of 395 of the 768 multi-pass meshes in the shipped
    // art, and most of the rest are `*_n` maps. Taking the first texture name
    // in the chunk tree therefore wallpapers every two-pass building and
    // vehicle with clouds, which is exactly what it did.
    //
    // Passes are searched last-first because the diffuse is the later one, and
    // a pass only qualifies if it carries one texture coordinate per vertex —
    // so the coordinates used are always the ones authored for the texture
    // used. Unset slots in the shipped art carry a near-FLT_MAX sentinel,
    // which is perfectly finite, so the values are bounded rather than merely
    // finite-checked.
    const uvs: { u: number; v: number }[] = [];
    const textures: string[] = [];
    let additive = false;
    const shaders = findChunk(mesh.children, CHUNK.SHADERS);
    const passes = findChunks(mesh.children, CHUNK.MATERIAL_PASS);
    for (let p = passes.length - 1; p >= 0 && uvs.length === 0; p--) {
      const stage = findChunks((passes[p] as Chunk).children, CHUNK.TEXTURE_STAGE)[0];
      if (!stage) continue;
      const coords = findChunk(stage.children, CHUNK.STAGE_TEXCOORDS);
      if (!coords || coords.data.length !== vertices.length * 8) continue;

      const ids = findChunk(stage.children, CHUNK.TEXTURE_IDS);
      const id = ids && ids.data.length >= 4 ? ids.data.readUInt32LE(0) : 0;
      const chosen = named[id];
      if (chosen) textures.push(chosen);

      for (let i = 0; i + 8 <= coords.data.length; i += 8) {
        uvs.push({ u: sane(coords.data.readFloatLE(i)), v: sane(coords.data.readFloatLE(i + 4)) });
      }

      // The shader this pass draws with, which says how it blends.
      const shaderIds = findChunk((passes[p] as Chunk).children, CHUNK.SHADER_IDS);
      const shaderId = shaderIds && shaderIds.data.length >= 4 ? shaderIds.data.readUInt32LE(0) : 0;
      const at = shaderId * SHADER_SIZE + SHADER_DEST_BLEND;
      additive = !!shaders && at < shaders.data.length && shaders.data[at] === DSTBLEND_ONE;
    }

    // A mesh with no usable pass still declares its textures, and the effect
    // filters downstream read them.
    for (const value of named) if (!textures.includes(value)) textures.push(value);

    meshes.push({
      name,
      containerName,
      vertices,
      normals,
      uvs,
      indices,
      textures,
      // Bit 0 of the attribute word distinguishes a skin; the influences chunk
      // being present is the more reliable tell, so both are consulted.
      skinned:
        findChunk(mesh.children, CHUNK.VERTEX_INFLUENCES) !== null || (attributes & 0x00000002) !== 0,
      additive,
    });
  }

  return meshes;
}

/** Texture coordinates tile, but never by a thousand. */
function sane(value: number): number {
  return Number.isFinite(value) && Math.abs(value) < 1000 ? value : 0;
}

function readVectors(data: Buffer): W3DVertex[] {
  const out: W3DVertex[] = [];
  for (let i = 0; i + 12 <= data.length; i += 12) {
    out.push({ x: data.readFloatLE(i), y: data.readFloatLE(i + 4), z: data.readFloatLE(i + 8) });
  }
  return out;
}

export interface W3DPivot {
  readonly name: string;
  readonly parent: number;
  readonly translation: W3DVertex;
  /** Rotation quaternion, x y z w as stored. */
  readonly rotation: readonly [number, number, number, number];
}

/**
 * The skeleton, which is what says where a turret sits.
 *
 * A pivot is 60 bytes: a 16-byte name, a uint32 parent index, a float3
 * translation, a float3 of Euler angles and a float4 quaternion. Generals
 * vehicles put their turret on a pivot named `TURRET`, and the sub-object
 * array in the HLOD binds a mesh to it.
 */
export function readPivots(chunks: readonly Chunk[]): W3DPivot[] {
  const pivotChunk = findChunk(chunks, CHUNK.PIVOTS);
  if (!pivotChunk) return [];

  const pivots: W3DPivot[] = [];
  for (let i = 0; i + 60 <= pivotChunk.data.length; i += 60) {
    pivots.push({
      name: readName(pivotChunk.data, i, 16),
      parent: pivotChunk.data.readInt32LE(i + 16),
      translation: {
        x: pivotChunk.data.readFloatLE(i + 20),
        y: pivotChunk.data.readFloatLE(i + 24),
        z: pivotChunk.data.readFloatLE(i + 28),
      },
      rotation: [
        pivotChunk.data.readFloatLE(i + 44),
        pivotChunk.data.readFloatLE(i + 48),
        pivotChunk.data.readFloatLE(i + 52),
        pivotChunk.data.readFloatLE(i + 56),
      ],
    });
  }
  return pivots;
}

export interface W3DSubObject {
  readonly boneIndex: number;
  readonly meshName: string;
}

/** Which mesh is attached to which bone, from the HLOD. */
export function readSubObjects(chunks: readonly Chunk[]): W3DSubObject[] {
  const out: W3DSubObject[] = [];
  for (const sub of findChunks(chunks, CHUNK.HLOD_SUB_OBJECT)) {
    if (sub.data.length < 36) continue;
    out.push({
      boneIndex: sub.data.readUInt32LE(0),
      meshName: readName(sub.data, 4, 32),
    });
  }
  return out;
}

/** `ANIM_CHANNEL_*` in `w3d_file.h`: which component a channel drives. */
const CHANNEL = { X: 0, Y: 1, Z: 2, Q: 6 } as const;

/** One pivot's motion: per-axis translation, a rotation, and visibility. */
export interface PivotMotion {
  readonly x?: { first: number; values: Float32Array };
  readonly y?: { first: number; values: Float32Array };
  readonly z?: { first: number; values: Float32Array };
  /** Quaternions, four floats a frame: x y z w. */
  readonly rotation?: { first: number; values: Float32Array };
  readonly visibility?: { first: number; last: number; fallback: boolean; bits: Uint8Array };
}

export interface W3DAnimation {
  readonly name: string;
  readonly hierarchy: string;
  readonly frames: number;
  readonly frameRate: number;
  /** Indexed by pivot. A pivot with no entry is not animated. */
  readonly motion: ReadonlyMap<number, PivotMotion>;
}

/**
 * Read an uncompressed animation, following `HRawAnimClass` in the source.
 *
 * A channel is keyed over `[first, last]` and holds nothing outside it:
 * translation and rotation fall back to none there, and visibility to the
 * channel's default. Visibility bits are least-significant first, as
 * `BitChannelClass::Get_Bit` reads them.
 *
 * Compressed animations are a different chunk and are not read; the caller
 * gets null and the part stays still.
 */
export function readAnimation(chunks: readonly Chunk[]): W3DAnimation | null {
  const anim = findChunk(chunks, CHUNK.ANIMATION);
  if (!anim) return null;
  const header = findChunk(anim.children, CHUNK.ANIMATION_HEADER);
  if (!header || header.data.length < 44) return null;

  const motion = new Map<number, {
    x?: { first: number; values: Float32Array };
    y?: { first: number; values: Float32Array };
    z?: { first: number; values: Float32Array };
    rotation?: { first: number; values: Float32Array };
    visibility?: { first: number; last: number; fallback: boolean; bits: Uint8Array };
  }>();
  const of = (pivot: number) => {
    let entry = motion.get(pivot);
    if (!entry) {
      entry = {};
      motion.set(pivot, entry);
    }
    return entry;
  };

  for (const channel of findChunks(anim.children, CHUNK.ANIMATION_CHANNEL)) {
    const d = channel.data;
    if (d.length < 12) continue;
    const first = d.readUInt16LE(0);
    const last = d.readUInt16LE(2);
    const width = d.readUInt16LE(4);
    const kind = d.readUInt16LE(6);
    const pivot = d.readUInt16LE(8);
    const count = (last - first + 1) * width;
    if (count <= 0 || 12 + count * 4 > d.length) continue;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) values[i] = d.readFloatLE(12 + i * 4);

    const entry = of(pivot);
    if (kind === CHANNEL.X && width === 1) entry.x = { first, values };
    else if (kind === CHANNEL.Y && width === 1) entry.y = { first, values };
    else if (kind === CHANNEL.Z && width === 1) entry.z = { first, values };
    else if (kind === CHANNEL.Q && width === 4) entry.rotation = { first, values };
  }

  for (const channel of findChunks(anim.children, CHUNK.BIT_CHANNEL)) {
    const d = channel.data;
    if (d.length < 9) continue;
    const first = d.readUInt16LE(0);
    const last = d.readUInt16LE(2);
    const kind = d.readUInt16LE(4);
    const pivot = d.readUInt16LE(6);
    if (kind !== 0) continue; // BIT_CHANNEL_VIS; the time-coded form is not used here
    of(pivot).visibility = { first, last, fallback: d[8] !== 0, bits: d.subarray(9) };
  }

  return {
    name: readName(header.data, 4, 16),
    hierarchy: readName(header.data, 20, 16),
    frames: header.data.readUInt32LE(36),
    frameRate: header.data.readUInt32LE(40),
    motion,
  };
}

/** A pivot's translation at a frame: nothing outside its keyed range. */
export function translationAt(motion: PivotMotion | undefined, frame: number): W3DVertex {
  const at = (c?: { first: number; values: Float32Array }): number => {
    if (!c) return 0;
    const i = frame - c.first;
    return i >= 0 && i < c.values.length ? (c.values[i] as number) : 0;
  };
  return { x: at(motion?.x), y: at(motion?.y), z: at(motion?.z) };
}

/** A pivot's rotation at a frame, x y z w: identity outside its keyed range. */
export function rotationAt(
  motion: PivotMotion | undefined,
  frame: number,
): readonly [number, number, number, number] {
  const c = motion?.rotation;
  if (!c) return [0, 0, 0, 1];
  const i = (frame - c.first) * 4;
  if (i < 0 || i + 4 > c.values.length) return [0, 0, 0, 1];
  return [c.values[i] as number, c.values[i + 1] as number, c.values[i + 2] as number, c.values[i + 3] as number];
}

/** Whether a pivot is shown at a frame; shown if it has no channel at all. */
export function visibleAt(motion: PivotMotion | undefined, frame: number): boolean {
  const c = motion?.visibility;
  if (!c) return true;
  if (frame < c.first || frame > c.last) return c.fallback;
  const bit = frame - c.first;
  return ((c.bits[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0;
}
