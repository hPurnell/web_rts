import { beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';

import {
  CHUNK_SIZE,
  buildChunkVertexData,
  buildCornerNormals,
  cellCornerY,
  createTerrain,
  maxTerrainHeight,
} from '../src/render/terrain.ts';
import { createTestMap, TEST_MAP_SIZE } from '../src/sim/fixtures/testmap.ts';
import { cornerStride, createHeightOverrides, setOverride } from '../src/sim/terrain.ts';
import { fromInt, toFloat } from '../src/sim/fixed.ts';
import * as w from '../src/sim/world.ts';

/** Raise one corner and return its index, for the small hand-built worlds. */
function raise(world: w.World, cx: number, cz: number, height: number): number {
  const corner = cz * cornerStride(world) + cx;
  world.heights[corner] = height;
  return corner;
}

describe('surface geometry', () => {
  it('places a cell at its own corner heights', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const cell = w.cellIndex(world, 1, 1);
    raise(world, 1, 1, fromInt(3)); // the cell's NW corner

    // NW, NE, SE, SW. Only the corner that was raised moves, which is the
    // whole point of putting heights on corners: a cell cannot be lifted
    // without lifting its neighbours' shared corners with it.
    expect(cellCornerY(world, cell, null)).toEqual([3, 0, 0, 0]);
  });

  it('shares corners between neighbouring cells, so there is no crack', () => {
    // Guaranteed by construction rather than by a solver, which is why the
    // heightfield has no equivalent of the old ramp-stitching pass. This
    // checks the guarantee has not been lost in the indexing.
    const world = createTestMap();
    for (let cz = 0; cz < world.height - 1; cz++) {
      for (let cx = 0; cx < world.width - 1; cx++) {
        const here = cellCornerY(world, w.cellIndex(world, cx, cz), null);
        const east = cellCornerY(world, w.cellIndex(world, cx + 1, cz), null);
        const south = cellCornerY(world, w.cellIndex(world, cx, cz + 1), null);
        // This cell's NE/SE are the east cell's NW/SW.
        expect(here[1]).toBe(east[0]);
        expect(here[2]).toBe(east[3]);
        // This cell's SW/SE are the south cell's NW/NE.
        expect(here[3]).toBe(south[0]);
        expect(here[2]).toBe(south[1]);
      }
    }
  });

  it('reads a match height override in place of the map own height', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const overrides = createHeightOverrides();
    const corner = 1 * cornerStride(world) + 1;
    setOverride(overrides, corner, fromInt(5));

    const cell = w.cellIndex(world, 1, 1);
    expect(cellCornerY(world, cell, null)[0]).toBe(0);
    expect(cellCornerY(world, cell, overrides)[0]).toBe(5);
  });

  it('reports the highest ground on the map, for the shader', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    expect(maxTerrainHeight(world)).toBeGreaterThan(0); // never divides by zero
    raise(world, 2, 2, fromInt(9));
    expect(maxTerrainHeight(world)).toBeGreaterThanOrEqual(9);
  });
});

describe('corner normals', () => {
  it('points straight up over flat ground', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const normals = buildCornerNormals(world);
    for (let i = 0; i < normals.length; i += 3) {
      expect(normals[i]).toBeCloseTo(0, 6);
      expect(normals[i + 1]).toBeCloseTo(1, 6);
      expect(normals[i + 2]).toBeCloseTo(0, 6);
    }
  });

  it('tilts away from rising ground', () => {
    // A slope climbing to the east: the normal leans west, which is what makes
    // the hillside catch the light differently from the ground beside it.
    const world = w.createWorld({ width: 8, height: 4 });
    const stride = cornerStride(world);
    for (let cz = 0; cz <= 4; cz++) {
      for (let cx = 0; cx <= 8; cx++) world.heights[cz * stride + cx] = fromInt(cx);
    }
    const normals = buildCornerNormals(world);
    const middle = (2 * stride + 4) * 3;
    expect(normals[middle]).toBeLessThan(0); // leaning back down the slope
    expect(normals[middle + 2]).toBeCloseTo(0, 6); // nothing changes north-south
  });

  it('is computed map-wide, so chunk seams do not shade differently', () => {
    // Chunk-local normals were the obvious implementation and would put a
    // visible crease down every chunk boundary, because the cells outside the
    // chunk are exactly the ones a central difference needs.
    const world = createTestMap();
    const normals = buildCornerNormals(world);
    expect(normals.length).toBe(cornerStride(world) * (world.height + 1) * 3);
  });
});

describe('chunk geometry', () => {
  it('emits two triangles per cell, split the same way heightAt is', () => {
    const world = w.createWorld({ width: 3, height: 1 });
    const normals = buildCornerNormals(world);
    const data = buildChunkVertexData(world, normals, { cx0: 0, cy0: 0, cx1: 3, cy1: 1 });
    const indices = data.indices as number[];

    // Three cells of two triangles, plus the map-edge skirt. The top faces
    // come first, so the first eighteen indices are the cells.
    expect(indices.length).toBeGreaterThanOrEqual(18);

    const positions = data.positions as number[];
    // Each cell's two triangles share the NW-SE diagonal: vertex 0 and 2.
    for (let cell = 0; cell < 3; cell++) {
      const base = cell * 4;
      const tri = indices.slice(cell * 6, cell * 6 + 6);
      expect(tri).toContain(base);
      expect(tri).toContain(base + 2);
      // NW is at (cx, cz); SE is a cell along in both directions.
      expect(positions[base * 3]).toBeCloseTo(cell, 6);
      expect(positions[(base + 2) * 3]).toBeCloseTo(cell + 1, 6);
    }
  });

  it('needs no cliff walls, because the surface is continuous', () => {
    // With tiers, a height change meant a vertical wall quad stitched in by
    // hand. A heightfield's cliff is just a steep triangle, and every vertex
    // in the chunk sits on the surface.
    const world = w.createWorld({ width: 3, height: 3 });
    raise(world, 1, 1, fromInt(6));
    raise(world, 2, 1, fromInt(6));
    raise(world, 1, 2, fromInt(6));
    raise(world, 2, 2, fromInt(6));

    const normals = buildCornerNormals(world);
    const data = buildChunkVertexData(world, normals, { cx0: 0, cy0: 0, cx1: 3, cy1: 3 });
    const positions = data.positions as number[];
    // Four vertices per cell for nine cells, then the skirt.
    const surfaceVertices = 9 * 4;
    for (let i = 0; i < surfaceVertices; i++) {
      const cx = Math.round((positions[i * 3] as number));
      const cz = Math.round((positions[i * 3 + 2] as number));
      const corner = cz * cornerStride(world) + cx;
      expect(positions[i * 3 + 1]).toBeCloseTo(toFloat(world.heights[corner] as number), 6);
    }
  });

  it('hangs a skirt off the map edge so the horizon is not a hole', () => {
    const world = w.createWorld({ width: CHUNK_SIZE * 2, height: 2 });
    const normals = buildCornerNormals(world);
    const left = buildChunkVertexData(world, normals, {
      cx0: 0,
      cy0: 0,
      cx1: CHUNK_SIZE,
      cy1: 2,
    });
    const positions = left.positions as number[];

    let below = 0;
    for (let i = 1; i < positions.length; i += 3) {
      if ((positions[i] as number) < 0) below++;
    }
    expect(below).toBeGreaterThan(0);

    // The interior seam is not an edge, so it grows no skirt.
    const right = buildChunkVertexData(world, normals, {
      cx0: CHUNK_SIZE,
      cy0: 0,
      cx1: CHUNK_SIZE * 2,
      cy1: 2,
    });
    const rightPositions = right.positions as number[];
    for (let i = 0; i < rightPositions.length; i += 3) {
      if ((rightPositions[i + 1] as number) >= 0) continue;
      // Any skirt here belongs to the map's own east, north or south edge.
      const x = rightPositions[i] as number;
      expect(x === CHUNK_SIZE * 2 || rightPositions[i + 2] === 0 || rightPositions[i + 2] === 2).toBe(
        true,
      );
    }
  });

  it('carries positions, normals and both UV channels', () => {
    const world = createTestMap();
    const normals = buildCornerNormals(world);
    const data = buildChunkVertexData(world, normals, { cx0: 0, cy0: 0, cx1: 8, cy1: 8 });
    expect(data.positions?.length).toBeGreaterThan(0);
    expect(data.normals?.length).toBe(data.positions?.length);
    expect((data.uvs as number[]).length).toBe(((data.positions as number[]).length / 3) * 2);
    expect((data.uvs2 as number[]).length).toBe(((data.positions as number[]).length / 3) * 2);
  });

  it('addresses the whole map in the second UV channel', () => {
    const world = createTestMap();
    const normals = buildCornerNormals(world);
    const data = buildChunkVertexData(world, normals, {
      cx0: 0,
      cy0: 0,
      cx1: TEST_MAP_SIZE,
      cy1: TEST_MAP_SIZE,
    });
    const uv2 = data.uvs2 as number[];
    let min = Infinity;
    let max = -Infinity;
    for (const v of uv2) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeCloseTo(1, 6); // reaches the far edge of the map
  });
});

describe('terrain meshes', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = new Scene(new NullEngine());
  });

  it('chunks the fixture into meshes sharing one material', () => {
    const world = createTestMap();
    const material = new StandardMaterial('t', scene);
    const terrain = createTerrain(scene, world, material);

    const expected = Math.ceil(TEST_MAP_SIZE / CHUNK_SIZE);
    expect(terrain.chunksX).toBe(expected);
    expect(terrain.chunksY).toBe(expected);
    expect(terrain.chunks).toHaveLength(expected * expected);
    // One material across every chunk: terrain costs one draw call per chunk.
    for (const chunk of terrain.chunks) {
      expect(chunk.mesh).not.toBeNull();
      expect(chunk.mesh?.material).toBe(material);
      expect(chunk.mesh?.isVerticesDataPresent(VertexBuffer.UV2Kind)).toBe(true);
    }
    expect(terrain.triangleCount()).toBeGreaterThan(TEST_MAP_SIZE * TEST_MAP_SIZE * 2);
    terrain.dispose();
  });

  it('rebuilds a single chunk in isolation', () => {
    const world = createTestMap();
    const terrain = createTerrain(scene, world, new StandardMaterial('t', scene));
    const untouched = terrain.chunks[3]?.mesh;
    const before = terrain.chunks[0]?.mesh?.getVerticesData(VertexBuffer.PositionKind)?.slice();

    // Raise a block of corners inside chunk 0 and rebuild only that chunk.
    for (let cz = 4; cz < 8; cz++) {
      for (let cx = 4; cx < 8; cx++) raise(world, cx, cz, fromInt(7));
    }
    terrain.rebuildChunk(0);

    const after = terrain.chunks[0]?.mesh?.getVerticesData(VertexBuffer.PositionKind);
    // The vertex count does not change — a heightfield chunk always has the
    // same topology — so what must have changed is where the vertices are.
    expect(after?.length).toBe(before?.length);
    expect(Array.from(after ?? [])).not.toEqual(Array.from(before ?? []));
    expect(terrain.chunks[3]?.mesh).toBe(untouched); // other chunks untouched
    terrain.dispose();
  });

  it('reports the chunks an edit touches, including seam neighbours', () => {
    const world = createTestMap();
    const terrain = createTerrain(scene, world, new StandardMaterial('t', scene));
    expect(terrain.chunksForRect(4, 4, 6, 6)).toEqual([0]);
    // An edit against the seam must also rebuild the chunk on the other side.
    const seam = terrain.chunksForRect(CHUNK_SIZE - 1, 4, CHUNK_SIZE - 1, 6);
    expect(seam).toContain(0);
    expect(seam).toContain(1);
    terrain.dispose();
  });
});

describe('back-face culling', () => {
  it('emits top faces that survive back-face culling', () => {
    // This is the assertion that would have caught a whole map rendering as
    // nothing but its skirt. Babylon's default is left-handed, where a front
    // face is clockwise as seen from the front; for ground viewed from above
    // that makes the right-hand-rule cross product of every top triangle
    // point down. Reversing the winding typechecks, passes every other test,
    // and renders an empty screen.
    const world = w.createWorld({ width: 4, height: 4 });
    raise(world, 2, 2, fromInt(3)); // some relief, so this is not a flat case
    const normals = buildCornerNormals(world);
    const data = buildChunkVertexData(world, normals, { cx0: 0, cy0: 0, cx1: 4, cy1: 4 });
    const positions = data.positions as number[];
    const indices = data.indices as number[];

    const topTriangles = 4 * 4 * 2;
    for (let t = 0; t < topTriangles; t++) {
      const [ia, ib, ic] = [indices[t * 3] as number, indices[t * 3 + 1] as number, indices[t * 3 + 2] as number];
      const at = (i: number): [number, number, number] => [
        positions[i * 3] as number,
        positions[i * 3 + 1] as number,
        positions[i * 3 + 2] as number,
      ];
      const a = at(ia);
      const b = at(ib);
      const c = at(ic);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const crossY = (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number);
      expect(crossY, `triangle ${t}`).toBeLessThan(0);
    }
  });
});
