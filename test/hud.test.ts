// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commandsFor, createHud } from '../src/ui/hud.ts';
import { createMinimap } from '../src/ui/minimap.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { placeBuilding } from '../src/sim/building.ts';
import { spawnUnit, resolve } from '../src/sim/units.ts';
import type { UnitHandle } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { createCostGrid } from '../src/nav/grid.ts';
import { stepMatch } from '../src/sim/tick.ts';
import * as w from '../src/sim/world.ts';
import { ONE, fromInt } from '../src/sim/fixed.ts';

function setup(minerals = 1000) {
  const world = w.createWorld({ width: 48, height: 48 });
  world.startLocations.push({ cell: w.cellIndex(world, 24, 24) });
  const match = createMatchFromWorld({
    world,
    seed: 1,
    playerCount: 2,
    startingWorkers: 0,
    startingDepots: 0,
    startingMinerals: minerals,
    costGrid: createCostGrid(world),
  });
  return { world, match, context: { world } };
}

function spawn(match: ReturnType<typeof createMatchFromWorld>, type: string, owner = 0): UnitHandle {
  return spawnUnit(match.units, {
    type: unitTypeById(type),
    ownerId: owner,
    x: fromInt(30) + ONE / 2,
    z: fromInt(30) + ONE / 2,
  });
}

describe('the command card', () => {
  it('is empty with nothing selected', () => {
    const { match } = setup();
    expect(commandsFor(match, [], 0)).toEqual([]);
  });

  it('offers movement commands for units', () => {
    const { match } = setup();
    const handle = spawn(match, 'soldier');
    const ids = commandsFor(match, [handle], 0).map((b) => b.id);
    expect(ids).toContain('stop');
    expect(ids).toContain('hold');
    expect(ids).toContain('attack-move');
    // A soldier cannot gather or build.
    expect(ids).not.toContain('gather');
    expect(ids.some((id) => id.startsWith('build-'))).toBe(false);
  });

  it('offers gathering and building for workers', () => {
    const { match } = setup();
    const handle = spawn(match, 'worker');
    const ids = commandsFor(match, [handle], 0).map((b) => b.id);
    expect(ids).toContain('gather');
    expect(ids).toContain('build-depot');
    expect(ids).toContain('build-barracks');
  });

  it('greys out what the player cannot afford', () => {
    const { match } = setup(10);
    const handle = spawn(match, 'worker');
    const build = commandsFor(match, [handle], 0).find((b) => b.id === 'build-barracks');
    expect(build?.enabled).toBe(false);
    expect(build?.cost?.minerals).toBe(unitTypeById('barracks').mineralCost);
  });

  it('offers production for a finished structure', () => {
    const { world, match, context } = setup();
    const handle = placeBuilding(match, world, 0, unitTypeById('barracks'), w.cellIndex(world, 10, 10));
    const ids = () => commandsFor(match, [handle], 0).map((b) => b.id);
    // Nothing while it is still going up.
    expect(ids()).toEqual([]);

    for (let i = 0; i < unitTypeById('barracks').buildTicks + 2; i++) stepMatch(match, [], context);
    expect(ids()).toContain('produce-soldier');
    expect(ids()).toContain('produce-siege');
    expect(ids()).not.toContain('produce-worker'); // a barracks makes no workers
  });

  it('shows unit commands for a mixed selection', () => {
    // Box-selecting a base and an army together should offer the army's verbs.
    const { world, match, context } = setup();
    const building = placeBuilding(match, world, 0, unitTypeById('barracks'), w.cellIndex(world, 10, 10));
    for (let i = 0; i < unitTypeById('barracks').buildTicks + 2; i++) stepMatch(match, [], context);
    const soldier = spawn(match, 'soldier');
    const ids = commandsFor(match, [building, soldier], 0).map((b) => b.id);
    expect(ids).toContain('stop');
    expect(ids).not.toContain('produce-soldier');
  });

  it('ignores units the player does not own', () => {
    const { match } = setup();
    const theirs = spawn(match, 'soldier', 1);
    expect(commandsFor(match, [theirs], 0)).toEqual([]);
  });

  it('drops stale handles', () => {
    const { match } = setup();
    const handle = spawn(match, 'soldier');
    match.units.isAlive[resolve(match.units, handle)] = 0;
    expect(commandsFor(match, [handle], 0)).toEqual([]);
  });
});

describe('the HUD element', () => {
  let overlay: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="overlay"></div>';
    overlay = document.getElementById('overlay') as HTMLElement;
  });

  it('shows resources and the selection', () => {
    const { match } = setup(250);
    const hud = createHud({
      overlay,
      localPlayer: 0,
      onCommand: () => {},
      onMinimapJump: () => {},
    });
    const a = spawn(match, 'worker');
    const b = spawn(match, 'worker');
    hud.update(match, [a, b]);

    expect(overlay.textContent).toContain('250');
    expect(overlay.querySelector('.hud-selection')?.textContent).toContain('Worker');
    expect(overlay.querySelector('.hud-selection')?.textContent).toContain('2');
    hud.dispose();
  });

  it('fires a command from a click and from its hotkey', () => {
    const { match } = setup();
    const onCommand = vi.fn();
    const hud = createHud({ overlay, localPlayer: 0, onCommand, onMinimapJump: () => {} });
    hud.update(match, [spawn(match, 'soldier')]);

    overlay.querySelectorAll<HTMLButtonElement>('.hud-button')[0]?.click();
    expect(onCommand).toHaveBeenCalledTimes(1);

    expect(hud.handleKey('h')).toBe(true);
    expect(onCommand).toHaveBeenCalledTimes(2);
    expect(onCommand.mock.calls[1]?.[0]).toEqual({ kind: 'hold' });
    // A key with no button bound does nothing.
    expect(hud.handleKey('z')).toBe(false);
    hud.dispose();
  });

  it('will not fire a disabled button', () => {
    const { match } = setup(0);
    const onCommand = vi.fn();
    const hud = createHud({ overlay, localPlayer: 0, onCommand, onMinimapJump: () => {} });
    hud.update(match, [spawn(match, 'worker')]);
    expect(hud.handleKey('b')).toBe(false); // cannot afford a depot
    expect(onCommand).not.toHaveBeenCalled();
    hud.dispose();
  });

  it('hides itself when no match is running, and cleans up', () => {
    const hud = createHud({ overlay, localPlayer: 0, onCommand: () => {}, onMinimapJump: () => {} });
    hud.update(null, []);
    expect(hud.root.classList.contains('is-idle')).toBe(true);
    hud.dispose();
    expect(overlay.querySelector('.hud')).toBeNull();
  });
});

describe('the follow camera button', () => {
  it('is offered for a mobile unit and pressed while that unit is followed', () => {
    const { match } = setup();
    const tank = spawn(match, 'soldier');
    const off = commandsFor(match, [tank], 0).find((b) => b.id === 'follow');
    expect(off).toMatchObject({ hotkey: 'f', active: false, action: { kind: 'follow' } });
    const on = commandsFor(match, [tank], 0, tank).find((b) => b.id === 'follow');
    expect(on?.active).toBe(true);
  });

  it('is not offered for a structure, which has nowhere to go', () => {
    const { match } = setup();
    const depot = spawn(match, 'depot');
    expect(commandsFor(match, [depot], 0).some((b) => b.id === 'follow')).toBe(false);
  });
});

describe('the minimap', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('rejects a click outside its bounds', () => {
    const world = w.createWorld({ width: 64, height: 64 });
    const minimap = createMinimap(200);
    document.body.appendChild(minimap.element);
    expect(minimap.worldAt(-10, -10, world)).toBeNull();
    minimap.dispose();
  });

  it('maps a click back to a world position, north at the top', () => {
    // The camera sits south of its focus and looks north, so on screen
    // increasing z goes *up*. The minimap has to agree, or clicking the north
    // of it sends the camera south — and reading it means mentally mirroring
    // it every time.
    //
    // jsdom gives every element a zero-sized rect, so the arithmetic here was
    // untested until this stub, which is how the minimap shipped mirrored.
    const world = w.createWorld({ width: 64, height: 64 });
    const minimap = createMinimap(200);
    document.body.appendChild(minimap.element);
    minimap.element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0 }) as DOMRect;

    // worldAt returns world units, not fixed-point: it feeds camera.moveTo.
    const top = minimap.worldAt(100, 2, world);
    const bottom = minimap.worldAt(100, 198, world);
    expect(top).not.toBeNull();
    expect(bottom).not.toBeNull();

    // Near the top of the minimap is the far, high-z edge of the map.
    expect(top!.z).toBeGreaterThan(60);
    expect(bottom!.z).toBeLessThan(4);
    // x is not flipped: left is low x, as it looks.
    expect(minimap.worldAt(2, 100, world)!.x).toBeLessThan(
      minimap.worldAt(198, 100, world)!.x,
    );

    minimap.dispose();
  });

  it('survives being drawn without a match', () => {
    const world = w.createWorld({ width: 32, height: 32 });
    const minimap = createMinimap(100);
    minimap.rebuildTerrain(world);
    expect(() =>
      minimap.draw(world, null, null, -1, { focusX: 0, focusZ: 0, halfWidth: 8, halfDepth: 8 }, [
        { r: 1, g: 1, b: 1 },
      ]),
    ).not.toThrow();
    minimap.dispose();
  });

  /** jsdom has no 2D canvas; this one records the images the minimap writes. */
  function recordingCanvas() {
    const images: ImageData[] = [];
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          createImageData: (width: number, height: number) =>
            ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
          putImageData: (image: ImageData) => images.push(image),
        }) as unknown as CanvasRenderingContext2D,
    );
    return { images, restore: () => spy.mockRestore() };
  }

  it('re-renders its terrain at a new map\'s size', () => {
    // It was drawn once at startup and never again, so every map after the
    // first showed the first one stretched to fit.
    const canvas = recordingCanvas();
    const minimap = createMinimap(100);
    minimap.rebuildTerrain(w.createWorld({ width: 32, height: 32 }));
    minimap.rebuildTerrain(w.createWorld({ width: 64, height: 48 }));
    const last = canvas.images[canvas.images.length - 1]!;
    expect([last.width, last.height]).toEqual([64, 48]);
    minimap.dispose();
    canvas.restore();
  });

  it("draws a map in its own palette's colours", () => {
    const canvas = recordingCanvas();
    const minimap = createMinimap(100);
    const world = w.createWorld({ width: 8, height: 8 });
    minimap.rebuildTerrain(world, { ground: [0.82, 0.65, 0.36], cliff: [0.58, 0.56, 0.49] });
    const sand = canvas.images[canvas.images.length - 1]!.data;
    // Sand: more red than green, more green than blue. The default relief
    // colour is green-dominant, which is what a desert used to be drawn in.
    expect(sand[0]!).toBeGreaterThan(sand[1]!);
    expect(sand[1]!).toBeGreaterThan(sand[2]!);

    minimap.rebuildTerrain(world);
    const plain = canvas.images[canvas.images.length - 1]!.data;
    expect(plain[1]!).toBeGreaterThan(plain[0]!);
    minimap.dispose();
    canvas.restore();
  });
});
