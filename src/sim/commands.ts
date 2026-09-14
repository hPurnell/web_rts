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
import { NULL_HANDLE, despawnUnit, spawnUnit } from './units.ts';
import { UNIT_TYPES, unitType } from './unittypes.ts';

export const enum CommandKind {
  /** Does nothing. Useful as a keep-alive turn in lockstep. */
  Noop = 0,
  /** Adds (or removes, if negative) resources for one player. */
  GrantResources = 1,
  /** Creates a unit. Used by match setup, production and the test harness. */
  SpawnUnit = 2,
  /** Removes a unit outright, without the death handling combat will add. */
  DespawnUnit = 3,
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

export type SimCommand =
  | NoopCommand
  | GrantResourcesCommand
  | SpawnUnitCommand
  | DespawnUnitCommand;

/** A command tagged with the tick it must execute on. */
export interface ScheduledCommand {
  readonly tick: number;
  readonly command: SimCommand;
}

function validPlayer(match: Match, player: number): boolean {
  return Number.isInteger(player) && player >= 0 && player < match.playerCount && player < MAX_PLAYERS;
}

/**
 * Apply one command. Invalid commands are ignored rather than thrown, because
 * in lockstep a peer's malformed command must not halt everyone else's
 * simulation — but every client must ignore it identically.
 */
export function applyCommand(match: Match, command: SimCommand): void {
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
  }
}
