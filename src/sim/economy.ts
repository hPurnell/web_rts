/**
 * Resource gathering.
 *
 * A worker cycles: walk to a patch, harvest for a while, walk to the nearest
 * drop-off, deposit, repeat. That loop is the entire economy of an RTS, and
 * the only subtle part is what happens when more workers are assigned to a
 * patch than it can serve — see HARVEST_SLOTS below.
 *
 * Node amounts live in match state, not world state. The editor authors how
 * much a patch starts with; mining it out is something that happens during a
 * match and must not touch the map (invariant 4).
 */
import type { Fixed } from './fixed.ts';
import { add, mul, sub } from './fixed.ts';
import type { Match } from './match.ts';
import type { UnitStore } from './units.ts';
import { OrderKind, UnitState, headOrder, popOrder, resolve } from './units.ts';
import { unitType } from './unittypes.ts';
import type { World } from './world.ts';
import { ResourceType, cellFromWorld, cellIndex, worldFromCell } from './world.ts';
import { DIRECTIONS, isPassable } from '../nav/grid.ts';
import type { CostGrid } from '../nav/grid.ts';

/** Ticks a worker spends mining before it is carrying a full load. */
export const HARVEST_TICKS = 40;
/** Resource units carried per trip. */
export const MINERAL_LOAD = 8;
export const GAS_LOAD = 8;
/**
 * Workers that can mine one patch at once.
 *
 * This is what makes saturation a real decision rather than a free lunch: past
 * this many, extra workers spend their time queuing instead of mining, so the
 * income curve flattens the way an RTS economy should.
 *
 * Known limitation, measured rather than assumed: past a base's capacity the
 * curve does not merely flatten, it falls. Four patches are saturated by eight
 * workers (about 1,000 minerals a minute); sixteen workers on the same four
 * earn roughly 600, because the traffic around the patches costs the workers
 * who could be mining more than the extra bodies contribute. Real RTS
 * economies degrade under over-saturation too, but not by this much. Tuning
 * the approach and queuing behaviour belongs with the performance pass in M33,
 * where the crowd behaviour is being looked at anyway.
 */
export const HARVEST_SLOTS = 2;
/**
 * How close a worker must be to a patch or drop-off to use it.
 *
 * A patch is impassable, so the worker stands on a neighbouring cell — up to
 * 1.41 cells away diagonally — and stops anywhere inside that cell's arrival
 * radius, another 0.6. Anything under about 2.1 cells here means workers walk
 * to the patch and then stand beside it doing nothing.
 */
const INTERACT_RANGE: Fixed = 163840; // 2.5 cells

export interface NodeState {
  /** Remaining amount per node, indexed like world.resourceNodes. */
  readonly amount: Int32Array;
  /** Workers currently mining each node. */
  readonly harvesters: Int32Array;
  /** Cell each node sits on, copied so the sim never re-reads world state. */
  readonly cell: Int32Array;
  readonly type: Uint8Array;
}

export function createNodeState(world: World): NodeState {
  const count = world.resourceNodes.length;
  const state: NodeState = {
    amount: new Int32Array(count),
    harvesters: new Int32Array(count),
    cell: new Int32Array(count),
    type: new Uint8Array(count),
  };
  world.resourceNodes.forEach((node, i) => {
    state.amount[i] = node.amount;
    state.cell[i] = node.cell;
    state.type[i] = node.type;
  });
  return state;
}

export function nodeHashableArrays(nodes: NodeState): { name: string; data: ArrayBufferView }[] {
  return [
    { name: 'node.amount', data: nodes.amount },
    { name: 'node.harvesters', data: nodes.harvesters },
  ];
}

export interface EconomyContext {
  readonly world: World;
}

/** Run one tick of gathering for every worker. */
export function stepEconomy(match: Match, context: EconomyContext): void {
  const store = match.units;

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;

    const order = headOrder(store, i);
    const gathering =
      order.kind === OrderKind.Gather ||
      store.state[i] === UnitState.Gathering ||
      store.state[i] === UnitState.Returning;
    if (!gathering) {
      releaseNode(match, i);
      continue;
    }

    if (store.state[i] === UnitState.Returning || (store.carryAmount[i] as number) > 0) {
      stepReturning(match, context, i);
      continue;
    }

    stepHarvesting(match, context, i, order.cell);
  }
}

/** Walking to a patch, waiting for a slot, and mining it. */
function stepHarvesting(match: Match, context: EconomyContext, index: number, orderCell: number): void {
  const store = match.units;
  const nodes = match.nodes;

  let node = store.gatherNode[index] as number;
  if (node < 0 || (nodes.amount[node] as number) <= 0) {
    node = pickNode(match, context.world, index, orderCell);
    if (node < 0) {
      // Nothing left to mine: the order is finished rather than pending.
      releaseNode(match, index);
      store.state[index] = UnitState.Idle;
      if (headOrder(store, index).kind === OrderKind.Gather) popOrder(store, index);
      return;
    }
    store.gatherNode[index] = node;
    store.harvestTicks[index] = 0;
  }

  const nodeCell = nodes.cell[node] as number;
  if (!withinRange(store, index, context.world, nodeCell, INTERACT_RANGE)) {
    // Do not join a queue that has nowhere to put you. Workers beyond a
    // patch's capacity that keep walking in jam the approach so thoroughly
    // that the workers already mining get pushed out of range -- sixteen
    // workers on four patches ended up with two of them mining. Waiting where
    // they stand costs nothing and keeps the lanes clear.
    if ((nodes.harvesters[node] as number) >= HARVEST_SLOTS) {
      const free = nearestFreeNode(match, context.world, index);
      if (free < 0) {
        store.goalCell[index] = -1;
        store.state[index] = UnitState.Gathering;
        return;
      }
      if (free !== node) {
        store.gatherNode[index] = free;
        return;
      }
    }

    // Not there yet: keep walking. Movement owns the actual steps.
    // A patch is impassable, so the worker walks to a cell beside it; asking
    // the pathfinder for the patch itself would produce an empty field and the
    // worker would stand still forever.
    const approach = approachCell(context.world, match.costGrid, nodeCell, store, index);
    store.state[index] = UnitState.Gathering;
    if ((store.goalCell[index] as number) !== approach) {
      store.goalCell[index] = approach;
      store.bestProgress[index] = 0x7fffffff;
      store.stuckTicks[index] = 0;
    }
    return;
  }

  store.goalCell[index] = -1;
  store.state[index] = UnitState.Gathering;

  if ((store.harvestTicks[index] as number) === 0) {
    // Claim a mining slot, or go somewhere there is one. Queuing forever at a
    // saturated patch is how sixteen workers end up earning less than eight;
    // spreading to a free patch is what a player would do by hand anyway.
    if ((nodes.harvesters[node] as number) >= HARVEST_SLOTS) {
      const free = nearestFreeNode(match, context.world, index);
      if (free >= 0 && free !== node) store.gatherNode[index] = free;
      return;
    }
    nodes.harvesters[node] = (nodes.harvesters[node] as number) + 1;
    store.harvestTicks[index] = HARVEST_TICKS;
    return;
  }

  store.harvestTicks[index] = (store.harvestTicks[index] as number) - 1;
  if ((store.harvestTicks[index] as number) > 0) return;

  // The harvest finished, so give the slot back. releaseNode only covers a
  // worker abandoning a harvest in progress; a completed one leaves
  // harvestTicks at zero, and relying on that here leaked a slot per trip
  // until every patch was permanently full and the economy stopped.
  nodes.harvesters[node] = Math.max(0, (nodes.harvesters[node] as number) - 1);

  const type = nodes.type[node] as ResourceType;
  const wanted = type === ResourceType.Gas ? GAS_LOAD : MINERAL_LOAD;
  const taken = Math.min(wanted, nodes.amount[node] as number);
  nodes.amount[node] = (nodes.amount[node] as number) - taken;
  store.carryAmount[index] = taken;
  store.carryType[index] = type;
  store.state[index] = UnitState.Returning;
}

/** Walking a full load back to the nearest drop-off and depositing it. */
function stepReturning(match: Match, context: EconomyContext, index: number): void {
  const store = match.units;
  const dropOff = nearestDropOff(match, index);

  if (dropOff < 0) {
    // Nowhere to deliver: hold the load rather than losing it.
    store.state[index] = UnitState.Returning;
    store.goalCell[index] = -1;
    return;
  }

  const dropCell = cellFromWorld(
    context.world,
    store.posX[dropOff] as number,
    store.posZ[dropOff] as number,
  );

  if (!withinRange(store, index, context.world, dropCell, INTERACT_RANGE)) {
    const approach = approachCell(context.world, match.costGrid, dropCell, store, index);
    store.state[index] = UnitState.Returning;
    if ((store.goalCell[index] as number) !== approach) {
      store.goalCell[index] = approach;
      store.bestProgress[index] = 0x7fffffff;
      store.stuckTicks[index] = 0;
    }
    return;
  }

  const player = store.ownerId[index] as number;
  const amount = store.carryAmount[index] as number;
  if ((store.carryType[index] as number) === ResourceType.Gas) {
    match.gas[player] = (match.gas[player] as number) + amount;
  } else {
    match.minerals[player] = (match.minerals[player] as number) + amount;
  }

  store.carryAmount[index] = 0;
  store.goalCell[index] = -1;
  // Straight back to the patch: the loop is what makes an economy.
  store.state[index] = UnitState.Gathering;
}

/** Give up a mining slot, if this worker holds one. */
function releaseNode(match: Match, index: number): void {
  const store = match.units;
  const node = store.gatherNode[index] as number;
  if (node < 0) return;
  if ((store.harvestTicks[index] as number) > 0) {
    match.nodes.harvesters[node] = Math.max(0, (match.nodes.harvesters[node] as number) - 1);
  }
  store.harvestTicks[index] = 0;
  if (store.state[index] !== UnitState.Gathering && store.state[index] !== UnitState.Returning) {
    store.gatherNode[index] = -1;
  }
}

/** The nearest patch with something left and a free mining slot. */
function nearestFreeNode(match: Match, world: World, index: number): number {
  const nodes = match.nodes;
  const store = match.units;
  const x = store.posX[index] as number;
  const z = store.posZ[index] as number;

  let best = -1;
  let bestDistance = 0x7fffffff;
  for (let n = 0; n < nodes.amount.length; n++) {
    if ((nodes.amount[n] as number) <= 0) continue;
    if ((nodes.harvesters[n] as number) >= HARVEST_SLOTS) continue;
    const centre = worldFromCell(world, nodes.cell[n] as number);
    const dx = sub(x, centre.x);
    const dz = sub(z, centre.z);
    const distance = add(mul(dx, dx), mul(dz, dz));
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = n;
  }
  return best;
}

/**
 * A cell a unit can actually stand on to interact with `cell`.
 *
 * Returns the cell itself when it is passable, and otherwise the passable
 * neighbour nearest the unit, so workers approach a patch from the side they
 * are already on rather than all converging on one corner.
 */
export function approachCell(
  world: World,
  grid: CostGrid | null,
  cell: number,
  store: UnitStore,
  index: number,
): number {
  if (cell < 0) return -1;
  if (!grid || isPassable(grid, cell)) return cell;

  const cx = cell % world.width;
  const cy = (cell / world.width) | 0;
  const x = store.posX[index] as number;
  const z = store.posZ[index] as number;

  let best = -1;
  let bestDistance = 0x7fffffff;
  for (const [dx, dy] of DIRECTIONS) {
    const neighbour = cellIndex(world, cx + dx, cy + dy);
    if (neighbour < 0 || !isPassable(grid, neighbour)) continue;
    const centre = worldFromCell(world, neighbour);
    const ddx = sub(x, centre.x);
    const ddz = sub(z, centre.z);
    const distance = add(mul(ddx, ddx), mul(ddz, ddz));
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = neighbour;
  }
  return best;
}

/**
 * Which patch to mine.
 *
 * The ordered cell is preferred, so a player's click is obeyed; if that patch
 * is mined out, the nearest one with something left is chosen instead, which
 * is what stops a base going idle the moment a patch runs dry.
 */
function pickNode(match: Match, world: World, index: number, orderCell: number): number {
  const nodes = match.nodes;
  for (let n = 0; n < nodes.amount.length; n++) {
    if (nodes.cell[n] === orderCell && (nodes.amount[n] as number) > 0) return n;
  }

  const store = match.units;
  const x = store.posX[index] as number;
  const z = store.posZ[index] as number;
  let best = -1;
  let bestDistance = 0x7fffffff;
  for (let n = 0; n < nodes.amount.length; n++) {
    if ((nodes.amount[n] as number) <= 0) continue;
    const centre = worldFromCell(world, nodes.cell[n] as number);
    const dx = sub(x, centre.x);
    const dz = sub(z, centre.z);
    const distance = add(mul(dx, dx), mul(dz, dz));
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = n;
  }
  return best;
}

/** The player's nearest structure that accepts resources. */
function nearestDropOff(match: Match, index: number): number {
  const store = match.units;
  const player = store.ownerId[index] as number;
  const x = store.posX[index] as number;
  const z = store.posZ[index] as number;

  let best = -1;
  let bestDistance = 0x7fffffff;
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.ownerId[i] !== player) continue;
    if (!unitType(store.typeId[i] as number).isStructure) continue;
    const dx = sub(x, store.posX[i] as number);
    const dz = sub(z, store.posZ[i] as number);
    const distance = add(mul(dx, dx), mul(dz, dz));
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = i;
  }
  return best;
}

function withinRange(
  store: UnitStore,
  index: number,
  world: World,
  cell: number,
  range: Fixed,
): boolean {
  if (cell < 0) return false;
  const centre = worldFromCell(world, cell);
  const dx = sub(store.posX[index] as number, centre.x);
  const dz = sub(store.posZ[index] as number, centre.z);
  return add(mul(dx, dx), mul(dz, dz)) <= mul(range, range);
}

/** Total resources a player is carrying but has not yet delivered. */
export function carriedTotal(store: UnitStore, player: number): number {
  let total = 0;
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.ownerId[i] !== player) continue;
    total += store.carryAmount[i] as number;
  }
  return total;
}

/** Resources still in the ground. */
export function remainingInNodes(nodes: NodeState): number {
  let total = 0;
  for (let i = 0; i < nodes.amount.length; i++) total += nodes.amount[i] as number;
  return total;
}

/** Resolve a handle-free check that a worker exists, for tests. */
export function isGathering(store: UnitStore, handle: number): boolean {
  const index = resolve(store, handle);
  if (index < 0) return false;
  return (
    store.state[index] === UnitState.Gathering || store.state[index] === UnitState.Returning
  );
}
