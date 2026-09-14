/**
 * Fog of war.
 *
 * This lives in the simulation rather than the renderer because it gates
 * targeting and ability range: what a player can shoot is decided by what they
 * can see, and two clients that disagreed about that would desync. Every
 * player's grids are computed; only the local player's reaches the GPU.
 *
 * Visibility is recomputed from scratch every few ticks instead of being
 * maintained incrementally. A unit moving one cell changes the shape of its
 * whole disc, so the bookkeeping to update in place costs more than the
 * restamp, and a from-scratch pass cannot drift.
 */
import { MAX_PLAYERS } from './match.ts';
import type { Match } from './match.ts';
import type { World } from './world.ts';
import { VISION_BLOCKER, cellFromWorld } from './world.ts';
import { unitType } from './unittypes.ts';
import { toInt } from './fixed.ts';

/** Ticks between recomputes. At 20Hz this is five updates a second. */
export const FOG_INTERVAL_TICKS = 4;

export const VISIBLE = 255;
export const HIDDEN = 0;

export interface FogGrids {
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
    visible: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    explored: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    remembered: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    rememberedOwner: Array.from({ length: MAX_PLAYERS }, () => new Uint8Array(cells)),
    width,
    height,
  };
}

/**
 * Cell offsets forming a filled disc, grouped by radius.
 *
 * Computed once per radius and reused: stamping is the hot loop, and working
 * out which cells are inside a circle is the same answer every time.
 */
const DISC_CACHE = new Map<number, Int32Array>();

export function discOffsets(radius: number): Int32Array {
  const key = radius | 0;
  const cached = DISC_CACHE.get(key);
  if (cached) return cached;

  const offsets: number[] = [];
  const limit = key * key;
  for (let dy = -key; dy <= key; dy++) {
    for (let dx = -key; dx <= key; dx++) {
      if (dx * dx + dy * dy > limit) continue;
      offsets.push(dx, dy);
    }
  }
  const packed = Int32Array.from(offsets);
  DISC_CACHE.set(key, packed);
  return packed;
}

/**
 * Recompute visibility for every player, and fold it into explored.
 *
 * The high-ground rule is the whole point of tiered terrain: a unit sees
 * everything at its own tier or below within its sight radius, and nothing
 * above it. Standing on a cliff is an advantage you can see on the minimap.
 */
export function updateFog(match: Match, world: World): void {
  const fog = match.fog;
  const store = match.units;
  const width = world.width;
  const height = world.height;

  for (let player = 0; player < match.playerCount; player++) {
    (fog.visible[player] as Uint8Array).fill(HIDDEN);
  }

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    const owner = store.ownerId[i] as number;
    if (owner >= match.playerCount) continue;

    const unitCell = cellFromWorld(world, store.posX[i] as number, store.posZ[i] as number);
    if (unitCell < 0) continue;

    const cx = unitCell % width;
    const cy = (unitCell / width) | 0;
    const unitTier = world.tier[unitCell] as number;
    const radius = toInt(unitType(store.typeId[i] as number).sightRadius);
    const offsets = discOffsets(radius);
    const visible = fog.visible[owner] as Uint8Array;
    const explored = fog.explored[owner] as Uint8Array;
    const remembered = fog.remembered[owner] as Uint8Array;
    const rememberedOwner = fog.rememberedOwner[owner] as Uint8Array;

    for (let o = 0; o < offsets.length; o += 2) {
      const x = cx + (offsets[o] as number);
      const y = cy + (offsets[o + 1] as number);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const cell = y * width + x;

      // Look down and across, never up.
      if ((world.tier[cell] as number) > unitTier) continue;
      // A blocker hides itself; nothing else about the disc changes.
      if (((world.flags[cell] as number) & VISION_BLOCKER) !== 0) continue;

      visible[cell] = VISIBLE;
      explored[cell] = VISIBLE;
      // Seeing a cell forgets what used to stand there; structures still
      // standing are restamped below.
      remembered[cell] = 0;
      rememberedOwner[cell] = 0;
    }
  }

  stampStructures(match, world);
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
