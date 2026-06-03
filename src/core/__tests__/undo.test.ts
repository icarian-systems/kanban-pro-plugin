/**
 * Redo support.
 *
 * The `createUndoStack` factory already retained a future stack; what
 * was missing pre-fix was the `Cmd+Shift+Z` wiring in main.ts +
 * `KanbanView.redo()`. These tests pin the stack-level invariants so
 * the command-palette wiring has a stable contract.
 */
import { describe, it, expect } from 'vitest';
import { createUndoStack } from '@/core/undo';
import type { Board } from '@/core/model';

function makeBoard(label: string): Board {
  return {
    lanes: [],
    frontmatter: { 'kanban-plugin': 'board' },
    settings: {},
    fileTrivia: {
      bom: false,
      newline: '\n',
      trailingNewline: true,
      originalSource: label,
    },
    hash: label,
  };
}

describe('undo stack — redo round trip', () => {
  it('undo → redo → undo → redo preserves state', () => {
    const stack = createUndoStack();
    const A = makeBoard('A');
    const B = makeBoard('B');
    const C = makeBoard('C');

    // Build: snapshot A (gesture commit), then move state to B and snapshot it
    // (gesture commit while in state B), then move to C.
    stack.commitGesture(A);
    stack.commitGesture(B);
    // current state is now conceptually C

    // canUndo true; first undo pops B (the snapshot taken when leaving B) and
    // pushes C onto future.
    expect(stack.canUndo()).toBe(true);
    const u1 = stack.undo(C);
    expect(u1).toEqual(B);

    // canUndo still true (A remains), canRedo true.
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(true);

    // Second undo pops A.
    const u2 = stack.undo(B);
    expect(u2).toEqual(A);
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(true);

    // Redo restores B (pushed onto future as we undid out of it).
    const r1 = stack.redo(A);
    expect(r1).toEqual(B);

    // Redo again restores C.
    const r2 = stack.redo(B);
    expect(r2).toEqual(C);
    expect(stack.canRedo()).toBe(false);

    // Final undo pops B from the past again.
    const u3 = stack.undo(C);
    expect(u3).toEqual(B);
    // Final redo back to C.
    const r3 = stack.redo(B);
    expect(r3).toEqual(C);
  });

  it('a fresh gesture commit clears the redo stack', () => {
    const stack = createUndoStack();
    const A = makeBoard('A');
    const B = makeBoard('B');
    const C = makeBoard('C');

    stack.commitGesture(A);
    // undo to push something into the redo stack
    expect(stack.undo(B)).toEqual(A);
    expect(stack.canRedo()).toBe(true);

    // A new gesture commit must invalidate the redo branch.
    stack.commitGesture(C);
    expect(stack.canRedo()).toBe(false);
  });

  it('canRedo false when stack is empty', () => {
    const stack = createUndoStack();
    expect(stack.canRedo()).toBe(false);
    expect(stack.redo(makeBoard('X'))).toBeNull();
  });
});
