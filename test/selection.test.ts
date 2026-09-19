import { describe, expect, it } from 'vitest';
import { Selection, ControlGroups, unitsInRect, unitAtPoint, sameTypeOnScreen } from '../src/game/selection.ts';
import { SelectionController, CLICK_PICK_RADIUS_PX, DOUBLE_CLICK_MS } from '../src/game/selectioncontroller.ts';
import { projectPoint, rectArea, rectContains, rectFromDrag } from '../src/game/project.ts';
import { createMatch } from '../src/sim/match.ts';
import { despawnUnit, makeHandle, spawnUnit, NULL_HANDLE } from '../src/sim/units.ts';
import type { UnitHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { fromInt } from '../src/sim/fixed.ts';

const WIDTH = 1280;
const HEIGHT = 720;

/**
 * An orthographic view looking straight down, built so world (x, z) lands on
 * screen (x * 10, z * 10). A real camera matrix cannot be checked by hand;
 * this one can.
 *
 *   clip.x = x/64 - 1   -> screen x = x * 10
 *   clip.y = 1 - z/36   -> screen y = z * 10
 *   clip.w = 1
 */
const TOP_DOWN = (() => {
  const m = new Float32Array(16);
  m[0] = 1 / 64; // x -> clip.x
  m[12] = -1;
  m[9] = -1 / 36; // z -> clip.y, inverted so +z goes down the screen
  m[13] = 1;
  m[15] = 1; // clip.w = 1
  return m;
})();

const project = (x: number, z: number) => projectPoint(TOP_DOWN, x, 0, z, WIDTH, HEIGHT);

function match() {
  return createMatch({ seed: 1, playerCount: 2 });
}

function spawn(m: ReturnType<typeof match>, type: string, owner: number, x: number, z: number): UnitHandle {
  return spawnUnit(m.units, {
    type: unitTypeById(type),
    ownerId: owner,
    x: fromInt(x),
    z: fromInt(z),
  });
}

describe('projection', () => {
  it('maps world positions to screen pixels', () => {
    const origin = project(0, 0);
    expect(origin.visible).toBe(true);
    expect(origin.x).toBeCloseTo(0, 3);
    expect(origin.y).toBeCloseTo(0, 3);

    const mid = project(64, 36);
    expect(mid.x).toBeCloseTo(WIDTH / 2, 3);
    expect(mid.y).toBeCloseTo(HEIGHT / 2, 3);
  });

  it('rejects points behind the camera rather than mirroring them', () => {
    // A perspective matrix where w goes negative behind the eye. Projecting
    // such a point without checking w folds it back onto the screen, and units
    // behind the camera start appearing in selection boxes.
    const perspective = new Float32Array(16);
    perspective[0] = 1;
    perspective[5] = 1;
    perspective[11] = 1; // w = z
    perspective[10] = 1;
    expect(projectPoint(perspective, 1, 0, -5, WIDTH, HEIGHT).visible).toBe(false);
    expect(projectPoint(perspective, 1, 0, 5, WIDTH, HEIGHT).visible).toBe(true);
  });

  it('normalises a drag from any corner', () => {
    const a = rectFromDrag(100, 200, 50, 80);
    expect(a).toEqual({ left: 50, top: 80, right: 100, bottom: 200 });
    expect(rectContains(a, 60, 100)).toBe(true);
    expect(rectContains(a, 40, 100)).toBe(false);
    expect(rectArea(a)).toBe(50 * 120);
  });
});

describe('selection model', () => {
  it('keeps insertion order and ignores duplicates', () => {
    const selection = new Selection();
    selection.add([5, 9, 5, 7]);
    expect(selection.list()).toEqual([5, 9, 7]);
    expect(selection.count).toBe(3);
    expect(selection.has(9)).toBe(true);
  });

  it('ignores the null handle', () => {
    const selection = new Selection();
    selection.add([NULL_HANDLE, 4]);
    expect(selection.list()).toEqual([4]);
  });

  it('toggles, removes and clears', () => {
    const selection = new Selection();
    selection.set([1, 2, 3]);
    selection.toggle(2);
    expect(selection.list()).toEqual([1, 3]);
    selection.toggle(2);
    expect(selection.list()).toEqual([1, 3, 2]);
    selection.remove([1, 99]);
    expect(selection.list()).toEqual([3, 2]);
    selection.clear();
    expect(selection.count).toBe(0);
  });

  it('survives unit death without dangling handles', () => {
    // The failure this prevents: a dead unit's slot is recycled and the stale
    // selection starts pointing at the new occupant.
    const m = match();
    const a = spawn(m, 'soldier', 0, 10, 10);
    const b = spawn(m, 'soldier', 0, 12, 10);
    const selection = new Selection();
    selection.set([a, b]);

    despawnUnit(m.units, a);
    const replacement = spawn(m, 'raider', 1, 40, 40);
    expect(replacement).not.toBe(a);

    expect(selection.prune(m.units)).toBe(1);
    expect(selection.list()).toEqual([b]);
    expect(selection.has(replacement)).toBe(false);
  });

  it('prunes nothing when everything is alive', () => {
    const m = match();
    const selection = new Selection();
    selection.set([spawn(m, 'soldier', 0, 1, 1), spawn(m, 'soldier', 0, 2, 2)]);
    expect(selection.prune(m.units)).toBe(0);
    expect(selection.count).toBe(2);
  });
});

describe('picking units', () => {
  it('finds units inside a screen rect and nothing outside it', () => {
    const m = match();
    const inside = [spawn(m, 'soldier', 0, 10, 10), spawn(m, 'soldier', 0, 12, 12)];
    const outside = spawn(m, 'soldier', 0, 100, 60);
    const rect = rectFromDrag(project(8, 8).x, project(8, 8).y, project(20, 20).x, project(20, 20).y);

    const found = unitsInRect(m.units, TOP_DOWN, rect, { ownerId: 0, width: WIDTH, height: HEIGHT });
    expect(found.sort()).toEqual(inside.sort());
    expect(found).not.toContain(outside);
  });

  it('only selects the local player units', () => {
    const m = match();
    spawn(m, 'soldier', 0, 10, 10);
    spawn(m, 'soldier', 1, 11, 10);
    const rect = { left: 0, top: 0, right: WIDTH, bottom: HEIGHT };
    expect(unitsInRect(m.units, TOP_DOWN, rect, { ownerId: 0, width: WIDTH, height: HEIGHT })).toHaveLength(1);
    expect(unitsInRect(m.units, TOP_DOWN, rect, { ownerId: -1, width: WIDTH, height: HEIGHT })).toHaveLength(2);
  });

  it('skips dead units', () => {
    const m = match();
    const a = spawn(m, 'soldier', 0, 10, 10);
    spawn(m, 'soldier', 0, 11, 10);
    despawnUnit(m.units, a);
    const rect = { left: 0, top: 0, right: WIDTH, bottom: HEIGHT };
    expect(unitsInRect(m.units, TOP_DOWN, rect, { ownerId: 0, width: WIDTH, height: HEIGHT })).toHaveLength(1);
  });

  it('picks the nearest unit to a click and nothing when too far', () => {
    const m = match();
    const near = spawn(m, 'soldier', 0, 10, 10);
    spawn(m, 'soldier', 0, 30, 30);
    const point = project(10, 10);
    const options = { ownerId: 0, width: WIDTH, height: HEIGHT };
    expect(unitAtPoint(m.units, TOP_DOWN, point.x + 3, point.y + 3, CLICK_PICK_RADIUS_PX, options)).toBe(near);
    expect(unitAtPoint(m.units, TOP_DOWN, 5, 700, CLICK_PICK_RADIUS_PX, options)).toBe(NULL_HANDLE);
  });

  it('finds every on-screen unit of the same type', () => {
    const m = match();
    const soldiers = [spawn(m, 'soldier', 0, 10, 10), spawn(m, 'soldier', 0, 20, 20)];
    spawn(m, 'raider', 0, 30, 30);
    spawn(m, 'soldier', 1, 40, 40); // enemy soldier, not ours
    const found = sameTypeOnScreen(m.units, TOP_DOWN, soldiers[0] as number, {
      ownerId: 0,
      width: WIDTH,
      height: HEIGHT,
    });
    expect(found.sort()).toEqual(soldiers.sort());
  });

});

describe('control groups', () => {
  it('sets, adds and recalls like SC2', () => {
    const m = match();
    const groups = new ControlGroups();
    const a = spawn(m, 'soldier', 0, 1, 1);
    const b = spawn(m, 'soldier', 0, 2, 2);
    const c = spawn(m, 'raider', 0, 3, 3);

    groups.set(1, [a, b]);
    expect(groups.recall(1, m.units).sort()).toEqual([a, b].sort());

    groups.add(1, [c, a]); // `a` is already in the group
    expect(groups.size(1)).toBe(3);

    groups.set(1, [c]); // setting replaces rather than merges
    expect(groups.recall(1, m.units)).toEqual([c]);
  });

  it('forgets units that have died', () => {
    const m = match();
    const groups = new ControlGroups();
    const a = spawn(m, 'soldier', 0, 1, 1);
    const b = spawn(m, 'soldier', 0, 2, 2);
    groups.set(3, [a, b]);
    despawnUnit(m.units, a);
    expect(groups.recall(3, m.units)).toEqual([b]);
    expect(groups.size(3)).toBe(1);
  });

  it('ignores group indices outside 0..9', () => {
    const groups = new ControlGroups();
    groups.set(-1, [5]);
    groups.set(10, [5]);
    expect(groups.size(-1)).toBe(0);
    expect(groups.size(10)).toBe(0);
  });
});

describe('selection controller', () => {
  const view = { viewProjection: TOP_DOWN, width: WIDTH, height: HEIGHT };
  const plain = { shift: false, ctrl: false };

  function setup() {
    const m = match();
    const controller = new SelectionController(0);
    return { m, controller };
  }

  const clickAt = (
    controller: SelectionController,
    m: ReturnType<typeof match>,
    x: number,
    y: number,
    modifiers = plain,
    now = 1000,
  ): void => {
    controller.beginDrag(x, y);
    controller.endDrag(x, y, m.units, view, modifiers, now);
  };

  it('selects a unit by clicking it and clears on empty ground', () => {
    const { m, controller } = setup();
    const handle = spawn(m, 'soldier', 0, 10, 10);
    const point = project(10, 10);

    clickAt(controller, m, point.x, point.y);
    expect(controller.selection.list()).toEqual([handle]);

    clickAt(controller, m, 5, 700);
    expect(controller.selection.count).toBe(0);
  });

  it('shift-clicking adds and removes', () => {
    const { m, controller } = setup();
    const a = spawn(m, 'soldier', 0, 10, 10);
    const b = spawn(m, 'soldier', 0, 30, 30);
    clickAt(controller, m, project(10, 10).x, project(10, 10).y);
    clickAt(controller, m, project(30, 30).x, project(30, 30).y, { shift: true, ctrl: false });
    expect([...controller.selection.list()].sort()).toEqual([a, b].sort());

    clickAt(controller, m, project(30, 30).x, project(30, 30).y, { shift: true, ctrl: false }, 5000);
    expect(controller.selection.list()).toEqual([a]);
  });

  it('box-selects on a real drag and replaces the selection', () => {
    const { m, controller } = setup();
    const a = spawn(m, 'soldier', 0, 10, 10);
    const b = spawn(m, 'soldier', 0, 14, 14);
    spawn(m, 'soldier', 0, 100, 60);

    controller.beginDrag(project(8, 8).x, project(8, 8).y);
    controller.updateDrag(project(20, 20).x, project(20, 20).y);
    expect(controller.dragBox()).not.toBeNull();
    controller.endDrag(project(20, 20).x, project(20, 20).y, m.units, view, plain, 1000);

    expect(controller.dragBox()).toBeNull();
    expect([...controller.selection.list()].sort()).toEqual([a, b].sort());
  });

  it('treats a tiny shaky drag as a click', () => {
    const { m, controller } = setup();
    const handle = spawn(m, 'soldier', 0, 10, 10);
    const point = project(10, 10);
    controller.beginDrag(point.x, point.y);
    controller.updateDrag(point.x + 2, point.y + 1);
    controller.endDrag(point.x + 2, point.y + 1, m.units, view, plain, 1000);
    expect(controller.selection.list()).toEqual([handle]);
  });

  it('ctrl-click and double-click both take the type on screen', () => {
    const { m, controller } = setup();
    const soldiers = [spawn(m, 'soldier', 0, 10, 10), spawn(m, 'soldier', 0, 20, 20)];
    spawn(m, 'raider', 0, 30, 30);
    const point = project(10, 10);

    clickAt(controller, m, point.x, point.y, { shift: false, ctrl: true });
    expect([...controller.selection.list()].sort()).toEqual(soldiers.sort());

    controller.selection.clear();
    clickAt(controller, m, point.x, point.y, plain, 1000);
    clickAt(controller, m, point.x, point.y, plain, 1000 + DOUBLE_CLICK_MS - 10);
    expect([...controller.selection.list()].sort()).toEqual(soldiers.sort());
  });

  it('does not treat two slow clicks as a double-click', () => {
    const { m, controller } = setup();
    const handle = spawn(m, 'soldier', 0, 10, 10);
    spawn(m, 'soldier', 0, 20, 20);
    const point = project(10, 10);
    clickAt(controller, m, point.x, point.y, plain, 1000);
    clickAt(controller, m, point.x, point.y, plain, 1000 + DOUBLE_CLICK_MS + 50);
    expect(controller.selection.list()).toEqual([handle]);
  });

  it('drives control groups from the number row', () => {
    const { m, controller } = setup();
    const a = spawn(m, 'soldier', 0, 10, 10);
    const b = spawn(m, 'raider', 0, 20, 20);

    controller.selection.set([a]);
    expect(controller.handleDigit(2, m.units, { shift: false, ctrl: true })).toBe(true);

    controller.selection.set([b]);
    controller.handleDigit(2, m.units, { shift: true, ctrl: false }); // add to group 2
    controller.selection.clear();

    controller.handleDigit(2, m.units, plain); // recall
    expect([...controller.selection.list()].sort()).toEqual([a, b].sort());
    expect(controller.handleDigit(99, m.units, plain)).toBe(false);
  });

  it('cancels a drag without changing the selection', () => {
    const { m, controller } = setup();
    const handle = spawn(m, 'soldier', 0, 10, 10);
    controller.selection.set([handle]);
    controller.beginDrag(0, 0);
    controller.updateDrag(500, 500);
    controller.cancelDrag();
    expect(controller.dragBox()).toBeNull();
    controller.endDrag(500, 500, m.units, view, plain, 1000);
    expect(controller.selection.list()).toEqual([handle]);
  });

  it('prunes dead units out of the live selection', () => {
    const { m, controller } = setup();
    const a = spawn(m, 'soldier', 0, 10, 10);
    const b = spawn(m, 'soldier', 0, 12, 12);
    controller.selection.set([a, b]);
    despawnUnit(m.units, a);
    controller.prune(m.units);
    expect(controller.selection.list()).toEqual([b]);
  });

  it('never resolves a handle from a different generation', () => {
    const m = match();
    const handle = spawn(m, 'soldier', 0, 10, 10);
    despawnUnit(m.units, handle);
    const recycled = spawn(m, 'soldier', 0, 10, 10);
    const selection = new Selection();
    selection.set([makeHandle(0, 1)]);
    selection.prune(m.units);
    expect(selection.count).toBe(0);
    expect(recycled).not.toBe(handle);
  });
});

/**
 * A pitched camera, where height matters.
 *
 * The TOP_DOWN matrix above has no y terms at all, which is why it never
 * noticed that `unitsInRect` projected every unit at y = 0. This one lifts a
 * unit up the screen as the ground under it rises, the way any camera looking
 * down at an angle does.
 */
const PITCHED = (() => {
  const m = new Float32Array(16);
  m[0] = 1 / 64; // x -> clip.x
  m[12] = -1;
  m[9] = -1 / 36; // z -> clip.y, inverted so +z goes down the screen
  m[5] = 1 / 36; // y -> clip.y, so higher ground draws higher up
  m[13] = 1;
  m[15] = 1;
  return m;
})();

describe('picking units over terrain that is not flat', () => {
  const PLATEAU = 6;
  const groundY = (_x: number, z: number): number => (z >= 20 ? PLATEAU : 0);

  it('projects a unit at the height it is drawn at, not at zero', () => {
    // The reported bug: with a unit standing six units up, a box drawn around
    // where it appears caught nothing, and the only way to select it was to
    // drag over the whole screen.
    const m = match();
    const handle = spawn(m, 'soldier', 0, 30, 30);

    const drawn = projectPoint(PITCHED, 30, PLATEAU, 30, WIDTH, HEIGHT);
    const box = rectFromDrag(drawn.x - 20, drawn.y - 20, drawn.x + 20, drawn.y + 20);

    const withHeight = unitsInRect(m.units, PITCHED, box, {
      ownerId: 0,
      width: WIDTH,
      height: HEIGHT,
      groundY,
    });
    expect(withHeight).toEqual([handle]);

    // And without the height, the same box misses it — which is the bug.
    const flat = unitsInRect(m.units, PITCHED, box, {
      ownerId: 0,
      width: WIDTH,
      height: HEIGHT,
    });
    expect(flat).toEqual([]);
  });

  it('clicks a unit standing on high ground', () => {
    const m = match();
    const handle = spawn(m, 'soldier', 0, 30, 30);
    const drawn = projectPoint(PITCHED, 30, PLATEAU, 30, WIDTH, HEIGHT);

    expect(
      unitAtPoint(m.units, PITCHED, drawn.x, drawn.y, 24, {
        ownerId: 0,
        width: WIDTH,
        height: HEIGHT,
        groundY,
      }),
    ).toBe(handle);
  });

  it('keeps units at different heights apart on screen', () => {
    // Two units at the same x and adjacent z, one on the plateau and one in
    // the basin. Projected at y = 0 they land almost on top of each other; at
    // their real heights they are a plateau apart.
    const m = match();
    spawn(m, 'soldier', 0, 30, 19);
    spawn(m, 'soldier', 0, 30, 21);

    const low = projectPoint(PITCHED, 30, groundY(30, 19), 19, WIDTH, HEIGHT);
    const high = projectPoint(PITCHED, 30, groundY(30, 21), 21, WIDTH, HEIGHT);
    expect(Math.abs(low.y - high.y)).toBeGreaterThan(40);

    const around = (p: { x: number; y: number }) =>
      unitsInRect(m.units, PITCHED, rectFromDrag(p.x - 15, p.y - 15, p.x + 15, p.y + 15), {
        ownerId: 0,
        width: WIDTH,
        height: HEIGHT,
        groundY,
      });
    expect(around(low)).toHaveLength(1);
    expect(around(high)).toHaveLength(1);
  });

  it('still works with no height lookup at all, on a flat map', () => {
    const m = match();
    const handle = spawn(m, 'soldier', 0, 30, 10);
    const drawn = projectPoint(PITCHED, 30, 0, 10, WIDTH, HEIGHT);
    const box = rectFromDrag(drawn.x - 20, drawn.y - 20, drawn.x + 20, drawn.y + 20);
    expect(
      unitsInRect(m.units, PITCHED, box, { ownerId: 0, width: WIDTH, height: HEIGHT }),
    ).toEqual([handle]);
  });
});
