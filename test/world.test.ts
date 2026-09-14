import { describe, expect, it } from 'vitest';
import * as w from '../src/sim/world.ts';
import { createTestMap, TEST_MAP_SIZE } from '../src/sim/fixtures/testmap.ts';
import { ONE, fromInt, fromRatio } from '../src/sim/fixed.ts';

describe('world creation', () => {
  it('starts flat, walkable and buildable', () => {
    const world = w.createWorld({ width: 8, height: 4 });
    expect(world.tier).toHaveLength(32);
    expect(world.flags).toHaveLength(32);
    expect(Array.from(world.tier).every((t) => t === 0)).toBe(true);
    expect(Array.from(world.flags).every((f) => f === (w.WALKABLE | w.BUILDABLE))).toBe(true);
  });

  it('rejects impossible dimensions', () => {
    expect(() => w.createWorld({ width: 0, height: 4 })).toThrow();
    expect(() => w.createWorld({ width: 4, height: -1 })).toThrow();
    expect(() => w.createWorld({ width: 1024, height: 4 })).toThrow(/1\.\.512/);
    expect(() => w.createWorld({ width: 4.5, height: 4 })).toThrow(/integers/);
  });

  it('clamps tier writes to the legal range', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    w.setTier(world, 0, 99);
    w.setTier(world, 1, -3);
    expect(world.tier[0]).toBe(w.MAX_TIER);
    expect(world.tier[1]).toBe(0);
    // Out-of-range cells are ignored rather than throwing or corrupting.
    expect(() => w.setTier(world, 999, 1)).not.toThrow();
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

  it('clamps tier reads to the edge and zeroes flag reads', () => {
    world.tier[0] = 2;
    expect(w.tierAt(world, -5, -5)).toBe(2); // clamped to (0,0)
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

describe('tier connectivity', () => {
  it('blocks cliffs and allows ramps', () => {
    const world = w.createWorld({ width: 4, height: 1 });
    world.tier[0] = 0;
    world.tier[1] = 1;
    world.tier[2] = 1;
    world.tier[3] = 3;
    expect(w.tiersConnect(world, 1, 2)).toBe(true); // same tier
    expect(w.tiersConnect(world, 0, 1)).toBe(false); // one-tier cliff, no ramp
    world.flags[1] = (world.flags[1] as number) | w.RAMP;
    expect(w.tiersConnect(world, 0, 1)).toBe(true); // ramp bridges one tier
    expect(w.tiersConnect(world, 1, 3)).toBe(false); // ramps never bridge two
  });
});

describe('the 64x64 test map fixture', () => {
  const world = createTestMap();

  it('is the advertised size', () => {
    expect(world.width).toBe(TEST_MAP_SIZE);
    expect(world.height).toBe(TEST_MAP_SIZE);
  });

  it('validates clean', () => {
    expect(w.validate(world)).toEqual([]);
  });

  it('has three tiers, ramps, four mineral clusters and two starts', () => {
    const tiers = new Set(world.tier);
    expect(Array.from(tiers).sort()).toEqual([0, 1, 2]);
    expect(Array.from(world.flags).filter((f) => f & w.RAMP).length).toBeGreaterThan(0);
    const minerals = world.resourceNodes.filter((n) => n.type === w.ResourceType.Minerals);
    const gas = world.resourceNodes.filter((n) => n.type === w.ResourceType.Gas);
    expect(minerals).toHaveLength(32); // four clusters of eight
    expect(gas).toHaveLength(4);
    expect(world.startLocations).toHaveLength(2);
  });

  it('is fully connected — every walkable cell is one region', () => {
    const regions = w.labelRegions(world);
    expect(regions.count).toBe(1);
    expect(regions.size[0]).toBe(TEST_MAP_SIZE * TEST_MAP_SIZE);
  });

  it('puts both starts on high ground', () => {
    for (const start of world.startLocations) {
      expect(world.tier[start.cell]).toBe(2);
      expect((world.flags[start.cell] as number) & w.WALKABLE).toBeTruthy();
    }
  });

  it('cannot be left except by a ramp', () => {
    // Walk the whole grid: any pair of adjacent cells with different tiers must
    // involve a ramp, or be disconnected.
    let cliffPairs = 0;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x + 1 < world.width; x++) {
        const a = w.cellIndex(world, x, y);
        const b = w.cellIndex(world, x + 1, y);
        if (world.tier[a] === world.tier[b]) continue;
        cliffPairs++;
        if (w.tiersConnect(world, a, b)) {
          expect((world.flags[a]! | world.flags[b]!) & w.RAMP).toBeTruthy();
        }
      }
    }
    expect(cliffPairs).toBeGreaterThan(0);
  });
});

describe('validation catches broken maps', () => {
  it('reports start locations that cannot reach each other', () => {
    const world = w.createWorld({ width: 16, height: 4 });
    for (let y = 0; y < 4; y++) {
      for (let x = 8; x < 16; x++) world.tier[w.cellIndex(world, x, y)] = 2;
    }
    world.startLocations.push({ cell: w.cellIndex(world, 1, 1) });
    world.startLocations.push({ cell: w.cellIndex(world, 14, 1) });
    const issues = w.validate(world);
    expect(issues.map((i) => i.code)).toContain('start-unreachable');
  });

  it('reports an orphaned raised region', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    for (let y = 4; y < 8; y++) {
      for (let x = 4; x < 8; x++) world.tier[w.cellIndex(world, x, y)] = 1;
    }
    const issues = w.validate(world);
    expect(issues.map((i) => i.code)).toContain('orphaned-tier');
    expect(issues.find((i) => i.code === 'orphaned-tier')?.severity).toBe('warning');
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
