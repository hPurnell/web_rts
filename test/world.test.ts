import { describe, expect, it } from 'vitest';
import * as w from '../src/sim/world.ts';
import { createTestMap, TEST_MAP_SIZE } from '../src/sim/fixtures/testmap.ts';
import { ONE, fromInt, fromRatio, toFloat } from '../src/sim/fixed.ts';
import {
  HEIGHT_MAX,
  cellCentreHeight,
  cellSlope,
  cornerStride,
} from '../src/sim/terrain.ts';

describe('world creation', () => {
  it('starts flat, walkable and buildable', () => {
    const world = w.createWorld({ width: 8, height: 4 });
    // Heights live on corners, so there is one more of them in each direction
    // than there are cells. Sharing corners is what stops adjacent cells from
    // disagreeing about where the ground is.
    expect(world.heights).toHaveLength(9 * 5);
    expect(world.flags).toHaveLength(32);
    expect(Array.from(world.heights).every((h) => h === 0)).toBe(true);
    expect(Array.from(world.flags).every((f) => f === (w.WALKABLE | w.BUILDABLE))).toBe(true);
  });

  it('rejects impossible dimensions', () => {
    expect(() => w.createWorld({ width: 0, height: 4 })).toThrow();
    expect(() => w.createWorld({ width: 4, height: -1 })).toThrow();
    expect(() => w.createWorld({ width: 1024, height: 4 })).toThrow(/1\.\.512/);
    expect(() => w.createWorld({ width: 4.5, height: 4 })).toThrow(/integers/);
  });

  it('clamps height writes to the sculptable range', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    w.setCornerHeight(world, 0, fromInt(9999));
    w.setCornerHeight(world, 1, fromInt(-3));
    expect(world.heights[0]).toBe(HEIGHT_MAX);
    expect(world.heights[1]).toBe(0);
    // Out-of-range corners are ignored rather than throwing or corrupting.
    expect(() => w.setCornerHeight(world, 9999, ONE)).not.toThrow();
    expect(() => w.setFlags(world, -1, 1)).not.toThrow();
  });
});

describe('cell addressing at the map edges', () => {
  const world = w.createWorld({ width: 8, height: 4 });

  it('maps coordinates to indices and back', () => {
    expect(w.cellIndex(world, 0, 0)).toBe(0);
    expect(w.cellIndex(world, 7, 3)).toBe(31);
    expect(w.cellX(world, 31)).toBe(7);
    expect(w.cellY(world, 31)).toBe(3);
  });

  it('returns -1 outside the map rather than wrapping', () => {
    // The classic grid bug is x = -1 folding onto the previous row.
    expect(w.cellIndex(world, -1, 1)).toBe(-1);
    expect(w.cellIndex(world, 8, 1)).toBe(-1);
    expect(w.cellIndex(world, 0, -1)).toBe(-1);
    expect(w.cellIndex(world, 0, 4)).toBe(-1);
  });

  it('zeroes flag reads outside the map', () => {
    expect(w.flagsAt(world, -5, -5)).toBe(0); // nothing outside is walkable
    expect(w.hasFlag(world, -5, -5, w.WALKABLE)).toBe(false);
    expect(w.hasFlag(world, 0, 0, w.WALKABLE)).toBe(true);
  });

  it('converts between cells and world space', () => {
    const cell = w.cellIndex(world, 3, 2);
    const pos = w.worldFromCell(world, cell);
    expect(pos.x).toBe(fromInt(3) + ONE / 2);
    expect(pos.z).toBe(fromInt(2) + ONE / 2);
    expect(w.cellFromWorld(world, pos.x, pos.z)).toBe(cell);
    // Cell boundaries belong to the higher cell, and negatives are outside.
    expect(w.cellFromWorld(world, fromInt(3), fromInt(2))).toBe(cell);
    expect(w.cellFromWorld(world, fromRatio(-1, 100), fromInt(2))).toBe(-1);
    expect(w.cellFromWorld(world, fromInt(99), fromInt(2))).toBe(-1);
  });

  it('honours a non-unit cell size', () => {
    const big = w.createWorld({ width: 8, height: 4, cellSize: fromInt(4) });
    const cell = w.cellIndex(big, 2, 1);
    const pos = w.worldFromCell(big, cell);
    expect(pos.x).toBe(fromInt(10)); // 2 * 4 + half a cell
    expect(pos.z).toBe(fromInt(6));
    expect(w.cellFromWorld(big, pos.x, pos.z)).toBe(cell);
  });
});

describe('slope connectivity', () => {
  it('allows a gentle incline and blocks a steep one', () => {
    // A staircase of four cells: flat, then a gentle rise, then a wall.
    const world = w.createWorld({ width: 5, height: 1 });
    const stride = cornerStride(world);
    const raise = (cx: number, height: number): void => {
      world.heights[cx] = height;
      world.heights[stride + cx] = height;
    };
    raise(2, world.cellSize / 4); // slope 0.25 across cell 1
    raise(3, world.cellSize / 4); // cell 2 is flat again, a quarter cell up
    raise(4, fromInt(6)); // cell 3 is a wall

    expect(w.cellsConnect(world, 0, 1)).toBe(true);
    expect(w.cellsConnect(world, 1, 2)).toBe(true);
    expect(w.cellsConnect(world, 2, 3)).toBe(false);
    expect(w.isTraversable(world, 3)).toBe(false);
  });

  it('refuses a step between two cells that are each flat', () => {
    // The reason connectivity is two rules rather than one. Both cells here
    // are perfectly level; the cliff is the join between them, which a check
    // of each cell on its own would never see.
    const world = w.createWorld({ width: 2, height: 1 });
    const stride = cornerStride(world);
    for (const cx of [1, 2]) {
      world.heights[cx] = fromInt(6);
      world.heights[stride + cx] = fromInt(6);
    }

    expect(w.isTraversable(world, 0)).toBe(false); // cell 0 is now the face
    world.heights[0] = fromInt(6);
    world.heights[stride] = fromInt(6);
    // Cell 0 is flat at 6 and cell 1 is flat at 6; they connect.
    expect(w.cellsConnect(world, 0, 1)).toBe(true);
  });
});

describe('the test map fixture', () => {
  const world = createTestMap();

  it('is the advertised size', () => {
    expect(world.width).toBe(TEST_MAP_SIZE);
    expect(world.height).toBe(TEST_MAP_SIZE);
  });

  it('validates clean', () => {
    expect(w.validate(world)).toEqual([]);
  });

  it('has real relief, four mineral clusters and two starts', () => {
    const heights = Array.from(world.heights);
    expect(Math.min(...heights)).toBe(0);
    expect(toFloat(Math.max(...heights))).toBeGreaterThan(6);
    const minerals = world.resourceNodes.filter((n) => n.type === w.ResourceType.Minerals);
    const gas = world.resourceNodes.filter((n) => n.type === w.ResourceType.Gas);
    expect(minerals).toHaveLength(32); // four clusters of eight
    expect(gas).toHaveLength(4);
    expect(world.startLocations).toHaveLength(2);
  });

  it('is fully connected — every walkable cell is one region', () => {
    const regions = w.labelRegions(world);
    expect(regions.count).toBe(1);

    // Not every cell: the cliff faces themselves are too steep to stand on,
    // which is new. What matters is that there is exactly one region and it
    // holds every cell a unit could ever occupy.
    let traversable = 0;
    for (let cell = 0; cell < world.flags.length; cell++) {
      if (w.isTraversable(world, cell)) traversable++;
    }
    expect(regions.size[0]).toBe(traversable);
    expect(traversable).toBeGreaterThan(TEST_MAP_SIZE * TEST_MAP_SIZE * 0.9);
  });

  it('puts both starts on flat high ground', () => {
    for (const start of world.startLocations) {
      expect(toFloat(cellCentreHeight(world, start.cell))).toBeGreaterThan(5);
      expect(w.isTraversable(world, start.cell)).toBe(true);
      // A base needs somewhere to put buildings, not just somewhere to stand.
      expect(cellSlope(world, start.cell)).toBe(0);
    }
  });

  it('has cliffs that genuinely cannot be climbed', () => {
    // There is no ramp flag to look for any more, so the property to check is
    // the one that actually matters: the map contains pairs of neighbouring
    // cells that do not connect, and every such pair is steep.
    let cliffPairs = 0;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x + 1 < world.width; x++) {
        const a = w.cellIndex(world, x, y);
        const b = w.cellIndex(world, x + 1, y);
        if (w.cellsConnect(world, a, b)) continue;
        cliffPairs++;
        expect(Math.max(cellSlope(world, a), cellSlope(world, b))).toBeGreaterThan(0);
      }
    }
    expect(cliffPairs).toBeGreaterThan(0);
  });
});

describe('validation catches broken maps', () => {
  it('reports start locations that cannot reach each other', () => {
    const world = w.createWorld({ width: 16, height: 4 });
    const stride = cornerStride(world);
    for (let cz = 0; cz <= 4; cz++) {
      for (let cx = 8; cx <= 16; cx++) world.heights[cz * stride + cx] = fromInt(8);
    }
    world.startLocations.push({ cell: w.cellIndex(world, 1, 1) });
    world.startLocations.push({ cell: w.cellIndex(world, 14, 1) });
    const issues = w.validate(world);
    expect(issues.map((i) => i.code)).toContain('start-unreachable');
  });

  it('reports ground stranded behind its own cliffs', () => {
    // A mesa: a block of flat ground raised straight up, with no way onto it.
    // The old check compared tiers; this one asks the question that matters,
    // which is whether anything can walk there from anywhere else.
    const world = w.createWorld({ width: 16, height: 16 });
    const stride = cornerStride(world);
    for (let cz = 4; cz <= 10; cz++) {
      for (let cx = 4; cx <= 10; cx++) world.heights[cz * stride + cx] = fromInt(8);
    }
    const issues = w.validate(world);
    expect(issues.map((i) => i.code)).toContain('stranded-ground');
    expect(issues.find((i) => i.code === 'stranded-ground')?.severity).toBe('warning');
  });

  it('reports out-of-bounds placements', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    world.startLocations.push({ cell: 999 });
    world.resourceNodes.push({ cell: -1, type: w.ResourceType.Minerals, amount: 100 });
    const codes = w.validate(world).map((i) => i.code);
    expect(codes).toContain('start-out-of-bounds');
    expect(codes).toContain('node-out-of-bounds');
  });

  it('reports a start location on unwalkable ground', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const cell = w.cellIndex(world, 2, 2);
    w.setFlags(world, cell, 0);
    world.startLocations.push({ cell });
    expect(w.validate(world).map((i) => i.code)).toContain('start-unwalkable');
  });
});
