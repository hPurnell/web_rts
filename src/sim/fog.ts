/**
 * Fog of war.
 *
 * This lives in the simulation because it gates targeting and ability range:
 * what a player can shoot is decided by what they can see, and two clients
 * that disagreed about that would desync. Every player's grids are computed;
 * only the local player's reaches the GPU.
 *
 * With tiers, vision was a disc stamp and a one-line comparison:
 * `tier[cell] <= tier[unitCell]`. A heightfield has no tiers to compare, and
 * the honest equivalent is a **radial horizon sweep**: walk outward along each
 * ray, track the greatest elevation angle seen so far, and a cell is visible
 * only if it rises above everything nearer. High ground still sees further and
 * into more, but now it does so because of the shape of the ground rather than
 * because of a rule — and a ridge casts a real shadow that units hide in.
 *
 * That costs more than a disc stamp. It is worth it, and the budget in the
 * plan says 6ms rather than 2ms instead of pretending otherwise.
 */
import { MAX_PLAYERS } from './match.ts';
import type { Match } from './match.ts';
import type { World } from './world.ts';
import { VISION_BLOCKER, cellFromWorld } from './world.ts';
import { cellCentreHeight } from './terrain.ts';
import { isqrt, toInt } from './fixed.ts';
import { unitType } from './unittypes.ts';

/** Ticks between recomputes. At 20Hz this is five updates a second. */
export const FOG_INTERVAL_TICKS = 4;

export const VISIBLE = 255;
export const HIDDEN = 0;

/**
 * How far above the ground a unit's eye sits.
 *
 * Without this a unit standing on perfectly flat ground would see nothing at
 * all: every cell would be at exactly its own elevation angle of zero, and the
 * first one would raise the horizon to meet the rest.
 */
const EYE_HEIGHT = 256; // one cell, in the sweep's 1/256 units



export interface FogGrids {
  /**
   * Height at each cell's centre, refreshed once per update.
   *
   * The sweep reads terrain height thousands of times per unit. Sampling the
   * heightfield each time would dominate the whole update; one pass to fill
   * this costs a fraction of that and makes the inner loop an array index.
   */
  cellHeights: Int32Array;
  /**
   * The override version `cellHeights` was filled from, or -1 for never.
   *
   * Refilling it is one pass over the whole map. On a 256x256 map that is
   * 65,536 cells of work every fog update, for a heightfield that changes only
   * when a building levels its footprint — which is to say almost never.
   */
  cellHeightsVersion: number;
  /** Currently in someone's sight radius. Cleared and restamped. */
  readonly visible: Uint8Array[];
  /** Ever seen. OR-accumulated and never cleared. */
  readonly explored: Uint8Array[];
  /**
   * What each player remembers standing on each cell: the structure's type id
   * plus one, or zero for nothing. Updated only where the player can currently
   * see, so a scouted base stays on the map after the scout dies -- and stays
   * as it was, which is the point: the memory can be out of date.
   */
  readonly remembered: Uint8Array[];
  /** Owner of the remembered structure, valid where `remembered` is non-zero. */
  readonly rememberedOwner: Uint8Array[];
  readonly width: number;
  readonly height: number;
}

export function createFogGrids(width: number, height: number): FogGrids {
  const cells = width * height;
  return {
    cellHeights: new Int32Array(cells),
    cellHeightsVersion: -1,
    visible: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    explored: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    remembered: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    rememberedOwner: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    width,
    height,
  };
}

/**
 * The rays for one sight radius, flattened into typed arrays.
 *
 * Held as parallel arrays rather than an array of step objects because this is
 * the hottest loop in the simulation: two hundred units at sight radius nine
 * is well over a hundred thousand steps a fog update, and walking objects
 * costs more in pointer chasing than the arithmetic costs in total.
 *
 * Heights and distances here are in units of 1/256 of a cell, not Q16.16.
 * That keeps the cross-multiplied horizon comparison inside a 32-bit integer
 * with room to spare, so it is two `Math.imul`s and no fixed-point helper.
 */
interface RayTable {
  /** Cell offset of each step, over every ray end to end. */
  readonly dx: Int32Array;
  readonly dz: Int32Array;
  /** Distance from the centre, in 1/256 of a cell. */
  readonly run: Int32Array;
  /** Where each ray starts in the arrays above; one longer than the ray count. */
  readonly starts: Int32Array;
}

/** Rays for a sight radius, cached: the same radius always sweeps the same way. */
const RAY_CACHE = new Map<number, RayTable>();

/** How finely heights and distances are quantised inside the sweep. */
const SUB = 256;

/**
 * Rays from the centre out to every cell on the rim of the bounding square.
 *
 * Walked with a Bresenham line rather than by angle, because angles would need
 * trigonometry and the simulation has none. One ray per perimeter cell gives
 * roughly one ray per cell of circumference, which is the density at which the
 * rim stops showing gaps between rays.
 */
export function visionRays(radius: number): RayTable {
  const key = radius | 0;
  const cached = RAY_CACHE.get(key);
  if (cached) return cached;

  const dx: number[] = [];
  const dz: number[] = [];
  const run: number[] = [];
  const starts: number[] = [0];
  const seen = new Set<number>();

  for (let i = -key; i <= key; i++) {
    for (const [ex, ez] of [
      [i, -key],
      [i, key],
      [-key, i],
      [key, i],
    ] as const) {
      // A ray is identified by its endpoint; the four edges share their corners.
      const signature = (ex + key) * (2 * key + 2) + (ez + key);
      if (seen.has(signature)) continue;
      seen.add(signature);
      walkRay(ex, ez, key, dx, dz, run);
      starts.push(dx.length);
    }
  }

  const table: RayTable = {
    dx: Int32Array.from(dx),
    dz: Int32Array.from(dz),
    run: Int32Array.from(run),
    starts: Int32Array.from(starts),
  };
  RAY_CACHE.set(key, table);
  return table;
}

/** Integer Bresenham walk from the origin to (ex, ez), clipped to the disc. */
function walkRay(
  ex: number,
  ez: number,
  radius: number,
  dx: number[],
  dz: number[],
  run: number[],
): void {
  const adx = Math.abs(ex);
  const adz = Math.abs(ez);
  const sx = ex >= 0 ? 1 : -1;
  const sz = ez >= 0 ? 1 : -1;
  let x = 0;
  let z = 0;
  let error = adx - adz;

  for (let guard = 0; guard < radius * 3; guard++) {
    const doubled = error * 2;
    if (doubled > -adz) {
      error -= adz;
      x += sx;
    }
    if (doubled < adx) {
      error += adx;
      z += sz;
    }
    const distanceSq = x * x + z * z;
    if (distanceSq > radius * radius) break;
    dx.push(x);
    dz.push(z);
    // isqrt takes a whole number: scaling by SUB squared gives the root in
    // units of 1/SUB of a cell, which is the run the comparison divides by.
    run.push(isqrt(distanceSq * SUB * SUB));
    if (x === ex && z === ez) break;
  }
}

/**
 * Recompute visibility for every player, and fold it into explored.
 *
 * One horizon sweep per unit. Elevation angles are compared cross-multiplied
 * rather than divided, so the inner loop has no division and no square root.
 */
export function updateFog(match: Match, world: World): void {
  const fog = match.fog;
  const store = match.units;
  const width = world.width;
  const height = world.height;

  for (let player = 0; player < match.playerCount; player++) {
    (fog.visible[player] as Uint8Array).fill(HIDDEN);
  }

  // One pass to cache the height of every cell, then the sweeps just index it.
  // Stored in 1/256 of a cell rather than Q16.16, which is what lets the
  // horizon comparison be a plain integer multiply.
  //
  // Only refilled when the terrain has actually moved. The world's heightfield
  // cannot change during a match at all (invariant 3), so in practice this
  // runs once, and again each time a building levels its footprint.
  if (fog.cellHeights.length !== width * height) {
    fog.cellHeights = new Int32Array(width * height);
    fog.cellHeightsVersion = -1;
  }
  if (fog.cellHeightsVersion !== match.terrain.version) {
    for (let cell = 0; cell < fog.cellHeights.length; cell++) {
      fog.cellHeights[cell] = cellCentreHeight(world, cell, match.terrain) >> 8;
    }
    fog.cellHeightsVersion = match.terrain.version;
  }

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    const owner = store.ownerId[i] as number;
    if (owner >= match.playerCount) continue;

    const unitCell = cellFromWorld(world, store.posX[i] as number, store.posZ[i] as number);
    if (unitCell < 0) continue;

    sweep(
      fog,
      world,
      unitCell,
      toInt(unitType(store.typeId[i] as number).sightRadius),
      fog.visible[owner] as Uint8Array,
      fog.explored[owner] as Uint8Array,
      fog.remembered[owner] as Uint8Array,
      fog.rememberedOwner[owner] as Uint8Array,
    );
  }

  stampStructures(match, world);
}

/**
 * Reveal what one unit can see, by walking every ray out from it.
 *
 * `horizonRise / horizonRun` is the steepest elevation angle met so far along
 * this ray, held as a rise and a run rather than a quotient. A cell is visible
 * when its own angle is at least the horizon — cross-multiplied, so the
 * comparison stays in integers — and raises the horizon behind it when it is.
 *
 * Both quantities are in 1/256 of a cell, which bounds the products well
 * inside a 32-bit integer: the tallest legal rise is 32 cells and the longest
 * run is the sight radius, so neither factor exceeds about 2^13.
 */
function sweep(
  fog: FogGrids,
  world: World,
  unitCell: number,
  radius: number,
  visible: Uint8Array,
  explored: Uint8Array,
  remembered: Uint8Array,
  rememberedOwner: Uint8Array,
): void {
  const width = world.width;
  const height = world.height;
  const heights = fog.cellHeights;
  const flags = world.flags;
  const cx = unitCell % width;
  const cz = (unitCell / width) | 0;
  const eye = (heights[unitCell] as number) + EYE_HEIGHT;

  visible[unitCell] = VISIBLE;
  explored[unitCell] = VISIBLE;
  remembered[unitCell] = 0;
  rememberedOwner[unitCell] = 0;

  const rays = visionRays(radius);
  const starts = rays.starts;
  const rayDx = rays.dx;
  const rayDz = rays.dz;
  const rayRun = rays.run;

  for (let ray = 0; ray + 1 < starts.length; ray++) {
    // The horizon starts below everything, so the first cell on a ray is
    // always visible. It must stay small enough that multiplying it by the
    // longest run does not overflow a 32-bit integer; the tallest real rise
    // is about 8,448 of these units, so this clears it by a wide margin.
    let horizonRise = -(1 << 18);
    let horizonRun = 1;

    const end = starts[ray + 1] as number;
    for (let step = starts[ray] as number; step < end; step++) {
      const x = cx + (rayDx[step] as number);
      const z = cz + (rayDz[step] as number);
      if (x < 0 || z < 0 || x >= width || z >= height) break;
      const cell = z * width + x;

      // A blocker hides itself and everything behind it. With a disc stamp it
      // could only ever hide its own cell; a ray can stop, so a stand of trees
      // now casts a shadow the way a ridge does.
      if (((flags[cell] as number) & VISION_BLOCKER) !== 0) break;

      const run = rayRun[step] as number;
      const rise = (heights[cell] as number) - eye;
      // rise / run >= horizonRise / horizonRun, without dividing.
      if (Math.imul(rise, horizonRun) >= Math.imul(horizonRise, run)) {
        visible[cell] = VISIBLE;
        explored[cell] = VISIBLE;
        // Seeing a cell forgets what used to stand there; anything still
        // standing is restamped afterwards.
        remembered[cell] = 0;
        rememberedOwner[cell] = 0;
        horizonRise = rise;
        horizonRun = run;
      }
    }
  }
}

/**
 * Stamp the structures each player can currently see.
 *
 * Clearing happened during the visibility pass, which already touches exactly
 * the cells that need it -- a separate sweep over the whole map per player
 * costs more than the entire rest of the update on a large map.
 */
function stampStructures(match: Match, world: World): void {
  const fog = match.fog;
  const store = match.units;

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    const typeId = store.typeId[i] as number;
    if (!unitType(typeId).isStructure) continue;

    const cell = cellFromWorld(world, store.posX[i] as number, store.posZ[i] as number);
    if (cell < 0) continue;

    for (let player = 0; player < match.playerCount; player++) {
      if ((fog.visible[player] as Uint8Array)[cell] !== VISIBLE) continue;
      (fog.remembered[player] as Uint8Array)[cell] = typeId + 1;
      (fog.rememberedOwner[player] as Uint8Array)[cell] = store.ownerId[i] as number;
    }
  }
}

/** The structure a player remembers on a cell, or null. */
export function rememberedStructure(
  fog: FogGrids,
  player: number,
  cell: number,
): { typeId: number; ownerId: number } | null {
  const remembered = fog.remembered[player];
  const owner = fog.rememberedOwner[player];
  if (!remembered || !owner || cell < 0 || cell >= remembered.length) return null;
  const stored = remembered[cell] as number;
  if (stored === 0) return null;
  return { typeId: stored - 1, ownerId: owner[cell] as number };
}

/** True when a player can currently see a cell. */
export function isVisible(fog: FogGrids, player: number, cell: number): boolean {
  if (player < 0 || player >= MAX_PLAYERS) return false;
  const grid = fog.visible[player];
  return grid !== undefined && cell >= 0 && cell < grid.length && grid[cell] === VISIBLE;
}

/** True when a player has ever seen a cell. */
export function isExplored(fog: FogGrids, player: number, cell: number): boolean {
  if (player < 0 || player >= MAX_PLAYERS) return false;
  const grid = fog.explored[player];
  return grid !== undefined && cell >= 0 && cell < grid.length && grid[cell] === VISIBLE;
}

/** Whether a player can see a unit, for targeting and for rendering. */
export function canSeeUnit(match: Match, world: World, player: number, unitIndex: number): boolean {
  if (match.units.ownerId[unitIndex] === player) return true;
  const cell = cellFromWorld(
    world,
    match.units.posX[unitIndex] as number,
    match.units.posZ[unitIndex] as number,
  );
  return isVisible(match.fog, player, cell);
}

/** Fog arrays that contribute to the determinism hash, in a fixed order. */
export function fogHashableArrays(fog: FogGrids, playerCount: number): {
  name: string;
  data: ArrayBufferView;
}[] {
  const out: { name: string; data: ArrayBufferView }[] = [];
  for (let player = 0; player < playerCount; player++) {
    out.push({ name: `fog.visible.${player}`, data: fog.visible[player] as Uint8Array });
    out.push({ name: `fog.explored.${player}`, data: fog.explored[player] as Uint8Array });
    out.push({ name: `fog.remembered.${player}`, data: fog.remembered[player] as Uint8Array });
    out.push({
      name: `fog.rememberedOwner.${player}`,
      data: fog.rememberedOwner[player] as Uint8Array,
    });
  }
  return out;
}
