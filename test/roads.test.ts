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
import { createRoads, joinRoads, smoothCorners, splitAtJunctions } from '../src/render/roads.ts';
import { fourWay, threeWay } from '../src/render/roadjunctions.ts';
import type { JunctionPieces } from '../src/render/roadjunctions.ts';
import type { RoadPoint, RoadType } from '../src/render/roads.ts';

const TWO_LANE: RoadType = {
  id: 'TwoLane',
  texture: 'roads/twolane.png',
  width: 4,
  scale: 4,
  repeat: 16,
  v0: 0.3,
  v1: 0.05,
};

const types = new Map([['TwoLane', TWO_LANE]]);

function build(
  points: RoadPoint[],
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

  it('mitres a corner the author flagged as angled, rather than notching it', () => {
    // A right angle. The bisector is at 45 degrees, so the offset has to
    // stretch by sqrt(2) for the outer edge to stay parallel to both legs.
    const { positions } = build([
      { x: 0, z: 0 },
      { x: 20, z: 0, angled: true },
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

describe('road corners', () => {
  const radiusOf = (points: RoadPoint[], cx: number, cz: number): number[] =>
    points.map((p) => Math.hypot(p.x - cx, p.z - cz));

  it('curves a right angle into an arc a road and a half wide', () => {
    // CORNER_RADIUS in the source is 1.5 road widths. A right-angle fillet of
    // radius r meets each leg r back from the corner, with its centre at
    // (20 - r, r) for a turn from +x to +z at (20, 0).
    const out = smoothCorners(
      [
        { x: 0, z: 0 },
        { x: 20, z: 0 },
        { x: 20, z: 20 },
      ],
      4,
    );
    const r = 1.5 * 4;
    const arc = out.slice(1, -1);
    expect(arc.length).toBeGreaterThan(4);
    for (const d of radiusOf(arc, 20 - r, r)) expect(d).toBeCloseTo(r, 6);
    // And it meets the legs where a tangent arc must.
    expect(arc[0]!.x).toBeCloseTo(20 - r, 6);
    expect(arc[0]!.z).toBeCloseTo(0, 6);
    expect(arc[arc.length - 1]!.x).toBeCloseTo(20, 6);
    expect(arc[arc.length - 1]!.z).toBeCloseTo(r, 6);
  });

  it('curves the other way on a turn the other way', () => {
    const out = smoothCorners(
      [
        { x: 0, z: 0 },
        { x: 20, z: 0 },
        { x: 20, z: -20 },
      ],
      4,
    );
    const r = 1.5 * 4;
    for (const d of radiusOf(out.slice(1, -1), 20 - r, -r)) expect(d).toBeCloseTo(r, 6);
  });

  it('makes a tight corner a third the radius', () => {
    const out = smoothCorners(
      [
        { x: 0, z: 0 },
        { x: 20, z: 0, tight: true },
        { x: 20, z: 20 },
      ],
      4,
    );
    const r = 0.5 * 4;
    for (const d of radiusOf(out.slice(1, -1), 20 - r, r)) expect(d).toBeCloseTo(r, 6);
  });

  it('leaves an angled corner sharp', () => {
    const points: RoadPoint[] = [
      { x: 0, z: 0 },
      { x: 20, z: 0, angled: true },
      { x: 20, z: 20 },
    ];
    expect(smoothCorners(points, 4)).toEqual(points);
  });

  it('leaves a gentle bend sharp, as the source does under 27 degrees', () => {
    const points: RoadPoint[] = [
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: 40, z: 5 }, // about 14 degrees
    ];
    expect(smoothCorners(points, 4)).toHaveLength(3);
  });

  it('shrinks the radius rather than overlapping a short leg', () => {
    // Legs of 4 leave room for a reach of 2 each way; a full 1.5-width radius
    // would reach 6 and run past both ends.
    const out = smoothCorners(
      [
        { x: 0, z: 0 },
        { x: 4, z: 0 },
        { x: 4, z: 4 },
      ],
      4,
    );
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(4 + 1e-9);
      expect(p.z).toBeGreaterThanOrEqual(-1e-9);
      expect(p.z).toBeLessThanOrEqual(4 + 1e-9);
    }
    expect(out[1]!.x).toBeCloseTo(2, 6); // the arc starts halfway along
  });
});

describe('road junctions', () => {
  const PIECES: JunctionPieces = {
    tee: [0.83, 0.5],
    fourWay: [0.83, 0.83],
    y: [0.5, 0.44],
    h: [0.39, 0.71],
  };
  const JOINED: RoadType = { ...TWO_LANE, width: 3.6, pieces: PIECES };
  const centre = { x: 10, z: 10 };
  const arm = (x: number, z: number) => ({ dir: { x, z } });
  const S = Math.SQRT1_2;

  it('picks the piece from the angles, as W3DRoadBuffer does', () => {
    // Straight through with a square stem.
    expect(threeWay(centre, [arm(-1, 0), arm(1, 0), arm(0, 1)], 4, 0.9, PIECES).kind).toBe('tee');
    // Straight through with the stem 45 degrees off square.
    expect(threeWay(centre, [arm(-1, 0), arm(1, 0), arm(S, S)], 4, 0.9, PIECES).kind).toBe('h');
    // Nothing straight across: a stem and two legs behind it.
    expect(threeWay(centre, [arm(0, 1), arm(-S, -S), arm(S, -S)], 4, 0.9, PIECES).kind).toBe('y');
    expect(
      fourWay(centre, [arm(-1, 0), arm(1, 0), arm(0, 1), arm(0, -1)], 4, 0.9, PIECES).kind,
    ).toBe('fourWay');
  });

  it("trims a T's arms to half a road width and squares them to the piece", () => {
    // The stem arrives slightly off square; its end is squared regardless.
    const joined = joinRoads(
      [
        { type: 'TwoLane', points: [{ x: 0, z: 10 }, { x: 10, z: 10 }] },
        { type: 'TwoLane', points: [{ x: 20, z: 10 }, { x: 10, z: 10 }] },
        { type: 'TwoLane', points: [{ x: 11, z: 30 }, { x: 10, z: 10 }] },
      ],
      JOINED,
    );
    expect(joined.patches).toHaveLength(1);
    const [west, east, stem] = joined.runs;
    expect(west!.road.points[1]!.x).toBeCloseTo(8, 6);
    expect(east!.road.points[1]!.x).toBeCloseTo(12, 6);
    expect(stem!.road.points[1]!.z).toBeCloseTo(12, 6);

    const edge = stem!.ends.end!;
    expect(Math.abs(edge.z)).toBeLessThan(0.1);
    expect(Math.abs(edge.x)).toBeCloseTo(JOINED.width / 2, 1);

    // The piece's u runs up its stem, which is how the atlas paints it.
    const piece = joined.patches[0]!;
    expect(piece.uAxis.z).toBeGreaterThan(0.99);
    expect(piece.u0).toBe(PIECES.tee[0]);
  });

  it('splits a run that was chained straight through a junction', () => {
    const runs = splitAtJunctions([
      { type: 'TwoLane', points: [{ x: 0, z: 10 }, { x: 10, z: 10 }, { x: 20, z: 10 }] },
      { type: 'TwoLane', points: [{ x: 10, z: 30 }, { x: 10, z: 10 }] },
    ]);
    expect(runs).toHaveLength(3);
    expect(joinRoads(runs, JOINED).patches).toHaveLength(1);
  });

  it('leaves five arms alone, having no piece for them', () => {
    const runs = [0, 1, 2, 3, 4].map((i) => ({
      type: 'TwoLane',
      points: [
        { x: 10 + 10 * Math.cos((i * 2 * Math.PI) / 5), z: 10 + 10 * Math.sin((i * 2 * Math.PI) / 5) },
        { x: 10, z: 10 },
      ],
    }));
    expect(joinRoads(runs, JOINED).patches).toHaveLength(0);
  });

  it('winds every junction triangle to face up, mirrored pieces included', () => {
    const scene = new Scene(new NullEngine());
    const stems = [
      [10, 30],
      [10, -10],
      [25, 25],
      [-5, 25],
    ];
    const roads = stems.flatMap(([x, z], i) => {
      const ox = i * 100;
      return [
        { type: 'TwoLane', points: [{ x: ox, z: 10 }, { x: ox + 10, z: 10 }] },
        { type: 'TwoLane', points: [{ x: ox + 20, z: 10 }, { x: ox + 10, z: 10 }] },
        { type: 'TwoLane', points: [{ x: ox + x!, z: z! }, { x: ox + 10, z: 10 }] },
      ];
    });
    createRoads(scene, '/pack', new Map([['TwoLane', JOINED]]), roads, () => 0);
    const mesh = scene.meshes.find((m) => m.name.startsWith('road_'))!;
    const p = mesh.getVerticesData('position')!;
    const idx = mesh.getIndices()!;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
      const e1x = p[b * 3]! - p[a * 3]!;
      const e1z = p[b * 3 + 2]! - p[a * 3 + 2]!;
      const e2x = p[c * 3]! - p[a * 3]!;
      const e2z = p[c * 3 + 2]! - p[a * 3 + 2]!;
      // Babylon is left-handed: a visible ground triangle's right-hand normal points down.
      expect(e1z * e2x - e1x * e2z).toBeLessThan(1e-9);
    }
  });
});
