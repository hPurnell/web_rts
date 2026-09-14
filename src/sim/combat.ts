/**
 * Combat: acquiring targets, firing, and dying.
 *
 * The rule that shapes everything here is that a unit may only attack what its
 * owner can see. Range is not enough — a siege tank outranges its own sight,
 * which is exactly why spotters exist — so every target check goes through the
 * fog grids. Without that, a player would be able to shoot units they have no
 * way of knowing about, and two clients with different vision would disagree
 * about who died.
 */
import type { Fixed } from './fixed.ts';
import { add, div, length as vectorLength, mul, sub } from './fixed.ts';
import { atan2 } from './trig.ts';
import type { Match } from './match.ts';
import type { UnitHandle, UnitStore } from './units.ts';
import {
  NULL_HANDLE,
  OrderKind,
  UnitState,
  clearOrders,
  despawnUnit,
  headOrder,
  makeHandle,
  resolve,
} from './units.ts';
import { unitType } from './unittypes.ts';
import { forEachInRadius } from './spatialhash.ts';
import { isVisible } from './fog.ts';
import type { World } from './world.ts';
import { cellFromWorld } from './world.ts';
import { despawnProjectile, spawnProjectile } from './projectiles.ts';

/**
 * Ticks between a unit looking for something to shoot.
 *
 * Acquisition scans every unit within sight, which is the most expensive thing
 * combat does. Spreading it over four ticks costs a fifth of a second of
 * reaction time and a quarter of the work.
 */
export const ACQUIRE_INTERVAL_TICKS = 4;
/** Ticks a projectile may fly before giving up. */
const PROJECTILE_TTL = 200;

export interface CombatContext {
  readonly world: World;
}

/** Run one tick of combat. */
export function stepCombat(match: Match, context: CombatContext): void {
  const store = match.units;

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if ((store.cooldown[i] as number) > 0) {
      store.cooldown[i] = (store.cooldown[i] as number) - 1;
    }
  }

  stepProjectiles(match, context);

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    const type = unitType(store.typeId[i] as number);
    if (!type.canAttack) continue;

    const owner = store.ownerId[i] as number;
    let target = resolve(store, store.targetHandle[i] as UnitHandle);

    // Drop a target that died, left vision, or was never valid.
    if (target >= 0 && !canEngage(match, context.world, owner, target)) {
      store.targetHandle[i] = NULL_HANDLE;
      target = -1;
    }

    if (target < 0) {
      // Stagger acquisition across ticks by slot, so the cost is spread rather
      // than every unit scanning on the same tick.
      if ((match.tick + i) % ACQUIRE_INTERVAL_TICKS !== 0) continue;
      const acquired = acquireTarget(match, context.world, i, type.sightRadius);
      if (acquired === NULL_HANDLE) continue;
      store.targetHandle[i] = acquired;
      target = resolve(store, acquired);
      if (target < 0) continue;
    }

    if ((store.cooldown[i] as number) > 0) continue;

    const range = add(type.attackRange, unitType(store.typeId[target] as number).radius);
    if (!withinRange(store, i, target, range)) continue;

    fire(match, i, target, type.damage, type.projectileSpeed, type.cooldown);
  }

  reapDead(match);
}

/** Can this player's unit legally shoot that one? */
function canEngage(match: Match, world: World, player: number, targetIndex: number): boolean {
  const store = match.units;
  if (store.isAlive[targetIndex] !== 1) return false;
  if (store.ownerId[targetIndex] === player) return false;
  const cell = cellFromWorld(
    world,
    store.posX[targetIndex] as number,
    store.posZ[targetIndex] as number,
  );
  // The whole point: range does not grant knowledge.
  return isVisible(match.fog, player, cell);
}

/**
 * Nearest visible enemy within a radius.
 *
 * Ties break toward the lower slot index, so two clients presented with two
 * equidistant targets pick the same one.
 */
export function acquireTarget(
  match: Match,
  world: World,
  index: number,
  radius: Fixed,
): UnitHandle {
  const store = match.units;
  const owner = store.ownerId[index] as number;
  const x = store.posX[index] as number;
  const z = store.posZ[index] as number;

  let bestIndex = -1;
  let bestDistance = mul(radius, radius);

  forEachInRadius(match.spatialHash, x, z, radius, (other) => {
    if (other === index) return;
    if (!canEngage(match, world, owner, other)) return;
    const dx = sub(x, store.posX[other] as number);
    const dz = sub(z, store.posZ[other] as number);
    const distance = add(mul(dx, dx), mul(dz, dz));
    if (distance > bestDistance) return;
    if (distance === bestDistance && bestIndex >= 0 && other > bestIndex) return;
    bestDistance = distance;
    bestIndex = other;
  });

  if (bestIndex < 0) return NULL_HANDLE;
  return makeHandle(bestIndex, store.generation[bestIndex] as number);
}

function withinRange(store: UnitStore, index: number, target: number, range: Fixed): boolean {
  const dx = sub(store.posX[index] as number, store.posX[target] as number);
  const dz = sub(store.posZ[index] as number, store.posZ[target] as number);
  return add(mul(dx, dx), mul(dz, dz)) <= mul(range, range);
}

function fire(
  match: Match,
  index: number,
  target: number,
  damage: number,
  projectileSpeed: Fixed,
  cooldown: number,
): void {
  const store = match.units;
  store.cooldown[index] = cooldown;

  const dx = sub(store.posX[target] as number, store.posX[index] as number);
  const dz = sub(store.posZ[target] as number, store.posZ[index] as number);
  store.facing[index] = atan2(dz, dx);

  if (projectileSpeed === 0) {
    // Hitscan: the shot lands the tick it is fired.
    applyDamage(match, target, damage);
    return;
  }

  const length = vectorLength(dx, dz);
  if (length === 0) {
    applyDamage(match, target, damage);
    return;
  }
  spawnProjectile(match.projectiles, {
    x: store.posX[index] as number,
    z: store.posZ[index] as number,
    velX: mul(div(dx, length), projectileSpeed),
    velZ: mul(div(dz, length), projectileSpeed),
    target: makeHandle(target, store.generation[target] as number),
    damage,
    ownerId: store.ownerId[index] as number,
    ttl: PROJECTILE_TTL,
  });
}

/**
 * Advance shots in flight.
 *
 * A shot homes on its target's current position rather than the point it was
 * aimed at, which is what stops fast units from outrunning every shell fired
 * at them. It lands when it reaches the target's radius, and expires if the
 * target dies first — the shot does not transfer to someone else.
 */
function stepProjectiles(match: Match, context: CombatContext): void {
  const shots = match.projectiles;
  const store = match.units;

  for (let i = 0; i < shots.count; i++) {
    if (shots.isAlive[i] !== 1) continue;

    shots.ttl[i] = (shots.ttl[i] as number) - 1;
    if ((shots.ttl[i] as number) <= 0) {
      despawnProjectile(shots, i);
      continue;
    }

    const target = resolve(store, shots.target[i] as UnitHandle);
    if (target < 0) {
      despawnProjectile(shots, i);
      continue;
    }

    const x = shots.posX[i] as number;
    const z = shots.posZ[i] as number;
    const dx = sub(store.posX[target] as number, x);
    const dz = sub(store.posZ[target] as number, z);
    const speed = vectorLength(shots.velX[i] as number, shots.velZ[i] as number);
    const distance = vectorLength(dx, dz);
    const hitRadius = unitType(store.typeId[target] as number).radius;

    if (distance <= add(speed, hitRadius)) {
      applyDamage(match, target, shots.damage[i] as number);
      despawnProjectile(shots, i);
      continue;
    }

    // Re-aim each tick: a shell that was fired at where a unit used to be
    // never hits anything that moves.
    shots.velX[i] = mul(div(dx, distance), speed);
    shots.velZ[i] = mul(div(dz, distance), speed);
    shots.posX[i] = add(x, shots.velX[i] as number);
    shots.posZ[i] = add(z, shots.velZ[i] as number);
    void context;
  }
}

/** Apply damage. Death is handled in one pass at the end of the tick. */
export function applyDamage(match: Match, targetIndex: number, damage: number): void {
  const store = match.units;
  if (store.isAlive[targetIndex] !== 1) return;
  const hp = (store.hp[targetIndex] as number) - (damage | 0);
  store.hp[targetIndex] = hp;
}

/**
 * Remove everything that died this tick.
 *
 * Done in one sweep after all damage, so the order two units kill each other
 * in cannot depend on the order they were examined: if both are at zero, both
 * die, which is the only symmetric answer.
 */
function reapDead(match: Match): void {
  const store = match.units;
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if ((store.hp[i] as number) > 0) continue;
    // Corpses are a rendering concern; the simulation frees the slot at once,
    // and generational handles make every outstanding reference to it stale.
    clearOrders(store, i);
    despawnUnit(store, makeHandle(i, store.generation[i] as number));
  }
}

/** True when a unit is currently ordered to attack something. */
export function hasAttackOrder(store: UnitStore, index: number): boolean {
  const order = headOrder(store, index);
  return order.kind === OrderKind.Attack || order.kind === OrderKind.AttackMove;
}

/** Exposed for tests: whether a unit is idle with nothing to shoot. */
export function isEngaged(store: UnitStore, index: number): boolean {
  return (
    store.targetHandle[index] !== NULL_HANDLE && store.state[index] !== UnitState.Dead
  );
}
