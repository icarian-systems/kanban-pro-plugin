/**
 * Card.titleStrip.test.tsx — title-line token stripping.
 *
 * Pins the title-line cleanup: inline-meta tokens (`#tag`, `^blockid`,
 * `[k:: v]`, `📅 2026-01-01`, `@{YYYY-MM-DD}`) must NOT appear as raw text
 * in the rendered `<h3>` — every kind already has a dedicated chip rendered
 * below the title, so leaving the raw token in `<h3>` produces the
 * duplicated-tag, raw-block-id, and raw-date symptoms this test guards
 * against.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Card } from '@/ui/Card';
import type { BoardStore } from '@/core/store';
import type { Card as CardModel } from '@/core/model';

function makeCardModel(overrides: Partial<CardModel>): CardModel {
  return {
    id: 'c-1',
    text: 'Draft Q2 OKRs',
    done: false,
    hash: 'h-1',
    meta: { tags: [], fields: {}, emoji: {} },
    subtasks: [],
    ...overrides,
  };
}

function makeStubStore(card: CardModel): BoardStore {
  const listeners = new Set<() => void>();
  let current = card;
  const noop = (): void => undefined;
  return {
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    selectLaneIds: () => ['l1'],
    selectCardIds: () => [current.id],
    selectCard: () => current,
    selectLane: () => ({
      id: 'l1',
      title: 'Backlog',
      kind: 'normal' as const,
      cards: [current],
      collapsed: false,
    }),
    selectBoardMeta: () => ({ title: 'Untitled Board', cardCount: 1, laneCount: 1 }),
    selectMode: () => 'board' as const,
    getState: () => ({
      board: {
        hash: 'h-board',
        lanes: [{ id: 'l1', title: 'Backlog', kind: 'normal' as const, cards: [current], collapsed: false }],
        frontmatter: {},
        settings: {},
        fileTrivia: { newline: '\n', trailingNewline: true, bom: false },
      },
      readOnly: false,
    } as unknown as ReturnType<BoardStore['getState']>),
    editCard: vi.fn(),
    toggleCardDone: vi.fn(),
    addCard: vi.fn(),
    deleteCard: vi.fn(),
    addLane: vi.fn(),
    toggleSubtask: vi.fn(),
    editSubtask: vi.fn(),
    addSubtask: vi.fn(),
    deleteSubtask: vi.fn(),
    setMode: vi.fn(),
    beginGesture: noop,
    moveCardOptimistic: noop,
    moveCard: noop,
    moveLane: noop,
    commitGesture: noop,
    cancelGesture: noop,
    archiveCard: noop,
    editLane: noop,
    deleteLane: noop,
    isReadOnly: () => false,
  } as unknown as BoardStore;
}

function mount(card: CardModel): ReturnType<typeof render> {
  const store = makeStubStore(card);
  return render(
    <DndContext>
      <SortableContext items={[card.id]} strategy={verticalListSortingStrategy}>
        <Card
          cardId={card.id}
          laneId={'l1'}
          index={0}
          store={store}
          onOpenDetail={vi.fn()}
        />
      </SortableContext>
    </DndContext>,
  );
}

afterEach(cleanup);

describe('Card title strips inline-meta tokens', () => {
  it('strips a `#tag` token from the title (no duplication vs the chip below)', () => {
    const card = makeCardModel({
      text: 'Investigate flaky DnD #bug',
      meta: { tags: ['bug'], fields: {}, emoji: {} },
    });
    const { container } = mount(card);
    const title = container.querySelector('.kp-card-title');
    expect(title?.textContent ?? '').toBe('Investigate flaky DnD');
    // Tag chip still renders below the title.
    const tagChip = container.querySelector('.kp-tag');
    expect(tagChip?.textContent ?? '').toMatch(/#?\s*bug/);
  });

  it('strips a `^blockId` token from the title', () => {
    const card = makeCardModel({
      text: 'Draft Q2 OKRs ^card-c3d4',
      meta: { tags: [], fields: {}, emoji: {}, blockId: 'card-c3d4' },
    });
    const { container } = mount(card);
    const title = container.querySelector('.kp-card-title');
    expect(title?.textContent ?? '').toBe('Draft Q2 OKRs');
  });

  it('strips a `[due:: …]` Dataview field from the title', () => {
    const card = makeCardModel({
      text: 'Plan sprint [due:: 2026-05-20]',
      meta: { tags: [], fields: { due: '2026-05-20' }, emoji: {}, date: '2026-05-20' },
    });
    const { container } = mount(card);
    const title = container.querySelector('.kp-card-title');
    expect(title?.textContent ?? '').toBe('Plan sprint');
  });

  it('strips a Tasks-plugin emoji + date from the title (emoji path)', () => {
    const card = makeCardModel({
      text: 'Ship feature 📅 2026-05-18',
      meta: {
        tags: [],
        fields: {},
        emoji: { '📅': '2026-05-18' },
        date: '2026-05-18',
      },
    });
    const { container } = mount(card);
    const title = container.querySelector('.kp-card-title');
    expect(title?.textContent ?? '').toBe('Ship feature');
  });

  it('strips multiple token kinds from a single title (full migration-card shape)', () => {
    // The migration fixture: subtasks + 📅 + #planning + ^card-c3d4 +
    // [due:: …]. All five must leave the title; only the textual prefix
    // survives.
    const card = makeCardModel({
      text: 'Draft Q2 OKRs #planning [due:: 2026-05-20] 📅 2026-05-18 ^card-c3d4',
      meta: {
        tags: ['planning'],
        fields: { due: '2026-05-20' },
        emoji: { '📅': '2026-05-18' },
        date: '2026-05-18',
        blockId: 'card-c3d4',
      },
    });
    const { container } = mount(card);
    const title = container.querySelector('.kp-card-title');
    expect(title?.textContent ?? '').toBe('Draft Q2 OKRs');
  });

  it('leaves a plain title untouched when no tokens are present', () => {
    const card = makeCardModel({
      text: 'Onboarding doc revision',
      meta: { tags: [], fields: {}, emoji: {} },
    });
    const { container } = mount(card);
    const title = container.querySelector('.kp-card-title');
    expect(title?.textContent ?? '').toBe('Onboarding doc revision');
  });
});
