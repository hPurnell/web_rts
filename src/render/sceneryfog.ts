/**
 * Fog of war on everything that is not terrain but belongs to the map:
 * scenery, civilian buildings, roads.
 *
 * The terrain shader has always darkened the ground by the fog texture, but
 * the scenery on it uses Babylon's own `StandardMaterial` and was drawn at full
 * brightness everywhere — a lit town standing on black, unexplored ground,
 * which gives away the map and reads as a rendering bug.
 *
 * This is a material plugin rather than a second shader: it injects the same
 * lookup into the standard material's shaders, keyed on the fragment's world
 * position instead of a UV channel, so it works for thin-instanced models and
 * road ribbons alike, and a large building straddling the fog edge is
 * darkened across its width rather than all at once. The five taps and the
 * brightness rule match `terrainMaterial.ts` exactly, so scenery and the
 * ground under it are always the same shade.
 *
 * Units do not use this. They are hidden outright when not visible, because
 * where an enemy stands is information and a dimmed tank is still a tank.
 * Scenery cannot move, so drawing what was explored is honest.
 */
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { Material } from '@babylonjs/core/Materials/material';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';

/** What every fogged material reads when it is drawn. */
interface FogState {
  texture: BaseTexture | null;
  width: number;
  height: number;
  exploredDim: number;
  softness: number;
}

const state: FogState = { texture: null, width: 1, height: 1, exploredDim: 1, softness: 0.9 };
const plugins = new Set<SceneryFogPlugin>();
const fogged = new WeakSet<Material>();

class SceneryFogPlugin extends MaterialPluginBase {
  private enabled = false;

  constructor(material: Material) {
    super(material, 'SceneryFog', 150, { SCENERYFOG: false });
    this.setEnabled(state.texture !== null);
  }

  /**
   * Recompiles the material's shaders, so only called when fog toggles.
   *
   * Activating a plugin does not dirty the material's defines by itself. A
   * material that has already compiled — every one of them, since the map is
   * drawn before a match starts — keeps its old shader, and the fog silently
   * never appears.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this._enable(enabled);
    this.markAllDefinesAsDirty();
  }

  override getClassName(): string {
    return 'SceneryFogPlugin';
  }

  override prepareDefines(defines: Record<string, unknown>): void {
    defines['SCENERYFOG'] = this.enabled && state.texture !== null;
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('sceneryFogSampler');
  }

  override getUniforms(): {
    ubo: { name: string; size: number; type: string }[];
    vertex: string;
    fragment: string;
  } {
    const declarations = `
      #ifdef SCENERYFOG
        uniform vec4 sceneryFogMap;
        uniform vec4 sceneryFogTaps;
      #endif
    `;
    return {
      ubo: [
        { name: 'sceneryFogMap', size: 4, type: 'vec4' },
        { name: 'sceneryFogTaps', size: 4, type: 'vec4' },
      ],
      vertex: declarations,
      fragment: declarations,
    };
  }

  override bindForSubMesh(buffer: UniformBuffer): void {
    if (!this.enabled || !state.texture) return;
    buffer.updateFloat4('sceneryFogMap', 1 / state.width, 1 / state.height, state.exploredDim, 0);
    buffer.updateFloat4(
      'sceneryFogTaps',
      state.softness / state.width,
      state.softness / state.height,
      0,
      0,
    );
    buffer.setTexture('sceneryFogSampler', state.texture);
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
          #ifdef SCENERYFOG
            varying vec2 vSceneryFogUv;
          #endif
        `,
        // The terrain's map UV is world x and z over the map's size in cells.
        CUSTOM_VERTEX_MAIN_END: `
          #ifdef SCENERYFOG
            vSceneryFogUv = worldPos.xz * sceneryFogMap.xy;
          #endif
        `,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
        #ifdef SCENERYFOG
          varying vec2 vSceneryFogUv;
          uniform sampler2D sceneryFogSampler;
        #endif
      `,
      // After lighting, so an additive light that is out of sight goes dark
      // with everything else rather than glowing through the fog.
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
        #ifdef SCENERYFOG
          vec2 fogTap = sceneryFogTaps.xy;
          vec2 fogSample = texture2D(sceneryFogSampler, vSceneryFogUv).rg * 2.0;
          fogSample += texture2D(sceneryFogSampler, vSceneryFogUv + fogTap).rg;
          fogSample += texture2D(sceneryFogSampler, vSceneryFogUv - fogTap).rg;
          fogSample += texture2D(sceneryFogSampler, vSceneryFogUv + vec2(fogTap.x, -fogTap.y)).rg;
          fogSample += texture2D(sceneryFogSampler, vSceneryFogUv + vec2(-fogTap.x, fogTap.y)).rg;
          fogSample /= 6.0;
          color.rgb *= max(fogSample.r, fogSample.g * sceneryFogMap.z);
        #endif
      `,
    };
  }
}

/**
 * Put a material under the fog. Idempotent, so every mesh of a renderer can be
 * passed through without tracking which share a material.
 */
export function fogMaterial(material: Material | null | undefined): void {
  if (!material || fogged.has(material)) return;
  fogged.add(material);
  const plugin = new SceneryFogPlugin(material);
  plugins.add(plugin);
  material.onDisposeObservable.addOnce(() => plugins.delete(plugin));
}

/**
 * Point every fogged material at a fog texture, or pass null to draw them
 * unfogged — the editor, a replay with fog off, `r_fog 0`.
 */
export function setSceneryFog(
  texture: BaseTexture | null,
  width: number,
  height: number,
  exploredDim: number,
): void {
  state.texture = texture;
  state.width = Math.max(1, width);
  state.height = Math.max(1, height);
  state.exploredDim = exploredDim;
  for (const plugin of plugins) plugin.setEnabled(texture !== null);
}

/** The fog edge's blur radius, in texels; kept equal to the terrain's. */
export function setSceneryFogSoftness(texels: number): void {
  state.softness = texels;
}
