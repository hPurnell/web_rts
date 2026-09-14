/**
 * Undo/redo history.
 *
 * Strokes are explicit: a brush drag opens a stroke, every sampled cell is
 * pushed into it, and closing the stroke leaves exactly one undo entry. Without
 * that, a four-hundred-sample drag would take four hundred presses of Ctrl+Z.
 */
import type { EditorCommand } from './commands.ts';
import type { World } from '../sim/world.ts';

export const DEFAULT_HISTORY_LIMIT = 256;

export interface HistoryEvent {
  readonly type: 'apply' | 'undo' | 'redo' | 'clear';
  readonly command: EditorCommand | null;
}

export class EditorHistory {
  private readonly undoStack: EditorCommand[] = [];
  private readonly redoStack: EditorCommand[] = [];
  private strokeKey: string | null = null;
  private strokeCommand: EditorCommand | null = null;

  constructor(
    private readonly world: World,
    private readonly limit = DEFAULT_HISTORY_LIMIT,
    private readonly onChange?: (event: HistoryEvent) => void,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /** Commands pushed while a stroke is open coalesce into one undo entry. */
  beginStroke(key: string): void {
    this.strokeKey = key;
    this.strokeCommand = null;
  }

  endStroke(): void {
    // A stroke that never changed anything leaves no history behind.
    if (this.strokeCommand?.isEmpty()) {
      const index = this.undoStack.lastIndexOf(this.strokeCommand);
      if (index >= 0) this.undoStack.splice(index, 1);
    }
    this.strokeKey = null;
    this.strokeCommand = null;
  }

  /** Apply a command and record it. Returns false if it changed nothing. */
  push(command: EditorCommand): boolean {
    if (command.isEmpty() && this.strokeCommand === null) return false;

    command.apply(this.world);

    if (
      this.strokeKey !== null &&
      this.strokeCommand !== null &&
      command.coalesceKey === this.strokeKey &&
      this.strokeCommand.merge(command)
    ) {
      this.onChange?.({ type: 'apply', command: this.strokeCommand });
      return true;
    }

    this.undoStack.push(command);
    this.redoStack.length = 0;
    if (this.strokeKey !== null && command.coalesceKey === this.strokeKey) {
      this.strokeCommand = command;
    }
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    this.onChange?.({ type: 'apply', command });
    return true;
  }

  undo(): EditorCommand | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    command.invert(this.world);
    this.redoStack.push(command);
    this.onChange?.({ type: 'undo', command });
    return command;
  }

  redo(): EditorCommand | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    command.apply(this.world);
    this.undoStack.push(command);
    this.onChange?.({ type: 'redo', command });
    return command;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.strokeKey = null;
    this.strokeCommand = null;
    this.onChange?.({ type: 'clear', command: null });
  }
}
