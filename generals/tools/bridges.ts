/**
 * Bridges, as far as the ground under them is concerned.
 *
 * A Generals bridge is a pair of map objects flagged as its two ends, and a
 * model tiled between them. The pathfinder gives it a layer of its own above
 * whatever it spans. This engine has one ground height per corner and no
 * layers, so a bridge over water is imported as what a unit on it actually
 * stands on: ground at deck height, running from bank to bank as wide as the
 * deck. Without it, the rivers that `water.ts` makes impassable cut maps like
 * Winding River clean in two.
 *
 * Only bridges that cross water are laid. A bridge across a dry gorge would
 * otherwise fill the gorge, and the gorge is passable or not on its own
 * terms. Drawing the bridge itself is separate work.
 *
 * Numbers from `W3DBridgeBuffer.cpp`: a deck runs straight between the
 * terrain heights at its two ends, and its width is the width of its model's
 * `BRIDGE_LEFT` mesh across the span, times the `BridgeScale` in `Roads.ini`.
 */
import { findByBasename, readEntry, readIndexed } from './big.ts';
import type { AssetIndex } from './big.ts';
import { parseChunks, readMeshes, readPivots } from './w3d.ts';
import type { W3DPivot, W3DVertex } from './w3d.ts';

/** Generals units per cell. */
const UNITS_PER_CELL = 10;

/** `FLAG_BRIDGE_POINT1` and `FLAG_BRIDGE_POINT2` in `MapObject.h`. */
export const BRIDGE_POINT1 = 0x10;
export const BRIDGE_POINT2 = 0x20;

/** A bridge from end to end, in cells. */
export interface BridgeSpan {
  readonly type: string;
  readonly from: { readonly x: number; readonly z: number };
  readonly to: { readonly x: number; readonly z: number };
}

/**
 * Pair bridge ends as `W3DBridgeBuffer::loadBridges` does: a first point and
 * the object straight after it, if that is a second point.
 */
export function pairBridges(
  objects: readonly { type: string; x: number; z: number; flags: number }[],
): BridgeSpan[] {
  const spans: BridgeSpan[] = [];
  for (let i = 0; i + 1 < objects.length; i++) {
    const a = objects[i] as (typeof objects)[number];
    const b = objects[i + 1] as (typeof objects)[number];
    if ((a.flags & BRIDGE_POINT1) === 0 || (b.flags & BRIDGE_POINT2) === 0) continue;
    spans.push({ type: a.type, from: { x: a.x, z: a.z }, to: { x: b.x, z: b.z } });
    i++;
  }
  return spans;
}

/**
 * Deck width in cells for each `Bridge` block in `Roads.ini`, by lower-case
 * name. A bridge whose model cannot be read is left out, and so gets no
 * crossing rather than a guessed one.
 */
export function readBridgeWidths(index: AssetIndex): Map<string, number> {
  const widths = new Map<string, number>();
  let text: string;
  try {
    text = readIndexed(index, 'data/ini/roads.ini').toString('latin1');
  } catch {
    return widths;
  }
  for (const block of text.matchAll(/^Bridge\s+(\w+)\s*\r?\n([\s\S]*?)^End/gim)) {
    const body = block[2] as string;
    const scale = Number(/^\s*BridgeScale\s*=\s*([\d.]+)/im.exec(body)?.[1] ?? '1');
    const model = /^\s*BridgeModelName\s*=\s*(\S+)/im.exec(body)?.[1];
    if (!model) continue;
    const entry = findByBasename(index, `${model}.w3d`)[0];
    if (!entry) continue;
    const chunks = parseChunks(readEntry(index.archivePaths.get(entry.archive) as string, entry));
    // The deck's end piece; a fixed bridge has only this one.
    const left = readMeshes(chunks).find((mesh) => /BRIDGE_LEFT/i.test(mesh.name));
    if (!left || left.vertices.length === 0) continue;
    // Measured after the piece's own transform, as the source does: several
    // bridges model the deck on its side and turn it upright with the pivot,
    // and the width across is then the mesh's local z, not its y.
    const pivots = readPivots(chunks);
    const pivot = pivots.findIndex((p) => p.name.trim().toUpperCase() === left.name.trim().toUpperCase());
    let min = Infinity;
    let max = -Infinity;
    for (const v of left.vertices) {
      const y = rotateThrough(pivots, pivot, v).y;
      min = Math.min(min, y);
      max = Math.max(max, y);
    }
    widths.set((block[1] as string).toLowerCase(), ((max - min) * scale) / UNITS_PER_CELL);
  }
  return widths;
}

/** Rotate by a unit quaternion stored x, y, z, w. */
function rotate(q: readonly [number, number, number, number], v: W3DVertex): W3DVertex {
  const [x, y, z, w] = q;
  // v + 2w(q x v) + 2 q x (q x v)
  const cx = y * v.z - z * v.y;
  const cy = z * v.x - x * v.z;
  const cz = x * v.y - y * v.x;
  return {
    x: v.x + 2 * (w * cx + y * cz - z * cy),
    y: v.y + 2 * (w * cy + z * cx - x * cz),
    z: v.z + 2 * (w * cz + x * cy - y * cx),
  };
}

/** A direction through a pivot and each of its parents; translation cannot change a width. */
function rotateThrough(pivots: readonly W3DPivot[], index: number, v: W3DVertex): W3DVertex {
  let out = v;
  for (let i = index, guard = 0; i >= 0 && i < pivots.length && guard < 32; guard++) {
    const pivot = pivots[i] as W3DPivot;
    out = rotate(pivot.rotation, out);
    i = pivot.parent === 0xffffffff ? -1 : pivot.parent;
  }
  return out;
}

/**
 * Turn the ground under each bridge that crosses water into a deck.
 *
 * A cell is under the deck when its centre is within half the deck's width of
 * the span, between its ends. Every such cell has its corners raised to the
 * deck where they are below it and becomes walkable (never buildable, since
 * nothing is changed that would make it so). Returns the cells changed.
 */
export function layBridges(
  spans: readonly BridgeSpan[],
  widths: ReadonlyMap<string, number>,
  width: number,
  height: number,
  isWater: (cell: number) => boolean,
  cornerHeight: (cx: number, cz: number) => number,
  raiseCorner: (cx: number, cz: number, to: number) => void,
  makeWalkable: (cell: number) => void,
): number[] {
  const changed: number[] = [];
  for (const span of spans) {
    const deckWidth = widths.get(span.type.toLowerCase());
    if (!deckWidth) continue;
    const half = deckWidth / 2;
    const dx = span.to.x - span.from.x;
    const dz = span.to.z - span.from.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const ux = dx / length;
    const uz = dz / length;
    // The deck's ends sit on the ground at each end.
    const corner = (x: number, z: number): number =>
      cornerHeight(
        Math.max(0, Math.min(width, Math.round(x))),
        Math.max(0, Math.min(height, Math.round(z))),
      );
    const fromY = corner(span.from.x, span.from.z);
    const toY = corner(span.to.x, span.to.z);
    const deckAt = (x: number, z: number): number => {
      const t = Math.max(0, Math.min(1, ((x - span.from.x) * ux + (z - span.from.z) * uz) / length));
      return fromY + (toY - fromY) * t;
    };

    const minX = Math.max(0, Math.floor(Math.min(span.from.x, span.to.x) - half - 1));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(span.from.x, span.to.x) + half + 1));
    const minZ = Math.max(0, Math.floor(Math.min(span.from.z, span.to.z) - half - 1));
    const maxZ = Math.min(height - 1, Math.ceil(Math.max(span.from.z, span.to.z) + half + 1));
    const under: number[] = [];
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const px = cx + 0.5 - span.from.x;
        const pz = cz + 0.5 - span.from.z;
        const along = px * ux + pz * uz;
        const across = Math.abs(-px * uz + pz * ux);
        if (along >= 0 && along <= length && across <= half) under.push(cz * width + cx);
      }
    }
    // A bridge over no water is left alone: its gorge is not ours to fill.
    if (!under.some(isWater)) continue;

    // Everything under the deck, banks included. The ends of a bridge sit
    // back from the water's edge, and the bank between an end and the
    // water is as steep as any bank; raising only the water left the deck a
    // cliff above the ground at both ends.
    for (const cell of under) {
      const cx = cell % width;
      const cz = Math.floor(cell / width);
      let raised = false;
      for (const [ox, oz] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const deck = deckAt(cx + ox, cz + oz);
        if (cornerHeight(cx + ox, cz + oz) < deck) {
          raiseCorner(cx + ox, cz + oz, deck);
          raised = true;
        }
      }
      if (raised || isWater(cell)) {
        makeWalkable(cell);
        changed.push(cell);
      }
    }
  }
  return changed;
}
