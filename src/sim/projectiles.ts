/**
 * Travelling projectiles.
 *
 * A separate structure-of-arrays store, like units: a siege shell in flight is
 * its own entity with a position and a heading, not a property of the unit
 * that fired it. That matters because the shooter can die mid-flight and the
 * shell should still land.
 *
 * Hitscan weapons never come through here at all; they resolve the instant
 * they fire.
 */
import type { Fixed } from './fixed.ts';
import type { UnitHandle } from './units.ts';
import { NULL_HANDLE } from './units.ts';

export const MAX_PROJECTILES = 1 << 12; // 4096

export interface ProjectileStore {
  count: number;
  alive: number;
  readonly posX: Int32Array;
  readonly posZ: Int32Array;
  readonly velX: Int32Array;
  readonly velZ: Int32Array;
  readonly target: Int32Array;
  readonly damage: Int32Array;
  readonly ownerId: Uint8Array;
  /** Ticks before the shot gives up and vanishes. */
  readonly ttl: Int32Array;
  readonly isAlive: Uint8Array;
  readonly nextFree: Int32Array;
  freeHead: number;
}

export function createProjectileStore(): ProjectileStore {
  const store: ProjectileStore = {
    count: 0,
    alive: 0,
    posX: new Int32Array(MAX_PROJECTILES),
    posZ: new Int32Array(MAX_PROJECTILES),
    velX: new Int32Array(MAX_PROJECTILES),
    velZ: new Int32Array(MAX_PROJECTILES),
    target: new Int32Array(MAX_PROJECTILES),
    damage: new Int32Array(MAX_PROJECTILES),
    ownerId: new Uint8Array(MAX_PROJECTILES),
    ttl: new Int32Array(MAX_PROJECTILES),
    isAlive: new Uint8Array(MAX_PROJECTILES),
    nextFree: new Int32Array(MAX_PROJECTILES).fill(-1),
    freeHead: -1,
  };
  return store;
}

export interface ProjectileSpawn {
  readonly x: Fixed;
  readonly z: Fixed;
  readonly velX: Fixed;
  readonly velZ: Fixed;
  readonly target: UnitHandle;
  readonly damage: number;
  readonly ownerId: number;
  readonly ttl: number;
}

export function spawnProjectile(store: ProjectileStore, spawn: ProjectileSpawn): number {
  let index: number;
  if (store.freeHead >= 0) {
    index = store.freeHead;
    store.freeHead = store.nextFree[index] as number;
    store.nextFree[index] = -1;
  } else {
    if (store.count >= MAX_PROJECTILES) return -1;
    index = store.count++;
  }

  store.posX[index] = spawn.x;
  store.posZ[index] = spawn.z;
  store.velX[index] = spawn.velX;
  store.velZ[index] = spawn.velZ;
  store.target[index] = spawn.target;
  store.damage[index] = spawn.damage;
  store.ownerId[index] = spawn.ownerId;
  store.ttl[index] = spawn.ttl;
  store.isAlive[index] = 1;
  store.alive++;
  return index;
}

export function despawnProjectile(store: ProjectileStore, index: number): void {
  if (index < 0 || index >= store.count || store.isAlive[index] !== 1) return;
  store.isAlive[index] = 0;
  store.target[index] = NULL_HANDLE;
  store.alive--;
  store.nextFree[index] = store.freeHead;
  store.freeHead = index;
}

export function resetProjectileStore(store: ProjectileStore): void {
  store.count = 0;
  store.alive = 0;
  store.freeHead = -1;
  store.isAlive.fill(0);
  store.nextFree.fill(-1);
}

export function projectileHashableArrays(store: ProjectileStore): {
  name: string;
  data: ArrayBufferView;
}[] {
  const n = store.count;
  return [
    { name: 'shot.posX', data: store.posX.subarray(0, n) },
    { name: 'shot.posZ', data: store.posZ.subarray(0, n) },
    { name: 'shot.velX', data: store.velX.subarray(0, n) },
    { name: 'shot.velZ', data: store.velZ.subarray(0, n) },
    { name: 'shot.target', data: store.target.subarray(0, n) },
    { name: 'shot.damage', data: store.damage.subarray(0, n) },
    { name: 'shot.ownerId', data: store.ownerId.subarray(0, n) },
    { name: 'shot.ttl', data: store.ttl.subarray(0, n) },
    { name: 'shot.isAlive', data: store.isAlive.subarray(0, n) },
    { name: 'shot.nextFree', data: store.nextFree.subarray(0, n) },
  ];
}
