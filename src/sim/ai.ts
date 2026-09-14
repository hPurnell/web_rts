/**
 * The skirmish bot.
 *
 * It runs *inside* the simulation rather than beside it, reading match state
 * and issuing the same commands a player would. That placement is the whole
 * design: a bot that reached in and moved units directly would not be
 * reproducible, and a bot outside the simulation would have to have its
 * commands recorded into every replay. As a deterministic function of match
 * state it needs neither — a replay re-derives exactly what it did.
 *
 * It is deliberately simple. It keeps its workers mining, builds a barracks,
 * makes an army, and attacks when the army is big enough. That is enough to
 * play a match to a conclusion, which is what M32 asks for.
 */
import type { Match } from './match.ts';
import { MAX_PLAYERS } from './match.ts';
import type { World } from './world.ts';
import { cellFromWorld, worldFromCell } from './world.ts';
import {
  NULL_HANDLE,
  OrderKind,
  UnitState,
  isUnderConstruction,
  makeHandle,
  productionCount,
  setOrder,
} from './units.ts';
import type { UnitHandle } from './units.ts';
import { UNIT_TYPES, unitType, unitTypeById } from './unittypes.ts';
import { canPlace, placeBuilding, startProduction } from './building.ts';
import { nextRange } from './rand.ts';
import { add, mul, sub } from './fixed.ts';

/**
 * Ticks between bot decisions.
 *
 * A bot that thought every tick would cost as much as the rest of the
 * simulation put together and play no better: every decision it makes takes
 * seconds to matter.
 */
export const AI_INTERVAL_TICKS = 10;

/** Army size the bot gathers before attacking. */
const ATTACK_AT = 8;
/** Workers the bot wants before it spends on anything else. */
const WORKER_TARGET = 12;
/** How far from its base the bot will look for a spot to build. */
const BUILD_SEARCH_RADIUS = 12;

export const enum AiPhase {
  /** Growing the economy. */
  Economy = 0,
  /** Massing an army. */
  Army = 1,
  /** Attacking. */
  Attack = 2,
}

export interface AiState {
  /** 1 where a player is bot-controlled. */
  readonly controlled: Uint8Array;
  readonly phase: Uint8Array;
  /** Cell the bot is currently attacking, or -1. */
  readonly target: Int32Array;
}

export function createAiState(): AiState {
  return {
    controlled: new Uint8Array(MAX_PLAYERS),
    phase: new Uint8Array(MAX_PLAYERS),
    target: new Int32Array(MAX_PLAYERS).fill(-1),
  };
}

export function aiHashableArrays(ai: AiState): { name: string; data: ArrayBufferView }[] {
  return [
    { name: 'ai.controlled', data: ai.controlled },
    { name: 'ai.phase', data: ai.phase },
    { name: 'ai.target', data: ai.target },
  ];
}

export interface AiContext {
  readonly world: World;
}

/** Run the bot for every player it controls. */
export function stepAi(match: Match, context: AiContext): void {
  if (match.tick % AI_INTERVAL_TICKS !== 0) return;

  for (let player = 0; player < match.playerCount; player++) {
    if (match.ai.controlled[player] !== 1) continue;
    think(match, context.world, player);
  }
}

function think(match: Match, world: World, player: number): void {
  const store = match.units;
  const workerType = unitTypeById('worker');
  const barracksType = unitTypeById('barracks');

  let workers = 0;
  let army = 0;
  let barracks = -1;
  let producer = -1;
  const idleWorkers: number[] = [];
  const idleArmy: number[] = [];

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.ownerId[i] !== player) continue;
    const type = unitType(store.typeId[i] as number);

    if (type.isStructure) {
      if (isUnderConstruction(store, i)) continue;
      if (type.typeId === barracksType.typeId) barracks = i;
      if (type.produces.includes(workerType.typeId)) producer = i;
      continue;
    }

    if (type.typeId === workerType.typeId) {
      workers++;
      // A worker that is neither mining nor walking somewhere is wasted.
      if (store.state[i] === UnitState.Idle) idleWorkers.push(i);
      continue;
    }

    if (!type.canAttack) continue;
    army++;
    if (store.state[i] === UnitState.Idle) idleArmy.push(i);
  }

  putWorkersToWork(match, world, idleWorkers);

  // Economy first: workers pay for everything else.
  if (producer >= 0 && workers < WORKER_TARGET && productionCount(store, producer) === 0) {
    startProduction(match, player, producer, workerType.typeId);
  }

  if (barracks < 0) {
    tryBuild(match, world, player, barracksType);
  } else if (productionCount(store, barracks) < 2) {
    // Whatever it can afford, preferring the cheapest so it always has
    // something coming rather than saving for a unit it may never reach.
    for (const typeId of [...barracksType.produces].sort(
      (a, b) => unitType(a).mineralCost - unitType(b).mineralCost,
    )) {
      if (startProduction(match, player, barracks, typeId)) break;
    }
  }

  const phase = match.ai.phase[player] as AiPhase;
  if (phase !== AiPhase.Attack && army >= ATTACK_AT) {
    match.ai.phase[player] = AiPhase.Attack;
    match.ai.target[player] = pickTarget(match, world, player);
  } else if (phase === AiPhase.Attack && army === 0) {
    // Wiped out: go back to rebuilding rather than sending each new unit to
    // die alone.
    match.ai.phase[player] = AiPhase.Economy;
    match.ai.target[player] = -1;
  } else if (phase === AiPhase.Economy && army > 0) {
    match.ai.phase[player] = AiPhase.Army;
  }

  if (match.ai.phase[player] === AiPhase.Attack) {
    let target = match.ai.target[player] as number;
    if (target < 0) {
      target = pickTarget(match, world, player);
      match.ai.target[player] = target;
    }
    if (target >= 0) {
      for (const index of idleArmy) {
        setOrder(store, index, { kind: OrderKind.AttackMove, cell: target, target: NULL_HANDLE });
      }
    }
  } else {
    // Rally idle soldiers near the base so the army gathers in one place.
    const rally = homeCell(match, world, player);
    if (rally >= 0) {
      for (const index of idleArmy) {
        const at = cellFromWorld(world, store.posX[index] as number, store.posZ[index] as number);
        if (at === rally) continue;
        setOrder(store, index, { kind: OrderKind.Move, cell: rally, target: NULL_HANDLE });
      }
    }
  }
}

/** Send idle workers to the nearest patch that still has something in it. */
function putWorkersToWork(match: Match, world: World, idle: readonly number[]): void {
  if (idle.length === 0) return;
  const store = match.units;

  for (const index of idle) {
    let best = -1;
    let bestDistance = 0x7fffffff;
    for (let n = 0; n < match.nodes.amount.length; n++) {
      if ((match.nodes.amount[n] as number) <= 0) continue;
      const centre = worldFromCell(world, match.nodes.cell[n] as number);
      const dx = sub(store.posX[index] as number, centre.x);
      const dz = sub(store.posZ[index] as number, centre.z);
      const distance = add(mul(dx, dx), mul(dz, dz));
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = n;
    }
    if (best < 0) continue;
    setOrder(store, index, {
      kind: OrderKind.Gather,
      cell: match.nodes.cell[best] as number,
      target: NULL_HANDLE,
    });
  }
}

/**
 * Find somewhere to put a building.
 *
 * Searched outward from the base in a fixed spiral rather than randomly, so
 * two runs of the same seed place buildings identically. The PRNG picks the
 * starting offset, which keeps bots from looking mechanical without making
 * them unpredictable.
 */
function tryBuild(match: Match, world: World, player: number, type: ReturnType<typeof unitType>): void {
  const home = homeCell(match, world, player);
  if (home < 0) return;
  const hx = home % world.width;
  const hy = (home / world.width) | 0;
  const jitter = nextRange(match.rand, 0, 4);

  for (let radius = 3; radius <= BUILD_SEARCH_RADIUS; radius++) {
    for (let step = 0; step < radius * 8; step++) {
      const angle = (step + jitter) % (radius * 8);
      const side = Math.floor(angle / (radius * 2));
      const along = angle % (radius * 2);
      const offset = along - radius;
      const cx = side === 0 || side === 2 ? hx + offset : hx + (side === 1 ? radius : -radius);
      const cy = side === 1 || side === 3 ? hy + offset : hy + (side === 0 ? radius : -radius);
      const cell = cy * world.width + cx;
      if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) continue;
      if (!canPlace(match, world, player, type, cell).ok) continue;
      placeBuilding(match, world, player, type, cell);
      return;
    }
  }
}

/** The cell the bot considers home: its first structure, or its first unit. */
function homeCell(match: Match, world: World, player: number): number {
  const store = match.units;
  let fallback = -1;
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.ownerId[i] !== player) continue;
    const cell = cellFromWorld(world, store.posX[i] as number, store.posZ[i] as number);
    if (unitType(store.typeId[i] as number).isStructure) return cell;
    if (fallback < 0) fallback = cell;
  }
  return fallback;
}

/**
 * Where to attack: the nearest enemy structure it knows about, or failing
 * that an enemy unit, or failing that the enemy's start location.
 */
function pickTarget(match: Match, world: World, player: number): number {
  const store = match.units;
  let structure = -1;
  let unit = -1;

  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    const owner = store.ownerId[i] as number;
    if (owner === player) continue;
    if (unitType(store.typeId[i] as number).isStructure) {
      if (structure < 0) structure = i;
    } else if (unit < 0) {
      unit = i;
    }
  }

  const chosen = structure >= 0 ? structure : unit;
  if (chosen >= 0) {
    return cellFromWorld(world, store.posX[chosen] as number, store.posZ[chosen] as number);
  }

  for (let other = 0; other < match.playerCount; other++) {
    if (other === player) continue;
    const start = world.startLocations[other];
    if (start) return start.cell;
  }
  return -1;
}

/** Mark a player as bot-controlled. */
export function setAiPlayer(match: Match, player: number, controlled: boolean): void {
  if (player < 0 || player >= MAX_PLAYERS) return;
  match.ai.controlled[player] = controlled ? 1 : 0;
  match.ai.phase[player] = AiPhase.Economy;
  match.ai.target[player] = -1;
}

/** Handles of everything a player owns, for tests and for the HUD. */
export function unitsOf(match: Match, player: number): UnitHandle[] {
  const store = match.units;
  const out: UnitHandle[] = [];
  for (let i = 0; i < store.count; i++) {
    if (store.isAlive[i] !== 1) continue;
    if (store.ownerId[i] !== player) continue;
    out.push(makeHandle(i, store.generation[i] as number));
  }
  return out;
}

/** Type ids the bot knows how to make, for documentation and tests. */
export const AI_KNOWN_TYPES = UNIT_TYPES.map((type) => type.id);
