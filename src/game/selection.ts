/**
 * Unit selection and control groups.
 *
 * Selection holds handles rather than indices, so a unit dying cannot turn a
 * selection into a reference to whoever recycles its slot — the generation in
 * the handle makes the stale entry resolve to nothing, and prune() drops it.
 */
import type { UnitHandle, UnitStore } from '../sim/units.ts';
import { NULL_HANDLE, resolve } from '../sim/units.ts';
import type { ScreenRect } from './project.ts';
import { projectPoint, rectContains } from './project.ts';
import { toFloat } from '../sim/fixed.ts';

export const CONTROL_GROUP_COUNT = 10;
/** A drag smaller than this many pixels square counts as a click. */
export const CLICK_THRESHOLD_PX = 5;

export class Selection {
  private handles: UnitHandle[] = [];
  private readonly members = new Set<UnitHandle>();

  get count(): number {
    return this.handles.length;
  }

  /** Selected handles in selection order. */
  list(): readonly UnitHandle[] {
    return this.handles;
  }

  has(handle: UnitHandle): boolean {
    return this.members.has(handle);
  }

  clear(): void {
    this.handles = [];
    this.members.clear();
  }

  set(handles: Iterable<UnitHandle>): void {
    this.clear();
    this.add(handles);
  }

  add(handles: Iterable<UnitHandle>): void {
    for (const handle of handles) {
      if (handle === NULL_HANDLE || this.members.has(handle)) continue;
      this.members.add(handle);
      this.handles.push(handle);
    }
  }

  remove(handles: Iterable<UnitHandle>): void {
    for (const handle of handles) {
      if (!this.members.delete(handle)) continue;
      const index = this.handles.indexOf(handle);
      if (index >= 0) this.handles.splice(index, 1);
    }
  }

  /** Add if absent, remove if present — what shift-clicking a unit does. */
  toggle(handle: UnitHandle): void {
    if (this.members.has(handle)) this.remove([handle]);
    else this.add([handle]);
  }

  /** Drop handles whose units are gone. Cheap enough to run every tick. */
  prune(store: UnitStore): number {
    const before = this.handles.length;
    if (before === 0) return 0;
    const kept: UnitHandle[] = [];
    for (const handle of this.handles) {
      if (resolve(store, handle) >= 0) kept.push(handle);
      else this.members.delete(handle);
    }
    this.handles = kept;
    return before - kept.length;
  }
}

export interface PickOptions {
  /** Only select units owned by this player; -1 selects anyone's. */
  readonly ownerId: number;
  readonly width: number;
  readonly height: number;
  /**
   * World-space Y of the ground under a unit, so it projects to where it is
   * drawn rather than to where sea level would be.
   *
   * This existed as a hard-coded 0, which was nearly harmless when terrain was
   * five flat tiers and the camera looked at the lowest one. Over a heightfield
   * a unit on a six-unit plateau projects most of a screen below itself, and
   * the only way to catch it is to drag a box over the whole view — which is
   * exactly how the bug was reported.
   *
   * Defaults to flat ground, so callers that genuinely have none (the unit
   * tests, and anything on a flat map) need not supply it.
   */
  readonly groundY?: (x: number, z: number) => number;
}

/**
 * The world Y a unit is drawn at: the ground under it plus its altitude.
 *
 * A helicopter is drawn several units above the ground, and projecting it at
 * ground height puts its selection box under the terrain it is flying over —
 * the same class of bug as the hard-coded zero above, and invisible until
 * something actually flies.
 */
function drawnY(store: UnitStore, index: number, x: number, z: number, options: PickOptions): number {
  return (options.groundY?.(x, z) ?? 0) + toFloat(store.altitude[index] as number);
}

/**
 * Units whose centre projects inside a screen rect.
 *
 * Ownership is filtered first because it is a byte compare, and it removes
 * most of the store before any arithmetic happens in a two-player match.
 */
export function unitsInRect(
  store: UnitStore,
  viewProjection: ArrayLike<number>,
  rect: ScreenRect,
  options: PickOptions,
): UnitHandle[] {
  const found: UnitHandle[] = [];
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (options.ownerId >= 0 && store.ownerId[i] !== options.ownerId) continue;
    const x = toFloat(store.posX[i] as number);
    const z = toFloat(store.posZ[i] as number);
    const point = projectPoint(
      viewProjection,
      x,
      drawnY(store, i, x, z, options),
      z,
      options.width,
      options.height,
    );
    if (!point.visible || !rectContains(rect, point.x, point.y)) continue;
    found.push(handleAt(store, i));
  }
  return found;
}

/** The nearest unit to a screen position within `radiusPx`, or NULL_HANDLE. */
export function unitAtPoint(
  store: UnitStore,
  viewProjection: ArrayLike<number>,
  screenX: number,
  screenY: number,
  radiusPx: number,
  options: PickOptions,
): UnitHandle {
  let best = NULL_HANDLE;
  let bestDistance = radiusPx * radiusPx;
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (options.ownerId >= 0 && store.ownerId[i] !== options.ownerId) continue;
    const x = toFloat(store.posX[i] as number);
    const z = toFloat(store.posZ[i] as number);
    const point = projectPoint(
      viewProjection,
      x,
      drawnY(store, i, x, z, options),
      z,
      options.width,
      options.height,
    );
    if (!point.visible) continue;
    const dx = point.x - screenX;
    const dy = point.y - screenY;
    const distance = dx * dx + dy * dy;
    if (distance > bestDistance) continue;
    bestDistance = distance;
    best = handleAt(store, i);
  }
  return best;
}

/** Every on-screen unit of the same type and owner as `handle`. */
export function sameTypeOnScreen(
  store: UnitStore,
  viewProjection: ArrayLike<number>,
  handle: UnitHandle,
  options: PickOptions,
): UnitHandle[] {
  const index = resolve(store, handle);
  if (index < 0) return [];
  const typeId = store.typeId[index];
  const ownerId = store.ownerId[index];
  const screen: ScreenRect = {
    left: 0,
    top: 0,
    right: options.width,
    bottom: options.height,
  };
  return unitsInRect(store, viewProjection, screen, { ...options, ownerId: ownerId as number }).filter(
    (candidate) => {
      const i = resolve(store, candidate);
      return i >= 0 && store.typeId[i] === typeId;
    },
  );
}

function handleAt(store: UnitStore, index: number): UnitHandle {
  return (index | ((store.generation[index] as number) << 20)) >>> 0;
}

/**
 * The ten control groups.
 *
 * SC2 semantics: a number sets the group from the current selection, shift and
 * a number adds to it, and pressing the number alone recalls it. Groups store
 * handles, so units that die simply stop being in the group.
 */
export class ControlGroups {
  private readonly groups: UnitHandle[][] = Array.from(
    { length: CONTROL_GROUP_COUNT },
    () => [],
  );

  set(index: number, handles: readonly UnitHandle[]): void {
    if (!this.valid(index)) return;
    this.groups[index] = [...handles];
  }

  add(index: number, handles: readonly UnitHandle[]): void {
    if (!this.valid(index)) return;
    const group = this.groups[index] as UnitHandle[];
    const present = new Set(group);
    for (const handle of handles) {
      if (present.has(handle)) continue;
      present.add(handle);
      group.push(handle);
    }
  }

  /** Live members of a group, pruning dead ones as a side effect. */
  recall(index: number, store: UnitStore): UnitHandle[] {
    if (!this.valid(index)) return [];
    const group = (this.groups[index] as UnitHandle[]).filter(
      (handle) => resolve(store, handle) >= 0,
    );
    this.groups[index] = group;
    return [...group];
  }

  size(index: number): number {
    return this.valid(index) ? (this.groups[index] as UnitHandle[]).length : 0;
  }

  clear(): void {
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) this.groups[i] = [];
  }

  private valid(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < CONTROL_GROUP_COUNT;
  }
}
