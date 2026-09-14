/**
 * Uploading the local player's fog to the GPU.
 *
 * One RG8 texture the size of the map: red is current visibility, green is
 * explored. The terrain shader samples it through the map-wide UV2 channel the
 * mesh has carried since M6, so no extra geometry is needed and the fog
 * follows ramps and cliffs for free.
 *
 * LINEAR filtering does most of the softening: at one texel per cell, bilinear
 * interpolation across cell boundaries is already a gradient, and the shader
 * only has to avoid making it crisp again.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';

import type { FogGrids } from '../sim/fog.ts';

/** Brightness of ground that has been explored but is not currently visible. */
export const EXPLORED_DIM = 0.45;

export interface FogTexture {
  readonly texture: RawTexture;
  /** Copy a player's grids into the texture. */
  update(fog: FogGrids, player: number): void;
  /** Milliseconds the last upload took, for the dev overlay. */
  lastUploadMs(): number;
  dispose(): void;
}

export function createFogTexture(scene: Scene, width: number, height: number): FogTexture {
  const cells = width * height;
  // Two bytes per cell, interleaved: the GPU wants them together, and building
  // the interleaved buffer is a single pass over two contiguous arrays.
  const data = new Uint8Array(cells * 2);

  const texture = new RawTexture(
    data,
    width,
    height,
    Engine.TEXTUREFORMAT_RG,
    scene,
    false, // no mipmaps: the fog is sampled at roughly one texel per cell
    false,
    Texture.LINEAR_LINEAR,
    Engine.TEXTURETYPE_UNSIGNED_BYTE,
  );
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.name = 'fog';

  let uploadMs = 0;

  return {
    texture,
    lastUploadMs: () => uploadMs,

    update(fog, player) {
      const started = performance.now();
      const visible = fog.visible[player];
      const explored = fog.explored[player];
      if (!visible || !explored) return;

      for (let i = 0, o = 0; i < cells; i++, o += 2) {
        data[o] = visible[i] as number;
        data[o + 1] = explored[i] as number;
      }
      texture.update(data);
      uploadMs = performance.now() - started;
    },

    dispose() {
      texture.dispose();
    },
  };
}
