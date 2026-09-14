/**
 * Editor shell: the DOM overlay, its panels and its lifetime.
 *
 * The whole editor is loaded through a dynamic import so it stays out of the
 * game bundle, and everything it touches goes through a Disposer, so toggling
 * modes cannot leak listeners or leave nodes behind.
 */
import { Disposer } from '../ui/disposer.ts';
import type { World } from '../sim/world.ts';

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
  /** Called when the user picks a different tool. */
  onToolChange?(tool: EditorTool): void;
  /** Called when the user asks to leave the editor. */
  onExit?(): void;
}

export interface EditorHandle {
  readonly root: HTMLElement;
  readonly tools: readonly EditorTool[];
  activeTool(): EditorTool;
  selectTool(id: string): void;
  setStatus(key: string, value: string): void;
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
    context.onToolChange?.(tool);
  }

  disposer.listen(window, 'keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tool = EDITOR_TOOLS.find((t) => t.hotkey === event.key);
    if (tool) {
      event.preventDefault();
      selectTool(tool.id);
    }
  });

  selectTool(active.id);
  setStatus('map', `${world.width} x ${world.height}`);

  return {
    root,
    tools: EDITOR_TOOLS,
    activeTool: () => active,
    selectTool,
    setStatus,
    pendingTeardowns: () => disposer.pending,
    dispose: () => {
      statusRows.clear();
      buttons.clear();
      disposer.dispose();
    },
  };
}
