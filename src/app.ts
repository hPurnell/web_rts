/**
 * Application shell: owns the renderer, the camera and the frame loop, and
 * wires the simulation's world state into both.
 */
import type { Scene } from '@babylonjs/core/scene';

import { createTestMap } from './sim/fixtures/testmap.ts';
import { toFloat } from './sim/fixed.ts';
import type { World } from './sim/world.ts';
import { MAX_TIER, hashWorld, worldFromCell } from './sim/world.ts';
import { createMatchFromWorld } from './sim/matchinit.ts';
import { setAiPlayer } from './sim/ai.ts';
import type { Driver } from './driver.ts';
import { createDriver } from './driver.ts';
import type { Replay, ReplayRecorder } from './sim/replay.ts';
import { createRecorder, decodeReplay, describeReplay, encodeReplay } from './sim/replay.ts';
import type { ReplayPlayer } from './replayplayer.ts';
import { PLAYBACK_SPEEDS, createReplayPlayer } from './replayplayer.ts';
import { createRenderer } from './render/engine.ts';
import { RtsCamera } from './render/camera.ts';
import { attachInput } from './render/input.ts';
import { TIER_HEIGHT, createTerrain } from './render/terrain.ts';
import { describeFlags, pickCell, screenRay } from './render/pick.ts';
import { FLAG_LAYERS, createFlagOverlay } from './render/flagoverlay.ts';
import { createGizmos } from './render/gizmos.ts';
import { createUnitRenderer } from './render/units.ts';
import { createGhostRenderer } from './render/ghosts.ts';
import { EXPLORED_DIM, createFogTexture } from './render/fogtexture.ts';
import { setTerrainFog } from './render/terrainMaterial.ts';
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
import { createHud } from './ui/hud.ts';
import type { CommandAction } from './ui/hud.ts';
import { createMinimap } from './ui/minimap.ts';
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
  playReplay(replay: Replay): void;
  /** Solve a flow field to a cell. Used by orders, and by the browser check. */
  requestPath(cell: number): Promise<FlowField | null>;
  dispose(): void;
}

export function startApp(canvas: HTMLCanvasElement, overlayRoot: HTMLElement): App {
  // `world` is replaced wholesale when the editor loads a map, so everything
  // built from it is rebuilt at the same time by loadWorld().
  let world = createTestMap();
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

  const terrainMaterial = createTerrainMaterial(renderer.scene, {
    tierHeight: TIER_HEIGHT,
    maxTier: MAX_TIER,
    lightDirection: renderer.sun.direction,
  });
  let terrain = createTerrain(renderer.scene, world, terrainMaterial);
  let ramps = terrain.ramps();
  let flagOverlay = createFlagOverlay(renderer.scene, world);
  flagOverlay.rebuild(ramps);
  const gizmos = createGizmos(renderer.scene, () => world);
  gizmos.rebuild(ramps);

  // Pathfinding lives in a worker: a 256x256 field is several milliseconds,
  // which is a visible hitch if it lands inside a frame.
  let costGrid: CostGrid = createCostGrid(world);
  const nav: NavClient = createNavClient(createWorkerTransport());
  nav.setGrid(costGrid);
  const unitRenderer = createUnitRenderer(renderer.scene);
  const ghostRenderer = createGhostRenderer(renderer.scene);
  const selectionRings = createSelectionRings(renderer.scene);
  let fogTexture = createFogTexture(renderer.scene, world.width, world.height);

  /** The player this client controls. Multiplayer decides this at M31. */
  const LOCAL_PLAYER = 0;
  const selection = new SelectionController(LOCAL_PLAYER);

  /** Type the player is about to place, or -1. Set by a build button. */
  let pendingBuild = -1;

  const hud = createHud({
    overlay: overlayRoot,
    localPlayer: LOCAL_PLAYER,
    onCommand: (action) => applyHudCommand(action),
    onMinimapJump: (x, z) => camera.moveTo(x, z),
  });
  const minimap = createMinimap();
  hud.minimapSlot.appendChild(minimap.element);
  minimap.rebuildTerrain(world);

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

  /** View data the selection code needs, read fresh each time it is used. */
  const viewInfo = () => ({
    viewProjection: renderer.scene.getTransformMatrix().m,
    width: renderer.engine.getRenderWidth(),
    height: renderer.engine.getRenderHeight(),
  });

  /** Swap in a different map: rebuild the scene and re-bound the camera. */
  function loadWorld(next: World): void {
    const layer = flagOverlay.current();
    flagOverlay.dispose();
    terrain.dispose();
    world = next;
    terrain = createTerrain(renderer.scene, world, terrainMaterial);
    ramps = terrain.ramps();
    flagOverlay = createFlagOverlay(renderer.scene, world);
    flagOverlay.rebuild(ramps);
    flagOverlay.show(layer);
    gizmos.rebuild(ramps);
    fogTexture.dispose();
    fogTexture = createFogTexture(renderer.scene, world.width, world.height);
    setTerrainFog(terrainMaterial, null, world.width, world.height, EXPLORED_DIM);
    costGrid = createCostGrid(world);
    nav.setGrid(costGrid);
    const cell = toFloat(world.cellSize);
    camera.setBounds(
      { minX: 0, maxX: world.width * cell, minZ: 0, maxZ: world.height * cell },
      true,
    );
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

  function startMatch(seed = 1): void {
    stopPlayback();
    const before = hashWorld(world);
    const playerCount = Math.max(1, world.startLocations.length);
    recorder = createRecorder({
      seed,
      playerCount,
      mapHash: before,
    });
    const match = createMatchFromWorld({ world, seed, playerCount, costGrid });
    // Every player but the local one is a bot, so a test match is a game
    // rather than a diorama. The bot is part of the simulation, so replays
    // re-derive it rather than recording what it did.
    for (let player = 0; player < playerCount; player++) {
      if (player !== LOCAL_PLAYER) setAiPlayer(match, player, true);
    }
    driver = createDriver(match, { world });
    unitRenderer.captureTick(driver.match);
    unitRenderer.update(driver.match, world, ramps, 1, LOCAL_PLAYER);
    setTerrainFog(terrainMaterial, fogTexture.texture, world.width, world.height, EXPLORED_DIM);

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
    unitRenderer.update(playback.match, world, ramps, 1, LOCAL_PLAYER);
    setTerrainFog(terrainMaterial, fogTexture.texture, world.width, world.height, EXPLORED_DIM);
    overlay.set('match', 'replay');
    overlay.set('replay', describeReplay(replay));
  }

  function stopPlayback(): void {
    if (!playback) return;
    playback = null;
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

  function stopMatch(): void {
    if (driver && recorder) {
      lastReplay = recorder.finish(driver.match);
      overlay.set('replay', describeReplay(lastReplay));
    }
    recorder = null;
    driver = null;
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
  renderer.engine.runRenderLoop(() => {
    const dt = renderer.frameDelta();
    camera.update(input, dt, renderer.engine.getRenderWidth(), renderer.engine.getRenderHeight());

    if (playback) {
      const showing = playback;
      showing.advance(dt, () => unitRenderer.captureTick(showing.match));
      unitRenderer.update(showing.match, world, ramps, showing.driver.alpha(), LOCAL_PLAYER);
      ghostRenderer.update(showing.match, world, ramps, LOCAL_PLAYER);
      fogTexture.update(showing.match.fog, LOCAL_PLAYER);
      selection.prune(showing.match.units);
      selectionRings.update(selection.selection.list(), showing.match.units, world, ramps);
      hud.update(showing.match, selection.selection.list());
      minimap.draw(
        world,
        showing.match.fog,
        showing.match.units,
        LOCAL_PLAYER,
        {
          focusX: camera.focusX,
          focusZ: camera.focusZ,
          halfWidth: camera.currentHeight * 0.9,
          halfDepth: camera.currentHeight * 0.75,
        },
        PLAYER_COLORS,
      );
      overlay.set('tick', `${showing.match.tick} / ${showing.replay.ticks}`);
      overlay.set('speed', showing.paused ? 'paused' : `${showing.speed}x`);
      const divergence = showing.divergence();
      if (divergence) overlay.set('desync', `tick ${divergence.tick}`);
    }

    if (driver) {
      // Capture before stepping, so interpolation has both endpoints.
      const running = driver;
      const recording = recorder;
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
      unitRenderer.update(running.match, world, ramps, running.alpha(), LOCAL_PLAYER);
      ghostRenderer.update(running.match, world, ramps, LOCAL_PLAYER);
      fogTexture.update(running.match.fog, LOCAL_PLAYER);
      overlay.set('fog', `${fogTexture.lastUploadMs().toFixed(2)} ms`);

      selection.prune(running.match.units);
      selectionRings.update(selection.selection.list(), running.match.units, world, ramps);

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

      hud.update(running.match, selection.selection.list());
      minimap.draw(
        world,
        running.match.fog,
        running.match.units,
        LOCAL_PLAYER,
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
      const hit = pickCell(world, ramps, ray);
      overlay.set('cell', hit ? `${hit.cell} (${hit.cx},${hit.cy})` : '-');
      overlay.set('tier', hit ? String(hit.tier) : '-');
      overlay.set('flags', hit ? describeFlags(hit.flags) : '-');
    } else {
      overlay.set('cell', '-');
      overlay.set('tier', '-');
      overlay.set('flags', '-');
    }

    renderer.scene.render();
  });

  const mode = createModeController({
    world: () => world,
    overlay: overlayRoot,
    sessionHooks: {
      pick: (screenX, screenY) => {
        const ray = screenRay(renderer.scene, camera.camera, screenX, screenY);
        return pickCell(world, ramps, ray)?.cell ?? -1;
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
        ramps = terrain.ramps();
        flagOverlay.rebuild(ramps);
        gizmos.rebuild(ramps);
        // Only the edited region is recomputed; the worker gets the result.
        rebuildRegion(costGrid, world, x0, y0, x1, y1);
        nav.setGrid(costGrid);
      },
      // Any session change can move a marker: a placed patch, an undo, a load.
      onChange: () => gizmos.rebuild(ramps),
    },
    onChange: (next) => {
      overlay.set('mode', next);
      // Node and start markers are an authoring aid, not part of the game.
      gizmos.setVisible(next === 'editor');
      gizmos.rebuild(ramps);
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
        const hit = pickCell(world, ramps, ray);
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
      const hit = pickCell(world, ramps, ray);
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

  const onKey = (e: KeyboardEvent): void => {
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
