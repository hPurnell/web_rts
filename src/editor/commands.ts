/**
 * Editor commands (invariant 5).
 *
 * Every mutation of world state is a command with apply() and invert(), which
 * is what buys undo/redo for free. Commands record the *previous* value of
 * everything they touch, so invert is exact rather than reconstructed — a
 * brush that raises a tier and clamps at MAX_TIER cannot be undone by
 * subtracting one.
 */
import type { ResourceNode, StartLocation, World } from '../sim/world.ts';

export interface EditorCommand {
  readonly kind: string;
  /** Key identifying the stroke this belongs to; same key coalesces. */
  readonly coalesceKey: string | null;
  apply(world: World): void;
  invert(world: World): void;
  /** Absorb a later command of the same stroke. Returns false if it cannot. */
  merge(next: EditorCommand): boolean;
  /** True when the command would change nothing; such commands are dropped. */
  isEmpty(): boolean;
  /** Terrain cells this command moved, so the right chunks get rebuilt. */
  touchedCells?(world?: World): number[];
  /** For status readouts and tests. */
  describe(): string;
}

interface CellChange {
  beforeFlags: number;
  afterFlags: number;
}

interface CornerChange {
  beforeHeight: number;
  afterHeight: number;
}

/**
 * A terrain edit: corner heights, cell flags, or both.
 *
 * One brush stroke is one command. A corner or cell is recorded the first time
 * the stroke touches it and updated in place afterwards, so a sculpt stroke
 * that passes back over the same ground four hundred times stores one original
 * height, not four hundred copies of it — and undo restores the height the
 * ground had before the stroke, not before the last sample.
 */
export class TerrainEditCommand implements EditorCommand {
  readonly kind = 'terrain';
  private readonly cells = new Map<number, CellChange>();
  private readonly corners = new Map<number, CornerChange>();

  constructor(readonly coalesceKey: string | null = null) {}

  /** Stage a corner's new height, capturing its current one once. */
  recordCorner(world: World, corner: number, height: number): void {
    if (corner < 0 || corner >= world.heights.length) return;
    const existing = this.corners.get(corner);
    if (existing) {
      existing.afterHeight = height;
      return;
    }
    this.corners.set(corner, {
      beforeHeight: world.heights[corner] as number,
      afterHeight: height,
    });
  }

  /** Stage a cell's new flags, capturing its current ones once. */
  recordFlags(world: World, cell: number, flags: number): void {
    if (cell < 0 || cell >= world.flags.length) return;
    const existing = this.cells.get(cell);
    if (existing) {
      existing.afterFlags = flags;
      return;
    }
    this.cells.set(cell, {
      beforeFlags: world.flags[cell] as number,
      afterFlags: flags,
    });
  }

  /**
   * Cells this command touches, for deciding which chunks to rebuild.
   *
   * A corner belongs to up to four cells, and moving it changes all of them,
   * so every cell around a touched corner is reported.
   */
  touchedCells(world?: World): number[] {
    const touched = new Set<number>(this.cells.keys());
    if (world) {
      const stride = world.width + 1;
      for (const corner of this.corners.keys()) {
        const cx = corner % stride;
        const cz = (corner / stride) | 0;
        for (const [dx, dz] of [
          [0, 0],
          [-1, 0],
          [0, -1],
          [-1, -1],
        ] as const) {
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= world.width || z >= world.height) continue;
          touched.add(z * world.width + x);
        }
      }
    }
    return [...touched];
  }

  /** Corners this command moved. */
  touchedCorners(): number[] {
    return [...this.corners.keys()];
  }

  apply(world: World): void {
    for (const [corner, change] of this.corners) world.heights[corner] = change.afterHeight;
    for (const [cell, change] of this.cells) world.flags[cell] = change.afterFlags;
  }

  invert(world: World): void {
    for (const [corner, change] of this.corners) world.heights[corner] = change.beforeHeight;
    for (const [cell, change] of this.cells) world.flags[cell] = change.beforeFlags;
  }

  merge(next: EditorCommand): boolean {
    if (!(next instanceof TerrainEditCommand)) return false;
    if (next.coalesceKey === null || next.coalesceKey !== this.coalesceKey) return false;
    for (const [corner, change] of next.corners) {
      const existing = this.corners.get(corner);
      if (existing) existing.afterHeight = change.afterHeight;
      else this.corners.set(corner, { ...change });
    }
    for (const [cell, change] of next.cells) {
      const existing = this.cells.get(cell);
      if (existing) existing.afterFlags = change.afterFlags;
      else this.cells.set(cell, { ...change });
    }
    return true;
  }

  isEmpty(): boolean {
    for (const change of this.corners.values()) {
      if (change.beforeHeight !== change.afterHeight) return false;
    }
    for (const change of this.cells.values()) {
      if (change.beforeFlags !== change.afterFlags) return false;
    }
    return true;
  }

  describe(): string {
    return `terrain (${this.corners.size} corners, ${this.cells.size} cells)`;
  }
}

/**
 * Several commands as one undo step.
 *
 * Placing a resource patch is two edits — the node list and the flags of the
 * cell under it — and undoing half of that would leave the map inconsistent.
 */
export class CompositeCommand implements EditorCommand {
  readonly kind = 'composite';
  readonly coalesceKey = null;

  constructor(private readonly parts: readonly EditorCommand[]) {}

  apply(world: World): void {
    for (const part of this.parts) part.apply(world);
  }

  invert(world: World): void {
    // Reverse order: later parts may depend on what earlier ones did.
    for (let i = this.parts.length - 1; i >= 0; i--) this.parts[i]?.invert(world);
  }

  merge(): boolean {
    return false;
  }

  isEmpty(): boolean {
    return this.parts.every((part) => part.isEmpty());
  }

  describe(): string {
    return this.parts.map((part) => part.describe()).join(' + ');
  }

  touchedCells(world?: World): number[] {
    return this.parts.flatMap((part) => part.touchedCells?.(world) ?? []);
  }
}

/** Add, remove or edit resource nodes. Used from M13. */
export class ResourceNodeCommand implements EditorCommand {
  readonly kind = 'resource-nodes';
  readonly coalesceKey = null;
  private before: ResourceNode[] = [];

  constructor(private readonly next: readonly ResourceNode[]) {}

  apply(world: World): void {
    this.before = world.resourceNodes.map((n) => ({ ...n }));
    world.resourceNodes = this.next.map((n) => ({ ...n }));
  }

  invert(world: World): void {
    world.resourceNodes = this.before.map((n) => ({ ...n }));
  }

  merge(): boolean {
    return false;
  }

  isEmpty(): boolean {
    return false;
  }

  describe(): string {
    return `resource nodes (${this.next.length})`;
  }
}

/** Add, remove or move start locations. Used from M13. */
export class StartLocationCommand implements EditorCommand {
  readonly kind = 'start-locations';
  readonly coalesceKey = null;
  private before: StartLocation[] = [];

  constructor(private readonly next: readonly StartLocation[]) {}

  apply(world: World): void {
    this.before = world.startLocations.map((s) => ({ ...s }));
    world.startLocations = this.next.map((s) => ({ ...s }));
  }

  invert(world: World): void {
    world.startLocations = this.before.map((s) => ({ ...s }));
  }

  merge(): boolean {
    return false;
  }

  isEmpty(): boolean {
    return false;
  }

  describe(): string {
    return `start locations (${this.next.length})`;
  }
}
