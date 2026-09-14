/**
 * Performance budgets from PLAN.md.
 *
 * Collected here and run serially (see vitest.perf.config.ts) because
 * wall-clock assertions are meaningless when the rest of the suite is
 * competing for the same cores. Each budget names where it comes from.
 */
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';

import { computeFlowField } from '../src/nav/flowfield.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { updateFog } from '../src/sim/fog.ts';
import { createMatch } from '../src/sim/match.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { createSpatialHash, rebuildSpatialHash } from '../src/sim/spatialhash.ts';
import { spawnUnit } from '../src/sim/units.ts';
import { UNIT_TYPES, unitTypeById } from '../src/sim/unittypes.ts';
import { createUnitRenderer } from '../src/render/units.ts';
import { solveRamps } from '../src/render/terrain.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { unitsInRect } from '../src/game/selection.ts';
import * as w from '../src/sim/world.ts';
import { ONE, fromInt } from '../src/sim/fixed.ts';

/** Best of `runs`, after warming up: the cleanest estimate of real cost. */
function best(runs: number, warmup: number, work: () => void): number {
  for (let i = 0; i < warmup; i++) work();
  let lowest = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    work();
    lowest = Math.min(lowest, performance.now() - start);
  }
  return lowest;
}

function spawnGrid(
  match: ReturnType<typeof createMatch>,
  type: string,
  count: number,
  columns: number,
): void {
  for (let i = 0; i < count; i++) {
    spawnUnit(match.units, {
      type: unitTypeById(type),
      ownerId: i % 2,
      x: fromInt(10 + (i % columns)) + ONE / 2,
      z: fromInt(10 + ((i / columns) | 0)) + ONE / 2,
    });
  }
}

describe('simulation budgets', () => {
  it('M19: a 256x256 flow field solves in under 15ms', () => {
    const world = w.createWorld({ width: 256, height: 256 });
    for (let i = 0; i < 4000; i++) w.setFlags(world, (i * 2654435761) % (256 * 256), 0);
    const grid = createCostGrid(world);
    const goal = w.cellIndex(world, 128, 128);
    expect(best(10, 5, () => computeFlowField(grid, goal))).toBeLessThan(15);
  });

  it('M22: 200 units at sight radius 9 update fog in under 2ms', () => {
    const world = w.createWorld({ width: 128, height: 128 });
    const match = createMatchFromWorld({
      world,
      seed: 1,
      playerCount: 2,
      startingWorkers: 0,
      startingDepots: 0,
      costGrid: createCostGrid(world),
    });
    spawnGrid(match, 'siege', 200, 100);
    expect(unitTypeById('siege').sightRadius).toBeGreaterThan(fromInt(9));
    expect(best(40, 10, () => updateFog(match, world))).toBeLessThan(2);
  });

  it('M20: the spatial hash rebuilds for 2,000 units in under 2ms', () => {
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnGrid(match, 'soldier', 2000, 200);
    let hash = createSpatialHash(256, 256);
    hash = rebuildSpatialHash(hash, match.units);
    expect(best(40, 10, () => {
      hash = rebuildSpatialHash(hash, match.units);
    })).toBeLessThan(2);
  });
});

describe('rendering budgets', () => {
  const world = createTestMap();
  const ramps = solveRamps(world);

  it('M16: writing 2,000 unit instances costs a fraction of a frame', () => {
    const scene = new Scene(new NullEngine());
    const renderer = createUnitRenderer(scene);
    const match = createMatch({ seed: 1, playerCount: 2 });
    const per = Math.floor(2000 / (UNIT_TYPES.length * 2));
    for (const type of UNIT_TYPES) spawnGrid(match, type.id, per * 2, 40);
    renderer.captureTick(match);

    expect(best(40, 10, () => renderer.update(match, world, ramps, 0.5))).toBeLessThan(4);
    renderer.dispose();
  });

  it('M17: box-selecting 500 units costs under 1ms', () => {
    const match = createMatch({ seed: 1, playerCount: 2 });
    spawnGrid(match, 'soldier', 500, 50);
    const viewProjection = new Float32Array(16);
    viewProjection[0] = 1 / 64;
    viewProjection[12] = -1;
    viewProjection[9] = -1 / 36;
    viewProjection[13] = 1;
    viewProjection[15] = 1;
    const rect = { left: 0, top: 0, right: 1280, bottom: 720 };
    const options = { ownerId: 0, width: 1280, height: 720 };

    expect(best(60, 20, () => {
      unitsInRect(match.units, viewProjection, rect, options);
    })).toBeLessThan(1);
  });
});
