/**
 * Loading unit models from a content pack.
 *
 * Generic on purpose: this knows about glTF and about the engine's hull-and-
 * turret convention, and nothing whatever about where the art came from. The
 * Generals pipeline is one possible producer and lives entirely outside `src/`.
 *
 * **The glTF reader here is deliberately narrow.** It handles the exact shape
 * the pipeline emits — one mesh, one primitive, `POSITION`, `NORMAL`,
 * `TEXCOORD_0` and `SCALAR` indices in a side-car `.bin` — and refuses anything
 * else. A general loader is `@babylonjs/loaders`, which is a few hundred
 * kilobytes of bundle for features a rigid RTS part never uses. Writing to a
 * format that standard tools can inspect is worth it; shipping a parser for
 * all of it is not.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Material } from '@babylonjs/core/Materials/material';
import { Constants } from '@babylonjs/core/Engines/constants';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

/** One loaded part: geometry plus the material its texture is on. */
export interface LoadedPart {
  readonly vertexData: VertexData;
  readonly material: StandardMaterial;
}

/** A part that spins about its own hub: a helicopter's rotor disc. */
export interface LoadedRotor {
  readonly part: LoadedPart;
  readonly offset: { x: number; y: number; z: number };
}

export interface LoadedModel {
  readonly hull: LoadedPart;
  readonly turret?: LoadedPart;
  /** How far above the ground the turret's origin sits, in world units. */
  readonly turretOffsetY: number;
  /** Rotor discs, empty for anything that does not fly. */
  readonly rotors: readonly LoadedRotor[];
}

/** What a content pack declares. */
export interface ContentPackEntry {
  /**
   * What this model is for: an engine unit type id such as `raider` for a
   * vehicle, or a scenery type name such as `TreePine` for a doodad. The
   * loader does not interpret it; it is the key the caller looks models up by.
   */
  readonly id: string;
  /**
   * The texture's alpha is a cut-out, not translucency. Foliage is built this
   * way — the branches are holes punched in a few flat quads — so it is drawn
   * with an alpha test and no back-face culling.
   */
  readonly alphaTest?: boolean;
  readonly hull: string;
  readonly turret?: string;
  readonly texture: string;
  readonly turretOffsetY?: number;
  /**
   * Spinning parts, each with the hub it turns about, in world units. A rotor
   * disc is always a cut-out — the blades are alpha in the texture — whatever
   * the rest of the model is.
   */
  readonly rotors?: readonly {
    readonly gltf: string;
    readonly offset: { x: number; y: number; z: number };
  }[];
}

export interface ContentPack {
  readonly baseUrl: string;
  readonly entries: readonly ContentPackEntry[];
}

interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
}

interface GltfDocument {
  meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[];
  accessors: GltfAccessor[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
  buffers: { uri: string; byteLength: number }[];
}

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const UNSIGNED_SHORT = 5123;

function readAccessor(
  doc: GltfDocument,
  bin: ArrayBuffer,
  index: number,
): Float32Array | Uint32Array {
  const accessor = doc.accessors[index];
  if (!accessor) throw new Error(`glTF: no accessor ${index}`);
  const view = doc.bufferViews[accessor.bufferView];
  if (!view) throw new Error(`glTF: accessor ${index} has no bufferView`);

  const components = accessor.type === 'VEC3' ? 3 : accessor.type === 'VEC2' ? 2 : 1;
  const count = accessor.count * components;

  if (accessor.componentType === FLOAT) {
    return new Float32Array(bin.slice(view.byteOffset, view.byteOffset + view.byteLength), 0, count);
  }
  if (accessor.componentType === UNSIGNED_INT) {
    return new Uint32Array(bin.slice(view.byteOffset, view.byteOffset + view.byteLength), 0, count);
  }
  if (accessor.componentType === UNSIGNED_SHORT) {
    const shorts = new Uint16Array(
      bin.slice(view.byteOffset, view.byteOffset + view.byteLength),
      0,
      count,
    );
    return Uint32Array.from(shorts);
  }
  throw new Error(`glTF: unsupported componentType ${accessor.componentType}`);
}

async function loadPart(
  baseUrl: string,
  file: string,
  material: StandardMaterial,
): Promise<LoadedPart> {
  const response = await fetch(`${baseUrl}/${file}`);
  if (!response.ok) throw new Error(`${file}: ${response.status}`);
  const doc = (await response.json()) as GltfDocument;

  const primitive = doc.meshes[0]?.primitives[0];
  if (!primitive) throw new Error(`${file}: no primitive`);

  const buffer = doc.buffers[0];
  if (!buffer) throw new Error(`${file}: no buffer`);
  // A glTF buffer URI is relative to the glTF file, not to the pack root.
  // Resolving it against the root finds nothing for any model in a
  // subdirectory, which is every model the pipeline emits.
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const binResponse = await fetch(`${baseUrl}/${dir}${buffer.uri}`);
  if (!binResponse.ok) throw new Error(`${buffer.uri}: ${binResponse.status}`);
  const bin = await binResponse.arrayBuffer();

  const vertexData = new VertexData();

  // A straight pass-through: no axis flip and no winding reversal.
  //
  // The reflex is to convert here, because glTF is nominally right-handed and
  // Babylon's scene is left-handed. That is wrong for this pipeline. The
  // source is a DirectX game, so its data is already left-handed, and the
  // converter emits it wound for Babylon's front-face convention. Converting
  // again makes every face back-facing.
  vertexData.positions = Array.from(
    readAccessor(doc, bin, primitive.attributes['POSITION'] as number),
  );

  const normal = primitive.attributes['NORMAL'];
  if (normal !== undefined) vertexData.normals = Array.from(readAccessor(doc, bin, normal));

  const uv = primitive.attributes['TEXCOORD_0'];
  if (uv !== undefined) vertexData.uvs = Array.from(readAccessor(doc, bin, uv));

  vertexData.indices = Array.from(readAccessor(doc, bin, primitive.indices));

  return { vertexData, material };
}

/**
 * Load a content pack.
 *
 * Returns what loaded rather than throwing: a pack with one bad model should
 * put the rest on screen and leave that unit as a placeholder box, which is
 * how you find out which one is broken.
 */
export async function loadContentPack(
  scene: Scene,
  pack: ContentPack,
): Promise<Map<string, LoadedModel>> {
  const models = new Map<string, LoadedModel>();
  // Shared across entries: a dozen doodads converted from one source texture
  // atlas would otherwise each upload their own copy of it.
  const materials = new Map<string, StandardMaterial>();

  for (const entry of pack.entries) {
    try {
      let material = materials.get(entry.texture);
      if (!material) {
        material = new StandardMaterial(`pack_${entry.texture}`, scene);
        const texture = new Texture(
          `${pack.baseUrl}/${entry.texture}`,
          scene,
          true,
          // Textures converted from the game are stored top-row-first, which is
          // glTF's convention and the opposite of Babylon's default.
          false,
        );
        // Tiling is baked into the atlas slots by the pipeline, so the
        // texture itself must clamp: wrapping would sample a neighbouring
        // vehicle's slot at the edges.
        texture.wrapU = Texture.CLAMP_ADDRESSMODE;
        texture.wrapV = Texture.CLAMP_ADDRESSMODE;
        material.diffuseTexture = texture;
        material.specularColor = new Color3(0.08, 0.08, 0.09);

        // Two-sided lighting, and no back-face culling with it.
        //
        // The source art does not have a consistent normal convention across
        // the sub-meshes of one vehicle — it was authored for a fixed-function
        // DirectX pipeline that did not care, and merging a dozen W3D
        // sub-objects into a single mesh is what exposes it. Without this the
        // vehicles are lit by the hemispheric light's *ground* colour, which
        // is a dark blue, so they render almost black and look for all the
        // world like the texture failed to load.
        //
        // Ruled out on the way here, all verified rather than assumed: the
        // texture decodes correctly, the UVs are in range, the geometry and
        // scale are right, mipmaps are not to blame, and the mirrored-part
        // correction in the converter (which is right regardless) does not
        // account for it either. This is a remedy for inconsistent source
        // normals, not a root-cause fix; the root cause is in the art.
        if (entry.alphaTest) {
          // An alpha *test*, not blending: the foliage is binary, so a discard
          // in the opaque pass renders it correctly from any angle with no
          // sorting — which thin instances could not give anyway.
          texture.hasAlpha = true;
          material.useAlphaFromDiffuseTexture = true;
          material.transparencyMode = Material.MATERIAL_ALPHATEST;
          // Below Babylon's 0.4 default. The foliage textures are 64x64 and
          // their alpha is soft at the edges, so a high threshold eats the
          // thin outer branches and leaves a tree looking half dead.
          material.alphaCutOff = 0.2;
          // Foliage quads are single planes. Culling their back faces deletes
          // half of every tree depending on which way the camera looks at it,
          // and this is the one case where the source art really is two-sided.
          material.backFaceCulling = false;
          material.twoSidedLighting = true;
        } else {
          material.backFaceCulling = true;
          material.twoSidedLighting = false;
        }
        // The models carry their own baked shading; a strong specular on top
        // makes them read as plastic.
        material.emissiveColor = new Color3(0.18, 0.18, 0.18);
        materials.set(entry.texture, material);
      }

      const hull = await loadPart(pack.baseUrl, entry.hull, material);
      const turret = entry.turret
        ? await loadPart(pack.baseUrl, entry.turret, material)
        : undefined;

      const rotors: LoadedRotor[] = [];
      if ((entry.rotors ?? []).length > 0) {
        // A second material over the same texture: the disc needs the alpha
        // test and the two-sided lighting that goes with it, and the fuselage
        // it is bolted to needs neither.
        const key = `${entry.texture}#cutout`;
        let discMaterial = materials.get(key);
        if (!discMaterial) {
          discMaterial = new StandardMaterial(`pack_${key}`, scene);
          discMaterial.diffuseTexture = material.diffuseTexture;
          discMaterial.specularColor = new Color3(0, 0, 0);
          discMaterial.emissiveColor = new Color3(0.1, 0.1, 0.1);
          discMaterial.useAlphaFromDiffuseTexture = true;
          discMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
          discMaterial.alphaCutOff = 0.2;
          discMaterial.backFaceCulling = false;
          discMaterial.twoSidedLighting = true;
          materials.set(key, discMaterial);
        }
        // The texture is shared, so it has to carry alpha for the disc even
        // though the hull's material ignores it.
        if (material.diffuseTexture) material.diffuseTexture.hasAlpha = true;
        for (const rotor of entry.rotors ?? []) {
          rotors.push({
            part: await loadPart(pack.baseUrl, rotor.gltf, discMaterial),
            offset: rotor.offset,
          });
        }
      }

      models.set(entry.id, {
        hull,
        ...(turret ? { turret } : {}),
        turretOffsetY: entry.turretOffsetY ?? 0,
        rotors,
      });
    } catch (error) {
      console.warn(
        `content pack: ${entry.id} left as a placeholder — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return models;
}

/** Build a mesh from a loaded part, ready for thin instancing. */
export function buildPartMesh(scene: Scene, name: string, part: LoadedPart): Mesh {
  const mesh = new Mesh(name, scene);
  part.vertexData.applyToMesh(mesh, false);
  mesh.material = part.material;
  mesh.isPickable = false;
  mesh.thinInstanceEnablePicking = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.setEnabled(false);
  return mesh;
}

/** How a moving part is drawn, from its W3D shader. */
export interface PartLook {
  /** Added to what is behind it: a light or a glow, not a surface. */
  readonly additive: boolean;
  /** Its texture's alpha is a cut-out. */
  readonly cutout: boolean;
}

/**
 * Load one moving part — a flag panel, a warning light — with a material to
 * match how the source game draws it.
 *
 * An additive part is unlit and emissive, and adds to the colour behind it
 * without writing depth: that is `SRCBLEND_ONE, DSTBLEND_ONE` in the part's
 * W3D shader, and it is what makes a red warning light glow instead of
 * sitting there as a dull red card. Materials are shared by texture and look,
 * so forty derricks' lights are one material.
 */
export async function loadLoosePart(
  scene: Scene,
  baseUrl: string,
  gltf: string,
  texturePath: string,
  look: PartLook,
  materials: Map<string, StandardMaterial>,
): Promise<LoadedPart> {
  const key = `${texturePath}#${look.additive ? 'add' : look.cutout ? 'cut' : 'solid'}`;
  let material = materials.get(key);
  if (!material) {
    material = new StandardMaterial(`part_${key}`, scene);
    const texture = new Texture(`${baseUrl}/${texturePath}`, scene, true, false);
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    if (look.additive) {
      material.emissiveTexture = texture;
      material.disableLighting = true;
      material.alphaMode = Constants.ALPHA_ADD;
      material.alpha = 0.999; // anything under 1 puts it in the blended pass
      material.disableDepthWrite = true;
      material.backFaceCulling = false;
    } else {
      material.diffuseTexture = texture;
      material.specularColor = new Color3(0.08, 0.08, 0.09);
      material.emissiveColor = new Color3(0.18, 0.18, 0.18);
      if (look.cutout) {
        texture.hasAlpha = true;
        material.useAlphaFromDiffuseTexture = true;
        material.transparencyMode = Material.MATERIAL_ALPHATEST;
        material.alphaCutOff = 0.2;
        // A flag is a single sheet; seen from behind it has to be there too.
        material.backFaceCulling = false;
        material.twoSidedLighting = true;
      } else {
        material.backFaceCulling = false;
        material.twoSidedLighting = true;
      }
    }
    materials.set(key, material);
  }
  return loadPart(baseUrl, gltf, material);
}
