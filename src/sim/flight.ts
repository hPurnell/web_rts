/**
 * Flight: helicopters, and how they get off and back onto the ground.
 *
 * An aircraft is not a ground unit with the collision turned off. It ignores
 * the flow field, the navigation grid and every other unit, it carries an
 * altitude, and it cannot go anywhere until it has taken off. All of that is
 * simulation state — it decides where the thing is, what it can see and what
 * can shoot it — so all of it is integer-only like the rest of `sim/`.
 *
 * **The physics are rate-limited rather than instant**, which is the whole
 * difference between this and the ground movement next door. A ground unit
 * reads a direction and moves at its top speed that tick. A helicopter has an
 * acceleration and a turn rate, so it leans into a course change, overshoots
 * slightly and settles, and slides to a stop rather than halting. That lag is
 * what the source game's helicopters feel like, and it is also what gives the
 * renderer something honest to bank and pitch from: it reads the change in
 * velocity and heading rather than inventing an animation.
 *
 * What is *not* here: bank and pitch angles. They are a function of the
 * velocity the simulation already stores, nothing else reads them, and putting
 * them in the store would mean hashing two more arrays for a purely visual
 * effect. `render/units.ts` derives them.
 */
import type { Fixed } from './fixed.ts';
import { ONE, abs, add, div, length as fixedLength, mul, sub } from './fixed.ts';
import { angleDelta, atan2, normalizeAngle } from './trig.ts';
import type { Match } from './match.ts';
import { AirState, OrderKind, UnitState, headOrder } from './units.ts';
import { unitType } from './unittypes.ts';
import type { World } from './world.ts';
import { worldFromCell } from './world.ts';

export interface FlightContext {
  readonly world: World;
}

/**
 * How close to the target an aircraft has to be before it counts as arrived.
 *
 * Wider than a ground unit's arrival radius. A helicopter cannot stop on a
 * sixpence — it has to decelerate — and a tight radius makes it sail past the
 * point, turn around, and sail past again from the other side.
 */
const ARRIVAL = 98304; // 1.5 cells

/** Below this speed an aircraft counts as stopped, for landing. */
const HOVER_SPEED = 3277; // 0.05 cells per tick

/** Altitude below which the aircraft is on the ground. */
const TOUCHDOWN = 1638; // 0.025 cells

/** Advance every aircraft by one tick. */
export function stepFlight(match: Match, context: FlightContext): void {
  const store = match.units;

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    const type = unitType(store.typeId[i] as number);
    if (!type.isAircraft) continue;

    const order = headOrder(store, i);
    const state = store.airState[i] as AirState;

    // A move order given to a grounded helicopter takes off first, rather than
    // being refused. Anything else would mean every order on an aircraft is
    // two orders, which is not how the source game plays.
    const wantsToFly =
      order.kind === OrderKind.TakeOff ||
      ((order.kind === OrderKind.Move ||
        order.kind === OrderKind.AttackMove ||
        order.kind === OrderKind.Attack) &&
        order.cell >= 0);

    switch (state) {
      case AirState.Grounded:
        store.velX[i] = 0;
        store.velZ[i] = 0;
        store.altitude[i] = 0;
        if (wantsToFly) store.airState[i] = AirState.TakingOff;
        break;

      case AirState.TakingOff:
        // Straight up first, then travel. Translating while still on the skids
        // looks like the helicopter is being dragged.
        store.velX[i] = 0;
        store.velZ[i] = 0;
        climb(store, i, type.cruiseAltitude, type.climbRate);
        if ((store.altitude[i] as number) >= type.cruiseAltitude) {
          store.altitude[i] = type.cruiseAltitude;
          store.airState[i] = AirState.Airborne;
        }
        break;

      case AirState.Airborne: {
        climb(store, i, type.cruiseAltitude, type.climbRate);
        const target = destination(store, i, order, context);
        fly(store, i, type, target);
        if (order.kind === OrderKind.Land && target === null) {
          store.airState[i] = AirState.Landing;
        }
        break;
      }

      case AirState.Landing: {
        // Bleed off speed before descending, so it comes down where it was
        // told to rather than wherever its momentum was taking it.
        fly(store, i, type, null);
        const speed = fixedLength(store.velX[i] as number, store.velZ[i] as number);
        if (speed <= HOVER_SPEED) {
          store.velX[i] = 0;
          store.velZ[i] = 0;
          climb(store, i, 0, type.climbRate);
          if ((store.altitude[i] as number) <= TOUCHDOWN) {
            store.altitude[i] = 0;
            store.airState[i] = AirState.Grounded;
          }
        }
        break;
      }
    }

    store.state[i] =
      store.airState[i] === AirState.Grounded &&
      (store.velX[i] as number) === 0 &&
      (store.velZ[i] as number) === 0
        ? UnitState.Idle
        : store.state[i] === UnitState.Idle && isMovingOrder(order)
          ? UnitState.Moving
          : (store.state[i] as UnitState);
  }
}

function isMovingOrder(order: ReturnType<typeof headOrder>): boolean {
  return (
    order.kind === OrderKind.Move ||
    order.kind === OrderKind.AttackMove ||
    order.kind === OrderKind.Attack
  );
}

/** Move the altitude toward a target, by at most `rate` this tick. */
function climb(
  store: Match['units'],
  index: number,
  target: Fixed,
  rate: Fixed,
): void {
  const current = store.altitude[index] as number;
  const gap = sub(target, current);
  if (abs(gap) <= rate) {
    store.altitude[index] = target;
    return;
  }
  store.altitude[index] = add(current, gap > 0 ? rate : -rate);
}

/**
 * Where this aircraft is trying to be, or null to hold station.
 *
 * A landing order with a cell flies there first and comes down on it; a
 * landing order without one comes down where it stands.
 */
function destination(
  store: Match['units'],
  index: number,
  order: ReturnType<typeof headOrder>,
  context: FlightContext,
): { x: Fixed; z: Fixed } | null {
  if (order.kind === OrderKind.Land) {
    if (order.cell < 0) return null;
    const centre = worldFromCell(context.world, order.cell);
    // Once it is over the pad, stop steering and start descending.
    const gap = fixedLength(
      sub(centre.x, store.posX[index] as number),
      sub(centre.z, store.posZ[index] as number),
    );
    return gap <= ARRIVAL ? null : centre;
  }

  if (!isMovingOrder(order) || order.cell < 0) return null;
  const centre = worldFromCell(context.world, order.cell);
  const gap = fixedLength(
    sub(centre.x, store.posX[index] as number),
    sub(centre.z, store.posZ[index] as number),
  );
  if (gap <= ARRIVAL) {
    // Arrived: clear the goal so the order queue can retire the order.
    store.goalCell[index] = -1;
    store.state[index] = UnitState.Idle;
    return null;
  }
  return centre;
}

/**
 * One tick of horizontal flight toward a point, or to a hover when null.
 *
 * Velocity chases a target velocity at a limited rate rather than snapping to
 * it, and the nose chases the velocity at a limited rate in turn. Both limits
 * matter: without the first the helicopter starts and stops like a lift, and
 * without the second it pirouettes on the spot when given a course reversal.
 */
function fly(
  store: Match['units'],
  index: number,
  type: ReturnType<typeof unitType>,
  target: { x: Fixed; z: Fixed } | null,
): void {
  const x = store.posX[index] as number;
  const z = store.posZ[index] as number;

  let wantX: Fixed = 0;
  let wantZ: Fixed = 0;
  if (target) {
    const dx = sub(target.x, x);
    const dz = sub(target.z, z);
    const distance = fixedLength(dx, dz);
    if (distance > 0) {
      // Ease off on the way in, so it settles over the point instead of
      // arriving at full speed and having to fly back.
      const approach = distance < BRAKING_DISTANCE ? div(distance, BRAKING_DISTANCE) : ONE;
      const speed = mul(type.speed, approach);
      wantX = mul(div(dx, distance), speed);
      wantZ = mul(div(dz, distance), speed);
    }
  }

  // Chase the wanted velocity, clamped to what the rotor can do in a tick.
  const velX = store.velX[index] as number;
  const velZ = store.velZ[index] as number;
  let dvx = sub(wantX, velX);
  let dvz = sub(wantZ, velZ);
  const change = fixedLength(dvx, dvz);
  if (change > type.acceleration) {
    dvx = mul(div(dvx, change), type.acceleration);
    dvz = mul(div(dvz, change), type.acceleration);
  }

  const nextVelX = add(velX, dvx);
  const nextVelZ = add(velZ, dvz);
  store.velX[index] = nextVelX;
  store.velZ[index] = nextVelZ;
  store.posX[index] = add(x, nextVelX);
  store.posZ[index] = add(z, nextVelZ);

  // The nose follows the travel direction, at a limited rate. A hovering
  // helicopter keeps the heading it had rather than snapping back to zero.
  if (fixedLength(nextVelX, nextVelZ) > HOVER_SPEED) {
    const wanted = atan2(nextVelZ, nextVelX);
    const delta = angleDelta(store.facing[index] as number, wanted);
    const step = abs(delta) <= type.turnRate ? delta : delta > 0 ? type.turnRate : -type.turnRate;
    store.facing[index] = normalizeAngle(add(store.facing[index] as number, step));
  }
}

/** How far out an aircraft starts easing off the throttle, in cells. */
const BRAKING_DISTANCE = 393216; // 6 cells
