import { describe, expect, it, vi } from 'vitest';
import { createConsole } from '../src/ui/console.ts';
import type { GameConsole } from '../src/ui/console.ts';
import { registerGameCommands } from '../src/game/consolecommands.ts';
import type { ConsoleGame } from '../src/game/consolecommands.ts';
import { CommandKind } from '../src/sim/commands.ts';
import type { SimCommand } from '../src/sim/commands.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { spawnUnit } from '../src/sim/units.ts';
import { unitTypeById } from '../src/sim/unittypes.ts';
import { fromInt, toFloat } from '../src/sim/fixed.ts';

function setup(overrides: Partial<ConsoleGame> = {}): {
  console: GameConsole;
  queued: SimCommand[];
  game: ConsoleGame;
  calls: Record<string, unknown[]>;
} {
  const world = createTestMap();
  const match = createMatchFromWorld({ world, seed: 1, playerCount: 2 });
  const queued: SimCommand[] = [];
  const calls: Record<string, unknown[]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      (calls[name] ??= []).push(args);
    };

  const game: ConsoleGame = {
    world: () => world,
    match: () => match,
    selection: () => [],
    focus: () => ({ x: 20, z: 20 }),
    localPlayer: () => 0,
    availableMaps: () => [],
    currentMap: () => '',
    loadMap: () => Promise.resolve(false),
    startMatch: record('startMatch'),
    stopMatch: record('stopMatch'),
    connect: record('connect'),
    openEditor: record('openEditor'),
    closeEditor: record('closeEditor'),
    inEditor: () => false,
    playLastReplay: record('playLastReplay'),
    hasReplay: () => true,
    saveReplay: record('saveReplay'),
    stressSpawn: () => 42,
    setFogEnabled: record('setFogEnabled'),
    setOverlayLayer: record('setOverlayLayer'),
    overlayLayers: () => ['walkable', 'slope'],
    setWireframe: record('setWireframe'),
    setFogSoftness: record('setFogSoftness'),
    setStatsVisible: record('setStatsVisible'),
    setCameraSpeed: record('setCameraSpeed'),
    ...overrides,
  };

  const console = createConsole({ queue: (command) => queued.push(command) });
  registerGameCommands(console, game);
  return { console, queued, game, calls };
}

function output(console: GameConsole): string {
  return console.lines.map((l) => l.text).join('\n');
}

describe('cheats reach the simulation only through the command queue', () => {
  it('give queues a GrantResources rather than adding minerals', () => {
    // The whole reason the console is allowed to have cheats at all. Writing
    // match.minerals directly would work locally and desync every other
    // client in a networked match.
    const { console, queued, game } = setup();
    const before = game.match()!.minerals[0];

    console.execute('sv_cheats 1');
    console.execute('give 500 100');

    expect(game.match()!.minerals[0]).toBe(before);
    expect(queued).toEqual([
      { kind: CommandKind.GrantResources, player: 0, minerals: 500, gas: 100 },
    ]);
  });

  it('spawn queues one SpawnUnit per unit, spread around the camera', () => {
    const { console, queued } = setup();
    console.execute('sv_cheats 1');
    console.execute('spawn soldier 5');

    expect(queued).toHaveLength(5);
    const typeId = unitTypeById('soldier').typeId;
    for (const command of queued) {
      expect(command.kind).toBe(CommandKind.SpawnUnit);
      expect((command as { typeId: number }).typeId).toBe(typeId);
    }
    // Not all on one cell: the first two land somewhere different.
    const first = queued[0] as { x: number; z: number };
    const last = queued[4] as { x: number; z: number };
    expect(`${first.x},${first.z}`).not.toBe(`${last.x},${last.z}`);
  });

  it('spawn accepts a type id as readily as a name', () => {
    const { console, queued } = setup();
    console.execute('sv_cheats 1');
    console.execute('spawn 1');
    expect((queued[0] as { typeId: number }).typeId).toBe(1);
  });

  it('spawn names the types it knows when given something else', () => {
    const { console, queued } = setup();
    console.execute('sv_cheats 1');
    console.execute('spawn wombat');
    expect(queued).toHaveLength(0);
    expect(output(console)).toContain('no unit type');
    expect(output(console)).toContain('soldier');
  });

  it('spawn clamps an absurd count rather than queueing a million commands', () => {
    const { console, queued } = setup();
    console.execute('sv_cheats 1');
    console.execute('spawn soldier 99999');
    expect(queued.length).toBeLessThanOrEqual(200);
  });

  it('kill queues a DespawnUnit for each selected unit', () => {
    const world = createTestMap();
    const match = createMatchFromWorld({ world, seed: 1, playerCount: 2 });
    const handles = [
      spawnUnit(match.units, {
        type: unitTypeById('soldier'),
        ownerId: 0,
        x: fromInt(20),
        z: fromInt(20),
      }),
      spawnUnit(match.units, {
        type: unitTypeById('soldier'),
        ownerId: 0,
        x: fromInt(21),
        z: fromInt(20),
      }),
    ];
    const { console, queued } = setup({ match: () => match, selection: () => handles });
    const before = match.units.alive;

    console.execute('sv_cheats 1');
    console.execute('kill');

    // Still alive: the command is queued, not applied. The match has its own
    // starting workers too, which is why this compares against a snapshot
    // rather than against two.
    expect(match.units.alive).toBe(before);
    expect(queued.map((c) => c.kind)).toEqual([
      CommandKind.DespawnUnit,
      CommandKind.DespawnUnit,
    ]);
  });

  it('refuses every cheat with cheats off', () => {
    const { console, queued } = setup();
    for (const line of ['give 500', 'spawn soldier', 'kill', 'stress 10']) {
      console.execute(line);
    }
    expect(queued).toHaveLength(0);
    expect(output(console)).toContain('sv_cheats 1');
  });

  it('says so instead of queueing when no match is running', () => {
    const { console, queued } = setup({ match: () => null });
    console.execute('sv_cheats 1');
    console.execute('give 500');
    expect(queued).toHaveLength(0);
    expect(output(console)).toContain('no match running');
  });
});

describe('cvars drive the renderer', () => {
  it('turns fog off and on, as a cheat', () => {
    const { console, calls } = setup();
    console.execute('r_fog 0');
    expect(calls['setFogEnabled']).toBeUndefined(); // refused: it is a cheat

    console.execute('sv_cheats 1');
    console.execute('r_fog 0');
    expect(calls['setFogEnabled']).toEqual([[false]]);
  });

  it('selects an overlay layer by name, and off means null', () => {
    const { console, calls } = setup();
    console.execute('r_overlay slope');
    console.execute('r_overlay off');
    expect(calls['setOverlayLayer']).toEqual([['slope'], [null]]);
  });

  it('lists the real layers in its help text', () => {
    const { console } = setup();
    console.execute('help r_overlay');
    expect(output(console)).toContain('walkable');
    expect(output(console)).toContain('slope');
  });

  it('clamps camera speed to a sane range', () => {
    const { console, calls } = setup();
    console.execute('cam_speed 99');
    expect(calls['setCameraSpeed']).toEqual([[5]]);
  });

  it('archives the settings worth keeping, and not the debug ones', () => {
    const { console } = setup();
    console.execute('sv_cheats 1');
    console.execute('cl_showstats 0');
    console.execute('cam_speed 2');
    console.execute('r_wireframe 1');

    const config = console.saveConfig();
    expect(config).toContain('cl_showstats 0');
    expect(config).toContain('cam_speed 2');
    expect(config).not.toContain('r_wireframe');
    expect(config).not.toContain('sv_cheats');
  });
});

describe('plain commands', () => {
  it('map restarts the match with a seed', () => {
    const { console, calls } = setup();
    console.execute('map 7');
    expect(calls['stopMatch']).toHaveLength(1);
    expect(calls['startMatch']).toEqual([[7]]);
  });

  it('connect passes the relay and match id through', () => {
    const { console, calls } = setup();
    console.execute('connect ws://localhost:8787 arena');
    expect(calls['connect']).toEqual([['ws://localhost:8787', 'arena']]);
  });

  it('connect needs a url', () => {
    const { console, calls } = setup();
    console.execute('connect');
    expect(calls['connect']).toBeUndefined();
    expect(output(console)).toContain('usage: connect');
  });

  it('editor toggles when given no argument', () => {
    const inEditor = vi.fn(() => false);
    const { console, calls } = setup({ inEditor });
    console.execute('editor');
    expect(calls['openEditor']).toHaveLength(1);
    console.execute('editor 0');
    expect(calls['closeEditor']).toHaveLength(1);
  });

  it('status describes the match without touching it', () => {
    const { console, game } = setup();
    const before = game.match()!.tick;
    console.execute('status');
    expect(output(console)).toContain('units');
    expect(output(console)).toContain('player 0');
    expect(game.match()!.tick).toBe(before);
  });

  it('where reports the ground under the camera', () => {
    const { console, game } = setup();
    console.execute('where');
    // The camera is over the plateau in the fixture, six units up.
    expect(output(console)).toMatch(/height\s+6\.00/);
    expect(output(console)).toContain('slope');
    expect(toFloat(fromInt(1))).toBe(1); // sanity: fixed-point helpers imported
    expect(game.match()).not.toBeNull();
  });

  it('hash prints a tick and a hash, and says so when there is no match', () => {
    const { console } = setup();
    console.execute('hash');
    expect(output(console)).toMatch(/tick \d+\s+hash 0x[0-9a-f]{8}/);

    const empty = setup({ match: () => null });
    empty.console.execute('hash');
    expect(output(empty.console)).toContain('no match running');
  });

  it('unittypes lists something buildable', () => {
    const { console } = setup();
    console.execute('unittypes');
    expect(output(console)).toContain('soldier');
    expect(output(console)).toContain('[structure]');
  });
});
