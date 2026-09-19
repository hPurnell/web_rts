import { describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  HEADER_BYTES,
  MapFormatError,
  decodeMap,
  encodeMap,
  suggestFilename,
} from '../src/editor/mapfile.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import * as w from '../src/sim/world.ts';
import { fromInt } from '../src/sim/fixed.ts';

describe('map file round trip', () => {
  it('preserves the world hash exactly', () => {
    const world = createTestMap();
    const restored = decodeMap(encodeMap(world));
    expect(w.hashWorld(restored)).toBe(w.hashWorld(world));
    expect(restored.heights).toEqual(world.heights);
    expect(restored.flags).toEqual(world.flags);
    expect(restored.resourceNodes).toEqual(world.resourceNodes);
    expect(restored.startLocations).toEqual(world.startLocations);
    expect(restored.width).toBe(world.width);
    expect(restored.height).toBe(world.height);
    expect(restored.cellSize).toBe(world.cellSize);
  });

  it('survives a second round trip byte for byte', () => {
    const world = createTestMap();
    const once = encodeMap(world);
    const twice = encodeMap(decodeMap(once));
    expect(twice).toEqual(once);
  });

  it('handles an empty map and a full-size one', () => {
    const empty = w.createWorld({ width: 1, height: 1 });
    expect(w.hashWorld(decodeMap(encodeMap(empty)))).toBe(w.hashWorld(empty));

    const big = w.createWorld({ width: 512, height: 512, cellSize: fromInt(2) });
    big.heights[513 * 513 - 1] = fromInt(3);
    const restored = decodeMap(encodeMap(big));
    expect(w.hashWorld(restored)).toBe(w.hashWorld(big));
    expect(restored.cellSize).toBe(fromInt(2));
  });

  it('is mostly raw grid data rather than encoded numbers', () => {
    const world = createTestMap();
    const bytes = encodeMap(world);
    // Four bytes per corner for the heightfield, one per cell for the flags.
    // Heights dominate now, which is the cost of continuous terrain: a tier
    // fitted in a byte and a fixed-point height does not.
    const gridBytes = (world.width + 1) * (world.height + 1) * 4 + world.width * world.height;
    expect(bytes.length).toBeGreaterThan(gridBytes);
    expect(bytes.length - gridBytes).toBeLessThan(gridBytes / 4);
  });

  it('writes the documented header', () => {
    const world = w.createWorld({ width: 7, height: 5 });
    const bytes = encodeMap(world);
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RTSM');
    expect(view.getUint16(4, true)).toBe(FORMAT_VERSION);
    expect(view.getUint16(8, true)).toBe(7);
    expect(view.getUint16(10, true)).toBe(5);
    // 8x6 corners at four bytes, then 7x5 flag bytes, then the JSON tail.
    expect(bytes.length).toBe(HEADER_BYTES + 8 * 6 * 4 + 35 + view.getUint32(16, true));
  });
});

describe('map file rejection', () => {
  const expectError = (bytes: Uint8Array, code: string, pattern: RegExp): void => {
    try {
      decodeMap(bytes);
      expect.unreachable('decode should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MapFormatError);
      expect((error as MapFormatError).code).toBe(code);
      expect((error as MapFormatError).message).toMatch(pattern);
    }
  };

  it('rejects a file that is not a map', () => {
    expectError(new TextEncoder().encode('not a map file at all!!'), 'magic', /not an RTS map/);
  });

  it('rejects a file that is too short to have a header', () => {
    expectError(new Uint8Array(4), 'truncated', /too short/);
  });

  it('rejects a version it does not know, and says both versions', () => {
    const bytes = encodeMap(w.createWorld({ width: 4, height: 4 }));
    new DataView(bytes.buffer).setUint16(4, FORMAT_VERSION + 7, true);
    expectError(bytes, 'version', new RegExp(`version ${FORMAT_VERSION + 7}.*version ${FORMAT_VERSION}`));
  });

  it('rejects impossible dimensions', () => {
    const bytes = encodeMap(w.createWorld({ width: 4, height: 4 }));
    new DataView(bytes.buffer).setUint16(8, 0, true);
    expectError(bytes, 'dimensions', /out of range/);
  });

  it('rejects a truncated body', () => {
    const bytes = encodeMap(createTestMap());
    expectError(bytes.slice(0, bytes.length - 40), 'truncated', /bytes but its header/);
  });

  it('rejects a corrupt data section', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    world.startLocations.push({ cell: 1 });
    const bytes = encodeMap(world);
    bytes[bytes.length - 3] = 0x7b; // '{' in the middle of the JSON tail
    expectError(bytes, 'json', /corrupt data section/);
  });
});

describe('map file sanitisation', () => {
  it('drops out-of-range cells from a hand-edited tail', () => {
    const world = w.createWorld({ width: 4, height: 4 });
    world.resourceNodes.push({ cell: 2, type: w.ResourceType.Minerals, amount: 500 });
    world.startLocations.push({ cell: 3 });
    const bytes = encodeMap(world);

    // Rewrite the tail with entries that point off the map.
    const head = bytes.subarray(0, 20 + 5 * 5 * 4 + 16);
    const tail = new TextEncoder().encode(
      JSON.stringify({
        resourceNodes: [
          { cell: 999, type: 0, amount: 1 },
          { cell: 2, type: 1, amount: -5 },
          null,
        ],
        startLocations: [{ cell: -1 }, { cell: 3 }, 'nope'],
      }),
    );
    const rebuilt = new Uint8Array(head.length + tail.length);
    rebuilt.set(head);
    rebuilt.set(tail, head.length);
    new DataView(rebuilt.buffer).setUint32(16, tail.length, true);

    const restored = decodeMap(rebuilt);
    expect(restored.resourceNodes).toEqual([{ cell: 2, type: 1, amount: 0 }]);
    expect(restored.startLocations).toEqual([{ cell: 3 }]);
  });
});

describe('filenames', () => {
  it('suggests a timestamped name with the right extension', () => {
    expect(suggestFilename('arena')).toMatch(/^arena-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.rtsmap$/);
  });
});
