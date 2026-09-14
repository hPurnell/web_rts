/**
 * Terrain geometry built from world state.
 *
 * Discrete cliffs mean the surface is not a heightfield: each cell is a flat
 * quad at its tier's height, ramps slope between tiers, and vertical walls fill
 * the gaps at tier boundaries. Everything is driven by one function,
 * `cornerHeights`, so tops and walls can never disagree about where a cell's
 * surface is.
 *
 * Geometry is chunked so an editor brush rebuilds a block rather than the map.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';
import type { Material } from '@babylonjs/core/Materials/material';

import type { World } from '../sim/world.ts';
import { RAMP, cellIndex, inBounds } from '../sim/world.ts';
import { toFloat } from '../sim/fixed.ts';

/** World-space height of one tier step. */
export const TIER_HEIGHT = 2;
/** Cells per chunk edge. */
export const CHUNK_SIZE = 32;

/** Corner order around a cell: NW, NE, SE, SW (y increasing southward). */
const CORNER_OFFSETS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

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
  /** Rebuild one chunk's mesh in place. */
  rebuildChunk(index: number): void;
  /** Rebuild several chunks, solving ramps once for the whole batch. */
  rebuildChunks(indices: readonly number[], options?: { resolveRamps?: boolean }): void;
  /** The ramp slopes the current meshes were built from. */
  ramps(): RampSlopes;
  /** Chunk indices touched by a cell rectangle, including seam neighbours. */
  chunksForRect(x0: number, y0: number, x1: number, y1: number): number[];
  /** Total triangles across all chunks — used by tests and the dev overlay. */
  triangleCount(): number;
  dispose(): void;
}

/**
 * Height of one corner of one cell.
 *
 * Flat cells sit at their tier. Ramp cells interpolate along the ramp's axis,
 * which is derived from the ramp group as a whole: a four-cell ramp has middle
 * cells with no local gradient to read, so the direction has to come from
 * where the group touches high ground versus low ground.
 */
export interface RampSlopes {
  /** Per ramp cell: the four corner heights, in CORNER_OFFSETS order. */
  readonly byCell: Map<number, [number, number, number, number]>;
}

export function tierHeight(tier: number): number {
  return tier * TIER_HEIGHT;
}

/** Group connected ramp cells and solve each group's slope. */
export function solveRamps(world: World): RampSlopes {
  const byCell = new Map<number, [number, number, number, number]>();
  const seen = new Uint8Array(world.width * world.height);

  for (let start = 0; start < seen.length; start++) {
    if (seen[start] === 1) continue;
    if (((world.flags[start] as number) & RAMP) === 0) continue;

    // Flood-fill this ramp group.
    const group: number[] = [];
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const cell = queue.pop() as number;
      group.push(cell);
      const cx = cell % world.width;
      const cy = (cell / world.width) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inBounds(world, nx, ny)) continue;
        const next = ny * world.width + nx;
        if (seen[next] === 1) continue;
        if (((world.flags[next] as number) & RAMP) === 0) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }

    solveRampGroup(world, group, byCell);
  }

  return { byCell };
}

function solveRampGroup(
  world: World,
  group: readonly number[],
  out: Map<number, [number, number, number, number]>,
): void {
  // Find the tiers this ramp touches and the centroids of the cells touching
  // each, which gives the direction the ramp runs in.
  let hiTier = -Infinity;
  let loTier = Infinity;
  const hiPoints: [number, number][] = [];
  const loPoints: [number, number][] = [];
  const neighbours: { cell: number; tier: number; x: number; y: number }[] = [];

  for (const cell of group) {
    const cx = cell % world.width;
    const cy = (cell / world.width) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(world, nx, ny)) continue;
      const next = ny * world.width + nx;
      if (((world.flags[next] as number) & RAMP) !== 0) continue;
      const tier = world.tier[next] as number;
      neighbours.push({ cell: next, tier, x: cx + 0.5, y: cy + 0.5 });
      if (tier > hiTier) hiTier = tier;
      if (tier < loTier) loTier = tier;
    }
  }

  if (neighbours.length === 0 || hiTier === loTier) {
    // A ramp that connects nothing, or connects equal ground: leave it flat.
    for (const cell of group) {
      const h = tierHeight(world.tier[cell] as number);
      out.set(cell, [h, h, h, h]);
    }
    return;
  }

  for (const n of neighbours) {
    if (n.tier === hiTier) hiPoints.push([n.x, n.y]);
    else if (n.tier === loTier) loPoints.push([n.x, n.y]);
  }

  const hiCentre = centroid(hiPoints);
  const loCentre = centroid(loPoints);
  let axisX = hiCentre[0] - loCentre[0];
  let axisY = hiCentre[1] - loCentre[1];
  const axisLength = Math.hypot(axisX, axisY);
  if (axisLength < 1e-6) {
    // Degenerate: high and low ground meet the ramp from the same place.
    for (const cell of group) {
      const h = tierHeight(world.tier[cell] as number);
      out.set(cell, [h, h, h, h]);
    }
    return;
  }
  axisX /= axisLength;
  axisY /= axisLength;

  // Project every corner of the group onto the axis and normalise, so the ramp
  // reaches exactly the low tier at one end and the high tier at the other.
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const cell of group) {
    const cx = cell % world.width;
    const cy = (cell / world.width) | 0;
    for (const [ox, oy] of CORNER_OFFSETS) {
      const p = (cx + ox) * axisX + (cy + oy) * axisY;
      if (p < minProj) minProj = p;
      if (p > maxProj) maxProj = p;
    }
  }
  const span = maxProj - minProj || 1;
  const loHeight = tierHeight(loTier);
  const hiHeight = tierHeight(hiTier);

  for (const cell of group) {
    const cx = cell % world.width;
    const cy = (cell / world.width) | 0;
    const heights = CORNER_OFFSETS.map(([ox, oy]) => {
      const t = ((cx + ox) * axisX + (cy + oy) * axisY - minProj) / span;
      return loHeight + (hiHeight - loHeight) * t;
    }) as [number, number, number, number];
    out.set(cell, heights);
  }
}

function centroid(points: readonly [number, number][]): [number, number] {
  if (points.length === 0) return [0, 0];
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/** The four corner heights of a cell, in CORNER_OFFSETS order. */
export function cornerHeights(
  world: World,
  ramps: RampSlopes,
  cell: number,
): [number, number, number, number] {
  const ramp = ramps.byCell.get(cell);
  if (ramp) return ramp;
  const h = tierHeight(world.tier[cell] as number);
  return [h, h, h, h];
}

interface MeshBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  uv2s: number[];
  indices: number[];
}

function pushQuad(
  buf: MeshBuffers,
  corners: readonly [number, number, number][],
  uvs: readonly [number, number][],
  uv2s: readonly [number, number][],
): void {
  const base = buf.positions.length / 3;
  // Face normal from the first triangle; every quad here is planar enough.
  const [a, b, c] = [corners[0] as [number, number, number], corners[1] as [number, number, number], corners[2] as [number, number, number]];
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;

  for (let i = 0; i < 4; i++) {
    const p = corners[i] as [number, number, number];
    buf.positions.push(p[0], p[1], p[2]);
    buf.normals.push(nx, ny, nz);
    const uv = uvs[i] as [number, number];
    buf.uvs.push(uv[0], uv[1]);
    const uv2 = uv2s[i] as [number, number];
    buf.uv2s.push(uv2[0], uv2[1]);
  }
  buf.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/**
 * Build one chunk's geometry.
 *
 * Walls are emitted by the *higher* of the two cells at a boundary, and read
 * the neighbour straight out of the world grid, so a wall on a chunk seam is
 * produced exactly once and is correct without the neighbouring chunk existing.
 */
export function buildChunkVertexData(
  world: World,
  ramps: RampSlopes,
  chunk: { cx0: number; cy0: number; cx1: number; cy1: number },
): VertexData {
  const buf: MeshBuffers = { positions: [], normals: [], uvs: [], uv2s: [], indices: [] };
  const cellSize = toFloat(world.cellSize);
  const mapU = 1 / world.width;
  const mapV = 1 / world.height;

  for (let cy = chunk.cy0; cy < chunk.cy1; cy++) {
    for (let cx = chunk.cx0; cx < chunk.cx1; cx++) {
      const cell = cellIndex(world, cx, cy);
      if (cell < 0) continue;
      const h = cornerHeights(world, ramps, cell);
      const x0 = cx * cellSize;
      const x1 = (cx + 1) * cellSize;
      const z0 = cy * cellSize;
      const z1 = (cy + 1) * cellSize;

      // Top face, wound SW -> SE -> NE -> NW so the face normal points up.
      // pushQuad derives the normal from the first three corners, and the wall
      // quads below use the same convention, so winding stays consistent.
      // uv tiles once per cell; uv2 addresses the whole map, which is what the
      // fog texture samples in M23.
      pushQuad(
        buf,
        [
          [x0, h[3], z1],
          [x1, h[2], z1],
          [x1, h[1], z0],
          [x0, h[0], z0],
        ],
        [
          [cx, cy + 1],
          [cx + 1, cy + 1],
          [cx + 1, cy],
          [cx, cy],
        ],
        [
          [cx * mapU, (cy + 1) * mapV],
          [(cx + 1) * mapU, (cy + 1) * mapV],
          [(cx + 1) * mapU, cy * mapV],
          [cx * mapU, cy * mapV],
        ],
      );

      // Walls: one per edge where this cell stands above its neighbour.
      emitWall(buf, world, ramps, cx, cy, 0, h, cellSize, mapU, mapV); // north edge
      emitWall(buf, world, ramps, cx, cy, 1, h, cellSize, mapU, mapV); // east
      emitWall(buf, world, ramps, cx, cy, 2, h, cellSize, mapU, mapV); // south
      emitWall(buf, world, ramps, cx, cy, 3, h, cellSize, mapU, mapV); // west
    }
  }

  const data = new VertexData();
  data.positions = buf.positions;
  data.normals = buf.normals;
  data.uvs = buf.uvs;
  data.uvs2 = buf.uv2s;
  data.indices = buf.indices;
  return data;
}

/** Edge e: 0 north (-y), 1 east (+x), 2 south (+y), 3 west (-x). */
const EDGE_DIRS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
/** The two cell corners along each edge, in CORNER_OFFSETS indices. */
const EDGE_CORNERS: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
];

function emitWall(
  buf: MeshBuffers,
  world: World,
  ramps: RampSlopes,
  cx: number,
  cy: number,
  edge: number,
  heights: readonly number[],
  cellSize: number,
  mapU: number,
  mapV: number,
): void {
  const [dx, dy] = EDGE_DIRS[edge] as [number, number];
  const nx = cx + dx;
  const ny = cy + dy;

  // Off the map edge: drop a skirt to zero so the map has sides rather than
  // a visible hole at the horizon.
  const neighbourCell = inBounds(world, nx, ny) ? ny * world.width + nx : -1;
  const [ca, cb] = EDGE_CORNERS[edge] as [number, number];
  const topA = heights[ca] as number;
  const topB = heights[cb] as number;

  let bottomA: number;
  let bottomB: number;
  if (neighbourCell < 0) {
    bottomA = -TIER_HEIGHT;
    bottomB = -TIER_HEIGHT;
  } else {
    const nh = cornerHeights(world, ramps, neighbourCell);
    // The neighbour's corners that touch this edge are the opposite pair.
    const [na, nb] = EDGE_CORNERS[(edge + 2) % 4] as [number, number];
    bottomA = nh[nb] as number;
    bottomB = nh[na] as number;
  }

  if (topA <= bottomA + 1e-6 && topB <= bottomB + 1e-6) return;
  bottomA = Math.min(bottomA, topA);
  bottomB = Math.min(bottomB, topB);

  const corner = (index: number, y: number): [number, number, number] => {
    const [ox, oy] = CORNER_OFFSETS[index] as [number, number];
    return [(cx + ox) * cellSize, y, (cy + oy) * cellSize];
  };

  const heightA = topA - bottomA;
  const heightB = topB - bottomB;
  const uv2a: [number, number] = [(cx + 0.5) * mapU, (cy + 0.5) * mapV];

  pushQuad(
    buf,
    [corner(ca, topA), corner(cb, topB), corner(cb, bottomB), corner(ca, bottomA)],
    [
      [0, heightA],
      [1, heightB],
      [1, 0],
      [0, 0],
    ],
    [uv2a, uv2a, uv2a, uv2a],
  );
}

export function createTerrain(scene: Scene, world: World, material: Material): Terrain {
  const chunksX = Math.ceil(world.width / CHUNK_SIZE);
  const chunksY = Math.ceil(world.height / CHUNK_SIZE);
  let ramps = solveRamps(world);

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
    buildChunkVertexData(world, ramps, chunk).applyToMesh(mesh, false);
    mesh.material = material;
    mesh.isPickable = false; // cell picking is analytic (M7)
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
    rebuildChunks(indices, options) {
      // Ramp shapes are global to a ramp group, which can straddle chunks, so
      // they are solved once per batch rather than once per chunk.
      if (options?.resolveRamps !== false) ramps = solveRamps(world);
      for (const index of indices) {
        const chunk = chunks[index];
        if (chunk) build(chunk);
      }
    },
    ramps: () => ramps,
    chunksForRect(x0, y0, x1, y1) {
      // Include one chunk of margin: an edit at a seam changes the walls the
      // neighbouring chunk owns.
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
    dispose() {
      for (const chunk of chunks) {
        chunk.mesh?.dispose();
        chunk.mesh = null;
      }
    },
  };
}

/** Exposed for tests: the vertex buffer kinds a terrain mesh must carry. */
export const REQUIRED_BUFFERS = [
  VertexBuffer.PositionKind,
  VertexBuffer.NormalKind,
  VertexBuffer.UVKind,
  VertexBuffer.UV2Kind,
] as const;
