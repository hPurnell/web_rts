/**
 * Sun shadows for units and scenery.
 *
 * One shadow map from the sun, fitted each frame to the ground the camera can
 * see. Fitting it to the whole map instead — which is what Babylon does when
 * left to itself, since the scenery's thin instances cover the whole map —
 * spreads 2048 texels over four hundred cells, five to a cell, and a tank's
 * shadow comes out as a smudge.
 *
 * Renderers opt their meshes in with `castShadow` and `receiveShadow`, as they
 * opt materials into fog, so none of them needs to know whether shadows are
 * on. Everything that casts also receives: a tree's shadow falls across the
 * house next to it. The terrain is the one receiver that is not a Babylon
 * material, so `terrainMaterial.ts` samples the map itself, and this module
 * hands it the texture and the matrix.
 *
 * The terrain does not cast. A Generals map is lit by its own baked terrain
 * lighting, which already shades the far side of a hill; a shadow map across
 * the whole relief would double that, and self-shadowing ground is where
 * shadow acne lives.
 */
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Constants } from '@babylonjs/core/Engines/constants';
import { SHADOW_DARKNESS, setShaderShadow } from './terrainMaterial.ts';

/** Texels across the shadow map. */
const MAP_SIZE = 2048;
/** How far the light's eye sits back from the map, and so its depth range. */
const LIGHT_DISTANCE = 1500;
/**
 * The widest ground the map is stretched over, in cells. Zoomed right out the
 * view covers most of a map; past this the shadows stop at the edge of it
 * rather than going soft everywhere.
 */
const MAX_EXTENT = 260;
/** Extra ground around the view, so a shadow cast from just off-screen lands. */
const MARGIN = 6;

const casters = new Set<AbstractMesh>();
const receivers = new Set<AbstractMesh>();
/** Hand-written shaders that sample the map themselves, via `SHADOW_GLSL`. */
const shaderReceivers = new Set<ShaderMaterial>();
let active: ShadowGenerator | null = null;

/** Mark a mesh as casting (and receiving) sun shadows. */
export function castShadow(mesh: AbstractMesh): void {
  casters.add(mesh);
  mesh.receiveShadows = true;
  active?.addShadowCaster(mesh, false);
  mesh.onDisposeObservable.addOnce(() => {
    casters.delete(mesh);
    active?.removeShadowCaster(mesh, false);
  });
}

/** Mark a mesh as receiving sun shadows without casting any: roads. */
export function receiveShadow(mesh: AbstractMesh): void {
  receivers.add(mesh);
  mesh.receiveShadows = true;
  mesh.onDisposeObservable.addOnce(() => receivers.delete(mesh));
}

/**
 * Let a hand-written shader receive shadows: one that includes `SHADOW_GLSL`
 * and has `shadowMatrix`, `shadowInfo` and `shadowSampler` among its uniforms.
 */
export function receiveShadowShader(material: ShaderMaterial): void {
  shaderReceivers.add(material);
  setShaderShadow(material, null, Matrix.Identity(), 0);
  material.onDisposeObservable.addOnce(() => shaderReceivers.delete(material));
}

export interface Shadows {
  setEnabled(enabled: boolean): void;
  enabled(): boolean;
  /** Fit the shadow map to what the camera sees. Call once a frame. */
  update(camera: Camera, groundY: number): void;
  /** Map size in cells, which fixes where the light's eye sits. */
  setMapSize(width: number, height: number): void;
  dispose(): void;
}

export function createShadows(sun: DirectionalLight, terrain: ShaderMaterial): Shadows {
  receiveShadowShader(terrain);
  let mapWidth = 1;
  let mapHeight = 1;

  // The light's eye is fixed relative to the map rather than following the
  // camera, so the grid the shadow map is snapped to is fixed too, and a
  // shadow does not crawl as the view pans.
  const eye = new Vector3();
  const view = new Matrix();
  const corner = new Vector3();
  const inLight = new Vector3();

  const place = (): void => {
    const dir = sun.direction.clone().normalize();
    eye.set(mapWidth / 2, 0, mapHeight / 2).subtractInPlace(dir.scale(LIGHT_DISTANCE));
    sun.position.copyFrom(eye);
    // Exactly the view matrix ShadowGenerator builds from the same two
    // vectors, so extents measured in it are the ones it projects with.
    Matrix.LookAtLHToRef(eye, eye.add(dir), Vector3.Up(), view);
  };

  const enable = (): void => {
    if (active) return;
    const generator = new ShadowGenerator(MAP_SIZE, sun, true);
    // Poisson for the standard materials; the terrain filters for itself.
    generator.usePoissonSampling = true;
    generator.bias = 0.0004;
    generator.normalBias = 0.02;
    generator.darkness = SHADOW_DARKNESS;
    generator.transparencyShadow = false;
    for (const mesh of casters) generator.addShadowCaster(mesh, false);
    for (const mesh of [...casters, ...receivers]) mesh.receiveShadows = true;

    sun.autoUpdateExtends = false;
    sun.autoCalcShadowZBounds = false;
    sun.shadowOrthoScale = 0;
    sun.shadowMinZ = 0;
    sun.shadowMaxZ = LIGHT_DISTANCE * 2;
    sun.shadowEnabled = true;
    active = generator;
  };

  const disable = (): void => {
    if (!active) return;
    active.dispose();
    active = null;
    sun.shadowEnabled = false;
    for (const material of shaderReceivers) setShaderShadow(material, null, Matrix.Identity(), 0);
  };

  return {
    enabled: () => active !== null,

    setEnabled(enabled) {
      if (enabled) enable();
      else disable();
    },

    setMapSize(width, height) {
      mapWidth = width;
      mapHeight = height;
    },

    update(camera, groundY) {
      if (!active) return;
      place();

      // The ground the camera sees: its four corner rays met with the ground
      // at the focus height, then boxed in the light's own space. A ray that
      // misses the ground (a view reaching the horizon) is capped.
      // Built rather than read from the camera's cache, which is only filled
      // in by a render and so lags a frame behind a camera that just moved.
      const inverse = camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true)).invert();
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const near = Vector3.TransformCoordinates(new Vector3(sx, sy, -1), inverse);
        const far = Vector3.TransformCoordinates(new Vector3(sx, sy, 1), inverse);
        const ray = far.subtract(near);
        let t = ray.y < -1e-6 ? (groundY - near.y) / ray.y : Infinity;
        t = Math.min(Math.max(t, 0), MAX_EXTENT / Math.max(1e-6, ray.length()));
        corner.copyFrom(near).addInPlace(ray.scale(t));
        // Taller things stand in the view too; the margin covers them.
        Vector3.TransformCoordinatesToRef(corner, view, inLight);
        minX = Math.min(minX, inLight.x);
        maxX = Math.max(maxX, inLight.x);
        minY = Math.min(minY, inLight.y);
        maxY = Math.max(maxY, inLight.y);
      }

      // Before the camera has a projection there is nothing to fit to.
      if (!Number.isFinite(minX + maxX + minY + maxY)) return;

      // A square of fixed-step size, snapped to its own texels, so neither a
      // pan nor a slight zoom shifts which texel a shadow edge falls in.
      const extent = Math.min(
        MAX_EXTENT,
        Math.ceil((Math.max(maxX - minX, maxY - minY) + 2 * MARGIN) / 16) * 16,
      );
      const texel = extent / MAP_SIZE;
      const cx = Math.round((minX + maxX) / 2 / texel) * texel;
      const cy = Math.round((minY + maxY) / 2 / texel) * texel;
      if (sun.orthoLeft !== cx - extent / 2 || sun.orthoBottom !== cy - extent / 2 ||
          sun.orthoRight !== cx + extent / 2) {
        sun.orthoLeft = cx - extent / 2;
        sun.orthoRight = cx + extent / 2;
        sun.orthoBottom = cy - extent / 2;
        sun.orthoTop = cy + extent / 2;
        // The setters only store; without this the projection keeps its old
        // extents until the light itself moves.
        sun.forceProjectionMatrixCompute();
      }

      const shadowMap = active.getShadowMap();
      const packed = shadowMap?.textureType === Constants.TEXTURETYPE_UNSIGNED_BYTE;
      const matrix = active.getTransformMatrix();
      for (const material of shaderReceivers) setShaderShadow(material, shadowMap, matrix, packed ? 2 : 1);
    },

    dispose() {
      disable();
    },
  };
}
