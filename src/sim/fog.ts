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
import type { Fixed } from './fixed.ts';
import { ONE, fromInt, isqrt, mul, sub, toInt } from './fixed.ts';
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
const EYE_HEIGHT: Fixed = ONE;

/**
 * How tall a vision blocker stands.
 *
 * A blocker is revealed — you can see the trees — and then blocks what is
 * behind it, which is the whole reason to paint one.
 */
const BLOCKER_HEIGHT: Fixed = fromInt(4);

export interface FogGrids {
  /**
   * Height at each cell's centre, refreshed once per update.
   *
   * The sweep reads terrain height thousands of times per unit. Sampling the
   * heightfield each time would dominate the whole update; one pass to fill
   * this costs a fraction of that and makes the inner loop an array index.
   */
  cellHeights: Int32Array;
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
    visible: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    explored: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    remembered: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    rememberedOwner: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    width,
    height,
  };
}

/**
 * One step along a ray: a cell offset and how far away it is.
 *
 * Distance is kept because the horizon is an *angle*, and an angle needs a
 * run as well as a rise. Precomputing it means the sweep never takes a square
 * root.
 */
interface RayStep {
  readonly dx: number;
  readonly dz: number;
  readonly distance: Fixed;
}

/** Rays for a sight radius, cached: the same radius always sweeps the same way. */
const RAY_CACHE = new Map<number, RayStep[][]>();

/**
 * Rays from the centre out to every cell on the rim of the bounding square.
 *
 * Walked with a Bresenham line rather than by angle, because angles would need
 * trigonometry and the simulation has none. One ray per perimeter cell gives
 * roughly one ray per cell of circumference, which is the density at which the
 * rim stops showing gaps between rays.
 */
export function visionRays(radius: number): RayStep[][] {
  const key = radius | 0;
  const cached = RAY_CACHE.get(key);
  if (cached) return cached;

  const rays: RayStep[][] = [];
  const seen = new Set<string>();

  for (let i = -key; i <= key; i++) {
    for (const [ex, ez] of [
      [i, -key],
      [i, key],
      [-key, i],
      [key, i],
    ] as const) {
      const signature = `${ex},${ez}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      rays.push(walkRay(ex, ez, key));
    }
  }

  RAY_CACHE.set(key, rays);
  return rays;
}

/** Integer Bresenham walk from the origin to (ex, ez), clipped to the disc. */
function walkRay(ex: number, ez: number, radius: number): RayStep[] {
  const steps: RayStep[] = [];
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
    // isqrt of a value scaled by 2^16 gives the root in Q16.16.
    steps.push({ dx: x, dz: z, distance: isqrt(distanceSq * 65536) });
    if (x === ex && z === ez) break;
  }
  return steps;
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
  if (fog.cellHeights.length !== width * height) {
    fog.cellHeights = new Int32Array(width * height);
  }
  for (let cell = 0; cell < fog.cellHeights.length; cell++) {
    fog.cellHeights[cell] = cellCentreHeight(world, cell, match.terrain);
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
 * `horizon` is the steepest elevation angle met so far along this ray, held as
 * a rise and a run rather than a quotient. A cell is visible when its own
 * angle is at least the horizon — cross-multiplied, so the comparison stays in
 * integers — and raises the horizon behind it when it is.
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
  const cx = unitCell % width;
  const cz = (unitCell / width) | 0;
  const eye = (fog.cellHeights[unitCell] as number) + EYE_HEIGHT;

  const reveal = (cell: number): void => {
    visible[cell] = VISIBLE;
    explored[cell] = VISIBLE;
    // Seeing a cell forgets what used to stand there; anything still standing
    // is restamped afterwards.
    remembered[cell] = 0;
    rememberedOwner[cell] = 0;
  };

  reveal(unitCell);

  for (const ray of visionRays(radius)) {
    // The horizon starts below everything, so the first cell on a ray is
    // always visible.
    let horizonRise: Fixed = -0x40000000;
    let horizonRun: Fixed = ONE;

    for (const step of ray) {
      const x = cx + step.dx;
      const z = cz + step.dz;
      if (x < 0 || z < 0 || x >= width || z >= height) break;
      const cell = z * width + x;

      const rise = sub(fog.cellHeights[cell] as number, eye);
      // rise / distance >= horizonRise / horizonRun, without dividing.
      if (mul(rise, horizonRun) >= mul(horizonRise, step.distance)) {
        reveal(cell);
        horizonRise = rise;
        horizonRun = step.distance;
      }

      // A blocker is seen and then hides what is behind it, whether or not the
      // ground it stands on was high enough to do so itself.
      if (((world.flags[cell] as number) & VISION_BLOCKER) !== 0) {
        const blocked = sub(
          (fog.cellHeights[cell] as number) + BLOCKER_HEIGHT,
          eye,
        );
        if (mul(blocked, horizonRun) > mul(horizonRise, step.distance)) {
          horizonRise = blocked;
          horizonRun = step.distance;
        }
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
