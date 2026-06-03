/**
 * BoardView.add-lane.test.tsx — coverage for the "+ Add lane" UX.
 *
 * Four sub-cases:
 *
 *   1. The trailing-column "+ Add lane" button is visible and a11y-labelled.
 *   2. After clicking "+ Add lane", pressing Escape inside the new lane's
 *      title input deletes the uncommitted placeholder lane.
 *   3. Empty-title lanes are excluded from `selectBoardMeta().laneCount`.
 *   4. The Column title-input's blur handler does NOT commit when the
 *      input is empty AND `titleCancelledRef.current === true` (Escape
 *      sets the flag).
 *
 * Tests mount the real store + DnD provider so the focus-new-lane event
 * round-trips through the same wiring production uses.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { BoardView } from '@/ui/BoardView';
import { createBoardStore } from '@/core/store';
import { DnDProvider } from '@/ui/DnDProvider';
import type { Board, Lane } from '@/core/model';

function makeBoard(lanes: Lane[]): Board {
  return {
    lanes,
    frontmatter: { 'kanban-plugin': 'board' },
    settings: { 'kanban-plugin': 'board' },
    fileTrivia: {
      bom: false,
      newline: '\n',
      trailingNewline: true,
      originalSource: '',
    },
    hash: '',
  };
}

function lane(id: string, title: string): Lane {
  return { id, title, kind: 'normal', cards: [], collapsed: false };
}

function Harness({
  board,
}: {
  board: Board;
}): React.ReactElement {
  const storeRef = React.useRef(createBoardStore({ initialBoard: board }));
  return (
    <DnDProvider store={storeRef.current}>
      <BoardView
        store={storeRef.current}
        onOpenDetail={() => {}}
      />
    </DnDProvider>
  );
}

describe('BoardView — add-lane UX', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('"+ Add lane" button is visible with an Add lane aria-label', () => {
    const board = makeBoard([lane('l1', 'Backlog')]);
    const { container, getByLabelText } = render(<Harness board={board} />);
    const btn = container.querySelector('.kp-add-lane') as HTMLElement;
    expect(btn).toBeTruthy();
    // Visible text content includes "Add lane" for sighted users.
    expect(btn.textContent ?? '').toMatch(/Add lane/);
    // Aria-label exists for screen readers.
    expect(getByLabelText('Add lane')).toBeTruthy();
  });

  it('Escape inside a freshly-added lane title input deletes the placeholder', () => {
    const board = makeBoard([lane('l1', 'Backlog')]);
    const { container, getByLabelText } = render(<Harness board={board} />);

    // Sanity: only the seeded lane is on screen.
    expect(container.querySelectorAll('.kp-lane').length).toBe(1);

    // Click "+ Add lane". This calls store.addLane() then schedules the
    // focus-new-lane broadcast via setTimeout(…, 0).
    fireEvent.click(getByLabelText('Add lane'));
    act(() => {
      vi.advanceTimersByTime(1);
    });

    // The new lane is in the DOM and is in edit mode (title input visible).
    expect(container.querySelectorAll('.kp-lane').length).toBe(2);
    const input = container.querySelector('input.kp-lane-title') as HTMLInputElement;
    expect(input).toBeTruthy();

    // Escape → titleCancelledRef = true, edit mode exits, the placeholder
    // is deleted by the cancellation branch in commitTitle.
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
      // jsdom synthesises a blur as the input is removed, which would
      // otherwise re-enter commitTitle — but the cancellation flag makes
      // the second pass a no-op (the lane is already deleted on the first).
      vi.advanceTimersByTime(1);
    });

    // Placeholder is gone — back to a single lane.
    expect(container.querySelectorAll('.kp-lane').length).toBe(1);
  });

  it('selectBoardMeta excludes empty-title lanes from the visible count', () => {
    // Build a board where one of three lanes has an empty title (the QA
    // failure mode: an in-progress "+ Add lane" placeholder).
    const board = makeBoard([
      lane('l1', 'Backlog'),
      lane('l2', ''), // placeholder
      lane('l3', 'Done'),
    ]);
    const store = createBoardStore({ initialBoard: board });
    const meta = store.selectBoardMeta();
    // 3 lanes exist in the model; 2 are visible (have titles).
    expect(meta.laneCount).toBe(2);
  });

  it('blur on an empty title with the cancel flag set does NOT commit a write', () => {
    const board = makeBoard([lane('l1', 'Backlog')]);
    const { container, getByLabelText } = render(<Harness board={board} />);

    // Open the rename flow on the existing lane (via dblclick — bypasses
    // the placeholder semantics so we isolate the blur+cancel behaviour).
    const title = container.querySelector('h2.kp-lane-title') as HTMLElement;
    fireEvent.doubleClick(title);

    const input = container.querySelector('input.kp-lane-title') as HTMLInputElement;
    expect(input).toBeTruthy();

    // User types nothing — value stays at the default ('Backlog'). Press
    // Escape: cancel flag flips, edit mode exits. The unmount-triggered
    // blur should NOT re-rename and should NOT delete the lane (existing
    // lane, not a placeholder).
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
      vi.advanceTimersByTime(1);
    });

    // Lane still exists with its original title.
    expect(container.querySelectorAll('.kp-lane').length).toBe(1);
    const titleAfter = container.querySelector('h2.kp-lane-title');
    expect(titleAfter?.textContent).toBe('Backlog');

    // Sanity — the +Add lane affordance is still in place.
    expect(getByLabelText('Add lane')).toBeTruthy();
  });
});
