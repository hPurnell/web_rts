/**
 * The heightfield, and everything derived from it.
 *
 * This is the module the rest of the project asks about the ground. It owns
 * three decisions that everything downstream depends on, so they are made once
 * here rather than re-derived:
 *
 *  - **Heights live on cell corners**, not cell centres. A map of w x h cells
 *    has a (w+1) x (h+1) grid of corner heights. Corners are shared, so two
 *    adjacent cells cannot disagree about where their common edge is: the
 *    surface has no cracks by construction, and a cell's slope is exactly
 *    defined by its four corners.
 *
 *  - **A cell is two triangles split north-west to south-east.** The split has
 *    to be fixed and shared. The renderer, the picker and this module all
 *    interpolate the same way, or a unit stands a few centimetres off the
 *    ground it is being shot on.
 *
 *  - **Heights are Q16.16.** A heightfield invites floats, and a float in a
 *    height is a float in a slope, which is a float in a path cost, which is a
 *    desync (invariant 2).
 */
import type { Fixed } from './fixed.ts';
import { ONE, abs, add, div, length, mul, sub } from './fixed.ts';

/**
 * Rise over run above which ground is a cliff rather than a hill.
 *
 * 0.55 is about 29 degrees. Everything about how a map plays — where the
 * chokepoints are, which hills are strongpoints, whether a sculpted ramp
 * actually works — comes out of this one number.
 */
export const MAX_TRAVERSABLE_SLOPE: Fixed = 36045; // 0.55

/**
 * Flattest-ground requirement for a building footprint.
 *
 * Much stricter than walking: ground you can march up is not ground you can
 * put a factory on, and finding somewhere flat is meant to be a decision.
 */
export const MAX_BUILD_SLOPE: Fixed = 7864; // 0.12

/**
 * How much slope adds to movement cost, as a multiplier on the cost grid's
 * base cost at maximum traversable slope. This is what makes paths curve
 * around hills instead of marching over them.
 */
export const SLOPE_COST_SCALE: Fixed = 196608;

/**
 * How much an uphill gradient costs in speed, as a fraction per unit of rise
 * over run. One means the steepest walkable climb lands exactly on the floor
 * below, which is a tidier thing to explain than an arbitrary constant.
 */
export const UPHILL_PENALTY: Fixed = 65536; // 1.0
/** The downhill equivalent. Far smaller: gravity helps less than it hinders. */
export const DOWNHILL_BONUS: Fixed = 16384; // 0.25
/** Clamps, so terrain can never make a unit faster than its type says. */
export const MIN_SPEED_SCALE: Fixed = 29491; // 0.45
export const MAX_SPEED_SCALE: Fixed = 75366; // 1.15 // 3.0

/** Range the editor may sculpt within, kept well inside Q16.16. */
export const HEIGHT_MIN: Fixed = 0;
export const HEIGHT_MAX: Fixed = 2097152; // 32 world units

/** sqrt(2), for diagonal steps, so no square root is needed at runtime. */
const SQRT2: Fixed = 92682;

/** The minimal shape of a world this module needs. */
export interface HeightfieldWorld {
  readonly width: number;
  readonly height: number;
  readonly cellSize: Fixed;
  readonly heights: Int32Array;
}

// --- corner addressing ------------------------------------------------------

/** Corners per row. One more than cells, because corners are shared. */
export function cornerStride(world: HeightfieldWorld): number {
  return world.width + 1;
}

export function cornerCount(world: HeightfieldWorld): number {
  return (world.width + 1) * (world.height + 1);
}

/** Corner index from corner coordinates, clamped to the map. */
export function cornerIndex(world: HeightfieldWorld, cx: number, cz: number): number {
  const x = cx < 0 ? 0 : cx > world.width ? world.width : cx;
  const z = cz < 0 ? 0 : cz > world.height ? world.height : cz;
  return z * cornerStride(world) + x;
}

/**
 * The four corners of a cell, in the order NW, NE, SE, SW.
 *
 * Every consumer that walks a cell's corners uses this order, so the triangle
 * split below and the mesh in the renderer describe the same two triangles.
 */
export function cellCorners(world: HeightfieldWorld, cell: number): [number, number, number, number] {
  const cx = cell % world.width;
  const cz = (cell / world.width) | 0;
  const stride = cornerStride(world);
  const top = cz * stride + cx;
  return [top, top + 1, top + stride + 1, top + stride];
}

// --- height overrides -------------------------------------------------------

/**
 * Terrain a match has changed, held separately from the authored heightfield.
 *
 * Invariant 5: the simulation may level ground under a building, but it may
 * not edit the map. Overrides live in match state, are discarded at match end,
 * and are part of the determinism hash.
 *
 * Stored as a pair list rather than a full copy of the heightfield: the only
 * writer is footprint levelling, so this holds tens of entries, not a megabyte.
 * The Map is a derived lookup index and is deliberately not hashed.
 */
export interface HeightOverrides {
  count: number;
  corner: Int32Array;
  height: Int32Array;
  readonly index: Map<number, number>;
}

export function createHeightOverrides(capacity = 256): HeightOverrides {
  return {
    count: 0,
    corner: new Int32Array(capacity),
    height: new Int32Array(capacity),
    index: new Map(),
  };
}

export function setOverride(overrides: HeightOverrides, corner: number, height: Fixed): void {
  const existing = overrides.index.get(corner);
  if (existing !== undefined) {
    overrides.height[existing] = height;
    return;
  }
  if (overrides.count >= overrides.corner.length) {
    const grown = new Int32Array(overrides.corner.length * 2);
    grown.set(overrides.corner);
    overrides.corner = grown;
    const grownHeights = new Int32Array(overrides.height.length * 2);
    grownHeights.set(overrides.height);
    overrides.height = grownHeights;
  }
  overrides.index.set(corner, overrides.count);
  overrides.corner[overrides.count] = corner;
  overrides.height[overrides.count] = height;
  overrides.count++;
}

export function clearOverrides(overrides: HeightOverrides): void {
  overrides.count = 0;
  overrides.index.clear();
}

export function overrideHashableArrays(
  overrides: HeightOverrides,
): { name: string; data: ArrayBufferView }[] {
  return [
    { name: 'terrain.overrideCorner', data: overrides.corner.subarray(0, overrides.count) },
    { name: 'terrain.overrideHeight', data: overrides.height.subarray(0, overrides.count) },
  ];
}

// --- sampling ---------------------------------------------------------------

/** Height at a corner, honouring a match's overrides when one is given. */
export function cornerHeight(
  world: HeightfieldWorld,
  corner: number,
  overrides?: HeightOverrides | null,
): Fixed {
  if (overrides) {
    const slot = overrides.index.get(corner);
    if (slot !== undefined) return overrides.height[slot] as number;
  }
  return world.heights[corner] as number;
}

/**
 * Height of the terrain surface at a world position.
 *
 * Interpolated across whichever of the cell's two triangles the point falls
 * in, not bilinearly: the mesh is triangles, and only planar interpolation
 * agrees with it exactly. Points outside the map clamp to the nearest edge.
 */
export function heightAt(
  world: HeightfieldWorld,
  x: Fixed,
  z: Fixed,
  overrides?: HeightOverrides | null,
): Fixed {
  const cellX = div(x, world.cellSize);
  const cellZ = div(z, world.cellSize);

  let cx = cellX >> 16;
  let cz = cellZ >> 16;
  if (cx < 0) cx = 0;
  if (cz < 0) cz = 0;
  if (cx >= world.width) cx = world.width - 1;
  if (cz >= world.height) cz = world.height - 1;

  // Fractional position within the cell, clamped so an out-of-bounds sample
  // reads the edge rather than extrapolating off it.
  let fx = cellX - (cx << 16);
  let fz = cellZ - (cz << 16);
  if (fx < 0) fx = 0;
  if (fz < 0) fz = 0;
  if (fx > ONE) fx = ONE;
  if (fz > ONE) fz = ONE;

  const stride = cornerStride(world);
  const top = cz * stride + cx;
  const nw = cornerHeight(world, top, overrides);
  const ne = cornerHeight(world, top + 1, overrides);
  const se = cornerHeight(world, top + stride + 1, overrides);
  const sw = cornerHeight(world, top + stride, overrides);

  // The diagonal runs NW to SE, so fz <= fx is the north-east triangle.
  if (fz <= fx) {
    return add(nw, add(mul(sub(ne, nw), fx), mul(sub(se, ne), fz)));
  }
  return add(nw, add(mul(sub(se, sw), fx), mul(sub(sw, nw), fz)));
}

// --- slope ------------------------------------------------------------------

/** Largest height difference across a cell's four corners. */
export function cellRelief(
  world: HeightfieldWorld,
  cell: number,
  overrides?: HeightOverrides | null,
): Fixed {
  const [nw, ne, se, sw] = cellCorners(world, cell);
  const a = cornerHeight(world, nw, overrides);
  const b = cornerHeight(world, ne, overrides);
  const c = cornerHeight(world, se, overrides);
  const d = cornerHeight(world, sw, overrides);
  const lo = Math.min(Math.min(a, b), Math.min(c, d));
  const hi = Math.max(Math.max(a, b), Math.max(c, d));
  return sub(hi, lo);
}

/**
 * A cell's slope as rise over run.
 *
 * Only call this when the actual number is wanted — for a comparison, use
 * `slopeAtMost`, which needs one multiply where this needs a divide.
 */
export function cellSlope(
  world: HeightfieldWorld,
  cell: number,
  overrides?: HeightOverrides | null,
): Fixed {
  return div(cellRelief(world, cell, overrides), world.cellSize);
}

/**
 * Whether a cell's slope is at most `limit`, without dividing.
 *
 * relief / cellSize <= limit  becomes  relief <= limit * cellSize.
 */
export function slopeAtMost(
  world: HeightfieldWorld,
  cell: number,
  limit: Fixed,
  overrides?: HeightOverrides | null,
): boolean {
  return cellRelief(world, cell, overrides) <= mul(limit, world.cellSize);
}

/**
 * Whether the step between two adjacent cells is walkable.
 *
 * Separate from each cell's own slope, and not implied by it: two cells can
 * both be flat with a cliff face between them. Checking only the cells would
 * let units walk off a ledge.
 *
 * Diagonal steps cover sqrt(2) cells, which is a constant rather than a
 * runtime square root.
 */
export function stepSlopeAtMost(
  world: HeightfieldWorld,
  fromCell: number,
  toCell: number,
  limit: Fixed,
  overrides?: HeightOverrides | null,
): boolean {
  const fromX = fromCell % world.width;
  const fromZ = (fromCell / world.width) | 0;
  const toX = toCell % world.width;
  const toZ = (toCell / world.width) | 0;
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  if (dx === 0 && dz === 0) return true;

  const rise = abs(sub(cellCentreHeight(world, toCell, overrides), cellCentreHeight(world, fromCell, overrides)));
  const run = dx !== 0 && dz !== 0 ? mul(world.cellSize, SQRT2) : world.cellSize;
  return rise <= mul(limit, run);
}

/** Height at the middle of a cell. */
export function cellCentreHeight(
  world: HeightfieldWorld,
  cell: number,
  overrides?: HeightOverrides | null,
): Fixed {
  const [nw, ne, se, sw] = cellCorners(world, cell);
  const a = cornerHeight(world, nw, overrides);
  const b = cornerHeight(world, ne, overrides);
  const c = cornerHeight(world, se, overrides);
  const d = cornerHeight(world, sw, overrides);
  return (((a + b + c + d) / 4) | 0) as Fixed;
}

/**
 * The cell's surface normal, normalised.
 *
 * Used for slope-aware presentation, and available to the simulation because
 * it is computed the same way on every machine. The renderer builds its own
 * smoothed per-vertex normals; this is the flat one for a single cell.
 */
/**
 * How much slower a unit moves going from one cell to the next.
 *
 * At the steepest walkable gradient a unit crawls at `MIN_SPEED_SCALE`, and
 * the same gradient downhill earns a much smaller bonus — falling down a hill
 * is easier than climbing it, but not four times easier. Both directions are
 * clamped, so no amount of terrain makes a unit faster than a unit is.
 *
 * Returns a Q16.16 multiplier. Flat ground returns exactly ONE, which means
 * the overwhelmingly common case costs one comparison.
 */
export function slopeSpeedScale(
  world: HeightfieldWorld,
  fromCell: number,
  toCell: number,
  overrides?: HeightOverrides | null,
): Fixed {
  if (fromCell === toCell || fromCell < 0 || toCell < 0) return ONE;

  const rise = sub(
    cellCentreHeight(world, toCell, overrides),
    cellCentreHeight(world, fromCell, overrides),
  );
  if (rise === 0) return ONE;

  // Rise over run. The run is one cell orthogonally and a little more
  // diagonally; using the cell size for both overstates a diagonal's gradient
  // by 40%, which is not worth a square root in this loop.
  const gradient = div(rise, world.cellSize);
  const scale = sub(ONE, mul(gradient, gradient > 0 ? UPHILL_PENALTY : DOWNHILL_BONUS));

  if (scale < MIN_SPEED_SCALE) return MIN_SPEED_SCALE;
  if (scale > MAX_SPEED_SCALE) return MAX_SPEED_SCALE;
  return scale;
}

export function cellNormal(
  world: HeightfieldWorld,
  cell: number,
  overrides?: HeightOverrides | null,
): { x: Fixed; y: Fixed; z: Fixed } {
  const [nwC, neC, seC, swC] = cellCorners(world, cell);
  const nw = cornerHeight(world, nwC, overrides);
  const ne = cornerHeight(world, neC, overrides);
  const se = cornerHeight(world, seC, overrides);
  const sw = cornerHeight(world, swC, overrides);

  // Central differences across the cell, which is the gradient of the plane
  // that best fits its four corners.
  const dx = div(sub(add(ne, se), add(nw, sw)), mul(world.cellSize, 2 * ONE));
  const dz = div(sub(add(sw, se), add(nw, ne)), mul(world.cellSize, 2 * ONE));

  // The normal of a heightfield is (-dx, 1, -dz), normalised.
  const planar = length(dx, dz);
  const magnitude = length(planar, ONE);
  if (magnitude === 0) return { x: 0, y: ONE, z: 0 };
  return {
    x: div(-dx, magnitude),
    y: div(ONE, magnitude),
    z: div(-dz, magnitude),
  };
}
