/**
 * The game's console commands and cvars.
 *
 * Kept apart from `ui/console.ts` so the console engine stays a general thing
 * with no idea what a mineral is, and apart from `app.ts` so the shell does
 * not grow another three hundred lines. Everything the commands need arrives
 * through `ConsoleGame`, which is the same surface the main menu uses.
 *
 * The rule that shapes this file: **a console command never writes match
 * state**. `give`, `spawn` and `kill` build a `SimCommand` and queue it, so it
 * is applied at a tick boundary, recorded in the replay, and — in a networked
 * match — shipped to the other client rather than applied behind its back.
 * That is also why cheats are locked off when a relay is involved: the gate is
 * not about fairness, it is that one client inventing units the other never
 * hears about is a desync.
 */
import type { GameConsole } from '../ui/console.ts';
import { CommandKind } from '../sim/commands.ts';
import type { Match } from '../sim/match.ts';
import { UNIT_TYPES, unitType, unitTypeById } from '../sim/unittypes.ts';
import { NULL_HANDLE, OrderKind, resolve } from '../sim/units.ts';
import type { UnitHandle } from '../sim/units.ts';
import { DEFAULT_LIGHT_SCALE } from '../render/terrainMaterial.ts';
import { fromInt } from '../sim/fixed.ts';
import { hashMatch } from '../sim/statehash.ts';
import { cellCentreHeight, cellSlope } from '../sim/terrain.ts';
import { cellFromWorld } from '../sim/world.ts';
import type { World } from '../sim/world.ts';
import { toFloat } from '../sim/fixed.ts';

/** Everything the console needs from the running application. */
/** One map the content pack offers. */
export interface PackMap {
  readonly slug: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface ConsoleGame {
  world(): World;
  match(): Match | null;
  /** Units the player has selected, for commands that act on a selection. */
  selection(): readonly UnitHandle[];
  /** Where the camera is looking, so `spawn` has somewhere to put things. */
  focus(): { x: number; z: number };
  localPlayer(): number;

  /** Maps the content pack brought. Empty when there is no pack. */
  availableMaps(): readonly PackMap[];
  /** The slug of the loaded pack map, or '' for the built-in fixture. */
  currentMap(): string;
  /** Swap the world for a pack map. Resolves false if it could not load. */
  loadMap(slug: string): Promise<boolean>;

  startMatch(seed?: number): void;
  stopMatch(): void;
  connect(url: string, matchId: string): void;
  openEditor(): void;
  closeEditor(): void;
  inEditor(): boolean;
  playLastReplay(): void;
  /** Whether a finished match is available to replay. */
  hasReplay(): boolean;
  saveReplay(): void;
  stressSpawn(perSide: number): number;

  /** Renderer and UI switches the cvars flip. */
  setFogEnabled(enabled: boolean): void;
  setOverlayLayer(id: string | null): void;
  overlayLayers(): readonly string[];
  setWireframe(enabled: boolean): void;
  /** Blur radius the fog edge is sampled with, in cells. */
  setFogSoftness(texels: number): void;
  /** Sun shadows from units and scenery. */
  setShadowsEnabled(enabled: boolean): void;
  /** How brightly a map's own lighting is applied. */
  setLightScale(scale: number): void;
  setStatsVisible(visible: boolean): void;
  setCameraSpeed(scale: number): void;
}

/** Look up a unit type by name or by id, so `spawn 1` works as well as names. */
function resolveType(token: string): number {
  const byName = UNIT_TYPES.find((t) => t.id === token.toLowerCase());
  if (byName) return byName.typeId;
  const id = Number(token);
  if (Number.isInteger(id) && id >= 0 && id < UNIT_TYPES.length) return id;
  throw new Error(`no unit type called '${token}' — try: ${UNIT_TYPES.map((t) => t.id).join(', ')}`);
}

export function registerGameCommands(console: GameConsole, game: ConsoleGame): void {
  // ---------------------------------------------------------------- cvars

  console.cvar({
    name: 'r_fog',
    help:
      'Draw fog of war. 0 reveals the whole map and every unit on it, for this' +
      ' client only — the simulation still fogs, so vision still gates combat.',
    // Off by default while the game is being built; a networked match turns
    // it back on, because a client that cannot see fog sees what others hide.
    value: false,
    fair: true,
    cheat: true,
    onChange: (value) => game.setFogEnabled(value === true),
  });

  console.cvar({
    name: 'r_overlay',
    help: `Debug terrain overlay: off, or one of ${game.overlayLayers().join(', ')}.`,
    value: 'off',
    onChange: (value) => game.setOverlayLayer(value === 'off' ? null : String(value)),
  });

  console.cvar({
    name: 'r_lightscale',
    help: "How brightly a map's own lighting is applied. 1 is literal, 2 is the era's doubling.",
    value: DEFAULT_LIGHT_SCALE,
    min: 0.25,
    max: 3,
    archive: true,
    onChange: (value) => game.setLightScale(Number(value)),
  });

  console.cvar({
    name: 'r_fogsoftness',
    help: 'How far the fog edge is blurred, in cells. 0.5 is crisp, 2 is hazy.',
    value: 0.9,
    min: 0,
    max: 4,
    archive: true,
    onChange: (value) => game.setFogSoftness(Number(value)),
  });

  console.cvar({
    name: 'r_shadows',
    help: 'Sun shadows cast by units and scenery. 0 turns them off, and saves a render pass.',
    value: true,
    archive: true,
    onChange: (value) => game.setShadowsEnabled(value === true),
  });

  console.cvar({
    name: 'r_wireframe',
    help: 'Draw the terrain as wireframe.',
    value: false,
    onChange: (value) => game.setWireframe(value === true),
  });

  console.cvar({
    name: 'cl_showstats',
    help: 'Show the frame and simulation readout.',
    value: true,
    archive: true,
    onChange: (value) => game.setStatsVisible(value === true),
  });

  console.cvar({
    name: 'cam_speed',
    help: 'Camera pan speed, as a multiple of the default.',
    value: 1,
    min: 0.1,
    max: 5,
    archive: true,
    onChange: (value) => game.setCameraSpeed(Number(value)),
  });

  // ------------------------------------------------------------- commands

  console.register({
    name: 'map',
    help:
      'Start a match on the loaded map, or on a named one. With no arguments,' +
      ' lists the maps the content pack brought.',
    usage: 'map [name|seed]',
    complete: (prefix) =>
      game
        .availableMaps()
        .map((entry) => entry.slug)
        .filter((slug) => slug.startsWith(prefix)),
    run({ args, print }) {
      const maps = game.availableMaps();

      if (args.length === 0) {
        if (maps.length === 0) {
          print('no content pack maps; `map <seed>` starts on the loaded one');
          return;
        }
        for (const entry of maps) {
          const mark = entry.slug === game.currentMap() ? '*' : ' ';
          print(`${mark} ${entry.slug}  ${entry.width}x${entry.height}  ${entry.name}`);
        }
        return;
      }

      // A bare number is a seed, the way this command has always worked; a
      // name is a map to load. Nothing named a map after a number, and
      // checking the list first would make `map 7` ambiguous forever.
      const seed = Number(args[0]);
      if (Number.isFinite(seed)) {
        game.stopMatch();
        game.startMatch(Math.trunc(seed));
        print(`started a match with seed ${Math.trunc(seed)}`);
        return;
      }

      const slug = String(args[0]);
      if (!maps.some((entry) => entry.slug === slug)) {
        throw new Error(`no such map: ${slug}`);
      }
      print(`loading ${slug}...`);
      void game.loadMap(slug).then((loaded) => {
        print(loaded ? `loaded ${slug}` : `could not load ${slug}`);
      });
    },
  });

  console.register({
    name: 'disconnect',
    help: 'Stop the running match and return to the menu.',
    run({ print }) {
      game.stopMatch();
      print('match stopped');
    },
  });

  console.register({
    name: 'connect',
    help: 'Join a networked match through a relay.',
    usage: 'connect <url> [matchId]',
    run({ args, print }) {
      const url = args[0];
      if (url === undefined) throw new Error('usage: connect <url> [matchId]');
      game.connect(url, args[1] ?? 'default');
      print(`connecting to ${url}...`);
    },
  });

  console.register({
    name: 'editor',
    help: 'Open or close the map editor.',
    usage: 'editor [0|1]',
    run({ args, print }) {
      const wanted = args[0] === undefined ? !game.inEditor() : args[0] !== '0';
      if (wanted) game.openEditor();
      else game.closeEditor();
      print(wanted ? 'editor open' : 'editor closed');
    },
  });

  console.register({
    name: 'replay',
    help: 'Play back the last finished match, or save it to a file.',
    usage: 'replay play|save',
    run({ args, print }) {
      const what = args[0] ?? 'play';
      if (what === 'save') {
        game.saveReplay();
        print('saving replay');
        return;
      }
      game.playLastReplay();
      print('playing the last replay');
    },
  });

  console.register({
    name: 'hash',
    help: 'Print the running match state hash, for comparing against another client.',
    run({ print }) {
      const match = game.match();
      if (!match) {
        print('no match running', 'warn');
        return;
      }
      print(`tick ${match.tick}  hash 0x${(hashMatch(match) >>> 0).toString(16).padStart(8, '0')}`);
    },
  });

  console.register({
    name: 'status',
    help: 'Summarise the running match.',
    run({ print }) {
      const match = game.match();
      const world = game.world();
      print(`map        ${world.width} x ${world.height}`);
      if (!match) {
        print('match      not running');
        return;
      }
      print(`tick       ${match.tick}`);
      print(`players    ${match.playerCount}`);
      print(`units      ${match.units.alive} alive of ${match.units.count} slots`);
      print(`selected   ${game.selection().length}`);
      for (let player = 0; player < match.playerCount; player++) {
        print(`player ${player}   ${match.minerals[player]} minerals, ${match.gas[player]} gas`);
      }
    },
  });

  console.register({
    name: 'where',
    help: 'Describe the ground under the camera.',
    run({ print }) {
      const world = game.world();
      const focus = game.focus();
      const cell = cellFromWorld(world, fromInt(Math.round(focus.x)), fromInt(Math.round(focus.z)));
      if (cell < 0) {
        print('the camera is not over the map', 'warn');
        return;
      }
      print(`cell   ${cell}  (${cell % world.width}, ${(cell / world.width) | 0})`);
      print(`height ${toFloat(cellCentreHeight(world, cell)).toFixed(2)}`);
      print(`slope  ${toFloat(cellSlope(world, cell)).toFixed(3)}`);
    },
  });

  console.register({
    name: 'unittypes',
    help: 'List the unit types spawn and build accept.',
    run({ print }) {
      for (const type of UNIT_TYPES) {
        print(
          `${String(type.typeId).padStart(2)}  ${type.id.padEnd(10)} ${type.mineralCost}m ${type.gasCost}g` +
            `${type.isStructure ? '  [structure]' : ''}`,
        );
      }
    },
  });

  // --------------------------------------------------------------- cheats

  console.register({
    name: 'give',
    help: 'Grant resources to the local player.',
    usage: 'give <minerals> [gas]',
    cheat: true,
    run({ args, console: c, print }) {
      const minerals = Number(args[0] ?? 1000);
      const gas = Number(args[1] ?? 0);
      if (!Number.isFinite(minerals) || !Number.isFinite(gas)) {
        throw new Error('usage: give <minerals> [gas]');
      }
      if (!game.match()) {
        print('no match running', 'warn');
        return;
      }
      c.queue({
        kind: CommandKind.GrantResources,
        player: game.localPlayer(),
        minerals: Math.trunc(minerals),
        gas: Math.trunc(gas),
      });
      print(`queued ${minerals} minerals and ${gas} gas`);
    },
  });

  console.register({
    name: 'spawn',
    help: 'Spawn units at the camera. They arrive at the next tick boundary.',
    usage: 'spawn <type> [count] [player]',
    cheat: true,
    run({ args, console: c, print }) {
      const token = args[0];
      if (token === undefined) throw new Error('usage: spawn <type> [count] [player]');
      const typeId = resolveType(token);
      const count = Math.max(1, Math.min(200, Number(args[1] ?? 1) || 1));
      const player = Number(args[2] ?? game.localPlayer());
      const match = game.match();
      if (!match) {
        print('no match running', 'warn');
        return;
      }

      // A small spiral out from the camera, so a count of twenty does not put
      // twenty units on one cell and leave separation to sort it out.
      const focus = game.focus();
      for (let i = 0; i < count; i++) {
        const ring = Math.floor(Math.sqrt(i));
        const angle = i * 2.399963; // golden angle, which spreads without clumping
        c.queue({
          kind: CommandKind.SpawnUnit,
          player,
          typeId,
          x: fromInt(Math.round(focus.x + Math.cos(angle) * ring)),
          z: fromInt(Math.round(focus.z + Math.sin(angle) * ring)),
        });
      }
      print(`queued ${count} x ${unitTypeById(UNIT_TYPES[typeId]?.id ?? '').id} for player ${player}`);
    },
  });

  console.register({
    name: 'kill',
    help: 'Remove the selected units.',
    cheat: true,
    run({ console: c, print }) {
      const match = game.match();
      const selected = game.selection();
      if (!match || selected.length === 0) {
        print('nothing selected', 'warn');
        return;
      }
      for (const handle of selected) {
        if (resolve(match.units, handle) < 0) continue;
        c.queue({ kind: CommandKind.DespawnUnit, handle });
      }
      print(`queued ${selected.length} removals`);
    },
  });

  /**
   * Takeoff and landing, for the aircraft in the selection.
   *
   * Not cheats: they are ordinary orders a player can give, and like every
   * order they go on the command queue rather than touching the store.
   */
  for (const [name, kind, help] of [
    ['takeoff', OrderKind.TakeOff, 'Order the selected aircraft into the air.'],
    ['land', OrderKind.Land, 'Order the selected aircraft to land where they are.'],
  ] as const) {
    console.register({
      name,
      help,
      run({ console: c, print }) {
        const match = game.match();
        const selected = game.selection();
        if (!match || selected.length === 0) {
          print('nothing selected', 'warn');
          return;
        }

        const aircraft = selected.filter((handle) => {
          const index = resolve(match.units, handle);
          return index >= 0 && unitType(match.units.typeId[index] as number).isAircraft;
        });
        if (aircraft.length === 0) {
          print('nothing selected that can fly', 'warn');
          return;
        }

        c.queue({
          kind: CommandKind.IssueOrders,
          player: game.localPlayer(),
          handles: [...aircraft],
          order: { kind, cell: -1, target: NULL_HANDLE },
          queue: false,
        });
        print(`${name}: ${aircraft.length} aircraft`);
      },
    });
  }

  console.register({
    name: 'stress',
    help: 'Spawn the M33 stress army, for profiling the renderer.',
    usage: 'stress [perSide]',
    cheat: true,
    run({ args, print }) {
      const perSide = Math.max(1, Math.min(2000, Number(args[0] ?? 400) || 400));
      const spawned = game.stressSpawn(perSide);
      print(`spawned ${spawned} units`);
    },
  });
}
