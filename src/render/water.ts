/**
 * Water: lakes and seas, and rivers that flow.
 *
 * A content pack describes water as polygons with a surface height, which is
 * how the source game stores it, and this draws them the way its water
 * renderer does:
 *
 * - **Standing water** is the polygon filled as a fan from its first point,
 *   textured in world space so neighbouring lakes join up, and wobbled a
 *   little over time. It fades out towards the shore by depth: opacity is
 *   `min(depth / (D * m), m)`, with `D` the depth it turns opaque at and `m`
 *   its opacity when deep. The game does that with a destination-alpha pass
 *   over the shoreline; here the shader looks the ground height up itself,
 *   from the same corner heights and the same NW-SE triangle split the
 *   terrain mesh uses, so the fade meets the ground exactly.
 * - **A river** is the polygon read as two banks walked outward from its
 *   start point, pairing the points either side into a strip. Its texture runs
 *   along the strip, one repeat per river width, and scrolls down it; an alpha
 *   ramp across it fades the banks.
 *
 * Both sit under the fog of war like scenery and take the sun's shadows on
 * the part of their light that comes from the sun.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Effect } from '@babylonjs/core/Materials/effect';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector2, Vector4 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { SHADOW_GLSL } from './shadowglsl.ts';
import { SCENERY_FOG_GLSL, fogShader } from './sceneryfog.ts';
import { receiveShadowShader } from './shadows.ts';

/** One water polygon, in cells: x and z across, y the surface height. */
export interface WaterSurface {
  readonly river: boolean;
  /** For a river, the point its flow starts from. */
  readonly riverStart: number;
  readonly points: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

/** How a map's water looks. */
export interface WaterStyle {
  /** The surface texture, relative to the pack. */
  readonly texture: string;
  /** The alpha ramp a river's banks fade with. */
  readonly edge: string;
  /** Light the water gets regardless of the sun, 0..1 per channel. */
  readonly ambient: readonly number[];
  /** Light it gets from the sun, which a shadow takes away. */
  readonly sun: readonly number[];
  /** A river's opacity. */
  readonly alpha: number;
  /** Depth in cells at which standing water reaches `minOpacity`. */
  readonly transparentDepth: number;
  /** Standing water's opacity when deep. */
  readonly minOpacity: number;
}

/** Corner heights, in cells, laid out as the world stores them. */
export interface WaterGround {
  readonly width: number;
  readonly height: number;
  /** `(width + 1) * (height + 1)` corner heights, row by row. */
  readonly corners: Float32Array;
}

/**
 * How fast the water moves, in texture units a second.
 *
 * `WaterRenderObjClass::update` adds 0.002 a frame, and the game draws at a
 * fixed thirty frames a second.
 */
const FLOW_PER_SECOND = 0.002 * 30;

export interface WaterGeometry {
  readonly positions: number[];
  /** Standing water: unused. A river: u across (0 to 0.5), v along. */
  readonly uvs: number[];
  /** A river: the bank ramp's u across (0 to 1). */
  readonly uvs2: number[];
  readonly indices: number[];
}

/**
 * Standing water: a fan from the first point.
 *
 * The game draws it as quads `(P0, Pk, Pk+1, Pk+2)` for odd k, which on a flat
 * surface is the same fan. So an author's concave polygon draws exactly as
 * wrongly here as it did there, which is to say it was drawn to look right.
 */
export function standingGeometry(surface: WaterSurface): WaterGeometry {
  const positions: number[] = [];
  for (const p of surface.points) positions.push(p.x, p.y, p.z);
  const indices: number[] = [];
  for (let i = 1; i + 1 < surface.points.length; i++) indices.push(0, i, i + 1);
  const count = surface.points.length;
  return {
    positions,
    uvs: new Array<number>(count * 2).fill(0),
    uvs2: new Array<number>(count * 2).fill(0),
    indices,
  };
}

/**
 * A river: `WaterRenderObjClass::drawRiverWater`.
 *
 * The polygon goes up one bank and back down the other. Starting at
 * `riverStart` and the point after it, the two indices walk away from each
 * other, one each way round, and each step pairs a point on one bank with its
 * opposite number on the other. The segment between the two starting points
 * is the river's width at its source, and the texture repeats once per that
 * width along the river's length.
 */
export function riverGeometry(surface: WaterSurface): WaterGeometry | null {
  const points = surface.points;
  const n = points.length;
  const rectangles = Math.floor(n / 2) - 1;
  if (rectangles < 1 || surface.riverStart < 0 || surface.riverStart >= n - 1) return null;

  let total = 0;
  let endLength = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i] as WaterSurface['points'][number];
    const b = points[i + 1] as WaterSurface['points'][number];
    const length = Math.hypot(a.x - b.x, a.z - b.z);
    total += length;
    if (i === surface.riverStart) endLength = length;
  }
  if (endLength <= 0) return null;
  const repeats = (total / 2 - endLength) / endLength;
  const vScale = repeats / rectangles;

  const positions: number[] = [];
  const uvs: number[] = [];
  const uvs2: number[] = [];
  let inner = surface.riverStart;
  let outer = inner + 1;
  for (let i = 0; i < Math.floor(n / 2); i++) {
    const near = points[outer] as WaterSurface['points'][number];
    const far = points[inner] as WaterSurface['points'][number];
    outer = (outer + 1) % n;
    inner = inner - 1 < 0 ? n - 1 : inner - 1;
    const v = vScale * i;
    // Half the texture across, as the source does (`HEIGHT_TO_USE`), and the
    // whole bank ramp.
    positions.push(near.x, near.y, near.z);
    uvs.push(0.5, v);
    uvs2.push(1, v);
    positions.push(far.x, far.y, far.z);
    uvs.push(0, v);
    uvs2.push(0, v);
  }

  const indices: number[] = [];
  for (let i = 0; i < rectangles; i++) {
    indices.push(i * 2, i * 2 + 1, i * 2 + 3);
    indices.push(i * 2, i * 2 + 3, i * 2 + 2);
  }
  return { positions, uvs, uvs2, indices };
}

const VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec2 uv2;

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform mat4 shadowMatrix;

varying vec3 vWorld;
varying vec2 vUv;
varying vec2 vEdge;
varying vec4 vShadow;

void main(void) {
  vec4 at = world * vec4(position, 1.0);
  vWorld = at.xyz;
  vUv = uv;
  vEdge = uv2;
  vShadow = shadowMatrix * at;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAGMENT = `
precision highp float;

varying vec3 vWorld;
varying vec2 vUv;
varying vec2 vEdge;
varying vec4 vShadow;

uniform sampler2D waterTexture;
uniform sampler2D edgeTexture;
uniform sampler2D groundHeights;
/** Corner columns and rows of groundHeights. */
uniform vec2 groundSize;
uniform vec3 ambientColor;
uniform vec3 sunColor;
/** River alpha, transparent depth, deep opacity, 1 for a river. */
uniform vec4 waterInfo;
/** How far the water has flowed: the game's m_riverVOrigin. */
uniform float flow;

${SHADOW_GLSL}
${SCENERY_FOG_GLSL}

float corner(vec2 at) {
  return texture2D(groundHeights, (at + 0.5) / groundSize).r;
}

/** The ground height, split NW-SE exactly as the terrain mesh is. */
float groundAt(vec2 xz) {
  vec2 cell = clamp(floor(xz), vec2(0.0), groundSize - 2.0);
  vec2 f = clamp(xz - cell, 0.0, 1.0);
  float nw = corner(cell);
  float ne = corner(cell + vec2(1.0, 0.0));
  float se = corner(cell + vec2(1.0, 1.0));
  float sw = corner(cell + vec2(0.0, 1.0));
  if (f.y <= f.x) return nw + (ne - nw) * f.x + (se - ne) * f.y;
  return nw + (se - sw) * f.x + (sw - nw) * f.y;
}

void main(void) {
  float alpha;
  vec2 uv;
  if (waterInfo.w > 0.5) {
    // drawRiverWater: down the river, with a slow wobble.
    float v = vUv.y - flow + sin(6.2831853 * vUv.y - 3.0 * flow) / 22.0;
    uv = vec2(vUv.x, v);
    alpha = texture2D(edgeTexture, vec2(vEdge.x, v)).a * waterInfo.x;
  } else {
    // drawTrapezoidWater: world-space, 150 game units (15 cells) a repeat,
    // wobbling a fiftieth of a repeat.
    vec2 xz = vWorld.xz;
    uv = xz / 15.0 + vec2(
      0.02 * cos(11.0 * flow) * sin(25.0 * flow + xz.x * 0.7853982),
      0.02 * cos(5.0 * flow) * sin(25.0 * flow + xz.y * 0.7853982));
    float depth = max(0.0, vWorld.y - groundAt(vWorld.xz));
    float deep = waterInfo.z;
    alpha = waterInfo.y > 0.0 ? min(depth / (waterInfo.y * deep), deep) : deep;
  }

  float shade = mix(shadowInfo.z, 1.0, sunLit());
  vec3 color = texture2D(waterTexture, uv).rgb * (ambientColor + sunColor * shade);
  color *= sceneryFog(vWorld.xz);
  gl_FragColor = vec4(color, alpha);
}
`;

export interface WaterRenderer {
  /** How many surfaces were drawn. */
  readonly count: number;
  /** Advance the flow. `seconds` is wall-clock time. */
  update(seconds: number): void;
  dispose(): void;
}

function makeMaterial(
  scene: Scene,
  name: string,
  style: WaterStyle,
  surface: Texture,
  edge: Texture,
  heights: RawTexture,
  ground: WaterGround,
  river: boolean,
): ShaderMaterial {
  Effect.ShadersStore['rtsWaterVertexShader'] = VERTEX;
  Effect.ShadersStore['rtsWaterFragmentShader'] = FRAGMENT;
  const material = new ShaderMaterial(
    name,
    scene,
    'rtsWater',
    {
      attributes: ['position', 'uv', 'uv2'],
      uniforms: [
        'worldViewProjection',
        'world',
        'shadowMatrix',
        'shadowInfo',
        'groundSize',
        'ambientColor',
        'sunColor',
        'waterInfo',
        'flow',
        'sceneryFogMap',
        'sceneryFogTaps',
      ],
      samplers: ['waterTexture', 'edgeTexture', 'groundHeights', 'shadowSampler', 'sceneryFogSampler'],
      needAlphaBlending: true,
    },
  );
  material.setTexture('waterTexture', surface);
  material.setTexture('edgeTexture', edge);
  material.setTexture('groundHeights', heights);
  material.setVector2('groundSize', new Vector2(ground.width + 1, ground.height + 1));
  material.setColor3('ambientColor', new Color3(style.ambient[0], style.ambient[1], style.ambient[2]));
  material.setColor3('sunColor', new Color3(style.sun[0], style.sun[1], style.sun[2]));
  material.setVector4(
    'waterInfo',
    new Vector4(style.alpha, style.transparentDepth, style.minOpacity, river ? 1 : 0),
  );
  material.setFloat('flow', 0);
  // Water is seen from above and from below the rim of a bank alike, and the
  // source draws it with culling off. It writes no depth, so what is under it
  // stays visible through the shallows.
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.alphaMode = Constants.ALPHA_COMBINE;
  fogShader(material);
  receiveShadowShader(material);
  return material;
}

export function createWater(
  scene: Scene,
  baseUrl: string,
  style: WaterStyle,
  surfaces: readonly WaterSurface[],
  ground: WaterGround,
): WaterRenderer {
  const surfaceTexture = new Texture(`${baseUrl}/${style.texture}`, scene);
  surfaceTexture.wrapU = Texture.WRAP_ADDRESSMODE;
  surfaceTexture.wrapV = Texture.WRAP_ADDRESSMODE;
  const edgeTexture = new Texture(`${baseUrl}/${style.edge}`, scene);
  edgeTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
  edgeTexture.wrapV = Texture.WRAP_ADDRESSMODE;
  // Exact corner heights, not filtered: the shader does the terrain's own
  // triangle interpolation between them.
  const heights = RawTexture.CreateRTexture(
    ground.corners,
    ground.width + 1,
    ground.height + 1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_FLOAT,
  );

  const meshes: Mesh[] = [];
  const materials: ShaderMaterial[] = [];
  let count = 0;
  for (const river of [false, true]) {
    const positions: number[] = [];
    const uvs: number[] = [];
    const uvs2: number[] = [];
    const indices: number[] = [];
    for (const surface of surfaces) {
      if (surface.river !== river) continue;
      const geometry = river ? riverGeometry(surface) : standingGeometry(surface);
      if (!geometry) continue;
      const base = positions.length / 3;
      positions.push(...geometry.positions);
      uvs.push(...geometry.uvs);
      uvs2.push(...geometry.uvs2);
      for (const index of geometry.indices) indices.push(base + index);
      count++;
    }
    if (indices.length === 0) continue;

    const mesh = new Mesh(river ? 'water_rivers' : 'water_standing', scene);
    const data = new VertexData();
    data.positions = positions;
    data.uvs = uvs;
    data.uvs2 = uvs2;
    data.indices = indices;
    data.applyToMesh(mesh, false);
    const material = makeMaterial(
      scene,
      mesh.name,
      style,
      surfaceTexture,
      edgeTexture,
      heights,
      ground,
      river,
    );
    mesh.material = material;
    mesh.isPickable = false;
    meshes.push(mesh);
    materials.push(material);
  }

  return {
    count,
    update(seconds) {
      const flow = seconds * FLOW_PER_SECOND;
      for (const material of materials) material.setFloat('flow', flow);
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      for (const material of materials) material.dispose();
      surfaceTexture.dispose();
      edgeTexture.dispose();
      heights.dispose();
    },
  };
}
