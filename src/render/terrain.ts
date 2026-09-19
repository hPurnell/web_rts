/**
 * Terrain geometry from the heightfield.
 *
 * Two triangles per cell on the same north-west to south-east diagonal the
 * simulation samples along, so the ground a unit is drawn standing on is the
 * ground the simulation says it is standing on.
 *
 * The one thing this does that the tiered version could not is **smooth vertex
 * normals**. Flat cliffs and flat tops needed no shading continuity; a
 * landscape does, and averaging each corner's normal across the cells that
 * share it is the whole difference between terrain that reads as hills and
 * terrain that reads as a low-poly facet salad.
 *
 * Geometry is chunked so an editor brush rebuilds a block rather than the map.
 * Chunks share corner heights so they cannot crack — but a chunk's edge
 * normals depend on heights in the *next* chunk, so normals are computed from
 * the whole heightfield rather than from the chunk, or every seam lights
 * differently from the ground either side of it.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';
import type { Material } from '@babylonjs/core/Materials/material';

import type { World } from '../sim/world.ts';
import type { HeightOverrides } from '../sim/terrain.ts';
import { HEIGHT_MAX, cellCorners, cornerHeight, cornerStride } from '../sim/terrain.ts';
import { toFloat } from '../sim/fixed.ts';

/** Cells per chunk edge. */
export const CHUNK_SIZE = 32;
/** How far the map-edge skirt hangs below the lowest ground. */
const SKIRT_DROP = 4;

export interface TerrainChunk {
  readonly index: number;
  readonly cx0: number;
  readonly cy0: number;
  readonly cx1: number;
  readonly cy1: number;
  mesh: Mesh | null;
}

export interface Terrain {
  readonly chunks: readonly TerrainChunk[];
  readonly chunksX: number;
  readonly chunksY: number;
  readonly material: Material;
  rebuildChunk(index: number): void;
  rebuildChunks(indices: readonly number[]): void;
  /** Chunk indices touched by a cell rectangle, including seam neighbours. */
  chunksForRect(x0: number, y0: number, x1: number, y1: number): number[];
  triangleCount(): number;
  /** Point the terrain at a match's terrain changes, or null for the map's own. */
  setOverrides(overrides: HeightOverrides | null): void;
  dispose(): void;
}

/** World-space height of a corner, in renderer floats. */
export function cornerY(
  world: World,
  corner: number,
  overrides?: HeightOverrides | null,
): number {
  return toFloat(cornerHeight(world, corner, overrides));
}

/**
 * Render-space Y of a cell's four corners, in `cellCorners` order.
 *
 * Anything that lies on the ground — a decal, an overlay quad, a gizmo — needs
 * the same four numbers the terrain mesh used, or it will crawl under the
 * surface on one corner and float above it on another.
 */
export function cellCornerY(
  world: World,
  cell: number,
  overrides?: HeightOverrides | null,
): [number, number, number, number] {
  const [nw, ne, se, sw] = cellCorners(world, cell);
  return [
    cornerY(world, nw, overrides),
    cornerY(world, ne, overrides),
    cornerY(world, se, overrides),
    cornerY(world, sw, overrides),
  ];
}

/**
 * Smoothed normals for every corner of the heightfield.
 *
 * Central differences over the neighbouring corners: the normal of a
 * heightfield at a point is (-dh/dx, 1, -dh/dz) normalised, and taking the
 * difference across two cells rather than one is what averages the two faces
 * that meet there. Computed for the whole map because a chunk cannot see the
 * heights just past its edge, and a normal that stops at a chunk boundary is a
 * lighting seam.
 */
export function buildCornerNormals(
  world: World,
  overrides?: HeightOverrides | null,
): Float32Array {
  const stride = cornerStride(world);
  const rows = world.height + 1;
  const normals = new Float32Array(stride * rows * 3);
  const cellSize = toFloat(world.cellSize);

  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < stride; cx++) {
      const west = cornerY(world, cz * stride + Math.max(0, cx - 1), overrides);
      const east = cornerY(world, cz * stride + Math.min(stride - 1, cx + 1), overrides);
      const north = cornerY(world, Math.max(0, cz - 1) * stride + cx, overrides);
      const south = cornerY(world, Math.min(rows - 1, cz + 1) * stride + cx, overrides);

      // Span is two cells except at the edges, where it is one.
      const spanX = (cx === 0 || cx === stride - 1 ? 1 : 2) * cellSize;
      const spanZ = (cz === 0 || cz === rows - 1 ? 1 : 2) * cellSize;
      const dx = (east - west) / spanX;
      const dz = (south - north) / spanZ;

      const length = Math.hypot(dx, 1, dz) || 1;
      const offset = (cz * stride + cx) * 3;
      normals[offset] = -dx / length;
      normals[offset + 1] = 1 / length;
      normals[offset + 2] = -dz / length;
    }
  }
  return normals;
}

interface MeshBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  uv2s: number[];
  indices: number[];
}

/**
 * Build one chunk's geometry.
 *
 * Vertices are not shared between cells, because each cell needs its own UVs
 * for a tiling texture. Normals still come from the shared corner table, so
 * duplicated vertices at the same corner all carry the same normal and the
 * surface shades continuously anyway.
 */
export function buildChunkVertexData(
  world: World,
  normals: Float32Array,
  chunk: { cx0: number; cy0: number; cx1: number; cy1: number },
  overrides?: HeightOverrides | null,
): VertexData {
  const buf: MeshBuffers = { positions: [], normals: [], uvs: [], uv2s: [], indices: [] };
  const cellSize = toFloat(world.cellSize);
  const stride = cornerStride(world);
  const mapU = 1 / world.width;
  const mapV = 1 / world.height;

  const push = (cx: number, cz: number, u: number, v: number): void => {
    const corner = cz * stride + cx;
    buf.positions.push(cx * cellSize, cornerY(world, corner, overrides), cz * cellSize);
    buf.normals.push(
      normals[corner * 3] as number,
      normals[corner * 3 + 1] as number,
      normals[corner * 3 + 2] as number,
    );
    buf.uvs.push(u, v);
    buf.uv2s.push(cx * mapU, cz * mapV);
  };

  for (let cz = chunk.cy0; cz < chunk.cy1; cz++) {
    for (let cx = chunk.cx0; cx < chunk.cx1; cx++) {
      const base = buf.positions.length / 3;
      // NW, NE, SE, SW — the order the simulation's cellCorners uses.
      push(cx, cz, cx, cz);
      push(cx + 1, cz, cx + 1, cz);
      push(cx + 1, cz + 1, cx + 1, cz + 1);
      push(cx, cz + 1, cx, cz + 1);

      // Split NW-SE, matching heightAt.
      //
      // Wound so these faces survive back-face culling. Babylon's default is
      // left-handed, where a front face is clockwise as seen from the front —
      // which means the right-hand-rule cross product of a visible top face
      // points *down*, not up. Reversing these six indices makes the whole
      // terrain vanish and leaves only the skirt, which is not obvious from
      // looking at the code, so `emits top faces that survive back-face
      // culling` in test/terrain.test.ts asserts it directly.
      buf.indices.push(base, base + 2, base + 3, base, base + 1, base + 2);
    }
  }

  addSkirt(world, buf, chunk, cellSize, overrides);

  const data = new VertexData();
  data.positions = buf.positions;
  data.normals = buf.normals;
  data.uvs = buf.uvs;
  data.uvs2 = buf.uv2s;
  data.indices = buf.indices;
  return data;
}

/**
 * A wall hanging down from the map edge, so the horizon is not an open hole.
 * Only chunks that touch an edge grow one.
 */
function addSkirt(
  world: World,
  buf: MeshBuffers,
  chunk: { cx0: number; cy0: number; cx1: number; cy1: number },
  cellSize: number,
  overrides?: HeightOverrides | null,
): void {
  const stride = cornerStride(world);
  const bottom = -SKIRT_DROP;

  const quad = (
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    h0: number,
    h1: number,
    nx: number,
    nz: number,
  ): void => {
    const base = buf.positions.length / 3;
    buf.positions.push(x0, h0, z0, x1, h1, z1, x1, bottom, z1, x0, bottom, z0);
    for (let i = 0; i < 4; i++) {
      buf.normals.push(nx, 0, nz);
      buf.uv2s.push(x0 / (world.width * cellSize), z0 / (world.height * cellSize));
    }
    buf.uvs.push(0, h0, 1, h1, 1, 0, 0, 0);
    buf.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };

  const heightAtCorner = (cx: number, cz: number): number =>
    cornerY(world, cz * stride + cx, overrides);

  if (chunk.cy0 === 0) {
    for (let cx = chunk.cx0; cx < chunk.cx1; cx++) {
      quad(
        (cx + 1) * cellSize, 0, cx * cellSize, 0,
        heightAtCorner(cx + 1, 0), heightAtCorner(cx, 0), 0, -1,
      );
    }
  }
  if (chunk.cy1 === world.height) {
    const z = world.height * cellSize;
    for (let cx = chunk.cx0; cx < chunk.cx1; cx++) {
      quad(
        cx * cellSize, z, (cx + 1) * cellSize, z,
        heightAtCorner(cx, world.height), heightAtCorner(cx + 1, world.height), 0, 1,
      );
    }
  }
  if (chunk.cx0 === 0) {
    for (let cz = chunk.cy0; cz < chunk.cy1; cz++) {
      quad(
        0, cz * cellSize, 0, (cz + 1) * cellSize,
        heightAtCorner(0, cz), heightAtCorner(0, cz + 1), -1, 0,
      );
    }
  }
  if (chunk.cx1 === world.width) {
    const x = world.width * cellSize;
    for (let cz = chunk.cy0; cz < chunk.cy1; cz++) {
      quad(
        x, (cz + 1) * cellSize, x, cz * cellSize,
        heightAtCorner(world.width, cz + 1), heightAtCorner(world.width, cz), 1, 0,
      );
    }
  }
}

export function createTerrain(scene: Scene, world: World, material: Material): Terrain {
  const chunksX = Math.ceil(world.width / CHUNK_SIZE);
  const chunksY = Math.ceil(world.height / CHUNK_SIZE);
  let overrides: HeightOverrides | null = null;
  let normals = buildCornerNormals(world, overrides);

  const chunks: TerrainChunk[] = [];
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) {
      chunks.push({
        index: cy * chunksX + cx,
        cx0: cx * CHUNK_SIZE,
        cy0: cy * CHUNK_SIZE,
        cx1: Math.min((cx + 1) * CHUNK_SIZE, world.width),
        cy1: Math.min((cy + 1) * CHUNK_SIZE, world.height),
        mesh: null,
      });
    }
  }

  const build = (chunk: TerrainChunk): void => {
    chunk.mesh?.dispose();
    const mesh = new Mesh(`terrain_${chunk.index}`, scene);
    buildChunkVertexData(world, normals, chunk, overrides).applyToMesh(mesh, false);
    mesh.material = material;
    mesh.isPickable = false; // picking marches the heightfield instead (M7)
    mesh.freezeWorldMatrix();
    chunk.mesh = mesh;
  };

  for (const chunk of chunks) build(chunk);

  return {
    chunks,
    chunksX,
    chunksY,
    material,
    rebuildChunk(index) {
      this.rebuildChunks([index]);
    },
    rebuildChunks(indices) {
      // Normals span chunk boundaries, so they are rebuilt for the map rather
      // than per chunk. At map sizes this is a few hundred microseconds and
      // removes a whole class of seam bug.
      normals = buildCornerNormals(world, overrides);
      for (const index of indices) {
        const chunk = chunks[index];
        if (chunk) build(chunk);
      }
    },
    chunksForRect(x0, y0, x1, y1) {
      // One chunk of margin: an edit at a seam changes the normals the
      // neighbouring chunk's edge vertices carry.
      const gx0 = Math.max(0, Math.floor((x0 - 1) / CHUNK_SIZE));
      const gy0 = Math.max(0, Math.floor((y0 - 1) / CHUNK_SIZE));
      const gx1 = Math.min(chunksX - 1, Math.floor((x1 + 1) / CHUNK_SIZE));
      const gy1 = Math.min(chunksY - 1, Math.floor((y1 + 1) / CHUNK_SIZE));
      const out: number[] = [];
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) out.push(gy * chunksX + gx);
      }
      return out;
    },
    triangleCount() {
      let total = 0;
      for (const chunk of chunks) {
        const indices = chunk.mesh?.getIndices();
        if (indices) total += indices.length / 3;
      }
      return total;
    },
    setOverrides(next) {
      overrides = next;
      this.rebuildChunks(chunks.map((chunk) => chunk.index));
    },
    dispose() {
      for (const chunk of chunks) {
        chunk.mesh?.dispose();
        chunk.mesh = null;
      }
    },
  };
}

/** The highest ground on the map, for framing the camera and the minimap. */
export function maxTerrainHeight(world: World): number {
  let highest = 0;
  for (let i = 0; i < world.heights.length; i++) {
    const h = world.heights[i] as number;
    if (h > highest) highest = h;
  }
  // A floor of one unit: the shader divides by this to get a 0..1 elevation
  // tint, and a perfectly flat map would otherwise turn a rounding error into
  // a full-range colour ramp.
  return Math.max(1, toFloat(Math.min(highest, HEIGHT_MAX)));
}

/** Exposed for tests: the vertex buffer kinds a terrain mesh must carry. */
export const REQUIRED_BUFFERS = [
  VertexBuffer.PositionKind,
  VertexBuffer.NormalKind,
  VertexBuffer.UVKind,
  VertexBuffer.UV2Kind,
] as const;
