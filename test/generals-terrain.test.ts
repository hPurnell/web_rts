/**
 * Terrain texturing: which square of which texture a map cell shows.
 *
 * Both halves of the rule are the source game's, and both were wrong once.
 * The low two bits of a tile index are a quadrant, so the texture is found
 * from the index shifted right two. And the squares a map assigns climb the
 * texture as z grows, so the shader's position inside a cell has to climb the
 * same way — it ran the other way, and every row boundary on every map jumped
 * two squares, which on cliff rock showed as stacked horizontal bands.
 */
import { describe, expect, it } from 'vitest';
import { squareOf } from '../generals/tools/importmap.ts';

/** Two texture classes: a 2x2-tile one, then a 3x3. First tiles accumulate. */
const RECORDS = [
  { first: 0, count: 4, side: 2 },
  { first: 4, count: 9, side: 3 },
];

/** A tile index as a map stores it: the source tile shifted left two, plus a quadrant. */
const index = (tile: number, quadrant: number): number => (tile << 2) | quadrant;

/**
 * The texture v the shader samples at a point within a cell, top to bottom.
 * Mirrors `inCellAt` and `squareAt` in src/render/terrainMaterial.ts for an
 * unstretched cell: the position inside the cell runs 1 - f as z rises.
 */
const vAt = (square: { subY: number; span: number }, fz: number): number =>
  (square.subY + (1 - fz)) / square.span;

describe('terrain tile squares', () => {
  it('finds the texture from the tile index shifted right two', () => {
    // Tile 5 is the second texture's second tile; unshifted, index 20 would
    // not be in either range at all.
    expect(squareOf(index(5, 0), RECORDS)?.record).toBe(1);
    expect(squareOf(index(3, 3), RECORDS)?.record).toBe(0);
    expect(squareOf(index(99, 0), RECORDS)).toBeNull();
  });

  it('picks the left or right half with bit 0', () => {
    expect(squareOf(index(4, 0), RECORDS)?.subX).toBe(0);
    expect(squareOf(index(4, 1), RECORDS)?.subX).toBe(1);
    expect(squareOf(index(5, 0), RECORDS)?.subX).toBe(2);
  });

  it('counts squares across as two a tile', () => {
    expect(squareOf(index(4, 0), RECORDS)?.span).toBe(6);
  });

  it('joins vertically adjacent cells of one texture without a seam', () => {
    // Walk up a column of the 3x3 texture the way a map lays it: within a
    // tile the quadrant's bit 1 steps from 0 to 1, then the next tile row.
    const column = [index(4, 0), index(4, 2), index(7, 0), index(7, 2), index(10, 0), index(10, 2)];
    for (let z = 0; z + 1 < column.length; z++) {
      const below = squareOf(column[z] as number, RECORDS);
      const above = squareOf(column[z + 1] as number, RECORDS);
      if (!below || !above) throw new Error('unresolved');
      // The top edge of one cell must meet the bottom edge of the next.
      expect(vAt(below, 1), `row ${z}`).toBeCloseTo(vAt(above, 0), 9);
    }
  });

  it('joins horizontally adjacent cells without a seam', () => {
    const row = [index(4, 0), index(4, 1), index(5, 0), index(5, 1)];
    for (let x = 0; x + 1 < row.length; x++) {
      const left = squareOf(row[x] as number, RECORDS);
      const right = squareOf(row[x + 1] as number, RECORDS);
      if (!left || !right) throw new Error('unresolved');
      expect((left.subX + 1) / left.span).toBeCloseTo(right.subX / right.span, 9);
    }
  });
});
