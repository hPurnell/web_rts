/**
 * Terrain material. Placeholder colours for now — M29 swaps in real textures —
 * but the shader already carries the two things later milestones need: tier
 * shading so cliffs read at a glance, and the map-wide UV2 channel the fog
 * texture will sample in M23.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector2, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Effect } from '@babylonjs/core/Materials/effect';
import type { Scene } from '@babylonjs/core/scene';

const VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec2 uv2;

uniform mat4 worldViewProjection;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
varying vec2 vMapUv;

void main(void) {
  vNormal = normal;
  vPosition = position;
  vUv = uv;
  vMapUv = uv2;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAGMENT = `
precision highp float;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
varying vec2 vMapUv;

uniform vec3 lightDirection;
uniform vec3 groundLow;
uniform vec3 groundHigh;
uniform vec3 cliffColor;
uniform float heightRange;
uniform float cliffSlope;
uniform sampler2D fogSampler;
uniform vec2 fogTexel;
uniform float fogEnabled;
uniform float exploredDim;
uniform float fogSoftness;

/** Cheap value noise, enough to break up flat colour until real textures land. */
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

void main(void) {
  vec3 n = normalize(vNormal);
  float up = clamp(n.y, 0.0, 1.0);

  // Height tint: higher ground reads lighter. With tiers this produced five
  // flat bands and the terraces read themselves; over a heightfield it is a
  // smooth gradient, and on its own it would be mush.
  float elevation = clamp(vPosition.y / max(heightRange, 0.0001), 0.0, 1.0);
  vec3 flat_ = mix(groundLow, groundHigh, elevation);

  // Slope does the work the tier step used to. The normal's y component is
  // the cosine of the surface angle, so rise over run is sin/cos -- the same
  // quantity the simulation calls slope. Shading against the simulation's own
  // traversable limit puts the colour change exactly where the ground stops
  // being walkable, rather than somewhere near it.
  float rise = sqrt(max(0.0, 1.0 - up * up));
  float slope = rise / max(up, 0.0001);
  float cliffness = smoothstep(cliffSlope * 0.5, cliffSlope, slope);
  vec3 base = mix(flat_, cliffColor, cliffness);

  float grain = noise(vUv * 3.0) * 0.12 + noise(vUv * 11.0) * 0.06;
  base *= 0.92 + grain;

  float lambert = clamp(dot(n, -normalize(lightDirection)), 0.0, 1.0);
  float ambient = 0.42 + 0.18 * up;
  vec3 color = base * (ambient + lambert * 0.85);

  // Steep ground is darkened a little beyond what the lambert term gives it,
  // so a slope reads as a slope even when the sun is behind the camera.
  color *= mix(1.0, 0.84, cliffness);

  if (fogEnabled > 0.5) {
    // Five taps: the centre, and four on the diagonals.
    //
    // The old kernel was a five-tap cross, which samples along the axes and so
    // reinforces exactly the horizontal and vertical edges the cell grid is
    // made of — the boundary came out as a staircase. Diagonal taps do the
    // opposite, and each one is a bilinear fetch already averaging a 2x2
    // neighbourhood, so four of them cover a rounded 3x3 area for the same
    // cost the cross paid to cover a plus.
    //
    // Worth knowing what this cannot do: the simulation's visibility is per
    // cell and binary, so there is no sub-cell detail to recover. This makes
    // the transition smooth and wide; it does not add information.
    vec2 o = fogTexel * fogSoftness;
    vec2 fog = texture2D(fogSampler, vMapUv).rg * 2.0;
    fog += texture2D(fogSampler, vMapUv + o).rg;
    fog += texture2D(fogSampler, vMapUv - o).rg;
    fog += texture2D(fogSampler, vMapUv + vec2(o.x, -o.y)).rg;
    fog += texture2D(fogSampler, vMapUv + vec2(-o.x, o.y)).rg;
    fog /= 6.0;

    // Visible is full brightness, explored-only is dimmed, unexplored is black.
    float brightness = max(fog.r, fog.g * exploredDim);
    color *= brightness;
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface TerrainMaterialOptions {
  /** World-space height the ground tint reaches full brightness at. */
  readonly heightRange: number;
  /** Traversable slope limit as rise over run, matching the simulation's. */
  readonly cliffSlope: number;
  readonly lightDirection: { x: number; y: number; z: number };
}

/** Point the terrain shader at a fog texture, or pass null to disable fog. */
/**
 * How far the fog blur reaches, in texels (one texel is one cell).
 *
 * Under about 0.5 the cell lattice starts showing through again; much over 1
 * and unit vision starts bleeding through thin walls, because the blur does
 * not know what a wall is.
 */
export const DEFAULT_FOG_SOFTNESS = 0.9;

/**
 * Recolour the ground and cliffs.
 *
 * A content pack's map can carry the palette of the terrain textures it was
 * built from, which is most of what makes an imported map recognisable before
 * real terrain texturing lands.
 */
export function setTerrainPalette(
  material: ShaderMaterial,
  ground: readonly number[],
  cliff: readonly number[],
): void {
  const [r = 0.21, g = 0.29, b = 0.2] = ground;
  // The high tint is the same hue lifted, so height still reads as height.
  material.setColor3('groundLow', new Color3(r * 0.8, g * 0.8, b * 0.8));
  material.setColor3('groundHigh', new Color3(
    Math.min(1, r * 1.25),
    Math.min(1, g * 1.25),
    Math.min(1, b * 1.25),
  ));
  material.setColor3('cliffColor', new Color3(cliff[0] ?? 0.3, cliff[1] ?? 0.27, cliff[2] ?? 0.24));
}

/** Point the terrain shader at a different sun. */
export function setTerrainSun(
  material: ShaderMaterial,
  direction: { x: number; y: number; z: number },
): void {
  material.setVector3('lightDirection', new Vector3(direction.x, direction.y, direction.z).normalize());
}

/** Set the blur radius the fog is sampled with, in texels. */
export function setTerrainFogSoftness(material: ShaderMaterial, texels: number): void {
  material.setFloat('fogSoftness', texels);
}

export function setTerrainFog(
  material: ShaderMaterial,
  texture: BaseTexture | null,
  width: number,
  height: number,
  exploredDim: number,
): void {
  material.setFloat('fogEnabled', texture ? 1 : 0);
  material.setFloat('exploredDim', exploredDim);
  material.setVector2('fogTexel', new Vector2(1 / Math.max(1, width), 1 / Math.max(1, height)));
  if (texture) material.setTexture('fogSampler', texture);
}

export function createTerrainMaterial(
  scene: Scene,
  options: TerrainMaterialOptions,
): ShaderMaterial {
  Effect.ShadersStore['rtsTerrainVertexShader'] = VERTEX;
  Effect.ShadersStore['rtsTerrainFragmentShader'] = FRAGMENT;

  const material = new ShaderMaterial('terrain', scene, 'rtsTerrain', {
    attributes: ['position', 'normal', 'uv', 'uv2'],
    uniforms: [
      'worldViewProjection',
      'lightDirection',
      'groundLow',
      'groundHigh',
      'cliffColor',
      'heightRange',
      'cliffSlope',
      'fogTexel',
      'fogEnabled',
      'exploredDim',
      'fogSoftness',
    ],
    samplers: ['fogSampler'],
  });

  const light = options.lightDirection;
  material.setVector3('lightDirection', new Vector3(light.x, light.y, light.z).normalize());
  material.setColor3('groundLow', new Color3(0.21, 0.29, 0.2));
  material.setColor3('groundHigh', new Color3(0.38, 0.44, 0.3));
  material.setColor3('cliffColor', new Color3(0.3, 0.27, 0.24));
  material.setFloat('heightRange', options.heightRange);
  material.setFloat('cliffSlope', options.cliffSlope);
  material.setFloat('fogEnabled', 0);
  material.setFloat('exploredDim', 0);
  material.setFloat('fogSoftness', DEFAULT_FOG_SOFTNESS);
  material.setVector2('fogTexel', new Vector2(0, 0));
  material.backFaceCulling = true;
  return material;
}
