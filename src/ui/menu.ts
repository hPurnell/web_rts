/**
 * The main menu.
 *
 * Drawn over a live scene rather than over a black screen, because the map is
 * already loaded and rendering by the time anyone sees this, and a menu with
 * the terrain moving behind it costs nothing extra.
 *
 * Everything it can do, the console can do too: both drive the same
 * `ConsoleGame` surface, and the settings screen is a view onto cvars rather
 * than a second place where preferences live. A menu that kept its own copy of
 * "show stats" would drift from `cl_showstats` within a week.
 */
import { Disposer } from './disposer.ts';
import type { ConsoleGame } from '../game/consolecommands.ts';
import type { Cvar, GameConsole } from './console.ts';
import { formatValue } from './console.ts';

/** Cvars the settings screen exposes, in the order it shows them. */
const SETTINGS_CVARS = ['cl_showstats', 'cam_speed', 'r_overlay', 'r_wireframe'];

export type MenuScreen = 'root' | 'skirmish' | 'multiplayer' | 'settings';

export interface MenuContext {
  readonly overlay: HTMLElement;
  readonly game: ConsoleGame;
  readonly console: GameConsole;
  /** Called whenever the menu opens or closes, so the shell can react. */
  onVisibility?(open: boolean): void;
}

export interface MainMenu {
  readonly root: HTMLElement;
  isOpen(): boolean;
  open(screen?: MenuScreen): void;
  close(): void;
  toggle(): void;
  screen(): MenuScreen;
  /** Offer a keydown. Returns true if the menu consumed it. */
  handleKey(event: KeyboardEvent): boolean;
  /** Re-read game state, so Resume appears once a match starts. */
  refresh(): void;
  dispose(): void;
}

interface MenuItem {
  readonly label: string;
  readonly hint?: string;
  readonly enabled: boolean;
  activate(): void;
}

export function createMainMenu(context: MenuContext): MainMenu {
  const disposer = new Disposer();
  const { game, console: gameConsole } = context;

  const root = document.createElement('div');
  root.className = 'menu';
  root.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'menu-panel';

  const title = document.createElement('h1');
  title.className = 'menu-title';
  title.textContent = 'WEB RTS';

  const subtitle = document.createElement('p');
  subtitle.className = 'menu-subtitle';

  const list = document.createElement('div');
  list.className = 'menu-items';
  list.setAttribute('role', 'menu');

  const fields = document.createElement('div');
  fields.className = 'menu-fields';

  const footer = document.createElement('p');
  footer.className = 'menu-footer';
  footer.textContent = 'Arrows and Enter, or click.   `  opens the console.';

  panel.append(title, subtitle, fields, list, footer);
  root.appendChild(panel);
  context.overlay.appendChild(root);

  let open = false;
  let screen: MenuScreen = 'root';
  let cursor = 0;
  let items: MenuItem[] = [];

  // Form state lives here rather than in the DOM, so switching screens and
  // coming back does not lose what was typed.
  let seed = String(Math.floor(Date.now() % 100000));
  let relayUrl = 'ws://localhost:8787';
  /** The map the Start button will load, empty for whatever is already up. */
  let chosenMap = '';
  let loadingMap = false;
  let matchId = 'default';

  const textField = (
    label: string,
    value: string,
    onInput: (value: string) => void,
  ): HTMLElement => {
    const row = document.createElement('label');
    row.className = 'menu-field';
    const caption = document.createElement('span');
    caption.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.spellcheck = false;
    disposer.listen(input, 'input', () => onInput(input.value));
    // Arrow keys belong to the text box while it has focus, not to the menu.
    disposer.listen(input, 'keydown', (event) => event.stopPropagation());
    row.append(caption, input);
    return row;
  };

  const selectField = (
    label: string,
    options: readonly { value: string; text: string }[],
    selected: string,
    onChange: (value: string) => void,
  ): HTMLElement => {
    const row = document.createElement('label');
    row.className = 'menu-field';
    const caption = document.createElement('span');
    caption.textContent = label;
    const select = document.createElement('select');
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.text;
      if (option.value === selected) element.selected = true;
      select.appendChild(element);
    }
    disposer.listen(select, 'change', () => onChange(select.value));
    // Arrows belong to the dropdown while it has focus, not to the menu.
    disposer.listen(select, 'keydown', (event) => event.stopPropagation());
    row.append(caption, select);
    return row;
  };

  /** One settings row, typed from the cvar rather than hard-coded per name. */
  const cvarField = (cvar: Cvar): HTMLElement => {
    const row = document.createElement('label');
    row.className = 'menu-field';
    const caption = document.createElement('span');
    caption.textContent = cvar.name;
    caption.title = cvar.help;

    if (cvar.type === 'boolean') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = cvar.value === true;
      disposer.listen(input, 'change', () => {
        gameConsole.execute(`${cvar.name} ${input.checked ? 1 : 0}`, { silent: true });
      });
      row.append(caption, input);
      return row;
    }

    if (cvar.type === 'number') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(cvar.min ?? 0);
      input.max = String(cvar.max ?? 10);
      input.step = '0.1';
      input.value = String(cvar.value);
      const readout = document.createElement('span');
      readout.className = 'menu-readout';
      readout.textContent = formatValue(cvar.value);
      disposer.listen(input, 'input', () => {
        readout.textContent = input.value;
        gameConsole.execute(`${cvar.name} ${input.value}`, { silent: true });
      });
      disposer.listen(input, 'keydown', (event) => event.stopPropagation());
      row.append(caption, input, readout);
      return row;
    }

    const select = document.createElement('select');
    const options =
      cvar.name === 'r_overlay' ? ['off', ...game.overlayLayers()] : [String(cvar.value)];
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option;
      element.textContent = option;
      if (option === String(cvar.value)) element.selected = true;
      select.appendChild(element);
    }
    disposer.listen(select, 'change', () => {
      gameConsole.execute(`${cvar.name} ${select.value}`, { silent: true });
    });
    disposer.listen(select, 'keydown', (event) => event.stopPropagation());
    row.append(caption, select);
    return row;
  };

  function buildRoot(): MenuItem[] {
    const running = game.match() !== null;
    return [
      {
        label: running ? 'Resume' : 'Continue',
        hint: running ? 'Back to the match' : 'Look at the map',
        enabled: true,
        activate: () => menu.close(),
      },
      {
        label: 'Skirmish',
        hint: 'Start a match against the skirmish bot',
        enabled: true,
        activate: () => show('skirmish'),
      },
      {
        label: 'Multiplayer',
        hint: 'Join a match through a relay',
        enabled: true,
        activate: () => show('multiplayer'),
      },
      {
        label: 'Map Editor',
        hint: 'Sculpt terrain and place resources',
        enabled: true,
        activate: () => {
          game.openEditor();
          menu.close();
        },
      },
      {
        label: 'Watch Last Replay',
        hint: game.hasReplay() ? 'Replay the match that just finished' : 'No replay recorded yet',
        enabled: game.hasReplay(),
        activate: () => {
          game.playLastReplay();
          menu.close();
        },
      },
      {
        label: 'Settings',
        hint: 'A few cvars, the same ones the console sets',
        enabled: true,
        activate: () => show('settings'),
      },
      ...(running
        ? [
            {
              label: 'Quit to Menu',
              hint: 'End the running match',
              enabled: true,
              activate: () => {
                game.stopMatch();
                render();
              },
            },
          ]
        : []),
    ];
  }

  function buildSkirmish(): MenuItem[] {
    const maps = game.availableMaps();

    // Only offered when a content pack brought maps. With no pack there is one
    // map — the built-in fixture — and a dropdown with a single entry is
    // worse than no dropdown.
    if (maps.length > 0) {
      fields.appendChild(
        selectField(
          'Map',
          maps.map((entry) => ({
            value: entry.slug,
            text: `${entry.name}  (${entry.width}x${entry.height})`,
          })),
          chosenMap || game.currentMap(),
          (value) => {
            chosenMap = value;
            // Re-render so Start's hint says what it will actually do. The
            // dropdown has already closed by the time this fires, so rebuilding
            // the fields costs nothing visible.
            render();
          },
        ),
      );
    }

    fields.appendChild(
      textField('Seed', seed, (value) => {
        seed = value;
      }),
    );

    // Read at activation as well as here: the dropdown writes `chosenMap`,
    // and a closure that captured it at build time would start a match on the
    // map that was showing when the screen was drawn.
    const pendingMap = (): string =>
      chosenMap && chosenMap !== game.currentMap() ? chosenMap : '';

    return [
      {
        label: 'Start',
        hint: pendingMap() ? `Load ${pendingMap()} and begin` : 'Begin a match on the loaded map',
        enabled: !loadingMap,
        activate: () => {
          const parsed = Number(seed);
          const startSeed = Number.isFinite(parsed) ? Math.trunc(parsed) : 1;
          const pending = pendingMap();

          // Loading a map swaps the world out, so the match has to start after
          // it lands rather than on the world that is about to be replaced.
          if (pending) {
            loadingMap = true;
            render();
            void game.loadMap(pending).finally(() => {
              loadingMap = false;
              game.stopMatch();
              game.startMatch(startSeed);
              menu.close();
            });
            return;
          }

          game.stopMatch();
          game.startMatch(startSeed);
          menu.close();
        },
      },
      { label: 'Back', enabled: true, activate: () => show('root') },
    ];
  }

  function buildMultiplayer(): MenuItem[] {
    fields.append(
      textField('Relay', relayUrl, (value) => {
        relayUrl = value;
      }),
      textField('Match', matchId, (value) => {
        matchId = value;
      }),
    );
    return [
      {
        label: 'Connect',
        hint: 'Cheats are locked off in a networked match',
        enabled: relayUrl.trim().length > 0,
        activate: () => {
          game.connect(relayUrl.trim(), matchId.trim() || 'default');
          menu.close();
        },
      },
      { label: 'Back', enabled: true, activate: () => show('root') },
    ];
  }

  function buildSettings(): MenuItem[] {
    for (const name of SETTINGS_CVARS) {
      const cvar = gameConsole.lookup(name);
      if (cvar) fields.appendChild(cvarField(cvar));
    }
    return [{ label: 'Back', enabled: true, activate: () => show('root') }];
  }

  function render(): void {
    list.textContent = '';
    fields.textContent = '';

    subtitle.textContent =
      screen === 'root'
        ? game.match()
          ? 'Match in progress'
          : 'No match running'
        : screen === 'skirmish'
          ? 'Skirmish'
          : screen === 'multiplayer'
            ? 'Multiplayer'
            : 'Settings';

    items =
      screen === 'skirmish'
        ? buildSkirmish()
        : screen === 'multiplayer'
          ? buildMultiplayer()
          : screen === 'settings'
            ? buildSettings()
            : buildRoot();

    cursor = Math.min(cursor, Math.max(0, items.length - 1));
    if (!items[cursor]?.enabled) cursor = items.findIndex((item) => item.enabled);
    if (cursor < 0) cursor = 0;

    items.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.dataset['item'] = item.label;
      button.disabled = !item.enabled;
      if (index === cursor) button.classList.add('is-active');

      const label = document.createElement('span');
      label.className = 'menu-item-label';
      label.textContent = item.label;
      button.appendChild(label);

      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'menu-item-hint';
        hint.textContent = item.hint;
        button.appendChild(hint);
      }

      disposer.listen(button, 'click', () => {
        if (!item.enabled) return;
        cursor = index;
        item.activate();
      });
      // Hovering moves the cursor, so mouse and keyboard agree about where it is.
      disposer.listen(button, 'mouseenter', () => {
        if (!item.enabled || cursor === index) return;
        cursor = index;
        highlight();
      });

      list.appendChild(button);
    });
  }

  function highlight(): void {
    const buttons = list.querySelectorAll<HTMLButtonElement>('.menu-item');
    buttons.forEach((button, index) => button.classList.toggle('is-active', index === cursor));
  }

  function show(next: MenuScreen): void {
    screen = next;
    cursor = 0;
    render();
  }

  /** Step the cursor, skipping anything disabled, wrapping at both ends. */
  function move(delta: number): void {
    if (items.length === 0) return;
    let index = cursor;
    for (let i = 0; i < items.length; i++) {
      index = (index + delta + items.length) % items.length;
      if (items[index]?.enabled) break;
    }
    cursor = index;
    highlight();
  }

  const menu: MainMenu = {
    root,
    isOpen: () => open,
    screen: () => screen,

    open(next) {
      if (next) screen = next;
      if (open) {
        render();
        return;
      }
      open = true;
      root.hidden = false;
      render();
      context.onVisibility?.(true);
    },

    close() {
      if (!open) return;
      open = false;
      root.hidden = true;
      screen = 'root';
      context.onVisibility?.(false);
    },

    toggle() {
      if (open) menu.close();
      else menu.open();
    },

    refresh() {
      if (open) render();
    },

    handleKey(event) {
      if (!open) return false;
      if (event.ctrlKey || event.metaKey || event.altKey) return false;

      switch (event.code) {
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          return true;
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          return true;
        case 'Enter':
        case 'NumpadEnter':
        case 'Space': {
          event.preventDefault();
          const item = items[cursor];
          if (item?.enabled) item.activate();
          return true;
        }
        case 'Escape':
          event.preventDefault();
          // Escape backs out one level, and closes from the root — but only
          // when there is something to go back to.
          if (screen !== 'root') show('root');
          else if (game.match() !== null) menu.close();
          return true;
        default:
          // Everything else is swallowed: the menu is modal over the game, and
          // a stray keypress must not reach the units behind it.
          return true;
      }
    },

    dispose() {
      disposer.dispose();
      root.remove();
    },
  };

  return menu;
}
