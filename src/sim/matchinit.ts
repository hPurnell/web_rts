/**
 * Building match state from world state (invariant 4).
 *
 * This is the only place the two halves meet, and it reads world state without
 * writing to it. Everything it produces is discarded at match end, which is
 * what makes the editor's Test/Stop toggle nearly free.
 */
import type { Match, MatchInit } from './match.ts';
import { MAX_PLAYERS, createMatch } from './match.ts';
import { createCostGrid } from '../nav/grid.ts';
import { createNodeState } from './economy.ts';
import type { World } from './world.ts';
import { cellFromWorld, worldFromCell } from './world.ts';
import { NULL_HANDLE, OrderKind, resolve, setOrder, spawnUnit } from './units.ts';
import { unitTypeById } from './unittypes.ts';
import type { Fixed } from './fixed.ts';
import { add, fromInt, fromRatio, mul, sub } from './fixed.ts';
import { sinCos } from './trig.ts';
import { TAU } from './fixed.ts';

export const STARTING_WORKERS = 6;
export const STARTING_MINERALS = 50;
export const STARTING_GAS = 0;

export interface MatchSetup extends MatchInit {
  readonly world: World;
  /** Workers each player begins with. */
  readonly startingWorkers?: number;
  /** Drop-off structures each player begins with. Zero for a bare match. */
  readonly startingDepots?: number;
  readonly startingMinerals?: number;
}

/**
 * Place starting workers in a ring around the start location.
 *
 * The ring is laid out by index rather than randomly: both players get the
 * same arrangement, which makes an opening position comparable between
 * replays and between sides.
 */
function ringOffset(index: number, count: number, radius: Fixed): { x: Fixed; z: Fixed } {
  const angle = mul(fromRatio(index, Math.max(1, count)), TAU);
  const { s, c } = sinCos(angle);
  return { x: mul(c, radius), z: mul(s, radius) };
}

/** The resource patch nearest a point, or -1 when the map has none. */
function nearestNode(world: World, x: Fixed, z: Fixed): number {
  let best = -1;
  let bestDistance = 0x7fffffff;
  for (const node of world.resourceNodes) {
    if (node.amount <= 0) continue;
    const centre = worldFromCell(world, node.cell);
    const dx = sub(x, centre.x);
    const dz = sub(z, centre.z);
    const distance = add(mul(dx, dx), mul(dz, dz));
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = node.cell;
  }
  return best;
}

export function createMatchFromWorld(setup: MatchSetup): Match {
  const world = setup.world;
  const match = createMatch({
    ...setup,
    worldWidth: world.width,
    worldHeight: world.height,
    costGrid: setup.costGrid ?? createCostGrid(world),
  });
  match.nodes = createNodeState(world);
  const workers = setup.startingWorkers ?? STARTING_WORKERS;
  const depots = setup.startingDepots ?? 1;
  const minerals = setup.startingMinerals ?? STARTING_MINERALS;
  const workerType = unitTypeById('worker');
  const radius = mul(fromInt(2), world.cellSize);

  for (let player = 0; player < match.playerCount && player < MAX_PLAYERS; player++) {
    match.minerals[player] = minerals;
    match.gas[player] = STARTING_GAS;

    const start = world.startLocations[player];
    if (!start) continue;
    const centre = worldFromCell(world, start.cell);

    // A drop-off at the start location, so the opening economy has somewhere
    // to deliver to. M26 lets players build more.
    for (let d = 0; d < depots; d++) {
      spawnUnit(match.units, {
        type: unitTypeById('depot'),
        ownerId: player,
        x: centre.x,
        z: centre.z,
        facing: 0,
      });
    }

    for (let i = 0; i < workers; i++) {
      const offset = ringOffset(i, workers, radius);
      const x = add(centre.x, offset.x);
      const z = add(centre.z, offset.z);
      // Keep every worker on the map; a start location near an edge would
      // otherwise fling part of the ring outside it.
      const cell = cellFromWorld(world, x, z);
      const placed = cell >= 0 ? { x, z } : centre;
      const handle = spawnUnit(match.units, {
        type: workerType,
        ownerId: player,
        x: placed.x,
        z: placed.z,
        facing: mul(fromRatio(i, Math.max(1, workers)), TAU),
      });

      // Starting workers mine straight away, the way every RTS opens. Without
      // it a match begins with six units standing still waiting to be told
      // something everybody was always going to tell them.
      const patch = nearestNode(world, placed.x, placed.z);
      const index = resolve(match.units, handle);
      if (patch >= 0 && index >= 0) {
        setOrder(match.units, index, {
          kind: OrderKind.Gather,
          cell: patch,
          target: NULL_HANDLE,
        });
      }
    }
  }

  return match;
}
