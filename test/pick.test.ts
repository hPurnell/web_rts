import { describe, expect, it } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

import { makeRay, pickCell, describeFlags } from '../src/render/pick.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import {
  cellSlope,
  cornerStride,
  createHeightOverrides,
  heightAt,
  setOverride,
} from '../src/sim/terrain.ts';
import { fromInt, toFloat } from '../src/sim/fixed.ts';
import * as w from '../src/sim/world.ts';

const world = createTestMap();

/** Terrain height at a point, in world units, straight from the simulation. */
function groundAt(x: number, z: number): number {
  return toFloat(heightAt(world, fromInt(Math.round(x * 256)) / 256, fromInt(Math.round(z * 256)) / 256));
}

/** A ray straight down onto a cell centre — the unambiguous case. */
function straightDown(cx: number, cy: number): ReturnType<typeof makeRay> {
  return makeRay(new Vector3(cx + 0.5, 60, cy + 0.5), new Vector3(0, -1, 0));
}

/** A ray at the camera's 55 degree pitch, aimed at a point on the ground. */
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
  it('hits the cell directly below a downward ray, at every elevation', () => {
    const samples: [number, number][] = [
      [20, 20], // plateau A
      [70, 64], // the basin
      [108, 108], // plateau B
      [54, 26], // partway up the western incline
      [4, 4], // the low ground outside the plateau skirt
    ];
    for (const [cx, cy] of samples) {
      const hit = pickCell(world, straightDown(cx, cy));
      expect(hit, `cell ${cx},${cy}`).not.toBeNull();
      expect(hit?.cx).toBe(cx);
      expect(hit?.cy).toBe(cy);
      // The height it reports is the simulation's own, to the last bit that
      // matters. Picking and pathing must not disagree about where the
      // ground is, or a click lands on a cell a unit cannot reach.
      expect(hit?.y).toBeCloseTo(groundAt(cx + 0.5, cy + 0.5), 4);
      expect(hit?.height).toBeCloseTo(hit?.y ?? -1, 6);
      expect(hit?.slope).toBeCloseTo(cellSlope(world, hit!.cell) / 65536, 4);
    }
  });

  it('reports the flags of the cell it hit', () => {
    const mineral = world.resourceNodes[0];
    expect(mineral).toBeDefined();
    const cx = w.cellX(world, mineral!.cell);
    const cy = w.cellY(world, mineral!.cell);
    const hit = pickCell(world, straightDown(cx, cy));
    expect(hit?.flags).toBe(world.flags[mineral!.cell]);
    expect(describeFlags(hit?.flags ?? 0)).toContain('blocker');
  });

  it('picks the high ground, not the low ground behind it, at a cliff', () => {
    // Looking down at the camera's pitch across the plateau's southern edge.
    // The nearest surface the ray meets must win; a march that tested cells
    // in the wrong order would report the basin showing through the cliff.
    const plateauX = 20;
    const plateauZ = 20;
    const hit = pickCell(world, atPitch(plateauX + 0.5, plateauZ + 0.5, groundAt(20.5, 20.5)));
    expect(hit?.cy).toBe(plateauZ);
    expect(hit?.y).toBeCloseTo(groundAt(20.5, 20.5), 3);
  });

  it('never reports a point that is not on the terrain surface', () => {
    // Sweep the pointer across the plateau's cliff line. Whatever cell comes
    // back, the point reported must lie on the ground at that point — this is
    // the assertion that catches a march that returns a cell but computes the
    // intersection against the wrong triangle.
    let hits = 0;
    for (let z = 40; z < 60; z += 0.25) {
      const hit = pickCell(world, atPitch(20.5, z, 0));
      if (!hit) continue;
      hits++;
      expect(hit.cell).toBe(w.cellIndex(world, hit.cx, hit.cy));
      expect(hit.y).toBeCloseTo(groundAt(hit.x, hit.z), 3);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('follows a slope continuously instead of snapping to a plane', () => {
    // Walk up the western incline. Every step must report a different height:
    // the old picker intersected flat tier planes and would have reported the
    // same value for a whole ramp.
    const heights: number[] = [];
    for (let x = 46; x <= 62; x += 2) {
      const hit = pickCell(world, straightDown(x, 26));
      expect(hit).not.toBeNull();
      heights.push(hit!.y);
    }
    expect(new Set(heights).size).toBe(heights.length);
    // And it climbs, rather than wandering.
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i] as number).toBeLessThan(heights[i - 1] as number);
    }
  });

  it('returns null when the ray misses the map', () => {
    expect(pickCell(world, makeRay(new Vector3(-50, 50, -50), new Vector3(0, -1, 0)))).toBeNull();
    // Pointing away from the ground entirely.
    expect(pickCell(world, makeRay(new Vector3(32, 50, 32), new Vector3(0, 1, 0)))).toBeNull();
  });

  it('marches a bounded number of cells, not the whole map', () => {
    const out = { cells: 0 };
    pickCell(world, atPitch(70.5, 64.5, 0), out);
    // A DDA march visits cells along one line, and the ray is clipped to the
    // slab the terrain can occupy first. What must not happen is a cost that
    // grows with the map.
    expect(out.cells).toBeGreaterThan(0);
    expect(out.cells).toBeLessThan(world.width);
  });

  it('costs well under a frame budget at pointer rates', () => {
    const start = performance.now();
    const iterations = 2000;
    for (let i = 0; i < iterations; i++) {
      pickCell(world, atPitch(10 + (i % 40), 10 + (i % 37), 0));
    }
    const perPick = (performance.now() - start) / iterations;
    // One pick per frame at 60fps has a 16ms budget; this must be noise.
    expect(perPick).toBeLessThan(0.1);
  });

  it('reads a match height override, not the map underneath it', () => {
    // Lift the four corners of one basin cell into an override layer, as a
    // building levelling its footprint does. Picking has to read the same
    // layer the mesh was built from, or a click on a levelled building site
    // lands under the ground.
    const overrides = createHeightOverrides();
    const stride = cornerStride(world);
    for (const [dx, dz] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const) {
      setOverride(overrides, (64 + dz) * stride + (70 + dx), fromInt(4));
    }

    expect(pickCell(world, straightDown(70, 64))?.y).toBeCloseTo(0, 4);
    expect(pickCell(world, straightDown(70, 64), undefined, overrides)?.y).toBeCloseTo(4, 4);
  });
});
