import { beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { RtsCamera, EDGE_PAN_MARGIN } from '../src/render/camera.ts';
import type { InputState } from '../src/render/input.ts';
import { MOUSE_MIDDLE } from '../src/render/input.ts';

const BOUNDS = { minX: 0, maxX: 64, minZ: 0, maxZ: 64 };
const CANVAS_W = 1280;
const CANVAS_H = 720;

/** A hand-driven InputState, so camera behaviour is testable without a DOM. */
function fakeInput(overrides: Partial<{ keys: string[]; wheel: number; buttons: number; x: number; y: number; inside: boolean; focused: boolean; drag: { dx: number; dy: number } }> = {}): InputState {
  let wheel = overrides.wheel ?? 0;
  let drag = overrides.drag ?? { dx: 0, dy: 0 };
  return {
    keys: new Set(overrides.keys ?? []),
    pointer: {
      x: overrides.x ?? CANVAS_W / 2,
      y: overrides.y ?? CANVAS_H / 2,
      inside: overrides.inside ?? true,
      buttons: overrides.buttons ?? 0,
      wheel: 0,
    },
    focused: overrides.focused ?? true,
    takeWheel() {
      const w = wheel;
      wheel = 0;
      return w;
    },
    takeDrag() {
      const d = drag;
      drag = { dx: 0, dy: 0 };
      return d;
    },
    dispose() {},
  };
}

describe('RTS camera', () => {
  let scene: Scene;
  let engine: NullEngine;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  const make = (): RtsCamera =>
    new RtsCamera(scene, { pitchDegrees: 55, bounds: BOUNDS, minHeight: 12, maxHeight: 90, startHeight: 38 });

  const run = (cam: RtsCamera, input: InputState, seconds: number, step = 1 / 60): void => {
    // Count steps rather than accumulating time, so two step sizes cover the
    // same simulated duration exactly and the comparison is about the camera.
    const steps = Math.round(seconds / step);
    for (let i = 0; i < steps; i++) cam.update(input, step, CANVAS_W, CANVAS_H);
  };

  it('starts centred on the map, looking down at the fixed pitch', () => {
    const cam = make();
    expect(cam.focusX).toBe(32);
    expect(cam.focusZ).toBe(32);
    // 55 degrees: the camera sits back by height / tan(55) and above by height.
    const back = 38 / Math.tan((55 * Math.PI) / 180);
    expect(cam.camera.position.y).toBeCloseTo(38, 5);
    expect(cam.camera.position.z).toBeCloseTo(32 - back, 5);
  });

  it('pans with WASD and with the arrow keys identically', () => {
    const a = make();
    run(a, fakeInput({ keys: ['KeyD'] }), 0.5);
    const b = make();
    run(b, fakeInput({ keys: ['ArrowRight'] }), 0.5);
    expect(a.focusX).toBeGreaterThan(32);
    expect(a.focusX).toBeCloseTo(b.focusX, 6);
  });

  it('does not pan faster diagonally', () => {
    // Half a second, so neither camera reaches the map edge and clamps.
    const straight = make();
    run(straight, fakeInput({ keys: ['KeyD'] }), 0.5);
    const diagonal = make();
    run(diagonal, fakeInput({ keys: ['KeyD', 'KeyW'] }), 0.5);
    const straightDistance = Math.hypot(straight.focusX - 32, straight.focusZ - 32);
    const diagonalDistance = Math.hypot(diagonal.focusX - 32, diagonal.focusZ - 32);
    expect(diagonalDistance).toBeCloseTo(straightDistance, 5);
  });

  it('edge-pans only when focused, inside the canvas and within the margin', () => {
    const near = make();
    run(near, fakeInput({ x: EDGE_PAN_MARGIN - 1 }), 0.5);
    expect(near.focusX).toBeLessThan(32);

    const justOutside = make();
    run(justOutside, fakeInput({ x: EDGE_PAN_MARGIN + 1 }), 0.5);
    expect(justOutside.focusX).toBe(32);

    const unfocused = make();
    run(unfocused, fakeInput({ x: 1, focused: false }), 0.5);
    expect(unfocused.focusX).toBe(32);

    const outside = make();
    run(outside, fakeInput({ x: 1, inside: false }), 0.5);
    expect(outside.focusX).toBe(32);
  });

  it('cannot leave the map in any direction', () => {
    for (const [key, check] of [
      ['KeyA', (c: RtsCamera) => expect(c.focusX).toBe(BOUNDS.minX)],
      ['KeyD', (c: RtsCamera) => expect(c.focusX).toBe(BOUNDS.maxX)],
      ['KeyW', (c: RtsCamera) => expect(c.focusZ).toBe(BOUNDS.maxZ)],
      ['KeyS', (c: RtsCamera) => expect(c.focusZ).toBe(BOUNDS.minZ)],
    ] as const) {
      const cam = make();
      run(cam, fakeInput({ keys: [key] }), 20);
      check(cam);
    }
  });

  it('clamps zoom to its range', () => {
    const inCam = make();
    for (let i = 0; i < 200; i++) inCam.update(fakeInput({ wheel: -500 }), 1 / 60, CANVAS_W, CANVAS_H);
    expect(inCam.currentHeight).toBeGreaterThanOrEqual(12);
    expect(inCam.currentHeight).toBeCloseTo(12, 1);

    const outCam = make();
    for (let i = 0; i < 200; i++) outCam.update(fakeInput({ wheel: 500 }), 1 / 60, CANVAS_W, CANVAS_H);
    expect(outCam.currentHeight).toBeLessThanOrEqual(90);
    expect(outCam.currentHeight).toBeCloseTo(90, 1);
  });

  it('keeps the ground point under the screen centre fixed while zooming', () => {
    // This is what "zoom does not fight pan" means: zooming never moves focus.
    const cam = make();
    const input = fakeInput({ wheel: -400 });
    cam.update(input, 1 / 60, CANVAS_W, CANVAS_H);
    run(cam, fakeInput(), 1);
    expect(cam.focusX).toBe(32);
    expect(cam.focusZ).toBe(32);
    expect(cam.currentHeight).toBeLessThan(38);
  });

  it('reports zoom as a 0..1 fraction', () => {
    const cam = make();
    expect(cam.zoomFraction).toBeCloseTo((38 - 12) / (90 - 12), 6);
  });

  it('pans on middle-drag and ignores drag without the middle button', () => {
    const dragging = make();
    dragging.update(fakeInput({ buttons: MOUSE_MIDDLE, drag: { dx: 100, dy: 0 } }), 1 / 60, CANVAS_W, CANVAS_H);
    expect(dragging.focusX).toBeLessThan(32);

    const notDragging = make();
    notDragging.update(fakeInput({ buttons: 0, drag: { dx: 100, dy: 0 } }), 1 / 60, CANVAS_W, CANVAS_H);
    expect(notDragging.focusX).toBe(32);
  });

  it('pans at a rate independent of frame rate', () => {
    const fast = make();
    run(fast, fakeInput({ keys: ['KeyD'] }), 0.5, 1 / 144);
    const slow = make();
    run(slow, fakeInput({ keys: ['KeyD'] }), 0.5, 1 / 30);
    expect(fast.focusX).toBeGreaterThan(32);
    expect(fast.focusX).toBeLessThan(BOUNDS.maxX); // not clamped, so this measures rate
    expect(fast.focusX).toBeCloseTo(slow.focusX, 1);
  });

  it('moveTo clamps to the map bounds', () => {
    const cam = make();
    cam.moveTo(-100, 500);
    expect(cam.focusX).toBe(BOUNDS.minX);
    expect(cam.focusZ).toBe(BOUNDS.maxZ);
  });
});
