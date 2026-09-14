// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAutosave,
  createMapStorage,
  hasFileSystemAccess,
  readAutosave,
  startAutosave,
  writeAutosave,
} from '../src/editor/storage.ts';
import { decodeMap, encodeMap } from '../src/editor/mapfile.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import * as w from '../src/sim/world.ts';

interface PickerWindow {
  showSaveFilePicker?: unknown;
  showOpenFilePicker?: unknown;
}

const picker = window as unknown as PickerWindow;

// jsdom implements neither of these; the download path needs both to exist.
beforeEach(() => {
  const urls = URL as unknown as Record<string, unknown>;
  urls['createObjectURL'] = vi.fn(() => 'blob:map');
  urls['revokeObjectURL'] = vi.fn();
});

/** A File System Access handle backed by an in-memory buffer. */
function fakeHandle(name = 'map.rtsmap') {
  const state = { bytes: new Uint8Array(0), closed: 0 };
  return {
    state,
    handle: {
      name,
      createWritable: async () => ({
        write: async (data: ArrayBuffer) => {
          state.bytes = new Uint8Array(data);
        },
        close: async () => {
          state.closed++;
        },
      }),
      getFile: async () => new File([state.bytes.slice().buffer as ArrayBuffer], name),
    },
  };
}

afterEach(() => {
  delete picker.showSaveFilePicker;
  delete picker.showOpenFilePicker;
  vi.restoreAllMocks();
});

describe('saving with the File System Access API', () => {
  it('writes the encoded map and remembers the handle', async () => {
    const { state, handle } = fakeHandle();
    const show = vi.fn(async () => handle);
    picker.showSaveFilePicker = show;
    expect(hasFileSystemAccess()).toBe(true);

    const world = createTestMap();
    const storage = createMapStorage();
    const first = await storage.save(world);
    expect(first).toMatchObject({ saved: true, via: 'file-system-access', name: 'map.rtsmap' });
    expect(w.hashWorld(decodeMap(state.bytes))).toBe(w.hashWorld(world));

    // A second save reuses the handle rather than asking again.
    world.tier[0] = 3;
    await storage.save(world);
    expect(show).toHaveBeenCalledTimes(1);
    expect(state.closed).toBe(2);
    expect(decodeMap(state.bytes).tier[0]).toBe(3);
  });

  it('asks again for Save As', async () => {
    const show = vi.fn(async () => fakeHandle('other.rtsmap').handle);
    picker.showSaveFilePicker = show;
    const storage = createMapStorage();
    await storage.save(createTestMap());
    await storage.save(createTestMap(), { saveAs: true });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('reports a cancelled picker without saving', async () => {
    picker.showSaveFilePicker = vi.fn(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    const result = await createMapStorage().save(createTestMap());
    expect(result).toMatchObject({ saved: false, via: 'cancelled' });
  });

  it('falls back to a download rather than losing work on an unexpected failure', async () => {
    picker.showSaveFilePicker = vi.fn(async () => {
      throw new Error('disk on fire');
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const result = await createMapStorage().save(createTestMap());
    expect(result.via).toBe('download');
    expect(click).toHaveBeenCalled();
  });
});

describe('the fallback path, in a browser without File System Access', () => {
  beforeEach(() => {
    delete picker.showSaveFilePicker;
    delete picker.showOpenFilePicker;
  });

  it('downloads a blob with the right filename', async () => {
    expect(hasFileSystemAccess()).toBe(false);
    const anchors: HTMLAnchorElement[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        anchors.push(this);
      });

    const result = await createMapStorage().save(createTestMap(), { name: 'arena.rtsmap' });
    expect(result).toMatchObject({ saved: true, via: 'download', name: 'arena.rtsmap' });
    expect(click).toHaveBeenCalledTimes(1);
    expect(anchors[0]?.download).toBe('arena.rtsmap');
    expect(document.querySelectorAll('a[download]')).toHaveLength(0); // cleaned up
  });

  it('opens through a file input', async () => {
    const world = createTestMap();
    const file = new File([encodeMap(world).slice().buffer as ArrayBuffer], 'x.rtsmap');
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { value: [file], configurable: true });
      this.dispatchEvent(new Event('change'));
    });

    const storage = createMapStorage();
    const loaded = await storage.open();
    expect(loaded).not.toBeNull();
    expect(w.hashWorld(loaded as w.World)).toBe(w.hashWorld(world));
    expect(storage.currentName()).toBe('x.rtsmap');
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(0); // cleaned up
  });

  it('loads a dropped file', async () => {
    const world = createTestMap();
    const file = new File([encodeMap(world).slice().buffer as ArrayBuffer], 'dropped.rtsmap');
    const loaded = await createMapStorage().loadFile(file);
    expect(w.hashWorld(loaded)).toBe(w.hashWorld(world));
  });
});

describe('autosave', () => {
  beforeEach(async () => {
    await clearAutosave();
  });

  it('round-trips through IndexedDB', async () => {
    const world = createTestMap();
    expect(await readAutosave()).toBeNull();

    await writeAutosave(world, 'arena.rtsmap');
    const record = await readAutosave();
    expect(record).not.toBeNull();
    expect(record?.name).toBe('arena.rtsmap');
    expect(record?.savedAt).toBeGreaterThan(0);
    expect(w.hashWorld(decodeMap(record!.bytes))).toBe(w.hashWorld(world));
  });

  it('keeps only the newest autosave', async () => {
    const world = createTestMap();
    await writeAutosave(world, 'a');
    world.tier[0] = 3;
    await writeAutosave(world, 'b');
    const record = await readAutosave();
    expect(record?.name).toBe('b');
    expect(decodeMap(record!.bytes).tier[0]).toBe(3);
  });

  it('clears on request, so a fresh session is not offered a stale map', async () => {
    await writeAutosave(createTestMap(), null);
    await clearAutosave();
    expect(await readAutosave()).toBeNull();
  });

  it('runs on a timer and survives a failure', async () => {
    vi.useFakeTimers();
    const world = createTestMap();
    let calls = 0;
    const getWorld = (): w.World => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return world;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = startAutosave(getWorld, () => null, 1000);

    // The first tick throws inside the timer callback; the timer must survive.
    expect(() => vi.advanceTimersByTime(1000)).toThrow(/transient/);
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(2);
    stop();
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(2);
    vi.useRealTimers();
    warn.mockRestore();
  });
});
