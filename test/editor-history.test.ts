import { describe, expect, it, vi } from 'vitest';
import { EditorHistory } from '../src/editor/history.ts';
import {
  ResourceNodeCommand,
  StartLocationCommand,
  TerrainEditCommand,
} from '../src/editor/commands.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import * as w from '../src/sim/world.ts';
import { makeRand, nextRange } from '../src/sim/rand.ts';
import { HEIGHT_MAX, cornerStride } from '../src/sim/terrain.ts';
import { fromInt } from '../src/sim/fixed.ts';

/** Build a terrain edit that raises one corner a unit, clamped. */
function raise(world: w.World, corner: number, key: string | null = null): TerrainEditCommand {
  const command = new TerrainEditCommand(key);
  const height = Math.min((world.heights[corner] as number) + fromInt(1), HEIGHT_MAX);
  command.recordCorner(world, corner, height);
  return command;
}

describe('editor commands', () => {
  it('invert restores the exact previous value, not an arithmetic inverse', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    world.heights[0] = HEIGHT_MAX;
    const command = raise(world, 0);
    const history = new EditorHistory(world);
    history.push(command);
    // Raising ground already at the ceiling clamps; subtracting a unit on
    // undo would leave it lower than it started.
    expect(world.heights[0]).toBe(HEIGHT_MAX);
    history.undo();
    expect(world.heights[0]).toBe(HEIGHT_MAX);
  });

  it('records a corner once however many times a stroke crosses it', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const command = new TerrainEditCommand('stroke');
    command.recordCorner(world, 5, fromInt(1));
    command.recordCorner(world, 5, fromInt(2));
    command.recordCorner(world, 5, fromInt(3));
    command.apply(world);
    expect(world.heights[5]).toBe(fromInt(3));
    command.invert(world);
    expect(world.heights[5]).toBe(0);
    expect(command.touchedCorners()).toEqual([5]);
  });

  it('expands a touched corner into the cells that share it', () => {
    // A corner belongs to up to four cells, and all four change shape when it
    // moves. Rebuilding only one of them would leave three stale.
    const world = w.createWorld({ width: 4, height: 4 });
    const stride = cornerStride(world);
    const command = new TerrainEditCommand(null);
    command.recordCorner(world, 2 * stride + 2, fromInt(1));
    expect(command.touchedCells(world).sort((a, b) => a - b)).toEqual([
      w.cellIndex(world, 1, 1),
      w.cellIndex(world, 2, 1),
      w.cellIndex(world, 1, 2),
      w.cellIndex(world, 2, 2),
    ].sort((a, b) => a - b));
  });

  it('drops commands that change nothing', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const history = new EditorHistory(world);
    const noop = new TerrainEditCommand();
    noop.recordCorner(world, 3, world.heights[3] as number);
    expect(noop.isEmpty()).toBe(true);
    expect(history.push(noop)).toBe(false);
    expect(history.depth).toBe(0);
  });
});

describe('undo and redo', () => {
  it('restores a byte-identical world after 100 commands', () => {
    const world = createTestMap();
    const original = w.hashWorld(world);
    const history = new EditorHistory(world);
    const rand = makeRand(4242);

    for (let i = 0; i < 100; i++) {
      const command = new TerrainEditCommand();
      command.recordCorner(
        world,
        nextRange(rand, 0, world.heights.length),
        fromInt(nextRange(rand, 1, 12)),
      );
      command.recordFlags(world, nextRange(rand, 0, world.flags.length), nextRange(rand, 0, 16));
      history.push(command);
    }

    const mutated = w.hashWorld(world);
    expect(mutated).not.toBe(original);
    // A few random edits land on values the cell already had; those are
    // dropped rather than recorded, so depth is at most the command count.
    expect(history.depth).toBeGreaterThan(90);
    expect(history.depth).toBeLessThanOrEqual(100);

    while (history.canUndo) history.undo();
    expect(w.hashWorld(world)).toBe(original);
    expect(world.heights).toEqual(createTestMap().heights);
    expect(world.flags).toEqual(createTestMap().flags);

    while (history.canRedo) history.redo();
    expect(w.hashWorld(world)).toBe(mutated);
  });

  it('undoes and redoes in strict order', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const history = new EditorHistory(world);
    const one = fromInt(1);
    for (let i = 0; i < 3; i++) history.push(raise(world, i));
    expect(Array.from(world.heights.slice(0, 3))).toEqual([one, one, one]);

    history.undo();
    expect(Array.from(world.heights.slice(0, 3))).toEqual([one, one, 0]);
    history.undo();
    expect(Array.from(world.heights.slice(0, 3))).toEqual([one, 0, 0]);
    history.redo();
    expect(Array.from(world.heights.slice(0, 3))).toEqual([one, one, 0]);
  });

  it('discards the redo stack once a new command is pushed', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const history = new EditorHistory(world);
    history.push(raise(world, 0));
    history.undo();
    expect(history.canRedo).toBe(true);
    history.push(raise(world, 1));
    expect(history.canRedo).toBe(false);
  });

  it('is a no-op at either end of the stack', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const history = new EditorHistory(world);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    const before = w.hashWorld(world);
    history.push(raise(world, 0));
    history.undo();
    history.undo();
    expect(w.hashWorld(world)).toBe(before);
  });

  it('bounds the stack and keeps the newest entries', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const history = new EditorHistory(world, 10);
    for (let i = 0; i < 25; i++) history.push(raise(world, i));
    expect(history.depth).toBe(10);
    while (history.canUndo) history.undo();
    // The oldest 15 edits are past the horizon and stay applied.
    expect(Array.from(world.heights.slice(0, 15)).every((h) => h === fromInt(1))).toBe(true);
    expect(Array.from(world.heights.slice(15, 25)).every((h) => h === 0)).toBe(true);
  });

  it('reports changes to a listener', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const onChange = vi.fn();
    const history = new EditorHistory(world, 64, onChange);
    history.push(raise(world, 0));
    history.undo();
    history.redo();
    history.clear();
    expect(onChange.mock.calls.map((c) => c[0].type)).toEqual(['apply', 'undo', 'redo', 'clear']);
  });
});

describe('stroke coalescing', () => {
  it('turns a 400-sample drag into one undo entry', () => {
    const world = createTestMap();
    const before = w.hashWorld(world);
    const history = new EditorHistory(world);

    history.beginStroke('stroke-1');
    for (let i = 0; i < 400; i++) {
      const corner = (i * 7) % world.heights.length;
      const command = new TerrainEditCommand('stroke-1');
      command.recordCorner(world, corner, fromInt(3));
      history.push(command);
    }
    history.endStroke();

    expect(history.depth).toBe(1);
    expect(w.hashWorld(world)).not.toBe(before);
    history.undo();
    expect(w.hashWorld(world)).toBe(before);
  });

  it('keeps separate strokes separate', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const history = new EditorHistory(world);
    const stride = cornerStride(world);
    // Each stroke paints a different row of corners, so none is a no-op.
    ['a', 'b', 'c'].forEach((key, stroke) => {
      history.beginStroke(key);
      for (let i = 0; i < 5; i++) {
        const command = new TerrainEditCommand(key);
        command.recordCorner(world, stroke * stride + i, fromInt(stroke + 1));
        history.push(command);
      }
      history.endStroke();
    });
    expect(history.depth).toBe(3);
    history.undo();
    expect(world.heights[2 * stride]).toBe(0); // the third stroke is undone
    expect(world.heights[stride]).toBe(fromInt(2)); // the second still stands
  });

  it('does not coalesce commands pushed outside a stroke', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const history = new EditorHistory(world);
    for (let i = 0; i < 4; i++) history.push(raise(world, i, 'stroke'));
    expect(history.depth).toBe(4);
  });

  it('leaves no entry for a stroke that changed nothing', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    const history = new EditorHistory(world);
    history.beginStroke('empty');
    for (let i = 0; i < 5; i++) {
      const command = new TerrainEditCommand('empty');
      command.recordCorner(world, i, world.heights[i] as number);
      history.push(command);
    }
    history.endStroke();
    expect(history.depth).toBe(0);
  });
});

describe('list commands', () => {
  it('round-trips resource nodes and start locations', () => {
    const world = createTestMap();
    const before = w.hashWorld(world);
    const history = new EditorHistory(world);

    history.push(
      new ResourceNodeCommand([{ cell: 5, type: w.ResourceType.Gas, amount: 100 }]),
    );
    history.push(new StartLocationCommand([{ cell: 9 }, { cell: 11 }, { cell: 13 }]));
    expect(world.resourceNodes).toHaveLength(1);
    expect(world.startLocations).toHaveLength(3);

    history.undo();
    history.undo();
    expect(w.hashWorld(world)).toBe(before);

    history.redo();
    history.redo();
    expect(world.resourceNodes[0]?.amount).toBe(100);
    expect(world.startLocations).toHaveLength(3);
  });

  it('copies rather than aliasing the callers arrays', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    const nodes = [{ cell: 1, type: w.ResourceType.Minerals, amount: 50 }];
    const history = new EditorHistory(world);
    history.push(new ResourceNodeCommand(nodes));
    nodes[0]!.amount = 999;
    expect(world.resourceNodes[0]?.amount).toBe(50);
  });
});
