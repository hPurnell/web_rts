/**
 * Editor shell: the DOM overlay, its panels and its lifetime.
 *
 * The whole editor is loaded through a dynamic import so it stays out of the
 * game bundle, and everything it touches goes through a Disposer, so toggling
 * modes cannot leak listeners or leave nodes behind.
 */
import { Disposer } from '../ui/disposer.ts';
import type { World } from '../sim/world.ts';
import type { EditorSession } from './session.ts';
import { MAP_EXTENSION, MapFormatError, decodeMap } from './mapfile.ts';
import {
  AUTOSAVE_INTERVAL_MS,
  clearAutosave,
  createMapStorage,
  hasFileSystemAccess,
  readAutosave,
  startAutosave,
} from './storage.ts';

export interface EditorTool {
  readonly id: string;
  readonly label: string;
  /** Single-key shortcut, matched against KeyboardEvent.key. */
  readonly hotkey: string;
  readonly hint: string;
}

export interface EditorContext {
  readonly world: World;
  /** Where the editor's DOM goes. */
  readonly overlay: HTMLElement;
  /** The editing session, when the editor is driving a live scene. */
  readonly session?: EditorSession;
  /** Called when the user picks a different tool. */
  onToolChange?(tool: EditorTool): void;
  /** Called when the user asks to leave the editor. */
  onExit?(): void;
  /**
   * Replace the world being edited. The app owns the World object, so loading
   * a map hands the new one back rather than mutating in place.
   */
  onLoad?(world: World): void;
}

export interface EditorHandle {
  readonly root: HTMLElement;
  readonly tools: readonly EditorTool[];
  activeTool(): EditorTool;
  selectTool(id: string): void;
  setStatus(key: string, value: string): void;
  /** Re-read the session into the status bar. */
  refresh(): void;
  /** Outstanding teardowns; zero after dispose. Used by the leak test. */
  pendingTeardowns(): number;
  dispose(): void;
}

/** Tools are declared here and implemented over M10-M13. */
export const EDITOR_TOOLS: readonly EditorTool[] = [
  { id: 'raise', label: 'Raise tier', hotkey: '1', hint: 'Drag to raise terrain a tier' },
  { id: 'lower', label: 'Lower tier', hotkey: '2', hint: 'Drag to lower terrain a tier' },
  { id: 'ramp', label: 'Ramp', hotkey: '3', hint: 'Drag across a cliff to place a ramp' },
  { id: 'buildable', label: 'Buildable', hotkey: '4', hint: 'Paint the BUILDABLE flag' },
  { id: 'blocker', label: 'Vision blocker', hotkey: '5', hint: 'Paint the VISION_BLOCKER flag' },
  { id: 'resource', label: 'Resource node', hotkey: '6', hint: 'Place a mineral or gas node' },
  { id: 'start', label: 'Start location', hotkey: '7', hint: 'Place a player start location' },
];

export function mountEditor(context: EditorContext): EditorHandle {
  const disposer = new Disposer();
  const { world, overlay } = context;

  const root = document.createElement('div');
  root.className = 'editor-root';
  disposer.mount(overlay, root);

  // --- tool palette -------------------------------------------------------
  const palette = document.createElement('div');
  palette.className = 'editor-panel editor-palette';
  palette.innerHTML = '<h2>Tools</h2>';
  root.appendChild(palette);

  const buttons = new Map<string, HTMLButtonElement>();
  let active: EditorTool = EDITOR_TOOLS[0] as EditorTool;

  for (const tool of EDITOR_TOOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'editor-tool';
    button.dataset['tool'] = tool.id;
    button.title = tool.hint;
    button.innerHTML = `<span class="editor-key">${tool.hotkey}</span><span>${tool.label}</span>`;
    disposer.listen(button, 'click', () => selectTool(tool.id));
    palette.appendChild(button);
    buttons.set(tool.id, button);
  }

  // --- properties panel ---------------------------------------------------
  const properties = document.createElement('div');
  properties.className = 'editor-panel editor-properties';
  properties.innerHTML = '<h2>Map</h2>';
  root.appendChild(properties);

  const mapInfo = document.createElement('div');
  mapInfo.className = 'editor-rows';
  mapInfo.innerHTML =
    `<div class="editor-row"><span>size</span><span>${world.width} x ${world.height}</span></div>` +
    `<div class="editor-row"><span>resource nodes</span><span>${world.resourceNodes.length}</span></div>` +
    `<div class="editor-row"><span>start locations</span><span>${world.startLocations.length}</span></div>`;
  properties.appendChild(mapInfo);

  const hint = document.createElement('p');
  hint.className = 'editor-hint';
  properties.appendChild(hint);

  // --- status bar ---------------------------------------------------------
  const status = document.createElement('div');
  status.className = 'editor-panel editor-status';
  root.appendChild(status);

  const statusRows = new Map<string, HTMLElement>();
  const setStatus = (key: string, value: string): void => {
    let row = statusRows.get(key);
    if (!row) {
      row = document.createElement('span');
      row.className = 'editor-status-item';
      row.innerHTML = `<span class="editor-status-key">${key}</span><span></span>`;
      status.appendChild(row);
      statusRows.set(key, row);
    }
    const target = row.lastElementChild;
    if (target && target.textContent !== value) target.textContent = value;
  };

  // --- file actions -------------------------------------------------------
  const storage = createMapStorage();
  const fileRow = document.createElement('div');
  fileRow.className = 'editor-files';
  properties.appendChild(fileRow);

  const fileButton = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'editor-file-button';
    button.textContent = label;
    button.title = title;
    disposer.listen(button, 'click', onClick);
    fileRow.appendChild(button);
    return button;
  };

  const note = (message: string, isError = false): void => {
    setStatus('file', message);
    status.classList.toggle('file-error', isError);
  };

  const doSave = async (saveAs: boolean): Promise<void> => {
    try {
      const result = await storage.save(world, { saveAs });
      if (!result.saved) return note('save cancelled');
      note(
        result.via === 'download'
          ? `downloaded ${result.name}`
          : `saved ${result.name}`,
      );
    } catch (error) {
      note(error instanceof Error ? error.message : 'save failed', true);
    }
  };

  const doOpen = async (): Promise<void> => {
    try {
      const loaded = await storage.open();
      if (!loaded) return note('open cancelled');
      context.onLoad?.(loaded);
      note(`opened ${storage.currentName() ?? 'map'}`);
    } catch (error) {
      // A version mismatch or a corrupt file must say what is wrong, not just
      // fail: MapFormatError messages are written for the person editing.
      const message =
        error instanceof MapFormatError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'could not open that file';
      note(message, true);
    }
  };

  fileButton('Save', `Save the map (Ctrl+S)`, () => void doSave(false));
  fileButton('Save as', 'Save to a new file', () => void doSave(true));
  fileButton('Open', `Open a ${MAP_EXTENSION} file (Ctrl+O)`, () => void doOpen());
  if (!hasFileSystemAccess()) {
    const fallbackNote = document.createElement('p');
    fallbackNote.className = 'editor-hint';
    fallbackNote.textContent = 'This browser has no file picker; Save downloads a file instead.';
    properties.appendChild(fallbackNote);
  }

  // Autosave every 30 seconds, and offer the previous one on arrival.
  disposer.add(startAutosave(() => world, () => storage.currentName(), AUTOSAVE_INTERVAL_MS));
  void readAutosave()
    .then((record) => {
      if (!record) return;
      const age = Math.round((Date.now() - record.savedAt) / 60_000);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'editor-file-button editor-restore';
      restore.textContent = `Restore autosave (${age}m ago)`;
      disposer.listen(restore, 'click', () => {
        try {
          context.onLoad?.(decodeMap(record.bytes));
          note('restored from autosave');
        } catch (error) {
          note(error instanceof MapFormatError ? error.message : 'autosave is unreadable', true);
        }
        restore.remove();
        void clearAutosave();
      });
      disposer.mount(fileRow, restore);
    })
    .catch(() => {
      // No IndexedDB (private mode, or a browser that blocks it): autosave is
      // a convenience, not a requirement.
    });

  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'editor-exit';
  exit.textContent = 'Exit editor (F2)';
  disposer.listen(exit, 'click', () => context.onExit?.());
  status.appendChild(exit);

  function selectTool(id: string): void {
    const tool = EDITOR_TOOLS.find((t) => t.id === id);
    if (!tool) return;
    active = tool;
    for (const [toolId, button] of buttons) {
      button.classList.toggle('is-active', toolId === id);
    }
    hint.textContent = tool.hint;
    setStatus('tool', tool.label);
    if (context.session) context.session.tool = tool;
    context.onToolChange?.(tool);
  }

  const session = context.session;

  const refresh = (): void => {
    if (!session) return;
    setStatus('brush', `r${session.radius}`);
    setStatus('undo', `${session.history.depth} step${session.history.depth === 1 ? '' : 's'}`);
    // A refused action needs to say why, or the tool just looks broken.
    root.classList.toggle('has-error', session.lastError !== null);
    setStatus('note', session.lastError ?? '');
  };

  disposer.listen(window, 'keydown', (event) => {
    if (event.altKey) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) session?.redo();
      else session?.undo();
      refresh();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void doSave(event.shiftKey);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      void doOpen();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      session?.redo();
      refresh();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;

    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      session?.adjustRadius(event.key === '[' ? -1 : 1);
      refresh();
      return;
    }

    const tool = EDITOR_TOOLS.find((t) => t.hotkey === event.key);
    if (tool) {
      event.preventDefault();
      selectTool(tool.id);
    }
  });

  selectTool(active.id);
  setStatus('map', `${world.width} x ${world.height}`);
  refresh();

  return {
    root,
    tools: EDITOR_TOOLS,
    activeTool: () => active,
    selectTool,
    setStatus,
    refresh,
    pendingTeardowns: () => disposer.pending,
    dispose: () => {
      statusRows.clear();
      buttons.clear();
      storage.dispose();
      disposer.dispose();
    },
  };
}
