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
import type { ProjectileStore } from './projectiles.ts';
import { createProjectileStore, projectileHashableArrays } from './projectiles.ts';
import type { NodeState } from './economy.ts';
import { nodeHashableArrays } from './economy.ts';
import type { AiState } from './ai.ts';
import { aiHashableArrays, createAiState } from './ai.ts';
import { createHeightOverrides, overrideHashableArrays } from './terrain.ts';
import type { HeightOverrides } from './terrain.ts';

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
  readonly projectiles: ProjectileStore;
  /** Per-match resource node state; the map's own amounts are never touched. */
  nodes: NodeState;
  /** Which players the skirmish bot controls, and what it is doing. */
  readonly ai: AiState;
  /**
   * Terrain heights this match has changed, as corner/height pairs.
   *
   * Invariant 5: a match never writes to the world's heightfield, because the
   * world is shared and `hashWorld` must not move while a match runs. When a
   * structure levels the ground under its footprint the new heights land here,
   * and every read of the terrain during a match passes this alongside the
   * world. It is a pair list rather than a second heightfield so that hashing
   * it costs the size of the edits rather than the size of the map.
   */
  readonly terrain: HeightOverrides;
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
    projectiles: createProjectileStore(),
    ai: createAiState(),
    terrain: createHeightOverrides(),
    nodes: {
      amount: new Int32Array(0),
      harvesters: new Int32Array(0),
      cell: new Int32Array(0),
      type: new Uint8Array(0),
    },
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
    ...projectileHashableArrays(match.projectiles),
    ...nodeHashableArrays(match.nodes),
    ...aiHashableArrays(match.ai),
    ...overrideHashableArrays(match.terrain),
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
    { name: 'shots.count', value: match.projectiles.count },
    { name: 'shots.alive', value: match.projectiles.alive },
    { name: 'shots.freeHead', value: match.projectiles.freeHead },
  ];
}
