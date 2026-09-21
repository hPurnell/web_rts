/**
 * The chase camera: third person, behind a unit, looking where it is going.
 *
 * What makes one feel good is almost entirely the smoothing, so everything
 * here is springs rather than easing. A critically damped spring — Unity's
 * `SmoothDamp`, from *Game Programming Gems 4* — carries a velocity, so the
 * camera accelerates after a unit that sets off and settles after one that
 * stops, with no jolt at either end, and it is stable at any frame rate. Plain
 * exponential easing, which the RTS camera's zoom uses, has no velocity: it
 * jumps to full speed the frame the target moves, and that jump is exactly the
 * violence this is meant to avoid.
 *
 * Three springs with different stiffness, because a camera that tracks
 * everything equally tightly looks welded to the unit:
 *
 * - **Heading** is the laziest. The camera swings round behind a turning unit
 *   over half a second or so, which reads as following it through the corner
 *   rather than being bolted to its tail.
 * - **Position** lags a little, so speed is visible as the unit pulling ahead.
 * - **The look point** is the stiffest, so the unit stays framed while the
 *   camera catches up.
 *
 * The view is framed on the part of the screen that can be seen: a panel
 * covering the bottom of it would otherwise hide the unit, since a camera
 * behind something looks at it from above and so draws it low. Aiming higher
 * only trades the unit for the road ahead; a lens shift moves the whole
 * picture up instead, and is eased in and out like everything else.
 *
 * The camera never goes below the ground: its wanted height already clears
 * the terrain under where it wants to be, and a hard floor catches a sharp
 * ridge the spring has not climbed yet.
 *
 * It knows nothing about units or the simulation. It is handed a pose each
 * frame, which is the unit as drawn — interpolated between ticks — not as
 * simulated, which only moves at tick boundaries and would drag the camera in
 * steps.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What is being followed: where it is and which way it is heading. */
export interface ChasePose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The simulation's heading: the unit travels along `(cos, sin)` in x, z. */
  readonly heading: number;
}

/** Where the camera is and what it looks at. */
export interface CameraPose {
  readonly eye: Vec3;
  readonly look: Vec3;
  /**
   * How far up the screen the view's centre is moved, as a fraction of half
   * the screen's height — a lens shift. Absent or 0 for a centred view.
   */
  readonly lens?: number;
}

export interface ChaseTuning {
  /** Distance behind the unit, in world units. */
  readonly distance: number;
  /** Height above the unit. */
  readonly height: number;
  /** How far ahead of the unit the camera looks. */
  readonly lookAhead: number;
  /** How far above the unit's footing it looks. */
  readonly lookHeight: number;
  /** Seconds each spring takes, roughly, to close most of a gap. */
  readonly headingTime: number;
  readonly eyeTime: number;
  readonly lookTime: number;
  /** How far the eye stays above the ground under it. */
  readonly clearance: number;
  /** Seconds to hand back to the overhead camera. */
  readonly returnTime: number;
}

/**
 * Framing sized for a tank of about three cells: close enough to read the
 * model, far enough back to see what it is driving into. The look point is
 * only a little ahead and the eye fairly high, which puts the unit just below
 * the middle of the screen: looking further ahead lowered it until the HUD
 * panel covered it.
 */
export const DEFAULT_TUNING: ChaseTuning = {
  distance: 10,
  height: 5.5,
  lookAhead: 2.5,
  lookHeight: 1.5,
  headingTime: 0.45,
  eyeTime: 0.28,
  lookTime: 0.12,
  clearance: 1.2,
  returnTime: 0.35,
};

/** How far the wheel may pull the camera in or push it out. */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const WHEEL_TO_ZOOM = 0.0012;

/**
 * One step of a critically damped spring toward `target`.
 *
 * Returns the new value and writes the new velocity to `state.v`. The
 * polynomial is a cheap, accurate stand-in for `exp(-omega * dt)`, and the
 * update is exact enough that a long frame overshoots nothing.
 */
export function smoothDamp(
  current: number,
  target: number,
  state: { v: number },
  smoothTime: number,
  dt: number,
): number {
  const time = Math.max(1e-4, smoothTime);
  const omega = 2 / time;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * decay;
  return target + (change + temp) * decay;
}

/** The difference `to - from`, the short way round a circle. */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

type Mode = 'off' | 'chasing' | 'returning';

export class ChaseCamera {
  private mode: Mode = 'off';
  private readonly eye: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly look: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly eyeV: [{ v: number }, { v: number }, { v: number }] = [{ v: 0 }, { v: 0 }, { v: 0 }];
  private readonly lookV: [{ v: number }, { v: number }, { v: number }] = [{ v: 0 }, { v: 0 }, { v: 0 }];
  private yaw = 0;
  private readonly yawV = { v: 0 };
  private lens = 0;
  private readonly lensV = { v: 0 };
  /** Multiplier on distance and height, from the wheel. */
  zoom = 1;

  constructor(readonly tuning: ChaseTuning = DEFAULT_TUNING) {}

  /** Following something, as opposed to off or handing back. */
  get chasing(): boolean {
    return this.mode === 'chasing';
  }

  /** In control of the camera at all: chasing, or still handing back. */
  get active(): boolean {
    return this.mode !== 'off';
  }

  /**
   * Start following, from wherever the camera is now.
   *
   * The springs start at the current view, not behind the unit, so turning
   * the chase on glides down into it instead of cutting.
   */
  start(from: CameraPose, pose: ChasePose): void {
    if (this.mode === 'off') {
      Object.assign(this.eye, from.eye);
      Object.assign(this.look, from.look);
      this.lens = from.lens ?? 0;
      for (const s of [...this.eyeV, ...this.lookV, this.lensV]) s.v = 0;
    }
    // Continuing from a hand-back keeps its velocity: the camera turns round
    // in flight rather than stopping dead.
    this.yaw = pose.heading;
    this.yawV.v = 0;
    this.mode = 'chasing';
  }

  /** Stop following and glide back to the overhead camera. */
  release(): void {
    if (this.mode === 'chasing') this.mode = 'returning';
  }

  /** Stop at once, e.g. when the map changes under it. */
  reset(): void {
    this.mode = 'off';
  }

  /** Mouse wheel: in or out, multiplicatively like the overhead camera. */
  zoomBy(wheel: number): void {
    if (wheel === 0) return;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * Math.exp(wheel * WHEEL_TO_ZOOM)));
  }

  /**
   * Advance one frame while chasing. `groundY` is the terrain height at a
   * point; the camera stays that far and more above it. `lens` is the lens
   * shift to settle on: the fraction of the screen a panel covers at the
   * bottom, so the view is framed on what can actually be seen.
   */
  follow(
    pose: ChasePose,
    dt: number,
    groundY: (x: number, z: number) => number,
    lens = 0,
  ): CameraPose {
    const t = this.tuning;
    // Heading: spring on the angle, unwrapped so it always goes the short way.
    const wantYaw = this.yaw + angleDelta(this.yaw, pose.heading);
    this.yaw = smoothDamp(this.yaw, wantYaw, this.yawV, t.headingTime, dt);

    const backX = -Math.cos(this.yaw);
    const backZ = -Math.sin(this.yaw);
    const distance = t.distance * this.zoom;
    const wantX = pose.x + backX * distance;
    const wantZ = pose.z + backZ * distance;
    // Clear the ground where the camera is going as well as the unit, or it
    // tucks into the hill behind a unit climbing out of a valley.
    const wantY = Math.max(pose.y + t.height * this.zoom, groundY(wantX, wantZ) + t.clearance);

    this.eye.x = smoothDamp(this.eye.x, wantX, this.eyeV[0], t.eyeTime, dt);
    this.eye.y = smoothDamp(this.eye.y, wantY, this.eyeV[1], t.eyeTime, dt);
    this.eye.z = smoothDamp(this.eye.z, wantZ, this.eyeV[2], t.eyeTime, dt);
    const floor = groundY(this.eye.x, this.eye.z) + t.clearance * 0.5;
    if (this.eye.y < floor) {
      this.eye.y = floor;
      this.eyeV[1].v = Math.max(0, this.eyeV[1].v);
    }

    const aheadX = pose.x - backX * t.lookAhead;
    const aheadZ = pose.z - backZ * t.lookAhead;
    this.look.x = smoothDamp(this.look.x, aheadX, this.lookV[0], t.lookTime, dt);
    this.look.y = smoothDamp(this.look.y, pose.y + t.lookHeight, this.lookV[1], t.lookTime, dt);
    this.look.z = smoothDamp(this.look.z, aheadZ, this.lookV[2], t.lookTime, dt);
    this.lens = smoothDamp(this.lens, lens, this.lensV, t.eyeTime, dt);

    return { eye: { ...this.eye }, look: { ...this.look }, lens: this.lens };
  }

  /**
   * Advance one frame while handing back to `overhead`, the view the normal
   * camera would show. Returns null once it has arrived and let go.
   */
  handBack(overhead: CameraPose, dt: number): CameraPose | null {
    const t = this.tuning.returnTime;
    const axes = ['x', 'y', 'z'] as const;
    axes.forEach((axis, i) => {
      this.eye[axis] = smoothDamp(this.eye[axis], overhead.eye[axis], this.eyeV[i] as { v: number }, t, dt);
      this.look[axis] = smoothDamp(this.look[axis], overhead.look[axis], this.lookV[i] as { v: number }, t, dt);
    });
    this.lens = smoothDamp(this.lens, overhead.lens ?? 0, this.lensV, t, dt);
    const gap =
      Math.hypot(this.eye.x - overhead.eye.x, this.eye.y - overhead.eye.y, this.eye.z - overhead.eye.z) +
      Math.hypot(this.look.x - overhead.look.x, this.look.y - overhead.look.y, this.look.z - overhead.look.z);
    if (gap < 0.05 && Math.abs(this.lens - (overhead.lens ?? 0)) < 0.005) {
      this.mode = 'off';
      return null;
    }
    return { eye: { ...this.eye }, look: { ...this.look }, lens: this.lens };
  }
}
