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
 * deliberately absent: PLAN.md G13 is the milestone that would need it, and it
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
}

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

    // Texture coordinates live under the first material pass's texture stage.
    const uvs: { u: number; v: number }[] = [];
    const texcoords = findChunk(mesh.children, CHUNK.STAGE_TEXCOORDS);
    if (texcoords) {
      for (let i = 0; i + 8 <= texcoords.data.length; i += 8) {
        uvs.push({ u: texcoords.data.readFloatLE(i), v: texcoords.data.readFloatLE(i + 4) });
      }
    }

    const textures: string[] = [];
    for (const texture of findChunks(mesh.children, CHUNK.TEXTURE_NAME)) {
      const value = readName(texture.data, 0, texture.data.length);
      if (value.length > 0) textures.push(value);
    }

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
    });
  }

  return meshes;
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
