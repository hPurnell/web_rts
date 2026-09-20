/**
 * The order system: turning queued orders into the state movement and combat
 * act on.
 *
 * It runs before movement each tick. Its whole job is to notice when the head
 * order has finished and move on to the next, which is what makes a shift-
 * queued sequence execute in order rather than all at once.
 */
import type { Match } from './match.ts';
import type { UnitStore } from './units.ts';
import {
  AirState,
  OrderKind,
  UnitState,
  headOrder,
  popOrder,
  resolve,
} from './units.ts';
import type { World } from './world.ts';
import { cellFromWorld } from './world.ts';

export interface OrderContext {
  readonly world: World;
}

/** Advance every unit's order queue by one tick. */
export function stepOrders(match: Match, context: OrderContext): void {
  const store = match.units;

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;

    const order = headOrder(store, i);
    if (order.kind === OrderKind.None) {
      // Nothing queued: an idle unit simply stands.
      continue;
    }

    if (store.orderStarted[i] === 1) {
      if (isFinished(store, i, order, context)) {
        popOrder(store, i);
        // Start the next one on this same tick, so a queue of short orders
        // does not lose a tick at every handover.
        begin(store, i, headOrder(store, i), context);
      }
      continue;
    }

    begin(store, i, order, context);
  }
}

function begin(store: UnitStore, index: number, order: ReturnType<typeof headOrder>, context: OrderContext): void {
  if (order.kind === OrderKind.None) {
    // The queue is empty. Stop where we are rather than walking on toward the
    // goal of the order that just finished.
    store.goalCell[index] = -1;
    store.state[index] = UnitState.Idle;
    store.velX[index] = 0;
    store.velZ[index] = 0;
    store.orderStarted[index] = 0;
    return;
  }
  store.orderStarted[index] = 1;
  store.bestProgress[index] = 0x7fffffff;
  store.stuckTicks[index] = 0;

  switch (order.kind) {
    case OrderKind.Move:
    case OrderKind.AttackMove: {
      store.goalCell[index] = order.cell;
      store.state[index] = order.cell >= 0 ? UnitState.Moving : UnitState.Idle;
      return;
    }
    case OrderKind.Gather: {
      // The economy owns where a gatherer walks: it alternates between the
      // patch and the drop-off, and setting a goal here would fight it.
      store.state[index] = UnitState.Gathering;
      store.goalCell[index] = -1;
      return;
    }
    case OrderKind.Attack: {
      const target = resolve(store, order.target);
      if (target < 0) {
        // The target died between the order being given and it being started.
        store.goalCell[index] = -1;
        store.state[index] = UnitState.Idle;
        return;
      }
      store.goalCell[index] = targetCell(store, target, context);
      store.state[index] = UnitState.Moving;
      return;
    }
    case OrderKind.Hold: {
      store.goalCell[index] = -1;
      store.state[index] = UnitState.Idle;
      return;
    }
    case OrderKind.TakeOff:
    case OrderKind.Land: {
      // The flight system owns these: it reads the head order each tick and
      // drives the state machine. Setting a goal here would have movement
      // fight it for the same unit.
      store.goalCell[index] = -1;
      store.state[index] = UnitState.Idle;
      return;
    }
  }
}

function isFinished(
  store: UnitStore,
  index: number,
  order: ReturnType<typeof headOrder>,
  context: OrderContext,
): boolean {
  switch (order.kind) {
    case OrderKind.Move:
    case OrderKind.AttackMove:
      // Movement clears the goal when it arrives or gives up.
      return store.state[index] === UnitState.Idle;
    case OrderKind.Gather:
      // The gather loop has no end: the economy pops the order itself when
      // there is nothing left to mine.
      return false;
    case OrderKind.Attack: {
      const target = resolve(store, order.target);
      if (target < 0) return true; // the target is dead: the order is done
      // Keep chasing: refresh the goal as the target moves.
      const cell = targetCell(store, target, context);
      if (cell !== (store.goalCell[index] as number)) {
        store.goalCell[index] = cell;
        store.state[index] = UnitState.Moving;
        store.bestProgress[index] = 0x7fffffff;
        store.stuckTicks[index] = 0;
      }
      return store.state[index] === UnitState.Idle;
    }
    case OrderKind.Hold:
      return false; // holding lasts until it is replaced
    case OrderKind.TakeOff:
      // Done once it is up and holding altitude.
      return store.airState[index] === AirState.Airborne;
    case OrderKind.Land:
      return store.airState[index] === AirState.Grounded;
    case OrderKind.None:
      return true;
  }
}

function targetCell(store: UnitStore, targetIndex: number, context: OrderContext): number {
  return cellFromWorld(
    context.world,
    store.posX[targetIndex] as number,
    store.posZ[targetIndex] as number,
  );
}
