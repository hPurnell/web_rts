/**
 * The editing session: the piece that connects a pointer to world state.
 *
 * It owns the history, translates pointer events into brush strokes, and
 * rebuilds only the terrain chunks an edit actually touched. It is deliberately
 * free of Babylon types — it takes a `pick` callback and a `rebuildChunks`
 * callback — so the whole editing loop can be driven from a test.
 */
import type { World } from '../sim/world.ts';
import { BUILDABLE, VISION_BLOCKER } from '../sim/world.ts';
import { EditorHistory } from './history.ts';
import { TerrainEditCommand } from './commands.ts';
import { brushCells, stageFlagEdit, stageTierEdit, MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from './brush.ts';
import type { EditorTool } from './shell.ts';

export interface SessionHooks {
  /** Cell under a screen position, or -1. */
  pick(screenX: number, screenY: number): number;
  /** Rebuild the terrain meshes covering these cells. */
  rebuildCells(cells: readonly number[]): void;
  /** Called when the undo/redo availability or stroke state changes. */
  onChange?(): void;
}

export interface EditorSession {
  readonly history: EditorHistory;
  radius: number;
  tool: EditorTool | null;
  /** Cell the pointer is over, or -1. */
  hoverCell: number;
  pointerDown(screenX: number, screenY: number, button: number): void;
  pointerMove(screenX: number, screenY: number): void;
  pointerUp(): void;
  adjustRadius(delta: number): void;
  undo(): void;
  redo(): void;
  dispose(): void;
}

/** Which flag each flag-painting tool writes. */
const FLAG_TOOLS: Record<string, number> = {
  buildable: BUILDABLE,
  blocker: VISION_BLOCKER,
};

export function createSession(world: World, hooks: SessionHooks): EditorSession {
  const history = new EditorHistory(world, 256, () => hooks.onChange?.());
  let strokeId = 0;
  let painting = false;
  /** Right button inverts the tool: raise becomes lower, set becomes clear. */
  let inverted = false;
  let lastCell = -1;

  const session: EditorSession = {
    history,
    radius: 2,
    tool: null,
    hoverCell: -1,

    pointerDown(screenX, screenY, button) {
      if (button !== 0 && button !== 2) return;
      const cell = hooks.pick(screenX, screenY);
      if (cell < 0) return;
      painting = true;
      inverted = button === 2;
      lastCell = -1;
      history.beginStroke(`stroke-${++strokeId}`);
      paint(cell);
    },

    pointerMove(screenX, screenY) {
      const cell = hooks.pick(screenX, screenY);
      session.hoverCell = cell;
      if (!painting || cell < 0) return;
      paint(cell);
    },

    pointerUp() {
      if (!painting) return;
      painting = false;
      lastCell = -1;
      history.endStroke();
      hooks.onChange?.();
    },

    adjustRadius(delta) {
      const next = session.radius + delta;
      session.radius = Math.max(MIN_BRUSH_RADIUS, Math.min(MAX_BRUSH_RADIUS, next));
      hooks.onChange?.();
    },

    undo() {
      const command = history.undo();
      if (command instanceof TerrainEditCommand) hooks.rebuildCells(command.touchedCells());
      else if (command) hooks.rebuildCells([]);
      hooks.onChange?.();
    },

    redo() {
      const command = history.redo();
      if (command instanceof TerrainEditCommand) hooks.rebuildCells(command.touchedCells());
      else if (command) hooks.rebuildCells([]);
      hooks.onChange?.();
    },

    dispose() {
      if (painting) session.pointerUp();
      history.clear();
    },
  };

  function paint(cell: number): void {
    // Sampling the same cell twice in a row does no work: a pointer that sits
    // still would otherwise re-stage the same edit sixty times a second.
    if (cell === lastCell) return;
    lastCell = cell;

    const tool = session.tool;
    if (!tool) return;

    const command = new TerrainEditCommand(`stroke-${strokeId}`);
    const cells = brushCells(world, cell, session.radius);
    let changed = 0;

    if (tool.id === 'raise' || tool.id === 'lower') {
      const raising = tool.id === 'raise' ? !inverted : inverted;
      changed = stageTierEdit(world, command, cells, raising ? 1 : -1);
    } else {
      const flag = FLAG_TOOLS[tool.id];
      if (flag === undefined) return;
      changed = stageFlagEdit(world, command, cells, flag, !inverted);
    }

    if (changed === 0) return;
    // Capture the touched cells before apply: the command is merged into the
    // stroke's command by push(), after which it is no longer the owner.
    const touched = command.touchedCells();
    history.push(command);
    hooks.rebuildCells(touched);
  }

  return session;
}
