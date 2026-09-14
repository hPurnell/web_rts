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
uniform float tierHeight;
uniform float maxTier;
uniform sampler2D fogSampler;
uniform vec2 fogTexel;
uniform float fogEnabled;
uniform float exploredDim;

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

  // Tier tint: higher ground reads lighter, which is what makes discrete
  // cliffs legible from an RTS camera.
  float tier = clamp(vPosition.y / max(tierHeight, 0.0001) / max(maxTier, 1.0), 0.0, 1.0);
  vec3 flat_ = mix(groundLow, groundHigh, tier);

  // Walls are near-vertical; blend to the cliff colour by how vertical we are.
  vec3 base = mix(cliffColor, flat_, up);

  float grain = noise(vUv * 3.0) * 0.12 + noise(vUv * 11.0) * 0.06;
  base *= 0.92 + grain;

  float lambert = clamp(dot(n, -normalize(lightDirection)), 0.0, 1.0);
  float ambient = 0.42 + 0.18 * up;
  vec3 color = base * (ambient + lambert * 0.85);

  // Contact darkening at the foot of cliffs, so walls do not float.
  float foot = smoothstep(0.0, 0.35, fract(vPosition.y / max(tierHeight, 0.0001)));
  color *= mix(1.0, 0.86, (1.0 - up) * (1.0 - foot));

  if (fogEnabled > 0.5) {
    // A small cross blur on top of the texture's own bilinear filtering. One
    // texel per cell is coarse, and without this the fog boundary reads as a
    // staircase of squares rather than an edge.
    vec2 fog = texture2D(fogSampler, vMapUv).rg;
    fog += texture2D(fogSampler, vMapUv + vec2(fogTexel.x, 0.0)).rg;
    fog += texture2D(fogSampler, vMapUv - vec2(fogTexel.x, 0.0)).rg;
    fog += texture2D(fogSampler, vMapUv + vec2(0.0, fogTexel.y)).rg;
    fog += texture2D(fogSampler, vMapUv - vec2(0.0, fogTexel.y)).rg;
    fog /= 5.0;

    // Visible is full brightness, explored-only is dimmed, unexplored is black.
    float brightness = max(fog.r, fog.g * exploredDim);
    color *= brightness;
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

export interface TerrainMaterialOptions {
  readonly tierHeight: number;
  readonly maxTier: number;
  readonly lightDirection: { x: number; y: number; z: number };
}

/** Point the terrain shader at a fog texture, or pass null to disable fog. */
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
      'tierHeight',
      'maxTier',
      'fogTexel',
      'fogEnabled',
      'exploredDim',
    ],
    samplers: ['fogSampler'],
  });

  const light = options.lightDirection;
  material.setVector3('lightDirection', new Vector3(light.x, light.y, light.z).normalize());
  material.setColor3('groundLow', new Color3(0.21, 0.29, 0.2));
  material.setColor3('groundHigh', new Color3(0.38, 0.44, 0.3));
  material.setColor3('cliffColor', new Color3(0.3, 0.27, 0.24));
  material.setFloat('tierHeight', options.tierHeight);
  material.setFloat('maxTier', options.maxTier);
  material.setFloat('fogEnabled', 0);
  material.setFloat('exploredDim', 0);
  material.setVector2('fogTexel', new Vector2(0, 0));
  material.backFaceCulling = true;
  return material;
}
