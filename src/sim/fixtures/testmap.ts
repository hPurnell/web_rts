/**
 * The 128x128 test map: the fixture every terrain, pathing, vision and editor
 * test runs against.
 *
 * A central basin, two raised plateaus each reachable by one sculpted ramp, and
 * a ridge too steep to climb that splits the basin into two approaches. It is
 * built by code rather than stored as data so the intent stays readable, and
 * because it is the clearest statement of what this terrain model is for:
 * there are no tiers and no ramp objects here, only ground of varying
 * steepness, and which parts of it are walkable falls out of the slope rules.
 *
 *   +--------------------------------------------------+
 *   |  plateau A        |                              |
 *   |  (start 0)      ==+== ramp A                     |
 *   |                   |            ridge             |
 *   |         basin     |         (impassable)         |
 *   |                            ==+== ramp B          |
 *   |                              |      plateau B    |
 *   |                              |      (start 1)    |
 *   +--------------------------------------------------+
 */
import type { World } from '../world.ts';
import { BUILDABLE, ResourceType, VISION_BLOCKER, cellIndex, createWorld } from '../world.ts';
import { cornerStride } from '../terrain.ts';
import type { Fixed } from '../fixed.ts';
import { fromInt, fromRatio, mul } from '../fixed.ts';

export const TEST_MAP_SIZE = 128;

/** Height of the two plateaus, in world units. */
const PLATEAU_HEIGHT = fromInt(6);
/** Height of the impassable ridge. */
const RIDGE_HEIGHT = fromInt(10);

interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const PLATEAU_A: Box = { x0: 8, z0: 8, x1: 44, z1: 44 };
const PLATEAU_B: Box = { x0: 84, z0: 84, x1: 120, z1: 120 };
/**
 * The ridge is a crest, not a wall with a top.
 *
 * A zero-width box falling away over two cells has no flat summit, so there is
 * nowhere up there to strand. The first version of this fixture gave it a
 * five-cell top, and validate() immediately reported 184 cells of ground that
 * could be seen and never reached — which is exactly the mistake sculpted
 * terrain invites and exactly what that check is for.
 */
const RIDGE: Box = { x0: 64, z0: 42, x1: 64, z1: 88 };
const RIDGE_SKIRT_CELLS = 2;

/** Ramps: a corridor whose height falls linearly from `from` to `to`. */
interface Ramp {
  readonly box: Box;
  /** The axis the ramp descends along, and which end is high. */
  readonly axis: 'x' | 'z';
  readonly highAt: number;
  readonly lowAt: number;
  readonly top: Fixed;
}

const RAMP_A: Ramp = {
  box: { x0: 44, z0: 22, x1: 64, z1: 30 },
  axis: 'x',
  highAt: 44,
  lowAt: 64,
  top: PLATEAU_HEIGHT,
};
const RAMP_B: Ramp = {
  box: { x0: 64, z0: 98, x1: 84, z1: 106 },
  axis: 'x',
  highAt: 84,
  lowAt: 64,
  top: PLATEAU_HEIGHT,
};

/**
 * How far outside a plateau its skirt falls to nothing.
 *
 * Two cells for six units of height is a slope of 3, comfortably a cliff. This
 * is what makes the plateaus defensible: the only way up is the ramp, and that
 * is a consequence of the geometry rather than a flag saying so.
 */
const SKIRT_CELLS = 2;

/** Chebyshev distance from a point to a box; zero inside it. */
function distanceOutside(box: Box, cx: number, cz: number): number {
  const dx = Math.max(0, Math.max(box.x0 - cx, cx - box.x1));
  const dz = Math.max(0, Math.max(box.z0 - cz, cz - box.z1));
  return Math.max(dx, dz);
}

/** A flat top with a linear skirt: `top` inside, falling to zero over `skirt`. */
function plateauHeight(box: Box, top: Fixed, skirt: number, cx: number, cz: number): Fixed {
  const outside = distanceOutside(box, cx, cz);
  if (outside === 0) return top;
  if (outside >= skirt) return 0;
  return mul(top, fromRatio(skirt - outside, skirt));
}

/** Linear descent along the ramp's axis, zero outside its corridor. */
function rampHeight(ramp: Ramp, cx: number, cz: number): Fixed {
  if (distanceOutside(ramp.box, cx, cz) > 0) return 0;
  const along = ramp.axis === 'x' ? cx : cz;
  const span = Math.abs(ramp.lowAt - ramp.highAt);
  if (span === 0) return ramp.top;
  const travelled = Math.min(span, Math.abs(along - ramp.highAt));
  return mul(ramp.top, fromRatio(span - travelled, span));
}

function addCluster(world: World, cx: number, cz: number, type: ResourceType, count: number): void {
  for (let i = 0; i < count; i++) {
    const cell = cellIndex(world, cx + i, cz);
    if (cell < 0) continue;
    world.resourceNodes.push({
      cell,
      type,
      amount: type === ResourceType.Minerals ? 1500 : 2500,
    });
    // Resource patches block building and block sight, like a mineral line.
    world.flags[cell] = ((world.flags[cell] as number) & ~BUILDABLE) | VISION_BLOCKER;
  }
}

export function createTestMap(): World {
  const world = createWorld({ width: TEST_MAP_SIZE, height: TEST_MAP_SIZE });

  // Sculpt every corner from the shapes above. Taking the maximum means a ramp
  // cuts through the skirt it crosses: at the plateau edge both are at full
  // height, and from there the skirt plunges while the ramp eases down.
  const stride = cornerStride(world);
  for (let cz = 0; cz <= world.height; cz++) {
    for (let cx = 0; cx <= world.width; cx++) {
      let height = plateauHeight(PLATEAU_A, PLATEAU_HEIGHT, SKIRT_CELLS, cx, cz);
      height = Math.max(height, plateauHeight(PLATEAU_B, PLATEAU_HEIGHT, SKIRT_CELLS, cx, cz));
      height = Math.max(height, plateauHeight(RIDGE, RIDGE_HEIGHT, RIDGE_SKIRT_CELLS, cx, cz));
      height = Math.max(height, rampHeight(RAMP_A, cx, cz));
      height = Math.max(height, rampHeight(RAMP_B, cx, cz));
      world.heights[cz * stride + cx] = height;
    }
  }

  addCluster(world, 14, 16, ResourceType.Minerals, 8);
  addCluster(world, 96, 112, ResourceType.Minerals, 8);
  addCluster(world, 30, 70, ResourceType.Minerals, 8);
  addCluster(world, 90, 40, ResourceType.Minerals, 8);
  addCluster(world, 14, 26, ResourceType.Gas, 2);
  addCluster(world, 108, 100, ResourceType.Gas, 2);

  world.startLocations.push({ cell: cellIndex(world, 20, 20) });
  world.startLocations.push({ cell: cellIndex(world, 108, 108) });

  return world;
}
