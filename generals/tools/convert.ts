/**
 * The pipeline: W3D and DDS out of the archives, glTF and PNG into assets/.
 *
 * Everything happens here at author time, never in the browser (PLAN.md's third
 * decision). The runtime sees glTF and PNG and knows nothing about Westwood
 * formats.
 *
 * Two conventions this has to honour, both from the root PLAN.md's M28:
 *
 * - **Rigid parts only.** Each unit becomes a hull mesh and optionally a turret
 *   mesh. Skinned meshes are refused rather than silently mangled.
 * - **One texture per part.** The renderer draws each part as thin instances
 *   with a single material, so a part that referenced three textures would be
 *   three draw calls. Meshes are grouped by texture and the parts are atlased.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ASSETS_DIR, MANIFEST_DIR, findInstall, runTool } from './config.ts';
import { findByBasename, indexArchives, readEntry } from './big.ts';
import type { AssetIndex } from './big.ts';
import { readMeshes, readPivots, readSubObjects, parseChunks } from './w3d.ts';
import type { W3DMesh, W3DPivot } from './w3d.ts';
import { decodeImage, writePng } from './image.ts';
import type { Image } from './image.ts';

/**
 * World units per Generals unit.
 *
 * Generals models are authored at roughly ten units to a cell; this engine's
 * cells are one world unit across. Measured from the Crusader, whose hull is
 * about 26 Generals units long and should read as a little under two cells.
 */
const MODEL_SCALE = 0.055;

/**
 * Meshes that are effects rather than vehicle body.
 *
 * Generals models carry their own muzzle flashes, smoke emitters and headlight
 * cones as geometry. The headlight beams in particular are long thin cones
 * projecting metres in front of the vehicle, so leaving them in triples a
 * Humvee's bounding radius and puts a translucent wedge through the scene.
 *
 * Matched on texture as well as name, because the naming is not consistent
 * across factions but the effect textures are.
 */
const EFFECT_MESH = /^(SMOKE|MUZZLE|FIRE|HEADLIGHT|LIGHT|GLOW|BEAM)|FX\d*$/i;
const EFFECT_TEXTURE = /(lightbeam|mzl|muzzle|flash|glow|shadow)/i;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

type Mat4 = Float64Array;

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Column-major multiply, `a` then `b`. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** A pivot's local transform: rotate by its quaternion, then translate. */
function pivotMatrix(pivot: W3DPivot): Mat4 {
  const [x, y, z, w] = pivot.rotation;
  const m = identity();
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + z * w);
  m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);
  m[9] = 2 * (y * z - x * w);
  m[10] = 1 - 2 * (x * x + y * y);
  m[12] = pivot.translation.x;
  m[13] = pivot.translation.y;
  m[14] = pivot.translation.z;
  return m;
}

function transform(m: Mat4, v: Vec3): Vec3 {
  return {
    x: (m[0] as number) * v.x + (m[4] as number) * v.y + (m[8] as number) * v.z + (m[12] as number),
    y: (m[1] as number) * v.x + (m[5] as number) * v.y + (m[9] as number) * v.z + (m[13] as number),
    z: (m[2] as number) * v.x + (m[6] as number) * v.y + (m[10] as number) * v.z + (m[14] as number),
  };
}

/**
 * Determinant of a matrix's 3x3 part.
 *
 * Negative means the transform mirrors. Generals models use that freely — the
 * left track is usually the right track with a negative scale on a bone — and
 * a mirrored transform turns a mesh inside out: its winding reverses and its
 * normals point into the hull. Merging such a part without correcting it
 * leaves those faces lit from behind, which reads as a vehicle that is dark on
 * top and lit underneath.
 */
function determinant3(m: Mat4): number {
  const a = m[0] as number;
  const b = m[4] as number;
  const c = m[8] as number;
  const d = m[1] as number;
  const e = m[5] as number;
  const f = m[9] as number;
  const g = m[2] as number;
  const h = m[6] as number;
  const i = m[10] as number;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** Rotation only, for normals. */
function rotate(m: Mat4, v: Vec3): Vec3 {
  return {
    x: (m[0] as number) * v.x + (m[4] as number) * v.y + (m[8] as number) * v.z,
    y: (m[1] as number) * v.x + (m[5] as number) * v.y + (m[9] as number) * v.z,
    z: (m[2] as number) * v.x + (m[6] as number) * v.y + (m[10] as number) * v.z,
  };
}

/**
 * Generals is Z-up right-handed; glTF is Y-up right-handed.
 *
 * `(x, y, z) -> (x, z, -y)`. Getting this wrong does not look like an error:
 * the model renders inside-out or lying on its face, which is why it lives in
 * one function with its convention written down.
 */
function toGltfAxes(v: Vec3): Vec3 {
  return { x: v.x, y: v.z, z: -v.y };
}

/** Every pivot's transform in model space. */
function boneMatrices(pivots: readonly W3DPivot[]): Mat4[] {
  const out: Mat4[] = [];
  for (const pivot of pivots) {
    const local = pivotMatrix(pivot);
    const parent = pivot.parent >= 0 && pivot.parent < out.length ? (out[pivot.parent] as Mat4) : identity();
    out.push(multiply(parent, local));
  }
  return out;
}

/** Bone indices in the subtree rooted at `root`, inclusive. */
function subtree(pivots: readonly W3DPivot[], root: number): Set<number> {
  const found = new Set<number>([root]);
  for (let i = 0; i < pivots.length; i++) {
    let walk: number | undefined = i;
    while (walk !== undefined && walk >= 0) {
      if (found.has(walk)) {
        found.add(i);
        break;
      }
      walk = pivots[walk]?.parent;
    }
  }
  return found;
}

interface BuiltPart {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly indices: number[];
}

/** Merge meshes into one buffer, baking each one's bone transform in. */
function buildPart(
  meshes: readonly { mesh: W3DMesh; matrix: Mat4 }[],
  origin: Vec3,
  remapUv: (name: string, u: number, v: number) => { u: number; v: number },
): BuiltPart {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const { mesh, matrix } of meshes) {
    const base = positions.length / 3;
    const mirrored = determinant3(matrix) < 0;
    for (let i = 0; i < mesh.vertices.length; i++) {
      const world = transform(matrix, mesh.vertices[i] as Vec3);
      const local = { x: world.x - origin.x, y: world.y - origin.y, z: world.z - origin.z };
      const p = toGltfAxes(local);
      positions.push(p.x * MODEL_SCALE, p.y * MODEL_SCALE, p.z * MODEL_SCALE);

      const n = toGltfAxes(rotate(matrix, (mesh.normals[i] as Vec3) ?? { x: 0, y: 0, z: 1 }));
      const length = (Math.hypot(n.x, n.y, n.z) || 1) * (mirrored ? -1 : 1);
      normals.push(n.x / length, n.y / length, n.z / length);

      // W3D puts the v origin at the bottom of the texture; the renderer
      // puts it at the top. Flipped before the atlas remap so the slot
      // arithmetic still lines up with the range the texture is used over.
      const uv = mesh.uvs[i] ?? { u: 0, v: 0 };
      const mapped = remapUv(mesh.textures[0] ?? '', uv.u, 1 - uv.v);
      uvs.push(mapped.u, mapped.v);
    }
    // Wound for the renderer's front-face convention, which is the opposite
    // of the source's.
    //
    // The axis map above has a determinant of +1, so it preserves handedness:
    // the data stays left-handed, as a DirectX game's data is. Only the face
    // winding has to flip. Leaving it alone renders every surface back-facing,
    // and with culling on you look straight through a vehicle's roof into its
    // unlit interior — which looks like a broken texture, not a winding bug,
    // and cost a long detour through the texture decoder to find.
    //
    // A mirrored part has already had its winding flipped by its own
    // transform, so it flips back rather than twice.
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      const a = base + (mesh.indices[i] as number);
      const b = base + (mesh.indices[i + 1] as number);
      const c = base + (mesh.indices[i + 2] as number);
      if (mirrored) indices.push(a, b, c);
      else indices.push(a, c, b);
    }
  }

  return { positions, normals, uvs, indices };
}

/** How many times a texture may be repeated into its atlas slot. */
const MAX_TILES = 8;

interface UvBounds {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/** The UV range each texture is actually used over, across every mesh. */
function uvBoundsByTexture(
  meshes: readonly { mesh: W3DMesh }[],
): Map<string, UvBounds> {
  const bounds = new Map<string, UvBounds>();
  for (const { mesh } of meshes) {
    const name = (mesh.textures[0] ?? '').toLowerCase();
    if (name.length === 0) continue;
    const box = bounds.get(name) ?? { uMin: Infinity, uMax: -Infinity, vMin: Infinity, vMax: -Infinity };
    for (const uv of mesh.uvs) {
      if (uv.u < box.uMin) box.uMin = uv.u;
      if (uv.u > box.uMax) box.uMax = uv.u;
      if (uv.v < box.vMin) box.vMin = uv.v;
      if (uv.v > box.vMax) box.vMax = uv.v;
    }
    bounds.set(name, box);
  }
  return bounds;
}

interface Slot {
  readonly x: number;
  readonly y: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** UV origin of the slot: the floor of the range this texture is used over. */
  readonly uBase: number;
  readonly vBase: number;
  readonly tilesU: number;
  readonly tilesV: number;
}

/**
 * Pack the textures a model uses into one image, baking any tiling in.
 *
 * Three things this has to get right, each of which was wrong in the first
 * version and each of which shows up as "the texture mapping looks off":
 *
 * - **v must be scaled by the tile's height, not left alone.** A 32x32 tread
 *   texture in a 256-tall atlas has a v range eight times too large, so it
 *   samples straight past its own slot into whatever is below.
 * - **Tiling UVs cannot simply be remapped.** Treads run u from -10.8 to 9.2
 *   and rely on REPEAT. Squeezed into an atlas slot they wrap across the
 *   whole atlas and sample other vehicles' textures. The slot is made as many
 *   tiles wide as the range needs and the texture is repeated into it.
 * - **Different textures have different sizes.** Slots are sized per texture
 *   rather than assuming a common tile.
 */
function atlas(
  textures: Map<string, Image>,
  bounds: Map<string, UvBounds>,
): {
  image: Image;
  remap: (name: string, u: number, v: number) => { u: number; v: number };
} {
  const names = [...textures.keys()];
  const slots = new Map<string, Slot>();

  let cursor = 0;
  let atlasHeight = 1;
  for (const name of names) {
    const tile = textures.get(name) as Image;
    const box = bounds.get(name);
    const uBase = box && Number.isFinite(box.uMin) ? Math.floor(box.uMin) : 0;
    const vBase = box && Number.isFinite(box.vMin) ? Math.floor(box.vMin) : 0;
    const tilesU = box && Number.isFinite(box.uMax)
      ? Math.max(1, Math.min(MAX_TILES, Math.ceil(box.uMax) - uBase))
      : 1;
    const tilesV = box && Number.isFinite(box.vMax)
      ? Math.max(1, Math.min(MAX_TILES, Math.ceil(box.vMax) - vBase))
      : 1;

    slots.set(name, {
      x: cursor,
      y: 0,
      tileWidth: tile.width,
      tileHeight: tile.height,
      uBase,
      vBase,
      tilesU,
      tilesV,
    });
    cursor += tile.width * tilesU;
    atlasHeight = Math.max(atlasHeight, tile.height * tilesV);
  }

  const atlasWidth = Math.max(1, cursor);
  const data = Buffer.alloc(atlasWidth * atlasHeight * 4, 0);

  for (const name of names) {
    const tile = textures.get(name) as Image;
    const slot = slots.get(name) as Slot;
    for (let ty = 0; ty < slot.tilesV; ty++) {
      for (let tx = 0; tx < slot.tilesU; tx++) {
        const originX = slot.x + tx * tile.width;
        const originY = slot.y + ty * tile.height;
        for (let y = 0; y < tile.height; y++) {
          const destY = originY + y;
          if (destY >= atlasHeight) break;
          tile.data.copy(
            data,
            (destY * atlasWidth + originX) * 4,
            y * tile.width * 4,
            (y + 1) * tile.width * 4,
          );
        }
      }
    }
  }

  return {
    image: { width: atlasWidth, height: atlasHeight, data },
    remap: (name, u, v) => {
      const slot = slots.get(name.toLowerCase());
      if (!slot) return { u: 0, v: 0 };
      // Clamped into the slot, so a coordinate beyond the tiles that were
      // baked samples the slot's edge rather than the neighbouring texture.
      const px = slot.x + clamp((u - slot.uBase) * slot.tileWidth, 0, slot.tileWidth * slot.tilesU);
      const py = slot.y + clamp((v - slot.vBase) * slot.tileHeight, 0, slot.tileHeight * slot.tilesV);
      return { u: px / atlasWidth, v: py / atlasHeight };
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Find a texture in the archives, preferring the DDS the game actually ships. */
function loadTexture(index: AssetIndex, name: string): Image | null {
  const stem = name.replace(/\.(tga|dds)$/i, '');
  for (const candidate of [`${stem}.dds`, `${stem}.tga`]) {
    const found = findByBasename(index, candidate);
    if (found.length === 0) continue;
    const entry = found[0]!;
    const archivePath = index.archivePaths.get(entry.archive);
    if (!archivePath) continue;
    try {
      return decodeImage(readEntry(archivePath, entry), entry.name);
    } catch (error) {
      console.warn(`    ${candidate}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return null;
}

interface ConvertedPart {
  readonly gltf: string;
  readonly texture: string;
  /** Where the part's origin sits above the ground, in world units. */
  readonly offsetY: number;
}

export interface ConvertedModel {
  readonly id: string;
  readonly hull: ConvertedPart;
  readonly turret?: ConvertedPart;
  /** Bounding radius in world units, for sanity-checking against unit stats. */
  readonly radius: number;
}

/** glTF with a side-car .bin, which keeps the writer to arithmetic. */
function writeGltf(outPath: string, part: BuiltPart, textureFile: string): void {
  const positions = new Float32Array(part.positions);
  const normals = new Float32Array(part.normals);
  const uvs = new Float32Array(part.uvs);
  const indices = new Uint32Array(part.indices);

  const chunks = [positions, normals, uvs, indices];
  const offsets: number[] = [];
  let total = 0;
  for (const chunk of chunks) {
    offsets.push(total);
    total += chunk.byteLength;
    total = Math.ceil(total / 4) * 4;
  }

  const bin = Buffer.alloc(total);
  for (let i = 0; i < chunks.length; i++) {
    Buffer.from((chunks[i] as Float32Array | Uint32Array).buffer).copy(bin, offsets[i] as number);
  }

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] as number, positions[i + a] as number);
      max[a] = Math.max(max[a] as number, positions[i + a] as number);
    }
  }
  if (!Number.isFinite(min[0] as number)) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }

  const binName = `${outPath.split('/').pop()}.bin`;
  const gltf = {
    asset: { version: '2.0', generator: 'web_rts generals pipeline' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [{ uri: textureFile }],
    buffers: [{ uri: binName, byteLength: total }],
    bufferViews: chunks.map((chunk, i) => ({
      buffer: 0,
      byteOffset: offsets[i],
      byteLength: chunk.byteLength,
      target: i === 3 ? 34963 : 34962,
    })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
      { bufferView: 3, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(`${outPath}.bin`, bin);
  writeFileSync(`${outPath}.gltf`, JSON.stringify(gltf));
}

/** Convert one model into hull and turret parts. */
export function convertModel(index: AssetIndex, id: string, file: string): ConvertedModel | null {
  const found = findByBasename(index, file);
  if (found.length === 0) {
    console.error(`  ${id}: ${file} not found in any archive`);
    return null;
  }
  const entry = found[0]!;
  const archivePath = index.archivePaths.get(entry.archive)!;
  const chunks = parseChunks(readEntry(archivePath, entry));

  const meshes = readMeshes(chunks);
  const pivots = readPivots(chunks);
  const subObjects = readSubObjects(chunks);
  const matrices = boneMatrices(pivots);

  const skinned = meshes.filter((m) => m.skinned);
  if (skinned.length > 0) {
    console.error(
      `  ${id}: skinned meshes are not supported (${skinned.map((m) => m.name).join(', ')}) —` +
        ' see PLAN.md G13',
    );
    return null;
  }

  const boneOf = new Map<string, number>();
  for (const sub of subObjects) boneOf.set(sub.meshName.split('.').pop() ?? sub.meshName, sub.boneIndex);

  // `TURRET` on some models, `TURRET01` on others — the numbering is not
  // consistent between factions, and matching only the bare name silently
  // exported half the roster with its turret welded into the hull.
  const turretBone = pivots.findIndex((p) => /^TURRET\d*$/i.test(p.name));
  const turretBones = turretBone >= 0 ? subtree(pivots, turretBone) : new Set<number>();

  const hull: { mesh: W3DMesh; matrix: Mat4 }[] = [];
  const turret: { mesh: W3DMesh; matrix: Mat4 }[] = [];
  const wanted = new Map<string, Image>();

  for (const mesh of meshes) {
    if (EFFECT_MESH.test(mesh.name)) continue;
    if (EFFECT_TEXTURE.test(mesh.textures[0] ?? '')) continue;
    const bone = boneOf.get(mesh.name) ?? 0;
    const matrix = (matrices[bone] as Mat4) ?? identity();
    (turretBones.has(bone) ? turret : hull).push({ mesh, matrix });

    const texture = (mesh.textures[0] ?? '').toLowerCase();
    if (texture.length > 0 && !wanted.has(texture)) {
      const image = loadTexture(index, texture);
      if (image) wanted.set(texture, image);
    }
  }

  if (hull.length === 0) {
    console.error(`  ${id}: no hull meshes`);
    return null;
  }

  const { image, remap } = atlas(wanted, uvBoundsByTexture([...hull, ...turret]));
  const textureFile = `${id}.png`;
  mkdirSync(join(ASSETS_DIR, 'models'), { recursive: true });
  writeFileSync(join(ASSETS_DIR, 'models', textureFile), writePng(image));

  // The hull keeps the model origin so it sits on the ground where the engine
  // puts it; the turret is rebased onto its own pivot so rotating it spins it
  // about the right axis rather than swinging it around the hull.
  const origin: Vec3 = { x: 0, y: 0, z: 0 };
  const hullPart = buildPart(hull, origin, remap);
  writeGltf(join(ASSETS_DIR, 'models', `${id}_hull`), hullPart, textureFile);

  let turretOut: ConvertedPart | undefined;
  if (turret.length > 0 && turretBone >= 0) {
    const pivot = matrices[turretBone] as Mat4;
    const turretOrigin: Vec3 = { x: pivot[12] as number, y: pivot[13] as number, z: pivot[14] as number };
    const turretPart = buildPart(turret, turretOrigin, remap);
    writeGltf(join(ASSETS_DIR, 'models', `${id}_turret`), turretPart, textureFile);
    turretOut = {
      gltf: `${id}_turret.gltf`,
      texture: textureFile,
      offsetY: toGltfAxes(turretOrigin).y * MODEL_SCALE,
    };
  }

  let radius = 0;
  for (let i = 0; i < hullPart.positions.length; i += 3) {
    radius = Math.max(
      radius,
      Math.hypot(hullPart.positions[i] as number, hullPart.positions[i + 2] as number),
    );
  }

  return {
    id,
    hull: { gltf: `${id}_hull.gltf`, texture: textureFile, offsetY: 0 },
    ...(turretOut ? { turret: turretOut } : {}),
    radius,
  };
}

interface AssetManifest {
  readonly vehicles: { id: string; model: string; unitType?: string }[];
}

async function main(): Promise<void> {
  const install = findInstall();
  const index = indexArchives(install.archives);
  console.log(`indexed ${index.entries.size} files from ${index.archiveCount} archives\n`);

  const manifestPath = join(MANIFEST_DIR, 'assets.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AssetManifest;

  const converted: ConvertedModel[] = [];
  const entries: Record<string, unknown>[] = [];

  for (const vehicle of manifest.vehicles) {
    const model = convertModel(index, vehicle.id, vehicle.model);
    if (!model) continue;
    converted.push(model);
    console.log(
      `  ${vehicle.id}: hull${model.turret ? ' + turret' : ''}, radius ${model.radius.toFixed(2)}`,
    );

    // Only models bound to an engine unit type go in the pack; the rest are
    // converted and sitting there for when the roster grows.
    if (vehicle.unitType) {
      entries.push({
        unitType: vehicle.unitType,
        hull: `models/${model.hull.gltf}`,
        ...(model.turret ? { turret: `models/${model.turret.gltf}` } : {}),
        texture: `models/${model.hull.texture}`,
        ...(model.turret ? { turretOffsetY: model.turret.offsetY } : {}),
      });
    }
  }

  mkdirSync(ASSETS_DIR, { recursive: true });
  writeFileSync(
    join(ASSETS_DIR, 'models.json'),
    `${JSON.stringify({ models: converted }, null, 1)}\n`,
  );
  writeFileSync(join(ASSETS_DIR, 'pack.json'), `${JSON.stringify({ entries }, null, 1)}\n`);
  console.log(
    `\nconverted ${converted.length} of ${manifest.vehicles.length} models,` +
      ` ${entries.length} bound to unit types`,
  );
}

if (process.argv[1]?.endsWith('convert.ts')) void runTool(main);
