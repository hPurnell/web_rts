/**
 * Raw pointer and keyboard state for the renderer. Nothing here decides what an
 * input *means* — that is the camera's and the order dispatcher's job — so this
 * stays a plain snapshot that systems poll once per frame.
 */
export interface PointerState {
  /** Position in CSS pixels relative to the canvas. */
  x: number;
  y: number;
  /** True while the pointer is over the canvas. */
  inside: boolean;
  buttons: number;
  /** Accumulated wheel delta since the last frame, consumed by takeWheel(). */
  wheel: number;
}

export interface InputState {
  readonly keys: Set<string>;
  readonly pointer: PointerState;
  /** True when the document has focus; edge-pan is off otherwise. */
  focused: boolean;
  /** Wheel delta accumulated since the last call, then reset. */
  takeWheel(): number;
  /** Pointer movement accumulated since the last call, then reset. */
  takeDrag(): { dx: number; dy: number };
  dispose(): void;
}

export const MOUSE_LEFT = 1;
export const MOUSE_RIGHT = 2;
export const MOUSE_MIDDLE = 4;

export function attachInput(canvas: HTMLCanvasElement): InputState {
  const keys = new Set<string>();
  const pointer: PointerState = { x: 0, y: 0, inside: false, buttons: 0, wheel: 0 };
  let dragX = 0;
  let dragY = 0;

  const state: InputState = {
    keys,
    pointer,
    focused: document.hasFocus(),
    takeWheel() {
      const w = pointer.wheel;
      pointer.wheel = 0;
      return w;
    },
    takeDrag() {
      const d = { dx: dragX, dy: dragY };
      dragX = 0;
      dragY = 0;
      return d;
    },
    dispose() {
      for (const [target, type, handler] of listeners) {
        (target as EventTarget).removeEventListener(type, handler as EventListener);
      }
      listeners.length = 0;
      keys.clear();
    },
  };

  const listeners: [EventTarget, string, EventListener][] = [];
  const on = <T extends Event>(target: EventTarget, type: string, handler: (e: T) => void): void => {
    const wrapped = handler as EventListener;
    target.addEventListener(type, wrapped, { passive: type !== 'wheel' && type !== 'contextmenu' });
    listeners.push([target, type, wrapped]);
  };

  on<KeyboardEvent>(window, 'keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
  });
  on<KeyboardEvent>(window, 'keyup', (e) => keys.delete(e.code));
  // Losing focus mid-keypress otherwise leaves the camera panning forever.
  on(window, 'blur', () => {
    keys.clear();
    pointer.buttons = 0;
    state.focused = false;
  });
  on(window, 'focus', () => {
    state.focused = true;
  });

  const updatePointer = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.inside =
      pointer.x >= 0 && pointer.y >= 0 && pointer.x < rect.width && pointer.y < rect.height;
    pointer.buttons = e.buttons;
  };

  on<PointerEvent>(canvas, 'pointermove', (e) => {
    updatePointer(e);
    dragX += e.movementX;
    dragY += e.movementY;
  });
  on<PointerEvent>(canvas, 'pointerdown', (e) => {
    updatePointer(e);
    canvas.setPointerCapture?.(e.pointerId);
  });
  on<PointerEvent>(canvas, 'pointerup', (e) => {
    updatePointer(e);
    canvas.releasePointerCapture?.(e.pointerId);
  });
  on<PointerEvent>(canvas, 'pointerleave', () => {
    pointer.inside = false;
  });
  on<PointerEvent>(canvas, 'pointerenter', (e) => updatePointer(e));
  on<WheelEvent>(canvas, 'wheel', (e) => {
    e.preventDefault();
    // deltaMode 1 is lines, 2 is pages; normalise to something pixel-ish.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    pointer.wheel += e.deltaY * scale;
  });
  // Right-drag is an in-game order, never a context menu.
  on<MouseEvent>(canvas, 'contextmenu', (e) => e.preventDefault());

  return state;
}
