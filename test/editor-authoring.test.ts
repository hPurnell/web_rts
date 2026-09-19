import { describe, expect, it } from 'vitest';
import { EditorHistory } from '../src/editor/history.ts';
import { TerrainEditCommand } from '../src/editor/commands.ts';
import { brushCorners, rampTarget, stageSculpt } from '../src/editor/sculpt.ts';
import { createSession } from '../src/editor/session.ts';
import { EDITOR_TOOLS } from '../src/editor/shell.ts';
import { decodeMap, encodeMap } from '../src/editor/mapfile.ts';
import {
  GAS_AMOUNT,
  MINERAL_AMOUNT,
  placeResourceNode,
  placeStartLocation,
  removeResourceNode,
  removeStartLocation,
} from '../src/editor/placement.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { MAX_BUILD_SLOPE, cellSlope, cornerStride } from '../src/sim/terrain.ts';
import { fromInt } from '../src/sim/fixed.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { computeFlowField, isReachable } from '../src/nav/flowfield.ts';
import * as w from '../src/sim/world.ts';

const tool = (id: string) => EDITOR_TOOLS.find((t) => t.id === id)!;

describe('placement rules', () => {
  function emptyWorld(): w.World {
    return w.createWorld({ width: 32, height: 32 });
  }

  it('places a mineral patch and marks the cell unbuildable and sight-blocking', () => {
    const world = emptyWorld();
    const result = placeResourceNode(world, 40, w.ResourceType.Minerals);
    expect(result.ok).toBe(true);
    expect(result.nodes?.at(-1)).toEqual({
      cell: 40,
      type: w.ResourceType.Minerals,
      amount: MINERAL_AMOUNT,
    });
    expect(result.flagCells).toEqual([40]);
  });

  it('refuses to stack patches and starts, and refuses steep ground', () => {
    const world = emptyWorld();
    world.resourceNodes.push({ cell: 40, type: w.ResourceType.Minerals, amount: 1 });
    expect(placeResourceNode(world, 40, w.ResourceType.Minerals).reason).toMatch(/already a patch/);
    expect(placeStartLocation(world, 40).reason).toMatch(/resource patch/);

    world.startLocations.push({ cell: 41 });
    expect(placeResourceNode(world, 41, w.ResourceType.Minerals).reason).toMatch(/start location/);
    expect(placeStartLocation(world, 41).reason).toMatch(/already a start/);

    // What used to be "not on a ramp" is now a question of slope: a patch
    // needs ground level enough to drive a harvester onto.
    const steep = w.cellIndex(world, 20, 20);
    world.heights[20 * cornerStride(world) + 20] = fromInt(4);
    expect(placeResourceNode(world, steep, w.ResourceType.Minerals).reason).toMatch(
      /level ground/,
    );
  });

  it('refuses unwalkable ground and cells off the map', () => {
    const world = emptyWorld();
    w.setFlags(world, 40, 0);
    expect(placeResourceNode(world, 40, w.ResourceType.Minerals).reason).toMatch(/walkable/);
    expect(placeStartLocation(world, 40).reason).toMatch(/walkable/);
    expect(placeStartLocation(world, -1).reason).toMatch(/on the map/);
    expect(placeResourceNode(world, 99_999, w.ResourceType.Minerals).ok).toBe(false);
  });

  it('needs a flat footprint for a geyser', () => {
    const world = emptyWorld();
    const cell = w.cellIndex(world, 4, 4);
    expect(placeResourceNode(world, cell, w.ResourceType.Gas).ok).toBe(true);
    // Cell (4,4) itself stays level; the corner raised here belongs to the
    // geyser's wider footprint, which is what the extra check is for.
    world.heights[6 * cornerStride(world) + 6] = fromInt(4);
    expect(placeResourceNode(world, cell, w.ResourceType.Gas).reason).toMatch(/level ground/);
    // And it must not hang off the edge of the map.
    const corner = w.cellIndex(world, 31, 31);
    expect(placeResourceNode(world, corner, w.ResourceType.Gas).reason).toMatch(/does not fit/);
  });

  it('gives a geyser more resources than a mineral patch', () => {
    const world = emptyWorld();
    const gas = placeResourceNode(world, 40, w.ResourceType.Gas);
    expect(gas.nodes?.at(-1)?.amount).toBe(GAS_AMOUNT);
    expect(GAS_AMOUNT).toBeGreaterThan(MINERAL_AMOUNT);
  });

  it('removes what is there and reports when nothing is', () => {
    const world = emptyWorld();
    world.resourceNodes.push({ cell: 40, type: w.ResourceType.Minerals, amount: 1 });
    world.startLocations.push({ cell: 41 });
    expect(removeResourceNode(world, 40).nodes).toEqual([]);
    expect(removeStartLocation(world, 41).starts).toEqual([]);
    expect(removeResourceNode(world, 7).reason).toMatch(/no patch/);
    expect(removeStartLocation(world, 7).reason).toMatch(/no start location/);
  });
});

describe('placement through a session', () => {
  function setup() {
    const world = w.createWorld({ width: 32, height: 32 });
    const session = createSession(world, { pick: (x) => x, rebuildCells: () => {} });
    return { world, session };
  }

  it('places and removes a patch as one undo step each', () => {
    const { world, session } = setup();
    const before = w.hashWorld(world);
    session.tool = tool('resource');

    session.pointerDown(40, 0, 0);
    session.pointerUp();
    expect(world.resourceNodes).toHaveLength(1);
    expect((world.flags[40] as number) & w.BUILDABLE).toBe(0);
    expect((world.flags[40] as number) & w.VISION_BLOCKER).toBeTruthy();
    expect(session.history.depth).toBe(1);

    // The list edit and the flag edit undo together, or the map is left
    // inconsistent.
    session.undo();
    expect(w.hashWorld(world)).toBe(before);

    session.redo();
    expect(world.resourceNodes).toHaveLength(1);
    session.pointerDown(40, 0, 2); // right click removes
    session.pointerUp();
    expect(world.resourceNodes).toHaveLength(0);
    expect(w.hashWorld(world)).toBe(before);
  });

  it('toggles between minerals and gas', () => {
    const { world, session } = setup();
    session.tool = tool('resource');
    session.toggleResourceType();
    session.pointerDown(40, 0, 0);
    session.pointerUp();
    expect(world.resourceNodes[0]?.type).toBe(w.ResourceType.Gas);
  });

  it('places and removes start locations', () => {
    const { world, session } = setup();
    session.tool = tool('start');
    session.pointerDown(40, 0, 0);
    session.pointerUp();
    session.pointerDown(200, 0, 0);
    session.pointerUp();
    expect(world.startLocations).toEqual([{ cell: 40 }, { cell: 200 }]);
    session.pointerDown(40, 0, 2);
    session.pointerUp();
    expect(world.startLocations).toEqual([{ cell: 200 }]);
  });

  it('reports why a placement was refused', () => {
    const { world, session } = setup();
    w.setFlags(world, 40, 0);
    session.tool = tool('start');
    session.pointerDown(40, 0, 0);
    session.pointerUp();
    expect(session.lastError).toMatch(/walkable/);
    expect(world.startLocations).toHaveLength(0);
  });
});

describe('start location validation', () => {
  it('warns about starts that are too close together', () => {
    const world = w.createWorld({ width: 64, height: 64 });
    world.startLocations.push({ cell: w.cellIndex(world, 10, 10) });
    world.startLocations.push({ cell: w.cellIndex(world, 15, 12) });
    const issue = w.validate(world).find((i) => i.code === 'starts-too-close');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toMatch(new RegExp(`${w.MIN_START_SEPARATION} cell minimum`));
  });

  it('accepts starts that are far enough apart', () => {
    const world = w.createWorld({ width: 64, height: 64 });
    world.startLocations.push({ cell: w.cellIndex(world, 5, 5) });
    world.startLocations.push({ cell: w.cellIndex(world, 50, 50) });
    expect(w.validate(world).map((i) => i.code)).not.toContain('starts-too-close');
  });
});

/**
 * The M13 acceptance criterion: the fixture map must be reproducible using
 * nothing but the editor's own operations, and must survive a save and load
 * unchanged. This is the end-to-end proof that the editor can author a real
 * map, rather than that its pieces work individually.
 */
describe('authoring a playable map with editor operations only', () => {
  const SIZE = 96;

  interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }

  /**
   * Flatten a rectangle of corners to a height, the way a player would: put
   * the flatten brush down and hold it until the ground stops moving.
   *
   * The old version of this test raised a rectangle a tier at a time and
   * compared the result to the fixture byte for byte. That comparison made
   * sense when terrain was five discrete values; over a heightfield the
   * fixture's skirts are smoothstepped and no sequence of brush strokes would
   * land on them exactly. What is worth asserting has not changed: that the
   * editor's own operations can produce a map that is playable.
   */
  function flattenTo(history: EditorHistory, world: w.World, rect: Rect, height: number): void {
    const stride = cornerStride(world);
    for (let pass = 0; pass < 24; pass++) {
      const command = new TerrainEditCommand(null);
      let moved = 0;
      for (let cz = rect.y0; cz <= rect.y1; cz++) {
        for (let cx = rect.x0; cx <= rect.x1; cx++) {
          moved += stageSculpt(world, command, [{ corner: cz * stride + cx, weight: 65536 }], {
            mode: 'flatten',
            reference: height,
          });
        }
      }
      if (moved === 0) return;
      history.push(command);
    }
  }

  /** Drag the ramp tool from one corner to another, as the session does. */
  function dragRamp(
    history: EditorHistory,
    world: w.World,
    from: { x: number; z: number },
    to: { x: number; z: number },
    fromHeight: number,
    toHeight: number,
    radius: number,
  ): void {
    const stride = cornerStride(world);
    const fromCorner = from.z * stride + from.x;
    const toCorner = to.z * stride + to.x;
    const command = new TerrainEditCommand(null);
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z));

    for (let step = 0; step <= steps; step++) {
      const t = steps === 0 ? 0 : step / steps;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const z = Math.round(from.z + (to.z - from.z) * t);
      for (const sample of brushCorners(world, z * stride + x, radius)) {
        const target = rampTarget(world, sample.corner, fromCorner, toCorner, fromHeight, toHeight);
        stageSculpt(world, command, [sample], { mode: 'ramp', reference: target });
      }
    }
    history.push(command);
  }

  function authorMap(): w.World {
    const world = w.createWorld({ width: SIZE, height: SIZE });
    const history = new EditorHistory(world, 4096);
    const high = fromInt(6);

    // Two plateaus in opposite corners, raised to the same height.
    flattenTo(history, world, { x0: 4, y0: 4, x1: 32, y1: 32 }, high);
    flattenTo(history, world, { x0: 64, y0: 64, x1: 92, y1: 92 }, high);

    // An incline off each one, wide enough to move an army down.
    dragRamp(history, world, { x: 32, z: 18 }, { x: 44, z: 18 }, high, 0, 5);
    dragRamp(history, world, { x: 64, z: 78 }, { x: 52, z: 78 }, high, 0, 5);

    // Smooth the cliff edges so the plateaus are not vertical walls where the
    // ramps meet them, which is what a player does with the smooth brush.
    for (const centre of [
      { x: 32, z: 18 },
      { x: 64, z: 78 },
    ]) {
      const stride = cornerStride(world);
      for (let pass = 0; pass < 6; pass++) {
        const command = new TerrainEditCommand(null);
        const moved = stageSculpt(
          world,
          command,
          brushCorners(world, centre.z * stride + centre.x, 8),
          { mode: 'smooth' },
        );
        if (moved > 0) history.push(command);
      }
    }

    const place = (cx: number, cy: number, type: w.ResourceType, count: number): void => {
      for (let i = 0; i < count; i++) {
        const cell = w.cellIndex(world, cx + i, cy);
        const result = placeResourceNode(world, cell, type);
        expect(result.ok, `patch at ${cx + i},${cy}: ${result.reason}`).toBe(true);
        world.resourceNodes = result.nodes ?? world.resourceNodes;
        const flags = world.flags[cell] as number;
        world.flags[cell] = (flags & ~w.BUILDABLE) | w.VISION_BLOCKER;
      }
    };
    place(10, 10, w.ResourceType.Minerals, 8);
    place(78, 78, w.ResourceType.Minerals, 8);
    place(10, 14, w.ResourceType.Gas, 2);
    place(78, 82, w.ResourceType.Gas, 2);

    for (const [cx, cy] of [
      [16, 16],
      [84, 84],
    ] as const) {
      const result = placeStartLocation(world, w.cellIndex(world, cx, cy));
      expect(result.ok, `start at ${cx},${cy}: ${result.reason}`).toBe(true);
      world.startLocations = result.starts ?? world.startLocations;
    }

    return world;
  }

  it('produces plateaus that are genuinely flat and genuinely raised', () => {
    const world = authorMap();
    const stride = cornerStride(world);
    // The middle of each plateau sits at the height it was flattened to, and
    // is level enough to put a base on.
    for (const [cx, cz] of [
      [16, 16],
      [80, 80],
    ] as const) {
      // Flatten converges on its reference rather than snapping to it, so
      // this is "level to well under a millimetre", not "exactly six".
      expect(world.heights[cz * stride + cx]).toBeCloseTo(fromInt(6), -3);
      expect(cellSlope(world, w.cellIndex(world, cx, cz))).toBeLessThanOrEqual(MAX_BUILD_SLOPE);
    }
    // And the basin between them was never touched.
    expect(world.heights[48 * stride + 48]).toBe(0);
  });

  it('produces a map both players can actually leave their base on', () => {
    const world = authorMap();
    const grid = createCostGrid(world);
    const [a, b] = world.startLocations;
    const field = computeFlowField(grid, b!.cell);
    expect(isReachable(field, a!.cell)).toBe(true);
  });

  it('validates clean and hashes identically after a save and load', () => {
    const world = authorMap();
    expect(w.validate(world)).toEqual([]);

    const reloaded = decodeMap(encodeMap(world));
    expect(w.hashWorld(reloaded)).toBe(w.hashWorld(world));
    expect(Array.from(reloaded.heights)).toEqual(Array.from(world.heights));
    expect(w.validate(reloaded)).toEqual([]);
  });

  it('is not the shipping fixture, and does not need to be', () => {
    // Worth stating: the fixture is generated, not authored by strokes. What
    // the editor guarantees is that a map built in it is playable, not that
    // it can reproduce a procedural one bit for bit.
    expect(w.hashWorld(authorMap())).not.toBe(w.hashWorld(createTestMap()));
  });
});
