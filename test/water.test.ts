/**
 * Water and the bridges over it.
 *
 * The pipeline half follows the source game's own rules — which polygon a
 * point is in, which cells a unit cannot enter, how a river's banks pair up —
 * and a wrong answer in any of them is invisible until a map floods or a tank
 * drives down a riverbed, so each rule is pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  pointInPolygon,
  underwaterCells,
  waterHeightAt,
  waterLook,
} from '../generals/tools/water.ts';
import type { WaterPolygon } from '../generals/tools/water.ts';
import { BRIDGE_POINT1, BRIDGE_POINT2, layBridges, pairBridges } from '../generals/tools/bridges.ts';
import { riverGeometry, standingGeometry } from '../src/render/water.ts';

/** A square lake from (x0,y0) to (x1,y1) in Generals units, surface at z. */
function lake(x0: number, y0: number, x1: number, y1: number, z: number, name = 'lake'): WaterPolygon {
  return {
    name,
    river: false,
    riverStart: 0,
    points: [
      { x: x0, y: y0, z },
      { x: x1, y: y0, z },
      { x: x1, y: y1, z },
      { x: x0, y: y1, z },
    ],
  };
}

describe('water areas', () => {
  it('tests points the way PolygonTrigger does', () => {
    const square = lake(0, 0, 100, 100, 5);
    expect(pointInPolygon(square, 50, 50)).toBe(true);
    expect(pointInPolygon(square, 150, 50)).toBe(false);
    expect(pointInPolygon(square, 50, -1)).toBe(false);
  });

  it('takes the highest of overlapping surfaces, by first point', () => {
    const low = lake(0, 0, 100, 100, 5, 'low');
    const high = lake(40, 40, 60, 60, 30, 'high');
    expect(waterHeightAt([low, high], 50, 50)).toBe(30);
    expect(waterHeightAt([low, high], 10, 10)).toBe(5);
    expect(waterHeightAt([low, high], 500, 500)).toBeNull();
  });

  it('makes a cell water if any one corner is under the surface', () => {
    // A 4x4-cell map with ground at 1 cell (10 units) everywhere except one
    // low corner at (2,2), under a lake at 5 units covering the whole map.
    const ground = (cx: number, cz: number): number => (cx === 2 && cz === 2 ? 0 : 1);
    const cells = underwaterCells([lake(-5, -5, 45, 45, 5)], 4, 4, ground);
    // The four cells sharing that corner, and no others.
    expect(cells.sort((a, b) => a - b)).toEqual([5, 6, 9, 10]);
  });

  it('is dry above the surface and outside the polygon', () => {
    const everywhereLow = (): number => 0;
    // The lake covers only the left half.
    const cells = underwaterCells([lake(-5, -5, 15, 45, 5)], 4, 4, everywhereLow);
    for (const cell of cells) expect(cell % 4).toBeLessThan(3);
    const high = (): number => 2;
    expect(underwaterCells([lake(-5, -5, 45, 45, 5)], 4, 4, high)).toEqual([]);
  });

  it('lights the water like the ground, tinted by the time of day', () => {
    const look = waterLook(
      {
        diffuse: [[0.5, 0.5, 0.5, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]],
        transparentDepth: 3,
        minOpacity: 1,
        standingColor: [1, 1, 1],
        texture: 'x',
      },
      1,
      { r: 0.2, g: 0.2, b: 0.2 },
      [
        { direction: { x: 0, y: -1, z: 0 }, color: { r: 1, g: 1, b: 1 } },
        // A light from below the horizon adds nothing.
        { direction: { x: 0, y: 1, z: 0 }, color: { r: 1, g: 1, b: 1 } },
      ],
    );
    expect(look.ambient[0]).toBeCloseTo(0.1, 6);
    expect(look.sun[0]).toBeCloseTo(0.5, 6);
    // Three game units is three tenths of a cell.
    expect(look.transparentDepth).toBeCloseTo(0.3, 6);
  });
});

describe('bridges over water', () => {
  it('pairs a first point only with the object straight after it', () => {
    const spans = pairBridges([
      { type: 'Stray', x: 0, z: 0, flags: BRIDGE_POINT1 },
      { type: 'Tree', x: 1, z: 1, flags: 0 },
      { type: 'Wood', x: 2, z: 5, flags: BRIDGE_POINT1 },
      { type: 'Wood', x: 12, z: 5, flags: BRIDGE_POINT2 },
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ type: 'Wood', from: { x: 2, z: 5 }, to: { x: 12, z: 5 } });
  });

  it('turns the water under a deck into ground at deck height, and nothing else', () => {
    const width = 10;
    const height = 10;
    const heights = new Float64Array((width + 1) * (height + 1)).fill(-1);
    // Banks at height 2 on the left and right edges; a river between.
    for (let cz = 0; cz <= height; cz++) {
      for (const cx of [0, 1, 9, 10]) heights[cz * (width + 1) + cx] = 2;
    }
    const water = new Set<number>();
    for (let cz = 0; cz < height; cz++) for (let cx = 1; cx < 9; cx++) water.add(cz * width + cx);
    const walkable = new Set<number>();

    const changed = layBridges(
      [{ type: 'Wood', from: { x: 1, z: 5 }, to: { x: 9, z: 5 } }],
      new Map([['wood', 2]]),
      width,
      height,
      (cell) => water.has(cell),
      (cx, cz) => heights[cz * (width + 1) + cx] as number,
      (cx, cz, to) => {
        heights[cz * (width + 1) + cx] = to;
      },
      (cell) => walkable.add(cell),
    );

    // Two cells wide (rows 4 and 5), across every water column.
    expect(new Set(changed)).toEqual(walkable);
    for (const cell of changed) expect([4, 5]).toContain(Math.floor(cell / width));
    for (let cx = 1; cx < 9; cx++) expect(walkable.has(5 * width + cx)).toBe(true);
    // Raised to the banks' height, and the river either side left alone.
    expect(heights[5 * (width + 1) + 5]).toBeCloseTo(2, 6);
    expect(heights[1 * (width + 1) + 5]).toBe(-1);
  });

  it('fills the bank between a bridge end and the water, not only the water', () => {
    // Ground at 2 falling to 0 at the water's edge (column 3), water in
    // columns 3-6, and the bridge's ends back on the high ground. Raising only
    // the water left a cliff between the deck and each end.
    const width = 10;
    const height = 6;
    const stride = width + 1;
    const heights = new Float64Array(stride * (height + 1));
    for (let cz = 0; cz <= height; cz++) {
      for (let cx = 0; cx <= width; cx++) {
        heights[cz * stride + cx] = cx <= 1 || cx >= 9 ? 2 : cx === 2 || cx === 8 ? 1 : 0;
      }
    }
    const water = new Set<number>();
    for (let cz = 0; cz < height; cz++) for (let cx = 3; cx < 7; cx++) water.add(cz * width + cx);
    layBridges(
      [{ type: 'Wood', from: { x: 0.5, z: 3 }, to: { x: 9.5, z: 3 } }],
      new Map([['wood', 2]]),
      width,
      height,
      (cell) => water.has(cell),
      (cx, cz) => heights[cz * stride + cx] as number,
      (cx, cz, to) => {
        heights[cz * stride + cx] = to;
      },
      () => undefined,
    );
    // The bank corners under the deck are up at the deck, not left at 1.
    expect(heights[3 * stride + 2]).toBeCloseTo(2, 6);
    expect(heights[3 * stride + 8]).toBeCloseTo(2, 6);
  });

  it('leaves a bridge over dry ground alone', () => {
    const raised: number[] = [];
    layBridges(
      [{ type: 'Wood', from: { x: 0, z: 2 }, to: { x: 8, z: 2 } }],
      new Map([['wood', 2]]),
      10,
      4,
      () => false,
      (cx) => (cx === 0 || cx === 8 ? 5 : 0),
      (cx) => raised.push(cx),
      () => undefined,
    );
    expect(raised).toEqual([]);
  });

  it('leaves a bridge of unknown type alone rather than guessing its width', () => {
    const changed = layBridges(
      [{ type: 'Mystery', from: { x: 0, z: 0 }, to: { x: 5, z: 0 } }],
      new Map(),
      5,
      5,
      () => true,
      () => 0,
      () => undefined,
      () => undefined,
    );
    expect(changed).toEqual([]);
  });
});

describe('water geometry', () => {
  it('fills standing water as a fan from its first point', () => {
    const geometry = standingGeometry({
      river: false,
      riverStart: 0,
      points: [
        { x: 0, y: 1, z: 0 },
        { x: 4, y: 1, z: 0 },
        { x: 4, y: 1, z: 4 },
        { x: 0, y: 1, z: 4 },
        { x: -1, y: 1, z: 2 },
      ],
    });
    expect(geometry.indices).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4]);
  });

  it('pairs a river’s banks outward from its start point', () => {
    // A straight river two cells wide and eight long, drawn as the editor
    // does: up one bank and back down the other. The flow starts at the
    // segment 0-1, which is its width.
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 2, y: 0, z: 4 },
      { x: 2, y: 0, z: 8 },
      { x: 0, y: 0, z: 8 },
      { x: 0, y: 0, z: 4 },
    ];
    const geometry = riverGeometry({ river: true, riverStart: 0, points })!;
    const at = (i: number) => geometry.positions.slice(i * 3, i * 3 + 3);
    // Each step pairs the two banks at the same distance along.
    expect(at(0)).toEqual([2, 0, 0]);
    expect(at(1)).toEqual([0, 0, 0]);
    expect(at(2)).toEqual([2, 0, 4]);
    expect(at(3)).toEqual([0, 0, 4]);
    expect(at(4)).toEqual([2, 0, 8]);
    expect(at(5)).toEqual([0, 0, 8]);
    // One texture repeat per river width, over the length the source works
    // out: half the perimeter *without* the polygon's closing edge, less the
    // width. That is (2 + 4 + 4 + 2 + 4) / 2 - 2 = 6, so three repeats.
    expect(geometry.uvs[5 * 2 + 1]).toBeCloseTo(3, 6);
    // Half the texture across, and the whole bank ramp.
    expect([geometry.uvs[0], geometry.uvs[2]]).toEqual([0.5, 0]);
    expect([geometry.uvs2[0], geometry.uvs2[2]]).toEqual([1, 0]);
  });

  it('draws nothing for a river whose start is past its last point', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
    ];
    expect(riverGeometry({ river: true, riverStart: 3, points })).toBeNull();
  });
});
