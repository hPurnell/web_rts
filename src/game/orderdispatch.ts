/**
 * Deciding what a right-click means.
 *
 * One click, several possible intentions, resolved by priority: an enemy unit
 * is an attack, a resource patch is a gather, a friendly transport is a load,
 * and bare ground is a move. Getting the priority right is most of what makes
 * an RTS feel like it is reading your mind rather than guessing.
 *
 * This is client-side: it turns a click into a command. The command is what
 * the simulation sees, and it is applied at a tick boundary like everything
 * else (invariant 5).
 */
import type { UnitHandle, UnitStore, UnitOrder } from '../sim/units.ts';
import { NULL_HANDLE, OrderKind, resolve } from '../sim/units.ts';
import type { World } from '../sim/world.ts';
import type { SimCommand } from '../sim/commands.ts';
import { CommandKind } from '../sim/commands.ts';
import { unitAtPoint } from './selection.ts';
import type { ViewInfo } from './selectioncontroller.ts';

/** How close a right-click must land to a unit to count as targeting it. */
export const TARGET_PICK_RADIUS_PX = 26;

export interface DispatchInput {
  /** Terrain cell under the cursor, or -1. */
  readonly cell: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly view: ViewInfo;
  /** Shift held: append to the queue rather than replace it. */
  readonly queue: boolean;
}

export interface DispatchResult {
  readonly order: UnitOrder;
  /** A short description, for the status line. */
  readonly label: string;
}

/**
 * Work out the order a click implies, without issuing it.
 *
 * Separated from `dispatchOrder` so the decision can be tested, and so the HUD
 * can show the cursor that matches what the click would do.
 */
export function resolveOrder(
  store: UnitStore,
  world: World,
  localPlayer: number,
  input: DispatchInput,
): DispatchResult | null {
  // 1. An enemy unit under the cursor is an attack.
  const enemy = unitAtPoint(
    store,
    input.view.viewProjection,
    input.screenX,
    input.screenY,
    TARGET_PICK_RADIUS_PX,
    { ownerId: -1, width: input.view.width, height: input.view.height },
  );
  if (enemy !== NULL_HANDLE) {
    const index = resolve(store, enemy);
    if (index >= 0 && store.ownerId[index] !== localPlayer) {
      return {
        order: { kind: OrderKind.Attack, cell: -1, target: enemy },
        label: 'attack',
      };
    }
    // 3. A friendly transport would be a load order. There are no transports
    //    until they exist as a unit type; until then a click on a friendly
    //    unit falls through to a move, which is what a player expects.
  }

  if (input.cell < 0) return null;

  // 2. A resource patch is a gather.
  if (world.resourceNodes.some((node) => node.cell === input.cell)) {
    return {
      order: { kind: OrderKind.Gather, cell: input.cell, target: NULL_HANDLE },
      label: 'gather',
    };
  }

  // 4. Ground is a move.
  return {
    order: { kind: OrderKind.Move, cell: input.cell, target: NULL_HANDLE },
    label: 'move',
  };
}

/** The command a click produces, or null if it means nothing. */
export function dispatchOrder(
  store: UnitStore,
  world: World,
  localPlayer: number,
  selected: readonly UnitHandle[],
  input: DispatchInput,
): SimCommand | null {
  if (selected.length === 0) return null;
  const resolved = resolveOrder(store, world, localPlayer, input);
  if (!resolved) return null;
  return {
    kind: CommandKind.IssueOrders,
    player: localPlayer,
    handles: [...selected],
    order: resolved.order,
    queue: input.queue,
  };
}
