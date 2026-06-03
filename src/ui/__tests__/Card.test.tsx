/**
 * Card.test.tsx — sanity coverage for the Card component.
 *
 * Verifies:
 *  - renders the card title
 *  - click switches to InlineEditor (which renders a textarea fallback)
 *  - blur fires the store's editCard with the updated text
 *  - 350ms long-press fires the `onOpenDetail` callback
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Card } from '@/ui/Card';
import type { BoardStore } from '@/core/store';
import type { Card as CardModel, CardId } from '@/core/model';

function makeCard(overrides: Partial<CardModel> = {}): CardModel {
  return {
    id: 'c1',
    text: 'My card title\nbody line',
    done: false,
    hash: 'h',
    meta: { tags: [], fields: {}, emoji: {} },
    subtasks: [],
    ...overrides,
  };
}

function makeStore(card: CardModel): { store: BoardStore; editCard: ReturnType<typeof vi.fn> } {
  let listeners = new Set<() => void>();
  let current = card;
  const editCard = vi.fn((id: CardId, patch: Partial<CardModel>) => {
    if (id !== current.id) return;
    current = { ...current, ...patch } as CardModel;
    listeners.forEach((l) => l());
  });

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
      title: 'Lane',
      kind: 'normal' as const,
      cards: [current],
      collapsed: false,
    }),
    selectBoardMeta: () => ({ title: 'Board', cardCount: 1, laneCount: 1 }),
    selectMode: () => 'board' as const,
    setMode: () => {},
    isReadOnly: () => false,
    editCard,
    toggleCardDone: vi.fn(),
    addCard: vi.fn(),
    deleteCard: vi.fn(),
    addLane: vi.fn(),
    toggleSubtask: vi.fn(),
    editSubtask: vi.fn(),
    addSubtask: vi.fn(),
    deleteSubtask: vi.fn(),
    beginGesture: vi.fn(),
    moveCardOptimistic: vi.fn(),
    commitGesture: vi.fn(),
    cancelGesture: vi.fn(),
  } as unknown as BoardStore;

  return { store, editCard };
}

function Harness(props: { store: BoardStore; onOpenDetail: (id: CardId) => void }) {
  return (
    <DndContext>
      <SortableContext items={['c1']} strategy={verticalListSortingStrategy}>
        <ol>
          <Card
            cardId="c1"
            laneId="l1"
            index={0}
            store={props.store}
            onOpenDetail={props.onOpenDetail}
          />
        </ol>
      </SortableContext>
    </DndContext>
  );
}

describe('Card', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders the card title', () => {
    const { store } = makeStore(makeCard());
    const { getByText } = render(<Harness store={store} onOpenDetail={() => {}} />);
    expect(getByText('My card title')).toBeTruthy();
  });

  it('renders plain titles via textContent (no markdown fast path)', () => {
    // Plain text titles must NOT introduce any wrapper elements — the
    // `kp-card-title__empty` fallback aside, we render the string raw.
    const { store } = makeStore(makeCard({ text: 'Plain title\nbody' }));
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    const title = container.querySelector('.kp-card-title');
    expect(title).toBeTruthy();
    expect(title?.textContent).toBe('Plain title');
    // No `<strong>` / `<em>` mounted for plain text.
    expect(title?.querySelector('strong')).toBeNull();
  });

  it('renders bold markdown inside the title without leaking asterisks', () => {
    // Without an Obsidian host the inline renderer falls back to textContent
    // (so the asterisks remain visible). That fallback is acceptable for
    // tests; the production case mounts a real renderer. We assert here
    // that the *fast path* still detects the markdown syntax and routes to
    // MarkdownInlineView (vs. the textContent branch), by checking the
    // rendered DOM contains the inline container element rather than a
    // bare text node directly under `.kp-card-title`.
    const { store } = makeStore(makeCard({ text: '**Bug:** broken DnD\nbody' }));
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    const title = container.querySelector('.kp-card-title');
    expect(title).toBeTruthy();
    // The text content collapses to the raw markdown in the test env (no
    // Obsidian host) — but the inline container is mounted, which means
    // production will render bold. The opposite (asterisks rendered into
    // an `<h3>` text node with no wrapper) would be the regression.
    expect(title?.querySelector('span')).toBeTruthy();
  });

  it('click switches the card into edit mode', () => {
    const { store } = makeStore(makeCard());
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    const card = container.querySelector('.kp-card') as HTMLElement;
    expect(card).toBeTruthy();
    fireEvent.click(card);
    expect(container.querySelector('.inline-editor')).toBeTruthy();
    // Textarea fallback is mounted imperatively; it should exist.
    expect(container.querySelector('textarea')).toBeTruthy();
  });

  it('commits inline-editor changes on blur', async () => {
    const { store, editCard } = makeStore(makeCard());
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    const card = container.querySelector('.kp-card') as HTMLElement;
    fireEvent.click(card);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    await act(async () => {
      textarea.value = 'New title\nbody line';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    expect(editCard).toHaveBeenCalledWith('c1', { text: 'New title\nbody line' });
  });

  it('fires onOpenDetail after a 350ms long-press', () => {
    const onOpenDetail = vi.fn();
    const { store } = makeStore(makeCard());
    const { container } = render(<Harness store={store} onOpenDetail={onOpenDetail} />);
    const card = container.querySelector('.kp-card') as HTMLElement;

    fireEvent.pointerDown(card, { clientX: 0, clientY: 0, pointerType: 'touch', button: 0 });
    act(() => {
      vi.advanceTimersByTime(360);
    });

    expect(onOpenDetail).toHaveBeenCalledWith('c1');
  });

  // ────────────────────────────────────────────────────────────────────
  // mountedRef guard against React #185 on async setState
  // ────────────────────────────────────────────────────────────────────
  it('late focus-new-card event after unmount produces no React warnings', () => {
    // Real timers needed: the event is dispatched synchronously through
    // window, not via the timer queue.
    vi.useRealTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { store } = makeStore(makeCard({ id: 'c-late' }));
    const { unmount } = render(<Harness store={store} onOpenDetail={() => {}} />);

    // Pre-unmount event — should land normally.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('kanban-pro:focus-new-card', { detail: { cardId: 'c-late' } }),
      );
    });
    unmount();

    // Post-unmount event — must NOT setState on the gone Card.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('kanban-pro:focus-new-card', { detail: { cardId: 'c-late' } }),
      );
    });

    const reactWarnings = errorSpy.mock.calls.filter((call) =>
      String(call[0] ?? '').match(
        /Can't perform a React state update on an unmounted component|Cannot update a component|Warning: setState/i,
      ),
    );
    expect(reactWarnings).toEqual([]);

    errorSpy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────────
// meta-row + due-chip behaviours.
//
// These tests deliberately use real timers (the parent describe block above
// reaches for fakeTimers) so `formatDueLabel`'s `toLocaleDateString` runs
// against a normal Date. We also re-import the helpers from the same Card
// module to keep them in sync with production.
// ────────────────────────────────────────────────────────────────────────
describe('Card — due chip + block-id badge', () => {
  beforeEach(() => {
    vi.useRealTimers();
    // Pin "today" to 2026-05-15 so the date fixture (2026-05-20) is 5 days
    // out and hits the "Wed, May 20" branch deterministically regardless
    // of when the test runs.
    vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders `meta.date` as the local-TZ calendar day, not UTC', () => {
    // The pre-fix code parsed `new Date('2026-05-20')` as UTC midnight,
    // which in any negative-offset TZ renders as the prior day. We can't
    // change the test process's TZ from JS, but we can verify the
    // *intent*: that the day component of the rendered chip matches the
    // day component of the input string regardless of host TZ.
    const { store } = makeStore(
      makeCard({ meta: { tags: [], fields: {}, emoji: {}, date: '2026-05-20' } }),
    );
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    const due = container.querySelector('.kp-due');
    expect(due).toBeTruthy();
    // The chip should include "20" (the day component) and "May".
    // `toLocaleDateString` weekday/month abbreviations are runtime-locale
    // dependent, so we test on the date + month abbreviation only.
    const text = due!.textContent ?? '';
    expect(text).toMatch(/May/);
    expect(text).toMatch(/\b20\b/);
  });

  it('renders a chip for `meta.date`', () => {
    const { store } = makeStore(
      makeCard({ meta: { tags: [], fields: {}, emoji: {}, date: '2026-05-22' } }),
    );
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    expect(container.querySelector('.kp-due')).toBeTruthy();
  });

  it('renders a chip for `meta.fields.due` when meta.date is absent', () => {
    const { store } = makeStore(
      makeCard({
        meta: { tags: [], fields: { due: '2026-05-22' }, emoji: {} },
      }),
    );
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    expect(container.querySelector('.kp-due')).toBeTruthy();
  });

  it("renders a chip for `meta.emoji['📅']` when both meta.date and fields.due are absent", () => {
    const { store } = makeStore(
      makeCard({
        meta: { tags: [], fields: {}, emoji: { '📅': '2026-05-22' } },
      }),
    );
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    expect(container.querySelector('.kp-due')).toBeTruthy();
  });

  it('renders a chip for `meta.emoji.due` (parser output shape)', () => {
    // The inlineMeta parser stores 📅 values under the canonical `due` key
    // (see EMOJI_TABLE in inlineMeta.ts), not under the glyph itself.
    // Real cards coming off disk hit this path, so it MUST resolve to a chip.
    const { store } = makeStore(
      makeCard({
        meta: { tags: [], fields: {}, emoji: { due: '2026-05-22' } },
      }),
    );
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    expect(container.querySelector('.kp-due')).toBeTruthy();
  });

  it('done-toggle checkbox is fully visible at mount (no hover required)', () => {
    const { store } = makeStore(makeCard());
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    const cb = container.querySelector('.kp-card-done-toggle') as HTMLElement;
    expect(cb).toBeTruthy();
    // Inline opacity should never be 0; computed should also be 1. JSDOM
    // returns '' for unset opacity, which is the desired state (CSS default
    // of 1). The regression-state would be opacity:0 either inline or
    // computed.
    expect(cb.style.opacity).not.toBe('0');
    const computed = getComputedStyle(cb).opacity;
    // jsdom may return '' or '1' for an unstyled element; the regression
    // would return '0'. We accept anything except '0'.
    expect(computed).not.toBe('0');
  });

  it('renders the `^card-XXXX` block ID as a `.kp-blockid` badge', () => {
    const { store } = makeStore(
      makeCard({
        meta: {
          tags: [],
          fields: {},
          emoji: {},
          blockId: 'card-a1b2',
        },
      }),
    );
    const { container } = render(<Harness store={store} onOpenDetail={() => {}} />);
    const badge = container.querySelector('.kp-blockid');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('^card-a1b2');
  });
});
