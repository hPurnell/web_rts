/**
 * Application shell: owns the renderer, the camera and the frame loop, and
 * wires the simulation's world state into both.
 */
import type { Scene } from '@babylonjs/core/scene';

import { createTestMap } from './sim/fixtures/testmap.ts';
import { toFloat } from './sim/fixed.ts';
import type { World } from './sim/world.ts';
import { MAX_TIER } from './sim/world.ts';
import { createRenderer } from './render/engine.ts';
import { RtsCamera } from './render/camera.ts';
import { attachInput } from './render/input.ts';
import { TIER_HEIGHT, createTerrain, solveRamps } from './render/terrain.ts';
import { describeFlags, pickCell, screenRay } from './render/pick.ts';
import { createTerrainMaterial } from './render/terrainMaterial.ts';
import { createDevOverlay } from './ui/devoverlay.ts';
import { MODE_KEY, createModeController, modeFromLocation } from './mode.ts';

/** Dev-only keybind for Babylon's Inspector. */
const INSPECTOR_KEY = 'F9';

export interface App {
  readonly world: World;
  readonly mode: ReturnType<typeof createModeController>;
  dispose(): void;
}

export function startApp(canvas: HTMLCanvasElement, overlayRoot: HTMLElement): App {
  const world = createTestMap();
  const renderer = createRenderer(canvas);
  const input = attachInput(canvas);
  const overlay = createDevOverlay(overlayRoot);

  const cellSize = toFloat(world.cellSize);
  const widthUnits = world.width * cellSize;
  const depthUnits = world.height * cellSize;

  const camera = new RtsCamera(renderer.scene, {
    pitchDegrees: 55,
    bounds: { minX: 0, maxX: widthUnits, minZ: 0, maxZ: depthUnits },
  });

  const terrainMaterial = createTerrainMaterial(renderer.scene, {
    tierHeight: TIER_HEIGHT,
    maxTier: MAX_TIER,
    lightDirection: renderer.sun.direction,
  });
  const terrain = createTerrain(renderer.scene, world, terrainMaterial);
  const ramps = solveRamps(world);

  let smoothedFps = 60;
  renderer.engine.runRenderLoop(() => {
    const dt = renderer.frameDelta();
    camera.update(input, dt, renderer.engine.getRenderWidth(), renderer.engine.getRenderHeight());

    // getFps() is NaN on the very first frames; without this guard the
    // exponential average is poisoned permanently.
    const fps = renderer.engine.getFps();
    if (Number.isFinite(fps)) smoothedFps += (fps - smoothedFps) * 0.1;
    overlay.set('fps', smoothedFps.toFixed(0));
    overlay.set('frame', `${(dt * 1000).toFixed(1)} ms`);
    overlay.set('camera', `${camera.focusX.toFixed(1)}, ${camera.focusZ.toFixed(1)}`);
    overlay.set('height', camera.currentHeight.toFixed(1));
    overlay.set('draws', String(renderer.scene.getActiveMeshes().length));

    if (input.pointer.inside) {
      const ray = screenRay(renderer.scene, camera.camera, input.pointer.x, input.pointer.y);
      const hit = pickCell(world, ramps, ray);
      overlay.set('cell', hit ? `${hit.cell} (${hit.cx},${hit.cy})` : '-');
      overlay.set('tier', hit ? String(hit.tier) : '-');
      overlay.set('flags', hit ? describeFlags(hit.flags) : '-');
    } else {
      overlay.set('cell', '-');
      overlay.set('tier', '-');
      overlay.set('flags', '-');
    }

    renderer.scene.render();
  });

  const mode = createModeController({
    world,
    overlay: overlayRoot,
    onChange: (next) => overlay.set('mode', next),
  });
  overlay.set('mode', 'game');
  if (modeFromLocation(window.location.search) === 'editor') void mode.set('editor');

  const onKey = (e: KeyboardEvent): void => {
    if (e.code === INSPECTOR_KEY) {
      e.preventDefault();
      void toggleInspector(renderer.scene);
    } else if (e.code === MODE_KEY) {
      e.preventDefault();
      void mode.toggle();
    }
  };
  window.addEventListener('keydown', onKey);

  return {
    world,
    mode,
    dispose() {
      window.removeEventListener('keydown', onKey);
      mode.dispose();
      renderer.engine.stopRenderLoop();
      overlay.dispose();
      terrain.dispose();
      terrainMaterial.dispose();
      input.dispose();
      renderer.dispose();
    },
  };
}

/**
 * The Inspector is a development tool and a large one. `import.meta.env.DEV`
 * is replaced with `false` in a production build, so Rollup removes this whole
 * branch and never pulls the package into the bundle.
 */
async function toggleInspector(scene: Scene): Promise<void> {
  if (!import.meta.env.DEV) return;
  await import('@babylonjs/core/Debug/debugLayer');
  await import('@babylonjs/inspector');
  if (scene.debugLayer.isVisible()) scene.debugLayer.hide();
  else await scene.debugLayer.show({ embedMode: true, overlay: true });
}
