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
  /** For status readouts and tests. */
  describe(): string;
}

interface CellChange {
  beforeTier: number;
  beforeFlags: number;
  afterTier: number;
  afterFlags: number;
}

/**
 * A terrain edit: any number of cells changing tier and/or flags.
 *
 * One brush stroke is one command. Cells are recorded the first time they are
 * touched, so dragging back over a cell does not stack up redundant history.
 */
export class TerrainEditCommand implements EditorCommand {
  readonly kind = 'terrain';
  private readonly changes = new Map<number, CellChange>();

  constructor(readonly coalesceKey: string | null = null) {}

  /** Stage a cell's new tier and flags, capturing its current values once. */
  record(world: World, cell: number, tier: number, flags: number): void {
    if (cell < 0 || cell >= world.tier.length) return;
    const existing = this.changes.get(cell);
    if (existing) {
      existing.afterTier = tier;
      existing.afterFlags = flags;
      return;
    }
    this.changes.set(cell, {
      beforeTier: world.tier[cell] as number,
      beforeFlags: world.flags[cell] as number,
      afterTier: tier,
      afterFlags: flags,
    });
  }

  /** Cells this command touches, for deciding which chunks to rebuild. */
  touchedCells(): number[] {
    return [...this.changes.keys()];
  }

  apply(world: World): void {
    for (const [cell, change] of this.changes) {
      world.tier[cell] = change.afterTier;
      world.flags[cell] = change.afterFlags;
    }
  }

  invert(world: World): void {
    for (const [cell, change] of this.changes) {
      world.tier[cell] = change.beforeTier;
      world.flags[cell] = change.beforeFlags;
    }
  }

  merge(next: EditorCommand): boolean {
    if (!(next instanceof TerrainEditCommand)) return false;
    if (next.coalesceKey === null || next.coalesceKey !== this.coalesceKey) return false;
    for (const [cell, change] of next.changes) {
      const existing = this.changes.get(cell);
      if (existing) {
        existing.afterTier = change.afterTier;
        existing.afterFlags = change.afterFlags;
      } else {
        this.changes.set(cell, { ...change });
      }
    }
    return true;
  }

  isEmpty(): boolean {
    for (const change of this.changes.values()) {
      if (change.beforeTier !== change.afterTier) return false;
      if (change.beforeFlags !== change.afterFlags) return false;
    }
    return true;
  }

  describe(): string {
    return `terrain (${this.changes.size} cells)`;
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
