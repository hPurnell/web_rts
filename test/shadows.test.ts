/**
 * Sun shadows: who casts, and how the shadow map is fitted to the view.
 *
 * The shading itself needs a GPU; what can go wrong without one is the
 * bookkeeping — a mesh that never reaches the caster list, or one that stays
 * in it after it is disposed — and the fit, which decides whether a tank's
 * shadow gets twenty texels or two.
 */
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { castShadow, createShadows, receiveShadow } from '../src/render/shadows.ts';
import { createTerrainMaterial } from '../src/render/terrainMaterial.ts';

function setup() {
  const scene = new Scene(new NullEngine());
  const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.3).normalize(), scene);
  const terrain = createTerrainMaterial(scene, {
    heightRange: 10,
    cliffSlope: 1,
    lightDirection: sun.direction,
  });
  const shadows = createShadows(sun, terrain);
  shadows.setMapSize(256, 256);
  // An RTS view: high over the middle of the map, pitched down.
  const camera = new FreeCamera('camera', new Vector3(128, 40, 100), scene);
  camera.setTarget(new Vector3(128, 0, 128));
  scene.activeCamera = camera;
  camera.computeWorldMatrix();
  return { scene, sun, shadows, camera };
}

function renderList(sun: DirectionalLight) {
  return sun.getShadowGenerator()?.getShadowMap()?.renderList ?? [];
}

describe('sun shadows', () => {
  it('adds casters made before and after shadows are turned on', () => {
    const { scene, sun, shadows } = setup();
    const before = MeshBuilder.CreateBox('before', {}, scene);
    castShadow(before);
    shadows.setEnabled(true);
    const after = MeshBuilder.CreateBox('after', {}, scene);
    castShadow(after);

    expect(renderList(sun)).toContain(before);
    expect(renderList(sun)).toContain(after);
    expect(before.receiveShadows).toBe(true);
    shadows.dispose();
  });

  it('forgets a caster once it is disposed', () => {
    const { scene, sun, shadows } = setup();
    shadows.setEnabled(true);
    const mesh = MeshBuilder.CreateBox('gone', {}, scene);
    castShadow(mesh);
    mesh.dispose();
    expect(renderList(sun)).not.toContain(mesh);

    // Nor does it come back when shadows are turned off and on again.
    shadows.setEnabled(false);
    shadows.setEnabled(true);
    expect(renderList(sun)).not.toContain(mesh);
    shadows.dispose();
  });

  it('lets a road receive without casting', () => {
    const { scene, sun, shadows } = setup();
    shadows.setEnabled(true);
    const road = MeshBuilder.CreateGround('road', { width: 4, height: 20 }, scene);
    receiveShadow(road);
    expect(road.receiveShadows).toBe(true);
    expect(renderList(sun)).not.toContain(road);
    shadows.dispose();
  });

  it('turns the light off with the shadows', () => {
    const { sun, shadows } = setup();
    shadows.setEnabled(true);
    expect(sun.getShadowGenerator()).toBeTruthy();
    shadows.setEnabled(false);
    expect(sun.getShadowGenerator()).toBeFalsy();
    expect(sun.shadowEnabled).toBe(false);
  });

  it('fits a square to the view, snapped to its own texels', () => {
    const { sun, shadows, camera } = setup();
    shadows.setEnabled(true);
    shadows.update(camera, 0);

    const width = sun.orthoRight - sun.orthoLeft;
    const height = sun.orthoTop - sun.orthoBottom;
    expect(width).toBeCloseTo(height, 9);
    // Tight to a close view, not the whole 256-cell map.
    expect(width).toBeLessThan(200);
    expect(width).toBeGreaterThan(20);
    const texel = width / 2048;
    const centre = (sun.orthoLeft + sun.orthoRight) / 2 / texel;
    expect(Math.abs(centre - Math.round(centre))).toBeLessThan(1e-6);
    shadows.dispose();
  });

  it('does not move the fit for a pan smaller than a texel', () => {
    const { sun, shadows, camera } = setup();
    shadows.setEnabled(true);
    shadows.update(camera, 0);
    const left = sun.orthoLeft;
    camera.position.x += 0.001;
    camera.computeWorldMatrix();
    shadows.update(camera, 0);
    expect(sun.orthoLeft).toBe(left);
    shadows.dispose();
  });
});
