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

/** Orders a unit can have queued behind the one it is executing. */
export const MAX_QUEUED_ORDERS = 8;

/** Units a structure can have queued for production. */
export const MAX_PRODUCTION_QUEUE = 5;

/** What a queued order tells a unit to do. */
export const enum OrderKind {
  None = 0,
  Move = 1,
  AttackMove = 2,
  Attack = 3,
  Gather = 4,
  Hold = 5,
}

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

  // --- order queue -------------------------------------------------------
  // A ring buffer per unit, flattened: unit `i` owns entries
  // [i * MAX_QUEUED_ORDERS, (i + 1) * MAX_QUEUED_ORDERS). Flat typed arrays
  // rather than an array of queues, so the whole thing hashes by walking
  // buffers like everything else in the store.
  readonly orderKind: Uint8Array;
  readonly orderCell: Int32Array;
  readonly orderTarget: Int32Array;
  readonly orderHead: Uint8Array;
  readonly orderCount: Uint8Array;
  /** 1 once the head order has been handed to a system to execute. */
  readonly orderStarted: Uint8Array;

  // --- gathering ---------------------------------------------------------
  /** Resource units currently carried. */
  readonly carryAmount: Int32Array;
  /** Which resource is carried, when carryAmount is non-zero. */
  readonly carryType: Uint8Array;
  /** Index into the match's node list, or -1. */
  readonly gatherNode: Int32Array;
  /** Ticks left in the current harvest, or 0. */
  readonly harvestTicks: Int32Array;

  // --- structures --------------------------------------------------------
  /** Ticks left before construction completes; 0 means finished. */
  readonly buildTicks: Int32Array;
  /** Where units produced here are sent, or -1. */
  readonly rallyCell: Int32Array;
  /** Production queue, flattened like the order queue. */
  readonly produceType: Uint8Array;
  readonly produceHead: Uint8Array;
  readonly produceCount: Uint8Array;
  /** Ticks left on the item at the head of the production queue. */
  readonly produceTicks: Int32Array;

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
    orderKind: new Uint8Array(MAX_UNITS * MAX_QUEUED_ORDERS),
    orderCell: new Int32Array(MAX_UNITS * MAX_QUEUED_ORDERS).fill(-1),
    orderTarget: new Int32Array(MAX_UNITS * MAX_QUEUED_ORDERS),
    orderHead: new Uint8Array(MAX_UNITS),
    orderCount: new Uint8Array(MAX_UNITS),
    orderStarted: new Uint8Array(MAX_UNITS),
    carryAmount: new Int32Array(MAX_UNITS),
    carryType: new Uint8Array(MAX_UNITS),
    gatherNode: new Int32Array(MAX_UNITS).fill(-1),
    harvestTicks: new Int32Array(MAX_UNITS),
    buildTicks: new Int32Array(MAX_UNITS),
    rallyCell: new Int32Array(MAX_UNITS).fill(-1),
    produceType: new Uint8Array(MAX_UNITS * MAX_PRODUCTION_QUEUE),
    produceHead: new Uint8Array(MAX_UNITS),
    produceCount: new Uint8Array(MAX_UNITS),
    produceTicks: new Int32Array(MAX_UNITS),
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
  store.carryAmount[index] = 0;
  store.carryType[index] = 0;
  store.gatherNode[index] = -1;
  store.harvestTicks[index] = 0;
  store.buildTicks[index] = 0;
  store.rallyCell[index] = -1;
  store.produceHead[index] = 0;
  store.produceCount[index] = 0;
  store.produceTicks[index] = 0;
  clearOrders(store, index);
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
  store.gatherNode[index] = -1;
  store.harvestTicks[index] = 0;
  clearOrders(store, index);
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
  store.orderKind.fill(0);
  store.orderCell.fill(-1);
  store.orderTarget.fill(0);
  store.orderHead.fill(0);
  store.orderCount.fill(0);
  store.orderStarted.fill(0);
  store.carryAmount.fill(0);
  store.carryType.fill(0);
  store.gatherNode.fill(-1);
  store.harvestTicks.fill(0);
  store.buildTicks.fill(0);
  store.rallyCell.fill(-1);
  store.produceType.fill(0);
  store.produceHead.fill(0);
  store.produceCount.fill(0);
  store.produceTicks.fill(0);
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
    { name: 'unit.orderHead', data: store.orderHead.subarray(0, n) },
    { name: 'unit.orderCount', data: store.orderCount.subarray(0, n) },
    { name: 'unit.orderStarted', data: store.orderStarted.subarray(0, n) },
    { name: 'unit.carryAmount', data: store.carryAmount.subarray(0, n) },
    { name: 'unit.carryType', data: store.carryType.subarray(0, n) },
    { name: 'unit.gatherNode', data: store.gatherNode.subarray(0, n) },
    { name: 'unit.harvestTicks', data: store.harvestTicks.subarray(0, n) },
    { name: 'unit.buildTicks', data: store.buildTicks.subarray(0, n) },
    { name: 'unit.rallyCell', data: store.rallyCell.subarray(0, n) },
    { name: 'unit.produceHead', data: store.produceHead.subarray(0, n) },
    { name: 'unit.produceCount', data: store.produceCount.subarray(0, n) },
    { name: 'unit.produceTicks', data: store.produceTicks.subarray(0, n) },
    { name: 'unit.produceType', data: store.produceType.subarray(0, n * MAX_PRODUCTION_QUEUE) },
    { name: 'unit.orderKind', data: store.orderKind.subarray(0, n * MAX_QUEUED_ORDERS) },
    { name: 'unit.orderCell', data: store.orderCell.subarray(0, n * MAX_QUEUED_ORDERS) },
    { name: 'unit.orderTarget', data: store.orderTarget.subarray(0, n * MAX_QUEUED_ORDERS) },
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

// --- order queue ------------------------------------------------------------

export interface UnitOrder {
  readonly kind: OrderKind;
  /** Destination cell, or -1 when the order is about a target instead. */
  readonly cell: number;
  /** Target unit handle, or NULL_HANDLE. */
  readonly target: UnitHandle;
}

export const NO_ORDER: UnitOrder = {
  kind: OrderKind.None,
  cell: -1,
  target: NULL_HANDLE,
};

function slot(index: number, position: number): number {
  return index * MAX_QUEUED_ORDERS + (position % MAX_QUEUED_ORDERS);
}

export function orderCount(store: UnitStore, index: number): number {
  return store.orderCount[index] as number;
}

/** The order a unit is executing, or NO_ORDER. */
export function headOrder(store: UnitStore, index: number): UnitOrder {
  if ((store.orderCount[index] as number) === 0) return NO_ORDER;
  const at = slot(index, store.orderHead[index] as number);
  return {
    kind: store.orderKind[at] as OrderKind,
    cell: store.orderCell[at] as number,
    target: store.orderTarget[at] as UnitHandle,
  };
}

/**
 * Append an order. Returns false when the queue is full.
 *
 * A full queue drops the new order rather than the oldest: in an RTS the
 * orders already given are the ones the player is watching happen.
 */
export function queueOrder(store: UnitStore, index: number, order: UnitOrder): boolean {
  const count = store.orderCount[index] as number;
  if (count >= MAX_QUEUED_ORDERS) return false;
  const at = slot(index, (store.orderHead[index] as number) + count);
  store.orderKind[at] = order.kind;
  store.orderCell[at] = order.cell;
  store.orderTarget[at] = order.target;
  store.orderCount[index] = count + 1;
  return true;
}

/** Replace the queue with a single order. */
export function setOrder(store: UnitStore, index: number, order: UnitOrder): void {
  clearOrders(store, index);
  queueOrder(store, index, order);
}

export function clearOrders(store: UnitStore, index: number): void {
  const base = index * MAX_QUEUED_ORDERS;
  for (let i = 0; i < MAX_QUEUED_ORDERS; i++) {
    store.orderKind[base + i] = OrderKind.None;
    store.orderCell[base + i] = -1;
    store.orderTarget[base + i] = NULL_HANDLE;
  }
  store.orderHead[index] = 0;
  store.orderCount[index] = 0;
  store.orderStarted[index] = 0;
}

/** Drop the head order and advance to the next. */
export function popOrder(store: UnitStore, index: number): void {
  const count = store.orderCount[index] as number;
  if (count === 0) return;
  const at = slot(index, store.orderHead[index] as number);
  store.orderKind[at] = OrderKind.None;
  store.orderCell[at] = -1;
  store.orderTarget[at] = NULL_HANDLE;
  store.orderHead[index] = ((store.orderHead[index] as number) + 1) % MAX_QUEUED_ORDERS;
  store.orderCount[index] = count - 1;
  store.orderStarted[index] = 0;
}

/** Every queued order for a unit, head first. For the HUD and for tests. */
export function listOrders(store: UnitStore, index: number): UnitOrder[] {
  const out: UnitOrder[] = [];
  const count = store.orderCount[index] as number;
  for (let i = 0; i < count; i++) {
    const at = slot(index, (store.orderHead[index] as number) + i);
    out.push({
      kind: store.orderKind[at] as OrderKind,
      cell: store.orderCell[at] as number,
      target: store.orderTarget[at] as UnitHandle,
    });
  }
  return out;
}

// --- production queue -------------------------------------------------------

function produceSlot(index: number, position: number): number {
  return index * MAX_PRODUCTION_QUEUE + (position % MAX_PRODUCTION_QUEUE);
}

export function productionCount(store: UnitStore, index: number): number {
  return store.produceCount[index] as number;
}

/** The type id currently being produced, or -1. */
export function productionHead(store: UnitStore, index: number): number {
  if ((store.produceCount[index] as number) === 0) return -1;
  return store.produceType[produceSlot(index, store.produceHead[index] as number)] as number;
}

/** Queue an item. Returns false when the queue is full. */
export function queueProduction(store: UnitStore, index: number, typeId: number): boolean {
  const count = store.produceCount[index] as number;
  if (count >= MAX_PRODUCTION_QUEUE) return false;
  store.produceType[produceSlot(index, (store.produceHead[index] as number) + count)] = typeId;
  store.produceCount[index] = count + 1;
  return true;
}

export function popProduction(store: UnitStore, index: number): void {
  const count = store.produceCount[index] as number;
  if (count === 0) return;
  store.produceHead[index] = ((store.produceHead[index] as number) + 1) % MAX_PRODUCTION_QUEUE;
  store.produceCount[index] = count - 1;
  store.produceTicks[index] = 0;
}

/** Everything queued at a structure, head first. For the HUD and tests. */
export function listProduction(store: UnitStore, index: number): number[] {
  const out: number[] = [];
  const count = store.produceCount[index] as number;
  for (let i = 0; i < count; i++) {
    out.push(store.produceType[produceSlot(index, (store.produceHead[index] as number) + i)] as number);
  }
  return out;
}

/** True while a structure is still being built. */
export function isUnderConstruction(store: UnitStore, index: number): boolean {
  return (store.buildTicks[index] as number) > 0;
}
