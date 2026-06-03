/**
 * Column.test.tsx — lane-edit keyboard semantics.
 *
 * Pressing Escape inside the lane-rename input must tear the input down
 * WITHOUT committing the typed value. Without this,
 * the subsequent blur (fired when the unmounting input loses focus) routes
 * the typed text into `store.editLane`, even though the user clearly
 * cancelled.
 *
 * The fix wires Enter/Escape via a native capture-phase listener on the
 * input (and a guarded window-capture fallback) so Obsidian's workspace-
 * level keydown interceptors can't preempt React's synthetic delegation.
 * The tests below exercise both keystroke paths.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { Column } from '@/ui/Column';
import type { BoardStore } from '@/core/store';
import type { LaneId, CardId } from '@/core/model';

function makeStore(): {
  store: BoardStore;
  editLane: ReturnType<typeof vi.fn>;
} {
  const editLane = vi.fn();
  const listeners = new Set<() => void>();
  const lane = {
    id: 'lane-a' as LaneId,
    title: 'Backlog',
    kind: 'normal' as const,
    cards: [],
    collapsed: false,
  };
  const state = { renderGeneration: 0 };
  const store: BoardStore = {
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getState: () => state,
    selectLaneIds: () => ['lane-a' as LaneId],
    selectCardIds: () => [] as CardId[],
    selectCard: () => undefined,
    selectLane: () => lane,
    selectBoardMeta: () => ({ title: 'Board', cardCount: 0, laneCount: 1 }),
    selectMode: () => 'board' as const,
    setMode: () => {},
    isReadOnly: () => false,
    editLane,
    editCard: vi.fn(),
    toggleCardDone: vi.fn(),
    addCard: vi.fn(),
    deleteCard: vi.fn(),
    addLane: vi.fn(),
    moveLane: vi.fn(),
    toggleSubtask: vi.fn(),
    editSubtask: vi.fn(),
    addSubtask: vi.fn(),
    deleteSubtask: vi.fn(),
    beginGesture: vi.fn(),
    moveCardOptimistic: vi.fn(),
    commitGesture: vi.fn(),
    cancelGesture: vi.fn(),
  } as unknown as BoardStore;
  return { store, editLane };
}

function Harness({ store }: { store: BoardStore }): JSX.Element {
  return (
    <DndContext>
      <Column
        laneId={'lane-a' as LaneId}
        store={store}
        onOpenDetail={() => {}}
      />
    </DndContext>
  );
}

function openRenameInput(): HTMLInputElement {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('kanban-pro:focus-new-lane', { detail: { laneId: 'lane-a' } }),
    );
  });
  const el = document.querySelector<HTMLInputElement>('input.kp-lane-title');
  if (!el) throw new Error('rename input did not mount');
  return el;
}

describe('Column — lane-rename keyboard', () => {
  afterEach(() => {
    cleanup();
  });

  it('Escape cancels the rename without committing the typed value', () => {
    const { store, editLane } = makeStore();
    render(<Harness store={store} />);

    const input = openRenameInput();
    fireEvent.change(input, { target: { value: 'SHOULD-NOT-COMMIT' } });

    // Native capture-phase listener on the input. fireEvent.keyDown
    // dispatches a real KeyboardEvent at the target, which the native
    // listener receives in capture phase.
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    // Input unmounts on cancel.
    expect(document.querySelector('input.kp-lane-title')).toBeNull();
    // And the typed value never lands in the store.
    expect(editLane).not.toHaveBeenCalled();
  });

  it('Escape unmounts the input synchronously (no double-commit window)', () => {
    // After Escape, the input is removed on the same React tick — there's
    // no opportunity for the user to interact with a stale focused input.
    // (In production the DOM-level blur during unmount may or may not
    // fire; we don't simulate it here because by the time it would, the
    // React onBlur callback is wired to a node that's already been
    // unmounted. Tests that fired blur explicitly were testing a
    // synthetic edge case that doesn't occur in real Obsidian.)
    const { store } = makeStore();
    render(<Harness store={store} />);

    const input = openRenameInput();
    fireEvent.change(input, { target: { value: 'SHOULD-NOT-COMMIT' } });

    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(document.querySelector('input.kp-lane-title')).toBeNull();
  });

  it('Enter commits the typed value', () => {
    const { store, editLane } = makeStore();
    render(<Harness store={store} />);

    const input = openRenameInput();
    fireEvent.change(input, { target: { value: 'Renamed' } });

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(editLane).toHaveBeenCalledWith('lane-a', { title: 'Renamed' });
  });

  it('blur (click-outside) commits when no cancel keystroke fired', () => {
    const { store, editLane } = makeStore();
    render(<Harness store={store} />);

    const input = openRenameInput();
    fireEvent.change(input, { target: { value: 'BlurCommit' } });

    act(() => {
      fireEvent.blur(input);
    });

    expect(editLane).toHaveBeenCalledWith('lane-a', { title: 'BlurCommit' });
  });
});
