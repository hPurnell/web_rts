/**
 * Turning mouse and keyboard input into selection changes.
 *
 * Kept separate from the Selection model so the SC2 conventions — shift adds,
 * ctrl-click takes the type, double-click takes the type on screen, digits
 * drive control groups — live in one readable place rather than smeared
 * through event handlers.
 */
import type { UnitHandle, UnitStore } from '../sim/units.ts';
import { NULL_HANDLE } from '../sim/units.ts';
import { ControlGroups, Selection, CLICK_THRESHOLD_PX, sameTypeOnScreen, unitAtPoint, unitsInRect } from './selection.ts';
import { rectArea, rectFromDrag } from './project.ts';

/** How close a click must land to a unit's centre to pick it, in pixels. */
export const CLICK_PICK_RADIUS_PX = 22;
/** Two clicks within this many milliseconds are a double-click. */
export const DOUBLE_CLICK_MS = 320;

export interface SelectionModifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
}

export interface ViewInfo {
  readonly viewProjection: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

export interface DragBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export class SelectionController {
  readonly selection = new Selection();
  readonly groups = new ControlGroups();

  private dragStartX = 0;
  private dragStartY = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private lastClickAt = -Infinity;
  private lastClickHandle: UnitHandle = NULL_HANDLE;

  constructor(private readonly localPlayer: number) {}

  /** The box to draw while dragging, or null when not dragging. */
  dragBox(): DragBox | null {
    if (!this.dragging) return null;
    return rectFromDrag(this.dragStartX, this.dragStartY, this.dragX, this.dragY);
  }

  beginDrag(x: number, y: number): void {
    this.dragging = true;
    this.dragStartX = x;
    this.dragStartY = y;
    this.dragX = x;
    this.dragY = y;
  }

  updateDrag(x: number, y: number): void {
    if (!this.dragging) return;
    this.dragX = x;
    this.dragY = y;
  }

  cancelDrag(): void {
    this.dragging = false;
  }

  /**
   * Finish a drag. A drag that covered almost no area is a click, which is how
   * a slightly shaky single click still selects one unit rather than nothing.
   */
  endDrag(
    x: number,
    y: number,
    store: UnitStore,
    view: ViewInfo,
    modifiers: SelectionModifiers,
    nowMs: number,
  ): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.dragX = x;
    this.dragY = y;

    const rect = rectFromDrag(this.dragStartX, this.dragStartY, x, y);
    const options = { ownerId: this.localPlayer, width: view.width, height: view.height };

    if (rectArea(rect) <= CLICK_THRESHOLD_PX * CLICK_THRESHOLD_PX) {
      this.click(x, y, store, view, modifiers, nowMs, options);
      return;
    }

    const found = unitsInRect(store, view.viewProjection, rect, options);
    if (modifiers.shift) this.selection.add(found);
    else this.selection.set(found);
    this.lastClickHandle = NULL_HANDLE;
  }

  private click(
    x: number,
    y: number,
    store: UnitStore,
    view: ViewInfo,
    modifiers: SelectionModifiers,
    nowMs: number,
    options: { ownerId: number; width: number; height: number },
  ): void {
    const handle = unitAtPoint(
      store,
      view.viewProjection,
      x,
      y,
      CLICK_PICK_RADIUS_PX,
      options,
    );

    if (handle === NULL_HANDLE) {
      // Clicking empty ground clears, unless shift is held to keep adding.
      if (!modifiers.shift) this.selection.clear();
      this.lastClickHandle = NULL_HANDLE;
      return;
    }

    const isDoubleClick =
      handle === this.lastClickHandle && nowMs - this.lastClickAt <= DOUBLE_CLICK_MS;
    this.lastClickAt = nowMs;
    this.lastClickHandle = handle;

    // Ctrl-click and double-click both mean "everything like this on screen".
    if (modifiers.ctrl || isDoubleClick) {
      const sameType = sameTypeOnScreen(store, view.viewProjection, handle, options);
      if (modifiers.shift) this.selection.add(sameType);
      else this.selection.set(sameType);
      return;
    }

    if (modifiers.shift) this.selection.toggle(handle);
    else this.selection.set([handle]);
  }

  /**
   * Handle a digit key. Returns true if it was consumed.
   *   digit          recall
   *   ctrl + digit   set from the current selection
   *   shift + digit  add the current selection to the group
   */
  handleDigit(
    digit: number,
    store: UnitStore,
    modifiers: SelectionModifiers,
  ): boolean {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) return false;
    if (modifiers.ctrl) {
      this.groups.set(digit, this.selection.list());
      return true;
    }
    if (modifiers.shift) {
      this.groups.add(digit, this.selection.list());
      return true;
    }
    const recalled = this.groups.recall(digit, store);
    this.selection.set(recalled);
    return true;
  }

  /** Drop selected units that have died. */
  prune(store: UnitStore): void {
    this.selection.prune(store);
  }
}
