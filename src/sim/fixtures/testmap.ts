/**
 * The 64x64 test map. Three tiers, two ramps, four resource clusters, two
 * start locations — the fixture every terrain, pathing, vision and editor test
 * runs against.
 *
 * Layout (x to the right, y downward):
 *
 *   +---------------------------------------+
 *   | tier 2 plateau (NW)      tier 1 shelf |
 *   |   start 0                             |
 *   |            ramp v                     |
 *   |======================== tier 0 basin ==|
 *   |                          ramp ^       |
 *   | tier 1 shelf (SW)     tier 2 plateau  |
 *   |                             start 1   |
 *   +---------------------------------------+
 *
 * It is built by code rather than stored as data so the intent stays readable
 * and the invariants below are checked on every load.
 */
import type { World } from '../world.ts';
import {
  BUILDABLE,
  RAMP,
  ResourceType,
  VISION_BLOCKER,
  WALKABLE,
  cellIndex,
  createWorld,
} from '../world.ts';

export const TEST_MAP_SIZE = 64;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const NW_PLATEAU: Rect = { x0: 0, y0: 0, x1: 25, y1: 20 };
const NE_SHELF: Rect = { x0: 40, y0: 0, x1: 63, y1: 16 };
const SE_PLATEAU: Rect = { x0: 38, y0: 43, x1: 63, y1: 63 };
const SW_SHELF: Rect = { x0: 0, y0: 47, x1: 23, y1: 63 };

/** Ramps are three cells wide, matching the SC2 feel. */
const NW_RAMP: Rect = { x0: 20, y0: 20, x1: 22, y1: 23 };
const SE_RAMP: Rect = { x0: 41, y0: 40, x1: 43, y1: 43 };
const NE_RAMP: Rect = { x0: 44, y0: 16, x1: 46, y1: 19 };
const SW_RAMP: Rect = { x0: 17, y0: 44, x1: 19, y1: 47 };

function fillTier(world: World, rect: Rect, tier: number): void {
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const cell = cellIndex(world, x, y);
      if (cell >= 0) world.tier[cell] = tier;
    }
  }
}

function fillRamp(world: World, rect: Rect, tier: number): void {
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const cell = cellIndex(world, x, y);
      if (cell < 0) continue;
      world.tier[cell] = tier;
      world.flags[cell] = WALKABLE | RAMP;
    }
  }
}

function addCluster(world: World, cx: number, cy: number, type: ResourceType, count: number): void {
  for (let i = 0; i < count; i++) {
    const cell = cellIndex(world, cx + i, cy);
    if (cell < 0) continue;
    world.resourceNodes.push({
      cell,
      type,
      amount: type === ResourceType.Minerals ? 1500 : 2500,
    });
    // Resource patches block building and sight, like SC2 mineral lines.
    world.flags[cell] = ((world.flags[cell] as number) & ~BUILDABLE) | VISION_BLOCKER;
  }
}

export function createTestMap(): World {
  const world = createWorld({ width: TEST_MAP_SIZE, height: TEST_MAP_SIZE });

  // Tier 0 is the basin across the middle; everything else is raised.
  fillTier(world, NW_PLATEAU, 2);
  fillTier(world, NE_SHELF, 1);
  fillTier(world, SE_PLATEAU, 2);
  fillTier(world, SW_SHELF, 1);

  // One ramp out of each raised region. The plateau ramps drop two tiers, so
  // they sit on the tier between their ends; the shelf ramps drop one, so they
  // are cut into the cliff at the basin's tier. Both are exactly what the
  // editor's ramp tool produces from a drag (see planRamp).
  fillRamp(world, NW_RAMP, 1); // tier 2 plateau -> basin
  fillRamp(world, NE_RAMP, 0); // tier 1 shelf -> basin
  fillRamp(world, SE_RAMP, 1);
  fillRamp(world, SW_RAMP, 0);

  // The apron cells directly below each plateau ramp sit at tier 1 so the ramp
  // never bridges two tiers at once.
  fillTier(world, { x0: 18, y0: 20, x1: 24, y1: 22 }, 1);
  fillTier(world, { x0: 39, y0: 41, x1: 45, y1: 43 }, 1);

  addCluster(world, 4, 6, ResourceType.Minerals, 8);
  addCluster(world, 48, 4, ResourceType.Minerals, 8);
  addCluster(world, 46, 54, ResourceType.Minerals, 8);
  addCluster(world, 4, 54, ResourceType.Minerals, 8);
  addCluster(world, 14, 9, ResourceType.Gas, 2);
  addCluster(world, 48, 50, ResourceType.Gas, 2);

  world.startLocations.push({ cell: cellIndex(world, 8, 12) });
  world.startLocations.push({ cell: cellIndex(world, 54, 50) });

  return world;
}
