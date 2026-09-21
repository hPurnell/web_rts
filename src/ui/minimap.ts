/**
 * The minimap.
 *
 * A 2D canvas rather than a second 3D view: the whole thing is a few thousand
 * pixels and a few hundred dots, and drawing it as geometry would cost more
 * than the main scene.
 *
 * Terrain is rendered once per map into an offscreen canvas at one pixel per
 * cell and then scaled up, because terrain only changes when the editor
 * changes it. Fog and units are redrawn each frame, which is two typed-array
 * walks over the same few thousand pixels.
 */
import type { World } from '../sim/world.ts';
import { WALKABLE } from '../sim/world.ts';
import { HEIGHT_MAX, MAX_BUILD_SLOPE, cellCentreHeight, cellSlope } from '../sim/terrain.ts';
import type { FogGrids } from '../sim/fog.ts';
import type { UnitStore } from '../sim/units.ts';
import { unitType } from '../sim/unittypes.ts';
import { toFloat } from '../sim/fixed.ts';

/** Clamp a computed shade into a byte. */
function clamp8(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** How dark explored-but-not-visible ground is drawn. */
const EXPLORED_ALPHA = 0.55;
const UNEXPLORED_ALPHA = 0.92;

export interface MinimapView {
  /** Camera focus in world units. */
  readonly focusX: number;
  readonly focusZ: number;
  /** Half-extent of what the camera can see, in world units. */
  readonly halfWidth: number;
  readonly halfDepth: number;
}

/** A map's own ground and cliff colours, 0..1, as the content pack gives them. */
export interface MinimapPalette {
  readonly ground: readonly number[];
  readonly cliff: readonly number[];
}

export interface Minimap {
  readonly element: HTMLCanvasElement;
  /**
   * Re-render the terrain layer. Call whenever the map changes — a new map
   * loading, or the editor reshaping this one. The layer is a cache, and
   * nothing else refreshes it.
   */
  rebuildTerrain(world: World, palette?: MinimapPalette | null): void;
  /** Draw one frame. */
  draw(
    world: World,
    fog: FogGrids | null,
    store: UnitStore | null,
    localPlayer: number,
    view: MinimapView,
    playerColors: readonly { r: number; g: number; b: number }[],
  ): void;
  /** Milliseconds the last draw took. */
  lastDrawMs(): number;
  /** World position for a point on the minimap, or null if outside it. */
  worldAt(clientX: number, clientY: number, world: World): { x: number; z: number } | null;
  dispose(): void;
}

export function createMinimap(size = 200): Minimap {
  const element = document.createElement('canvas');
  element.className = 'minimap';
  element.width = size;
  element.height = size;
  const context = element.getContext('2d');

  // Terrain is cached here at one pixel per cell and only redrawn when the
  // map changes. Fog gets its own layer so drawing it never disturbs the
  // cache — an earlier version wrote fog into the terrain canvas and rebuilt
  // the terrain every frame, which threw the caching away entirely.
  const terrainCanvas = document.createElement('canvas');
  let terrainContext = terrainCanvas.getContext('2d');
  const fogCanvas = document.createElement('canvas');
  let fogContext = fogCanvas.getContext('2d');
  let fogImage: ImageData | null = null;
  let drawMs = 0;

  const rebuildTerrain = (world: World, palette: MinimapPalette | null = null): void => {
    terrainCanvas.width = world.width;
    terrainCanvas.height = world.height;
    terrainContext = terrainCanvas.getContext('2d');
    if (!terrainContext) return;

    const image = terrainContext.createImageData(world.width, world.height);
    const data = image.data;
    for (let cell = 0; cell < world.flags.length; cell++) {
      const flags = world.flags[cell] as number;
      const offset = cell * 4;
      if ((flags & WALKABLE) === 0) {
        data[offset] = 26;
        data[offset + 1] = 24;
        data[offset + 2] = 30;
        data[offset + 3] = 255;
        continue;
      }

      // Tiers gave the minimap a free contour: five heights, five shades, and
      // the map read as terraces. A heightfield shaded only by height is a
      // smooth wash you cannot navigate by, so height sets the brightness and
      // slope darkens it — the hillsides draw themselves as shading, which is
      // how a relief map has always worked.
      const height = cellCentreHeight(world, cell) / HEIGHT_MAX;
      const slope = cellSlope(world, cell);
      const relief = Math.min(1, slope / (MAX_BUILD_SLOPE * 4));
      const shade = 46 + height * 150 - relief * 34;

      if (palette) {
        // The map's own colours, so a desert reads as sand rather than as
        // the green the fixture map is drawn in. Height and slope still set
        // the brightness, and a slope leans toward the cliff colour.
        const light = shade / 128;
        for (let c = 0; c < 3; c++) {
          const ground = palette.ground[c] ?? 0.5;
          const cliff = palette.cliff[c] ?? ground;
          data[offset + c] = clamp8((ground + (cliff - ground) * relief) * 255 * light);
        }
      } else {
        data[offset] = clamp8(shade - 8);
        data[offset + 1] = clamp8(shade + 22 - relief * 14);
        data[offset + 2] = clamp8(shade - 4);
      }
      data[offset + 3] = 255;
    }
    terrainContext.putImageData(image, 0, 0);

    fogCanvas.width = world.width;
    fogCanvas.height = world.height;
    fogContext = fogCanvas.getContext('2d');
    fogImage = fogContext?.createImageData(world.width, world.height) ?? null;
  };

  return {
    element,
    rebuildTerrain,
    lastDrawMs: () => drawMs,

    draw(world, fog, store, localPlayer, view, playerColors) {
      if (!context) return;
      const started = performance.now();
      const scale = size / Math.max(world.width, world.height);

      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, size, size);

      // Flip the z axis for everything below.
      //
      // The camera sits at `focusZ - back` and looks toward `focusZ`, so on
      // screen **increasing z goes away from the viewer, up the screen**. A
      // minimap that drew z downward — the obvious thing, since that is how
      // image rows run — would be a vertical mirror of what the player is
      // looking at, and every glance at it would have to be mentally
      // reversed. Flipping once here keeps every coordinate below in plain
      // world order.
      context.save();
      context.translate(0, world.height * scale);
      context.scale(1, -1);

      context.drawImage(terrainCanvas, 0, 0, world.width * scale, world.height * scale);

      if (fog && localPlayer >= 0 && fogImage && fogContext) {
        const visible = fog.visible[localPlayer];
        const explored = fog.explored[localPlayer];
        if (visible && explored) {
          const data = fogImage.data;
          for (let cell = 0; cell < visible.length; cell++) {
            const offset = cell * 4;
            data[offset + 3] =
              visible[cell] !== 0
                ? 0
                : explored[cell] !== 0
                  ? EXPLORED_ALPHA * 255
                  : UNEXPLORED_ALPHA * 255;
          }
          fogContext.putImageData(fogImage, 0, 0);
          context.drawImage(fogCanvas, 0, 0, world.width * scale, world.height * scale);
        }
      }

      if (store) {
        const cellSize = toFloat(world.cellSize);
        for (let i = 0; i < store.count; i++) {
          if (store.isAlive[i] !== 1) continue;
          const owner = store.ownerId[i] as number;
          if (fog && localPlayer >= 0 && owner !== localPlayer) {
            // Enemies appear only where they can be seen, like on screen.
            const cx = Math.floor(toFloat(store.posX[i] as number) / cellSize);
            const cy = Math.floor(toFloat(store.posZ[i] as number) / cellSize);
            const cell = cy * world.width + cx;
            if ((fog.visible[localPlayer]?.[cell] ?? 0) === 0) continue;
          }
          const color = playerColors[owner] ?? playerColors[0];
          context.fillStyle = `rgb(${Math.round((color?.r ?? 1) * 255)},${Math.round((color?.g ?? 1) * 255)},${Math.round((color?.b ?? 1) * 255)})`;
          const type = unitType(store.typeId[i] as number);
          const dot = type.isStructure ? Math.max(3, type.footprint * scale) : 2;
          context.fillRect(
            (toFloat(store.posX[i] as number) / cellSize) * scale - dot / 2,
            (toFloat(store.posZ[i] as number) / cellSize) * scale - dot / 2,
            dot,
            dot,
          );
        }
      }

      // The camera viewport, so the minimap says where you are looking.
      const cellSize = toFloat(world.cellSize);
      context.strokeStyle = 'rgba(255,255,255,0.85)';
      context.lineWidth = 1;
      context.strokeRect(
        ((view.focusX - view.halfWidth) / cellSize) * scale,
        ((view.focusZ - view.halfDepth) / cellSize) * scale,
        ((view.halfWidth * 2) / cellSize) * scale,
        ((view.halfDepth * 2) / cellSize) * scale,
      );

      context.restore();
      drawMs = performance.now() - started;
    },

    worldAt(clientX, clientY, world) {
      const rect = element.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      const scale = size / Math.max(world.width, world.height);
      const cellSize = toFloat(world.cellSize);
      // Undo the vertical flip the draw applies, or clicking the north of the
      // map would send the camera south.
      const mapped = ((y / rect.height) * size) / scale;
      return {
        x: ((x / rect.width) * size / scale) * cellSize,
        z: (world.height - mapped) * cellSize,
      };
    },

    dispose() {
      element.remove();
    },
  };
}
