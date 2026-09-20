/**
 * Terrain material.
 *
 * Two paths. Without a content pack the ground is shaded procedurally from a
 * height ramp and a slope term, which is what the fixture map and a production
 * build get. With one, the map brings **an atlas of its own ground textures
 * and a per-cell index map** saying which one each cell is painted with, and
 * the shader lays them down at the scale the artist drew them.
 *
 * The textured path blends the four cells around each fragment rather than
 * picking one. The source data is one texture per cell and nothing finer, so
 * a hard lookup gives a visible square lattice; the cross-fade is what turns
 * it back into ground. It costs four index lookups and four atlas lookups,
 * which buys the whole floor for one draw call.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector2, Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
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
uniform vec3 sunColor;
uniform vec3 ambientColor;
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

uniform sampler2D terrainAtlas;
uniform sampler2D terrainIndex;
/** Cells across the map, so a map UV becomes a cell coordinate. */
uniform vec2 mapCells;
/** Atlas columns, rows, slot side in pixels, and the padding around a slot. */
uniform vec4 atlasInfo;
uniform float terrainTextured;

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

/**
 * The ground texture one cell is painted with, sampled at a continuous point.
 *
 * The first argument says *which* texture: it is the cell being asked about.
 * The second is where in the world the sample falls, so neighbouring cells of
 * the same texture line up seamlessly instead of each restarting it.
 *
 * Green in the index map is how many cells the texture spans before it
 * repeats, which is the side of the tile grid the artist cut it into. Laying
 * every texture down at the same rate makes coarse ground look fine and fine
 * ground look coarse.
 */
vec3 groundAt(vec2 icell, vec2 at) {
  vec2 clamped = clamp(icell, vec2(0.0), mapCells - 1.0);
  vec4 entry = texture2D(terrainIndex, (clamped + 0.5) / mapCells);
  float slot = floor(entry.r * 255.0 + 0.5);
  float side = max(1.0, floor(entry.g * 255.0 + 0.5));

  float columns = atlasInfo.x;
  float pad = atlasInfo.w;
  float span = atlasInfo.z + pad * 2.0;
  vec2 atlasSize = vec2(columns * span, atlasInfo.y * span);
  vec2 slotXY = vec2(floor(mod(slot, columns)), floor(slot / columns));

  // Into the slot's usable area, never its padding: the padding exists so a
  // bilinear tap at the edge finds more of the same texture instead of the
  // neighbouring one.
  vec2 inside = fract(at / side) * atlasInfo.z + pad;
  return texture2D(terrainAtlas, (slotXY * span + inside) / atlasSize).rgb;
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

  if (terrainTextured > 0.5) {
    // Bilinear over the four cells around this fragment. Weighted from the
    // offset within the cell, so the blend is symmetric and a run of identical
    // cells comes out exactly as that texture.
    vec2 cell = vMapUv * mapCells;
    vec2 corner = floor(cell - 0.5);
    vec2 f = cell - 0.5 - corner;
    vec3 g = groundAt(corner, cell) * (1.0 - f.x) * (1.0 - f.y);
    g += groundAt(corner + vec2(1.0, 0.0), cell) * f.x * (1.0 - f.y);
    g += groundAt(corner + vec2(0.0, 1.0), cell) * (1.0 - f.x) * f.y;
    g += groundAt(corner + vec2(1.0, 1.0), cell) * f.x * f.y;
    base = g;
  }

  // The map's own sun and ambient, not a fixed pair. A Generals map carries
  // both per time of day, and using anything else throws away most of what
  // makes a night map a night map — the shipped tundra maps ask for a dim
  // blue ambient and a dimmer blue sun, and lighting them like noon is why
  // they came out as blazing white snow.
  //
  // The upward term stays as a small addition rather than the whole ambient:
  // flat ground catching a little more sky than a slope does is true, and the
  // map's ambient is a single colour with no direction in it.
  float lambert = clamp(dot(n, -normalize(lightDirection)), 0.0, 1.0);
  vec3 color = base * (ambientColor * (0.85 + 0.15 * up) + sunColor * lambert);

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

/** What a map's ground texturing needs, once the images have loaded. */
export interface TerrainTextureSet {
  readonly atlas: BaseTexture;
  readonly index: BaseTexture;
  readonly columns: number;
  readonly rows: number;
  readonly slot: number;
  readonly pad: number;
  readonly cells: { width: number; height: number };
}

/**
 * Paint the ground with a map's own textures, or pass null for the procedural
 * shading the fixture map uses.
 */
export function setTerrainTextures(
  material: ShaderMaterial,
  set: TerrainTextureSet | null,
): void {
  material.setFloat('terrainTextured', set ? 1 : 0);
  if (!set) return;
  material.setTexture('terrainAtlas', set.atlas);
  material.setTexture('terrainIndex', set.index);
  material.setVector2('mapCells', new Vector2(set.cells.width, set.cells.height));
  material.setVector4('atlasInfo', new Vector4(set.columns, set.rows, set.slot, set.pad));
}

/**
 * Point the terrain shader at a different sun, with its colour and ambient.
 *
 * All three together, because they are one decision: a map's lighting is a
 * direction and two colours, and applying the direction while keeping the
 * engine's own colours is what made every imported map look like noon.
 */
export function setTerrainSun(
  material: ShaderMaterial,
  direction: { x: number; y: number; z: number },
  sunColor?: { r: number; g: number; b: number },
  ambient?: { r: number; g: number; b: number },
): void {
  material.setVector3('lightDirection', new Vector3(direction.x, direction.y, direction.z).normalize());
  if (sunColor) material.setColor3('sunColor', new Color3(sunColor.r, sunColor.g, sunColor.b));
  if (ambient) material.setColor3('ambientColor', new Color3(ambient.r, ambient.g, ambient.b));
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
      'sunColor',
      'ambientColor',
      'groundLow',
      'groundHigh',
      'cliffColor',
      'heightRange',
      'cliffSlope',
      'fogTexel',
      'fogEnabled',
      'exploredDim',
      'fogSoftness',
      'mapCells',
      'atlasInfo',
      'terrainTextured',
    ],
    samplers: ['fogSampler', 'terrainAtlas', 'terrainIndex'],
  });

  const light = options.lightDirection;
  material.setVector3('lightDirection', new Vector3(light.x, light.y, light.z).normalize());
  material.setColor3('sunColor', new Color3(0.9, 0.87, 0.8));
  material.setColor3('ambientColor', new Color3(0.42, 0.44, 0.48));
  material.setColor3('groundLow', new Color3(0.21, 0.29, 0.2));
  material.setColor3('groundHigh', new Color3(0.38, 0.44, 0.3));
  material.setColor3('cliffColor', new Color3(0.3, 0.27, 0.24));
  material.setFloat('heightRange', options.heightRange);
  material.setFloat('cliffSlope', options.cliffSlope);
  material.setFloat('fogEnabled', 0);
  material.setFloat('exploredDim', 0);
  material.setFloat('fogSoftness', DEFAULT_FOG_SOFTNESS);
  material.setVector2('fogTexel', new Vector2(0, 0));
  material.setFloat('terrainTextured', 0);
  material.setVector2('mapCells', new Vector2(1, 1));
  material.setVector4('atlasInfo', new Vector4(1, 1, 1, 0));
  material.backFaceCulling = true;
  return material;
}
