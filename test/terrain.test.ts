import { beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';

import {
  CHUNK_SIZE,
  TIER_HEIGHT,
  buildChunkVertexData,
  cornerHeights,
  createTerrain,
  solveRamps,
  tierHeight,
} from '../src/render/terrain.ts';
import { createTestMap, TEST_MAP_SIZE } from '../src/sim/fixtures/testmap.ts';
import * as w from '../src/sim/world.ts';

describe('ramp slopes', () => {
  it('slopes a straight ramp from the low tier to the high tier', () => {
    const world = w.createWorld({ width: 8, height: 6 });
    // Rows 0-1 are tier 1 high ground, rows 4-5 are tier 0, rows 2-3 the ramp.
    for (let x = 0; x < 8; x++) {
      world.tier[w.cellIndex(world, x, 0)] = 1;
      world.tier[w.cellIndex(world, x, 1)] = 1;
    }
    for (const y of [2, 3]) {
      const cell = w.cellIndex(world, 3, y);
      world.tier[cell] = 1;
      world.flags[cell] = w.WALKABLE | w.RAMP;
    }
    const ramps = solveRamps(world);
    const top = ramps.byCell.get(w.cellIndex(world, 3, 2));
    const bottom = ramps.byCell.get(w.cellIndex(world, 3, 3));
    expect(top).toBeDefined();
    expect(bottom).toBeDefined();
    // North corners of the top ramp cell meet the high ground exactly.
    expect(top?.[0]).toBeCloseTo(tierHeight(1), 6);
    expect(top?.[1]).toBeCloseTo(tierHeight(1), 6);
    // South corners of the bottom ramp cell meet the basin exactly.
    expect(bottom?.[2]).toBeCloseTo(tierHeight(0), 6);
    expect(bottom?.[3]).toBeCloseTo(tierHeight(0), 6);
    // And it descends monotonically in between.
    expect(top?.[3]).toBeGreaterThan(bottom?.[3] ?? 0);
  });

  it('shares corner heights between adjacent ramp cells, so there is no crack', () => {
    const world = createTestMap();
    const ramps = solveRamps(world);
    for (const [cell, heights] of ramps.byCell) {
      const cx = w.cellX(world, cell);
      const cy = w.cellY(world, cell);
      const east = ramps.byCell.get(w.cellIndex(world, cx + 1, cy));
      if (east) {
        // This cell's NE/SE corners are the east cell's NW/SW corners.
        expect(heights[1]).toBeCloseTo(east[0], 6);
        expect(heights[2]).toBeCloseTo(east[3], 6);
      }
      const south = ramps.byCell.get(w.cellIndex(world, cx, cy + 1));
      if (south) {
        expect(heights[3]).toBeCloseTo(south[0], 6);
        expect(heights[2]).toBeCloseTo(south[1], 6);
      }
    }
  });

  it('leaves a ramp that connects nothing flat', () => {
    const world = w.createWorld({ width: 5, height: 5 });
    const cell = w.cellIndex(world, 2, 2);
    world.flags[cell] = w.WALKABLE | w.RAMP;
    const heights = solveRamps(world).byCell.get(cell);
    expect(heights).toEqual([0, 0, 0, 0]);
  });
});

describe('chunk geometry', () => {
  it('puts a flat cell at its tier height', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    world.tier[w.cellIndex(world, 1, 1)] = 2;
    const ramps = solveRamps(world);
    expect(cornerHeights(world, ramps, w.cellIndex(world, 1, 1))).toEqual([4, 4, 4, 4]);
    expect(TIER_HEIGHT).toBe(2);
  });

  it('emits a wall exactly once per cliff edge, from the higher cell', () => {
    const world = w.createWorld({ width: 3, height: 1 });
    world.tier[1] = 1; // a single raised cell between two low ones
    const ramps = solveRamps(world);

    const whole = buildChunkVertexData(world, ramps, { cx0: 0, cy0: 0, cx1: 3, cy1: 1 });
    const positions = whole.positions as number[];
    // Count quads whose four vertices are not all at the same height: those are
    // the walls. The raised cell has two cliff sides plus two map-edge skirts.
    let walls = 0;
    for (let q = 0; q < positions.length / 12; q++) {
      const ys = [0, 1, 2, 3].map((i) => positions[q * 12 + i * 3 + 1] as number);
      if (Math.max(...ys) - Math.min(...ys) > 1e-6) walls++;
    }
    // 3 cells * 4 edges = 12 edges; walls are the 2 internal cliffs plus the
    // 8 map-edge skirts (the two low cells contribute 3 each, the high one 2).
    expect(walls).toBe(10);
  });

  it('builds seam walls from the world grid, not from the chunk', () => {
    // A cliff running exactly along a chunk boundary must still produce a wall
    // when only one chunk is built.
    const world = w.createWorld({ width: CHUNK_SIZE * 2, height: 2 });
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) world.tier[w.cellIndex(world, x, y)] = 1;
    }
    const ramps = solveRamps(world);
    const left = buildChunkVertexData(world, ramps, { cx0: 0, cy0: 0, cx1: CHUNK_SIZE, cy1: 2 });
    const positions = left.positions as number[];
    // The east edge of the left chunk is a cliff down to the right chunk.
    const seamX = CHUNK_SIZE;
    let seamWallVerts = 0;
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs((positions[i] as number) - seamX) < 1e-6 && (positions[i + 1] as number) === 0) {
        seamWallVerts++;
      }
    }
    expect(seamWallVerts).toBeGreaterThan(0);
  });

  it('carries positions, normals and both UV channels', () => {
    const world = createTestMap();
    const ramps = solveRamps(world);
    const data = buildChunkVertexData(world, ramps, { cx0: 0, cy0: 0, cx1: 8, cy1: 8 });
    expect(data.positions?.length).toBeGreaterThan(0);
    expect(data.normals?.length).toBe(data.positions?.length);
    expect((data.uvs as number[]).length).toBe(((data.positions as number[]).length / 3) * 2);
    expect((data.uvs2 as number[]).length).toBe(((data.positions as number[]).length / 3) * 2);
  });

  it('addresses the whole map in the second UV channel', () => {
    const world = createTestMap();
    const ramps = solveRamps(world);
    const data = buildChunkVertexData(world, ramps, {
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

  it('chunks the fixture into four meshes sharing one material', () => {
    const world = createTestMap();
    const material = new StandardMaterial('t', scene);
    const terrain = createTerrain(scene, world, material);

    expect(terrain.chunksX).toBe(2);
    expect(terrain.chunksY).toBe(2);
    expect(terrain.chunks).toHaveLength(4);
    // Four meshes, one material: four draw calls for terrain, well under eight.
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
    const before = terrain.chunks[0]?.mesh?.getTotalVertices() ?? 0;

    // Raise a block of cells inside chunk 0 and rebuild only that chunk.
    for (let y = 4; y < 8; y++) {
      for (let x = 4; x < 8; x++) world.tier[w.cellIndex(world, x, y)] = 3;
    }
    terrain.rebuildChunk(0);

    expect(terrain.chunks[0]?.mesh?.getTotalVertices()).not.toBe(before);
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
