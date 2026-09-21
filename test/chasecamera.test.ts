/**
 * The chase camera's feel, as numbers.
 *
 * "Smooth" is not something a screenshot can show, so these pin the
 * properties that make it so: it settles where it should, it never cuts or
 * jolts, it swings through a turn rather than snapping, it stays out of the
 * ground, and it behaves the same at any frame rate.
 */
import { describe, expect, it } from 'vitest';
import { ChaseCamera, DEFAULT_TUNING, angleDelta, smoothDamp } from '../src/render/chasecamera.ts';
import type { CameraPose, ChasePose } from '../src/render/chasecamera.ts';

const flat = (): number => 0;
const OVERHEAD: CameraPose = { eye: { x: 0, y: 40, z: -28 }, look: { x: 0, y: 0, z: 0 } };

function run(
  chase: ChaseCamera,
  pose: (t: number) => ChasePose,
  seconds: number,
  dt = 1 / 60,
  ground: (x: number, z: number) => number = flat,
): CameraPose[] {
  const frames: CameraPose[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) frames.push(chase.follow(pose(t), dt, ground));
  return frames;
}

describe('smoothDamp', () => {
  it('reaches its target without overshooting', () => {
    const state = { v: 0 };
    let value = 0;
    let highest = 0;
    for (let i = 0; i < 300; i++) {
      value = smoothDamp(value, 10, state, 0.3, 1 / 60);
      highest = Math.max(highest, value);
    }
    expect(value).toBeCloseTo(10, 3);
    expect(highest).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('comes out the same at 30 and at 144 frames a second', () => {
    const at = (fps: number): number => {
      const state = { v: 0 };
      let value = 0;
      for (let i = 0; i < fps / 2; i++) value = smoothDamp(value, 10, state, 0.3, 1 / fps);
      return value;
    };
    expect(Math.abs(at(30) - at(144))).toBeLessThan(0.1);
  });

  it('survives a long frame, as after a tab switch', () => {
    const state = { v: 0 };
    const value = smoothDamp(0, 10, state, 0.3, 2);
    expect(value).toBeGreaterThan(9);
    expect(value).toBeLessThanOrEqual(10);
  });
});

describe('angleDelta', () => {
  it('goes the short way round', () => {
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6, 9);
    expect(angleDelta(-3, 3)).toBeCloseTo(6 - 2 * Math.PI, 9);
    expect(angleDelta(0, 1)).toBeCloseTo(1, 9);
  });
});

describe('the chase camera', () => {
  it('settles behind the unit and above it, looking ahead of it', () => {
    const chase = new ChaseCamera();
    const heading = Math.PI / 3;
    const unit = { x: 50, y: 2, z: 40, heading };
    chase.start(OVERHEAD, unit);
    const last = run(chase, () => unit, 5).at(-1)!;
    const t = DEFAULT_TUNING;
    expect(last.eye.x).toBeCloseTo(50 - Math.cos(heading) * t.distance, 2);
    expect(last.eye.z).toBeCloseTo(40 - Math.sin(heading) * t.distance, 2);
    expect(last.eye.y).toBeCloseTo(2 + t.height, 2);
    expect(last.look.x).toBeCloseTo(50 + Math.cos(heading) * t.lookAhead, 2);
    expect(last.look.z).toBeCloseTo(40 + Math.sin(heading) * t.lookAhead, 2);
  });

  it('glides in from the overhead view rather than cutting to the unit', () => {
    const chase = new ChaseCamera();
    const unit = { x: 30, y: 0, z: 30, heading: 0 };
    chase.start(OVERHEAD, unit);
    const first = chase.follow(unit, 1 / 60, flat);
    const moved = Math.hypot(
      first.eye.x - OVERHEAD.eye.x,
      first.eye.y - OVERHEAD.eye.y,
      first.eye.z - OVERHEAD.eye.z,
    );
    expect(moved).toBeLessThan(1);
  });

  it('swings round behind a unit that turns, over a fraction of a second', () => {
    const chase = new ChaseCamera();
    const east = { x: 0, y: 0, z: 0, heading: 0 };
    chase.start(OVERHEAD, east);
    run(chase, () => east, 5);
    // Turn to face north, all at once.
    const north = { ...east, heading: Math.PI / 2 };
    const frames = run(chase, () => north, 2);
    const bearing = (f: CameraPose): number => Math.atan2(-f.eye.z, -f.eye.x);
    // Still mostly behind the old heading after one frame; behind the new one
    // by the end; and every frame a small step, never a snap.
    expect(Math.abs(bearing(frames[0]!))).toBeLessThan(0.1);
    expect(bearing(frames.at(-1)!)).toBeCloseTo(Math.PI / 2, 1);
    for (let i = 1; i < frames.length; i++) {
      expect(Math.abs(angleDelta(bearing(frames[i - 1]!), bearing(frames[i]!)))).toBeLessThan(0.08);
    }
  });

  it('does not jolt when the unit sets off', () => {
    const chase = new ChaseCamera();
    const still = { x: 0, y: 0, z: 0, heading: 0 };
    chase.start(OVERHEAD, still);
    run(chase, () => still, 5);
    // Off at four cells a second along x.
    const frames = run(chase, (t) => ({ ...still, x: 4 * t }), 3);
    const speed = (i: number): number => (frames[i]!.eye.x - frames[i - 1]!.eye.x) * 60;
    // The camera accelerates into the unit's speed rather than matching it
    // on the first frame, and does get there.
    expect(speed(1)).toBeLessThan(1);
    expect(speed(frames.length - 1)).toBeCloseTo(4, 1);
    for (let i = 2; i < frames.length; i++) expect(speed(i)).toBeGreaterThanOrEqual(speed(i - 1) - 1e-6);
  });

  it('stays above the ground behind a unit climbing out of a valley', () => {
    const chase = new ChaseCamera();
    // A wall of ground behind the unit, higher than the camera would sit.
    const ground = (x: number): number => (x < -4 ? 12 : 0);
    const unit = { x: 0, y: 0, z: 0, heading: 0 };
    chase.start({ eye: { x: 0, y: 40, z: 0 }, look: { x: 0, y: 0, z: 0 } }, unit);
    for (const frame of run(chase, () => unit, 4, 1 / 60, ground)) {
      expect(frame.eye.y).toBeGreaterThanOrEqual(ground(frame.eye.x) + DEFAULT_TUNING.clearance * 0.5 - 1e-9);
    }
  });

  it('zooms out with the wheel, within limits', () => {
    const chase = new ChaseCamera();
    chase.zoomBy(100000);
    expect(chase.zoom).toBe(3);
    chase.zoomBy(-100000);
    expect(chase.zoom).toBe(0.5);
  });

  it('hands back to the overhead view on a glide, then lets go', () => {
    const chase = new ChaseCamera();
    const unit = { x: 10, y: 0, z: 10, heading: 0 };
    chase.start(OVERHEAD, unit);
    run(chase, () => unit, 3);
    chase.release();
    expect(chase.chasing).toBe(false);
    expect(chase.active).toBe(true);

    let frames = 0;
    let view = chase.handBack(OVERHEAD, 1 / 60);
    const firstGap = Math.hypot(view!.eye.x - OVERHEAD.eye.x, view!.eye.y - OVERHEAD.eye.y);
    expect(firstGap).toBeGreaterThan(5); // not a cut
    while (view && frames < 600) {
      view = chase.handBack(OVERHEAD, 1 / 60);
      frames++;
    }
    expect(view).toBeNull();
    expect(chase.active).toBe(false);
    expect(frames).toBeLessThan(180);
  });
});

describe('the lens shift', () => {
  it('moves the picture up by the fraction asked, in the matrix picking reads', async () => {
    const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine');
    const { Scene } = await import('@babylonjs/core/scene');
    const { Vector3 } = await import('@babylonjs/core/Maths/math.vector');
    const { RtsCamera } = await import('../src/render/camera.ts');
    const scene = new Scene(new NullEngine());
    const rts = new RtsCamera(scene, { bounds: { minX: 0, maxX: 100, minZ: 0, maxZ: 100 } });
    const eye = { x: 0, y: 5, z: 0 };
    const look = { x: 0, y: 5, z: 10 };
    const axisPoint = new Vector3(0, 5, 10);
    const ndcY = (): number => {
      const clip = Vector3.TransformCoordinates(
        axisPoint,
        rts.camera.getViewMatrix(true).multiply(rts.camera.getProjectionMatrix()),
      );
      return clip.y;
    };

    rts.show(eye, look, 0);
    expect(ndcY()).toBeCloseTo(0, 6);
    rts.show(eye, look, 0.3);
    expect(ndcY()).toBeCloseTo(0.3, 6);
    // And back to a centred view once the chase lets go.
    rts.moveTo(50, 50);
    rts.show(eye, look, 0);
    expect(ndcY()).toBeCloseTo(0, 6);
  });
});
