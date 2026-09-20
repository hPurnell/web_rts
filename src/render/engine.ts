/**
 * Babylon bootstrap. Everything Babylon-specific lives under src/render/, so
 * swapping renderers touches nothing outside this directory (see PLAN.md).
 */
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';

export interface Renderer {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly canvas: HTMLCanvasElement;
  readonly sun: DirectionalLight;
  /** Fill light, which an imported map's ambient colour replaces. */
  readonly sky: HemisphericLight;
  /** Seconds since the previous frame, clamped against tab-switch spikes. */
  frameDelta(): number;
  dispose(): void;
}

const MAX_FRAME_DELTA = 0.1;

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: false,
    stencil: false,
    antialias: true,
    powerPreference: 'high-performance',
  });
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.06, 0.08, 1);
  // Nothing in an RTS view needs picking against every mesh: cell picking is
  // analytic (M7), and selection projects positions on the CPU (M17).
  scene.skipPointerMovePicking = true;
  scene.autoClear = true;

  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, 0.6).normalize(), scene);
  sun.intensity = 2.1;
  sun.diffuse = new Color3(1, 0.97, 0.9);

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene);
  sky.intensity = 0.55;
  sky.diffuse = new Color3(0.62, 0.71, 0.85);
  sky.groundColor = new Color3(0.16, 0.18, 0.22);

  const onResize = (): void => engine.resize();
  window.addEventListener('resize', onResize);

  return {
    engine,
    scene,
    canvas,
    sky,
    sun,
    frameDelta: () => Math.min(engine.getDeltaTime() / 1000, MAX_FRAME_DELTA),
    dispose: () => {
      window.removeEventListener('resize', onResize);
      scene.dispose();
      engine.dispose();
    },
  };
}
