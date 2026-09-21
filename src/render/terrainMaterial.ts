/**
 * Terrain material.
 *
 * Two paths. Without a content pack the ground is shaded procedurally from a
 * height ramp and a slope term, which is what the fixture map and a production
 * build get. With one, the map brings **an atlas of its own ground textures
 * and a per-cell index map** saying which one each cell is painted with, and
 * the shader lays them down at the scale the artist drew them.
 *
 * The textured path follows the source game's terrain renderer closely. Each
 * cell shows the square of its texture the map names; up to two blend layers
 * fade other textures over it at the corners the map names; and on steep cells
 * the texture is stretched to the slope's true length so cliffs do not smear.
 * All of it is per-cell lookups in a handful of small images, which buys the
 * whole floor for one draw call.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector2, Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Effect } from '@babylonjs/core/Materials/effect';
import type { Scene } from '@babylonjs/core/scene';
import { setSceneryFog, setSceneryFogSoftness } from './sceneryfog.ts';

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
/** Two more lights, which a map's fills land in. Black when it has none. */
uniform vec3 fillDirection0;
uniform vec3 fillColor0;
uniform vec3 fillDirection1;
uniform vec3 fillColor1;
uniform float lightScale;
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
uniform sampler2D terrainBlend;
uniform sampler2D terrainExtraBlend;
uniform sampler2D terrainStretch;
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
 * The ground texture one cell is painted with.
 *
 * Each cell shows one cell-sized square of its texture, chosen by the map
 * rather than derived: the index map carries which atlas slot, which square,
 * and how many squares the texture divides into. That is the source game's own
 * scheme — a tile covers two cells each way and the low two bits of its index
 * pick the quarter — and neighbouring cells of one texture hold adjacent
 * squares, so the image runs on across them without a seam.
 *
 * Tiling it continuously instead, which is the obvious thing to do with an
 * atlas, puts a different part of the texture under every cell than the artist
 * placed there.
 */
/** One cell-sized square of an atlas slot, at a position within the cell. */
vec3 squareAt(float slot, vec2 square, float squares, vec2 inCell) {
  float columns = atlasInfo.x;
  float pad = atlasInfo.w;
  float span = atlasInfo.z + pad * 2.0;
  vec2 atlasSize = vec2(columns * span, atlasInfo.y * span);
  vec2 slotXY = vec2(floor(mod(slot, columns)), floor(slot / columns));

  // Where in the texture, then where in the slot. The padding around a slot
  // continues the texture, so a bilinear tap at the edge of an edge square
  // finds more of the same rather than the neighbouring slot.
  // Wrapped within the texture: a stretched cliff cell runs past its own
  // square, and the texture tiles, so it carries on into the same rock.
  //
  // Half a texel in from the edge of the square, unless the cell is stretched
  // and meant to run past it. A cell's square borders the next tile of the
  // texture, and neighbouring tiles need not be continuous — blend textures
  // especially are sets of separate variations — so a bilinear tap exactly
  // on the edge borrows half a texel of something else. At normal zoom a
  // texel is about a pixel, and it drew a one-pixel line along the edge of
  // every blended cell.
  vec2 half_ = vec2(0.5 * squares / atlasInfo.z);
  vec2 kept = mix(clamp(inCell, half_, 1.0 - half_), inCell, step(1.0001, inCell));
  vec2 inTexture = fract((square + kept) / squares);
  vec2 inside = inTexture * atlasInfo.z + pad;
  return texture2D(terrainAtlas, (slotXY * span + inside) / atlasSize).rgb;
}

/**
 * Where within a cell to sample, allowing for the cliff correction: a steep
 * cell runs its texture up to four times further along each axis, so the rock
 * on a cliff face stays rock-sized instead of smearing down it. See
 * readTerrainTextures in the importer; this is WorldHeightMap's run-time
 * cliff adjustment.
 */
vec2 inCellAt(vec2 cell) {
  vec2 icell = clamp(floor(cell), vec2(0.0), mapCells - 1.0);
  vec2 stretch = texture2D(terrainStretch, (icell + 0.5) / mapCells).rg * 3.0 + 1.0;
  vec2 f = fract(cell);
  // Up the picture as z increases, within the cell as well as between cells.
  // The squares a map assigns climb the texture as z grows — the source's
  // tile rows run bottom-up — so the position inside a cell has to run the
  // same way or every row boundary jumps two squares. It did: on Tournament
  // Tundra all 61,484 vertically adjacent cells of one texture had a seam,
  // which on cliff rock reads as stacked horizontal bands.
  return vec2(f.x, 1.0 - f.y) * stretch;
}

vec3 groundAt(vec2 cell) {
  vec2 icell = clamp(floor(cell), vec2(0.0), mapCells - 1.0);
  vec4 entry = texture2D(terrainIndex, (icell + 0.5) / mapCells);
  return squareAt(
    floor(entry.r * 255.0 + 0.5),
    floor(entry.gb * 255.0 + 0.5),
    max(1.0, floor(entry.a * 255.0 + 0.5)),
    inCellAt(cell));
}

/**
 * A blend layer at this point: the colour to lay over, and how much of it.
 *
 * This is the source game's terrain blending, which is not an alpha mask but a
 * vertex fade. Each cell's four corners are opaque or clear — two on one side
 * for a straight edge, one for a short diagonal, three for a long one — and
 * the fade between them is what softens the join between two ground types.
 * The corners are interpolated bilinearly here; the game splits the cell into
 * two triangles, which gives diagonals a slightly straighter edge.
 *
 * Alpha packs the texture's side in its high four bits and the corner mask in
 * its low four, corners running (x, z), (x+1, z), (x+1, z+1), (x, z+1).
 */
vec4 blendAt(sampler2D layer, vec2 cell) {
  vec2 icell = clamp(floor(cell), vec2(0.0), mapCells - 1.0);
  vec4 entry = texture2D(layer, (icell + 0.5) / mapCells);
  float slot = floor(entry.r * 255.0 + 0.5);
  if (slot > 254.5) return vec4(0.0);

  float packed = floor(entry.a * 255.0 + 0.5);
  float side = floor(packed / 16.0);
  float mask = packed - side * 16.0;
  float c0 = mod(mask, 2.0);
  float c1 = mod(floor(mask / 2.0), 2.0);
  float c2 = mod(floor(mask / 4.0), 2.0);
  float c3 = mod(floor(mask / 8.0), 2.0);

  // The fade runs across the cell as it is; the texture under it takes the
  // same cliff stretch as the base, as the source game's blends do.
  vec2 f = fract(cell);
  float alpha = mix(mix(c0, c1, f.x), mix(c3, c2, f.x), f.y);
  vec3 colour = squareAt(slot, floor(entry.gb * 255.0 + 0.5), max(1.0, side * 2.0), inCellAt(cell));
  return vec4(colour, alpha);
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
    // One sample of the base, not a cross-fade of four. With each cell
    // pointed at the square the map actually names, cells of one texture
    // already join up; the joins *between* textures are softened by the
    // map's own blend layers below, exactly where the artist put them.
    vec2 cell = vMapUv * mapCells;
    base = groundAt(cell);
    // Then the blends over it, in the order the game draws them: the edge
    // between two ground types, and where a third meets them, a second edge
    // over that.
    vec4 over = blendAt(terrainBlend, cell);
    base = mix(base, over.rgb, over.a);
    over = blendAt(terrainExtraBlend, cell);
    base = mix(base, over.rgb, over.a);
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
  // Three lights, not one. A Generals map carries three per time of day for
  // the ground and three more for what stands on it, and most maps use a
  // primary plus two fills from other directions. Reading only the primary
  // leaves the unlit sides of hills far darker than the game shows them.
  vec3 received = ambientColor * (0.85 + 0.15 * up);
  received += sunColor * clamp(dot(n, -normalize(lightDirection)), 0.0, 1.0);
  received += fillColor0 * clamp(dot(n, -normalize(fillDirection0)), 0.0, 1.0);
  received += fillColor1 * clamp(dot(n, -normalize(fillDirection1)), 0.0, 1.0);

  // Scaled, because the map's numbers do not fix an exposure on their own.
  // GameData.ini gives them as 0-255 colours with no multiplier alongside,
  // and taken at face value they land flat morning ground at about 60% of the
  // texture's own brightness — measurably darker than the previews the game
  // ships, which are close to the raw texture. The fixed-function terrain
  // blend of that era doubled; doubling here blows the red channel out. So
  // this is a knob with a measured default rather than a derived constant,
  // and it is r_lightscale at the console.
  vec3 color = base * received * lightScale;

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
 * How much of the map's own lighting reaches the screen.
 *
 * Chosen by measurement, not derived: at 1.0 a morning desert renders at
 * roughly 60% of its texture's brightness, and at 2.0 — the doubling the
 * source game's texture stage did — the red channel clips. 1.6 puts flat
 * flat morning ground at about three quarters of the unlit texture, which
 * reads as a warm desert; 1.6 and above turns the same sand neon orange,
 * because a warm light multiplying a warm texture compounds the cast.
 */
export const DEFAULT_LIGHT_SCALE = 1.0;

/** How brightly the map's lighting is applied. */
export function setTerrainLightScale(material: ShaderMaterial, scale: number): void {
  material.setFloat('lightScale', scale);
}

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
  readonly blend: BaseTexture;
  readonly extraBlend: BaseTexture;
  readonly stretch: BaseTexture;
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
  material.setTexture('terrainBlend', set.blend);
  material.setTexture('terrainExtraBlend', set.extraBlend);
  material.setTexture('terrainStretch', set.stretch);
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
  fills: readonly {
    direction: { x: number; y: number; z: number };
    color: { r: number; g: number; b: number };
  }[] = [],
): void {
  material.setVector3('lightDirection', new Vector3(direction.x, direction.y, direction.z).normalize());
  if (sunColor) material.setColor3('sunColor', new Color3(sunColor.r, sunColor.g, sunColor.b));
  if (ambient) material.setColor3('ambientColor', new Color3(ambient.r, ambient.g, ambient.b));

  for (let i = 0; i < 2; i++) {
    const fill = fills[i];
    material.setVector3(
      `fillDirection${i}`,
      fill
        ? new Vector3(fill.direction.x, fill.direction.y, fill.direction.z).normalize()
        : new Vector3(0, -1, 0),
    );
    material.setColor3(
      `fillColor${i}`,
      fill ? new Color3(fill.color.r, fill.color.g, fill.color.b) : new Color3(0, 0, 0),
    );
  }
}

/** Set the blur radius the fog is sampled with, in texels. */
export function setTerrainFogSoftness(material: ShaderMaterial, texels: number): void {
  material.setFloat('fogSoftness', texels);
  setSceneryFogSoftness(texels);
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
  // Scenery and roads are fogged by the same texture in the same way, and set
  // here so that nothing can turn the ground's fog off and leave theirs on.
  setSceneryFog(texture, width, height, exploredDim);
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
      'fillDirection0',
      'fillColor0',
      'fillDirection1',
      'fillColor1',
      'lightScale',
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
    samplers: [
      'fogSampler',
      'terrainAtlas',
      'terrainIndex',
      'terrainBlend',
      'terrainExtraBlend',
      'terrainStretch',
    ],
  });

  const light = options.lightDirection;
  material.setVector3('lightDirection', new Vector3(light.x, light.y, light.z).normalize());
  material.setColor3('sunColor', new Color3(0.45, 0.43, 0.4));
  material.setColor3('ambientColor', new Color3(0.21, 0.22, 0.24));
  material.setVector3('fillDirection0', new Vector3(0, -1, 0));
  material.setColor3('fillColor0', new Color3(0, 0, 0));
  material.setVector3('fillDirection1', new Vector3(0, -1, 0));
  material.setColor3('fillColor1', new Color3(0, 0, 0));
  material.setFloat('lightScale', DEFAULT_LIGHT_SCALE);
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
