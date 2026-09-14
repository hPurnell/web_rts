/**
 * Getting maps on and off disk.
 *
 * Three paths, in order of preference:
 *   1. File System Access API — a real Save/Save As, with the handle kept so
 *      a second save overwrites rather than piling up downloads.
 *   2. A Blob download and a file input, for browsers without it (Firefox and
 *      Safari at time of writing).
 *   3. An IndexedDB autosave every 30 seconds, offered back on the next load.
 *
 * No SharedArrayBuffer, no service worker: this all works on GitHub Pages.
 */
import type { World } from '../sim/world.ts';
import { MAP_EXTENSION, decodeMap, encodeMap, suggestFilename } from './mapfile.ts';

export const AUTOSAVE_INTERVAL_MS = 30_000;
const DB_NAME = 'web_rts';
const DB_VERSION = 1;
const STORE = 'autosave';
const AUTOSAVE_KEY = 'latest';

/** Narrow structural types: the DOM lib does not ship these yet everywhere. */
interface FileSystemWritable {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  readonly name: string;
  createWritable(): Promise<FileSystemWritable>;
  getFile(): Promise<File>;
}
interface SavePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type PickerWindow = Window & {
  showSaveFilePicker?(options?: SavePickerOptions): Promise<FileHandle>;
  showOpenFilePicker?(options?: SavePickerOptions): Promise<FileHandle[]>;
};

export function hasFileSystemAccess(): boolean {
  return typeof (window as PickerWindow).showSaveFilePicker === 'function';
}

const PICKER_TYPES = [
  { description: 'RTS map', accept: { 'application/octet-stream': [MAP_EXTENSION] } },
];

export interface SaveResult {
  readonly saved: boolean;
  readonly name: string | null;
  /** How the file left the browser, for the status bar and for tests. */
  readonly via: 'file-system-access' | 'download' | 'cancelled';
}

export interface MapStorage {
  /** Save, reusing the previous handle when the platform allows it. */
  save(world: World, options?: { saveAs?: boolean; name?: string }): Promise<SaveResult>;
  /** Open a map, through the picker or a file input. */
  open(): Promise<World | null>;
  /** Load a map from a File the caller already has (drag and drop). */
  loadFile(file: File): Promise<World>;
  currentName(): string | null;
  dispose(): void;
}

export function createMapStorage(): MapStorage {
  let handle: FileHandle | null = null;
  let name: string | null = null;

  const downloadBytes = (bytes: Uint8Array, filename: string): void => {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking immediately can race the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const pickFile = (): Promise<File | null> =>
    new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = MAP_EXTENSION;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const file = input.files?.[0] ?? null;
        input.remove();
        resolve(file);
      });
      // A cancelled picker fires no event in most browsers; the input is
      // removed when the page unloads, which is good enough for a dialog.
      input.click();
    });

  return {
    currentName: () => name,

    async save(world, options = {}) {
      const bytes = encodeMap(world);
      const picker = window as PickerWindow;

      if (picker.showSaveFilePicker) {
        try {
          if (options.saveAs || !handle) {
            handle = await picker.showSaveFilePicker({
              suggestedName: options.name ?? suggestFilename(),
              types: PICKER_TYPES,
            });
          }
          const writable = await handle.createWritable();
          await writable.write(bytes.slice().buffer as ArrayBuffer);
          await writable.close();
          name = handle.name;
          return { saved: true, name, via: 'file-system-access' };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return { saved: false, name, via: 'cancelled' };
          }
          // Any other failure falls through to the download path rather than
          // losing the user's work.
          handle = null;
        }
      }

      const filename = options.name ?? suggestFilename();
      downloadBytes(bytes, filename);
      name = filename;
      return { saved: true, name, via: 'download' };
    },

    async open() {
      const picker = window as PickerWindow;
      if (picker.showOpenFilePicker) {
        try {
          const [picked] = await picker.showOpenFilePicker({ types: PICKER_TYPES });
          if (!picked) return null;
          handle = picked;
          name = picked.name;
          return decodeMap(new Uint8Array(await (await picked.getFile()).arrayBuffer()));
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return null;
          throw error;
        }
      }

      const file = await pickFile();
      if (!file) return null;
      name = file.name;
      handle = null;
      return decodeMap(new Uint8Array(await file.arrayBuffer()));
    },

    async loadFile(file) {
      name = file.name;
      handle = null;
      return decodeMap(new Uint8Array(await file.arrayBuffer()));
    },

    dispose() {
      handle = null;
      name = null;
    },
  };
}

// --- autosave --------------------------------------------------------------

export interface AutosaveRecord {
  readonly bytes: Uint8Array;
  readonly savedAt: number;
  readonly name: string | null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

export async function writeAutosave(world: World, name: string | null): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(
        { bytes: encodeMap(world), savedAt: Date.now(), name },
        AUTOSAVE_KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('autosave failed'));
    });
  } finally {
    db.close();
  }
}

export async function readAutosave(): Promise<AutosaveRecord | null> {
  const db = await openDatabase();
  try {
    return await new Promise<AutosaveRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(AUTOSAVE_KEY);
      request.onsuccess = () => resolve((request.result as AutosaveRecord | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('autosave read failed'));
    });
  } finally {
    db.close();
  }
}

export async function clearAutosave(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('autosave clear failed'));
    });
  } finally {
    db.close();
  }
}

/**
 * Run `writeAutosave` on a timer. Autosave is best-effort: a failure must not
 * interrupt editing, so errors are logged and the timer keeps running.
 */
export function startAutosave(
  getWorld: () => World,
  getName: () => string | null,
  intervalMs = AUTOSAVE_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void writeAutosave(getWorld(), getName()).catch((error: unknown) => {
      console.warn('[autosave] failed:', error);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
