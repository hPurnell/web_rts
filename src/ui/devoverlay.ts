/**
 * A small always-on-top readout for frame time and whatever the current
 * milestone needs to see. Rows are registered by key so systems can add lines
 * without this module knowing about them.
 */
export interface DevOverlay {
  set(key: string, value: string): void;
  remove(key: string): void;
  dispose(): void;
}

export function createDevOverlay(parent: HTMLElement): DevOverlay {
  const root = document.createElement('div');
  root.className = 'dev-overlay';
  parent.appendChild(root);

  const rows = new Map<string, HTMLElement>();

  return {
    set(key, value) {
      let row = rows.get(key);
      if (!row) {
        row = document.createElement('div');
        row.className = 'dev-row';
        const label = document.createElement('span');
        label.className = 'dev-key';
        label.textContent = key;
        const val = document.createElement('span');
        val.className = 'dev-value';
        row.append(label, val);
        root.appendChild(row);
        rows.set(key, row);
      }
      const val = row.lastElementChild;
      if (val && val.textContent !== value) val.textContent = value;
    },
    remove(key) {
      rows.get(key)?.remove();
      rows.delete(key);
    },
    dispose() {
      rows.clear();
      root.remove();
    },
  };
}
