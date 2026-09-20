/**
 * Simulation commands (invariant 5): every mutation of match state is a
 * discrete object applied at a tick boundary. Replays record them, lockstep
 * ships them over the wire, and the determinism harness scripts them.
 *
 * Commands carry only integers, so they serialize without float formatting and
 * compare bit-exactly.
 */
import type { Fixed } from './fixed.ts';
import type { Match } from './match.ts';
import { MAX_PLAYERS } from './match.ts';
import type { UnitOrder } from './units.ts';
import {
  NULL_HANDLE,
  OrderKind,
  clearOrders,
  UnitState,
  despawnUnit,
  queueOrder,
  resolve,
  setOrder,
  spawnUnit,
} from './units.ts';
import { UNIT_TYPES, unitType } from './unittypes.ts';
import type { World } from './world.ts';
import { placeBuilding, startProduction } from './building.ts';

export const enum CommandKind {
  /** Does nothing. Useful as a keep-alive turn in lockstep. */
  Noop = 0,
  /** Adds (or removes, if negative) resources for one player. */
  GrantResources = 1,
  /** Creates a unit. Used by match setup, production and the test harness. */
  SpawnUnit = 2,
  /** Removes a unit outright, without the death handling combat will add. */
  DespawnUnit = 3,
  /** Sends units to a cell. Handles are checked, so stale ones are ignored. */
  MoveUnits = 4,
  /** Stops units where they stand. */
  StopUnits = 5,
  /** Gives units an order, replacing their queue or appending to it. */
  IssueOrders = 6,
  /** Starts a building at a cell. */
  PlaceBuilding = 7,
  /** Queues a unit at a structure. */
  QueueProduction = 8,
  /** Sets where a structure sends what it produces. */
  SetRally = 9,
}

export interface NoopCommand {
  readonly kind: CommandKind.Noop;
}

export interface GrantResourcesCommand {
  readonly kind: CommandKind.GrantResources;
  readonly player: number;
  readonly minerals: number;
  readonly gas: number;
}

export interface SpawnUnitCommand {
  readonly kind: CommandKind.SpawnUnit;
  readonly player: number;
  /** Index into UNIT_TYPES, not a name: commands go over the wire. */
  readonly typeId: number;
  readonly x: Fixed;
  readonly z: Fixed;
  readonly facing?: Fixed;
}

export interface DespawnUnitCommand {
  readonly kind: CommandKind.DespawnUnit;
  readonly handle: number;
}

export interface MoveUnitsCommand {
  readonly kind: CommandKind.MoveUnits;
  readonly player: number;
  readonly handles: readonly number[];
  readonly goalCell: number;
}

export interface StopUnitsCommand {
  readonly kind: CommandKind.StopUnits;
  readonly player: number;
  readonly handles: readonly number[];
}

export interface IssueOrdersCommand {
  readonly kind: CommandKind.IssueOrders;
  readonly player: number;
  readonly handles: readonly number[];
  readonly order: UnitOrder;
  /** True to append to the queue, false to replace it. */
  readonly queue: boolean;
}

export interface PlaceBuildingCommand {
  readonly kind: CommandKind.PlaceBuilding;
  readonly player: number;
  readonly typeId: number;
  readonly cell: number;
}

export interface QueueProductionCommand {
  readonly kind: CommandKind.QueueProduction;
  readonly player: number;
  readonly building: number;
  readonly typeId: number;
}

export interface SetRallyCommand {
  readonly kind: CommandKind.SetRally;
  readonly player: number;
  readonly handles: readonly number[];
  readonly cell: number;
}

export type SimCommand =
  | NoopCommand
  | GrantResourcesCommand
  | SpawnUnitCommand
  | DespawnUnitCommand
  | MoveUnitsCommand
  | StopUnitsCommand
  | IssueOrdersCommand
  | PlaceBuildingCommand
  | QueueProductionCommand
  | SetRallyCommand;

/** A command tagged with the tick it must execute on. */
export interface ScheduledCommand {
  readonly tick: number;
  readonly command: SimCommand;
}

/**
 * Orders arrive over the wire in lockstep, so a malformed one must be rejected
 * identically everywhere rather than trusted.
 */
function validOrder(order: UnitOrder): boolean {
  switch (order.kind) {
    case OrderKind.Move:
    case OrderKind.AttackMove:
    case OrderKind.Gather:
      return Number.isInteger(order.cell) && order.cell >= 0;
    case OrderKind.Attack:
      return Number.isInteger(order.target) && order.target !== NULL_HANDLE;
    case OrderKind.Hold:
      return true;
    case OrderKind.TakeOff:
      return true;
    case OrderKind.Land:
      // A cell is optional: without one the aircraft comes down where it is.
      return !Number.isInteger(order.cell) || order.cell >= -1;
    case OrderKind.None:
      return false;
    default:
      return false;
  }
}

function validPlayer(match: Match, player: number): boolean {
  return Number.isInteger(player) && player >= 0 && player < match.playerCount && player < MAX_PLAYERS;
}

/**
 * Apply one command. Invalid commands are ignored rather than thrown, because
 * in lockstep a peer's malformed command must not halt everyone else's
 * simulation — but every client must ignore it identically.
 *
 * `world` is needed by commands that read terrain, such as placing a building.
 */
export function applyCommand(match: Match, command: SimCommand, world?: World): void {
  switch (command.kind) {
    case CommandKind.Noop:
      return;
    case CommandKind.GrantResources: {
      if (!validPlayer(match, command.player)) return;
      const p = command.player;
      const minerals = (match.minerals[p] as number) + (command.minerals | 0);
      const gas = (match.gas[p] as number) + (command.gas | 0);
      match.minerals[p] = minerals < 0 ? 0 : minerals;
      match.gas[p] = gas < 0 ? 0 : gas;
      return;
    }
    case CommandKind.SpawnUnit: {
      if (!validPlayer(match, command.player)) return;
      if (!Number.isInteger(command.typeId)) return;
      if (command.typeId < 0 || command.typeId >= UNIT_TYPES.length) return;
      spawnUnit(match.units, {
        type: unitType(command.typeId),
        ownerId: command.player,
        x: command.x | 0,
        z: command.z | 0,
        facing: (command.facing ?? 0) | 0,
      });
      return;
    }
    case CommandKind.DespawnUnit: {
      if (command.handle === NULL_HANDLE) return;
      despawnUnit(match.units, command.handle | 0);
      return;
    }
    case CommandKind.MoveUnits: {
      if (!validPlayer(match, command.player)) return;
      if (!Number.isInteger(command.goalCell) || command.goalCell < 0) return;
      for (const handle of command.handles) {
        const index = resolve(match.units, handle);
        if (index < 0) continue;
        // Ownership is checked here rather than trusted: in lockstep the
        // command arrived over the wire, and a client must not be able to
        // order someone else's army by sending a handle it does not own.
        if (match.units.ownerId[index] !== command.player) continue;
        setOrder(match.units, index, {
          kind: OrderKind.Move,
          cell: command.goalCell | 0,
          target: NULL_HANDLE,
        });
        match.units.goalCell[index] = command.goalCell | 0;
        match.units.state[index] = UnitState.Moving;
        match.units.orderStarted[index] = 1;
        // A fresh order deserves a fresh chance to get somewhere.
        match.units.stuckTicks[index] = 0;
        match.units.bestProgress[index] = 0x7fffffff;
      }
      return;
    }
    case CommandKind.StopUnits: {
      if (!validPlayer(match, command.player)) return;
      for (const handle of command.handles) {
        const index = resolve(match.units, handle);
        if (index < 0) continue;
        if (match.units.ownerId[index] !== command.player) continue;
        clearOrders(match.units, index);
        match.units.goalCell[index] = -1;
        match.units.state[index] = UnitState.Idle;
        match.units.stuckTicks[index] = 0;
        match.units.bestProgress[index] = 0x7fffffff;
        match.units.velX[index] = 0;
        match.units.velZ[index] = 0;
      }
      return;
    }
    case CommandKind.IssueOrders: {
      if (!validPlayer(match, command.player)) return;
      if (!validOrder(command.order)) return;
      for (const handle of command.handles) {
        const index = resolve(match.units, handle);
        if (index < 0) continue;
        if (match.units.ownerId[index] !== command.player) continue;
        if (command.queue) queueOrder(match.units, index, command.order);
        else setOrder(match.units, index, command.order);
      }
      return;
    }
    case CommandKind.PlaceBuilding: {
      if (!validPlayer(match, command.player)) return;
      if (!world) return;
      if (!Number.isInteger(command.typeId)) return;
      if (command.typeId < 0 || command.typeId >= UNIT_TYPES.length) return;
      placeBuilding(match, world, command.player, unitType(command.typeId), command.cell | 0);
      return;
    }
    case CommandKind.QueueProduction: {
      if (!validPlayer(match, command.player)) return;
      const index = resolve(match.units, command.building);
      if (index < 0) return;
      startProduction(match, command.player, index, command.typeId | 0);
      return;
    }
    case CommandKind.SetRally: {
      if (!validPlayer(match, command.player)) return;
      for (const handle of command.handles) {
        const index = resolve(match.units, handle);
        if (index < 0) continue;
        if (match.units.ownerId[index] !== command.player) continue;
        if (!unitType(match.units.typeId[index] as number).isStructure) continue;
        match.units.rallyCell[index] = command.cell | 0;
      }
      return;
    }
  }
}
