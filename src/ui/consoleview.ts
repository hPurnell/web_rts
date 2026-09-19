/**
 * The console's drop-down panel.
 *
 * Half-Life rather than Quake in one respect: it slides over the top of the
 * screen without pausing anything behind it, so you can watch a cvar take
 * effect while you are still holding the key that set it.
 *
 * All the interesting behaviour lives in `console.ts`. This file is input
 * routing and text nodes, which is why it is the part with no tests worth
 * writing beyond "it renders and Escape closes it".
 */
import { Disposer } from './disposer.ts';
import type { ConsoleLine, GameConsole, LineLevel } from './console.ts';

/** The key that opens it. Backquote on every layout this cares about. */
export const CONSOLE_KEY = 'Backquote';

export interface ConsoleView {
  readonly root: HTMLElement;
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /**
   * Offer a keydown to the console.
   *
   * Returns true if the console consumed it, which the caller must respect:
   * typing `spawn` into the console should not also build a Starport.
   */
  handleKey(event: KeyboardEvent): boolean;
  dispose(): void;
}

export interface ConsoleViewOptions {
  /** Called whenever the panel opens or closes, so the shell can react. */
  onVisibility?(open: boolean): void;
}

export function createConsoleView(
  parent: HTMLElement,
  console: GameConsole,
  options: ConsoleViewOptions = {},
): ConsoleView {
  const disposer = new Disposer();

  const root = document.createElement('div');
  root.className = 'console';
  root.setAttribute('role', 'log');
  root.hidden = true;

  const output = document.createElement('div');
  output.className = 'console-output';

  const inputRow = document.createElement('div');
  inputRow.className = 'console-input-row';

  const prompt = document.createElement('span');
  prompt.className = 'console-prompt';
  prompt.textContent = ']';

  const input = document.createElement('input');
  input.className = 'console-input';
  input.type = 'text';
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'console');

  inputRow.append(prompt, input);
  root.append(output, inputRow);
  parent.appendChild(root);

  let open = false;
  /**
   * The console's total-printed count at the last draw.
   *
   * Comparing rendered node count against `lines.length` looks equivalent and
   * is not: a full scrollback trims one line for every one it gains, so the
   * length sits at its cap while the contents turn over entirely, and an
   * append-only redraw quietly stops updating. The monotonic counter is what
   * makes "what is new" answerable at all.
   */
  let lastTotal = 0;

  const levelClass: Record<LineLevel, string> = {
    echo: 'console-line is-echo',
    info: 'console-line',
    warn: 'console-line is-warn',
    error: 'console-line is-error',
  };

  const append = (line: ConsoleLine): void => {
    const element = document.createElement('div');
    element.className = levelClass[line.level];
    element.textContent = line.text;
    output.appendChild(element);
  };

  const draw = (): void => {
    const lines = console.lines;
    const added = console.totalPrinted - lastTotal;
    lastTotal = console.totalPrinted;

    if (added <= 0 || added >= lines.length) {
      // Either a clear, or so much arrived at once that nothing on screen
      // survived the trim. Either way, start again.
      output.textContent = '';
      for (const line of lines) append(line);
    } else {
      for (const line of lines.slice(lines.length - added)) append(line);
      // Drop from the front whatever the scrollback dropped, so the DOM and
      // the buffer hold the same lines rather than merely the same number.
      while (output.childElementCount > lines.length) output.firstElementChild?.remove();
    }

    output.scrollTop = output.scrollHeight;
  };

  disposer.add(console.onChange(draw));
  draw();

  const view: ConsoleView = {
    root,
    isOpen: () => open,

    open() {
      if (open) return;
      open = true;
      root.hidden = false;
      // Focus on the next frame: the keypress that opened it is still in
      // flight, and focusing now would type a backquote into the input.
      requestAnimationFrame(() => input.focus());
      draw();
      options.onVisibility?.(true);
    },

    close() {
      if (!open) return;
      open = false;
      root.hidden = true;
      input.blur();
      options.onVisibility?.(false);
    },

    toggle() {
      if (open) view.close();
      else view.open();
    },

    handleKey(event) {
      if (event.code === CONSOLE_KEY && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        view.toggle();
        return true;
      }
      if (!open) return false;

      if (event.code === 'Escape') {
        event.preventDefault();
        view.close();
        return true;
      }

      if (event.code === 'Enter' || event.code === 'NumpadEnter') {
        event.preventDefault();
        const line = input.value.trim();
        input.value = '';
        console.resetRecall();
        if (line.length > 0) console.execute(line);
        return true;
      }

      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault();
        input.value = console.recall(event.code === 'ArrowUp' ? -1 : 1);
        // Put the caret at the end, where you want it when recalling a line.
        requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
        return true;
      }

      if (event.code === 'Tab') {
        event.preventDefault();
        complete();
        return true;
      }

      if (event.code === 'PageUp' || event.code === 'PageDown') {
        event.preventDefault();
        output.scrollTop += (event.code === 'PageUp' ? -1 : 1) * output.clientHeight * 0.8;
        return true;
      }

      // Any other key while open belongs to the input, and must not reach the
      // game: `stop` typed into the console should not also stop the army.
      return true;
    },

    dispose() {
      disposer.dispose();
      root.remove();
    },
  };

  /**
   * Tab completion, Quake's way round: complete to the longest shared prefix,
   * and only list candidates when that adds nothing.
   */
  function complete(): void {
    // Only the first word completes; arguments are the command's business.
    const text = input.value;
    const space = text.indexOf(' ');
    if (space >= 0) return;

    const { matches, common } = console.complete(text);
    if (matches.length === 0) return;
    if (matches.length === 1) {
      input.value = `${matches[0] as string} `;
      return;
    }
    if (common.length > text.length) {
      input.value = common;
      return;
    }
    console.print(matches.join('  '));
  }

  return view;
}
