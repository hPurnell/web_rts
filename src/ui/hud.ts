/**
 * The in-game HUD.
 *
 * A DOM overlay rather than anything drawn in the scene: text, buttons and
 * layout are what the DOM is for, and keeping the HUD out of the renderer
 * means it costs no draw calls and can be restyled without touching Babylon.
 *
 * It reads match state and reports what the player clicked; it never mutates
 * the simulation. Commands go back through the same queue as every other input
 * (invariant 5).
 */
import { Disposer } from './disposer.ts';
import type { Match } from '../sim/match.ts';
import type { UnitHandle } from '../sim/units.ts';
import {
  UnitState,
  isUnderConstruction,
  listProduction,
  resolve,
} from '../sim/units.ts';
import { UNIT_TYPES, unitType } from '../sim/unittypes.ts';
import type { UnitType } from '../sim/unittypes.ts';

/** What a command-card button asks the game to do. */
export type CommandAction =
  | { readonly kind: 'stop' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'attack-move' }
  | { readonly kind: 'gather' }
  | { readonly kind: 'takeoff' }
  | { readonly kind: 'land' }
  | { readonly kind: 'follow' }
  | { readonly kind: 'produce'; readonly typeId: number }
  | { readonly kind: 'build'; readonly typeId: number };

export interface CommandButton {
  readonly id: string;
  readonly label: string;
  readonly hotkey: string;
  readonly action: CommandAction;
  readonly enabled: boolean;
  /** A toggle that is currently on: drawn pressed. */
  readonly active?: boolean;
  readonly cost?: { minerals: number; gas: number };
}

export interface HudContext {
  readonly overlay: HTMLElement;
  readonly localPlayer: number;
  onCommand(action: CommandAction): void;
  /** Move the camera, from a minimap click. */
  onMinimapJump(x: number, z: number): void;
  /** The unit the chase camera is following, if any, so Follow shows pressed. */
  following?(): UnitHandle | null;
}

export interface Hud {
  readonly root: HTMLElement;
  readonly minimapSlot: HTMLElement;
  /** Redraw from current state. Cheap enough to call every frame. */
  update(match: Match | null, selection: readonly UnitHandle[]): void;
  /** Fire the button bound to a key, if any. Returns true if handled. */
  handleKey(key: string): boolean;
  buttons(): readonly CommandButton[];
  /**
   * How many CSS pixels of the bottom of the screen the panel covers, or 0
   * when it is not shown. The chase camera shifts its framing up by this, so
   * the unit it follows is not behind the panel.
   */
  coveredBelow(): number;
  dispose(): void;
}

/**
 * Which buttons a selection offers.
 *
 * Structures show what they can produce; mobile units show the movement verbs,
 * and workers additionally show what they can build. A mixed selection shows
 * the mobile commands, which is what SC2 does and what a player expects when
 * they box-select a base and an army together.
 */
export function commandsFor(
  match: Match,
  selection: readonly UnitHandle[],
  localPlayer: number,
  following: UnitHandle | null = null,
): CommandButton[] {
  const store = match.units;
  const indices = selection
    .map((handle) => resolve(store, handle))
    .filter((index) => index >= 0 && store.ownerId[index] === localPlayer);
  if (indices.length === 0) return [];

  const types = new Set(indices.map((index) => store.typeId[index] as number));
  const mobile = indices.filter((index) => !unitType(store.typeId[index] as number).isStructure);

  if (mobile.length === 0) {
    // A pure structure selection: production.
    const buttons: CommandButton[] = [];
    const hotkeys = 'qwerasdf';
    let slot = 0;
    for (const typeId of types) {
      const structure = unitType(typeId);
      if (isUnderConstruction(store, indices[0] as number)) continue;
      for (const producible of structure.produces) {
        const produced = unitType(producible);
        buttons.push({
          id: `produce-${produced.id}`,
          label: produced.name,
          hotkey: hotkeys[slot++] ?? '',
          action: { kind: 'produce', typeId: producible },
          enabled:
            (match.minerals[localPlayer] as number) >= produced.mineralCost &&
            (match.gas[localPlayer] as number) >= produced.gasCost,
          cost: { minerals: produced.mineralCost, gas: produced.gasCost },
        });
      }
    }
    return buttons;
  }

  const buttons: CommandButton[] = [
    { id: 'stop', label: 'Stop', hotkey: 's', action: { kind: 'stop' }, enabled: true },
    { id: 'hold', label: 'Hold', hotkey: 'h', action: { kind: 'hold' }, enabled: true },
    {
      id: 'attack-move',
      label: 'Attack move',
      hotkey: 'a',
      action: { kind: 'attack-move' },
      enabled: true,
    },
    {
      // Every mobile unit can be followed; a structure has nowhere to go.
      // Pressed while the camera is following one of the selection, so the
      // same key turns it off again.
      id: 'follow',
      label: 'Follow cam',
      hotkey: 'f',
      action: { kind: 'follow' },
      enabled: true,
      active: following !== null && selection.includes(following),
    },
  ];

  // Aircraft get the two orders only they understand. Shown whenever one is
  // selected rather than only when it is grounded or only when it is flying:
  // a mixed flight has some of each, and a button that comes and went would
  // be worse than one that is occasionally a no-op.
  if (mobile.some((index) => unitType(store.typeId[index] as number).isAircraft)) {
    buttons.push(
      { id: 'takeoff', label: 'Take off', hotkey: 't', action: { kind: 'takeoff' }, enabled: true },
      { id: 'land', label: 'Land', hotkey: 'l', action: { kind: 'land' }, enabled: true },
    );
  }

  const canGather = mobile.some((index) => unitType(store.typeId[index] as number).id === 'worker');
  if (canGather) {
    buttons.push({
      id: 'gather',
      label: 'Gather',
      hotkey: 'g',
      action: { kind: 'gather' },
      enabled: true,
    });
    const buildHotkeys = 'bvcx';
    let slot = 0;
    for (const type of UNIT_TYPES) {
      if (!type.isStructure) continue;
      buttons.push({
        id: `build-${type.id}`,
        // Just the name: the grid cell is not wide enough for "Build Supply
        // depot", and a truncated label tells the player nothing.
        label: type.name,
        hotkey: buildHotkeys[slot++] ?? '',
        action: { kind: 'build', typeId: type.typeId },
        enabled: (match.minerals[localPlayer] as number) >= type.mineralCost,
        cost: { minerals: type.mineralCost, gas: type.gasCost },
      });
    }
  }

  return buttons;
}

export function createHud(context: HudContext): Hud {
  const disposer = new Disposer();
  const root = document.createElement('div');
  root.className = 'hud';
  disposer.mount(context.overlay, root);

  // --- resources ----------------------------------------------------------
  const resources = document.createElement('div');
  resources.className = 'hud-resources';
  const mineralsValue = labelled(resources, 'minerals');
  const gasValue = labelled(resources, 'gas');
  const supplyValue = labelled(resources, 'units');
  root.appendChild(resources);

  // --- bottom bar ---------------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'hud-bar';
  root.appendChild(bar);

  const minimapSlot = document.createElement('div');
  minimapSlot.className = 'hud-minimap';
  bar.appendChild(minimapSlot);

  const selectionPanel = document.createElement('div');
  selectionPanel.className = 'hud-selection';
  bar.appendChild(selectionPanel);

  const cardPanel = document.createElement('div');
  cardPanel.className = 'hud-card';
  bar.appendChild(cardPanel);

  let current: CommandButton[] = [];
  const buttonElements = new Map<string, HTMLButtonElement>();

  const renderCard = (buttons: CommandButton[]): void => {
    const signature = buttons.map((b) => `${b.id}:${b.enabled ? 1 : 0}${b.active ? 1 : 0}`).join('|');
    if (signature === cardPanel.dataset['signature']) return;
    cardPanel.dataset['signature'] = signature;
    cardPanel.innerHTML = '';
    buttonElements.clear();

    for (const button of buttons) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'hud-button';
      element.disabled = !button.enabled;
      // Only a toggle says whether it is pressed; a plain command saying
      // "not pressed" would be read out as a toggle that is off.
      if (button.active !== undefined) {
        element.setAttribute('aria-pressed', button.active ? 'true' : 'false');
        if (button.active) element.classList.add('is-active');
      }
      element.innerHTML =
        `<span class="hud-key">${button.hotkey.toUpperCase()}</span>` +
        `<span class="hud-label">${button.label}</span>` +
        (button.cost
          ? `<span class="hud-cost">${button.cost.minerals}${button.cost.gas > 0 ? ` / ${button.cost.gas}` : ''}</span>`
          : '');
      element.addEventListener('click', () => context.onCommand(button.action));
      cardPanel.appendChild(element);
      buttonElements.set(button.hotkey, element);
    }
  };

  return {
    root,
    minimapSlot,
    buttons: () => current,

    update(match, selection) {
      if (!match) {
        root.classList.add('is-idle');
        current = [];
        renderCard([]);
        selectionPanel.textContent = '';
        return;
      }
      root.classList.remove('is-idle');

      mineralsValue.textContent = String(match.minerals[context.localPlayer] ?? 0);
      gasValue.textContent = String(match.gas[context.localPlayer] ?? 0);

      let owned = 0;
      for (let i = 0; i < match.units.count; i++) {
        if (match.units.isAlive[i] !== 1) continue;
        if (match.units.ownerId[i] === context.localPlayer) owned++;
      }
      supplyValue.textContent = String(owned);

      renderSelection(match, selection, context.localPlayer, selectionPanel);
      current = commandsFor(match, selection, context.localPlayer, context.following?.() ?? null);
      renderCard(current);
    },

    coveredBelow() {
      if (root.classList.contains('is-idle')) return 0;
      const panel = bar.getBoundingClientRect();
      if (panel.height === 0) return 0;
      return Math.max(0, root.getBoundingClientRect().bottom - panel.top);
    },

    handleKey(key) {
      const element = buttonElements.get(key.toLowerCase());
      if (!element || element.disabled) return false;
      element.click();
      return true;
    },

    dispose() {
      buttonElements.clear();
      disposer.dispose();
    },
  };
}

function labelled(parent: HTMLElement, name: string): HTMLElement {
  const row = document.createElement('span');
  row.className = 'hud-resource';
  const label = document.createElement('span');
  label.className = 'hud-resource-label';
  label.textContent = name;
  const value = document.createElement('span');
  value.className = 'hud-resource-value';
  value.textContent = '0';
  row.append(label, value);
  parent.appendChild(row);
  return value;
}

/** Group the selection by type and show counts, plus any production queue. */
function renderSelection(
  match: Match,
  selection: readonly UnitHandle[],
  localPlayer: number,
  panel: HTMLElement,
): void {
  const store = match.units;
  const counts = new Map<number, number>();
  let queueOwner = -1;

  for (const handle of selection) {
    const index = resolve(store, handle);
    if (index < 0) continue;
    const typeId = store.typeId[index] as number;
    counts.set(typeId, (counts.get(typeId) ?? 0) + 1);
    if (queueOwner < 0 && store.ownerId[index] === localPlayer) {
      if (unitType(typeId).produces.length > 0) queueOwner = index;
    }
  }

  const parts: string[] = [];
  for (const [typeId, count] of counts) {
    const type = unitType(typeId);
    parts.push(
      `<span class="hud-portrait"><span class="hud-portrait-name">${type.name}</span>` +
        `<span class="hud-portrait-count">${count}</span></span>`,
    );
  }

  if (queueOwner >= 0) {
    if (isUnderConstruction(store, queueOwner)) {
      parts.push(`<span class="hud-queue">building…</span>`);
    } else {
      const queue = listProduction(store, queueOwner)
        .map((typeId) => unitType(typeId).name)
        .join(', ');
      if (queue) parts.push(`<span class="hud-queue">producing: ${queue}</span>`);
    }
  }

  if (parts.length === 0) parts.push('<span class="hud-hint">nothing selected</span>');
  const html = parts.join('');
  if (panel.innerHTML !== html) panel.innerHTML = html;
}

/** Unit types a worker can build, for the build palette. */
export function buildableTypes(): UnitType[] {
  return UNIT_TYPES.filter((type) => type.isStructure);
}

/** True when a unit is doing something worth showing as busy. */
export function isBusy(match: Match, index: number): boolean {
  return match.units.state[index] !== UnitState.Idle;
}
