import { describe, expect, it } from 'vitest';
import {
  DIAGONAL_WEIGHT,
  NO_DIRECTION,
  ORTHOGONAL_WEIGHT,
  UNREACHABLE,
  computeFlowField,
  distanceAt,
  flowAt,
  isReachable,
  tracePath,
} from '../src/nav/flowfield.ts';
import { createCostGrid, DIRECTIONS } from '../src/nav/grid.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { cellCentreHeight, cornerStride } from '../src/sim/terrain.ts';
import { toFloat } from '../src/sim/fixed.ts';
import * as w from '../src/sim/world.ts';
import { fnv1a32 } from '../src/sim/hash.ts';

describe('integration field', () => {
  it('is zero at the goal and grows outward', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    const grid = createCostGrid(world);
    const goal = w.cellIndex(world, 8, 8);
    const field = computeFlowField(grid, goal);

    expect(distanceAt(field, goal)).toBe(0);
    expect(distanceAt(field, w.cellIndex(world, 9, 8))).toBe(ORTHOGONAL_WEIGHT);
    expect(distanceAt(field, w.cellIndex(world, 9, 9))).toBe(DIAGONAL_WEIGHT);
    expect(distanceAt(field, w.cellIndex(world, 12, 8))).toBe(4 * ORTHOGONAL_WEIGHT);
  });

  it('prices a diagonal above an orthogonal step but below two', () => {
    // Otherwise paths either refuse to go diagonally or zigzag to exploit it.
    expect(DIAGONAL_WEIGHT).toBeGreaterThan(ORTHOGONAL_WEIGHT);
    expect(DIAGONAL_WEIGHT).toBeLessThan(2 * ORTHOGONAL_WEIGHT);
  });

  it('routes around an obstacle rather than through it', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    for (let y = 0; y < 12; y++) w.setFlags(world, w.cellIndex(world, 8, y), 0);
    const grid = createCostGrid(world);
    const goal = w.cellIndex(world, 12, 2);
    const field = computeFlowField(grid, goal);

    const start = w.cellIndex(world, 2, 2);
    expect(isReachable(field, start)).toBe(true);
    const path = tracePath(field, start);
    expect(path.length).toBeGreaterThan(10); // the straight line is 10 cells
    for (const cell of path) expect(grid.cost[cell]).not.toBe(0);
  });

  it('marks walled-off cells unreachable', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    for (let y = 0; y < 16; y++) w.setFlags(world, w.cellIndex(world, 8, y), 0);
    const grid = createCostGrid(world);
    const field = computeFlowField(grid, w.cellIndex(world, 2, 2));

    expect(isReachable(field, w.cellIndex(world, 4, 4))).toBe(true);
    expect(isReachable(field, w.cellIndex(world, 12, 4))).toBe(false);
    expect(distanceAt(field, w.cellIndex(world, 12, 4))).toBe(UNREACHABLE);
    expect(flowAt(field, w.cellIndex(world, 12, 4))).toBe(NO_DIRECTION);
  });

  it('returns an empty field for an impossible goal instead of throwing', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    w.setFlags(world, 20, 0);
    const grid = createCostGrid(world);
    for (const goal of [-1, 9999, 20]) {
      const field = computeFlowField(grid, goal);
      expect(isReachable(field, 0)).toBe(false);
    }
  });

  it('prefers flat ground to a slope when both reach the goal', () => {
    // The ramp flag used to add a fixed surcharge. Now the surcharge is the
    // slope itself, so a bump in one row of a corridor is what makes the
    // other row cheaper.
    const world = w.createWorld({ width: 16, height: 4 });
    const stride = cornerStride(world);
    // A rise of a quarter of a cell: slope 0.25, walkable but not free. Only
    // corner row 2 moves, so the cells in row 0 stay perfectly flat.
    for (let cx = 7; cx <= 10; cx++) world.heights[2 * stride + cx] = world.cellSize / 4;
    const grid = createCostGrid(world);
    const field = computeFlowField(grid, w.cellIndex(world, 15, 1));
    const throughSlope = distanceAt(field, w.cellIndex(world, 7, 1));
    const around = distanceAt(field, w.cellIndex(world, 7, 0));
    expect(around).toBeLessThan(throughSlope);
  });
});

describe('flow directions', () => {
  it('points every reachable cell at the goal', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const goal = world.startLocations[0]!.cell;
    const field = computeFlowField(grid, goal);

    let checked = 0;
    for (let cell = 0; cell < grid.cost.length; cell += 37) {
      if (!isReachable(field, cell)) continue;
      const path = tracePath(field, cell);
      expect(path.at(-1), `cell ${cell}`).toBe(goal);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('steps strictly downhill, so following it cannot loop', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const field = computeFlowField(grid, world.startLocations[1]!.cell);

    for (let cell = 0; cell < grid.cost.length; cell++) {
      const dir = flowAt(field, cell);
      if (dir === NO_DIRECTION) continue;
      const [dx, dy] = DIRECTIONS[dir] as [number, number];
      const next = (((cell / grid.width) | 0) + dy) * grid.width + (cell % grid.width) + dx;
      expect(distanceAt(field, next)).toBeLessThan(distanceAt(field, cell));
    }
  });

  it('leaves the goal itself with nowhere to go', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const grid = createCostGrid(world);
    const goal = w.cellIndex(world, 4, 4);
    expect(flowAt(computeFlowField(grid, goal), goal)).toBe(NO_DIRECTION);
  });

  it('routes off a plateau down the ramp, never over the cliff', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const basin = w.cellIndex(world, 70, 64);
    const field = computeFlowField(grid, basin);
    const path = tracePath(field, world.startLocations[0]!.cell);

    expect(path.length).toBeGreaterThan(0);
    expect(path.at(-1)).toBe(basin);

    // There is no ramp flag to check any more, and there does not need to be:
    // a step the terrain rules would refuse is a step off a cliff, whatever
    // the map author called it.
    for (let i = 1; i < path.length; i++) {
      expect(w.cellsConnect(world, path[i - 1] as number, path[i] as number)).toBe(true);
    }

    // It really did descend the six units from the plateau to the basin.
    expect(toFloat(cellCentreHeight(world, path[0] as number))).toBeCloseTo(6, 1);
    expect(toFloat(cellCentreHeight(world, basin))).toBeCloseTo(0, 1);
  });
});

describe('determinism and speed', () => {
  it('produces byte-identical fields for identical inputs', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const goal = w.cellIndex(world, 30, 30);
    const a = computeFlowField(grid, goal);
    const b = computeFlowField(grid, goal);
    expect(a.flow).toEqual(b.flow);
    expect(a.integration).toEqual(b.integration);

    // And hashes identically, which is what lets it feed the state hash.
    const hash = (f: typeof a): number =>
      fnv1a32(new Uint8Array(f.flow.buffer), fnv1a32(new Uint8Array(f.integration.buffer)));
    expect(hash(a)).toBe(hash(b));
  });

  it('records the grid version it was solved against', () => {
    const world = createTestMap();
    const grid = createCostGrid(world);
    const field = computeFlowField(grid, 100);
    expect(field.gridVersion).toBe(grid.version);
  });
});
