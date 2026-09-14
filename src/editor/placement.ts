/**
 * Placing resource nodes and start locations.
 *
 * Both snap to whole cells, refuse to stack on top of each other, and go
 * through commands like every other edit. Resource patches also change the
 * cells under them: they block building and block sight, exactly as a mineral
 * line does in SC2.
 */
import type { ResourceNode, StartLocation, World } from '../sim/world.ts';
import { BUILDABLE, RAMP, ResourceType, VISION_BLOCKER, WALKABLE, cellIndex } from '../sim/world.ts';

/** Default contents of a newly placed patch. */
export const MINERAL_AMOUNT = 1500;
export const GAS_AMOUNT = 2500;
/** Cells a gas geyser occupies along each axis; minerals are single cells. */
export const GAS_FOOTPRINT = 2;

export interface PlacementResult {
  readonly ok: boolean;
  readonly reason: string | null;
  /** The list as it should be after the placement. */
  readonly nodes?: ResourceNode[];
  readonly starts?: StartLocation[];
  /** Cells whose flags the placement changes. */
  readonly flagCells?: number[];
}

const REFUSE = (reason: string): PlacementResult => ({ ok: false, reason });

/** Flags a cell takes on when a resource patch sits on it. */
export function resourceCellFlags(current: number): number {
  return (current & ~BUILDABLE) | VISION_BLOCKER;
}

/** Flags a cell returns to when a patch is removed. */
export function clearedResourceCellFlags(current: number): number {
  return (current | BUILDABLE) & ~VISION_BLOCKER;
}

export function placeResourceNode(
  world: World,
  cell: number,
  type: ResourceType,
): PlacementResult {
  if (cell < 0 || cell >= world.tier.length) return REFUSE('place that on the map');
  const flags = world.flags[cell] as number;
  if ((flags & WALKABLE) === 0) return REFUSE('resource patches need walkable ground');
  if ((flags & RAMP) !== 0) return REFUSE('a resource patch cannot sit on a ramp');
  if (world.resourceNodes.some((n) => n.cell === cell)) return REFUSE('there is already a patch here');
  if (world.startLocations.some((s) => s.cell === cell)) {
    return REFUSE('that cell is a start location');
  }

  // Gas geysers are larger, so the whole footprint has to be clear and flat.
  if (type === ResourceType.Gas) {
    const cx = cellIndex(world, 0, 0) >= 0 ? cell % world.width : 0;
    const cy = (cell / world.width) | 0;
    const tier = world.tier[cell] as number;
    for (let oy = 0; oy < GAS_FOOTPRINT; oy++) {
      for (let ox = 0; ox < GAS_FOOTPRINT; ox++) {
        const foot = cellIndex(world, cx + ox, cy + oy);
        if (foot < 0) return REFUSE('the geyser does not fit here');
        if (world.tier[foot] !== tier) return REFUSE('a geyser needs flat ground');
      }
    }
  }

  const nodes = world.resourceNodes.map((n) => ({ ...n }));
  nodes.push({
    cell,
    type,
    amount: type === ResourceType.Gas ? GAS_AMOUNT : MINERAL_AMOUNT,
  });
  return { ok: true, reason: null, nodes, flagCells: [cell] };
}

export function removeResourceNode(world: World, cell: number): PlacementResult {
  if (!world.resourceNodes.some((n) => n.cell === cell)) return REFUSE('no patch here');
  return {
    ok: true,
    reason: null,
    nodes: world.resourceNodes.filter((n) => n.cell !== cell).map((n) => ({ ...n })),
    flagCells: [cell],
  };
}

export function placeStartLocation(world: World, cell: number): PlacementResult {
  if (cell < 0 || cell >= world.tier.length) return REFUSE('place that on the map');
  const flags = world.flags[cell] as number;
  if ((flags & WALKABLE) === 0) return REFUSE('a start location needs walkable ground');
  if (world.resourceNodes.some((n) => n.cell === cell)) return REFUSE('there is a resource patch here');
  if (world.startLocations.some((s) => s.cell === cell)) return REFUSE('there is already a start here');
  const starts = world.startLocations.map((s) => ({ ...s }));
  starts.push({ cell });
  return { ok: true, reason: null, starts };
}

export function removeStartLocation(world: World, cell: number): PlacementResult {
  if (!world.startLocations.some((s) => s.cell === cell)) return REFUSE('no start location here');
  return {
    ok: true,
    reason: null,
    starts: world.startLocations.filter((s) => s.cell !== cell).map((s) => ({ ...s })),
  };
}

/** The node or start under a cell, for a right-click to remove. */
export function whatIsAt(world: World, cell: number): 'node' | 'start' | null {
  if (world.resourceNodes.some((n) => n.cell === cell)) return 'node';
  if (world.startLocations.some((s) => s.cell === cell)) return 'start';
  return null;
}
