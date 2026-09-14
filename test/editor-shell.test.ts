// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_TOOLS, mountEditor } from '../src/editor/index.ts';
import { createModeController, modeFromLocation } from '../src/mode.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';

function makeOverlay(): HTMLElement {
  document.body.innerHTML = '<div id="overlay"></div>';
  return document.getElementById('overlay') as HTMLElement;
}

describe('editor shell', () => {
  let overlay: HTMLElement;

  beforeEach(() => {
    overlay = makeOverlay();
  });

  it('renders a palette, a properties panel and a status bar', () => {
    const editor = mountEditor({ world: createTestMap(), overlay });
    expect(overlay.querySelector('.editor-palette')).not.toBeNull();
    expect(overlay.querySelector('.editor-properties')).not.toBeNull();
    expect(overlay.querySelector('.editor-status')).not.toBeNull();
    expect(overlay.querySelectorAll('.editor-tool')).toHaveLength(EDITOR_TOOLS.length);
    editor.dispose();
  });

  it('shows the map it is editing', () => {
    const world = createTestMap();
    const editor = mountEditor({ world, overlay });
    const text = overlay.querySelector('.editor-properties')?.textContent ?? '';
    expect(text).toContain(`${world.width} x ${world.height}`);
    expect(text).toContain(String(world.resourceNodes.length));
    editor.dispose();
  });

  it('selects tools by click and by hotkey, and reports the change once', () => {
    const onToolChange = vi.fn();
    const editor = mountEditor({ world: createTestMap(), overlay, onToolChange });
    expect(editor.activeTool().id).toBe(EDITOR_TOOLS[0]?.id);
    onToolChange.mockClear();

    const rampButton = overlay.querySelector<HTMLButtonElement>('[data-tool="ramp"]');
    rampButton?.click();
    expect(editor.activeTool().id).toBe('ramp');
    expect(rampButton?.classList.contains('is-active')).toBe(true);
    expect(onToolChange).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '5' }));
    expect(editor.activeTool().id).toBe('blocker');
    expect(rampButton?.classList.contains('is-active')).toBe(false);
    editor.dispose();
  });

  it('ignores hotkeys held with a modifier', () => {
    const editor = mountEditor({ world: createTestMap(), overlay });
    editor.selectTool('ramp');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', ctrlKey: true }));
    expect(editor.activeTool().id).toBe('ramp');
    editor.dispose();
  });

  it('calls onExit from the exit button', () => {
    const onExit = vi.fn();
    const editor = mountEditor({ world: createTestMap(), overlay, onExit });
    overlay.querySelector<HTMLButtonElement>('.editor-exit')?.click();
    expect(onExit).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  it('leaves nothing behind when disposed', () => {
    const editor = mountEditor({ world: createTestMap(), overlay });
    expect(editor.pendingTeardowns()).toBeGreaterThan(0);
    editor.dispose();
    expect(editor.pendingTeardowns()).toBe(0);
    expect(overlay.querySelector('.editor-root')).toBeNull();
    expect(overlay.children).toHaveLength(0);
  });

  it('does not leak listeners across repeated mount and dispose', () => {
    // A stale keydown listener would keep switching tools on a dead editor.
    const world = createTestMap();
    const changes = vi.fn();
    for (let i = 0; i < 25; i++) {
      const editor = mountEditor({ world, overlay, onToolChange: changes });
      editor.dispose();
    }
    changes.mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));
    expect(changes).not.toHaveBeenCalled();
    expect(overlay.children).toHaveLength(0);
  });
});

describe('mode switching', () => {
  let overlay: HTMLElement;

  beforeEach(() => {
    overlay = makeOverlay();
    window.history.replaceState(null, '', '/');
  });

  it('reads the mode out of the URL', () => {
    expect(modeFromLocation('?mode=editor')).toBe('editor');
    expect(modeFromLocation('')).toBe('game');
    expect(modeFromLocation('?mode=game')).toBe('game');
  });

  it('mounts and unmounts the editor on toggle, and tracks the URL', async () => {
    const onChange = vi.fn();
    const mode = createModeController({ world: () => createTestMap(), overlay, onChange });
    expect(mode.current()).toBe('game');

    await mode.toggle();
    expect(mode.current()).toBe('editor');
    expect(overlay.querySelector('.editor-root')).not.toBeNull();
    expect(overlay.querySelector('.mode-badge')).not.toBeNull();
    expect(window.location.search).toBe('?mode=editor');

    await mode.toggle();
    expect(mode.current()).toBe('game');
    expect(overlay.querySelector('.editor-root')).toBeNull();
    expect(overlay.querySelector('.mode-badge')).toBeNull();
    expect(window.location.search).toBe('');
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['editor', 'game']);
    mode.dispose();
  });

  it('survives a double toggle without orphaning an editor', async () => {
    // The editor import is async: two fast presses must not mount twice.
    const mode = createModeController({ world: () => createTestMap(), overlay });
    const first = mode.toggle();
    const second = mode.toggle();
    await Promise.all([first, second]);
    expect(mode.current()).toBe('game');
    expect(overlay.querySelectorAll('.editor-root')).toHaveLength(0);
    mode.dispose();
  });

  it('exits the editor from its own exit button', async () => {
    const mode = createModeController({ world: () => createTestMap(), overlay });
    await mode.set('editor');
    overlay.querySelector<HTMLButtonElement>('.editor-exit')?.click();
    await mode.set('game'); // flushes the queued switch the click started
    expect(mode.current()).toBe('game');
    expect(overlay.querySelector('.editor-root')).toBeNull();
    mode.dispose();
  });

  it('cleans up when disposed while the editor is open', async () => {
    const mode = createModeController({ world: () => createTestMap(), overlay });
    await mode.set('editor');
    mode.dispose();
    expect(overlay.querySelector('.editor-root')).toBeNull();
  });
});
