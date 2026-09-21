/**
 * Application shell: owns the renderer, the camera and the frame loop, and
 * wires the simulation's world state into both.
 */
import type { Scene } from '@babylonjs/core/scene';

import { createTestMap } from './sim/fixtures/testmap.ts';
import { toFloat } from './sim/fixed.ts';
import type { World } from './sim/world.ts';
import { hashWorld, worldFromCell } from './sim/world.ts';
import type { HeightOverrides } from './sim/terrain.ts';
import { MAX_TRAVERSABLE_SLOPE } from './sim/terrain.ts';
import { createMatchFromWorld } from './sim/matchinit.ts';
import { stepMatch } from './sim/tick.ts';
import { hashMatch } from './sim/statehash.ts';
import { setAiPlayer } from './sim/ai.ts';
import { spawnUnit, resolve } from './sim/units.ts';
import type { UnitHandle } from './sim/units.ts';
import { unitTypeById } from './sim/unittypes.ts';
import { fromInt } from './sim/fixed.ts';
import type { Driver } from './driver.ts';
import { SECONDS_PER_TICK, createDriver } from './driver.ts';
import type { Replay, ReplayRecorder } from './sim/replay.ts';
import { createRecorder, decodeReplay, describeReplay, encodeReplay } from './sim/replay.ts';
import type { ReplayPlayer } from './replayplayer.ts';
import { PLAYBACK_SPEEDS, createReplayPlayer } from './replayplayer.ts';
import type { Lockstep } from './net/lockstep.ts';
import { createLockstep } from './net/lockstep.ts';
import { connect } from './net/transport.ts';
import { createRenderer } from './render/engine.ts';
import { RtsCamera } from './render/camera.ts';
import { attachInput } from './render/input.ts';
import { createTerrain, maxTerrainHeight } from './render/terrain.ts';
import { describeFlags, pickCell, screenRay } from './render/pick.ts';
import { FLAG_LAYERS, createFlagOverlay } from './render/flagoverlay.ts';
import { createGizmos } from './render/gizmos.ts';
import { createUnitRenderer, groundHeightAt } from './render/units.ts';
import { loadContentPack, loadLoosePart } from './render/models.ts';
import type { ContentPackEntry } from './render/models.ts';
import { createDoodads } from './render/doodads.ts';
import type { AnimatedAsset, DoodadPlacement, DoodadRenderer } from './render/doodads.ts';
import { createRoads } from './render/roads.ts';
import { createShadows } from './render/shadows.ts';
import { ChaseCamera } from './render/chasecamera.ts';
import { createWater } from './render/water.ts';
import type { WaterRenderer, WaterStyle, WaterSurface } from './render/water.ts';
import type { RoadPolyline, RoadRenderer, RoadType } from './render/roads.ts';
import { createGhostRenderer } from './render/ghosts.ts';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { EXPLORED_DIM, createFogTexture } from './render/fogtexture.ts';
import {
  setTerrainFog,
  setTerrainFogSoftness,
  DEFAULT_LIGHT_SCALE,
  setTerrainLightScale,
  setTerrainPalette,
  setTerrainTextures,
  setTerrainSun,
} from './render/terrainMaterial.ts';
import { createSelectionRings } from './render/selectionrings.ts';
import { SelectionController } from './game/selectioncontroller.ts';
import { dispatchOrder } from './game/orderdispatch.ts';
import type { SimCommand } from './sim/commands.ts';
import { CommandKind } from './sim/commands.ts';
import { MOUSE_LEFT } from './render/input.ts';
import type { CostGrid } from './nav/grid.ts';
import { createCostGrid, rebuildRegion } from './nav/grid.ts';
import type { NavClient } from './nav/client.ts';
import { createNavClient, createWorkerTransport } from './nav/client.ts';
import type { FlowField } from './nav/flowfield.ts';
import { createTerrainMaterial } from './render/terrainMaterial.ts';
import { createDevOverlay } from './ui/devoverlay.ts';
import { createConsole } from './ui/console.ts';
import { createConsoleView } from './ui/consoleview.ts';
import { createMainMenu } from './ui/menu.ts';
import { registerGameCommands } from './game/consolecommands.ts';
import type { ConsoleGame, PackMap } from './game/consolecommands.ts';
import { createHud } from './ui/hud.ts';
import type { CommandAction } from './ui/hud.ts';
import { createMinimap } from './ui/minimap.ts';
import type { MinimapPalette } from './ui/minimap.ts';
import { PLAYER_COLORS } from './render/units.ts';
import { OrderKind, NULL_HANDLE } from './sim/units.ts';
import { unitType } from './sim/unittypes.ts';
import { MODE_KEY, createModeController, modeFromLocation } from './mode.ts';

/** Dev-only keybind for Babylon's Inspector. */
const INSPECTOR_KEY = 'F9';
/** Cycles the flag debug overlay: off -> unwalkable -> buildable -> ... */
const FLAG_OVERLAY_KEY = 'F3';
/** Starts or stops a test match against the map currently loaded. */
const TEST_MATCH_KEY = 'F5';
/** Saves the replay of the match that just ended. */
const SAVE_REPLAY_KEY = 'F6';
/** Loads a replay file and plays it back. */
const LOAD_REPLAY_KEY = 'F7';
/** Where archived cvars and key binds are kept between sessions. */
const CONFIG_KEY = 'web_rts.config';
/**
 * Where an optional content pack is served from.
 *
 * Deliberately not named after any particular pack: `src/` is generic, and the
 * only thing it knows is that models may be served here. Served by a dev-only
 * Vite middleware (see vite.config.ts), so a production build cannot include
 * one however it is run. Absent, units stay boxes.
 */
const CONTENT_PACK_URL = '/content-pack';

export interface App {
  /** The map currently loaded. Replaced when the editor opens a file. */
  readonly world: World;
  readonly mode: ReturnType<typeof createModeController>;
  /** The running match, or null when none is in progress. */
  readonly driver: Driver | null;
  /** The replay being played back, or null. */
  readonly playback: ReplayPlayer | null;
  /** The replay of the most recently finished match, or null. */
  readonly lastReplay: Replay | null;
  startMatch(seed?: number): void;
  stopMatch(): void;
  /** Join a networked match through a relay. */
  joinMatch(url: string, matchId: string): Promise<void>;
  /** The lockstep scheduler, when a networked match is running. */
  readonly lockstep: Lockstep | null;
  /** Hash of the running match's state, for cross-client comparison. */
  stateHash(): number;
  /** Spawn a stress army, for profiling the renderer against M33's budget. */
  stressSpawn(perSide: number): number;
  playReplay(replay: Replay): void;
  /** Solve a flow field to a cell. Used by orders, and by the browser check. */
  requestPath(cell: number): Promise<FlowField | null>;
  /** The developer console. Exposed so the browser check can drive it. */
  readonly console: ReturnType<typeof createConsole>;
  /** The main menu, open on boot unless something asked to skip it. */
  readonly menu: ReturnType<typeof createMainMenu>;
  dispose(): void;
}

export function startApp(canvas: HTMLCanvasElement, overlayRoot: HTMLElement): App {
  // `world` is replaced wholesale when the editor loads a map, so everything
  // built from it is rebuilt at the same time by loadWorld().
  let world = createTestMap();
  /** A map's scenery, replaced wholesale when another map loads. */
  let doodads: DoodadRenderer | null = null;
  let roads: RoadRenderer | null = null;
  let water: WaterRenderer | null = null;
  /**
   * Whether fog of war is drawn at all; see `r_fog`.
   *
   * It gates two separate things, which is why it is a flag rather than just
   * a call into the terrain material: the ground's darkening, and whether the
   * renderers are told who is looking. Turning off only the first leaves every
   * enemy unit invisible over fully lit ground, which is not what "disable fog
   * of war" means to anyone.
   */
  let fogEnabled = false;
  /**
   * Who the view is drawn for, or -1 to see everything.
   *
   * Only ever affects what is *drawn*. The simulation's own fog is untouched,
   * so vision still gates targeting and the state hash is unchanged — this
   * cannot desync a match, and cheats are locked off in one anyway.
   */
  const viewer = (player: number): number => (fogEnabled ? player : -1);

  /** How brightly a map's own lighting is applied; see r_lightscale. */
  let lightScale = DEFAULT_LIGHT_SCALE;
  /** The ground textures the loaded map brought, disposed when it changes. */
  let terrainTextures: Texture[] = [];
  /** What the content pack offers, empty when there is no pack. */
  let packMaps: PackMap[] = [];
  let currentMap = '';
  const renderer = createRenderer(canvas);
  const input = attachInput(canvas);
  const overlay = createDevOverlay(overlayRoot);

  const cellSize = toFloat(world.cellSize);
  const widthUnits = world.width * cellSize;
  const depthUnits = world.height * cellSize;

  const camera = new RtsCamera(renderer.scene, {
    pitchDegrees: 55,
    bounds: { minX: 0, maxX: widthUnits, minZ: 0, maxZ: depthUnits },
  });

  /**
   * The height changes the running match has made, or null in the editor.
   *
   * Invariant 5 keeps a match's terrain edits out of the world, which means
   * every consumer that reads the ground — picking, decals, the overlay — has
   * to be handed them explicitly. This is the one place that knows where they
   * live.
   */
  const heightOverrides = (): HeightOverrides | null => driver?.match.terrain ?? null;

  /** Slope as a word, for the debug overlay. */
  const describeSlope = (slope: number): string => {
    const limit = toFloat(MAX_TRAVERSABLE_SLOPE);
    if (slope >= limit) return `${slope.toFixed(2)} cliff`;
    if (slope >= limit / 2) return `${slope.toFixed(2)} steep`;
    return slope.toFixed(2);
  };

  const terrainMaterial = createTerrainMaterial(renderer.scene, {
    heightRange: maxTerrainHeight(world),
    cliffSlope: toFloat(MAX_TRAVERSABLE_SLOPE),
    lightDirection: renderer.sun.direction,
  });
  let terrain = createTerrain(renderer.scene, world, terrainMaterial);
  const shadows = createShadows(renderer.sun, terrainMaterial);
  // On, matching r_shadows' default: a cvar's default is not applied by
  // registering it, only a saved or typed value is.
  shadows.setEnabled(true);
  shadows.setMapSize(world.width * toFloat(world.cellSize), world.height * toFloat(world.cellSize));
  let flagOverlay = createFlagOverlay(renderer.scene, world);
  flagOverlay.rebuild(null);
  const gizmos = createGizmos(renderer.scene, () => world);
  gizmos.rebuild(null);

  // Pathfinding lives in a worker: a 256x256 field is several milliseconds,
  // which is a visible hitch if it lands inside a frame.
  let costGrid: CostGrid = createCostGrid(world);
  const nav: NavClient = createNavClient(createWorkerTransport());
  nav.setGrid(costGrid);
  /**
   * Units render as placeholder boxes until a content pack replaces them.
   *
   * The pack is optional and loads over the network, so the renderer is built
   * immediately without it and swapped when it arrives. Building the boxes
   * first rather than awaiting means a missing or slow pack costs a few frames
   * of placeholder geometry instead of a blank screen, which is the behaviour
   * a content pack must be additive: absent one, the game runs exactly as it
   * does today.
   */
  let unitRenderer = createUnitRenderer(renderer.scene);

  /**
   * Scene lighting a content pack's map asked for.
   *
   * A map that ships with its own sun is most of why it looks like the place
   * it is meant to be — an alpine map's light is low and cold, and the terrain
   * textures alone do not carry that.
   */
  const applyMapLighting = (lighting: {
    sun: { x: number; y: number; z: number };
    sunColor: { r: number; g: number; b: number };
    ambient: { r: number; g: number; b: number };
    terrain?: { direction: { x: number; y: number; z: number }; color: { r: number; g: number; b: number } }[];
    object?: { direction: { x: number; y: number; z: number }; color: { r: number; g: number; b: number } }[];
  }): void => {
    // Units and scenery get the *object* lights, which are a separate set from
    // the ground's and on some maps point somewhere else entirely.
    const object = lighting.object ?? [];
    const primary = object[0];
    renderer.sun.direction.set(
      primary?.direction.x ?? lighting.sun.x,
      primary?.direction.y ?? lighting.sun.y,
      primary?.direction.z ?? lighting.sun.z,
    );
    renderer.sun.diffuse.set(
      primary?.color.r ?? lighting.sunColor.r,
      primary?.color.g ?? lighting.sunColor.g,
      primary?.color.b ?? lighting.sunColor.b,
    );
    // The models were already getting the map's sun; they were not getting its
    // ambient, so a night map lit its vehicles as if it were noon while the
    // ground around them went dark. The fill light carries it now, and the
    // intensities go to 1 because the colours are the whole answer.
    renderer.sun.intensity = lightScale;
    renderer.sky.intensity = lightScale;
    // The object fill lights fold into the sky light rather than becoming two
    // more directional lights: they are dim, they point in different
    // directions on every map, and a hemispheric fill is a fair approximation
    // of two of them at a fraction of the shader cost.
    let fillR = 0;
    let fillG = 0;
    let fillB = 0;
    for (const fill of object.slice(1)) {
      fillR += fill.color.r;
      fillG += fill.color.g;
      fillB += fill.color.b;
    }
    renderer.sky.diffuse.set(
      lighting.ambient.r + fillR,
      lighting.ambient.g + fillG,
      lighting.ambient.b + fillB,
    );
    renderer.sky.groundColor.set(
      lighting.ambient.r * 0.6,
      lighting.ambient.g * 0.6,
      lighting.ambient.b * 0.6,
    );
    setTerrainSun(
      terrainMaterial,
      lighting.sun,
      lighting.sunColor,
      lighting.ambient,
      (lighting.terrain ?? []).slice(1),
    );
    overlay.set('sun', `${lighting.sun.x.toFixed(2)}, ${lighting.sun.y.toFixed(2)}, ${lighting.sun.z.toFixed(2)}`);
  };

  void (async () => {
    // Development only, and structurally so. The pack is served by a Vite dev
    // middleware, so a production build has nothing to fetch — and probing for
    // it there would log a 404 to the console, which `check:browser` rightly
    // treats as a failure. `import.meta.env.DEV` is replaced with `false` at
    // build time, so this whole block is dropped from the shipped bundle.
    if (!import.meta.env.DEV) return;

    const baseUrl = CONTENT_PACK_URL;
    let entries: ContentPackEntry[];
    try {
      const response = await fetch(`${baseUrl}/pack.json`);
      if (!response.ok) return; // no pack installed: boxes it is
      entries = ((await response.json()) as { entries: ContentPackEntry[] }).entries;
    } catch {
      return;
    }
    if (entries.length === 0) return;

    const models = await loadContentPack(renderer.scene, { baseUrl, entries });
    if (models.size === 0) return;

    const replacement = createUnitRenderer(renderer.scene, models);
    unitRenderer.dispose();
    unitRenderer = replacement;
    overlay.set('models', `${models.size} loaded`);
  })();

  const ghostRenderer = createGhostRenderer(renderer.scene);
  const selectionRings = createSelectionRings(renderer.scene);
  let fogTexture = createFogTexture(renderer.scene, world.width, world.height);

  /**
   * The player this client controls. Single player is always 0; a networked
   * match uses whatever id the relay assigned.
   */
  const LOCAL_PLAYER = 0;
  const selection = new SelectionController(LOCAL_PLAYER);

  /** Type the player is about to place, or -1. Set by a build button. */
  let pendingBuild = -1;

  /**
   * The third-person camera, and the unit it is following.
   *
   * It takes the camera over from the overhead one while following and hands
   * it back on a glide when let go; `render/chasecamera.ts` has the why of the
   * smoothing. The overhead camera's focus is kept under the unit meanwhile, so
   * letting go lands looking down at where the unit is, not where the camera
   * was when it started following.
   */
  const chase = new ChaseCamera();
  let followed: UnitHandle | null = null;

  function stopFollowing(): void {
    followed = null;
    chase.release();
  }

  const hud = createHud({
    overlay: overlayRoot,
    localPlayer: LOCAL_PLAYER,
    onCommand: (action) => applyHudCommand(action),
    onMinimapJump: (x, z) => {
      // Asking to look somewhere else is asking to stop following.
      stopFollowing();
      camera.moveTo(x, z);
    },
    following: () => (chase.chasing ? followed : null),
  });
  const minimap = createMinimap();
  hud.minimapSlot.appendChild(minimap.element);
  minimap.rebuildTerrain(world);
  /** The loaded map's own colours, which the minimap is drawn in when known. */
  let minimapPalette: MinimapPalette | null = null;

  // Clicking or dragging on the minimap moves the camera there.
  let minimapDragging = false;
  const minimapJump = (event: PointerEvent): void => {
    const point = minimap.worldAt(event.clientX, event.clientY, world);
    if (point) camera.moveTo(point.x, point.z);
  };
  minimap.element.addEventListener('pointerdown', (event) => {
    minimapDragging = true;
    minimap.element.setPointerCapture(event.pointerId);
    minimapJump(event);
  });
  minimap.element.addEventListener('pointermove', (event) => {
    if (minimapDragging) minimapJump(event);
  });
  minimap.element.addEventListener('pointerup', (event) => {
    minimapDragging = false;
    minimap.element.releasePointerCapture(event.pointerId);
  });

  const dragBoxElement = document.createElement('div');
  dragBoxElement.className = 'drag-box';
  dragBoxElement.hidden = true;
  overlayRoot.appendChild(dragBoxElement);

  /**
   * Commands waiting for the next tick boundary. Input arrives whenever the
   * pointer moves; the simulation only accepts it between ticks (invariant 5).
   * M31 replaces this with the lockstep turn queue.
   */
  let pendingCommands: SimCommand[] = [];

  /** Turn a HUD button into a command, or into a pending build placement. */
  function applyHudCommand(action: CommandAction): void {
    if (!driver) return;
    const handles = selection.selection.list();

    switch (action.kind) {
      case 'follow':
        toggleFollow(handles);
        return;
      case 'stop':
        pendingBuild = -1;
        pendingCommands.push({ kind: CommandKind.StopUnits, player: LOCAL_PLAYER, handles: [...handles] });
        return;
      case 'hold':
        pendingCommands.push({
          kind: CommandKind.IssueOrders,
          player: LOCAL_PLAYER,
          handles: [...handles],
          order: { kind: OrderKind.Hold, cell: -1, target: NULL_HANDLE },
          queue: false,
        });
        return;
      case 'takeoff':
      case 'land':
        pendingCommands.push({
          kind: CommandKind.IssueOrders,
          player: LOCAL_PLAYER,
          handles: [...handles],
          order: {
            kind: action.kind === 'takeoff' ? OrderKind.TakeOff : OrderKind.Land,
            cell: -1,
            target: NULL_HANDLE,
          },
          queue: false,
        });
        return;
      case 'attack-move':
      case 'gather':
        // Both need a target the player has not picked yet; the next
        // right-click supplies it, which is what the dispatcher already does.
        return;
      case 'produce': {
        // Queue at every selected structure that can make it.
        for (const handle of handles) {
          pendingCommands.push({
            kind: CommandKind.QueueProduction,
            player: LOCAL_PLAYER,
            building: handle,
            typeId: action.typeId,
          });
        }
        return;
      }
      case 'build':
        // Placement waits for a click on the ground.
        pendingBuild = action.typeId;
        overlay.set('placing', unitType(action.typeId).name);
        return;
    }
  }

  /**
   * The canvas size in **CSS pixels**, which is the space every pointer
   * coordinate in this file is already in.
   *
   * Not `engine.getRenderWidth()`. The engine renders at device resolution —
   * `setHardwareScalingLevel(1 / devicePixelRatio)` in `render/engine.ts` — so
   * on a HiDPI display the drawing buffer is twice the CSS size. Projecting
   * units into that space and then testing them against a drag box measured in
   * CSS pixels puts every unit at double its true screen position, and
   * selection catches nothing at all. Babylon's own `createPickingRay` takes
   * CSS pixels and scales up internally, which is why terrain picking was
   * unaffected and this stayed hidden.
   */
  const viewportSize = (): { width: number; height: number } => {
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  /** View data the selection code needs, read fresh each time it is used. */
  const viewInfo = () => ({
    viewProjection: renderer.scene.getTransformMatrix().m,
    ...viewportSize(),
    // The same height the renderer draws the unit at, so what the box catches
    // is what the eye sees. Anything else and hit-testing disagrees with the
    // picture by however tall the ground is.
    groundY: (x: number, z: number) => groundHeightAt(world, heightOverrides(), x, z),
  });

  /** Swap in a different map: rebuild the scene and re-bound the camera. */
  function loadWorld(next: World): void {
    // A different map: nothing to follow, and nothing to glide back from.
    followed = null;
    chase.reset();
    const layer = flagOverlay.current();
    flagOverlay.dispose();
    terrain.dispose();
    world = next;
    terrain = createTerrain(renderer.scene, world, terrainMaterial);
    flagOverlay = createFlagOverlay(renderer.scene, world);
    flagOverlay.rebuild(heightOverrides());
    flagOverlay.show(layer);
    gizmos.rebuild(heightOverrides());
    fogTexture.dispose();
    fogTexture = createFogTexture(renderer.scene, world.width, world.height);
    setTerrainFog(terrainMaterial, null, world.width, world.height, EXPLORED_DIM);
    costGrid = createCostGrid(world);
    nav.setGrid(costGrid);
    const cell = toFloat(world.cellSize);
    // Enough height to frame the larger dimension; an imported map can be four
    // times the fixture's width.
    camera.setMaxHeight(Math.max(90, Math.max(world.width, world.height) * cell * 0.75));
    camera.setBounds(
      { minX: 0, maxX: world.width * cell, minZ: 0, maxZ: world.height * cell },
      true,
    );
    shadows.setMapSize(world.width * cell, world.height * cell);
    // The minimap caches its terrain at one pixel per cell. Left alone it goes
    // on drawing the previous map stretched to this one's size, with its fog
    // layer still sized for the old map too.
    minimapPalette = null;
    minimap.rebuildTerrain(world);
    overlay.set('map', `${world.width}x${world.height}`);
  }

  // A test match is generated from world state and discarded wholesale; the
  // world is never written to, so Test/Stop costs nothing but the spawn.
  let driver: Driver | null = null;
  // Every match is recorded. A replay is a seed and a command stream, so this
  // costs a few hundred small objects for a whole match.
  let recorder: ReplayRecorder | null = null;
  let lastReplay: Replay | null = null;
  let playback: ReplayPlayer | null = null;
  /** Set while a networked match is running; null for single player. */
  let lockstep: Lockstep | null = null;
  /** The player this client controls in a networked match. */
  let netPlayer = LOCAL_PLAYER;
  /**
   * How many height overrides the terrain mesh was last built against.
   *
   * A building levels the ground under its footprint, which changes the mesh.
   * Overrides are only ever added during a match, so the count is enough to
   * notice — and checking one integer per frame is cheaper than diffing.
   */
  let terrainOverrideCount = 0;

  /** Rebuild the terrain, overlay and gizmos against the current overrides. */
  function refreshTerrainSurface(): void {
    const overrides = heightOverrides();
    terrainOverrideCount = overrides?.count ?? 0;
    terrain.setOverrides(overrides);
    flagOverlay.rebuild(overrides);
    gizmos.rebuild(overrides);
  }

  function startMatch(seed = 1): void {
    stopPlayback();
    const before = hashWorld(world);
    // Capped rather than one per start position. An imported eight-player map
    // opens with eight bots on a 180,000-cell world, and the fog sweep and the
    // bot both scale with that — it costs twice the tick budget before anyone
    // has done anything. Four is a skirmish; eight is a stress test.
    const playerCount = Math.max(1, Math.min(4, world.startLocations.length));
    recorder = createRecorder({
      seed,
      playerCount,
      mapHash: before,
    });
    // One of every unit type on the map from the first tick, so the whole
    // roster is there to look at without building it.
    const match = createMatchFromWorld({
      world,
      seed,
      playerCount,
      costGrid,
      oneOfEachUnit: true,
    });
    // Every player but the local one is a bot, so a test match is a game
    // rather than a diorama. The bot is part of the simulation, so replays
    // re-derive it rather than recording what it did.
    for (let player = 0; player < playerCount; player++) {
      if (player !== LOCAL_PLAYER) setAiPlayer(match, player, true);
    }
    driver = createDriver(match, { world });
    refreshTerrainSurface();
    unitRenderer.captureTick(driver.match);
    unitRenderer.update(driver.match, world, driver.match.terrain, 1, viewer(LOCAL_PLAYER));
    // Only if r_fog is on: starting a match used to turn the ground's fog on
    // regardless, leaving it dark while every unit on it stayed visible.
    setTerrainFog(
      terrainMaterial,
      fogEnabled ? fogTexture.texture : null,
      world.width,
      world.height,
      EXPLORED_DIM,
    );

    // Open on the local player's base, the way an RTS does.
    const start = world.startLocations[0];
    if (start) {
      const centre = worldFromCell(world, start.cell);
      camera.moveTo(toFloat(centre.x), toFloat(centre.z));
    }
    if (hashWorld(world) !== before) {
      // Invariant 4: match setup reads world state and must not write it.
      console.error('[match] starting a match modified world state');
    }
    overlay.set('match', 'running');
    mode.editor()?.refresh();
  }

  /** Play a recorded match back. The live match, if any, is stopped first. */
  function startPlayback(replay: Replay): void {
    stopMatch();
    stopPlayback();
    try {
      playback = createReplayPlayer({ replay, world, costGrid });
    } catch (error) {
      overlay.set('replay', error instanceof Error ? error.message : 'replay failed');
      return;
    }
    unitRenderer.captureTick(playback.match);
    unitRenderer.update(playback.match, world, playback.match.terrain, 1, viewer(LOCAL_PLAYER));
    // Only if r_fog is on: starting a match used to turn the ground's fog on
    // regardless, leaving it dark while every unit on it stayed visible.
    setTerrainFog(
      terrainMaterial,
      fogEnabled ? fogTexture.texture : null,
      world.width,
      world.height,
      EXPLORED_DIM,
    );
    overlay.set('match', 'replay');
    overlay.set('replay', describeReplay(replay));
  }

  function stopPlayback(): void {
    if (!playback) return;
    playback = null;
    lastFogTick = -1;
    unitRenderer.clear();
    ghostRenderer.clear();
    selectionRings.clear();
    setTerrainFog(terrainMaterial, null, world.width, world.height, EXPLORED_DIM);
    hud.update(null, []);
    overlay.set('match', 'stopped');
    overlay.remove('speed');
  }

  /** Read a replay file the user picked and play it. */
  async function openReplay(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.rtsreplay,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
      input.click();
    });
    input.remove();
    if (!file) return;
    try {
      startPlayback(decodeReplay(await file.text(), hashWorld(world)));
    } catch (error) {
      overlay.set('replay', error instanceof Error ? error.message : 'could not read that replay');
    }
  }

  /** Download the most recent replay. */
  function saveReplay(): void {
    if (!lastReplay) {
      overlay.set('replay', 'no replay yet - finish a match first');
      return;
    }
    const blob = new Blob([encodeReplay(lastReplay)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `match-${lastReplay.seed.toString(16)}.rtsreplay`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    overlay.set('replay', 'saved');
  }

  /**
   * Join a networked match.
   *
   * The relay decides the seed and the player ids, so every client builds the
   * same opening position from the same world -- which is the only state that
   * ever crosses the wire.
   */
  async function joinMatch(url: string, matchId: string): Promise<void> {
    stopMatch();
    stopPlayback();
    overlay.set('net', 'connecting');
    // Cheats off, and not merely hidden: a console command that spawned units
    // this client never told the other about is a desync, not an unfairness.
    gameConsole.setCheatsLocked(true);

    const connection = connect({
      url,
      matchId,
      mapHash: hashWorld(world),
      onClose: (reason) => overlay.set('net', reason),
    });

    const { playerId } = await connection.welcome;
    if (playerId < 0) {
      overlay.set('net', 'room full');
      connection.close();
      return;
    }
    overlay.set('net', `player ${playerId}, waiting`);

    const start = await connection.start;
    netPlayer = playerId;
    // Same opening as a skirmish. Both clients run this, so they agree; a
    // setting that differed between them would be a desync on tick zero.
    const match = createMatchFromWorld({
      world,
      seed: start.seed,
      playerCount: start.playerCount,
      costGrid,
      oneOfEachUnit: true,
    });
    driver = createDriver(match, { world });
    lockstep = createLockstep({
      transport: connection,
      playerId,
      players: start.players,
    });
    recorder = createRecorder({
      seed: start.seed,
      playerCount: start.playerCount,
      mapHash: hashWorld(world),
    });

    unitRenderer.captureTick(match);
    unitRenderer.update(match, world, match.terrain, 1, viewer(netPlayer));
    // Only if r_fog is on: starting a match used to turn the ground's fog on
    // regardless, leaving it dark while every unit on it stayed visible.
    setTerrainFog(
      terrainMaterial,
      fogEnabled ? fogTexture.texture : null,
      world.width,
      world.height,
      EXPLORED_DIM,
    );
    const home = world.startLocations[playerId] ?? world.startLocations[0];
    if (home) {
      const centre = worldFromCell(world, home.cell);
      camera.moveTo(toFloat(centre.x), toFloat(centre.z));
    }
    overlay.set('net', `player ${playerId} of ${start.playerCount}`);
    overlay.set('match', 'multiplayer');
  }

  /**
   * Follow the first of the selection that is ours and can move, or stop if
   * the camera is already following one of them. Selecting something else and
   * pressing Follow switches to it, gliding across rather than cutting.
   */
  function toggleFollow(handles: readonly UnitHandle[]): void {
    const match = driver?.match;
    if (!match) return;
    if (chase.chasing && followed !== null && handles.includes(followed)) {
      stopFollowing();
      return;
    }
    const units = match.units;
    for (const handle of handles) {
      const index = resolve(units, handle);
      if (index < 0 || units.ownerId[index] !== LOCAL_PLAYER) continue;
      if (unitType(units.typeId[index] as number).isStructure) continue;
      const pose = unitRenderer.poseOf(index);
      if (!pose) continue;
      followed = handle;
      chase.start(
        {
          eye: {
            x: camera.camera.position.x,
            y: camera.camera.position.y,
            z: camera.camera.position.z,
          },
          look: camera.overheadPose().look,
        },
        pose,
      );
      return;
    }
  }

  /**
   * Drive the camera while the chase has it: following, or handing back.
   * Runs after the units have been placed for this frame, so the camera
   * follows where the unit is drawn now, not where it was a frame ago.
   */
  function updateChase(dt: number): void {
    if (chase.chasing) {
      const match = driver?.match ?? null;
      const index = match && followed !== null ? resolve(match.units, followed) : -1;
      const pose = index >= 0 ? unitRenderer.poseOf(index) : null;
      if (!pose) {
        // Dead, or no match any more: let go rather than stare at nothing.
        stopFollowing();
      } else {
        camera.moveTo(pose.x, pose.z);
        const covered = hud.coveredBelow() / Math.max(1, viewportSize().height);
        const view = chase.follow(
          pose,
          dt,
          (x, z) => groundHeightAt(world, heightOverrides(), x, z),
          covered,
        );
        camera.show(view.eye, view.look, view.lens);
        return;
      }
    }
    if (chase.active) {
      const view = chase.handBack(camera.overheadPose(), dt);
      if (view) camera.show(view.eye, view.look, view.lens);
    }
  }

  function stopMatch(): void {
    stopFollowing();
    if (driver && recorder) {
      lastReplay = recorder.finish(driver.match);
      overlay.set('replay', describeReplay(lastReplay));
    }
    recorder = null;
    driver = null;
    // Back to the map's own ground: the match's levelling was never the map's.
    refreshTerrainSurface();
    lockstep?.dispose();
    lockstep = null;
    netPlayer = LOCAL_PLAYER;
    gameConsole.setCheatsLocked(false);
    menu.refresh();
    overlay.remove('net');
    overlay.remove('waiting');
    mode.editor()?.refresh();
    unitRenderer.clear();
    ghostRenderer.clear();
    // Fog is a match concept: with no match running the whole map is lit.
    setTerrainFog(terrainMaterial, null, world.width, world.height, EXPLORED_DIM);
    hud.update(null, []);
    pendingCommands = [];
    pendingBuild = -1;
    overlay.remove('placing');
    overlay.remove('minimap');
    selection.selection.clear();
    selection.cancelDrag();
    selectionRings.clear();
    dragBoxElement.hidden = true;
    overlay.remove('selected');
    overlay.remove('tick');
    overlay.remove('units');
    overlay.remove('fog');
    overlay.set('match', 'stopped');
  }

  let smoothedFps = 60;
  // The frame is split so the two halves can be told apart: everything this
  // application does, and the GPU work Babylon submits. Under headless
  // software rendering the second dominates completely, and reporting a
  // combined number would say nothing about whether the simulation is fast.
  let smoothedCpuMs = 0;
  let smoothedGpuMs = 0;
  /**
   * The HUD and minimap redraw ten times a second, not sixty.
   *
   * Neither shows anything a player can perceive changing faster than that,
   * and between them they were the largest single slice of the frame at a
   * thousand units — the minimap walks every cell of the fog and the HUD does
   * DOM work.
   */
  const UI_INTERVAL_MS = 100;
  let nextUiUpdate = 0;
  /** Tick the fog texture and ghosts were last built from. */
  let lastFogTick = -1;
  renderer.engine.runRenderLoop(() => {
    const frameStarted = performance.now();
    // Scenery moves on wall-clock time in every mode, the editor included:
    // a flag that only waved during a match would look broken in the editor.
    doodads?.update(frameStarted / 1000);
    water?.update(frameStarted / 1000);
    const dt = renderer.frameDelta();
    // CSS pixels again: the camera compares these against `input.pointer`,
    // which is a CSS coordinate, and divides by them to turn a middle-drag in
    // CSS pixels into ground units.
    const view = viewportSize();
    if (chase.chasing) {
      // The wheel moves the chase camera in and out, and nothing pans: the
      // overhead camera is kept under the unit instead.
      if (!input.suppressed) chase.zoomBy(input.takeWheel());
      input.takeDrag();
    } else {
      camera.update(input, dt, view.width, view.height);
    }

    if (playback) {
      const showing = playback;
      showing.advance(dt, () => unitRenderer.captureTick(showing.match));
      unitRenderer.update(showing.match, world, showing.match.terrain, showing.driver.alpha(), viewer(LOCAL_PLAYER));
      if (showing.match.tick !== lastFogTick) {
        lastFogTick = showing.match.tick;
        ghostRenderer.update(showing.match, world, showing.match.terrain, LOCAL_PLAYER);
        fogTexture.update(showing.match.fog, LOCAL_PLAYER);
      }
      selection.prune(showing.match.units);
      selectionRings.update(selection.selection.list(), showing.match.units, world, showing.match.terrain);
      if (frameStarted >= nextUiUpdate) {
        nextUiUpdate = frameStarted + UI_INTERVAL_MS;
        hud.update(showing.match, selection.selection.list());
        minimap.draw(
          world,
          showing.match.fog,
          showing.match.units,
          viewer(LOCAL_PLAYER),
          {
            focusX: camera.focusX,
            focusZ: camera.focusZ,
            halfWidth: camera.currentHeight * 0.9,
            halfDepth: camera.currentHeight * 0.75,
          },
          PLAYER_COLORS,
        );
      }
      overlay.set('tick', `${showing.match.tick} / ${showing.replay.ticks}`);
      overlay.set('speed', showing.paused ? 'paused' : `${showing.speed}x`);
      const divergence = showing.divergence();
      if (divergence) overlay.set('desync', `tick ${divergence.tick}`);
    }

    if (driver) {
      // Capture before stepping, so interpolation has both endpoints.
      const running = driver;
      const recording = recorder;

      if (lockstep) {
        // In a networked match the scheduler decides when a tick may run, not
        // the accumulator: a tick waits for every player's commands.
        for (const command of pendingCommands) lockstep.issue(command);
        pendingCommands = [];

        const budget = Math.max(1, Math.round(dt / SECONDS_PER_TICK));
        lockstep.step(running.match, budget, (commands) => {
          unitRenderer.captureTick(running.match);
          recording?.record(running.match.tick, commands);
          stepMatch(running.match, commands, { world });
          recording?.checkpoint(running.match);
        });

        overlay.set('waiting', lockstep.stalled() ? lockstep.waitingFor().join(',') : '-');
        const halted = lockstep.halted();
        if (halted) overlay.set('net', halted);
      } else {
        running.advance(
          dt,
          (tick) => {
            const batch = pendingCommands;
            pendingCommands = [];
            recording?.record(tick, batch);
            return batch;
          },
          () => unitRenderer.captureTick(running.match),
          () => recording?.checkpoint(running.match),
        );
      }
      unitRenderer.update(running.match, world, running.match.terrain, running.alpha(), viewer(LOCAL_PLAYER));

      // Fog is recomputed every few ticks and remembered structures change
      // rarely, so neither needs touching on a frame where nothing moved.
      // The ghost pass in particular walks every cell of the map.
      if (running.match.tick !== lastFogTick) {
        lastFogTick = running.match.tick;
        ghostRenderer.update(running.match, world, running.match.terrain, LOCAL_PLAYER);
        fogTexture.update(running.match.fog, LOCAL_PLAYER);
        overlay.set('fog', `${fogTexture.lastUploadMs().toFixed(2)} ms`);
      }

      selection.prune(running.match.units);
      selectionRings.update(selection.selection.list(), running.match.units, world, running.match.terrain);

      const box = selection.dragBox();
      if (box) {
        dragBoxElement.hidden = false;
        dragBoxElement.style.left = `${box.left}px`;
        dragBoxElement.style.top = `${box.top}px`;
        dragBoxElement.style.width = `${box.right - box.left}px`;
        dragBoxElement.style.height = `${box.bottom - box.top}px`;
      } else {
        dragBoxElement.hidden = true;
      }

      overlay.set('tick', String(driver.tick()));
      overlay.set('units', String(driver.match.units.alive));
      overlay.set('selected', String(selection.selection.count));

      if (frameStarted >= nextUiUpdate) {
        nextUiUpdate = frameStarted + UI_INTERVAL_MS;
        hud.update(running.match, selection.selection.list());
        minimap.draw(
          world,
          running.match.fog,
          running.match.units,
          viewer(LOCAL_PLAYER),
          {
            focusX: camera.focusX,
            focusZ: camera.focusZ,
            halfWidth: camera.currentHeight * 0.9,
            halfDepth: camera.currentHeight * 0.75,
          },
          PLAYER_COLORS,
        );
        overlay.set('minimap', `${minimap.lastDrawMs().toFixed(2)} ms`);
      }
    }

    // After the units are placed, and before shadows are fitted to the view.
    updateChase(dt);
    shadows.update(
      camera.camera,
      groundHeightAt(world, heightOverrides(), camera.focusX, camera.focusZ),
    );

    // getFps() is NaN on the very first frames; without this guard the
    // exponential average is poisoned permanently.
    const fps = renderer.engine.getFps();
    if (Number.isFinite(fps)) smoothedFps += (fps - smoothedFps) * 0.1;
    overlay.set('fps', smoothedFps.toFixed(0));
    overlay.set('frame', `${(dt * 1000).toFixed(1)} ms`);
    overlay.set('camera', `${camera.focusX.toFixed(1)}, ${camera.focusZ.toFixed(1)}`);
    overlay.set('height', camera.currentHeight.toFixed(1));
    overlay.set('draws', String(renderer.scene.getActiveMeshes().length));

    if (input.pointer.inside) {
      const ray = screenRay(renderer.scene, camera.camera, input.pointer.x, input.pointer.y);
      const hit = pickCell(world, ray, undefined, heightOverrides());
      overlay.set('cell', hit ? `${hit.cell} (${hit.cx},${hit.cy})` : '-');
      overlay.set('ground', hit ? hit.height.toFixed(2) : '-');
      overlay.set('slope', hit ? describeSlope(hit.slope) : '-');
      overlay.set('flags', hit ? describeFlags(hit.flags) : '-');
    } else {
      overlay.set('cell', '-');
      overlay.set('ground', '-');
      overlay.set('slope', '-');
      overlay.set('flags', '-');
    }

    const cpuMs = performance.now() - frameStarted;
    const renderStarted = performance.now();
    renderer.scene.render();
    const gpuMs = performance.now() - renderStarted;

    // A building that finished levelling its footprint changed the ground.
    if ((heightOverrides()?.count ?? 0) !== terrainOverrideCount) refreshTerrainSurface();

    smoothedCpuMs += (cpuMs - smoothedCpuMs) * 0.1;
    smoothedGpuMs += (gpuMs - smoothedGpuMs) * 0.1;
    overlay.set('cpu', `${smoothedCpuMs.toFixed(2)} ms`);
    overlay.set('draw', `${smoothedGpuMs.toFixed(2)} ms`);
  });

  const mode = createModeController({
    world: () => world,
    overlay: overlayRoot,
    sessionHooks: {
      pick: (screenX, screenY) => {
        const ray = screenRay(renderer.scene, camera.camera, screenX, screenY);
        return pickCell(world, ray, undefined, heightOverrides())?.cell ?? -1;
      },
      rebuildCells: (cells) => {
        if (cells.length === 0) return;
        // One rebuild per affected chunk, however many cells the stroke moved.
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const cell of cells) {
          const cx = cell % world.width;
          const cy = (cell / world.width) | 0;
          if (cx < x0) x0 = cx;
          if (cy < y0) y0 = cy;
          if (cx > x1) x1 = cx;
          if (cy > y1) y1 = cy;
        }
        terrain.rebuildChunks(terrain.chunksForRect(x0, y0, x1, y1));
        minimap.rebuildTerrain(world, minimapPalette);
        flagOverlay.rebuild(heightOverrides());
        gizmos.rebuild(heightOverrides());
        // Only the edited region is recomputed; the worker gets the result.
        rebuildRegion(costGrid, world, x0, y0, x1, y1);
        nav.setGrid(costGrid);
      },
      // Any session change can move a marker: a placed patch, an undo, a load.
      onChange: () => gizmos.rebuild(heightOverrides()),
    },
    onChange: (next) => {
      overlay.set('mode', next);
      // Node and start markers are an authoring aid, not part of the game.
      gizmos.setVisible(next === 'editor');
      gizmos.rebuild(heightOverrides());
    },
    onToggleTestMatch: () => {
      if (driver) stopMatch();
      else startMatch();
    },
    isTestMatchRunning: () => driver !== null,
    onLoad: (next) => {
      loadWorld(next);
      // The editor holds a reference to the World it mounted with, so it has
      // to be rebound after a load.
      void mode.remount();
    },
  });
  overlay.set('mode', 'game');
  if (modeFromLocation(window.location.search) === 'editor') void mode.set('editor');

  // Editor pointer routing. The camera keeps middle-drag; the brush uses left
  // and right, and only while the editor is open.
  const modifiersOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => ({
    shift: e.shiftKey,
    ctrl: e.ctrlKey || e.metaKey,
  });
  const canvasPoint = (e: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onPointerDown = (e: PointerEvent): void => {
    // The console only covers the top of the screen, so the canvas below it is
    // still clickable as far as the DOM is concerned. Selecting units through
    // an open console is not what anyone means by clicking there.
    if (input.suppressed) return;
    const [x, y] = canvasPoint(e);
    const session = mode.session();
    if (session && mode.current() === 'editor') {
      if (e.button === 0 || e.button === 2) session.pointerDown(x, y, e.button);
      return;
    }
    // In game mode, left-drag selects.
    if (!driver) return;
    if (e.button === 0) {
      if (pendingBuild >= 0) {
        const ray = screenRay(renderer.scene, camera.camera, x, y);
        const hit = pickCell(world, ray, undefined, heightOverrides());
        if (hit) {
          pendingCommands.push({
            kind: CommandKind.PlaceBuilding,
            player: LOCAL_PLAYER,
            typeId: pendingBuild,
            cell: hit.cell,
          });
        }
        pendingBuild = -1;
        overlay.remove('placing');
        return;
      }
      selection.beginDrag(x, y);
      return;
    }
    if (e.button === 2) {
      if (pendingBuild >= 0) {
        // Right-click cancels a pending placement, as it should.
        pendingBuild = -1;
        overlay.remove('placing');
        return;
      }
      // Right-click issues an order to whatever is selected.
      const ray = screenRay(renderer.scene, camera.camera, x, y);
      const hit = pickCell(world, ray, undefined, heightOverrides());
      const command = dispatchOrder(driver.match.units, world, LOCAL_PLAYER, selection.selection.list(), {
        cell: hit?.cell ?? -1,
        screenX: x,
        screenY: y,
        view: viewInfo(),
        queue: e.shiftKey,
      });
      if (command) pendingCommands.push(command);
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (input.suppressed) return;
    const [x, y] = canvasPoint(e);
    const session = mode.session();
    if (session && mode.current() === 'editor') {
      session.pointerMove(x, y);
      return;
    }
    if (driver && (e.buttons & MOUSE_LEFT) !== 0) selection.updateDrag(x, y);
  };

  const onPointerUp = (e: PointerEvent): void => {
    const session = mode.session();
    if (session && mode.current() === 'editor') {
      session.pointerUp();
      return;
    }
    if (!driver) return;
    const [x, y] = canvasPoint(e);
    selection.endDrag(x, y, driver.match.units, viewInfo(), modifiersOf(e), e.timeStamp);
  };

  const onPointerLost = (): void => {
    mode.session()?.pointerUp();
    selection.cancelDrag();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerLost);
  window.addEventListener('blur', onPointerLost);

  // ---------------------------------------------------------------------
  // Console and main menu.
  //
  // Both drive the same surface, so anything the menu can do has a console
  // command and vice versa. Commands that touch match state go on
  // `pendingCommands` like every other input rather than writing to the store.
  // ---------------------------------------------------------------------

  const consoleGame: ConsoleGame = {
    world: () => world,
    match: () => driver?.match ?? playback?.match ?? null,
    selection: () => selection.selection.list(),
    focus: () => ({ x: camera.focusX, z: camera.focusZ }),
    localPlayer: () => (lockstep ? netPlayer : LOCAL_PLAYER),

    availableMaps: () => packMaps,
    currentMap: () => currentMap,
    loadMap: (slug) => loadPackMap(slug),

    startMatch,
    stopMatch,
    connect: (url, matchId) => void joinMatch(url, matchId),
    openEditor: () => void mode.set('editor'),
    closeEditor: () => void mode.set('game'),
    inEditor: () => mode.current() === 'editor',
    playLastReplay: () => {
      if (lastReplay) startPlayback(lastReplay);
    },
    hasReplay: () => lastReplay !== null,
    saveReplay,
    stressSpawn,

    setFogEnabled: (enabled) => {
      fogEnabled = enabled;
      setTerrainFog(
        terrainMaterial,
        enabled ? fogTexture.texture : null,
        world.width,
        world.height,
        EXPLORED_DIM,
      );
    },
    setOverlayLayer: (id) => {
      flagOverlay.rebuild(heightOverrides());
      flagOverlay.show(id);
      overlay.set('overlay', FLAG_LAYERS.find((l) => l.id === id)?.label ?? 'off');
    },
    overlayLayers: () => FLAG_LAYERS.map((l) => l.id),
    setWireframe: (enabled) => {
      terrainMaterial.wireframe = enabled;
    },
    setFogSoftness: (texels) => setTerrainFogSoftness(terrainMaterial, texels),
    setShadowsEnabled: (enabled) => shadows.setEnabled(enabled),
    setLightScale: (scale) => {
      lightScale = scale;
      setTerrainLightScale(terrainMaterial, scale);
      // Models are lit by the scene's own lights rather than the terrain
      // shader, so the same scale has to reach them or the ground and the
      // things standing on it drift apart.
      renderer.sun.intensity = scale;
      renderer.sky.intensity = scale;
    },
    setStatsVisible: (visible) => overlay.setVisible(visible),
    setCameraSpeed: (scale) => {
      camera.panScale = scale;
    },
  };

  const gameConsole = createConsole({
    queue: (command) => pendingCommands.push(command),
    storage: {
      read: () => {
        try {
          return window.localStorage.getItem(CONFIG_KEY);
        } catch {
          // Private browsing, or storage disabled. Not worth failing over.
          return null;
        }
      },
      write: (text) => {
        try {
          window.localStorage.setItem(CONFIG_KEY, text);
        } catch {
          /* ignore */
        }
      },
    },
  });
  registerGameCommands(gameConsole, consoleGame);

  /**
   * Hand the input to the game or to the overlay on top of it.
   *
   * The camera and the selection code poll input state on their own schedule
   * rather than receiving events, so an overlay that only swallowed keydown
   * would still let the map slide west through the `a` of `map 42`. This is
   * the one switch that stops all of it.
   */
  const syncInputOwner = (): void => {
    const overlayOwnsIt = consoleView.isOpen() || menu.isOpen();
    input.setSuppressed(overlayOwnsIt);
    if (!overlayOwnsIt) return;
    // A drag in progress when the overlay opens never gets its pointerup,
    // because the overlay is in front of the canvas by then. End it here or
    // the selection box is still on screen when the console closes.
    selection.cancelDrag();
    dragBoxElement.hidden = true;
  };

  const consoleView = createConsoleView(overlayRoot, gameConsole, {
    onVisibility: () => syncInputOwner(),
  });
  const menu = createMainMenu({
    overlay: overlayRoot,
    game: consoleGame,
    console: gameConsole,
    onVisibility: () => syncInputOwner(),
  });

  // Restore archived cvars and binds from the last session, then greet.
  try {
    const saved = window.localStorage.getItem(CONFIG_KEY);
    if (saved) gameConsole.loadConfig(saved);
  } catch {
    /* ignore */
  }
  gameConsole.print('web_rts console. `help` for help, `cmdlist` for everything.');

  // ---------------------------------------------------------------------
  // Where to start.
  //
  // All of it lives here, below the console, because joining a relay locks
  // cheats off and so cannot run before the console exists. Doing this higher
  // up cost a working multiplayer check and a confusing temporal-dead-zone
  // error that named the console rather than the URL parameter.
  // ---------------------------------------------------------------------
  // A content pack may also bring maps, with their own lighting.
  void (async () => {
    if (!import.meta.env.DEV) return;
    // Never while joining a relay. This swaps the world out asynchronously,
    // and a networked match whose two clients disagree about the map is a
    // desync on tick zero — the loser being whichever client's fetch was
    // slower. A networked match gets the map it booted with.
    if (new URLSearchParams(window.location.search).get('relay')) return;
    try {
      const index = await fetch(`${CONTENT_PACK_URL}/maps/index.json`);
      if (!index.ok) return;
      const listing = (await index.json()) as {
        maps?: PackMap[];
        default?: string;
      };
      packMaps = listing.maps ?? [];
      menu.refresh();
      if (listing.default) await loadPackMap(listing.default);
    } catch {
      // No pack, or a bad one: the fixture map is already loaded.
    }
  })();

  /**
   * Swap the world for one of the content pack's maps.
   *
   * Everything a map brings arrives together — terrain, lighting, palette,
   * scenery and roads — because they are only consistent with each other. A
   * world loaded without its palette is an imported map wearing the fixture's
   * colours, which looks like a broken import rather than a half-finished
   * load.
   *
   * Any match running is stopped first. A match holds indices into the unit
   * store and cells of the world it started on, so carrying one across a map
   * change is meaningless at best.
   */
  async function loadPackMap(slug: string): Promise<boolean> {
    const [mapResponse, metaResponse] = await Promise.all([
      fetch(`${CONTENT_PACK_URL}/maps/${slug}.rtsmap`),
      fetch(`${CONTENT_PACK_URL}/maps/${slug}.json`),
    ]);
    if (!mapResponse.ok) return false;

    const { decodeMap } = await import('./editor/mapfile.ts');
    stopMatch();
    loadWorld(decodeMap(new Uint8Array(await mapResponse.arrayBuffer())));
    // The editor holds the World it mounted with, so it has to be rebound or
    // it goes on reporting the previous map's size and contents.
    void mode.remount();

    doodads?.dispose();
    doodads = null;
    roads?.dispose();
    roads = null;
    water?.dispose();
    water = null;
    for (const texture of terrainTextures) texture.dispose();
    terrainTextures = [];
    setTerrainTextures(terrainMaterial, null);
    overlay.set('doodads', '');
    overlay.set('roads', '');
    overlay.set('water', '');

    if (metaResponse.ok) {
      const meta = (await metaResponse.json()) as {
        name?: string;
        lighting?: Parameters<typeof applyMapLighting>[0];
        palette?: { ground: number[]; cliff: number[] };
        water?: WaterStyle & { surfaces: WaterSurface[] };
        doodads?: DoodadPlacement[];
        roads?: RoadPolyline[];
        terrain?: {
          atlas: string;
          index: string;
          blend?: string;
          extraBlend?: string;
          stretch?: string;
          columns: number;
          rows: number;
          slot: number;
          pad: number;
        };
      };
      if (meta.lighting) applyMapLighting(meta.lighting);
      // The palette still matters with the atlas loaded: it is what the
      // minimap draws with, and what the shader falls back to if the images
      // do not arrive.
      if (meta.palette) {
        setTerrainPalette(terrainMaterial, meta.palette.ground, meta.palette.cliff);
        minimapPalette = meta.palette;
        minimap.rebuildTerrain(world, minimapPalette);
      }
      if (meta.terrain) loadTerrainTextures(meta.terrain);
      overlay.set('map', meta.name ?? slug);
      if (meta.doodads?.length) await loadDoodads(CONTENT_PACK_URL, meta.doodads);
      if (meta.roads?.length) await loadRoads(CONTENT_PACK_URL, meta.roads);
      if (meta.water?.surfaces.length) loadWater(CONTENT_PACK_URL, meta.water, meta.water.surfaces);    }

    currentMap = slug;
    menu.refresh();
    return true;
  }

  /**
   * Paint the ground with the map's own textures.
   *
   * Nearest filtering on the index map, always: it is a lookup table, not a
   * picture, and interpolating between two slot numbers gives a third slot
   * that has nothing to do with either.
   */
  function loadTerrainTextures(meta: {
    atlas: string;
    index: string;
    blend?: string;
    extraBlend?: string;
    stretch?: string;
    columns: number;
    rows: number;
    slot: number;
    pad: number;
  }): void {
    for (const texture of terrainTextures) texture.dispose();

    // No mipmaps on the atlas, deliberately. The shader picks a cell-sized
    // square with fract(), and the derivative the GPU uses to pick a mip level
    // spikes wherever that wraps — which draws a crisp grid over the whole
    // map, one line per cell. The proper fix is a texture array or explicit
    // gradients, both of which need a WebGL2-only shader; see
    // generals/PLAN.md.
    const atlas = new Texture(`${CONTENT_PACK_URL}/${meta.atlas}`, renderer.scene, true, false);
    atlas.wrapU = Texture.CLAMP_ADDRESSMODE;
    atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
    // No anisotropic filtering either, which Babylon turns on by default and
    // which does not need mipmaps to do harm. It reads the screen-space
    // derivative of the texture coordinate to decide how far to spread its
    // taps, and a 2x2 pixel quad straddling a cell edge has a coordinate that
    // jumps from one texture square to another — so on that one row of
    // pixels it averaged a stretch of the atlas running into other textures,
    // and drew a thin off-colour line along the edge of every blended cell.
    atlas.anisotropicFilteringLevel = 1;

    /**
     * A lookup table, not a picture. Nearest filtering always: interpolating
     * between two slot numbers gives a third slot that has nothing to do with
     * either, and between two corner masks a mask nobody drew.
     */
    const table = (path: string): Texture => {
      const texture = new Texture(
        `${CONTENT_PACK_URL}/${path}`,
        renderer.scene,
        true,
        false,
        Texture.NEAREST_SAMPLINGMODE,
      );
      texture.wrapU = Texture.CLAMP_ADDRESSMODE;
      texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      return texture;
    };
    const index = table(meta.index);
    // A map imported before the blend layers existed has none. An index map
    // doubles as an empty blend: its red channel is a real slot, but the
    // shader reads the layer's own slot, and a missing one is skipped.
    const blend = meta.blend ? table(meta.blend) : null;
    const extraBlend = meta.extraBlend ? table(meta.extraBlend) : null;
    const stretch = meta.stretch ? table(meta.stretch) : null;

    terrainTextures = [atlas, index, ...[blend, extraBlend, stretch].filter((t): t is Texture => t !== null)];
    setTerrainTextures(terrainMaterial, {
      atlas,
      index,
      blend: blend ?? noBlend(),
      extraBlend: extraBlend ?? noBlend(),
      stretch: stretch ?? noStretch(),
      columns: meta.columns,
      rows: meta.rows,
      slot: meta.slot,
      pad: meta.pad,
      cells: { width: world.width, height: world.height },
    });
  }

  /**
   * A one-texel blend layer that blends nothing, for maps imported before the
   * layers existed. Red 255 is "no blend" to the shader.
   */
  let emptyBlend: RawTexture | null = null;
  /**
   * No cliff correction, for maps imported before it existed. Not the empty
   * blend: that one's red is 255, which the stretch reads as the maximum.
   */
  let emptyStretch: RawTexture | null = null;
  function noStretch(): RawTexture {
    emptyStretch ??= RawTexture.CreateRGBATexture(
      new Uint8Array([0, 0, 0, 255]),
      1,
      1,
      renderer.scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    return emptyStretch;
  }
  function noBlend(): RawTexture {
    emptyBlend ??= RawTexture.CreateRGBATexture(
      new Uint8Array([255, 0, 0, 0]),
      1,
      1,
      renderer.scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    return emptyBlend;
  }

  /**
   * Lay a map's roads over the terrain.
   *
   * The ribbon geometry is built here rather than shipped, because the same
   * polyline over different terrain is different geometry — the road has to
   * follow whatever the heightfield does.
   */
  /**
   * Put a map's lakes and rivers on screen.
   *
   * The water shader fades the shallows by looking the ground up itself, so it
   * is handed the map's corner heights as they stand now.
   */
  function loadWater(baseUrl: string, style: WaterStyle, surfaces: WaterSurface[]): void {
    const corners = new Float32Array(world.heights.length);
    for (let i = 0; i < corners.length; i++) corners[i] = (world.heights[i] as number) / 65536;
    water?.dispose();
    water = createWater(renderer.scene, baseUrl, style, surfaces, {
      width: world.width,
      height: world.height,
      corners,
    });
    overlay.set('water', `${water.count} surfaces`);
  }

  async function loadRoads(baseUrl: string, polylines: RoadPolyline[]): Promise<void> {
    const response = await fetch(`${baseUrl}/roads.json`);
    if (!response.ok) return;
    const listed = ((await response.json()) as { types: RoadType[] }).types;
    const types = new Map(listed.map((type) => [type.id, type]));

    roads?.dispose();
    roads = createRoads(renderer.scene, baseUrl, types, polylines, (x, z) =>
      groundHeightAt(world, heightOverrides(), x, z),
    );
    if (roads.count > 0) overlay.set('roads', `${roads.count} in ${roads.types} types`);
  }

  /**
   * Put a map's scenery on screen.
   *
   * Its own content-pack file rather than `pack.json`, because the two are
   * produced by different tools and a map may bring scenery a unit pack knows
   * nothing about. Only the types the map actually places are loaded — a pack
   * carries every doodad across every imported map, and fetching a hundred
   * glTFs to draw forty of them is pure latency.
   */
  async function loadDoodads(baseUrl: string, placements: DoodadPlacement[]): Promise<void> {
    const response = await fetch(`${baseUrl}/doodads.json`);
    if (!response.ok) return;
    const pack = (await response.json()) as {
      entries: (ContentPackEntry & { extras?: string[]; hullAnimated?: boolean })[];
      animations?: Record<
        string,
        {
          frames: number;
          frameRate: number;
          parts: {
            gltf: string;
            texture: string;
            additive: boolean;
            cutout: boolean;
            matrices: number[];
            visible?: number[];
          }[];
        }
      >;
    };

    const placed = new Set(placements.map((placement) => placement.type));
    const entries = pack.entries.filter((entry) => placed.has(entry.id));
    if (entries.length === 0) return;

    const models = await loadContentPack(renderer.scene, { baseUrl, entries });
    if (models.size === 0) return;

    // The moving pieces on this map's scenery: flags, warning lights. Loaded
    // once per piece, however many object types share it.
    const materials = new Map<string, StandardMaterial>();
    const loaded = new Map<string, AnimatedAsset | null>();
    const animated = new Map<string, AnimatedAsset[]>();
    for (const entry of entries) {
      for (const key of entry.extras ?? []) {
        if (!loaded.has(key)) {
          const source = pack.animations?.[key];
          let asset: AnimatedAsset | null = null;
          if (source) {
            try {
              const parts = [];
              for (const part of source.parts) {
                parts.push({
                  part: await loadLoosePart(renderer.scene, baseUrl, part.gltf, part.texture, part, materials),
                  matrices: new Float32Array(part.matrices),
                  ...(part.visible ? { visible: new Uint8Array(part.visible) } : {}),
                });
              }
              asset = { frames: source.frames, frameRate: source.frameRate, parts };
            } catch (error) {
              console.warn(`doodads: ${key} left still — ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          loaded.set(key, asset);
        }
        const asset = loaded.get(key);
        if (!asset) continue;
        const list = animated.get(entry.id) ?? [];
        list.push(asset);
        animated.set(entry.id, list);
      }
    }

    doodads?.dispose();
    doodads = createDoodads(
      renderer.scene,
      models,
      placements,
      (x, z) => groundHeightAt(world, heightOverrides(), x, z),
      animated,
      new Set(entries.filter((entry) => entry.hullAnimated).map((entry) => entry.id)),
    );
    overlay.set(
      'doodads',
      `${doodads.count} in ${doodads.types} types` +
        (doodads.animatedParts > 0 ? `, ${doodads.animatedParts} moving parts` : ''),
    );
  }

  const params = new URLSearchParams(window.location.search);
  const relayUrl = params.get('relay');

  // ?relay=ws://host:port&match=id joins a networked match on load, which is
  // all two browsers need to play each other.
  if (relayUrl) void joinMatch(relayUrl, params.get('match') ?? 'default');

  // Otherwise boot into the menu, the way a game does — unless the URL
  // already said where it wanted to be. Joining a relay and opening the editor
  // are both requests to be somewhere specific, and the tooling passes
  // ?menu=0 so `pnpm shot` gets a live canvas without dismissing anything.
  const skipMenu =
    params.get('menu') === '0' ||
    relayUrl !== null ||
    modeFromLocation(window.location.search) === 'editor';
  if (!skipMenu) menu.open();

  /**
   * Spawn the M33 stress army.
   *
   * This writes to the unit store directly rather than queueing commands,
   * which is fine for a profiling tool run locally and would be a desync in a
   * networked match. It is reachable from the console only as a cheat, and
   * cheats are locked off the moment a relay is involved.
   */
  function stressSpawn(perSide: number): number {
    if (!driver) return 0;
    const match = driver.match;
    const types = ['soldier', 'raider', 'siege'];
    for (let i = 0; i < perSide; i++) {
      const type = unitTypeById(types[i % types.length] as string);
      for (const owner of [0, 1]) {
        spawnUnit(match.units, {
          type,
          ownerId: owner,
          x: fromInt(6 + (i % 24) + owner * 26) + (1 << 15),
          z: fromInt(4 + ((i / 24) | 0)) + (1 << 15),
        });
      }
    }
    return match.units.alive;
  }

  const onKey = (e: KeyboardEvent): void => {
    // The console gets first refusal: while it is open, every key belongs to
    // it, or typing `stop` would also stop the army behind it.
    if (consoleView.handleKey(e)) return;
    if (menu.handleKey(e)) return;
    if (e.code === 'Escape' && chase.chasing) {
      // The first Escape lets go of the camera; the next opens the menu.
      e.preventDefault();
      stopFollowing();
      return;
    }
    if (e.code === 'Escape' && mode.current() === 'game' && pendingBuild < 0 && !playback) {
      e.preventDefault();
      menu.open();
      return;
    }
    if (gameConsole.binds.has(e.code)) {
      e.preventDefault();
      gameConsole.pressKey(e.code);
      return;
    }
    if (e.code === INSPECTOR_KEY) {
      e.preventDefault();
      void toggleInspector(renderer.scene);
    } else if (e.code === MODE_KEY) {
      e.preventDefault();
      void mode.toggle();
    } else if (driver && mode.current() === 'game' && e.code === 'Escape' && pendingBuild >= 0) {
      e.preventDefault();
      pendingBuild = -1;
      overlay.remove('placing');
    } else if (
      driver &&
      mode.current() === 'game' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      hud.handleKey(e.key)
    ) {
      // A command-card hotkey. Checked before control groups so the digits
      // still belong to control groups and the letters to the card.
      e.preventDefault();
    } else if (driver && mode.current() === 'game' && /^Digit[0-9]$/.test(e.code)) {
      const digit = Number(e.code.slice(5));
      if (selection.handleDigit(digit, driver.match.units, modifiersOf(e))) e.preventDefault();
    } else if (e.code === TEST_MATCH_KEY) {
      e.preventDefault();
      if (playback) stopPlayback();
      else if (driver) stopMatch();
      else startMatch();
    } else if (e.code === SAVE_REPLAY_KEY) {
      e.preventDefault();
      saveReplay();
    } else if (e.code === LOAD_REPLAY_KEY) {
      e.preventDefault();
      void openReplay();
    } else if (playback && e.code === 'Space') {
      e.preventDefault();
      playback.paused = !playback.paused;
    } else if (playback && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      e.preventDefault();
      // Step through the offered speeds rather than scaling freely: a replay
      // at 3.7x helps nobody.
      const index = PLAYBACK_SPEEDS.indexOf(playback.speed as (typeof PLAYBACK_SPEEDS)[number]);
      const next = Math.max(
        0,
        Math.min(PLAYBACK_SPEEDS.length - 1, index + (e.code === 'BracketRight' ? 1 : -1)),
      );
      playback.speed = PLAYBACK_SPEEDS[next] as number;
    } else if (e.code === FLAG_OVERLAY_KEY) {
      e.preventDefault();
      const layer = flagOverlay.cycle();
      const label = FLAG_LAYERS.find((l) => l.id === layer)?.label;
      overlay.set('overlay', label ?? 'off');
    }
  };
  window.addEventListener('keydown', onKey);

  return {
    get world() {
      return world;
    },
    console: gameConsole,
    menu,
    mode,
    get driver() {
      return driver;
    },
    get playback() {
      return playback;
    },
    get lastReplay() {
      return lastReplay;
    },
    startMatch,
    stopMatch,
    joinMatch,
    get lockstep() {
      return lockstep;
    },
    stateHash: () => (driver ? hashMatch(driver.match) : 0),
    stressSpawn,
    playReplay: startPlayback,
    requestPath: async (cell) => {
      const field = await nav.request(cell);
      overlay.set('nav', field ? `${nav.lastSolveMs().toFixed(1)} ms` : 'stale');
      return field;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerLost);
      window.removeEventListener('blur', onPointerLost);
      dragBoxElement.remove();
      selectionRings.dispose();
      nav.dispose();
      hud.dispose();
      minimap.dispose();
      consoleView.dispose();
      menu.dispose();
      mode.dispose();
      renderer.engine.stopRenderLoop();
      overlay.dispose();
      flagOverlay.dispose();
      gizmos.dispose();
      unitRenderer.dispose();
      ghostRenderer.dispose();
      fogTexture.dispose();
      terrain.dispose();
      terrainMaterial.dispose();
      input.dispose();
      renderer.dispose();
    },
  };
}

/**
 * The Inspector is a development tool and a large one. `import.meta.env.DEV`
 * is replaced with `false` in a production build, so Rollup removes this whole
 * branch and never pulls the package into the bundle.
 */
async function toggleInspector(scene: Scene): Promise<void> {
  if (!import.meta.env.DEV) return;
  await import('@babylonjs/core/Debug/debugLayer');
  await import('@babylonjs/inspector');
  if (scene.debugLayer.isVisible()) scene.debugLayer.hide();
  else await scene.debugLayer.show({ embedMode: true, overlay: true });
}
