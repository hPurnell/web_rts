/**
 * The RTS camera: fixed pitch, pans over the map, zooms by changing height.
 *
 * Orientation convention for everything downstream: the camera sits south of
 * its focus and looks along +Z, so world +Z (increasing cell row) goes *up* the
 * screen and world +X goes right. The minimap in M27 therefore flips V when it
 * draws the grid.
 *
 * The camera is defined by a focus point on the ground plane plus a height.
 * Everything else is derived, which is what keeps zoom from fighting pan — the
 * ground point under the screen centre does not move when you zoom.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import type { Scene } from '@babylonjs/core/scene';
import type { InputState } from './input.ts';
import { MOUSE_MIDDLE } from './input.ts';

export interface CameraBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface CameraOptions {
  /** Downward pitch in degrees. 55 is the SC2-ish default. */
  readonly pitchDegrees?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly startHeight?: number;
  readonly bounds: CameraBounds;
}

/** Edge-pan activates within this many CSS pixels of a canvas edge. */
export const EDGE_PAN_MARGIN = 8;
/** Ground units panned per second at a height of one unit. */
const PAN_SPEED_PER_HEIGHT = 1.15;
/** Fraction of the remaining zoom distance covered per second. */
const ZOOM_SMOOTHING = 12;
const WHEEL_TO_ZOOM = 0.0016;

const KEYS_LEFT = ['KeyA', 'ArrowLeft'];
const KEYS_RIGHT = ['KeyD', 'ArrowRight'];
const KEYS_UP = ['KeyW', 'ArrowUp'];
const KEYS_DOWN = ['KeyS', 'ArrowDown'];

export class RtsCamera {
  readonly camera: FreeCamera;
  /** Mutable: loading a different map changes the extent the camera may cover. */
  bounds: CameraBounds;

  /** Ground point the camera looks at. */
  focusX: number;
  focusZ: number;

  private readonly pitch: number;
  /** Multiplier on pan speed, driven by the `cam_speed` cvar. */
  panScale = 1;
  private readonly minHeight: number;
  private readonly maxHeight: number;
  private height: number;
  private targetHeight: number;
  /** Horizontal distance from camera to focus, per unit of height. */
  private readonly backPerHeight: number;

  constructor(scene: Scene, options: CameraOptions) {
    this.bounds = options.bounds;
    this.pitch = ((options.pitchDegrees ?? 55) * Math.PI) / 180;
    this.minHeight = options.minHeight ?? 12;
    this.maxHeight = options.maxHeight ?? 90;
    this.height = clamp(options.startHeight ?? 38, this.minHeight, this.maxHeight);
    this.targetHeight = this.height;
    this.backPerHeight = 1 / Math.tan(this.pitch);

    this.focusX = (this.bounds.minX + this.bounds.maxX) / 2;
    this.focusZ = (this.bounds.minZ + this.bounds.maxZ) / 2;

    this.camera = new FreeCamera('rts', new Vector3(0, this.height, 0), scene);
    this.camera.minZ = 1;
    this.camera.maxZ = 600;
    this.camera.fov = 0.8;
    // No attachControl: this class owns all camera input.
    scene.activeCamera = this.camera;
    this.apply();
  }

  /** Current camera height above the ground plane. */
  get currentHeight(): number {
    return this.height;
  }

  /** Zoom as 0 (closest) to 1 (furthest), for HUD and LOD decisions. */
  get zoomFraction(): number {
    return (this.height - this.minHeight) / (this.maxHeight - this.minHeight);
  }

  /** Re-bound the camera, e.g. after loading a map of a different size. */
  setBounds(bounds: CameraBounds, recentre = false): void {
    this.bounds = bounds;
    if (recentre) {
      this.focusX = (bounds.minX + bounds.maxX) / 2;
      this.focusZ = (bounds.minZ + bounds.maxZ) / 2;
    }
    this.clampFocus();
    this.apply();
  }

  /** Jump straight to a ground position, e.g. from a minimap click. */
  moveTo(x: number, z: number): void {
    this.focusX = x;
    this.focusZ = z;
    this.clampFocus();
    this.apply();
  }

  update(input: InputState, dt: number, canvasWidth: number, canvasHeight: number): void {
    const wheel = input.takeWheel();
    if (wheel !== 0) {
      // Multiplicative zoom: each notch changes height by a fixed ratio, so
      // zooming feels the same close in and far out.
      this.targetHeight = clamp(
        this.targetHeight * Math.exp(wheel * WHEEL_TO_ZOOM),
        this.minHeight,
        this.maxHeight,
      );
    }
    const zoomBlend = 1 - Math.exp(-ZOOM_SMOOTHING * dt);
    this.height += (this.targetHeight - this.height) * zoomBlend;

    let dx = 0;
    let dz = 0;

    for (const key of input.keys) {
      if (KEYS_LEFT.includes(key)) dx -= 1;
      else if (KEYS_RIGHT.includes(key)) dx += 1;
      else if (KEYS_UP.includes(key)) dz += 1;
      else if (KEYS_DOWN.includes(key)) dz -= 1;
    }

    if (input.focused && input.pointer.inside) {
      const { x, y } = input.pointer;
      if (x < EDGE_PAN_MARGIN) dx -= 1;
      else if (x > canvasWidth - EDGE_PAN_MARGIN) dx += 1;
      if (y < EDGE_PAN_MARGIN) dz += 1;
      else if (y > canvasHeight - EDGE_PAN_MARGIN) dz -= 1;
    }

    // Normalise so diagonal panning is not faster than axis-aligned panning.
    const magnitude = Math.hypot(dx, dz);
    if (magnitude > 0) {
      const speed = (PAN_SPEED_PER_HEIGHT * this.panScale * this.height * dt) / magnitude;
      this.focusX += dx * speed;
      this.focusZ += dz * speed;
    }

    const drag = input.takeDrag();
    if ((input.pointer.buttons & MOUSE_MIDDLE) !== 0 && (drag.dx !== 0 || drag.dy !== 0)) {
      // Middle-drag moves the world with the cursor, so the drag is inverted
      // and scaled to approximate ground units per pixel at this height.
      const unitsPerPixel = (2 * this.height * Math.tan(this.camera.fov / 2)) / canvasHeight;
      this.focusX -= drag.dx * unitsPerPixel;
      this.focusZ += drag.dy * unitsPerPixel / Math.sin(this.pitch);
    }

    this.clampFocus();
    this.apply();
  }

  private clampFocus(): void {
    this.focusX = clamp(this.focusX, this.bounds.minX, this.bounds.maxX);
    this.focusZ = clamp(this.focusZ, this.bounds.minZ, this.bounds.maxZ);
  }

  private apply(): void {
    const back = this.height * this.backPerHeight;
    this.camera.position.set(this.focusX, this.height, this.focusZ - back);
    this.camera.setTarget(new Vector3(this.focusX, 0, this.focusZ));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
