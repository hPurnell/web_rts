/**
 * Helicopters: taking off, flying, and coming back down.
 *
 * The golden hash pins that flight is *deterministic*; these pin that it is
 * *right*. They are separate concerns — a helicopter that never left the
 * ground would hash identically on every client.
 */
import { describe, expect, it } from 'vitest';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { stepMatch } from '../src/sim/tick.ts';
import { AirState, OrderKind, UnitState, spawnUnit } from '../src/sim/units.ts';
import type { Match } from '../src/sim/match.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { CommandKind } from '../src/sim/commands.ts';
import type { SimCommand } from '../src/sim/commands.ts';
import { NULL_HANDLE, makeHandle } from '../src/sim/units.ts';
import { cellIndex } from '../src/sim/world.ts';
import { fromInt, toFloat } from '../src/sim/fixed.ts';

const world = createTestMap();
const GUNSHIP = unitTypeById('gunship');

function setup(): { match: Match; handle: number } {
  const match = createMatchFromWorld({
    world,
    seed: 1,
    playerCount: 2,
    startingWorkers: 0,
    startingDepots: 0,
  });
  spawnUnit(match.units, {
    type: GUNSHIP,
    ownerId: 0,
    x: fromInt(20),
    z: fromInt(20),
  });
  return { match, handle: makeHandle(0, 1) };
}

function run(match: Match, ticks: number, commands: Map<number, SimCommand[]> = new Map()): void {
  for (let t = 0; t < ticks; t++) stepMatch(match, commands.get(t) ?? [], { world });
}

function order(handle: number, kind: OrderKind, cell = -1): SimCommand {
  return {
    kind: CommandKind.IssueOrders,
    player: 0,
    handles: [handle],
    order: { kind, cell, target: NULL_HANDLE },
    queue: false,
  };
}

describe('helicopters', () => {
  it('sit on the ground until they are given somewhere to be', () => {
    const { match } = setup();
    run(match, 40);
    expect(match.units.airState[0]).toBe(AirState.Grounded);
    expect(match.units.altitude[0]).toBe(0);
  });

  it('climbs to cruise altitude and holds it', () => {
    const { match, handle } = setup();
    run(match, 120, new Map([[0, [order(handle, OrderKind.TakeOff)]]]));
    expect(match.units.airState[0]).toBe(AirState.Airborne);
    expect(match.units.altitude[0]).toBe(GUNSHIP.cruiseAltitude);
  });

  it('goes straight up before it goes anywhere', () => {
    const { match, handle } = setup();
    const startX = match.units.posX[0] as number;
    const startZ = match.units.posZ[0] as number;
    const commands = new Map([
      [0, [{ kind: CommandKind.MoveUnits, player: 0, handles: [handle], goalCell: cellIndex(world, 40, 40) } as SimCommand]],
    ]);
    // Part-way through the climb it must not have translated at all: a
    // helicopter dragged sideways off its skids looks broken.
    run(match, 6, commands);
    expect(match.units.airState[0]).toBe(AirState.TakingOff);
    expect(match.units.altitude[0]).toBeGreaterThan(0);
    expect(match.units.posX[0]).toBe(startX);
    expect(match.units.posZ[0]).toBe(startZ);
  });

  it('takes off by itself when told to move', () => {
    const { match, handle } = setup();
    run(
      match,
      200,
      new Map([
        [0, [{ kind: CommandKind.MoveUnits, player: 0, handles: [handle], goalCell: cellIndex(world, 30, 30) } as SimCommand]],
      ]),
    );
    // An order on an aircraft must not be two orders.
    expect(match.units.airState[0]).toBe(AirState.Airborne);
    expect(toFloat(match.units.posX[0] as number)).toBeGreaterThan(25);
  });

  it('accelerates and slows instead of snapping to full speed', () => {
    const { match, handle } = setup();
    run(match, 120, new Map([[0, [order(handle, OrderKind.TakeOff)]]]));

    const speeds: number[] = [];
    const commands = new Map([
      [0, [{ kind: CommandKind.MoveUnits, player: 0, handles: [handle], goalCell: cellIndex(world, 60, 20) } as SimCommand]],
    ]);
    for (let t = 0; t < 12; t++) {
      stepMatch(match, commands.get(t) ?? [], { world });
      speeds.push(Math.hypot(match.units.velX[0] as number, match.units.velZ[0] as number));
    }

    // Strictly increasing for the first few ticks, and never above top speed.
    expect(speeds[0]).toBeLessThan(speeds[1] as number);
    expect(speeds[1]).toBeLessThan(speeds[2] as number);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(GUNSHIP.speed + 1);
    // And it has not reached top speed within one tick, which is the point.
    expect(speeds[0]).toBeLessThan(GUNSHIP.speed / 2);
  });

  it('crosses ground no walking unit could', () => {
    // The ridge on the fixture map is too steep to climb. A gunship flies over
    // it, which is the whole reason aircraft skip the navigation grid.
    const { match, handle } = setup();
    run(
      match,
      400,
      new Map([
        [0, [{ kind: CommandKind.MoveUnits, player: 0, handles: [handle], goalCell: cellIndex(world, 70, 64) } as SimCommand]],
      ]),
    );
    expect(toFloat(match.units.posX[0] as number)).toBeGreaterThan(60);
    expect(toFloat(match.units.posZ[0] as number)).toBeGreaterThan(55);
  });

  it('stops before it descends, and settles on the ground', () => {
    const { match, handle } = setup();
    run(match, 120, new Map([[0, [order(handle, OrderKind.TakeOff)]]]));
    run(
      match,
      40,
      new Map([
        [0, [{ kind: CommandKind.MoveUnits, player: 0, handles: [handle], goalCell: cellIndex(world, 60, 20) } as SimCommand]],
      ]),
    );

    // Landing while travelling: it must bleed the speed off first, or it comes
    // down somewhere other than where it was told to.
    let descendedWhileMoving = false;
    const before = match.units.altitude[0] as number;
    let previous = before;
    stepMatch(match, [order(handle, OrderKind.Land)], { world });
    for (let t = 0; t < 200; t++) {
      stepMatch(match, [], { world });
      const altitude = match.units.altitude[0] as number;
      const speed = Math.hypot(match.units.velX[0] as number, match.units.velZ[0] as number);
      if (altitude < previous && speed > GUNSHIP.speed / 4) descendedWhileMoving = true;
      previous = altitude;
    }

    expect(descendedWhileMoving).toBe(false);
    expect(match.units.airState[0]).toBe(AirState.Grounded);
    expect(match.units.altitude[0]).toBe(0);
    expect(match.units.state[0]).toBe(UnitState.Idle);
  });

  it('ignores a landing order it is already obeying', () => {
    const { match, handle } = setup();
    run(match, 20, new Map([[0, [order(handle, OrderKind.Land)]]]));
    expect(match.units.airState[0]).toBe(AirState.Grounded);
    expect(match.units.altitude[0]).toBe(0);
  });

  it('does not shove the units it flies over', () => {
    const { match, handle } = setup();
    const soldier = unitTypeById('soldier');
    spawnUnit(match.units, { type: soldier, ownerId: 0, x: fromInt(30), z: fromInt(20) });
    const beforeX = match.units.posX[1] as number;
    const beforeZ = match.units.posZ[1] as number;

    run(
      match,
      300,
      new Map([
        [0, [{ kind: CommandKind.MoveUnits, player: 0, handles: [handle], goalCell: cellIndex(world, 40, 20) } as SimCommand]],
      ]),
    );

    expect(match.units.posX[1]).toBe(beforeX);
    expect(match.units.posZ[1]).toBe(beforeZ);
  });
});
