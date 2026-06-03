/**
 * Gesture-scoped undo/redo stack.
 *
 * The architectural decision: undo entries are per-GESTURE, not per-
 * mutation. A drag emits many `moveCard` calls (one per pointer move
 * frame) but only ONE undo entry — the one snapshotted on
 * `commitGesture()`. A gesture that is cancelled (`cancelGesture()`) does
 * not produce an undo entry at all.
 *
 * Outside of an explicit gesture, callers can use `commitGesture(snapshot)`
 * directly (no preceding `beginGesture()`) for atomic edits like
 * inline-text commit.
 *
 * The stack holds the last N (default 50) snapshots. Memory is bounded by
 * snapshot size — Board is reasonably small (~KB) at typical card counts.
 */
import type { Board } from '@/core/model';

export interface UndoStackOptions {
  /** Maximum entries kept in past/future combined per side. Default 50. */
  capacity?: number;
}

export interface UndoStack {
  beginGesture: () => void;
  /** Commit a snapshot to the undo stack. Closes any open gesture. */
  commitGesture: (snapshot: Board) => void;
  /** Discard the open gesture without pushing a snapshot. */
  cancelGesture: () => void;
  /** Pop the top of the past stack and return the previous board state.
   *  Pushes the CURRENT snapshot onto the future stack. */
  undo: (current: Board) => Board | null;
  /** Replay a future entry. */
  redo: (current: Board) => Board | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}

export function createUndoStack(opts: UndoStackOptions = {}): UndoStack {
  const capacity = opts.capacity ?? 50;
  const past: Board[] = [];
  const future: Board[] = [];
  let gestureOpen = false;

  const trim = (arr: Board[]) => {
    while (arr.length > capacity) arr.shift();
  };

  return {
    beginGesture(): void {
      gestureOpen = true;
    },

    commitGesture(snapshot: Board): void {
      past.push(snapshot);
      trim(past);
      // Any commit invalidates the redo branch (standard editor semantics).
      future.length = 0;
      gestureOpen = false;
    },

    cancelGesture(): void {
      gestureOpen = false;
    },

    undo(current: Board): Board | null {
      if (past.length === 0) return null;
      const prev = past.pop()!;
      future.push(current);
      trim(future);
      return prev;
    },

    redo(current: Board): Board | null {
      if (future.length === 0) return null;
      const next = future.pop()!;
      past.push(current);
      trim(past);
      return next;
    },

    canUndo(): boolean {
      return past.length > 0;
    },

    canRedo(): boolean {
      return future.length > 0;
    },

    clear(): void {
      past.length = 0;
      future.length = 0;
      gestureOpen = false;
    },
  };
}
