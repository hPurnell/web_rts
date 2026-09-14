import { describe, expect, it } from 'vitest';
import { EditorHistory } from '../src/editor/history.ts';
import { TerrainEditCommand } from '../src/editor/commands.ts';
import { stageTierEdit } from '../src/editor/brush.ts';
import { planRamp, stageRamp } from '../src/editor/ramp.ts';
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
import { createTestMap, TEST_MAP_SIZE } from '../src/sim/fixtures/testmap.ts';
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

  it('refuses to stack patches, starts and ramps', () => {
    const world = emptyWorld();
    world.resourceNodes.push({ cell: 40, type: w.ResourceType.Minerals, amount: 1 });
    expect(placeResourceNode(world, 40, w.ResourceType.Minerals).reason).toMatch(/already a patch/);
    expect(placeStartLocation(world, 40).reason).toMatch(/resource patch/);

    world.startLocations.push({ cell: 41 });
    expect(placeResourceNode(world, 41, w.ResourceType.Minerals).reason).toMatch(/start location/);
    expect(placeStartLocation(world, 41).reason).toMatch(/already a start/);

    w.setFlags(world, 42, w.WALKABLE | w.RAMP);
    expect(placeResourceNode(world, 42, w.ResourceType.Minerals).reason).toMatch(/ramp/);
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
    world.tier[w.cellIndex(world, 5, 5)] = 1;
    expect(placeResourceNode(world, cell, w.ResourceType.Gas).reason).toMatch(/flat ground/);
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
describe('reauthoring the fixture with editor operations only', () => {
  interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }

  function cellsIn(world: w.World, rect: Rect): number[] {
    const cells: number[] = [];
    for (let y = rect.y0; y <= rect.y1; y++) {
      for (let x = rect.x0; x <= rect.x1; x++) {
        const cell = w.cellIndex(world, x, y);
        if (cell >= 0) cells.push(cell);
      }
    }
    return cells;
  }

  /** Raise a rectangle to an absolute tier, one editor step at a time. */
  function raiseTo(history: EditorHistory, world: w.World, rect: Rect, tier: number): void {
    for (let step = 0; step < tier; step++) {
      const command = new TerrainEditCommand(null);
      const cells = cellsIn(world, rect).filter((c) => (world.tier[c] as number) < tier);
      if (stageTierEdit(world, command, cells, 1) === 0) continue;
      history.push(command);
    }
  }

  /** Move a rectangle to an absolute tier, raising or lowering as needed. */
  function setTo(history: EditorHistory, world: w.World, rect: Rect, tier: number): void {
    for (let pass = 0; pass < 4; pass++) {
      let moved = 0;
      for (const delta of [1, -1]) {
        const command = new TerrainEditCommand(null);
        const cells = cellsIn(world, rect).filter((c) =>
          delta > 0 ? (world.tier[c] as number) < tier : (world.tier[c] as number) > tier,
        );
        if (cells.length === 0) continue;
        if (stageTierEdit(world, command, cells, delta) === 0) continue;
        history.push(command);
        moved++;
      }
      if (moved === 0) return;
    }
  }

  function authorFixture(): w.World {
    const world = w.createWorld({ width: TEST_MAP_SIZE, height: TEST_MAP_SIZE });
    const history = new EditorHistory(world, 4096);

    raiseTo(history, world, { x0: 0, y0: 0, x1: 25, y1: 20 }, 2); // NW plateau
    raiseTo(history, world, { x0: 40, y0: 0, x1: 63, y1: 16 }, 1); // NE shelf
    raiseTo(history, world, { x0: 38, y0: 43, x1: 63, y1: 63 }, 2); // SE plateau
    raiseTo(history, world, { x0: 0, y0: 47, x1: 23, y1: 63 }, 1); // SW shelf

    // Four ramps, each dragged from its high end to its low end. The plateau
    // ramps span two tiers and the shelf ramps one.
    const ramps: [number, number, number, number][] = [
      [21, 20, 21, 23], // NW plateau down to the basin
      [45, 16, 45, 19], // NE shelf down to the basin
      [42, 43, 42, 40], // SE plateau down to the basin
      [18, 47, 18, 44], // SW shelf down to the basin
    ];
    for (const [hx, hy, lx, ly] of ramps) {
      const plan = planRamp(
        world,
        w.cellIndex(world, hx, hy),
        w.cellIndex(world, lx, ly),
      );
      expect(plan.ok, `ramp ${hx},${hy} -> ${lx},${ly}: ${plan.reason}`).toBe(true);
      const command = new TerrainEditCommand(null);
      stageRamp(world, command, plan);
      history.push(command);
    }

    // The aprons beside each plateau ramp: partly a lowering of plateau edge,
    // partly a raising of basin, which is two brush strokes either way.
    setTo(history, world, { x0: 18, y0: 20, x1: 24, y1: 22 }, 1);
    setTo(history, world, { x0: 39, y0: 41, x1: 45, y1: 43 }, 1);

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
    place(4, 6, w.ResourceType.Minerals, 8);
    place(48, 4, w.ResourceType.Minerals, 8);
    place(46, 54, w.ResourceType.Minerals, 8);
    place(4, 54, w.ResourceType.Minerals, 8);
    place(14, 9, w.ResourceType.Gas, 2);
    place(48, 50, w.ResourceType.Gas, 2);

    for (const [cx, cy] of [
      [8, 12],
      [54, 50],
    ] as const) {
      const result = placeStartLocation(world, w.cellIndex(world, cx, cy));
      expect(result.ok, `start at ${cx},${cy}: ${result.reason}`).toBe(true);
      world.startLocations = result.starts ?? world.startLocations;
    }

    return world;
  }

  it('produces terrain identical to the fixture', () => {
    const authored = authorFixture();
    const fixture = createTestMap();
    expect(Array.from(authored.tier)).toEqual(Array.from(fixture.tier));
    expect(Array.from(authored.flags)).toEqual(Array.from(fixture.flags));
  });

  it('produces the same resource nodes and start locations', () => {
    const authored = authorFixture();
    const fixture = createTestMap();
    expect(authored.resourceNodes).toEqual(fixture.resourceNodes);
    expect(authored.startLocations).toEqual(fixture.startLocations);
  });

  it('hashes identically, and still does after a save and load', () => {
    const authored = authorFixture();
    const fixture = createTestMap();
    expect(w.hashWorld(authored)).toBe(w.hashWorld(fixture));

    const reloaded = decodeMap(encodeMap(authored));
    expect(w.hashWorld(reloaded)).toBe(w.hashWorld(fixture));
    expect(w.validate(reloaded)).toEqual([]);
  });
});
