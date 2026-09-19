import { describe, expect, it } from 'vitest';
import {
  BASE_COST,
  BLOCKED,
  DIRECTIONS,
  MAX_SLOPE_COST,
  createCostGrid,
  gridFromSnapshot,
  isLinked,
  isPassable,
  labelComponents,
  neighboursOf,
  rebuildRegion,
  snapshotCostGrid,
} from '../src/nav/grid.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { cornerStride } from '../src/sim/terrain.ts';
import { fromInt } from '../src/sim/fixed.ts';

/** Raise a block of corner columns to a height, spanning the whole map depth. */
function raiseCorners(world: w.World, cx0: number, cx1: number, height: number): void {
  const stride = cornerStride(world);
  for (let cz = 0; cz <= world.height; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) world.heights[cz * stride + cx] = height;
  }
}
import * as w from '../src/sim/world.ts';

/** Walk the grid and report whether `to` is reachable from `from`. */
function reachable(grid: ReturnType<typeof createCostGrid>, from: number, to: number): boolean {
  const { labels } = labelComponents(grid);
  return labels[from] !== -1 && labels[from] === labels[to];
}

describe('cost grid', () => {
  it('marks unwalkable cells and resource patches impassable', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    w.setFlags(world, 10, 0);
    world.resourceNodes.push({ cell: 20, type: w.ResourceType.Minerals, amount: 100 });
    const grid = createCostGrid(world);

    expect(grid.cost[10]).toBe(BLOCKED);
    expect(grid.cost[20]).toBe(BLOCKED);
    expect(grid.cost[0]).toBe(BASE_COST);
    expect(isPassable(grid, 0)).toBe(true);
    expect(isPassable(grid, 10)).toBe(false);
    expect(grid.links[10]).toBe(0);
  });

  it('charges more for a slope than for flat ground, in proportion', () => {
    // The ramp flag used to buy a flat surcharge. Cost now scales with how
    // steep the ground actually is, so a gentle rise is nearly free and a
    // near-cliff is nearly unaffordable, and paths bend around hills by
    // themselves rather than because a flag told them to.
    const world = w.createWorld({ width: 8, height: 4 });
    const stride = cornerStride(world);
    for (let cz = 0; cz <= 4; cz++) {
      world.heights[cz * stride + 2] = world.cellSize / 8; // gentle
      world.heights[cz * stride + 5] = world.cellSize / 2; // steep
    }
    const grid = createCostGrid(world);

    const flat = grid.cost[w.cellIndex(world, 7, 2)] as number;
    const gentle = grid.cost[w.cellIndex(world, 1, 2)] as number;
    const steep = grid.cost[w.cellIndex(world, 4, 2)] as number;

    expect(flat).toBe(BASE_COST);
    expect(gentle).toBeGreaterThan(flat);
    expect(steep).toBeGreaterThan(gentle);
    expect(steep).toBeLessThanOrEqual(MAX_SLOPE_COST);
    expect(MAX_SLOPE_COST).toBeGreaterThan(BASE_COST);
  });

  it('links neighbours on level ground in all eight directions', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const grid = createCostGrid(world);
    const centre = w.cellIndex(world, 4, 4);
    for (let dir = 0; dir < DIRECTIONS.length; dir++) {
      expect(isLinked(grid, centre, dir), `direction ${dir}`).toBe(true);
    }
    expect(neighboursOf(grid, centre)).toHaveLength(8);
  });

  it('links nothing off the edge of the map', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const grid = createCostGrid(world);
    expect(neighboursOf(grid, w.cellIndex(world, 0, 0))).toHaveLength(3);
    expect(neighboursOf(grid, w.cellIndex(world, 7, 0))).toHaveLength(3);
  });

  it('refuses to link across a cliff', () => {
    const world = w.createWorld({ width: 8, height: 4 });
    raiseCorners(world, 5, 8, fromInt(6));
    const grid = createCostGrid(world);
    const low = w.cellIndex(world, 3, 2);
    const high = w.cellIndex(world, 5, 2);
    expect(neighboursOf(grid, low)).not.toContain(high);
    expect(neighboursOf(grid, high)).not.toContain(low);
    expect(reachable(grid, low, high)).toBe(false);
  });

  it('links across an incline cut into a cliff, and only there', () => {
    // A plateau with one row sculpted down into a slope gentle enough to
    // climb. Nothing is flagged: the slope is the ramp.
    const world = w.createWorld({ width: 12, height: 5 });
    const stride = cornerStride(world);
    raiseCorners(world, 4, 12, fromInt(2));

    // Row 2's corners run from ground level up to the plateau over four
    // cells, which is a slope of half a cell per cell.
    for (const cz of [2, 3]) {
      for (let cx = 4; cx <= 8; cx++) {
        world.heights[cz * stride + cx] = (fromInt(2) * (cx - 4)) / 4;
      }
    }

    const grid = createCostGrid(world);
    const low = w.cellIndex(world, 3, 2);
    const highBehindRamp = w.cellIndex(world, 9, 2);
    expect(reachable(grid, low, highBehindRamp)).toBe(true);

    // Rows away from the incline still cannot be crossed directly.
    expect(neighboursOf(grid, w.cellIndex(world, 3, 0))).not.toContain(w.cellIndex(world, 4, 0));
  });

  it('does not let a diagonal clip the corner of a cliff', () => {
    // The classic grid bug: a diagonal step squeezes between two blocked cells
    // and the unit walks through the corner of a wall.
    const world = w.createWorld({ width: 8, height: 8 });
    w.setFlags(world, w.cellIndex(world, 4, 3), 0);
    w.setFlags(world, w.cellIndex(world, 3, 4), 0);
    const grid = createCostGrid(world);
    expect(neighboursOf(grid, w.cellIndex(world, 3, 3))).not.toContain(w.cellIndex(world, 4, 4));
  });

  it('does not let a diagonal clip the corner of a cliff edge', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    raiseCorners(world, 5, 8, fromInt(6));
    const grid = createCostGrid(world);
    expect(neighboursOf(grid, w.cellIndex(world, 3, 3))).not.toContain(w.cellIndex(world, 4, 4));
  });
});

describe('the fixture map', () => {
  const world = createTestMap();
  const grid = createCostGrid(world);

  it('is one connected component, because every plateau has a way down', () => {
    const { count, labels } = labelComponents(grid);
    // Resource patches and cliff faces are impassable, and impassable cells
    // are left unlabelled rather than put in a component of their own.
    const walkable = [...labels.keys()].filter((cell) => isPassable(grid, cell));
    const label = labels[walkable[0] as number];
    expect(walkable.every((cell) => labels[cell] === label)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('connects the two start locations', () => {
    const [a, b] = world.startLocations;
    expect(reachable(grid, a!.cell, b!.cell)).toBe(true);
  });

  it('cannot leave a plateau except down its incline', () => {
    // Wall off the incline and the plateau becomes an island. There is no
    // ramp flag to clear, so this blocks the ground itself, which is what a
    // player walling a choke point would do.
    const blocked = createTestMap();
    for (let y = 20; y <= 32; y++) {
      for (let x = 44; x <= 66; x++) w.setFlags(blocked, w.cellIndex(blocked, x, y), 0);
    }
    const island = createCostGrid(blocked);
    const plateau = w.cellIndex(blocked, 20, 20);
    const basin = w.cellIndex(blocked, 70, 64);
    expect(reachable(island, plateau, basin)).toBe(false);
    // And with the incline open, it is not an island.
    expect(reachable(grid, plateau, basin)).toBe(true);
  });

  it('never links two cells the terrain rules would keep apart', () => {
    // The grid and the terrain must agree about what a cliff is, exactly.
    // This is the assertion that would have caught a nav grid quietly using a
    // different slope limit from the one units and buildings use.
    for (let cell = 0; cell < grid.cost.length; cell++) {
      for (const neighbour of neighboursOf(grid, cell)) {
        expect(w.cellsConnect(world, cell, neighbour)).toBe(true);
      }
    }
  });

  it('keeps links symmetric', () => {
    for (let cell = 0; cell < grid.cost.length; cell++) {
      for (const neighbour of neighboursOf(grid, cell)) {
        expect(neighboursOf(grid, neighbour), `${cell} -> ${neighbour}`).toContain(cell);
      }
    }
  });
});

describe('incremental rebuilds', () => {
  it('rebuilds only the edited region plus a one-cell margin', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const touched = rebuildRegion(grid, world, 10, 10, 12, 12);
    // A 3x3 edit plus a one-cell margin is 5x5.
    expect(touched).toBe(25);
    expect(touched).toBeLessThan(world.width * world.height / 100);
  });

  it('produces the same grid as a full rebuild', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);

    // Wall off a patch of the basin, then rebuild just that region.
    for (let y = 30; y <= 33; y++) {
      for (let x = 30; x <= 33; x++) w.setFlags(world, w.cellIndex(world, x, y), 0);
    }
    rebuildRegion(grid, world, 30, 30, 33, 33);

    const fresh = createCostGrid(world);
    expect(grid.cost).toEqual(fresh.cost);
    expect(grid.links).toEqual(fresh.links);
  });

  it('updates the neighbours of an edited cell, not only the cell', () => {
    // Links are directional data stored per cell: blocking a cell has to clear
    // the links pointing *into* it as well as the ones pointing out.
    const world = w.createWorld({ width: 8, height: 8 });
    const grid = createCostGrid(world);
    const cell = w.cellIndex(world, 4, 4);
    const west = w.cellIndex(world, 3, 4);
    expect(neighboursOf(grid, west)).toContain(cell);

    w.setFlags(world, cell, 0);
    rebuildRegion(grid, world, 4, 4, 4, 4);
    expect(neighboursOf(grid, west)).not.toContain(cell);
  });

  it('bumps the version on every rebuild', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const before = grid.version;
    rebuildRegion(grid, world, 1, 1, 2, 2);
    expect(grid.version).toBe(before + 1);
  });

  it('clamps a rebuild that runs off the map', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const grid = createCostGrid(world);
    expect(() => rebuildRegion(grid, world, -50, -50, 500, 500)).not.toThrow();
    expect(grid.cost).toEqual(createCostGrid(world).cost);
  });
});

describe('transfer to the worker', () => {
  it('round-trips through transferable buffers', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const snapshot = snapshotCostGrid(grid);
    const restored = gridFromSnapshot(snapshot);

    expect(restored.width).toBe(grid.width);
    expect(restored.version).toBe(grid.version);
    expect(restored.cost).toEqual(grid.cost);
    expect(restored.links).toEqual(grid.links);
    // Plain ArrayBuffers, so postMessage can transfer rather than copy them.
    expect(snapshot.cost).toBeInstanceOf(ArrayBuffer);
    expect(snapshot.links).toBeInstanceOf(ArrayBuffer);
  });

  it('snapshots a copy, so later edits do not mutate what was sent', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const snapshot = snapshotCostGrid(grid);
    const before = new Uint8Array(snapshot.cost)[0];
    grid.cost[0] = 99;
    expect(new Uint8Array(snapshot.cost)[0]).toBe(before);
  });
});
