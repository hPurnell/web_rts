// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMainMenu } from '../src/ui/menu.ts';
import type { MainMenu } from '../src/ui/menu.ts';
import { createConsole } from '../src/ui/console.ts';
import type { GameConsole } from '../src/ui/console.ts';
import { createConsoleView } from '../src/ui/consoleview.ts';
import { registerGameCommands } from '../src/game/consolecommands.ts';
import type { ConsoleGame } from '../src/game/consolecommands.ts';
import { createTestMap } from '../src/sim/fixtures/testmap.ts';
import { createMatchFromWorld } from '../src/sim/matchinit.ts';
import type { Match } from '../src/sim/match.ts';

let overlay: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  overlay = document.createElement('div');
  document.body.appendChild(overlay);
});

function fakeGame(overrides: Partial<ConsoleGame> = {}): {
  game: ConsoleGame;
  calls: Record<string, number>;
} {
  const world = createTestMap();
  const calls: Record<string, number> = {};
  const count =
    (name: string) =>
    (): void => {
      calls[name] = (calls[name] ?? 0) + 1;
    };

  const game: ConsoleGame = {
    world: () => world,
    match: () => null,
    selection: () => [],
    focus: () => ({ x: 0, z: 0 }),
    localPlayer: () => 0,
    availableMaps: () => [],
    currentMap: () => '',
    loadMap: () => Promise.resolve(false),
    startMatch: count('startMatch'),
    stopMatch: count('stopMatch'),
    connect: count('connect'),
    openEditor: count('openEditor'),
    closeEditor: count('closeEditor'),
    inEditor: () => false,
    playLastReplay: count('playLastReplay'),
    hasReplay: () => false,
    saveReplay: count('saveReplay'),
    stressSpawn: () => 0,
    setFogEnabled: () => {},
    setOverlayLayer: () => {},
    overlayLayers: () => ['walkable', 'slope'],
    setWireframe: () => {},
    setFogSoftness: () => {},
    setShadowsEnabled: () => {},
    setLightScale: () => {},
    setStatsVisible: () => {},
    setCameraSpeed: () => {},
    ...overrides,
  };
  return { game, calls };
}

function mount(overrides: Partial<ConsoleGame> = {}): {
  menu: MainMenu;
  console: GameConsole;
  game: ConsoleGame;
  calls: Record<string, number>;
} {
  const { game, calls } = fakeGame(overrides);
  const console = createConsole();
  registerGameCommands(console, game);
  const menu = createMainMenu({ overlay, game, console });
  return { menu, console, game, calls };
}

function press(menu: MainMenu, code: string): boolean {
  const event = new KeyboardEvent('keydown', { code, cancelable: true });
  return menu.handleKey(event);
}

function labels(): string[] {
  return [...overlay.querySelectorAll('.menu-item-label')].map((n) => n.textContent ?? '');
}

function activeLabel(): string {
  return overlay.querySelector('.menu-item.is-active .menu-item-label')?.textContent ?? '';
}

function click(label: string): void {
  const button = [...overlay.querySelectorAll<HTMLButtonElement>('.menu-item')].find(
    (b) => b.dataset['item'] === label,
  );
  button?.click();
}

describe('the main menu', () => {
  it('starts closed and opens on the root screen', () => {
    const { menu } = mount();
    expect(menu.isOpen()).toBe(false);
    expect(overlay.querySelector('.menu')?.hasAttribute('hidden')).toBe(true);

    menu.open();
    expect(menu.isOpen()).toBe(true);
    expect(menu.screen()).toBe('root');
    expect(labels()).toContain('Skirmish');
    expect(labels()).toContain('Map Editor');
  });

  it('offers Quit to Menu only while a match is running', () => {
    const idle = mount();
    idle.menu.open();
    expect(labels()).not.toContain('Quit to Menu');
    idle.menu.dispose();

    const match = createMatchFromWorld({ world: createTestMap(), seed: 1, playerCount: 2 });
    const running = mount({ match: () => match as Match });
    running.menu.open();
    expect(labels()).toContain('Quit to Menu');
    expect(labels()).toContain('Resume');
  });

  it('disables the replay entry until there is a replay', () => {
    const { menu } = mount();
    menu.open();
    const button = [...overlay.querySelectorAll<HTMLButtonElement>('.menu-item')].find(
      (b) => b.dataset['item'] === 'Watch Last Replay',
    );
    expect(button?.disabled).toBe(true);
  });

  it('moves the cursor with the arrow keys and wraps', () => {
    const { menu } = mount();
    menu.open();
    const first = activeLabel();

    press(menu, 'ArrowDown');
    expect(activeLabel()).not.toBe(first);

    // Up from the top wraps to the bottom.
    press(menu, 'ArrowUp');
    press(menu, 'ArrowUp');
    expect(activeLabel()).toBe(labels().at(-1));
  });

  it('skips disabled entries when moving', () => {
    // Watch Last Replay is disabled here, so it must never take the cursor.
    const { menu } = mount();
    menu.open();
    for (let i = 0; i < 12; i++) {
      press(menu, 'ArrowDown');
      expect(activeLabel()).not.toBe('Watch Last Replay');
    }
  });

  it('activates the highlighted entry with Enter', () => {
    const { menu, calls } = mount();
    menu.open();
    // Walk to Map Editor and press Enter.
    while (activeLabel() !== 'Map Editor') press(menu, 'ArrowDown');
    press(menu, 'Enter');
    expect(calls['openEditor']).toBe(1);
    expect(menu.isOpen()).toBe(false);
  });

  it('activates on click too', () => {
    const { menu, calls } = mount();
    menu.open();
    click('Map Editor');
    expect(calls['openEditor']).toBe(1);
  });

  it('walks into a submenu and back out with Escape', () => {
    const { menu } = mount();
    menu.open();
    click('Skirmish');
    expect(menu.screen()).toBe('skirmish');
    expect(overlay.querySelector('.menu-field')).not.toBeNull();

    press(menu, 'Escape');
    expect(menu.screen()).toBe('root');
    expect(menu.isOpen()).toBe(true);
  });

  it('will not close from the root when there is no match to go back to', () => {
    // Closing the menu with nothing running would leave the player staring at
    // a map with no way back in.
    const { menu } = mount();
    menu.open();
    press(menu, 'Escape');
    expect(menu.isOpen()).toBe(true);

    const match = createMatchFromWorld({ world: createTestMap(), seed: 1, playerCount: 2 });
    const running = mount({ match: () => match as Match });
    running.menu.open();
    press(running.menu, 'Escape');
    expect(running.menu.isOpen()).toBe(false);
  });

  it('starts a skirmish with the seed that was typed', () => {
    const { menu, calls, game } = mount();
    const started: number[] = [];
    vi.spyOn(game, 'startMatch').mockImplementation((seed) => {
      started.push(seed ?? -1);
    });

    menu.open();
    click('Skirmish');
    const input = overlay.querySelector<HTMLInputElement>('.menu-field input');
    expect(input).not.toBeNull();
    input!.value = '4242';
    input!.dispatchEvent(new Event('input'));
    click('Start');

    expect(started).toEqual([4242]);
    expect(calls['stopMatch']).toBe(1);
    expect(menu.isOpen()).toBe(false);
  });

  it('connects with the relay details that were typed', () => {
    const { menu, game } = mount();
    const connects: [string, string][] = [];
    vi.spyOn(game, 'connect').mockImplementation((url, id) => {
      connects.push([url, id]);
    });

    menu.open();
    click('Multiplayer');
    const inputs = overlay.querySelectorAll<HTMLInputElement>('.menu-field input');
    inputs[0]!.value = 'ws://host:9000';
    inputs[0]!.dispatchEvent(new Event('input'));
    inputs[1]!.value = 'arena';
    inputs[1]!.dispatchEvent(new Event('input'));
    click('Connect');

    expect(connects).toEqual([['ws://host:9000', 'arena']]);
  });

  it('keeps what was typed when you leave a screen and come back', () => {
    const { menu } = mount();
    menu.open();
    click('Multiplayer');
    const input = overlay.querySelector<HTMLInputElement>('.menu-field input')!;
    input.value = 'ws://remembered';
    input.dispatchEvent(new Event('input'));

    click('Back');
    click('Multiplayer');
    expect(overlay.querySelector<HTMLInputElement>('.menu-field input')!.value).toBe(
      'ws://remembered',
    );
  });

  it('drives cvars from the settings screen, rather than keeping its own copy', () => {
    const { menu, console } = mount();
    menu.open();
    click('Settings');

    const checkbox = [...overlay.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0];
    expect(checkbox).toBeDefined();
    expect(checkbox!.checked).toBe(console.bool('cl_showstats'));

    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change'));
    expect(console.bool('cl_showstats')).toBe(false);
  });

  it('offers the real overlay layers in its settings dropdown', () => {
    const { menu } = mount();
    menu.open();
    click('Settings');
    const options = [...overlay.querySelectorAll('select option')].map((o) => o.textContent);
    expect(options).toEqual(['off', 'walkable', 'slope']);
  });

  it('swallows keys it does not use, so the game behind it stays still', () => {
    const { menu } = mount();
    menu.open();
    expect(press(menu, 'KeyA')).toBe(true);
    expect(press(menu, 'Digit1')).toBe(true);

    menu.close();
    expect(press(menu, 'KeyA')).toBe(false);
  });

  it('lets modified keys through, so browser shortcuts still work', () => {
    const { menu } = mount();
    menu.open();
    const event = new KeyboardEvent('keydown', { code: 'KeyR', ctrlKey: true, cancelable: true });
    expect(menu.handleKey(event)).toBe(false);
  });

  it('cleans up every listener on dispose', () => {
    const { menu } = mount();
    menu.open();
    menu.dispose();
    expect(overlay.querySelector('.menu')).toBeNull();
  });
});

describe('the console panel', () => {
  function mountConsole(): { view: ReturnType<typeof createConsoleView>; console: GameConsole } {
    const console = createConsole();
    const view = createConsoleView(overlay, console);
    return { view, console };
  }

  function key(
    view: ReturnType<typeof createConsoleView>,
    code: string,
    init: KeyboardEventInit = {},
  ): boolean {
    return view.handleKey(new KeyboardEvent('keydown', { code, cancelable: true, ...init }));
  }

  it('opens and closes on the backquote key', () => {
    const { view } = mountConsole();
    expect(view.isOpen()).toBe(false);

    expect(key(view, 'Backquote')).toBe(true);
    expect(view.isOpen()).toBe(true);

    expect(key(view, 'Backquote')).toBe(true);
    expect(view.isOpen()).toBe(false);
  });

  it('closes on Escape', () => {
    const { view } = mountConsole();
    view.open();
    expect(key(view, 'Escape')).toBe(true);
    expect(view.isOpen()).toBe(false);
  });

  it('claims every key while open, and none while closed', () => {
    // Typing `stop` into the console must not also stop the army.
    const { view } = mountConsole();
    expect(key(view, 'KeyS')).toBe(false);

    view.open();
    expect(key(view, 'KeyS')).toBe(true);
    expect(key(view, 'Digit1')).toBe(true);
  });

  it('runs the line on Enter and clears the input', () => {
    const { view, console } = mountConsole();
    view.open();
    const input = overlay.querySelector<HTMLInputElement>('.console-input')!;
    input.value = 'echo hello';
    key(view, 'Enter');

    expect(input.value).toBe('');
    expect(console.lines.some((l) => l.text === 'hello')).toBe(true);
  });

  it('renders each line with its level', () => {
    const { view, console } = mountConsole();
    view.open();
    console.print('a warning', 'warn');
    console.print('a failure', 'error');

    expect(overlay.querySelector('.console-line.is-warn')?.textContent).toBe('a warning');
    expect(overlay.querySelector('.console-line.is-error')?.textContent).toBe('a failure');
  });

  it('recalls history with the arrow keys', () => {
    const { view, console } = mountConsole();
    view.open();
    console.execute('echo one');
    console.execute('echo two');

    const input = overlay.querySelector<HTMLInputElement>('.console-input')!;
    key(view, 'ArrowUp');
    expect(input.value).toBe('echo two');
    key(view, 'ArrowUp');
    expect(input.value).toBe('echo one');
  });

  it('completes a unique prefix on Tab', () => {
    const { view } = mountConsole();
    view.open();
    const input = overlay.querySelector<HTMLInputElement>('.console-input')!;
    input.value = 'cvarl';
    key(view, 'Tab');
    expect(input.value).toBe('cvarlist ');
  });

  it('lists candidates when Tab cannot narrow further', () => {
    const { view, console } = mountConsole();
    view.open();
    console.cvar({ name: 'r_one', help: '', value: 1 });
    console.cvar({ name: 'r_two', help: '', value: 1 });

    const input = overlay.querySelector<HTMLInputElement>('.console-input')!;
    input.value = 'r_';
    key(view, 'Tab');
    expect(input.value).toBe('r_');
    expect(console.lines.some((l) => l.text.includes('r_one') && l.text.includes('r_two'))).toBe(
      true,
    );
  });

  it('redraws correctly after the scrollback is trimmed', () => {
    // The view appends rather than rebuilding, which is wrong the moment the
    // ring buffer drops lines off the front.
    const { view, console } = mountConsole();
    view.open();
    for (let i = 0; i < 600; i++) console.print(`line ${i}`);

    const rendered = overlay.querySelectorAll('.console-line').length;
    expect(rendered).toBe(console.lines.length);
    expect(overlay.querySelector('.console-line')?.textContent).toBe(console.lines[0]?.text);
  });

  it('removes itself on dispose', () => {
    const { view } = mountConsole();
    view.dispose();
    expect(overlay.querySelector('.console')).toBeNull();
  });
});

describe('choosing a map', () => {
  const MAPS = [
    { slug: 'tournament-tundra', name: 'tournament tundra', width: 269, height: 269 },
    { slug: 'whiteout', name: 'whiteout', width: 419, height: 419 },
  ];

  it('offers nothing to choose when there is no content pack', () => {
    // One map — the built-in fixture — and a dropdown with a single entry in
    // it is worse than no dropdown.
    const { menu } = mount();
    menu.open('skirmish');
    expect(overlay.querySelectorAll('select')).toHaveLength(0);
  });

  it('lists the pack maps, with the loaded one selected', () => {
    const { menu } = mount({ availableMaps: () => MAPS, currentMap: () => 'whiteout' });
    menu.open('skirmish');
    const select = overlay.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      'tournament-tundra',
      'whiteout',
    ]);
    expect(select.value).toBe('whiteout');
  });

  it('starts on the loaded map without reloading it', async () => {
    const loaded: string[] = [];
    const { menu, calls } = mount({
      availableMaps: () => MAPS,
      currentMap: () => 'whiteout',
      loadMap: (slug) => {
        loaded.push(slug);
        return Promise.resolve(true);
      },
    });
    menu.open('skirmish');
    click('Start');
    await Promise.resolve();
    expect(loaded).toEqual([]);
    expect(calls['startMatch']).toBe(1);
  });

  it('loads a different map before starting, not after', async () => {
    const order: string[] = [];
    let finishLoad = (): void => {};
    const { menu } = mount({
      availableMaps: () => MAPS,
      currentMap: () => 'whiteout',
      loadMap: (slug) => {
        order.push(`load ${slug}`);
        return new Promise<boolean>((resolve) => {
          finishLoad = () => resolve(true);
        });
      },
      startMatch: () => {
        order.push('start');
      },
    });
    menu.open('skirmish');

    const select = overlay.querySelector('select') as HTMLSelectElement;
    select.value = 'tournament-tundra';
    select.dispatchEvent(new Event('change'));

    click('Start');
    // The match must not start on the world that is about to be replaced.
    expect(order).toEqual(['load tournament-tundra']);

    finishLoad();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['load tournament-tundra', 'start']);
  });
});
