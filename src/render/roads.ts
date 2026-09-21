/**
 * Roads, rails and pavements: a textured ribbon draped over the terrain.
 *
 * A road is not a model and not scenery. It is a polyline the map's author
 * drew, and it has to be turned into geometry that follows the ground — which
 * is why this lives in the renderer rather than coming out of the asset
 * pipeline as a mesh. The same polyline over different terrain is different
 * geometry.
 *
 * Two things the ribbon has to get right:
 *
 * - **Mitred joins.** The offset at a corner is the bisector of the two
 *   segments, lengthened by 1/cos(half-angle) so the outer edge stays parallel
 *   to both. Without it a corner has a notch on the inside and a gap on the
 *   outside. The lengthening is clamped, because at a hairpin it goes to
 *   infinity and would fire a spike across the map.
 * - **Following the ground.** Each segment is subdivided to about a cell and
 *   every vertex takes its height from the terrain, so a road over a ridge
 *   bends with it instead of burying itself.
 *
 * Like `models.ts` this knows nothing about where the art came from.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { fourWay, threeWay } from './roadjunctions.ts';
import { fogMaterial } from './sceneryfog.ts';
import { receiveShadow } from './shadows.ts';
import type { Arm, JunctionPatch, JunctionPieces, Vec } from './roadjunctions.ts';

/**
 * How far above the ground the ribbon sits.
 *
 * Enough to beat depth precision at this camera range, small enough that it
 * still reads as painted on. A road drawn at exactly ground height z-fights
 * and strobes as the camera moves.
 */
const LIFT = 0.04;

/** Target spacing of the ribbon's cross-sections, in cells. */
const STEP = 1;

/** How far a mitre may stretch before the corner is treated as a hairpin. */
const MAX_MITRE = 4;

/** What the pipeline says about one kind of road. */
export interface RoadType {
  readonly id: string;
  readonly texture: string;
  /** Width of the ribbon across the road, in world units. */
  readonly width: number;
  /**
   * The road's nominal width, which corners are sized from. Wider than
   * `width`: the texture's shoulder is part of the nominal road but not of
   * the ribbon.
   */
  readonly scale: number;
  /** Distance along the road that one repeat of the texture covers. */
  readonly repeat: number;
  /** Texture v at the right-hand edge, looking along the road. */
  readonly v0: number;
  /** Texture v at the left-hand edge. */
  readonly v1: number;
  /**
   * Where the junction pieces sit in the texture. Absent, runs that meet are
   * simply drawn over one another.
   */
  readonly pieces?: JunctionPieces;
}

/** A point on a road, and how the author asked it to turn there. */
export interface RoadPoint {
  readonly x: number;
  readonly z: number;
  /** A sharp corner, not a curve. */
  readonly angled?: boolean;
  /** A tight curve: half a road width of radius rather than one and a half. */
  readonly tight?: boolean;
}

/** One run of road, as the map stores it. */
export interface RoadPolyline {
  readonly type: string;
  readonly points: readonly RoadPoint[];
}

/**
 * Curve radius as a multiple of the road's nominal width.
 *
 * `CORNER_RADIUS` and `TIGHT_CORNER_RADIUS` in `W3DRoadBuffer.cpp`. Every
 * corner in a Generals map is one of these arcs unless the author flagged it
 * angled; mitring every corner is what made the roads turn in hard points.
 */
const CORNER_RADIUS = 1.5;
const TIGHT_CORNER_RADIUS = 0.5;

/**
 * Turns gentler than this stay sharp, as they do in the source game: it
 * counts a turn in thirty-degree steps and mitres anything under 0.9 of one.
 */
const MIN_CURVE_ANGLE = (0.9 * Math.PI) / 6;

/** How finely an arc is cut. The source uses thirty degrees; this is smoother. */
const ARC_STEP = Math.PI / 18;

/**
 * Replace each corner the author wanted curved with a circular arc tangent to
 * both legs.
 *
 * The arc's radius comes from the road's nominal width, so a wide road sweeps
 * round a wide bend. Where a leg is too short to fit the whole fillet — two
 * corners close together — the radius shrinks to what fits instead of the
 * arcs overlapping; the source falls back to a mitre there, which looks worse
 * and is not something a player would recognise as intended.
 *
 * This only moves the centreline. The ribbon is built along the result
 * afterwards, so the texture's lane markings follow the curve rather than
 * being cut from the separate corner pieces in the atlas.
 */
export function smoothCorners(points: readonly RoadPoint[], scale: number): RoadPoint[] {
  if (points.length < 3) return [...points];
  const out: RoadPoint[] = [points[0] as RoadPoint];

  for (let i = 1; i + 1 < points.length; i++) {
    const before = points[i - 1] as RoadPoint;
    const corner = points[i] as RoadPoint;
    const after = points[i + 1] as RoadPoint;

    const legA = Math.hypot(corner.x - before.x, corner.z - before.z);
    const legB = Math.hypot(after.x - corner.x, after.z - corner.z);
    if (legA < 1e-6 || legB < 1e-6) {
      out.push(corner);
      continue;
    }
    const ax = (corner.x - before.x) / legA;
    const az = (corner.z - before.z) / legA;
    const bx = (after.x - corner.x) / legB;
    const bz = (after.z - corner.z) / legB;

    const turn = Math.acos(Math.max(-1, Math.min(1, ax * bx + az * bz)));
    if (corner.angled || turn < MIN_CURVE_ANGLE || turn > Math.PI - 1e-3) {
      out.push(corner);
      continue;
    }

    // How far back along each leg the arc meets it. Half a leg at most, so a
    // fillet at the other end of the same leg always has room too.
    let radius = (corner.tight ? TIGHT_CORNER_RADIUS : CORNER_RADIUS) * scale;
    const half = Math.tan(turn / 2);
    let reach = radius * half;
    const room = Math.min(legA, legB) / 2;
    if (reach > room) {
      reach = room;
      radius = reach / half;
    }

    const startX = corner.x - ax * reach;
    const startZ = corner.z - az * reach;
    // The centre is on the inside of the turn, a radius off the first leg.
    const left = ax * bz - az * bx > 0 ? 1 : -1;
    const centreX = startX - az * radius * left;
    const centreZ = startZ + ax * radius * left;

    const from = Math.atan2(startZ - centreZ, startX - centreX);
    const steps = Math.max(1, Math.ceil(turn / ARC_STEP));
    for (let step = 0; step <= steps; step++) {
      const angle = from + (left * turn * step) / steps;
      out.push({
        x: centreX + Math.cos(angle) * radius,
        z: centreZ + Math.sin(angle) * radius,
      });
    }
  }

  out.push(points[points.length - 1] as RoadPoint);
  return out;
}

export interface RoadRenderer {
  /** How many runs were drawn. */
  readonly count: number;
  /** How many draw calls they cost, i.e. how many road types appeared. */
  readonly types: number;
  dispose(): void;
}

interface Buffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/** The unit perpendicular to a segment, in the ground plane. */
function perpendicular(
  from: { x: number; z: number },
  to: { x: number; z: number },
): { x: number; z: number } | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return null;
  return { x: -dz / length, z: dx / length };
}

/**
 * The half-width offset at each point of a polyline.
 *
 * At an end it is simply the segment's perpendicular; in the middle it is the
 * bisector of the two, stretched so the ribbon's edges stay parallel to both
 * segments.
 */
function offsets(
  points: readonly { x: number; z: number }[],
  half: number,
  ends: RoadEnds = {},
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];

  for (let i = 0; i < points.length; i++) {
    const before = i > 0 ? perpendicular(points[i - 1] as never, points[i] as never) : null;
    const after =
      i + 1 < points.length ? perpendicular(points[i] as never, points[i + 1] as never) : null;
    const a = before ?? after;
    const b = after ?? before;
    if (!a || !b) {
      out.push({ x: 0, z: 0 });
      continue;
    }

    let mx = a.x + b.x;
    let mz = a.z + b.z;
    const length = Math.hypot(mx, mz);
    if (length < 1e-6) {
      // The road doubles back on itself; there is no sane bisector.
      out.push({ x: a.x * half, z: a.z * half });
      continue;
    }
    mx /= length;
    mz /= length;

    // 1/cos(half-angle), which is what keeps the outer edge parallel.
    const stretch = Math.min(MAX_MITRE, 1 / Math.max(1e-3, mx * a.x + mz * a.z));
    out.push({ x: mx * half * stretch, z: mz * half * stretch });
  }

  // An end that meets a junction piece is squared to the piece, not to the
  // run. Turned to the run's left, which is the side the offset is added on.
  const square = (index: number, edge: Vec | null | undefined, along: Vec | null): void => {
    if (!edge || !along) return;
    const flip = edge.x * along.x + edge.z * along.z < 0 ? -1 : 1;
    out[index] = { x: edge.x * flip, z: edge.z * flip };
  };
  const last = points.length - 1;
  if (last > 0) {
    square(0, ends.start, perpendicular(points[0] as never, points[1] as never));
    square(last, ends.end, perpendicular(points[last - 1] as never, points[last] as never));
  }

  return out;
}

/** Edges forced at a run's ends, where it meets a junction piece. */
interface RoadEnds {
  readonly start?: Vec | null;
  readonly end?: Vec | null;
}

/** Append one polyline's ribbon to the buffers. */
function addRibbon(
  buffers: Buffers,
  road: RoadPolyline,
  type: RoadType,
  groundY: (x: number, z: number) => number,
  ends: RoadEnds = {},
): void {
  const points = road.points;
  if (points.length < 2) return;

  const half = type.width / 2;
  const mitres = offsets(points, half, ends);

  let distance = 0;
  let previous = -1;

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as { x: number; z: number };
    const b = points[i + 1] as { x: number; z: number };
    const oa = mitres[i] as { x: number; z: number };
    const ob = mitres[i + 1] as { x: number; z: number };
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-6) continue;

    const steps = Math.max(1, Math.ceil(length / STEP));
    // The first cross-section of a segment is the last of the one before it,
    // so it is only emitted for the very first segment. Emitting it twice
    // leaves a seam where the two copies disagree about the mitre.
    for (let step = previous < 0 ? 0 : 1; step <= steps; step++) {
      const t = step / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const ox = (oa.x + (ob.x - oa.x) * t) as number;
      const oz = (oa.z + (ob.z - oa.z) * t) as number;
      const u = (distance + length * t) / type.repeat;

      for (const side of [-1, 1]) {
        const px = x + ox * side;
        const pz = z + oz * side;
        buffers.positions.push(px, groundY(px, pz) + LIFT, pz);
        buffers.normals.push(0, 1, 0);
        // `side` -1 is the right-hand edge, looking along the road: the offset
        // is its left normal, subtracted. The source puts the larger v there.
        buffers.uvs.push(u, side < 0 ? type.v0 : type.v1);
      }

      const current = buffers.positions.length / 3 - 2;
      if (previous >= 0) {
        // Babylon is left-handed, so a front face is clockwise seen from the
        // front, which for ground viewed from above means the right-hand-rule
        // cross product of every triangle has to point *down*. Wound the other
        // way the ribbon is back-facing and vanishes completely with culling
        // on — no z-fighting, no flicker, just no road. The same trap as the
        // terrain mesh, and `test/terrain.test.ts` asserts it there.
        buffers.indices.push(previous, current, previous + 1);
        buffers.indices.push(previous + 1, current, current + 1);
      }
      previous = current;
    }

    distance += length;
  }
}

/** Positions closer than this are the same point; the importer uses the same. */
const pointKey = (p: Vec): string => `${Math.round(p.x * 1000)},${Math.round(p.z * 1000)}`;

/**
 * Cut runs wherever a third run meets them.
 *
 * A junction is where three or more segments share a point, but a run can
 * pass straight through one: whichever of the arms is chained last continues
 * the run it meets. Counting segment ends rather than run ends finds those
 * too, and splitting there makes every junction the end of all its arms.
 */
export function splitAtJunctions(runs: readonly RoadPolyline[]): RoadPolyline[] {
  const degree = new Map<string, number>();
  for (const run of runs) {
    for (let i = 0; i < run.points.length; i++) {
      const ends = (i > 0 ? 1 : 0) + (i + 1 < run.points.length ? 1 : 0);
      const key = pointKey(run.points[i] as RoadPoint);
      degree.set(key, (degree.get(key) ?? 0) + ends);
    }
  }

  const out: RoadPolyline[] = [];
  for (const run of runs) {
    let start = 0;
    for (let i = 1; i + 1 < run.points.length; i++) {
      if ((degree.get(pointKey(run.points[i] as RoadPoint)) ?? 0) < 3) continue;
      out.push({ type: run.type, points: run.points.slice(start, i + 1) });
      start = i;
    }
    out.push(start === 0 ? run : { type: run.type, points: run.points.slice(start) });
  }
  return out;
}

export interface JoinedRoads {
  /** The runs, their ends at a junction moved to meet its piece. */
  readonly runs: readonly { road: RoadPolyline; ends: RoadEnds }[];
  readonly patches: readonly JunctionPatch[];
}

/**
 * Find where runs of one type meet, and lay a junction piece at each.
 *
 * Three arms make a T, a slanted T or a Y and four a crossroads, chosen from
 * their angles in `roadjunctions.ts`. Five or more have no piece in the
 * texture, and are left as they are, as the source leaves them.
 */
export function joinRoads(runs: readonly RoadPolyline[], type: RoadType): JoinedRoads {
  const split = splitAtJunctions(runs);
  const points = split.map((run) => [...run.points]);
  const ends: { start?: Vec | null; end?: Vec | null }[] = split.map(() => ({}));
  const patches: JunctionPatch[] = [];
  const pieces = type.pieces;
  if (!pieces) return { runs: split.map((road) => ({ road, ends: {} })), patches };

  // Every run end, by where it is.
  const at = new Map<string, { run: number; first: boolean }[]>();
  points.forEach((run, index) => {
    if (run.length < 2) return;
    for (const first of [true, false]) {
      const key = pointKey((first ? run[0] : run[run.length - 1]) as RoadPoint);
      const list = at.get(key);
      if (list) list.push({ run: index, first });
      else at.set(key, [{ run: index, first }]);
    }
  });

  const widthInTexture = type.width / type.scale;
  for (const arms of at.values()) {
    if (arms.length !== 3 && arms.length !== 4) continue;
    const first = arms[0] as (typeof arms)[number];
    const firstRun = points[first.run] as RoadPoint[];
    const centre = (first.first ? firstRun[0] : firstRun[firstRun.length - 1]) as RoadPoint;

    const directions: Arm[] = arms.map(({ run, first: isFirst }) => {
      const list = points[run] as RoadPoint[];
      const next = (isFirst ? list[1] : list[list.length - 2]) as RoadPoint;
      return { dir: { x: next.x - centre.x, z: next.z - centre.z } };
    });
    const junction =
      arms.length === 3
        ? threeWay(centre, directions as [Arm, Arm, Arm], type.scale, widthInTexture, pieces)
        : fourWay(centre, directions as [Arm, Arm, Arm, Arm], type.scale, widthInTexture, pieces);

    arms.forEach(({ run, first: isFirst }, i) => {
      const end = junction.ends[i];
      if (!end) return;
      const list = points[run] as RoadPoint[];
      const index = isFirst ? 0 : list.length - 1;
      list[index] = { x: end.at.x, z: end.at.z };
      const record = ends[run] as { start?: Vec | null; end?: Vec | null };
      if (isFirst) record.start = end.edge;
      else record.end = end.edge;
    });
    patches.push(junction.patch);
  }

  return {
    runs: split.map((run, i) => ({
      road: { type: run.type, points: points[i] as RoadPoint[] },
      ends: ends[i] as RoadEnds,
    })),
    patches,
  };
}

/**
 * Append a junction piece, cut to about a cell so it follows the ground like
 * the ribbon does.
 */
function addPatch(
  buffers: Buffers,
  piece: JunctionPatch,
  groundY: (x: number, z: number) => number,
): void {
  const [bottomLeft, bottomRight, topRight, topLeft] = piece.corners;
  const columns = Math.max(
    1,
    Math.ceil(Math.hypot(bottomRight.x - bottomLeft.x, bottomRight.z - bottomLeft.z) / STEP),
  );
  const rows = Math.max(
    1,
    Math.ceil(Math.hypot(topLeft.x - bottomLeft.x, topLeft.z - bottomLeft.z) / STEP),
  );
  const base = buffers.positions.length / 3;

  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    for (let column = 0; column <= columns; column++) {
      const s = column / columns;
      const x =
        bottomLeft.x * (1 - s) * (1 - t) + bottomRight.x * s * (1 - t) +
        topRight.x * s * t + topLeft.x * (1 - s) * t;
      const z =
        bottomLeft.z * (1 - s) * (1 - t) + bottomRight.z * s * (1 - t) +
        topRight.z * s * t + topLeft.z * (1 - s) * t;
      const dx = x - piece.origin.x;
      const dz = z - piece.origin.z;
      buffers.positions.push(x, groundY(x, z) + LIFT, z);
      buffers.normals.push(0, 1, 0);
      buffers.uvs.push(
        piece.u0 + (dx * piece.uAxis.x + dz * piece.uAxis.z) / piece.span,
        piece.v0 - (dx * piece.vAxis.x + dz * piece.vAxis.z) / piece.span,
      );
    }
  }

  // Wound so the right-hand-rule normal points down, as the ribbon is: a
  // piece can arrive mirrored, so the order is decided from its corners.
  const e1x = bottomRight.x - bottomLeft.x;
  const e1z = bottomRight.z - bottomLeft.z;
  const e2x = topLeft.x - bottomLeft.x;
  const e2z = topLeft.z - bottomLeft.z;
  const upward = e1z * e2x - e1x * e2z > 0;
  const stride = columns + 1;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = base + row * stride + column;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      if (upward) buffers.indices.push(a, c, b, b, c, d);
      else buffers.indices.push(a, b, c, b, d, c);
    }
  }
}

/**
 * Build the roads for a map.
 *
 * Runs whose type has no entry in the pack are skipped; the alternative is
 * drawing a rail line with a pavement texture.
 */
export function createRoads(
  scene: Scene,
  baseUrl: string,
  types: ReadonlyMap<string, RoadType>,
  roads: readonly RoadPolyline[],
  groundY: (x: number, z: number) => number,
): RoadRenderer {
  const byType = new Map<string, RoadPolyline[]>();
  for (const road of roads) {
    if (!types.has(road.type)) continue;
    const list = byType.get(road.type);
    if (list) list.push(road);
    else byType.set(road.type, [road]);
  }

  const meshes: Mesh[] = [];
  let count = 0;

  for (const [id, list] of byType) {
    const type = types.get(id) as RoadType;
    const buffers: Buffers = { positions: [], normals: [], uvs: [], indices: [] };
    const joined = joinRoads(list, type);
    for (const { road, ends } of joined.runs) {
      addRibbon(
        buffers,
        { type: road.type, points: smoothCorners(road.points, type.scale) },
        type,
        groundY,
        ends,
      );
    }
    // After the ribbons, so the pieces draw over the arms they overlap: the
    // source draws its junctions last for the same reason.
    for (const piece of joined.patches) addPatch(buffers, piece, groundY);
    if (buffers.indices.length === 0) continue;

    const material = new StandardMaterial(`road_${id}`, scene);
    const texture = new Texture(`${baseUrl}/${type.texture}`, scene, true, false);
    // Along the road the texture repeats; across it the tile is one slice of
    // an atlas, so wrapping there would bleed in the corner pieces below it.
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    texture.hasAlpha = true;
    material.diffuseTexture = texture;
    // The shoulders fade out rather than stopping, so this blends rather than
    // alpha-tests: a hard edge against the terrain is exactly what the fade is
    // there to avoid.
    material.useAlphaFromDiffuseTexture = true;
    material.specularColor = new Color3(0, 0, 0);
    material.backFaceCulling = true;
    // The ribbon is a lid on the terrain and never has anything between it and
    // the camera, so it can skip depth writes and avoid fighting the ground.
    material.disableDepthWrite = true;
    // A road is painted on the ground, so it is fogged exactly as the ground is.
    fogMaterial(material);

    const mesh = new Mesh(`road_${id}`, scene);
    const data = new VertexData();
    data.positions = buffers.positions;
    data.normals = buffers.normals;
    data.uvs = buffers.uvs;
    data.indices = buffers.indices;
    data.applyToMesh(mesh, false);
    mesh.material = material;
    mesh.isPickable = false;
    // Painted on the ground, so it takes the shadows the ground does.
    receiveShadow(mesh);
    meshes.push(mesh);
    count += list.length;
  }

  return {
    count,
    types: meshes.length,
    dispose() {
      for (const mesh of meshes) {
        mesh.material?.dispose(true, true);
        mesh.dispose();
      }
      meshes.length = 0;
    },
  };
}
