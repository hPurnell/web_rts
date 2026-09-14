/**
 * Game / Editor mode switching.
 *
 * The editor is behind a dynamic import so it is code-split out of the game
 * bundle, and it is mounted and unmounted on every toggle rather than hidden,
 * so its listeners cannot fire while the game has focus.
 *
 * The mode is also in the URL (?mode=editor) so a reload keeps you where you
 * were and the editor is linkable.
 */
import type { EditorHandle } from './editor/index.ts';
import type { World } from './sim/world.ts';

export type Mode = 'game' | 'editor';

export const MODE_KEY = 'F2';

export interface ModeContext {
  readonly world: World;
  readonly overlay: HTMLElement;
  /** Called after every completed switch, with the new mode. */
  onChange?(mode: Mode): void;
}

export interface ModeController {
  current(): Mode;
  editor(): EditorHandle | null;
  set(mode: Mode): Promise<void>;
  toggle(): Promise<void>;
  dispose(): void;
}

export function modeFromLocation(search: string): Mode {
  return new URLSearchParams(search).get('mode') === 'editor' ? 'editor' : 'game';
}

export function createModeController(context: ModeContext): ModeController {
  let mode: Mode = 'game';
  let editor: EditorHandle | null = null;
  let badge: HTMLElement | null = null;
  let switching: Promise<void> = Promise.resolve();

  const applyUrl = (next: Mode): void => {
    const url = new URL(window.location.href);
    if (next === 'editor') url.searchParams.set('mode', 'editor');
    else url.searchParams.delete('mode');
    window.history.replaceState(null, '', url);
  };

  const enter = async (): Promise<void> => {
    if (editor) return;
    // The one dynamic import that keeps src/editor out of the game bundle.
    const { mountEditor } = await import('./editor/index.ts');
    editor = mountEditor({
      world: context.world,
      overlay: context.overlay,
      onExit: () => {
        void controller.set('game');
      },
    });
    badge = document.createElement('div');
    badge.className = 'mode-badge';
    badge.textContent = 'editor mode';
    context.overlay.appendChild(badge);
  };

  const leave = (): void => {
    editor?.dispose();
    editor = null;
    badge?.remove();
    badge = null;
  };

  /**
   * Serialise switches: the editor's import is async, so two fast presses of
   * F2 must not mount two editors or orphan one. `resolve` runs when the switch
   * reaches the front of the queue, not when it was requested -- otherwise a
   * double-tap computes both targets from the same stale mode and the second
   * press becomes a no-op.
   */
  const enqueue = (resolve: () => Mode): Promise<void> => {
    switching = switching.then(async () => {
      const next = resolve();
      if (next === mode) return;
      mode = next;
      if (next === 'editor') await enter();
      else leave();
      applyUrl(next);
      context.onChange?.(next);
    });
    return switching;
  };

  const controller: ModeController = {
    current: () => mode,
    editor: () => editor,
    set: (next) => enqueue(() => next),
    toggle: () => enqueue(() => (mode === 'game' ? 'editor' : 'game')),
    dispose() {
      leave();
    },
  };

  return controller;
}
