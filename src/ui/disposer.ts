/**
 * Tracked teardown for DOM-facing code.
 *
 * The editor is mounted and unmounted every time the user toggles modes, so a
 * listener that outlives its panel is a real leak, not a theoretical one.
 * Registering through a Disposer makes the leak testable: `pending` must be
 * zero after dispose.
 */
export class Disposer {
  private readonly teardowns: (() => void)[] = [];

  /** Number of registered teardowns still outstanding. */
  get pending(): number {
    return this.teardowns.length;
  }

  /** addEventListener with automatic removal on dispose. */
  listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    handler: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    handler: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.teardowns.push(() => target.removeEventListener(type, handler, options));
  }

  /** Register an arbitrary teardown (removing a node, stopping a timer). */
  add(teardown: () => void): void {
    this.teardowns.push(teardown);
  }

  /** Append a node and remove it on dispose. */
  mount<T extends Node>(parent: Node, node: T): T {
    parent.appendChild(node);
    this.teardowns.push(() => node.parentNode?.removeChild(node));
    return node;
  }

  dispose(): void {
    // Reverse order, so nodes come out after the listeners attached to them.
    for (let i = this.teardowns.length - 1; i >= 0; i--) {
      this.teardowns[i]?.();
    }
    this.teardowns.length = 0;
  }
}
