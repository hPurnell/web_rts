/**
 * The editing session: the piece that connects a pointer to world state.
 *
 * It owns the history, translates pointer events into brush strokes, and
 * rebuilds only the terrain chunks an edit actually touched. It is deliberately
 * free of Babylon types — it takes a `pick` callback and a `rebuildChunks`
 * callback — so the whole editing loop can be driven from a test.
 */
import type { World } from '../sim/world.ts';
import { BUILDABLE, ResourceType, VISION_BLOCKER } from '../sim/world.ts';
import { EditorHistory } from './history.ts';
import {
  CompositeCommand,
  ResourceNodeCommand,
  StartLocationCommand,
  TerrainEditCommand,
} from './commands.ts';
import {
  clearedResourceCellFlags,
  placeResourceNode,
  placeStartLocation,
  removeResourceNode,
  removeStartLocation,
  resourceCellFlags,
  whatIsAt,
} from './placement.ts';
import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  brushCells,
  brushCorners,
  rampTarget,
  stageFlagEdit,
  stageSculpt,
} from './sculpt.ts';
import type { SculptMode } from './sculpt.ts';
import { cornerStride, heightAt } from '../sim/terrain.ts';
import { worldFromCell } from '../sim/world.ts';
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
  /** Why the last action was refused, or null. Shown in the status bar. */
  readonly lastError: string | null;
  /** Cell a ramp drag started on, or -1 when no ramp drag is in progress. */
  readonly rampAnchor: number;
  /** Height the current flatten or ramp stroke is pulling toward. */
  readonly referenceHeight: number;
  /** Which resource the resource tool places. */
  resourceType: ResourceType;
  /** Cycle the resource tool between minerals and gas. */
  toggleResourceType(): void;
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

/** Which sculpt mode each terrain tool uses. */
const SCULPT_TOOLS: Record<string, SculptMode> = {
  raise: 'raise',
  lower: 'lower',
  smooth: 'smooth',
  flatten: 'flatten',
  noise: 'noise',
};

export function createSession(world: World, hooks: SessionHooks): EditorSession {
  const history = new EditorHistory(world, 256, () => hooks.onChange?.());
  let strokeId = 0;
  let painting = false;
  /** Right button inverts the tool: raise becomes lower, set becomes clear. */
  let inverted = false;
  let lastCell = -1;
  let rampAnchor = -1;
  let referenceHeight = 0;
  let strokeSeed = 0;
  let lastError: string | null = null;

  const session: EditorSession = {
    history,
    radius: 2,
    tool: null,
    hoverCell: -1,
    resourceType: ResourceType.Minerals,
    toggleResourceType() {
      session.resourceType =
        session.resourceType === ResourceType.Minerals ? ResourceType.Gas : ResourceType.Minerals;
      hooks.onChange?.();
    },
    get lastError() {
      return lastError;
    },
    get rampAnchor() {
      return rampAnchor;
    },
    get referenceHeight() {
      return referenceHeight;
    },

    pointerDown(screenX, screenY, button) {
      if (button !== 0 && button !== 2) return;
      const cell = hooks.pick(screenX, screenY);
      if (cell < 0) return;
      lastError = null;
      inverted = button === 2;

      // A ramp is a drag, not a stroke: it needs both ends before it can
      // decide anything. Unlike the old ramp tool it places no object — it
      // sculpts the ground between the two ends into a straight incline, and
      // whether that is walkable is then just a fact about its slope.
      if (session.tool?.id === 'ramp' && !inverted) {
        rampAnchor = cell;
        referenceHeight = sampleHeight(cell);
        hooks.onChange?.();
        return;
      }

      // Placements are single clicks, not strokes.
      if (session.tool?.id === 'resource') {
        placeOrRemoveNode(cell, inverted);
        hooks.onChange?.();
        return;
      }
      if (session.tool?.id === 'start') {
        placeOrRemoveStart(cell, inverted);
        hooks.onChange?.();
        return;
      }

      painting = true;
      lastCell = -1;
      // Flatten pulls toward the ground the stroke started on, so the height
      // is sampled once at the start rather than chased per sample.
      referenceHeight = sampleHeight(cell);
      strokeSeed = ++strokeId;
      history.beginStroke(`stroke-${strokeId}`);
      paint(cell);
    },

    pointerMove(screenX, screenY) {
      const cell = hooks.pick(screenX, screenY);
      session.hoverCell = cell;
      if (!painting || cell < 0) return;
      paint(cell);
    },

    pointerUp() {
      if (rampAnchor >= 0) {
        sculptRamp(rampAnchor, session.hoverCell);
        rampAnchor = -1;
        hooks.onChange?.();
        return;
      }
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
      rebuildFor(history.undo());
      hooks.onChange?.();
    },

    redo() {
      rebuildFor(history.redo());
      hooks.onChange?.();
    },

    dispose() {
      if (painting) session.pointerUp();
      history.clear();
    },
  };

  /** Rebuild whatever terrain an undone or redone command moved. */
  function rebuildFor(command: ReturnType<EditorHistory['undo']>): void {
    if (!command) return;
    hooks.rebuildCells(command.touchedCells?.(world) ?? []);
  }

  function placeOrRemoveNode(cell: number, remove: boolean): void {
    const removing = remove || whatIsAt(world, cell) === 'node';
    const result = removing
      ? removeResourceNode(world, cell)
      : placeResourceNode(world, cell, session.resourceType);
    if (!result.ok || !result.nodes) {
      lastError = result.reason;
      return;
    }

    // The cells under a patch stop being buildable and start blocking sight,
    // so the flag edit travels with the list edit as one undo step.
    const flagCommand = new TerrainEditCommand(null);
    for (const flagCell of result.flagCells ?? []) {
      const current = world.flags[flagCell] as number;
      const next = removing ? clearedResourceCellFlags(current) : resourceCellFlags(current);
      if (next !== current) flagCommand.recordFlags(world, flagCell, next);
    }

    const touched = flagCommand.touchedCells(world);
    history.push(
      flagCommand.isEmpty()
        ? new ResourceNodeCommand(result.nodes)
        : new CompositeCommand([new ResourceNodeCommand(result.nodes), flagCommand]),
    );
    if (touched.length > 0) hooks.rebuildCells(touched);
  }

  function placeOrRemoveStart(cell: number, remove: boolean): void {
    const removing = remove || whatIsAt(world, cell) === 'start';
    const result = removing ? removeStartLocation(world, cell) : placeStartLocation(world, cell);
    if (!result.ok || !result.starts) {
      lastError = result.reason;
      return;
    }
    history.push(new StartLocationCommand(result.starts));
  }

  /** Sample the terrain height at a cell's centre. */
  function sampleHeight(cell: number): number {
    if (cell < 0) return 0;
    const centre = worldFromCell(world, cell);
    return heightAt(world, centre.x, centre.z);
  }

  /**
   * Sculpt a straight incline between two cells.
   *
   * Every corner near the drag is pulled toward the height it would have if
   * the ground ran linearly from one end to the other. There is no validation
   * to do: an incline too steep to climb is simply a cliff, which the slope
   * overlay will show and the nav grid will refuse.
   */
  function sculptRamp(fromCell: number, toCell: number): void {
    if (fromCell < 0 || toCell < 0 || fromCell === toCell) return;
    const stride = cornerStride(world);
    const cornerOf = (cell: number): number =>
      ((cell / world.width) | 0) * stride + (cell % world.width);
    const fromCorner = cornerOf(fromCell);
    const toCorner = cornerOf(toCell);
    const fromHeight = referenceHeight;
    const toHeight = sampleHeight(toCell);

    const command = new TerrainEditCommand(null);
    // Walk the drag and brush along it, so the incline is as wide as the brush.
    const steps = Math.max(
      Math.abs((toCell % world.width) - (fromCell % world.width)),
      Math.abs(((toCell / world.width) | 0) - ((fromCell / world.width) | 0)),
    );
    let changed = 0;
    for (let step = 0; step <= steps; step++) {
      const t = steps === 0 ? 0 : step / steps;
      const x = Math.round(
        (fromCell % world.width) + ((toCell % world.width) - (fromCell % world.width)) * t,
      );
      const z = Math.round(
        ((fromCell / world.width) | 0) +
          ((((toCell / world.width) | 0) - ((fromCell / world.width) | 0)) * t),
      );
      for (const sample of brushCorners(world, z * stride + x, session.radius)) {
        const target = rampTarget(world, sample.corner, fromCorner, toCorner, fromHeight, toHeight);
        changed += stageSculpt(world, command, [sample], { mode: 'ramp', reference: target });
      }
    }

    if (changed === 0) return;
    const touched = command.touchedCells(world);
    history.push(command);
    hooks.rebuildCells(touched);
  }

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

    const sculptMode = SCULPT_TOOLS[tool.id];
    if (sculptMode !== undefined) {
      // Right-dragging inverts: raise becomes lower, and vice versa.
      const mode: SculptMode =
        inverted && sculptMode === 'raise'
          ? 'lower'
          : inverted && sculptMode === 'lower'
            ? 'raise'
            : sculptMode;
      const stride = cornerStride(world);
      const centreCorner = ((cell / world.width) | 0) * stride + (cell % world.width);
      changed = stageSculpt(world, command, brushCorners(world, centreCorner, session.radius), {
        mode,
        reference: referenceHeight,
        seed: strokeSeed,
      });
    } else {
      const flag = FLAG_TOOLS[tool.id];
      if (flag === undefined) return;
      changed = stageFlagEdit(world, command, cells, flag, !inverted);
    }

    if (changed === 0) return;
    // Capture the touched cells before apply: the command is merged into the
    // stroke's command by push(), after which it is no longer the owner.
    const touched = command.touchedCells(world);
    history.push(command);
    hooks.rebuildCells(touched);
  }

  return session;
}
