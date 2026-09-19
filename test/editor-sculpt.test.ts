import { describe, expect, it, vi } from 'vitest';
import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  brushCells,
  brushCorners,
  describeSlope,
  rampTarget,
  stageSculpt,
} from '../src/editor/sculpt.ts';
import { TerrainEditCommand } from '../src/editor/commands.ts';
import { createSession } from '../src/editor/session.ts';
import { EDITOR_TOOLS } from '../src/editor/shell.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import {
  MAX_TRAVERSABLE_SLOPE,
  cellSlope,
  cornerStride,
  heightAt,
} from '../src/sim/terrain.ts';
import { ONE, fromInt, toFloat } from '../src/sim/fixed.ts';
import * as w from '../src/sim/world.ts';

const tool = (id: string) => EDITOR_TOOLS.find((t) => t.id === id)!;

describe('brush shape', () => {
  it('is a disc of corners, clipped at the map edge', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    const stride = cornerStride(world);
    const centre = 8 * stride + 8;

    expect(brushCorners(world, centre, 1).length).toBeGreaterThan(1);
    const r3 = brushCorners(world, centre, 3);
    expect(r3.length).toBeGreaterThan(28);
    expect(r3.length).toBeLessThan(49); // a disc, not the whole square

    const corner = brushCorners(world, 0, 3);
    expect(corner.every((s) => s.corner >= 0 && s.corner < world.heights.length)).toBe(true);
    expect(corner.length).toBeLessThan(r3.length);
  });

  it('falls off smoothly from the centre, which is what avoids terraces', () => {
    // A hard-edged brush is what made the tiered editor produce steps. The
    // weight has to reach 1 in the middle and 0 at the rim, with everything
    // in between actually in between.
    const world = w.createWorld({ width: 32, height: 32 });
    const stride = cornerStride(world);
    const samples = brushCorners(world, 16 * stride + 16, 6);

    const byDistance = samples
      .map((s) => {
        const dx = (s.corner % stride) - 16;
        const dz = ((s.corner / stride) | 0) - 16;
        return { d: Math.sqrt(dx * dx + dz * dz), weight: s.weight };
      })
      .sort((a, b) => a.d - b.d);

    expect(byDistance[0]?.weight).toBe(ONE);
    expect(byDistance.at(-1)?.weight).toBeLessThan(ONE / 4);
    // Monotonically non-increasing with distance.
    for (let i = 1; i < byDistance.length; i++) {
      expect(byDistance[i]!.weight).toBeLessThanOrEqual(byDistance[i - 1]!.weight);
    }
  });

  it('rejects an invalid centre and clamps the radius', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    expect(brushCorners(world, -1, 3)).toEqual([]);
    expect(brushCorners(world, 999999, 3)).toEqual([]);
    expect(brushCells(world, -1, 3)).toEqual([]);
    expect(brushCells(world, 0, 999).length).toBe(
      brushCells(world, 0, MAX_BRUSH_RADIUS).length,
    );
  });
});

describe('sculpting', () => {
  const sculpt = (world: w.World, centre: number, radius: number, mode: 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise', reference?: number): number => {
    const command = new TerrainEditCommand(null);
    const moved = stageSculpt(world, command, brushCorners(world, centre, radius), {
      mode,
      seed: 7,
      ...(reference === undefined ? {} : { reference }),
    });
    command.apply(world);
    return moved;
  };

  it('raises the ground and lowers it back', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    const stride = cornerStride(world);
    const centre = 16 * stride + 16;

    sculpt(world, centre, 4, 'raise');
    expect(world.heights[centre]).toBeGreaterThan(0);

    const raised = world.heights[centre] as number;
    sculpt(world, centre, 4, 'lower');
    expect(world.heights[centre]).toBeLessThan(raised);
  });

  it('leaves a hill, not a spire', () => {
    // The whole reason for a falloff. The old editor had to repair spires
    // after the fact, because a tier edit was all-or-nothing per cell. A
    // weighted brush produces a profile that descends from the middle, and a
    // wide brush produces a gentler one than a narrow brush does.
    const hill = (radius: number): w.World => {
      const world = w.createWorld({ width: 32, height: 32 });
      const stride = cornerStride(world);
      for (let i = 0; i < 20; i++) sculpt(world, 16 * stride + 16, radius, 'raise');
      return world;
    };

    const wide = hill(8);
    const stride = cornerStride(wide);
    // The profile descends all the way out from the middle: no plateau, no
    // step, no spire.
    for (let d = 1; d < 8; d++) {
      expect(wide.heights[16 * stride + 16 + d - 1]).toBeGreaterThan(
        wide.heights[16 * stride + 16 + d] as number,
      );
    }

    const maxSlope = (world: w.World): number =>
      Math.max(
        ...brushCells(world, w.cellIndex(world, 16, 16), 10).map((c) => cellSlope(world, c)),
      );
    expect(maxSlope(wide)).toBeLessThan(maxSlope(hill(2)));
  });

  it('smooths a step into a slope', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    const stride = cornerStride(world);
    for (let cz = 0; cz <= 32; cz++) {
      for (let cx = 16; cx <= 32; cx++) world.heights[cz * stride + cx] = fromInt(6);
    }
    const edge = w.cellIndex(world, 15, 16);
    const before = cellSlope(world, edge);
    expect(before).toBeGreaterThan(MAX_TRAVERSABLE_SLOPE);

    for (let i = 0; i < 40; i++) sculpt(world, 16 * stride + 16, 8, 'smooth');
    expect(cellSlope(world, edge)).toBeLessThan(before);
  });

  it('flattens toward the height the stroke started at', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    const stride = cornerStride(world);
    const centre = 16 * stride + 16;
    for (let i = 0; i < 10; i++) sculpt(world, centre, 5, 'raise');

    const target = fromInt(2);
    for (let i = 0; i < 60; i++) sculpt(world, centre, 5, 'flatten', target);
    expect(world.heights[centre]).toBeCloseTo(target, -2);
  });

  it('makes noise that is reproducible from its seed', () => {
    const build = (): Int32Array => {
      const world = w.createWorld({ width: 32, height: 32 });
      sculpt(world, 16 * cornerStride(world) + 16, 6, 'noise');
      return world.heights.slice();
    };
    expect(Array.from(build())).toEqual(Array.from(build()));
  });

  it('never sculpts outside the legal height range', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    const centre = 8 * cornerStride(world) + 8;
    for (let i = 0; i < 400; i++) sculpt(world, centre, 3, 'lower');
    expect(Math.min(...Array.from(world.heights))).toBe(0);
  });

  it('stages nothing when the brush changes nothing', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    const centre = 8 * cornerStride(world) + 8;
    // Already at the floor, so lowering has nowhere to go.
    expect(sculpt(world, centre, 3, 'lower')).toBe(0);
  });
});

describe('ramp targets', () => {
  it('interpolates along the drag and clamps past its ends', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    const stride = cornerStride(world);
    const from = 8 * stride + 8;
    const to = 8 * stride + 16;

    expect(rampTarget(world, from, from, to, 0, fromInt(8))).toBe(0);
    expect(rampTarget(world, to, from, to, 0, fromInt(8))).toBe(fromInt(8));
    expect(rampTarget(world, 8 * stride + 12, from, to, 0, fromInt(8))).toBe(fromInt(4));
    // Beyond the far end, it holds rather than running away.
    expect(rampTarget(world, 8 * stride + 24, from, to, 0, fromInt(8))).toBe(fromInt(8));
  });

  it('is flat when the drag has no length', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    expect(rampTarget(world, 3, 5, 5, fromInt(2), fromInt(9))).toBe(fromInt(2));
  });
});

describe('describing a slope', () => {
  it('names the three cases the editor cares about', () => {
    expect(describeSlope(0, MAX_TRAVERSABLE_SLOPE)).toBe('flat');
    expect(describeSlope((MAX_TRAVERSABLE_SLOPE * 9) / 10, MAX_TRAVERSABLE_SLOPE)).toBe('steep');
    expect(describeSlope(MAX_TRAVERSABLE_SLOPE * 2, MAX_TRAVERSABLE_SLOPE)).toBe('cliff');
  });
});

describe('editing session', () => {
  function setup(width = 64, height = 64) {
    const world = w.createWorld({ width, height });
    const rebuilt: number[][] = [];
    const session = createSession(world, {
      pick: (x) => x, // screen x doubles as a cell index in these tests
      rebuildCells: (cells) => rebuilt.push([...cells]),
    });
    session.tool = tool('raise');
    return { world, session, rebuilt };
  }

  it('paints a stroke as one undo entry and rebuilds the cells it touched', () => {
    const { world, session, rebuilt } = setup();
    const before = w.hashWorld(world);

    session.pointerDown(1000, 0, 0);
    for (let i = 1001; i < 1040; i++) session.pointerMove(i, 0);
    session.pointerUp();

    expect(session.history.depth).toBe(1);
    expect(rebuilt.length).toBeGreaterThan(1);
    expect(rebuilt.flat().length).toBeGreaterThan(0);
    expect(w.hashWorld(world)).not.toBe(before);

    session.undo();
    expect(w.hashWorld(world)).toBe(before);
  });

  it('undo asks for a rebuild of exactly the cells it reverted', () => {
    const { session, rebuilt } = setup();
    session.pointerDown(1000, 0, 0);
    session.pointerUp();
    const painted = new Set(rebuilt.flat());
    rebuilt.length = 0;

    session.undo();
    expect(rebuilt).toHaveLength(1);
    for (const cell of rebuilt[0] ?? []) expect(painted.has(cell)).toBe(true);
  });

  it('does no work while the pointer sits still', () => {
    const { session, rebuilt } = setup();
    session.pointerDown(1000, 0, 0);
    const after = rebuilt.length;
    for (let i = 0; i < 60; i++) session.pointerMove(1000, 0);
    expect(rebuilt).toHaveLength(after);
    session.pointerUp();
  });

  it('inverts raise into lower on the right button', () => {
    const { world, session } = setup();
    const stride = cornerStride(world);
    const cell = 20 * world.width + 20;
    const corner = 20 * stride + 20;

    session.pointerDown(cell, 0, 0);
    session.pointerUp();
    const raised = world.heights[corner] as number;
    expect(raised).toBeGreaterThan(0);

    session.pointerDown(cell, 0, 2);
    session.pointerUp();
    expect(world.heights[corner]).toBeLessThan(raised);
  });

  it('paints flags with the flag tools', () => {
    const { world, session } = setup();
    session.tool = tool('blocker');
    session.radius = 1;
    session.pointerDown(1000, 0, 0);
    session.pointerUp();
    expect((world.flags[1000] as number) & w.VISION_BLOCKER).toBeTruthy();

    session.pointerDown(1000, 0, 2);
    session.pointerUp();
    expect((world.flags[1000] as number) & w.VISION_BLOCKER).toBe(0);
  });

  it('sculpts a straight incline between the ends of a ramp drag', () => {
    const { world, session } = setup();
    const stride = cornerStride(world);
    // Raise a plateau across the east half, then cut a ramp into its edge.
    for (let cz = 0; cz <= 64; cz++) {
      for (let cx = 32; cx <= 64; cx++) world.heights[cz * stride + cx] = fromInt(6);
    }

    session.tool = tool('ramp');
    session.radius = 3;
    session.pointerDown(20 * 64 + 24, 0, 0); // low ground, west of the cliff
    session.pointerMove(20 * 64 + 40, 0); // up on the plateau
    session.pointerUp();

    // Partway along, the ground now sits between the two ends rather than at
    // one or the other: it is a slope, not a step.
    const middle = toFloat(heightAt(world, fromInt(32), fromInt(20)));
    expect(middle).toBeGreaterThan(0.5);
    expect(middle).toBeLessThan(5.5);
    expect(session.history.depth).toBe(1);
  });

  it('ignores a stroke that starts off the map', () => {
    const { session, rebuilt } = setup();
    session.pointerDown(-1, 0, 0);
    session.pointerMove(50, 0);
    session.pointerUp();
    expect(session.history.depth).toBe(0);
    expect(rebuilt).toHaveLength(0);
  });

  it('clamps the brush radius', () => {
    const { session } = setup();
    session.adjustRadius(-99);
    expect(session.radius).toBe(MIN_BRUSH_RADIUS);
    session.adjustRadius(99);
    expect(session.radius).toBe(MAX_BRUSH_RADIUS);
  });

  it('reports changes so the UI can follow', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    const onChange = vi.fn();
    const session = createSession(world, {
      pick: (x) => x,
      rebuildCells: () => {},
      onChange,
    });
    session.tool = tool('raise');
    session.pointerDown(100, 0, 0);
    session.pointerUp();
    expect(onChange).toHaveBeenCalled();
  });

  it('stays fast on a 256x256 map under a long stroke', () => {
    const world = w.createWorld({ width: 256, height: 256 });
    const session = createSession(world, { pick: (x) => x, rebuildCells: () => {} });
    session.tool = tool('raise');
    session.radius = 4;

    const start = performance.now();
    session.pointerDown(w.cellIndex(world, 20, 20), 0, 0);
    for (let i = 0; i < 400; i++) {
      session.pointerMove(w.cellIndex(world, 20 + (i % 200), 20 + ((i / 3) | 0)), 0);
    }
    session.pointerUp();
    const elapsed = performance.now() - start;

    expect(session.history.depth).toBe(1);
    // 400 samples is several seconds of dragging; the whole stroke must cost
    // far less than one frame's worth of budget per sample.
    expect(elapsed / 400).toBeLessThan(16);
  });

  it('does nothing when the pick misses', () => {
    const world = createTestMap();
    const before = w.hashWorld(world);
    const session = createSession(world, { pick: () => -1, rebuildCells: () => {} });
    session.tool = tool('raise');
    session.pointerDown(10, 10, 0);
    session.pointerUp();
    expect(w.hashWorld(world)).toBe(before);
  });
});
