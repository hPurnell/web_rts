/**
 * The road ribbon.
 *
 * Geometry built at load time from a polyline and the terrain under it, which
 * makes it the one piece of the map pipeline with no source data to compare
 * against — so the shape is asserted directly.
 */
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { createRoads } from '../src/render/roads.ts';
import type { RoadType } from '../src/render/roads.ts';

const TWO_LANE: RoadType = {
  id: 'TwoLane',
  texture: 'roads/twolane.png',
  width: 4,
  repeat: 16,
  v0: 0.05,
  v1: 0.3,
};

const types = new Map([['TwoLane', TWO_LANE]]);

function build(
  points: { x: number; z: number }[],
  groundY: (x: number, z: number) => number = () => 0,
): { positions: Float32Array; indices: number[] } {
  const scene = new Scene(new NullEngine());
  createRoads(scene, '/pack', types, [{ type: 'TwoLane', points }], groundY);
  const mesh = scene.meshes.find((m) => m.name.startsWith('road_'));
  if (!mesh) throw new Error('no road mesh');
  return {
    positions: mesh.getVerticesData('position') as Float32Array,
    indices: [...(mesh.getIndices() as number[])],
  };
}

/** The width of the cross-section starting at vertex `i`. */
function crossSection(positions: ArrayLike<number>, i: number): number {
  return Math.hypot(
    (positions[i * 3] as number) - (positions[(i + 1) * 3] as number),
    (positions[i * 3 + 2] as number) - (positions[(i + 1) * 3 + 2] as number),
  );
}

describe('the road ribbon', () => {
  it('is as wide as the road type says', () => {
    const { positions } = build([
      { x: 0, z: 0 },
      { x: 20, z: 0 },
    ]);
    expect(crossSection(positions, 0)).toBeCloseTo(TWO_LANE.width, 5);
  });

  it('subdivides along its length so it can follow the ground', () => {
    const flat = build([
      { x: 0, z: 0 },
      { x: 20, z: 0 },
    ]);
    // Twenty cells at roughly a cell a step, two vertices each.
    expect(flat.positions.length / 3).toBeGreaterThanOrEqual(2 * 20);
  });

  it('takes each vertex height from the terrain under it', () => {
    const slope = build(
      [
        { x: 0, z: 0 },
        { x: 20, z: 0 },
      ],
      (x) => x / 2,
    );
    // The ends sit at the ground height there, plus the anti-z-fight lift.
    const first = slope.positions[1] as number;
    const last = slope.positions[slope.positions.length - 2] as number;
    expect(first).toBeCloseTo(0, 1);
    expect(last).toBeCloseTo(10, 1);
  });

  it('mitres a corner rather than notching it', () => {
    // A right angle. The bisector is at 45 degrees, so the offset has to
    // stretch by sqrt(2) for the outer edge to stay parallel to both legs.
    const { positions } = build([
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: 20, z: 20 },
    ]);
    const widths: number[] = [];
    for (let i = 0; i + 1 < positions.length / 3; i += 2) {
      widths.push(crossSection(positions, i));
    }
    const widest = Math.max(...widths);
    expect(widest).toBeCloseTo(TWO_LANE.width * Math.SQRT2, 3);
  });

  it('does not let a hairpin fire a spike across the map', () => {
    const { positions } = build([
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: 0, z: 0.01 },
    ]);
    for (let i = 0; i + 1 < positions.length / 3; i += 2) {
      expect(crossSection(positions, i)).toBeLessThanOrEqual(TWO_LANE.width * 4 + 1e-6);
    }
  });

  it('joins its segments into one strip, with no seam between them', () => {
    const { positions, indices } = build([
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 20, z: 0 },
    ]);
    // A seam would show up as a duplicated cross-section: two pairs of
    // vertices at the same place, with no triangles bridging them.
    const count = positions.length / 3;
    expect(indices.length / 3).toBe(count - 2);
  });

  it('winds its triangles so they face up', () => {
    // Babylon's left-handed front face means the right-hand-rule cross product
    // of a ground triangle seen from above points down. Wound the other way
    // the whole ribbon is back-facing and silently disappears, which is
    // exactly what it did.
    const { positions, indices } = build([
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
    ]);
    const at = (i: number): number[] => [
      positions[i * 3] as number,
      positions[i * 3 + 1] as number,
      positions[i * 3 + 2] as number,
    ];
    for (let t = 0; t < indices.length; t += 3) {
      const a = at(indices[t] as number);
      const b = at(indices[t + 1] as number);
      const c = at(indices[t + 2] as number);
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const crossY = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
      expect(crossY, `triangle ${t / 3}`).toBeLessThan(0);
    }
  });

  it('skips a road whose type the pack does not have', () => {
    const scene = new Scene(new NullEngine());
    const renderer = createRoads(
      scene,
      '/pack',
      types,
      [{ type: 'Monorail', points: [{ x: 0, z: 0 }, { x: 5, z: 0 }] }],
      () => 0,
    );
    expect(renderer.count).toBe(0);
    expect(scene.meshes.filter((m) => m.name.startsWith('road_'))).toHaveLength(0);
  });
});
