import { describe, expect, it } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

import { makeRay, pickCell, describeFlags } from '../src/render/pick.ts';
import { TIER_HEIGHT, solveRamps, tierHeight } from '../src/render/terrain.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import * as w from '../src/sim/world.ts';

const world = createTestMap();
const ramps = solveRamps(world);

/** A ray straight down onto a cell centre — the unambiguous case. */
function straightDown(cx: number, cy: number): ReturnType<typeof makeRay> {
  return makeRay(new Vector3(cx + 0.5, 50, cy + 0.5), new Vector3(0, -1, 0));
}

/** A ray at the camera's 55 degree pitch, aimed at a point on a tier plane. */
function atPitch(targetX: number, targetZ: number, targetY: number): ReturnType<typeof makeRay> {
  const pitch = (55 * Math.PI) / 180;
  const distance = 40;
  const origin = new Vector3(
    targetX,
    targetY + distance * Math.sin(pitch),
    targetZ - distance * Math.cos(pitch),
  );
  return makeRay(origin, new Vector3(targetX - origin.x, targetY - origin.y, targetZ - origin.z));
}

describe('cell picking', () => {
  it('hits the cell directly below a downward ray on every tier', () => {
    const samples: [number, number, number][] = [
      [8, 12, 2], // NW plateau
      [50, 8, 1], // NE shelf
      [32, 32, 0], // basin
      [54, 50, 2], // SE plateau
      [10, 55, 1], // SW shelf
    ];
    for (const [cx, cy, tier] of samples) {
      const hit = pickCell(world, ramps, straightDown(cx, cy));
      expect(hit, `cell ${cx},${cy}`).not.toBeNull();
      expect(hit?.cx).toBe(cx);
      expect(hit?.cy).toBe(cy);
      expect(hit?.tier).toBe(tier);
      expect(hit?.y).toBeCloseTo(tierHeight(tier), 5);
    }
  });

  it('reports the flags of the cell it hit', () => {
    const mineral = world.resourceNodes[0];
    expect(mineral).toBeDefined();
    const cx = w.cellX(world, mineral!.cell);
    const cy = w.cellY(world, mineral!.cell);
    const hit = pickCell(world, ramps, straightDown(cx, cy));
    expect(hit?.flags).toBe(world.flags[mineral!.cell]);
    expect(describeFlags(hit?.flags ?? 0)).toContain('blocker');
  });

  it('picks the high cell, not the low one behind it, at a cliff edge', () => {
    // Looking down at the camera's pitch, the ray passes over the basin and
    // lands on the plateau: the nearest surface must win.
    const plateauX = 12;
    const plateauZ = 18; // inside the NW plateau, close to its southern cliff
    const hit = pickCell(world, ramps, atPitch(plateauX + 0.5, plateauZ + 0.5, tierHeight(2)));
    expect(hit?.tier).toBe(2);
    expect(hit?.cy).toBe(plateauZ);
  });

  it('never reports a cell whose surface the ray did not reach', () => {
    // Sweep the pointer across a cliff line and check every hit is consistent:
    // the reported tier must match the reported cell's tier in the world.
    for (let z = 14; z < 30; z += 0.25) {
      const hit = pickCell(world, ramps, atPitch(12.5, z, 0));
      if (!hit) continue;
      expect(hit.tier).toBe(world.tier[hit.cell]);
      const expectedY = tierHeight(hit.tier);
      const isRamp = (hit.flags & w.RAMP) !== 0;
      if (!isRamp) expect(hit.y).toBeCloseTo(expectedY, 4);
    }
  });

  it('follows the slope of a ramp instead of snapping to a tier plane', () => {
    const rampCells = Array.from(ramps.byCell.keys());
    expect(rampCells.length).toBeGreaterThan(0);
    const heights = new Set<number>();
    for (const cell of rampCells) {
      const cx = w.cellX(world, cell);
      const cy = w.cellY(world, cell);
      const hit = pickCell(world, ramps, straightDown(cx, cy));
      expect(hit?.cell).toBe(cell);
      heights.add(Math.round((hit?.y ?? 0) * 100) / 100);
    }
    // A ramp that picked as a flat plane would report a single height.
    expect(heights.size).toBeGreaterThan(1);
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(tierHeight(2));
    }
  });

  it('returns null when the ray misses the map', () => {
    expect(pickCell(world, ramps, makeRay(new Vector3(-50, 50, -50), new Vector3(0, -1, 0)))).toBeNull();
    // Pointing away from the ground entirely.
    expect(pickCell(world, ramps, makeRay(new Vector3(32, 50, 32), new Vector3(0, 1, 0)))).toBeNull();
  });

  it('tests only a handful of cells, never the whole mesh', () => {
    const out = { candidates: 0 };
    pickCell(world, ramps, atPitch(32.5, 32.5, 0), out);
    // Four tier planes, nine cells each, minus overlap: a fixed small number
    // regardless of map size. This is the property that makes it cheap.
    expect(out.candidates).toBeLessThanOrEqual(36);
  });

  it('costs well under a frame budget at pointer rates', () => {
    const start = performance.now();
    const iterations = 2000;
    for (let i = 0; i < iterations; i++) {
      pickCell(world, ramps, atPitch(10 + (i % 40), 10 + (i % 37), 0));
    }
    const perPick = (performance.now() - start) / iterations;
    // One pick per frame at 60fps has a 16ms budget; this must be noise.
    expect(perPick).toBeLessThan(0.1);
  });

  it('agrees with the terrain heights the mesh was built from', () => {
    for (let i = 0; i < 200; i++) {
      const cx = (i * 7) % world.width;
      const cy = (i * 13) % world.height;
      const hit = pickCell(world, ramps, straightDown(cx, cy));
      expect(hit?.cell).toBe(w.cellIndex(world, cx, cy));
      expect(hit?.y).toBeLessThanOrEqual(tierHeight(2) + 1e-6);
      expect(hit?.y).toBeGreaterThanOrEqual(-TIER_HEIGHT);
    }
  });
});
