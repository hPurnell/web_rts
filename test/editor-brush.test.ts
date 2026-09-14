import { describe, expect, it, vi } from 'vitest';
import {
  brushCells,
  illegalCells,
  isTerrainLegal,
  proposeTierEdit,
} from '../src/editor/brush.ts';
import { stageTierEdit } from '../src/editor/brush.ts';
import { TerrainEditCommand } from '../src/editor/commands.ts';
import { createSession } from '../src/editor/session.ts';
import { EDITOR_TOOLS } from '../src/editor/shell.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import * as w from '../src/sim/world.ts';

const tool = (id: string) => EDITOR_TOOLS.find((t) => t.id === id)!;

describe('brush shape', () => {
  it('is a disc, clipped at the map edge', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    expect(brushCells(world, w.cellIndex(world, 8, 8), 0)).toHaveLength(1);
    expect(brushCells(world, w.cellIndex(world, 8, 8), 1)).toHaveLength(9);
    const r3 = brushCells(world, w.cellIndex(world, 8, 8), 3);
    expect(r3.length).toBeGreaterThan(28);
    expect(r3.length).toBeLessThan(49); // a disc, not the whole square

    const corner = brushCells(world, w.cellIndex(world, 0, 0), 3);
    expect(corner.every((c) => c >= 0 && c < 256)).toBe(true);
    expect(corner.length).toBeLessThan(r3.length);
  });

  it('clamps the radius and rejects an invalid centre', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    expect(brushCells(world, -1, 3)).toEqual([]);
    expect(brushCells(world, 9999, 3)).toEqual([]);
    expect(brushCells(world, 0, 999).length).toBe(brushCells(world, 0, 16).length);
  });
});

describe('tier legality', () => {
  const raiseOnce = (world: w.World, cells: number[], delta = 1): void => {
    const proposed = proposeTierEdit(world, cells, delta);
    for (const [cell, tier] of proposed) world.tier[cell] = tier;
  };

  it('never leaves a spire standing alone above its neighbours', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    const centre = w.cellIndex(world, 16, 16);
    for (let i = 0; i < 3; i++) raiseOnce(world, [centre]);
    expect(world.tier[centre]).toBe(3);
    expect(illegalCells(world)).toEqual([]);
    expect(isTerrainLegal(world)).toBe(true);
  });

  it('turns a repeated single-cell raise into a mesa', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    const centre = w.cellIndex(world, 16, 16);
    raiseOnce(world, [centre]);
    // One tier up is legal on its own: no repair needed yet.
    expect(world.tier[w.cellIndex(world, 17, 16)]).toBe(0);

    raiseOnce(world, [centre]);
    // Now the centre is two tiers above everything, so the ring comes up.
    expect(world.tier[centre]).toBe(2);
    expect(world.tier[w.cellIndex(world, 17, 16)]).toBe(1);
    expect(world.tier[w.cellIndex(world, 17, 17)]).toBe(1); // diagonals too
    expect(world.tier[w.cellIndex(world, 18, 16)]).toBe(0); // a legal 2-tier cliff
    expect(isTerrainLegal(world)).toBe(true);
  });

  it('allows a two-tier cliff along an edge', () => {
    const world = w.createWorld({ width: 16, height: 16 });
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 8; x++) world.tier[w.cellIndex(world, x, y)] = 2;
    }
    expect(isTerrainLegal(world)).toBe(true);
  });

  it('keeps the fixture legal', () => {
    expect(illegalCells(createTestMap())).toEqual([]);
  });

  it('repairs pits the same way it repairs spires', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    for (const cell of brushCells(world, w.cellIndex(world, 16, 16), 8)) world.tier[cell] = 3;
    const centre = w.cellIndex(world, 16, 16);
    for (let i = 0; i < 3; i++) raiseOnce(world, [centre], -1);
    expect(world.tier[centre]).toBe(0);
    expect(world.tier[w.cellIndex(world, 17, 16)]).toBe(1);
    expect(isTerrainLegal(world)).toBe(true);
  });

  it('proposes nothing at the clamp boundaries', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    expect(proposeTierEdit(world, [0], -1).size).toBe(0);
    for (const cell of world.tier.keys()) world.tier[cell] = w.MAX_TIER;
    expect(proposeTierEdit(world, [0], 1).size).toBe(0);
  });

  it('clears the RAMP flag from cells whose tier moves', () => {
    const world = createTestMap();
    const rampCell = world.flags.findIndex((f) => (f & w.RAMP) !== 0);
    expect(rampCell).toBeGreaterThanOrEqual(0);
    const command = new TerrainEditCommand();
    stageTierEdit(world, command, [rampCell], 1);
    command.apply(world);
    expect((world.flags[rampCell] as number) & w.RAMP).toBe(0);
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

    session.pointerDown(100, 0, 0);
    for (let i = 101; i < 140; i++) session.pointerMove(i, 0);
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
    session.pointerDown(100, 0, 0);
    session.pointerUp();
    const painted = new Set(rebuilt.flat());
    rebuilt.length = 0;

    session.undo();
    expect(rebuilt).toHaveLength(1);
    for (const cell of rebuilt[0] ?? []) expect(painted.has(cell)).toBe(true);
  });

  it('does no work while the pointer sits still', () => {
    const { session, rebuilt } = setup();
    session.pointerDown(100, 0, 0);
    const after = rebuilt.length;
    for (let i = 0; i < 60; i++) session.pointerMove(100, 0);
    expect(rebuilt).toHaveLength(after);
    session.pointerUp();
  });

  it('inverts the tool on the right button', () => {
    const { world, session } = setup();
    session.pointerDown(100, 0, 0);
    session.pointerUp();
    const raised = world.tier[100] as number;
    expect(raised).toBe(1);

    session.pointerDown(100, 0, 2);
    session.pointerUp();
    expect(world.tier[100]).toBe(0);
  });

  it('paints flags with the flag tools', () => {
    const { world, session } = setup();
    session.tool = tool('blocker');
    session.radius = 0;
    session.pointerDown(100, 0, 0);
    session.pointerUp();
    expect((world.flags[100] as number) & w.VISION_BLOCKER).toBeTruthy();

    session.pointerDown(100, 0, 2);
    session.pointerUp();
    expect((world.flags[100] as number) & w.VISION_BLOCKER).toBe(0);
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
    expect(session.radius).toBe(0);
    session.adjustRadius(99);
    expect(session.radius).toBe(16);
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

  it('keeps a 256x256 map legal and fast under a long stroke', () => {
    const world = w.createWorld({ width: 256, height: 256 });
    const session = createSession(world, { pick: (x) => x, rebuildCells: () => {} });
    session.tool = tool('raise');
    session.radius = 4;

    const start = performance.now();
    session.pointerDown(300 * 256 + 0, 0, 0);
    for (let i = 0; i < 400; i++) {
      session.pointerMove(w.cellIndex(world, 20 + (i % 200), 20 + ((i / 3) | 0)), 0);
    }
    session.pointerUp();
    const elapsed = performance.now() - start;

    expect(session.history.depth).toBe(1);
    expect(isTerrainLegal(world)).toBe(true);
    // 400 samples is several seconds of dragging; the whole stroke must cost
    // far less than one frame's worth of budget per sample.
    expect(elapsed / 400).toBeLessThan(16);
  });
});
