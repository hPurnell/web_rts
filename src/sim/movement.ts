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
import { ONE, abs, add, div, fromInt, isqrt, length as fixedLength, mul, sub } from './fixed.ts';
import { atan2 } from './trig.ts';
import type { Match } from './match.ts';
import { UnitState } from './units.ts';
import { unitType } from './unittypes.ts';
import type { World } from './world.ts';
import { cellFromWorld, cellIndex } from './world.ts';
import { slopeSpeedScale } from './terrain.ts';
import type { HeightOverrides } from './terrain.ts';
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

/** The same directions as whole cell offsets, for sampling the ground ahead. */
const STEP_CX: readonly number[] = [0, 1, 1, 1, 0, -1, -1, -1];
const STEP_CZ: readonly number[] = [-1, -1, 0, 1, 1, 1, 0, -1];

/** The cell one step along a flow direction, or the cell itself at the edge. */
function neighbourCell(world: World, cell: number, direction: number): number {
  const next = cellIndex(
    world,
    (cell % world.width) + (STEP_CX[direction] as number),
    ((cell / world.width) | 0) + (STEP_CZ[direction] as number),
  );
  return next < 0 ? cell : next;
}

/** How hard neighbours push each other apart, as a fraction of top speed. */
const SEPARATION_STRENGTH = ONE; // 1.0
/** Base arrival radius in cells, for a single unit. */
const ARRIVAL_RADIUS = 39321; // 0.6 cells
/**
 * How far the arrival disc spreads per unit, as a multiple of unit radius.
 *
 * Units stop once they are inside the arrival radius and stop separating once
 * idle, so that radius has to be big enough to actually hold the crowd. The
 * area a crowd needs grows with its count, so the radius grows with the square
 * root of it: packing `n` discs of radius r loosely needs a disc of about
 * 1.6 * r * sqrt(n). A linear rule looks fine for six units and leaves fifty
 * standing inside each other.
 */
const ARRIVAL_SPREAD = 65536; // 1.0
/** Arrival radius never grows past this, however big the army. */
const MAX_ARRIVAL_RADIUS = 524288; // 8 cells
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
  /** The match's terrain changes, so units walk on the ground buildings left. */
  readonly overrides?: HeightOverrides | null;
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
    const goal = store.goalCell[i] as number;
    if (goal < 0) continue;
    crowd.set(goal, (crowd.get(goal) ?? 0) + 1);
  }

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    // Anything with a goal walks, whatever it thinks it is doing: a worker on
    // its way to a patch is Gathering, not Moving, and still has to get there.
    if ((store.goalCell[i] as number) < 0) continue;
    // Except aircraft, which `flight.ts` has already moved this tick. They
    // route around nothing and collide with nothing, so the flow field and the
    // separation pass below have no opinion worth hearing.
    if (unitType(store.typeId[i] as number).isAircraft) continue;

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
    const radius = arrivalRadius(
      crowd.get(goalCell) ?? 1,
      unitType(store.typeId[i] as number).radius,
    );
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

    // Terrain tax: climbing is slow and descending is a little quick. The
    // gradient is measured toward the cell the flow field is sending the unit
    // into, not toward wherever separation has shoved it, so a unit crossing a
    // ridge slows down for the ridge rather than for its neighbours.
    const aheadCell = neighbourCell(context.world, cell, direction);
    const terrain = slopeSpeedScale(context.world, cell, aheadCell, context.overrides);

    // Normalise, then scale to this unit's speed: steering must never make a
    // unit faster than its type says it is.
    const speed = mul(type.speed, terrain);
    const velX = mul(div(dirX, length), speed);
    const velZ = mul(div(dirZ, length), speed);

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

  resolveOverlaps(store, hash, context);
  return hash;
}

/**
 * Ease apart units that are standing inside each other.
 *
 * Units stop as soon as they enter the arrival radius, and they all arrive
 * from the same side, so without this a squad settles as a clump at the near
 * edge of the disc. Nudging only resolves actual overlap, and only by half the
 * penetration, so it converges instead of oscillating: once nothing overlaps,
 * nothing moves.
 */
function resolveOverlaps(store: Match['units'], hash: SpatialHash, context: MovementContext): void {
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.state[i] !== UnitState.Idle) continue;

    const type = unitType(store.typeId[i] as number);
    // A parked helicopter is not in anyone's way, and one in the air is not
    // even on the same plane.
    if (type.isAircraft) continue;
    const push = separation(store, hash, i, type.radius);
    if (push.x === 0 && push.z === 0) continue;

    // Half the correction each, since the other unit is doing the same.
    const stepX = mul(push.x, type.radius) >> 1;
    const stepZ = mul(push.z, type.radius) >> 1;
    if (stepX === 0 && stepZ === 0) continue;

    const x = store.posX[i] as number;
    const z = store.posZ[i] as number;
    const cell = cellFromWorld(context.world, x, z);
    const nextX = add(x, stepX);
    const nextZ = add(z, stepZ);
    const nextCell = cellFromWorld(context.world, nextX, nextZ);
    // Same rule as a step under power: never cross a link that does not exist.
    if (nextCell === cell || (nextCell >= 0 && isLinkedCell(context.grid, cell, nextCell))) {
      store.posX[i] = nextX;
      store.posZ[i] = nextZ;
    }
  }
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

/**
 * Stop walking.
 *
 * The state only drops to Idle for a unit that was plainly moving. A worker
 * arriving at a patch is still gathering, and the economy decides what it does
 * next; clearing its state here would restart its whole loop every trip.
 */
function stop(store: Match['units'], index: number): void {
  store.velX[index] = 0;
  store.velZ[index] = 0;
  store.goalCell[index] = -1;
  store.stuckTicks[index] = 0;
  store.bestProgress[index] = NO_PROGRESS;
  if (store.state[index] === UnitState.Moving) store.state[index] = UnitState.Idle;
}

/** Arrival radius for a goal shared by `count` units of radius `unitRadius`. */
export function arrivalRadius(count: number, unitRadius: Fixed): Fixed {
  if (count <= 1) return ARRIVAL_RADIUS;
  // Whole-number square root is precision enough for a crowd size, and it
  // cannot overflow the way scaling the count into Q16.16 first would.
  const root = fromInt(isqrt(count));
  const spread = mul(mul(unitRadius, ARRIVAL_SPREAD), root);
  const radius = add(ARRIVAL_RADIUS, spread);
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
    // Aircraft are not on this plane. A helicopter passing overhead would
    // otherwise plough a furrow through the infantry underneath it.
    if (unitType(store.typeId[other] as number).isAircraft) return;
    const otherRadius = unitType(store.typeId[other] as number).radius;
    const minimum = add(radius, otherRadius);

    const dx = sub(x, store.posX[other] as number);
    const dz = sub(z, store.posZ[other] as number);
    // Two units can only overlap if *both* axes are within the sum of their
    // radii, so either one exceeding it rules the pair out. This was written
    // with && , which is still correct but only rejects pairs that are far
    // away on both axes — most of the bucket fell through to the squared
    // distance test and, when that passed, to a square root.
    if (abs(dx) >= minimum || abs(dz) >= minimum) return;

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
