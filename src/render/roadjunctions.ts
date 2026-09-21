/**
 * Where roads meet: a junction piece from the road's own texture, with the
 * arms trimmed back to meet it.
 *
 * A road texture is an atlas. Besides the straight strip there is a T, a Y, a
 * slanted T and a crossroads, each already painted with the kerbs and markings
 * a junction needs. Ending every run at the junction's centre instead lays
 * three or four square-ended ribbons over one another, and their centre lines
 * cross in the middle of the road.
 *
 * This is a port of `W3DRoadBuffer::insertTee`, `insertY` and `insert4Way`
 * and the `load*` functions that draw them. Three things it keeps from the
 * source:
 *
 * - **The shape is chosen from the angles.** Three arms make a Y when none of
 *   them is nearly straight across from another, a T when two are and the
 *   third leaves square, and a slanted T when it leaves at more than 30
 *   degrees off square.
 * - **The arms are moved, not just cut.** Each arm's end is put on the
 *   piece's own axis, and its edge squared to that axis rather than to the
 *   arm, so a road that arrives at a slight angle still meets the piece flush.
 * - **Texture coordinates are measured from the junction's centre** along the
 *   piece's axes, `u = u0 + along / 4w` and `v = v0 - across / 4w`, exactly as
 *   the straight strip is.
 *
 * Only roads of the same type join, as in the source; a pavement ending on a
 * road is drawn over it rather than merged into it.
 *
 * The constants are the source's. They are fractions of a road width and are
 * matched to where each piece sits in the atlas, so they are not tunable.
 */

export interface Vec {
  readonly x: number;
  readonly z: number;
}

/** Where each junction piece is centred in a road's texture, in texture units. */
export interface JunctionPieces {
  readonly tee: readonly [number, number];
  readonly fourWay: readonly [number, number];
  readonly y: readonly [number, number];
  readonly h: readonly [number, number];
}

/** One arm of a junction, looking out from its centre. */
export interface Arm {
  /** Unit vector from the centre toward the arm's next point. */
  readonly dir: Vec;
}

/** Where an arm now ends, and its half-width edge vector there. */
export interface ArmEnd {
  readonly at: Vec;
  /**
   * The ribbon's half-width offset at that end, unsigned: the caller turns it
   * to whichever side it needs. `null` keeps the arm's own perpendicular.
   */
  readonly edge: Vec | null;
}

/** A quadrilateral cut from the atlas. */
export interface JunctionPatch {
  /** Bottom-left, bottom-right, top-right, top-left, as the source names them. */
  readonly corners: readonly [Vec, Vec, Vec, Vec];
  /** Where the texture coordinates are `(u0, v0)`. */
  readonly origin: Vec;
  /** Unit axis along which `u` grows. */
  readonly uAxis: Vec;
  /** Unit axis along which `v` shrinks. */
  readonly vAxis: Vec;
  readonly u0: number;
  readonly v0: number;
  /** World distance per texture unit: four road widths. */
  readonly span: number;
}

export interface Junction {
  readonly kind: 'tee' | 'h' | 'y' | 'fourWay';
  readonly ends: readonly ArmEnd[];
  readonly patch: JunctionPatch;
}

const TEE_WIDTH_ADJUSTMENT = 1.03;
const COS30 = 0.866;
const COS45 = 0.707;

const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, z: a.z + b.z });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, z: a.z - b.z });
const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, z: a.z * s });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.z * b.z;
const cross = (a: Vec, b: Vec): number => a.x * b.z - a.z * b.x;
const sign = (a: Vec, b: Vec): number => Math.sign(cross(a, b));
/** The source's left normal, `(-y, x)`. */
const perp = (a: Vec): Vec => ({ x: -a.z, z: a.x });
function unit(a: Vec): Vec {
  const length = Math.hypot(a.x, a.z);
  return length < 1e-9 ? { x: 1, z: 0 } : { x: a.x / length, z: a.z / length };
}
/** Counter-clockwise, as `Vector2::Rotate`. */
function rotate(a: Vec, angle: number): Vec {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return { x: a.x * c - a.z * s, z: a.x * s + a.z * c };
}

/** `loadFloat4PtSection`'s texture frame, for a piece whose u runs along `along`. */
function patch(
  corners: [Vec, Vec, Vec, Vec],
  origin: Vec,
  along: Vec,
  normal: Vec,
  piece: readonly [number, number],
  scale: number,
): JunctionPatch {
  return {
    corners,
    origin,
    uAxis: unit(along),
    vAxis: unit(normal),
    u0: piece[0],
    v0: piece[1],
    span: 4 * scale,
  };
}

/** `loadFloatSection` for a T or crossroads: centred on `loc`, stem along `stem`. */
function teePatch(
  loc: Vec,
  stem: Vec,
  widthInTexture: number,
  piece: readonly [number, number],
  scale: number,
): JunctionPatch {
  const along = unit(stem);
  const tee = (scale * TEE_WIDTH_ADJUSTMENT) / 2;
  const left = (widthInTexture * scale) / 2;
  const normal = mul(perp(along), tee);
  const length = mul(along, tee + left);
  const bottomLeft = sub(sub(loc, mul(along, left)), normal);
  const bottomRight = add(bottomLeft, length);
  return patch(
    [bottomLeft, bottomRight, add(bottomRight, mul(normal, 2)), add(bottomLeft, mul(normal, 2))],
    loc,
    along,
    normal,
    piece,
    scale,
  );
}

/** `insertY`: a Y, or null when the arms do not make one. */
function yJunction(
  loc: Vec,
  v: readonly [Vec, Vec, Vec],
  scale: number,
  widthInTexture: number,
  pieces: JunctionPieces,
): Junction | null {
  const [v1, v2, v3] = v;
  const dot12 = dot(v1, v2);
  const dot13 = dot(v1, v3);
  const dot32 = dot(v3, v2);
  // Too close to a straight line: a T suits it better.
  if (dot12 < -COS30 || dot13 < -COS30 || dot32 < -COS30) return null;

  let do12 = false;
  let do13 = false;
  let do32 = false;
  let score12 = 2;
  let score13 = 2;
  let score32 = 2;

  // Each arm in turn is tried as the stem, with the other two as legs: they
  // must fall either side of it, and both behind it.
  if (sign(v1, v2) + sign(v1, v3) === 0 && sign(v1, v2) !== sign(v1, v3)) {
    const across = perp(v1);
    if (sign(across, v2) === 1 && sign(across, v3) === 1) {
      do32 = true;
      score32 = Math.abs(dot12 + COS45) + Math.abs(dot13 + COS45);
    }
  }
  if (sign(v3, v1) + sign(v3, v2) === 0 && sign(v3, v1) !== sign(v3, v2)) {
    const across = perp(v3);
    if (sign(across, v2) === 1 && sign(across, v1) === 1) {
      do12 = true;
      score12 = Math.abs(dot13 + COS45) + Math.abs(dot32 + COS45);
    }
  }
  if (sign(v2, v1) + sign(v2, v3) === 0 && sign(v2, v1) !== sign(v2, v3)) {
    const across = perp(v2);
    if (sign(across, v3) === 1 && sign(across, v1) === 1) {
      do13 = true;
      score13 = Math.abs(dot12 + COS45) + Math.abs(dot32 + COS45);
    }
  }

  // The lowest score wins, with the source's tie-breaking.
  if (score12 < score13) {
    do13 = false;
    if (score12 < score32) do32 = false;
    else do12 = false;
  } else {
    do12 = false;
    if (score13 < score32) do32 = false;
    else do13 = false;
  }

  // [first leg, second leg, stem], as the source orders them.
  let legs: [number, number, number];
  if (do12) legs = [0, 1, 2];
  else if (do13) legs = [0, 2, 1];
  else if (do32) legs = [2, 1, 0];
  else return null;
  const [a, b, s] = legs;

  const up = mul(unit(v[s] as Vec), 0.5 * scale);
  const tee = rotate(up, -Math.PI / 2);

  // `offsetY`: the stem slides out along itself and keeps its own edge; the
  // legs move onto the piece's two diagonals, squared to them.
  const [right, left] = sign(v[s] as Vec, v[a] as Vec) === -1 ? [a, b] : [b, a];
  const ends: ArmEnd[] = [];
  ends[s] = { at: add(loc, mul(up, 0.55)), edge: null };
  const leftArm = rotate(up, (3 * Math.PI) / 4);
  ends[left] = { at: add(loc, mul(leftArm, 1.1)), edge: mul(perp(leftArm), widthInTexture) };
  const rightArm = rotate(up, (-3 * Math.PI) / 4);
  ends[right] = { at: add(loc, mul(rightArm, 1.1)), edge: mul(perp(rightArm), widthInTexture) };

  // `loadY`.
  const along = unit(tee);
  const vector = mul(along, scale * 1.59);
  const normal = mul(perp(along), scale);
  const topLeft = sub(add(loc, mul(normal, 0.29)), mul(vector, 0.5));
  const bottomLeft = sub(topLeft, mul(normal, 1.08));
  return {
    kind: 'y',
    ends,
    patch: patch(
      [bottomLeft, add(bottomLeft, vector), add(topLeft, vector), topLeft],
      loc,
      along,
      normal,
      pieces.y,
      scale,
    ),
  };
}

/** `insertTee`: a Y if the angles allow, otherwise a T or a slanted T. */
export function threeWay(
  loc: Vec,
  arms: readonly [Arm, Arm, Arm],
  scale: number,
  widthInTexture: number,
  pieces: JunctionPieces,
): Junction {
  const v = arms.map((arm) => unit(arm.dir)) as [Vec, Vec, Vec];
  const y = yJunction(loc, v, scale, widthInTexture, pieces);
  if (y) return y;

  const [v1, v2, v3] = v;
  const dot12 = dot(v1, v2);
  const dot13 = dot(v1, v3);
  const dot32 = dot(v3, v2);
  // The pair heading most nearly opposite is the road straight through.
  let pair: [number, number, number];
  if (dot12 < dot13) pair = dot12 < dot32 ? [0, 1, 2] : [2, 1, 0];
  else pair = dot13 < dot32 ? [0, 2, 1] : [2, 1, 0];
  const [a, b, c] = pair;

  const upUnit = unit(sub(v[b] as Vec, v[a] as Vec));
  const decider = v[c] as Vec;
  const up = mul(upUnit, 0.5 * scale);
  const turn = cross(upUnit, decider) < 0 ? -1 : 1;
  const tee = rotate(up, (turn * Math.PI) / 2);
  const through = mul(tee, widthInTexture);
  const ends: ArmEnd[] = [];

  if (Math.abs(dot(upUnit, decider)) > 0.5) {
    // The stem leaves more than 30 degrees off square: the slanted piece.
    const mirror = turn < 0;
    const flip = sign(tee, decider) === 1;
    const [back, forward] = flip !== mirror ? [2.05, 0.46] : [0.46, 2.05];
    ends[a] = { at: sub(loc, mul(up, back)), edge: through };
    ends[b] = { at: add(loc, mul(up, forward)), edge: through };
    const arm = rotate(tee, flip ? Math.PI / 4 : -Math.PI / 4);
    ends[c] = { at: add(loc, mul(arm, 2.1)), edge: mul(perp(arm), widthInTexture) };

    // `loadH`.
    const along = unit(tee);
    const vector = mul(along, scale);
    let normal = mul(perp(along), scale * 1.35);
    const bottomLeft = sub(
      sub(loc, mul(normal, flip ? 0.2 : 0.8)),
      mul(vector, widthInTexture / 2),
    );
    const width = add(mul(vector, widthInTexture / 2), mul(vector, 1.2));
    const bottomRight = add(bottomLeft, width);
    const corners: [Vec, Vec, Vec, Vec] = [
      bottomLeft,
      bottomRight,
      add(bottomRight, normal),
      add(bottomLeft, normal),
    ];
    if (flip) normal = mul(normal, -1);
    return { kind: 'h', ends, patch: patch(corners, loc, along, normal, pieces.h, scale) };
  }

  ends[a] = { at: sub(loc, up), edge: through };
  ends[b] = { at: add(loc, up), edge: through };
  ends[c] = { at: add(loc, tee), edge: mul(up, widthInTexture) };
  return { kind: 'tee', ends, patch: teePatch(loc, tee, widthInTexture, pieces.tee, scale) };
}

/** `insert4Way`: the crossroads, squared to the straightest pair of arms. */
export function fourWay(
  loc: Vec,
  arms: readonly [Arm, Arm, Arm, Arm],
  scale: number,
  widthInTexture: number,
  pieces: JunctionPieces,
): Junction {
  const v = arms.map((arm) => unit(arm.dir));
  // Every pair, in the source's order, with the other two as they are passed
  // on to `offset4Way`.
  const pairs: [number, number, number, number][] = [
    [0, 1, 2, 3],
    [0, 2, 1, 3],
    [0, 3, 2, 1],
    [1, 2, 0, 3],
    [1, 3, 0, 2],
    [2, 3, 0, 1],
  ];
  let best = pairs[0] as [number, number, number, number];
  let bestDot = Infinity;
  for (const candidate of pairs) {
    const d = dot(v[candidate[0]] as Vec, v[candidate[1]] as Vec);
    if (d < bestDot) {
      bestDot = d;
      best = candidate;
    }
  }
  const [a, b, c, d] = best;

  let align = mul(unit(sub(v[b] as Vec, v[a] as Vec)), 0.5 * scale);
  const tee = rotate(align, cross(align, v[c] as Vec) < 0 ? -Math.PI / 2 : Math.PI / 2);
  const through = mul(rotate(align, Math.PI / 2), widthInTexture);
  const ends: ArmEnd[] = [];
  ends[a] = { at: sub(loc, align), edge: through };
  ends[b] = { at: add(loc, align), edge: through };
  ends[c] = { at: add(loc, tee), edge: mul(align, widthInTexture) };
  ends[d] = { at: sub(loc, tee), edge: mul(align, widthInTexture) };

  // The piece is symmetrical, so it is always laid facing +x.
  if (align.x < 0) align = mul(align, -1);
  return {
    kind: 'fourWay',
    ends,
    patch: teePatch(loc, align, TEE_WIDTH_ADJUSTMENT, pieces.fourWay, scale),
  };
}
