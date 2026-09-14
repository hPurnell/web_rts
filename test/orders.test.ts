import { describe, expect, it } from 'vitest';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { CommandKind } from '../src/sim/commands.ts';
import type { SimCommand } from '../src/sim/commands.ts';
import {
  MAX_QUEUED_ORDERS,
  NULL_HANDLE,
  OrderKind,
  UnitState,
  headOrder,
  listOrders,
  orderCount,
  resolve,
  spawnUnit,
  despawnUnit,
} from '../src/sim/units.ts';
import type { UnitHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { resolveOrder, dispatchOrder, TARGET_PICK_RADIUS_PX } from '../src/game/orderdispatch.ts';
import * as w from '../src/sim/world.ts';
import { ONE, fromInt } from '../src/sim/fixed.ts';
import { projectPoint } from '../src/game/project.ts';

function setup(world = createTestMap()) {
  const match = createMatchFromWorld({
    world,
    seed: 1,
    playerCount: 2,
    startingWorkers: 0,
    startingDepots: 0,
    costGrid: createCostGrid(world),
  });
  return { world, match, context: { world } };
}

function spawnAt(match: ReturnType<typeof createMatchFromWorld>, owner: number, x: number, z: number, type = 'soldier'): UnitHandle {
  return spawnUnit(match.units, {
    type: unitTypeById(type),
    ownerId: owner,
    x: fromInt(x) + ONE / 2,
    z: fromInt(z) + ONE / 2,
  });
}

const issue = (
  player: number,
  handles: UnitHandle[],
  order: { kind: OrderKind; cell: number; target: UnitHandle },
  queue = false,
): SimCommand => ({ kind: CommandKind.IssueOrders, player, handles, order, queue });

const moveTo = (cell: number) => ({ kind: OrderKind.Move, cell, target: NULL_HANDLE });

function run(match: ReturnType<typeof createMatchFromWorld>, context: { world: w.World }, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepMatch(match, [], context);
}

describe('the order queue', () => {
  it('replaces the queue by default and appends with queue: true', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 0, 30, 30);

    stepMatch(match, [issue(0, [handle], moveTo(w.cellIndex(world, 35, 30)))], context);
    expect(orderCount(match.units, 0)).toBe(1);

    stepMatch(match, [issue(0, [handle], moveTo(w.cellIndex(world, 40, 30)), true)], context);
    expect(orderCount(match.units, 0)).toBe(2);

    stepMatch(match, [issue(0, [handle], moveTo(w.cellIndex(world, 45, 30)))], context);
    expect(orderCount(match.units, 0)).toBe(1);
    expect(headOrder(match.units, 0).cell).toBe(w.cellIndex(world, 45, 30));
  });

  it('executes five queued move orders in sequence', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 0, 28, 28);
    const waypoints = [
      w.cellIndex(world, 34, 28),
      w.cellIndex(world, 34, 34),
      w.cellIndex(world, 28, 34),
      w.cellIndex(world, 28, 30),
      w.cellIndex(world, 32, 31),
    ];

    stepMatch(match, [issue(0, [handle], moveTo(waypoints[0]!))], context);
    for (let i = 1; i < waypoints.length; i++) {
      stepMatch(match, [issue(0, [handle], moveTo(waypoints[i]!), true)], context);
    }
    expect(orderCount(match.units, 0)).toBe(5);
    expect(listOrders(match.units, 0).map((o) => o.cell)).toEqual(waypoints);

    // Watch the queue drain in order, not all at once.
    const seen: number[] = [];
    for (let tick = 0; tick < 3000 && orderCount(match.units, 0) > 0; tick++) {
      const head = headOrder(match.units, 0).cell;
      if (seen.at(-1) !== head) seen.push(head);
      stepMatch(match, [], context);
    }

    expect(seen).toEqual(waypoints);
    expect(orderCount(match.units, 0)).toBe(0);
    expect(match.units.state[0]).toBe(UnitState.Idle);

    // And it finished near the last waypoint.
    const cell = w.cellFromWorld(world, match.units.posX[0] as number, match.units.posZ[0] as number);
    const distance = Math.hypot(
      w.cellX(world, cell) - w.cellX(world, waypoints[4]!),
      w.cellY(world, cell) - w.cellY(world, waypoints[4]!),
    );
    expect(distance).toBeLessThan(3);
  });

  it('drops an order rather than the queue when it is full', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 0, 30, 30);
    for (let i = 0; i < MAX_QUEUED_ORDERS + 4; i++) {
      stepMatch(match, [issue(0, [handle], moveTo(w.cellIndex(world, 32 + i, 30)), i > 0)], context);
    }
    expect(orderCount(match.units, 0)).toBe(MAX_QUEUED_ORDERS);
    // The orders kept are the earliest ones, which are the ones being watched.
    expect(headOrder(match.units, 0).cell).toBe(w.cellIndex(world, 32, 30));
  });

  it('wraps the ring buffer without losing orders', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 0, 30, 30);
    // Fill, drain one, refill: the head walks past the end of the buffer.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < MAX_QUEUED_ORDERS; i++) {
        stepMatch(match, [issue(0, [handle], moveTo(w.cellIndex(world, 31, 31)), i > 0 || round > 0)], context);
      }
      run(match, context, 60);
    }
    expect(orderCount(match.units, 0)).toBeLessThanOrEqual(MAX_QUEUED_ORDERS);
    for (const order of listOrders(match.units, 0)) {
      expect(order.kind).not.toBe(OrderKind.None);
    }
  });

  it('stop clears the whole queue, not just the current order', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 0, 30, 30);
    stepMatch(match, [issue(0, [handle], moveTo(w.cellIndex(world, 40, 30)))], context);
    stepMatch(match, [issue(0, [handle], moveTo(w.cellIndex(world, 45, 30)), true)], context);
    stepMatch(match, [{ kind: CommandKind.StopUnits, player: 0, handles: [handle] }], context);
    expect(orderCount(match.units, 0)).toBe(0);
    expect(match.units.state[0]).toBe(UnitState.Idle);
  });

  it('ignores orders for units another player owns', () => {
    const { match, context, world } = setup();
    const theirs = spawnAt(match, 1, 30, 30);
    stepMatch(match, [issue(0, [theirs], moveTo(w.cellIndex(world, 40, 30)))], context);
    expect(orderCount(match.units, 0)).toBe(0);
  });

  it('rejects malformed orders identically', () => {
    const { match, context } = setup();
    const handle = spawnAt(match, 0, 30, 30);
    for (const order of [
      { kind: OrderKind.None, cell: 5, target: NULL_HANDLE },
      { kind: OrderKind.Move, cell: -1, target: NULL_HANDLE },
      { kind: OrderKind.Attack, cell: -1, target: NULL_HANDLE },
    ]) {
      stepMatch(match, [issue(0, [handle], order)], context);
    }
    expect(orderCount(match.units, 0)).toBe(0);
  });

  it('clears orders when a unit dies', () => {
    const { match, context, world } = setup();
    const handle = spawnAt(match, 0, 30, 30);
    stepMatch(match, [issue(0, [handle], moveTo(w.cellIndex(world, 40, 30)))], context);
    despawnUnit(match.units, handle);
    expect(orderCount(match.units, 0)).toBe(0);
  });
});

describe('attack orders follow their target', () => {
  it('chases a moving target and finishes when it dies', () => {
    const { match, context } = setup();
    const attacker = spawnAt(match, 0, 30, 30);
    const victim = spawnAt(match, 1, 40, 30);

    stepMatch(
      match,
      [issue(0, [attacker], { kind: OrderKind.Attack, cell: -1, target: victim })],
      context,
    );
    run(match, context, 5);
    const firstGoal = match.units.goalCell[0] as number;
    expect(firstGoal).toBeGreaterThanOrEqual(0);

    // Move the target; the attacker's goal must follow it.
    const victimIndex = resolve(match.units, victim);
    match.units.posX[victimIndex] = fromInt(50) + ONE / 2;
    run(match, context, 2);
    expect(match.units.goalCell[0]).not.toBe(firstGoal);

    despawnUnit(match.units, victim);
    run(match, context, 2);
    expect(orderCount(match.units, 0)).toBe(0);
  });

  it('drops an attack order whose target died before it started', () => {
    const { match, context } = setup();
    const attacker = spawnAt(match, 0, 30, 30);
    const victim = spawnAt(match, 1, 40, 30);
    stepMatch(
      match,
      [issue(0, [attacker], { kind: OrderKind.Attack, cell: -1, target: victim })],
      context,
    );
    despawnUnit(match.units, victim);
    run(match, context, 3);
    expect(orderCount(match.units, 0)).toBe(0);
    expect(match.units.state[0]).toBe(UnitState.Idle);
  });
});

describe('right-click dispatch', () => {
  /** Top-down view: world (x, z) maps to screen (x * 10, z * 10). */
  const VIEW = (() => {
    const m = new Float32Array(16);
    m[0] = 1 / 64;
    m[12] = -1;
    m[9] = -1 / 36;
    m[13] = 1;
    m[15] = 1;
    return { viewProjection: m, width: 1280, height: 720 };
  })();
  const screen = (x: number, z: number) => projectPoint(VIEW.viewProjection, x, 0, z, 1280, 720);

  it('prefers an enemy unit over the ground under it', () => {
    const { match, world } = setup();
    spawnAt(match, 0, 10, 10);
    const enemy = spawnAt(match, 1, 20, 20);
    const point = screen(20.5, 20.5);

    const resolved = resolveOrder(match.units, world, 0, {
      cell: w.cellIndex(world, 20, 20),
      screenX: point.x,
      screenY: point.y,
      view: VIEW,
      queue: false,
    });
    expect(resolved?.label).toBe('attack');
    expect(resolved?.order.kind).toBe(OrderKind.Attack);
    expect(resolved?.order.target).toBe(enemy);
  });

  it('treats a friendly unit as ground, not as a target', () => {
    const { match, world } = setup();
    spawnAt(match, 0, 20, 20);
    const point = screen(20.5, 20.5);
    const resolved = resolveOrder(match.units, world, 0, {
      cell: w.cellIndex(world, 20, 20),
      screenX: point.x,
      screenY: point.y,
      view: VIEW,
      queue: false,
    });
    expect(resolved?.label).toBe('move');
  });

  it('prefers a resource patch over bare ground', () => {
    const { match, world } = setup();
    const patch = world.resourceNodes[0]!;
    const resolved = resolveOrder(match.units, world, 0, {
      cell: patch.cell,
      screenX: 5,
      screenY: 700,
      view: VIEW,
      queue: false,
    });
    expect(resolved?.label).toBe('gather');
    expect(resolved?.order.kind).toBe(OrderKind.Gather);
    expect(resolved?.order.cell).toBe(patch.cell);
  });

  it('falls back to a move on bare ground, and to nothing off the map', () => {
    const { match, world } = setup();
    const move = resolveOrder(match.units, world, 0, {
      cell: w.cellIndex(world, 32, 32),
      screenX: 5,
      screenY: 700,
      view: VIEW,
      queue: false,
    });
    expect(move?.label).toBe('move');

    const nothing = resolveOrder(match.units, world, 0, {
      cell: -1,
      screenX: 5,
      screenY: 700,
      view: VIEW,
      queue: false,
    });
    expect(nothing).toBeNull();
  });

  it('produces a command only when something is selected', () => {
    const { match, world } = setup();
    const handle = spawnAt(match, 0, 10, 10);
    const input = {
      cell: w.cellIndex(world, 32, 32),
      screenX: 5,
      screenY: 700,
      view: VIEW,
      queue: true,
    };
    expect(dispatchOrder(match.units, world, 0, [], input)).toBeNull();

    const command = dispatchOrder(match.units, world, 0, [handle], input);
    expect(command?.kind).toBe(CommandKind.IssueOrders);
    expect(command && 'queue' in command && command.queue).toBe(true);
    expect(command && 'handles' in command && command.handles).toEqual([handle]);
  });

  it('only targets units close enough to the click', () => {
    const { match, world } = setup();
    spawnAt(match, 1, 20, 20);
    const far = screen(20.5, 20.5);
    const resolved = resolveOrder(match.units, world, 0, {
      cell: w.cellIndex(world, 40, 40),
      screenX: far.x + TARGET_PICK_RADIUS_PX * 3,
      screenY: far.y,
      view: VIEW,
      queue: false,
    });
    expect(resolved?.label).toBe('move');
  });
});
