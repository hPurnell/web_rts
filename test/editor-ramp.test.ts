import { beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Scene } from '@babylonjs/core/scene';

import {
  MAX_RAMP_LENGTH,
  MAX_RAMP_SPAN,
  planRamp,
  stageRamp,
  stageRampErase,
} from '../src/editor/ramp.ts';
import { TerrainEditCommand } from '../src/editor/commands.ts';
import { createSession } from '../src/editor/session.ts';
import { EDITOR_TOOLS } from '../src/editor/shell.ts';
import { isTerrainLegal } from '../src/editor/brush.ts';
import { FLAG_LAYERS, createFlagOverlay } from '../src/render/flagoverlay.ts';
import { solveRamps } from '../src/render/terrain.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import * as w from '../src/sim/world.ts';

const tool = (id: string) => EDITOR_TOOLS.find((t) => t.id === id)!;

/** A 24x8 world: the left half at tier 1, the right at tier 2. */
function twoTierWorld(): w.World {
  const world = w.createWorld({ width: 24, height: 8 });
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 24; x++) {
      world.tier[w.cellIndex(world, x, y)] = x < 12 ? 1 : 2;
    }
  }
  return world;
}

describe('ramp planning', () => {
  it('plans a ramp between tiers one step apart', () => {
    const world = twoTierWorld();
    const plan = planRamp(world, w.cellIndex(world, 14, 4), w.cellIndex(world, 9, 4));
    expect(plan.ok).toBe(true);
    expect(plan.highTier).toBe(2);
    expect(plan.lowTier).toBe(1);
    expect(plan.cells.length).toBe(6 * 3); // six cells long, three wide
  });

  it('accepts the drag in either direction', () => {
    const world = twoTierWorld();
    const downhill = planRamp(world, w.cellIndex(world, 14, 4), w.cellIndex(world, 9, 4));
    const uphill = planRamp(world, w.cellIndex(world, 9, 4), w.cellIndex(world, 14, 4));
    expect(uphill.ok).toBe(true);
    expect(uphill.cells.length).toBe(downhill.cells.length);
    expect(uphill.highTier).toBe(2);
  });

  it('refuses flat ground and spans of more than two tiers', () => {
    const world = twoTierWorld();
    const flat = planRamp(world, w.cellIndex(world, 2, 4), w.cellIndex(world, 8, 4));
    expect(flat.ok).toBe(false);
    expect(flat.reason).toMatch(/different tiers/);

    // Tier 3 beside tier 0 is a three-tier span: no single middle tier exists.
    for (let y = 0; y < 8; y++) {
      world.tier[w.cellIndex(world, 0, y)] = 3;
      for (let x = 1; x < 12; x++) world.tier[w.cellIndex(world, x, y)] = 0;
    }
    const steep = planRamp(world, w.cellIndex(world, 0, 4), w.cellIndex(world, 5, 4));
    expect(steep.ok).toBe(false);
    expect(steep.reason).toMatch(new RegExp(`at most ${MAX_RAMP_SPAN} tiers`));
  });

  it('puts a two-tier ramp on the tier between its ends', () => {
    const world = twoTierWorld();
    // Make the left half tier 0, so the drag spans tiers 2 down to 0.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 12; x++) world.tier[w.cellIndex(world, x, y)] = 0;
    }
    const plan = planRamp(world, w.cellIndex(world, 14, 4), w.cellIndex(world, 9, 4));
    expect(plan.ok).toBe(true);
    expect(plan.highTier).toBe(2);
    expect(plan.lowTier).toBe(0);
    expect(plan.rampTier).toBe(1); // each end is one step from the ramp

    const command = new TerrainEditCommand();
    stageRamp(world, command, plan);
    command.apply(world);
    expect(w.labelRegions(world).count).toBe(1);
  });

  it('refuses ends that are not walkable', () => {
    const world = twoTierWorld();
    w.setFlags(world, w.cellIndex(world, 14, 4), 0);
    const plan = planRamp(world, w.cellIndex(world, 14, 4), w.cellIndex(world, 9, 4));
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/not walkable/);
  });

  it('refuses a span that is too short or too long', () => {
    const world = twoTierWorld();
    expect(planRamp(world, w.cellIndex(world, 12, 4), w.cellIndex(world, 12, 4)).ok).toBe(false);
    const long = planRamp(world, w.cellIndex(world, 23, 4), w.cellIndex(world, 0, 4));
    expect(long.ok).toBe(false);
    expect(long.reason).toMatch(new RegExp(String(MAX_RAMP_LENGTH)));
  });

  it('refuses a ramp that runs off the map and an off-map drag', () => {
    const world = twoTierWorld();
    const offEdge = planRamp(world, w.cellIndex(world, 14, 0), w.cellIndex(world, 9, 0));
    expect(offEdge.ok).toBe(false);
    expect(offEdge.reason).toMatch(/off the map/);
    expect(planRamp(world, -1, 5).ok).toBe(false);
  });

  it('snaps a diagonal drag to the axis it travelled furthest along', () => {
    const world = twoTierWorld();
    const plan = planRamp(world, w.cellIndex(world, 14, 4), w.cellIndex(world, 9, 5));
    expect(plan.ok).toBe(true);
    // All cells lie in rows 3..5, i.e. a horizontal ramp three cells wide.
    const rows = new Set(plan.cells.map((c) => w.cellY(world, c)));
    expect([...rows].sort()).toEqual([3, 4, 5]);
  });
});

describe('placing a ramp', () => {
  it('marks the ramp walkable and connects the two tiers', () => {
    const world = twoTierWorld();
    const plan = planRamp(world, w.cellIndex(world, 14, 4), w.cellIndex(world, 9, 4));
    const command = new TerrainEditCommand();
    expect(stageRamp(world, command, plan)).toBeGreaterThan(0);
    command.apply(world);

    for (const cell of plan.cells) {
      expect((world.flags[cell] as number) & w.WALKABLE).toBeTruthy();
      expect((world.flags[cell] as number) & w.RAMP).toBeTruthy();
      expect(world.tier[cell]).toBe(1); // ramp cells take the lower tier
    }

    // The whole map is now one connected region, which it was not before.
    expect(w.labelRegions(world).count).toBe(1);
    expect(isTerrainLegal(world)).toBe(true);
  });

  it('renders as a slope rather than a step', () => {
    const world = twoTierWorld();
    const plan = planRamp(world, w.cellIndex(world, 14, 4), w.cellIndex(world, 9, 4));
    const command = new TerrainEditCommand();
    stageRamp(world, command, plan);
    command.apply(world);

    const ramps = solveRamps(world);
    const heights = new Set<number>();
    for (const cell of plan.cells) {
      const corners = ramps.byCell.get(cell);
      expect(corners).toBeDefined();
      for (const h of corners ?? []) heights.add(Math.round(h * 1000) / 1000);
    }
    expect(heights.size).toBeGreaterThan(2); // a genuine slope, not one plane
    expect(Math.min(...heights)).toBeCloseTo(2, 5); // tier 1
    expect(Math.max(...heights)).toBeCloseTo(4, 5); // tier 2
  });

  it('erases ramp flags without touching tiers', () => {
    const world = createTestMap();
    const rampCells = [...world.flags.entries()].filter(([, f]) => f & w.RAMP).map(([c]) => c);
    expect(rampCells.length).toBeGreaterThan(0);
    const tiersBefore = rampCells.map((c) => world.tier[c]);

    const command = new TerrainEditCommand();
    expect(stageRampErase(world, command, rampCells)).toBe(rampCells.length);
    command.apply(world);
    for (const [i, cell] of rampCells.entries()) {
      expect((world.flags[cell] as number) & w.RAMP).toBe(0);
      expect(world.tier[cell]).toBe(tiersBefore[i]);
    }
  });
});

describe('the ramp tool in a session', () => {
  function setup() {
    const world = twoTierWorld();
    const session = createSession(world, { pick: (x) => x, rebuildCells: () => {} });
    session.tool = tool('ramp');
    return { world, session };
  }

  it('places a ramp on release, not on every sample', () => {
    const { world, session } = setup();
    const from = w.cellIndex(world, 14, 4);
    const to = w.cellIndex(world, 9, 4);

    session.pointerDown(from, 0, 0);
    expect(session.rampAnchor).toBe(from);
    session.pointerMove(to, 0);
    expect(session.history.depth).toBe(0); // nothing placed mid-drag

    session.pointerUp();
    expect(session.history.depth).toBe(1);
    expect((world.flags[to] as number) & w.RAMP).toBeTruthy();
    expect(session.rampAnchor).toBe(-1);
  });

  it('reports why a ramp was refused', () => {
    const { world, session } = setup();
    session.pointerDown(w.cellIndex(world, 2, 4), 0, 0);
    session.pointerMove(w.cellIndex(world, 8, 4), 0);
    session.pointerUp();
    expect(session.history.depth).toBe(0);
    expect(session.lastError).toMatch(/different tiers/);
  });

  it('undoes a placed ramp in one step', () => {
    const { world, session } = setup();
    const before = w.hashWorld(world);
    session.pointerDown(w.cellIndex(world, 14, 4), 0, 0);
    session.pointerMove(w.cellIndex(world, 9, 4), 0);
    session.pointerUp();
    expect(w.hashWorld(world)).not.toBe(before);
    session.undo();
    expect(w.hashWorld(world)).toBe(before);
  });
});

describe('flag debug overlay', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = new Scene(new NullEngine());
  });

  it('cycles through every layer and back to off', () => {
    const overlay = createFlagOverlay(scene, createTestMap());
    expect(overlay.current()).toBeNull();
    for (const layer of FLAG_LAYERS) {
      expect(overlay.cycle()).toBe(layer.id);
    }
    expect(overlay.cycle()).toBeNull();
    overlay.dispose();
  });

  it('draws one quad per flagged cell and nothing when off', () => {
    const world = createTestMap();
    const overlay = createFlagOverlay(scene, world);
    overlay.rebuild(solveRamps(world));

    const meshCount = (): number => scene.meshes.filter((m) => m.name === 'flagOverlay').length;
    expect(meshCount()).toBe(0);

    overlay.show('ramp');
    expect(meshCount()).toBe(1);
    const mesh = scene.meshes.find((m) => m.name === 'flagOverlay');
    const rampCells = Array.from(world.flags).filter((f) => f & w.RAMP).length;
    expect(mesh?.getTotalVertices()).toBe(rampCells * 4);

    overlay.show(null);
    expect(meshCount()).toBe(0);
    overlay.dispose();
  });

  it('follows ramp slopes rather than floating over them', () => {
    const world = createTestMap();
    const ramps = solveRamps(world);
    const overlay = createFlagOverlay(scene, world);
    overlay.rebuild(ramps);
    overlay.show('ramp');
    const mesh = scene.meshes.find((m) => m.name === 'flagOverlay');
    const positions = mesh?.getVerticesData('position') ?? [];
    const heights = new Set<number>();
    for (let i = 1; i < positions.length; i += 3) {
      heights.add(Math.round((positions[i] as number) * 100) / 100);
    }
    expect(heights.size).toBeGreaterThan(2);
    overlay.dispose();
  });

  it('shows unwalkable cells by inverting the walkable flag', () => {
    const world = w.createWorld({ width: 8, height: 8 });
    w.setFlags(world, 5, 0);
    const overlay = createFlagOverlay(scene, world);
    overlay.rebuild({ byCell: new Map() });
    overlay.show('walkable');
    const mesh = scene.meshes.find((m) => m.name === 'flagOverlay');
    expect(mesh?.getTotalVertices()).toBe(4); // exactly the one unwalkable cell
    overlay.dispose();
  });
});

describe('editor gizmos', () => {
  it('places one instance per node and start, at its cell centre', async () => {
    const { createGizmos } = await import('../src/render/gizmos.ts');
    const scene = new Scene(new NullEngine());
    const world = w.createWorld({ width: 16, height: 16 });
    world.tier[w.cellIndex(world, 3, 4)] = 2;
    world.resourceNodes.push({ cell: w.cellIndex(world, 3, 4), type: w.ResourceType.Minerals, amount: 1 });
    world.resourceNodes.push({ cell: w.cellIndex(world, 6, 7), type: w.ResourceType.Gas, amount: 1 });
    world.startLocations.push({ cell: w.cellIndex(world, 9, 9) });

    const gizmos = createGizmos(scene, () => world);
    gizmos.rebuild(solveRamps(world));
    gizmos.setVisible(true);
    expect(gizmos.visible()).toBe(true);

    const mesh = (name: string): Mesh | undefined =>
      scene.meshes.find((m) => m.name === name) as Mesh | undefined;
    expect(mesh('gizmoMinerals')?.thinInstanceCount).toBe(1);
    expect(mesh('gizmoGas')?.thinInstanceCount).toBe(1);
    expect(mesh('gizmoStart')?.thinInstanceCount).toBe(1);

    // The mineral marker sits above the middle of its cell, on the tier 2 top.
    const { gizmoPlacements } = await import('../src/render/gizmos.ts');
    const placements = gizmoPlacements(world, solveRamps(world));
    expect(placements.minerals).toHaveLength(1);
    const [x, y, z] = placements.minerals[0] as [number, number, number];
    expect(x).toBeCloseTo(3.5, 5);
    expect(z).toBeCloseTo(4.5, 5);
    expect(y).toBeGreaterThan(4); // above the tier 2 surface
    expect(placements.gas[0]?.[0]).toBeCloseTo(6.5, 5);
    expect(placements.starts[0]?.[2]).toBeCloseTo(9.5, 5);

    gizmos.setVisible(false);
    expect(mesh('gizmoStart')?.isEnabled()).toBe(false);
    gizmos.dispose();
  });

  it('follows the world when nodes are added and removed', async () => {
    const { createGizmos } = await import('../src/render/gizmos.ts');
    const scene = new Scene(new NullEngine());
    const world = w.createWorld({ width: 16, height: 16 });
    const gizmos = createGizmos(scene, () => world);
    gizmos.setVisible(true);
    gizmos.rebuild(solveRamps(world));
    expect(scene.meshes.find((m) => m.name === 'gizmoMinerals')?.isEnabled()).toBe(false);

    world.resourceNodes.push({ cell: 20, type: w.ResourceType.Minerals, amount: 1 });
    gizmos.rebuild(solveRamps(world));
    const minerals = scene.meshes.find((m) => m.name === 'gizmoMinerals') as Mesh | undefined;
    expect(minerals?.thinInstanceCount).toBe(1);

    world.resourceNodes = [];
    gizmos.rebuild(solveRamps(world));
    expect(scene.meshes.find((m) => m.name === 'gizmoMinerals')?.isEnabled()).toBe(false);
    gizmos.dispose();
  });
});
