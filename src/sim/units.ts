/**
 * Unit storage: structure of arrays over typed arrays.
 *
 * One array per field rather than one object per unit. Movement touches posX,
 * posZ, velX and velZ and nothing else, so a tick streams four contiguous
 * blocks instead of chasing 2,000 scattered objects — and the whole store
 * hashes by walking a fixed list of buffers, which is what the determinism
 * harness needs.
 *
 * Slots are recycled through a free list, and every handle carries the
 * generation of the slot it was issued against, so a reference to a unit that
 * died resolves to nothing rather than silently to whoever took its place.
 */
import type { Fixed } from './fixed.ts';
import type { UnitType } from './unittypes.ts';

/** Slots in the store. Fixed, so the arrays never reallocate mid-match. */
export const MAX_UNITS = 1 << 14; // 16384

/** Handle layout: index in the low 20 bits, generation above it. */
const INDEX_BITS = 20;
const INDEX_MASK = (1 << INDEX_BITS) - 1;
const GENERATION_MASK = 0x7ff; // 11 bits, keeping handles positive
const MAX_GENERATION = GENERATION_MASK;

/** No unit. Generations start at 1, so zero can never be a live handle. */
export const NULL_HANDLE = 0;

export type UnitHandle = number;

/** What a unit is currently doing. Ordered so 0 is the resting state. */
export const enum UnitState {
  Idle = 0,
  Moving = 1,
  Attacking = 2,
  Gathering = 3,
  Returning = 4,
  Building = 5,
  Dead = 6,
}

export interface UnitStore {
  /** Slots in use, live or not; the high-water mark of allocation. */
  count: number;
  /** Live units. */
  alive: number;

  readonly posX: Int32Array;
  readonly posZ: Int32Array;
  readonly velX: Int32Array;
  readonly velZ: Int32Array;
  readonly hp: Int32Array;
  readonly maxHp: Int32Array;
  readonly typeId: Uint8Array;
  readonly ownerId: Uint8Array;
  readonly state: Uint8Array;
  readonly targetHandle: Int32Array;
  readonly cooldown: Int32Array;
  readonly facing: Int32Array;
  /** Flow-field goal this unit is walking to, or -1. */
  readonly goalCell: Int32Array;
  /** Consecutive ticks spent making no real progress toward that goal. */
  readonly stuckTicks: Int32Array;
  /** Best flow-field distance to the goal this unit has reached so far. */
  readonly bestProgress: Int32Array;

  /** Generation of each slot; odd bookkeeping kept out of the hashed set. */
  readonly generation: Uint16Array;
  readonly isAlive: Uint8Array;
  /** Free-list links; -1 terminates. */
  readonly nextFree: Int32Array;
  freeHead: number;
}

export function createUnitStore(): UnitStore {
  const store: UnitStore = {
    count: 0,
    alive: 0,
    posX: new Int32Array(MAX_UNITS),
    posZ: new Int32Array(MAX_UNITS),
    velX: new Int32Array(MAX_UNITS),
    velZ: new Int32Array(MAX_UNITS),
    hp: new Int32Array(MAX_UNITS),
    maxHp: new Int32Array(MAX_UNITS),
    typeId: new Uint8Array(MAX_UNITS),
    ownerId: new Uint8Array(MAX_UNITS),
    state: new Uint8Array(MAX_UNITS),
    targetHandle: new Int32Array(MAX_UNITS),
    cooldown: new Int32Array(MAX_UNITS),
    facing: new Int32Array(MAX_UNITS),
    goalCell: new Int32Array(MAX_UNITS).fill(-1),
    stuckTicks: new Int32Array(MAX_UNITS),
    bestProgress: new Int32Array(MAX_UNITS).fill(0x7fffffff),
    generation: new Uint16Array(MAX_UNITS),
    isAlive: new Uint8Array(MAX_UNITS),
    nextFree: new Int32Array(MAX_UNITS),
    freeHead: -1,
  };
  store.generation.fill(1);
  store.nextFree.fill(-1);
  store.goalCell.fill(-1);
  return store;
}

export function makeHandle(index: number, generation: number): UnitHandle {
  return ((index & INDEX_MASK) | ((generation & GENERATION_MASK) << INDEX_BITS)) >>> 0;
}

export function handleIndex(handle: UnitHandle): number {
  return handle & INDEX_MASK;
}

export function handleGeneration(handle: UnitHandle): number {
  return (handle >>> INDEX_BITS) & GENERATION_MASK;
}

/** Slot index for a live unit, or -1 if the handle is stale or null. */
export function resolve(store: UnitStore, handle: UnitHandle): number {
  if (handle === NULL_HANDLE) return -1;
  const index = handleIndex(handle);
  if (index >= store.count) return -1;
  if (store.isAlive[index] !== 1) return -1;
  if (store.generation[index] !== handleGeneration(handle)) return -1;
  return index;
}

export function isAlive(store: UnitStore, handle: UnitHandle): boolean {
  return resolve(store, handle) >= 0;
}

export interface SpawnRequest {
  readonly type: UnitType;
  readonly ownerId: number;
  readonly x: Fixed;
  readonly z: Fixed;
  readonly facing?: Fixed;
}

/**
 * Allocate a unit. Returns NULL_HANDLE when the store is full — the caller
 * decides what that means, but the simulation never throws mid-tick.
 */
export function spawnUnit(store: UnitStore, request: SpawnRequest): UnitHandle {
  let index: number;
  if (store.freeHead >= 0) {
    // Reusing a slot is what keeps `count` from growing under churn.
    index = store.freeHead;
    store.freeHead = store.nextFree[index] as number;
    store.nextFree[index] = -1;
  } else {
    if (store.count >= MAX_UNITS) return NULL_HANDLE;
    index = store.count++;
  }

  store.posX[index] = request.x;
  store.posZ[index] = request.z;
  store.velX[index] = 0;
  store.velZ[index] = 0;
  store.hp[index] = request.type.maxHp;
  store.maxHp[index] = request.type.maxHp;
  store.typeId[index] = request.type.typeId;
  store.ownerId[index] = request.ownerId;
  store.state[index] = UnitState.Idle;
  store.targetHandle[index] = NULL_HANDLE;
  store.cooldown[index] = 0;
  store.facing[index] = request.facing ?? 0;
  store.goalCell[index] = -1;
  store.stuckTicks[index] = 0;
  store.bestProgress[index] = 0x7fffffff;
  store.isAlive[index] = 1;
  store.alive++;

  return makeHandle(index, store.generation[index] as number);
}

/**
 * Free a unit's slot. Bumping the generation is what makes every outstanding
 * handle to it stale; wrapping past the 11-bit field skips zero, since zero is
 * the null handle.
 */
export function despawnUnit(store: UnitStore, handle: UnitHandle): boolean {
  const index = resolve(store, handle);
  if (index < 0) return false;

  store.isAlive[index] = 0;
  store.state[index] = UnitState.Dead;
  store.hp[index] = 0;
  store.goalCell[index] = -1;
  store.alive--;

  const next = ((store.generation[index] as number) + 1) & MAX_GENERATION;
  store.generation[index] = next === 0 ? 1 : next;

  store.nextFree[index] = store.freeHead;
  store.freeHead = index;
  return true;
}

/** Clear the store without reallocating. */
export function resetUnitStore(store: UnitStore): void {
  store.count = 0;
  store.alive = 0;
  store.freeHead = -1;
  store.posX.fill(0);
  store.posZ.fill(0);
  store.velX.fill(0);
  store.velZ.fill(0);
  store.hp.fill(0);
  store.maxHp.fill(0);
  store.typeId.fill(0);
  store.ownerId.fill(0);
  store.state.fill(0);
  store.targetHandle.fill(0);
  store.cooldown.fill(0);
  store.facing.fill(0);
  store.goalCell.fill(-1);
  store.stuckTicks.fill(0);
  store.bestProgress.fill(0x7fffffff);
  store.generation.fill(1);
  store.isAlive.fill(0);
  store.nextFree.fill(-1);
}

/**
 * Arrays that contribute to the determinism hash, in a fixed order.
 *
 * Only the first `count` slots are hashed: slots beyond the high-water mark
 * have never been written, and including them would make the hash depend on
 * MAX_UNITS rather than on the match.
 */
export function unitHashableArrays(store: UnitStore): { name: string; data: ArrayBufferView }[] {
  const n = store.count;
  return [
    { name: 'unit.posX', data: store.posX.subarray(0, n) },
    { name: 'unit.posZ', data: store.posZ.subarray(0, n) },
    { name: 'unit.velX', data: store.velX.subarray(0, n) },
    { name: 'unit.velZ', data: store.velZ.subarray(0, n) },
    { name: 'unit.hp', data: store.hp.subarray(0, n) },
    { name: 'unit.maxHp', data: store.maxHp.subarray(0, n) },
    { name: 'unit.typeId', data: store.typeId.subarray(0, n) },
    { name: 'unit.ownerId', data: store.ownerId.subarray(0, n) },
    { name: 'unit.state', data: store.state.subarray(0, n) },
    { name: 'unit.targetHandle', data: store.targetHandle.subarray(0, n) },
    { name: 'unit.cooldown', data: store.cooldown.subarray(0, n) },
    { name: 'unit.facing', data: store.facing.subarray(0, n) },
    { name: 'unit.goalCell', data: store.goalCell.subarray(0, n) },
    { name: 'unit.stuckTicks', data: store.stuckTicks.subarray(0, n) },
    { name: 'unit.bestProgress', data: store.bestProgress.subarray(0, n) },
    { name: 'unit.generation', data: store.generation.subarray(0, n) },
    { name: 'unit.isAlive', data: store.isAlive.subarray(0, n) },
    { name: 'unit.nextFree', data: store.nextFree.subarray(0, n) },
  ];
}

/** Call `visit` for every live unit, in slot order. */
export function forEachUnit(store: UnitStore, visit: (index: number) => void): void {
  for (let index = 0; index < store.count; index++) {
    if (store.isAlive[index] === 1) visit(index);
  }
}
