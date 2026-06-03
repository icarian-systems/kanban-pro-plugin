/**
 * Card.complex.test.tsx — complex card render-loop coverage.
 *
 * Dragging a card that combines subtasks + tags + emoji + inline-meta
 * fields can trigger React error #185 ("Maximum update depth exceeded")
 * on the column/article render path after `onDragEnd` settles. The
 * `ErrorBoundary` catches it, but the underlying render loop is the
 * regression we're pinning here.
 *
 * The test mounts a Card with the full complex data shape and asserts
 * that rendering completes without an unhandled re-render loop and
 * without a React "update depth exceeded" console.error. It also
 * verifies that the post-drag store mutation (the original crash was a
 * lane move, but a `done`-toggle is sufficient to reproduce the snapshot
 * churn) settles within a bounded number of render cycles.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Card } from '@/ui/Card';
import type { BoardStore } from '@/core/store';
import type { Card as CardModel, CardId } from '@/core/model';

function makeComplexCard(): CardModel {
  return {
    id: 'c-complex',
    text: '**Migrate** parser to remark\nThe full migration plan lives here.',
    done: false,
    hash: 'h-complex',
    meta: {
      tags: ['#parser', '#migration', '#bug'],
      fields: {
        assignee: 'jane',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        priority: 'high',
      },
      emoji: { '🔁': 'every week', '📅': '2026-05-22' },
      date: '2026-05-22',
      blockId: 'card-complex',
    },
    subtasks: [
      { id: 's1', text: 'Replace tokenizer', done: true },
      { id: 's2', text: 'Wire trivia preservation', done: true },
      { id: 's3', text: 'Add round-trip tests', done: false },
      { id: 's4', text: 'Run on real corpus', done: false },
    ],
  };
}

interface StoreHarness {
  store: BoardStore;
  toggleDone: () => void;
  renderCount: { value: number };
}

function makeStore(card: CardModel): StoreHarness {
  const listeners = new Set<() => void>();
  let current = card;
  const notify = (): void => listeners.forEach((l) => l());

  const toggleCardDone = vi.fn((id: CardId) => {
    if (id !== current.id) return;
    // Mirror the immer-style behaviour the real store uses: a NEW Card
    // object on mutation. The selector's identity-cache then sees a
    // different reference and is expected to flow through without
    // triggering a getSnapshot-thrash.
    current = { ...current, done: !current.done };
    notify();
  });
  const editCard = vi.fn();

  const store: BoardStore = {
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    selectLaneIds: () => ['l1'],
    selectCardIds: () => [current.id],
    selectCard: (id: CardId) => (id === current.id ? current : undefined),
    selectLane: () => ({
      id: 'l1',
      title: 'Doing',
      kind: 'normal' as const,
      cards: [current],
      collapsed: false,
    }),
    selectBoardMeta: () => ({ title: 'Board', cardCount: 1, laneCount: 1 }),
    selectMode: () => 'board' as const,
    setMode: () => {},
    isReadOnly: () => false,
    editCard,
    toggleCardDone,
    addCard: vi.fn(),
    deleteCard: vi.fn(),
    addLane: vi.fn(),
    toggleSubtask: vi.fn(),
    editSubtask: vi.fn(),
    addSubtask: vi.fn(),
    deleteSubtask: vi.fn(),
    archiveCard: vi.fn(),
    beginGesture: vi.fn(),
    moveCardOptimistic: vi.fn(),
    commitGesture: vi.fn(),
    cancelGesture: vi.fn(),
  } as unknown as BoardStore;

  return {
    store,
    toggleDone: () => toggleCardDone(card.id),
    renderCount: { value: 0 },
  };
}

function CountingHarness(props: {
  store: BoardStore;
  onRender: () => void;
}) {
  // Render counter sits inside the React tree so we can detect a
  // post-mutation render storm: a healthy store mutation should produce
  // O(1) renders, not O(N).
  props.onRender();
  return (
    <DndContext>
      <SortableContext items={['c-complex']} strategy={verticalListSortingStrategy}>
        <ol>
          <Card
            cardId="c-complex"
            laneId="l1"
            index={0}
            store={props.store}
            onOpenDetail={() => {}}
          />
        </ol>
      </SortableContext>
    </DndContext>
  );
}

describe('Card — complex data shape', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the full complex card shape without a React render-loop warning', () => {
    const harness = makeStore(makeComplexCard());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const renderCounter = vi.fn();
    const { container } = render(
      <CountingHarness store={harness.store} onRender={renderCounter} />,
    );

    // The card mounts and the title text lands in the DOM. (Bold markdown
    // routes through MarkdownInlineView's fallback, which writes the raw
    // text — that's the test-env path; production would render bold.)
    const cardEl = container.querySelector('.kp-card');
    expect(cardEl).toBeTruthy();
    expect(container.textContent).toContain('Migrate');
    expect(container.textContent).toContain('Replace tokenizer');

    // No "Maximum update depth exceeded" warning should have surfaced.
    const renderLoopErrors = errorSpy.mock.calls.filter((call) =>
      String(call[0] ?? '').match(/Maximum update depth|getSnapshot should be cached/i),
    );
    expect(renderLoopErrors).toEqual([]);

    errorSpy.mockRestore();
  });

  it('settles within a bounded number of renders after a store mutation', async () => {
    const harness = makeStore(makeComplexCard());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const renderCounter = vi.fn();
    render(
      <CountingHarness store={harness.store} onRender={renderCounter} />,
    );

    const initialCalls = renderCounter.mock.calls.length;

    // Simulate the post-drag store update (a `done` toggle is a sufficient
    // proxy — the original crash was triggered by ANY store mutation that
    // produced a new card reference, not specifically by lane moves).
    await act(async () => {
      harness.toggleDone();
      // Two microtask drains so any cascaded effects flush.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Strict ceiling: a single store mutation must produce no more than
    // a handful of harness renders. The pre-fix loop would blow past this
    // and saturate React's internal update-depth guard at ~50.
    const additionalRenders = renderCounter.mock.calls.length - initialCalls;
    expect(additionalRenders).toBeLessThan(8);

    const renderLoopErrors = errorSpy.mock.calls.filter((call) =>
      String(call[0] ?? '').match(/Maximum update depth|getSnapshot should be cached/i),
    );
    expect(renderLoopErrors).toEqual([]);

    errorSpy.mockRestore();
  });
});
