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
import type { EditorHandle, EditorSession, SessionHooks } from './editor/index.ts';
import type { World } from './sim/world.ts';

export type Mode = 'game' | 'editor';

export const MODE_KEY = 'F2';

export interface ModeContext {
  /**
   * The map being edited, read fresh each time the editor mounts: loading a
   * file replaces the World object, and a stale reference would leave the
   * editor quietly editing the previous map.
   */
  world(): World;
  readonly overlay: HTMLElement;
  /** Hooks the editing session needs to reach the scene. Omit for a UI-only
   * editor, as the DOM tests do. */
  readonly sessionHooks?: SessionHooks;
  /** Called after every completed switch, with the new mode. */
  onChange?(mode: Mode): void;
  /** Called when the editor loads a map from disk or from an autosave. */
  onLoad?(world: World): void;
}

export interface ModeController {
  current(): Mode;
  editor(): EditorHandle | null;
  session(): EditorSession | null;
  /** Rebind the editor to the current world. No-op in game mode. */
  remount(): Promise<void>;
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
  let session: EditorSession | null = null;
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
    const { mountEditor, createSession } = await import('./editor/index.ts');
    const hooks = context.sessionHooks;
    const world = context.world();
    session = hooks ? createSession(world, { ...hooks, onChange: () => editor?.refresh() }) : null;
    editor = mountEditor({
      world,
      overlay: context.overlay,
      ...(session ? { session } : {}),
      onExit: () => {
        void controller.set('game');
      },
      ...(context.onLoad ? { onLoad: context.onLoad } : {}),
    });
    badge = document.createElement('div');
    badge.className = 'mode-badge';
    badge.textContent = 'editor mode';
    context.overlay.appendChild(badge);
  };

  const leave = (): void => {
    editor?.dispose();
    editor = null;
    session?.dispose();
    session = null;
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
    session: () => session,
    set: (next) => enqueue(() => next),
    remount() {
      return enqueue(() => {
        if (mode !== 'editor') return mode;
        leave();
        // Returning the same mode would short-circuit; flip to game and back.
        mode = 'game';
        return 'editor';
      });
    },
    toggle: () => enqueue(() => (mode === 'game' ? 'editor' : 'game')),
    dispose() {
      leave();
    },
  };

  return controller;
}
