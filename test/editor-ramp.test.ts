import { beforeEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';

import { MAX_RAMP_LENGTH, planRamp, stageRamp, stageRampErase } from '../src/editor/ramp.ts';
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

  it('refuses tiers that are equal or two apart', () => {
    const world = twoTierWorld();
    const flat = planRamp(world, w.cellIndex(world, 2, 4), w.cellIndex(world, 8, 4));
    expect(flat.ok).toBe(false);
    expect(flat.reason).toMatch(/different tiers/);

    for (let y = 0; y < 8; y++) world.tier[w.cellIndex(world, 0, y)] = 3;
    const steep = planRamp(world, w.cellIndex(world, 0, 4), w.cellIndex(world, 5, 4));
    expect(steep.ok).toBe(false);
    expect(steep.reason).toMatch(/one step apart/);
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
