/**
 * Buildings: placing them, finishing them, and producing out of them.
 *
 * The rule that matters most here is when a building starts blocking pathing.
 * It has to be the tick construction completes, not the tick it was placed —
 * otherwise a player can wall off a ramp instantly with a building that is not
 * there yet — and the nav grid has to be rebuilt for exactly that region, not
 * the whole map, or a base full of buildings would rebuild it every few
 * seconds.
 */
import type { Match } from './match.ts';
import type { UnitStore } from './units.ts';
import {
  NULL_HANDLE,
  UnitState,
  isUnderConstruction,
  popProduction,
  productionHead,
  queueProduction,
  resolve,
  setOrder,
  spawnUnit,
  OrderKind,
} from './units.ts';
import { unitType } from './unittypes.ts';
import type { UnitType } from './unittypes.ts';
import type { World } from './world.ts';
import { BUILDABLE, cellIndex, worldFromCell } from './world.ts';
import { isPassable, setOccupied } from '../nav/grid.ts';
import type { CostGrid } from '../nav/grid.ts';
import { add, div, fromInt, mul, sub } from './fixed.ts';

export interface PlacementCheck {
  readonly ok: boolean;
  readonly reason: string | null;
  /** The cells the footprint would cover. */
  readonly cells: readonly number[];
}

const REFUSE = (reason: string): PlacementCheck => ({ ok: false, reason, cells: [] });

/**
 * The cells a structure of this type placed at `cell` would cover.
 *
 * The footprint is anchored so the given cell is its top-left, which makes
 * placement predictable: the cell under the cursor is the one that ends up
 * under the corner of the ghost.
 */
export function footprintCells(world: World, type: UnitType, cell: number): number[] {
  const size = Math.max(1, type.footprint);
  const cx = cell % world.width;
  const cy = (cell / world.width) | 0;
  const cells: number[] = [];
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const index = cellIndex(world, cx + dx, cy + dy);
      if (index < 0) return [];
      cells.push(index);
    }
  }
  return cells;
}

/** Centre of a footprint in world space, so the building sits on it squarely. */
export function footprintCentre(world: World, type: UnitType, cell: number): { x: number; z: number } {
  const size = Math.max(1, type.footprint);
  const corner = worldFromCell(world, cell);
  const offset = mul(div(fromInt(size - 1), fromInt(2)), world.cellSize);
  return { x: add(corner.x, offset), z: add(corner.z, offset) };
}

/**
 * Whether a structure can be placed here.
 *
 * Checked in the simulation rather than only in the UI: in lockstep the
 * placement arrives over the wire, and a client must not be able to build
 * inside a cliff by sending a command the UI would have refused.
 */
export function canPlace(
  match: Match,
  world: World,
  player: number,
  type: UnitType,
  cell: number,
): PlacementCheck {
  if (!type.isStructure) return REFUSE('that is not a building');
  if (cell < 0 || cell >= world.tier.length) return REFUSE('place that on the map');

  const cells = footprintCells(world, type, cell);
  if (cells.length === 0) return REFUSE('it does not fit on the map');

  const tier = world.tier[cell] as number;
  for (const footprint of cells) {
    if (((world.flags[footprint] as number) & BUILDABLE) === 0) {
      return REFUSE('the ground there is not buildable');
    }
    if (world.tier[footprint] !== tier) return REFUSE('a building needs level ground');
    if (match.costGrid && !isPassable(match.costGrid, footprint)) {
      return REFUSE('something is already there');
    }
  }

  if ((match.minerals[player] as number) < type.mineralCost) return REFUSE('not enough minerals');
  if ((match.gas[player] as number) < type.gasCost) return REFUSE('not enough gas');

  return { ok: true, reason: null, cells };
}

/**
 * Start a building. It exists immediately, with a fraction of its hit points
 * and no effect on pathing until it finishes.
 */
export function placeBuilding(
  match: Match,
  world: World,
  player: number,
  type: UnitType,
  cell: number,
): number {
  const check = canPlace(match, world, player, type, cell);
  if (!check.ok) return -1;

  const centre = footprintCentre(world, type, cell);
  const handle = spawnUnit(match.units, {
    type,
    ownerId: player,
    x: centre.x,
    z: centre.z,
    facing: 0,
  });
  if (handle === NULL_HANDLE) return -1;

  const index = resolve(match.units, handle);
  match.minerals[player] = (match.minerals[player] as number) - type.mineralCost;
  match.gas[player] = (match.gas[player] as number) - type.gasCost;
  match.units.buildTicks[index] = Math.max(1, type.buildTicks);
  // A site starts at a tenth of its hit points and earns the rest as it goes
  // up, so an unfinished building is a real liability.
  match.units.hp[index] = Math.max(1, Math.floor(type.maxHp / 10));
  match.units.state[index] = UnitState.Building;
  return handle;
}

export interface BuildingContext {
  readonly world: World;
}

/** Advance construction and production for every structure. */
export function stepBuildings(match: Match, context: BuildingContext): void {
  const store = match.units;
  const grid = match.costGrid;

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    const type = unitType(store.typeId[i] as number);
    if (!type.isStructure) continue;

    if (isUnderConstruction(store, i)) {
      advanceConstruction(match, context, grid, i, type);
      continue;
    }

    advanceProduction(match, context, i, type);
  }
}

function advanceConstruction(
  match: Match,
  context: BuildingContext,
  grid: CostGrid | null,
  index: number,
  type: UnitType,
): void {
  const store = match.units;
  const remaining = (store.buildTicks[index] as number) - 1;
  store.buildTicks[index] = remaining;

  // Hit points climb with progress rather than jumping at the end.
  const total = Math.max(1, type.buildTicks);
  const done = total - remaining;
  const floor = Math.max(1, Math.floor(type.maxHp / 10));
  store.hp[index] = floor + Math.floor(((type.maxHp - floor) * done) / total);

  if (remaining > 0) return;

  store.hp[index] = type.maxHp;
  store.state[index] = UnitState.Idle;

  // Finished: now it blocks. Only the footprint's region is rebuilt.
  if (grid) {
    const anchor = anchorCell(match, context.world, index, type);
    setOccupied(grid, context.world, footprintCells(context.world, type, anchor), true);
    // Every cached field was solved against terrain this building was not on.
    match.fields.fields.clear();
  }
}

function advanceProduction(
  match: Match,
  context: BuildingContext,
  index: number,
  type: UnitType,
): void {
  const store = match.units;
  const producing = productionHead(store, index);
  if (producing < 0) return;

  if ((store.produceTicks[index] as number) <= 0) {
    store.produceTicks[index] = Math.max(1, unitType(producing).buildTicks);
  }

  store.produceTicks[index] = (store.produceTicks[index] as number) - 1;
  if ((store.produceTicks[index] as number) > 0) return;

  const produced = unitType(producing);
  const spawnCell = spawnPoint(match, context.world, index, type);
  const position =
    spawnCell >= 0
      ? worldFromCell(context.world, spawnCell)
      : { x: store.posX[index] as number, z: store.posZ[index] as number };

  const handle = spawnUnit(match.units, {
    type: produced,
    ownerId: store.ownerId[index] as number,
    x: position.x,
    z: position.z,
    facing: 0,
  });
  popProduction(store, index);
  if (handle === NULL_HANDLE) return;

  const rally = store.rallyCell[index] as number;
  if (rally < 0) return;

  // A rally point that cannot be reached is not an error: the unit is already
  // out of the building, and the order simply fails to make progress and ends.
  const newIndex = resolve(store, handle);
  if (newIndex >= 0) {
    setOrder(store, newIndex, { kind: OrderKind.Move, cell: rally, target: NULL_HANDLE });
  }
}

/** Top-left cell of a placed structure's footprint. */
function anchorCell(match: Match, world: World, index: number, type: UnitType): number {
  const store = match.units;
  const size = Math.max(1, type.footprint);
  const offset = mul(div(fromInt(size - 1), fromInt(2)), world.cellSize);
  const x = sub(store.posX[index] as number, offset);
  const z = sub(store.posZ[index] as number, offset);
  const cx = Math.floor(x / world.cellSize);
  const cy = Math.floor(z / world.cellSize);
  return cellIndex(world, cx, cy);
}

/** A free cell beside the structure for a new unit to appear on. */
function spawnPoint(match: Match, world: World, index: number, type: UnitType): number {
  const grid = match.costGrid;
  const anchor = anchorCell(match, world, index, type);
  if (anchor < 0) return -1;
  const size = Math.max(1, type.footprint);
  const cx = anchor % world.width;
  const cy = (anchor / world.width) | 0;

  // Walk the ring around the footprint, so units come out beside the building
  // rather than inside it.
  for (let dy = -1; dy <= size; dy++) {
    for (let dx = -1; dx <= size; dx++) {
      if (dx >= 0 && dx < size && dy >= 0 && dy < size) continue;
      const cell = cellIndex(world, cx + dx, cy + dy);
      if (cell < 0) continue;
      if (grid && !isPassable(grid, cell)) continue;
      return cell;
    }
  }
  return -1;
}

/** Queue a unit at a structure, if it can build it and can afford it. */
export function startProduction(
  match: Match,
  player: number,
  buildingIndex: number,
  typeId: number,
): boolean {
  const store = match.units;
  if (store.isAlive[buildingIndex] !== 1) return false;
  if (store.ownerId[buildingIndex] !== player) return false;
  if (isUnderConstruction(store, buildingIndex)) return false;

  const building = unitType(store.typeId[buildingIndex] as number);
  if (!building.produces.includes(typeId)) return false;

  const produced = unitType(typeId);
  if ((match.minerals[player] as number) < produced.mineralCost) return false;
  if ((match.gas[player] as number) < produced.gasCost) return false;
  if (!queueProduction(store, buildingIndex, typeId)) return false;

  // Charged when queued, like SC2: the cost is committed, and cancelling
  // refunds it.
  match.minerals[player] = (match.minerals[player] as number) - produced.mineralCost;
  match.gas[player] = (match.gas[player] as number) - produced.gasCost;
  return true;
}

/** Structures a player owns that can produce something. */
export function productionBuildings(store: UnitStore, player: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.ownerId[i] !== player) continue;
    if (isUnderConstruction(store, i)) continue;
    if (unitType(store.typeId[i] as number).produces.length === 0) continue;
    out.push(i);
  }
  return out;
}
