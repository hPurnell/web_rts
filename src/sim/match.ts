/**
 * Match state — everything generated at match start and discarded at match end
 * (invariant 4). The editor never touches this; the simulation never touches
 * world state.
 *
 * Entity storage arrives in M14. For now this holds the parts every milestone
 * needs from the start: the tick counter, the PRNG state and per-player
 * resources, all laid out so `hashableArrays` can walk them in a fixed order.
 */
import type { RandState } from './rand.ts';
import { makeRand } from './rand.ts';
import type { UnitStore } from './units.ts';
import { createUnitStore, unitHashableArrays } from './units.ts';
import type { FieldCache } from './navcache.ts';
import { createFieldCache } from './navcache.ts';
import type { SpatialHash } from './spatialhash.ts';
import { createSpatialHash } from './spatialhash.ts';
import type { CostGrid } from '../nav/grid.ts';
import type { FogGrids } from './fog.ts';
import { createFogGrids, fogHashableArrays } from './fog.ts';

export const MAX_PLAYERS = 8;

export interface MatchInit {
  readonly seed: number;
  readonly playerCount: number;
  /** Map dimensions, for sizing the spatial hash. Defaults to 64x64. */
  readonly worldWidth?: number;
  readonly worldHeight?: number;
  /** The navigation grid the match pathfinds over. */
  readonly costGrid?: CostGrid;
}

export interface Match {
  /** Ticks elapsed since match start. The simulation's only clock. */
  tick: number;
  readonly seed: number;
  readonly playerCount: number;
  readonly rand: RandState;
  /** Per-player mineral and gas totals, indexed by player id. */
  readonly minerals: Int32Array;
  readonly gas: Int32Array;
  readonly units: UnitStore;
  /** Flow fields, computed on demand and warmed by the worker. */
  readonly fields: FieldCache;
  /** Rebuilt each tick for neighbour queries. */
  spatialHash: SpatialHash;
  /** Navigation grid; null until a match is built from a world. */
  costGrid: CostGrid | null;
  readonly fog: FogGrids;
}

export function createMatch(init: MatchInit): Match {
  if (init.playerCount < 1 || init.playerCount > MAX_PLAYERS) {
    throw new Error(`playerCount must be 1..${MAX_PLAYERS}, got ${init.playerCount}`);
  }
  return {
    tick: 0,
    seed: init.seed >>> 0,
    playerCount: init.playerCount,
    rand: makeRand(init.seed),
    minerals: new Int32Array(MAX_PLAYERS),
    gas: new Int32Array(MAX_PLAYERS),
    units: createUnitStore(),
    fields: createFieldCache(),
    spatialHash: createSpatialHash(init.worldWidth ?? 64, init.worldHeight ?? 64),
    costGrid: init.costGrid ?? null,
    fog: createFogGrids(init.worldWidth ?? 64, init.worldHeight ?? 64),
  };
}

/**
 * Every typed array that contributes to the state hash, in a fixed order.
 *
 * Order is part of the hash: append new arrays at the end and regenerate the
 * golden hash deliberately. Each entry is named so a divergence report can say
 * which array differs rather than only that something did.
 */
export function hashableArrays(match: Match): { name: string; data: ArrayBufferView }[] {
  return [
    { name: 'rand', data: match.rand },
    { name: 'minerals', data: match.minerals },
    { name: 'gas', data: match.gas },
    ...unitHashableArrays(match.units),
    ...fogHashableArrays(match.fog, match.playerCount),
  ];
}

/** Scalars folded into the hash alongside the arrays, in a fixed order. */
export function hashableScalars(match: Match): { name: string; value: number }[] {
  return [
    { name: 'tick', value: match.tick },
    { name: 'seed', value: match.seed },
    { name: 'playerCount', value: match.playerCount },
    { name: 'units.count', value: match.units.count },
    { name: 'units.alive', value: match.units.alive },
    { name: 'units.freeHead', value: match.units.freeHead },
  ];
}
