/**
 * Movement: flow-field steering with local avoidance.
 *
 * Each moving unit reads one direction out of the flow field for its goal,
 * adds a push away from the neighbours crowding it, clamps to its top speed
 * and steps. Three details do most of the work of making that look like an
 * army rather than a particle system:
 *
 *  - A move is rejected if the navigation grid does not link the cell the unit
 *    is in to the cell it would end up in. That is what stops separation from
 *    shoving a unit off a cliff, and it is a hard guarantee rather than a
 *    tuning value.
 *  - Arrival radius grows with the number of units sharing a goal, so fifty
 *    units spread into a blob instead of grinding against one cell forever.
 *  - Units stop dead inside the arrival radius and stop separating once idle,
 *    which is what keeps a settled army from jittering.
 */
import type { Fixed } from './fixed.ts';
import { ONE, abs, add, div, mul, sub } from './fixed.ts';
import { atan2 } from './trig.ts';
import type { Match } from './match.ts';
import { UnitState } from './units.ts';
import { unitType } from './unittypes.ts';
import type { World } from './world.ts';
import { cellFromWorld } from './world.ts';
import type { CostGrid } from '../nav/grid.ts';
import { DIRECTIONS } from '../nav/grid.ts';
import type { FlowField } from '../nav/flowfield.ts';
import { NO_DIRECTION } from '../nav/flowfield.ts';
import { forEachNeighbour, rebuildSpatialHash } from './spatialhash.ts';
import type { SpatialHash } from './spatialhash.ts';

/** cos(45 degrees) in Q16.16, for normalising diagonal steps. */
const DIAGONAL = 46341;

/** Unit direction vectors per DIRECTIONS index, already normalised. */
const STEP_X: readonly Fixed[] = [0, DIAGONAL, ONE, DIAGONAL, 0, -DIAGONAL, -ONE, -DIAGONAL];
const STEP_Z: readonly Fixed[] = [-ONE, -DIAGONAL, 0, DIAGONAL, ONE, DIAGONAL, 0, -DIAGONAL];

/** How hard neighbours push each other apart, as a fraction of top speed. */
const SEPARATION_STRENGTH = ONE; // 1.0
/** Base arrival radius in cells. */
const ARRIVAL_RADIUS = 39321; // 0.6 cells
/** Extra arrival radius per unit sharing the goal, in cells. */
const ARRIVAL_PER_UNIT = 3276; // 0.05 cells
/** Arrival radius never grows past this, however big the army. */
const MAX_ARRIVAL_RADIUS = 327680; // 5 cells
/**
 * Ticks of no real progress before a unit gives up on its goal.
 *
 * Two hundred units sent to one cell cannot all stand on it. The ones at the
 * back press against the ones in front forever, which is not a deadlock — they
 * are all still trying — but it looks like one and it burns a tick's work per
 * unit per tick. Giving up after two seconds of getting nowhere is what makes
 * a big move order settle instead of simmering.
 */
const STUCK_LIMIT_TICKS = 40;
/** Flow-field distance counts as progress only if it improves on the best so
 * far, which is what distinguishes walking forward from being jostled. */
const NO_PROGRESS = 0x7fffffff;

export interface MovementContext {
  readonly world: World;
  readonly grid: CostGrid;
  /** Resolves the field for a goal cell, computing it if need be. */
  field(goalCell: number): FlowField | null;
  readonly hash: SpatialHash;
}

/**
 * Advance every moving unit by one tick.
 *
 * Returns the spatial hash, which may have been reallocated if the army grew.
 */
export function stepMovement(match: Match, context: MovementContext): SpatialHash {
  const store = match.units;
  const hash = rebuildSpatialHash(context.hash, store);

  // How many units share each goal, so arrival radius can widen for a crowd.
  const crowd = new Map<number, number>();
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.state[i] !== UnitState.Moving) continue;
    const goal = store.goalCell[i] as number;
    if (goal < 0) continue;
    crowd.set(goal, (crowd.get(goal) ?? 0) + 1);
  }

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.state[i] !== UnitState.Moving) continue;

    const goalCell = store.goalCell[i] as number;
    if (goalCell < 0) {
      stop(store, i);
      continue;
    }

    const field = context.field(goalCell);
    if (!field) {
      // No field yet: stand still rather than guess. Every client reaches the
      // same conclusion, because the field is a function of grid and goal.
      store.velX[i] = 0;
      store.velZ[i] = 0;
      continue;
    }

    const x = store.posX[i] as number;
    const z = store.posZ[i] as number;
    const cell = cellFromWorld(context.world, x, z);
    if (cell < 0) {
      stop(store, i);
      continue;
    }

    // Arrived?
    const radius = arrivalRadius(crowd.get(goalCell) ?? 1);
    if (cell === goalCell || withinGoal(context.world, x, z, goalCell, radius)) {
      stop(store, i);
      continue;
    }

    // Give up if pressed against a crowd that is not moving.
    if ((store.stuckTicks[i] as number) >= STUCK_LIMIT_TICKS) {
      stop(store, i);
      continue;
    }

    const direction = field.flow[cell] as number;
    if (direction === NO_DIRECTION) {
      // Standing somewhere the field cannot route from: the goal is walled off.
      stop(store, i);
      continue;
    }

    const type = unitType(store.typeId[i] as number);
    let dirX = STEP_X[direction] as number;
    let dirZ = STEP_Z[direction] as number;

    const push = separation(store, hash, i, type.radius);
    dirX = add(dirX, mul(push.x, SEPARATION_STRENGTH));
    dirZ = add(dirZ, mul(push.z, SEPARATION_STRENGTH));

    const length = fixedLength(dirX, dirZ);
    if (length <= 0) {
      store.velX[i] = 0;
      store.velZ[i] = 0;
      continue;
    }

    // Normalise, then scale to this unit's speed: steering must never make a
    // unit faster than its type says it is.
    const velX = mul(div(dirX, length), type.speed);
    const velZ = mul(div(dirZ, length), type.speed);

    const nextX = add(x, velX);
    const nextZ = add(z, velZ);
    const nextCell = cellFromWorld(context.world, nextX, nextZ);

    if (nextCell === cell) {
      commit(store, i, nextX, nextZ, velX, velZ);
    } else if (nextCell >= 0 && isLinkedCell(context.grid, cell, nextCell)) {
      commit(store, i, nextX, nextZ, velX, velZ);
    } else {
      // The step would cross a cliff or a wall. Try each axis alone, so a unit
      // pressed against a wall slides along it instead of sticking.
      const slideX = cellFromWorld(context.world, nextX, z);
      const slideZ = cellFromWorld(context.world, x, nextZ);
      if (slideX === cell || (slideX >= 0 && isLinkedCell(context.grid, cell, slideX))) {
        commit(store, i, nextX, z, velX, 0);
      } else if (slideZ === cell || (slideZ >= 0 && isLinkedCell(context.grid, cell, slideZ))) {
        commit(store, i, x, nextZ, 0, velZ);
      } else {
        store.velX[i] = 0;
        store.velZ[i] = 0;
      }
    }

    // Progress means getting closer to the goal through the field, not moving
    // at all: a unit being shoved sideways in a crowd covers plenty of ground
    // and gets nowhere. Measuring the integration value instead is exact and
    // costs one array read.
    const nowCell = cellFromWorld(context.world, store.posX[i] as number, store.posZ[i] as number);
    const distance = nowCell >= 0 ? (field.integration[nowCell] as number) : NO_PROGRESS;
    if (distance < (store.bestProgress[i] as number)) {
      store.bestProgress[i] = distance;
      store.stuckTicks[i] = 0;
    } else {
      store.stuckTicks[i] = (store.stuckTicks[i] as number) + 1;
    }
  }

  return hash;
}

function commit(
  store: Match['units'],
  index: number,
  x: Fixed,
  z: Fixed,
  velX: Fixed,
  velZ: Fixed,
): void {
  store.posX[index] = x;
  store.posZ[index] = z;
  store.velX[index] = velX;
  store.velZ[index] = velZ;
  if (velX !== 0 || velZ !== 0) store.facing[index] = atan2(velZ, velX);
}

function stop(store: Match['units'], index: number): void {
  store.velX[index] = 0;
  store.velZ[index] = 0;
  store.state[index] = UnitState.Idle;
  store.goalCell[index] = -1;
  store.stuckTicks[index] = 0;
  store.bestProgress[index] = NO_PROGRESS;
}

/** Arrival radius for a goal shared by `count` units. */
export function arrivalRadius(count: number): Fixed {
  const extra = ARRIVAL_PER_UNIT * Math.max(0, count - 1);
  const radius = ARRIVAL_RADIUS + extra;
  return radius > MAX_ARRIVAL_RADIUS ? MAX_ARRIVAL_RADIUS : radius;
}

function withinGoal(
  world: World,
  x: Fixed,
  z: Fixed,
  goalCell: number,
  radius: Fixed,
): boolean {
  const half = world.cellSize >> 1;
  const goalX = mul((goalCell % world.width) * ONE, world.cellSize) + half;
  const goalZ = mul(((goalCell / world.width) | 0) * ONE, world.cellSize) + half;
  const dx = sub(x, goalX);
  const dz = sub(z, goalZ);
  // Squared comparison: no square root needed to answer "am I close enough".
  return add(mul(dx, dx), mul(dz, dz)) <= mul(radius, radius);
}

/**
 * Push away from neighbours that overlap this unit.
 *
 * Weighted by how deep the overlap is, so units barely touching drift apart
 * gently while units on top of each other separate hard.
 */
function separation(
  store: Match['units'],
  hash: SpatialHash,
  index: number,
  radius: Fixed,
): { x: Fixed; z: Fixed } {
  const x = store.posX[index] as number;
  const z = store.posZ[index] as number;
  let pushX = 0;
  let pushZ = 0;

  forEachNeighbour(hash, x, z, (other) => {
    if (other === index) return;
    if (store.isAlive[other] !== 1) return;
    const otherRadius = unitType(store.typeId[other] as number).radius;
    const minimum = add(radius, otherRadius);

    const dx = sub(x, store.posX[other] as number);
    const dz = sub(z, store.posZ[other] as number);
    if (abs(dx) >= minimum && abs(dz) >= minimum) return;

    const distanceSq = add(mul(dx, dx), mul(dz, dz));
    if (distanceSq >= mul(minimum, minimum)) return;

    if (distanceSq === 0) {
      // Exactly coincident: nudge apart by index so the tie is broken the same
      // way on every client rather than by whichever is examined first.
      pushX = add(pushX, index < other ? -ONE : ONE);
      return;
    }

    const distance = fixedLength(dx, dz);
    const overlap = div(sub(minimum, distance), minimum);
    pushX = add(pushX, mul(div(dx, distance), overlap));
    pushZ = add(pushZ, mul(div(dz, distance), overlap));
  });

  return { x: pushX, z: pushZ };
}

/** Length of a fixed-point vector, guarding against overflow in the square. */
function fixedLength(x: Fixed, z: Fixed): Fixed {
  const ax = abs(x);
  const az = abs(z);
  if (ax === 0) return az;
  if (az === 0) return ax;
  // sqrt of the sum of squares; both are well inside range for unit vectors.
  const sum = add(mul(ax, ax), mul(az, az));
  return sqrtFixed(sum);
}

function sqrtFixed(a: Fixed): Fixed {
  if (a <= 0) return 0;
  const n = a * ONE;
  let root = 0;
  for (let bit = 1 << 23; bit !== 0; bit >>= 1) {
    const trial = root + bit;
    if (trial * trial <= n) root = trial;
  }
  return root | 0;
}

function isLinkedCell(grid: CostGrid, from: number, to: number): boolean {
  const fx = from % grid.width;
  const fy = (from / grid.width) | 0;
  const tx = to % grid.width;
  const ty = (to / grid.width) | 0;
  const dx = tx - fx;
  const dy = ty - fy;
  if (dx === 0 && dy === 0) return true;
  if (abs(dx) > 1 || abs(dy) > 1) return false;
  for (let dir = 0; dir < DIRECTIONS.length; dir++) {
    const [ox, oy] = DIRECTIONS[dir] as [number, number];
    if (ox === dx && oy === dy) {
      return ((grid.links[from] as number) & (1 << dir)) !== 0;
    }
  }
  return false;
}
