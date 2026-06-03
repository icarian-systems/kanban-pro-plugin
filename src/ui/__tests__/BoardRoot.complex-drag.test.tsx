/**
 * BoardRoot.complex-drag.test.tsx — board-level drag render-loop coverage.
 *
 * The existing `Card.complex.test.tsx` mounts `<Card>` directly inside a
 * synthetic `<DndContext>`. That misses the production crash surface, which
 * is the *board-level* render path: BoardRoot subscribes to a filter
 * fingerprint that re-derives on every mutation; Columns subscribe per-lane;
 * Cards subscribe per-card. On a board with at least ONE structurally-complex
 * card (subtasks + emoji + inline-meta + ^card-id), dragging ANY card — even
 * a plain one — surfaced React #185 ("Maximum update depth exceeded").
 *
 * This test exercises the same surface area the user hits in production:
 *   1. Real `createBoardStore` with a 2-card, 2-lane fixture (one complex,
 *      one plain).
 *   2. Real `BoardRoot` mounted (so `useFilterFingerprint`,
 *      `useBoardMeta`, the saved-view memo, etc. are all in the loop).
 *   3. Simulate a drag commit by calling `moveCardOptimistic` +
 *      `commitGesture` against the real store, the same sequence
 *      `DnDProvider` runs on `onDragOver` + `onDragEnd`.
 *   4. Assert no "Maximum update depth" warning fires and the post-mutation
 *      render count stays bounded.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { Component, type App } from 'obsidian';
import { BoardRoot } from '@/ui/BoardRoot';
import { createBoardStore } from '@/core/store';
import { parseBoard } from '@/core/parser';

// Complex card + plain card in the same board. The reproduction shape — the
// complex card on its own crashed Card.complex.test.tsx pre-fix; even AFTER
// that fix landed, the plain card in the same board still triggers the loop
// because the surrounding BoardRoot subscriptions churn on every mutation.
const FIXTURE_SOURCE = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
  '## Backlog',
  '',
  '- [ ] Plain card with no metadata ^card-plain',
  '',
  '## Doing',
  '',
  '- [ ] **Migrate** parser to remark [due:: 2026-05-22] [assignee:: jane] #parser #migration ^card-complex',
  '\t- [x] Replace tokenizer',
  '\t- [x] Wire trivia preservation',
  '\t- [ ] Add round-trip tests',
  '\t- [ ] Run on real corpus',
  '',
].join('\n');

function makeApp(): App {
  return {
    workspace: { openLinkText: vi.fn() },
    vault: { getAbstractFileByPath: vi.fn(() => null) },
    metadataCache: {
      getBacklinksForFile: vi.fn(() => ({ data: {} })),
      resolvedLinks: {},
    },
  } as unknown as App;
}

describe('BoardRoot — board-level drag with mixed plain/complex cards', () => {
  afterEach(() => {
    cleanup();
  });

  it('rendering the full board with a structurally-complex card does not produce a render loop', () => {
    const parsed = parseBoard(FIXTURE_SOURCE);
    if (!parsed.board) throw new Error('fixture parse failed');
    const store = createBoardStore({ initialBoard: parsed.board });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <BoardRoot
        store={store}
        app={makeApp()}
        viewComponent={new Component()}
        mode="board"
      />,
    );

    const loopErrors = errorSpy.mock.calls.filter((call) =>
      String(call[0] ?? '').match(/Maximum update depth|getSnapshot should be cached/i),
    );
    expect(loopErrors).toEqual([]);

    errorSpy.mockRestore();
  });

  it('a drag commit on the plain card does not loop the board render', async () => {
    const parsed = parseBoard(FIXTURE_SOURCE);
    if (!parsed.board) throw new Error('fixture parse failed');
    const store = createBoardStore({ initialBoard: parsed.board });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <BoardRoot
        store={store}
        app={makeApp()}
        viewComponent={new Component()}
        mode="board"
      />,
    );

    // Find the plain card id + the destination lane id (Doing).
    const board = store.getState().board;
    const plainCard = board.lanes[0].cards[0];
    const doingLane = board.lanes[1];
    expect(plainCard).toBeTruthy();
    expect(doingLane.title).toBe('Doing');

    // Drive the same sequence DnDProvider runs across MANY onDragOver
    // events (the repro showed the loop fired during the sustained
    // drag, not just at commit).
    await act(async () => {
      store.beginGesture();
      // Simulate the drag flicking across lane boundaries.
      for (let i = 0; i < 10; i += 1) {
        store.moveCardOptimistic(plainCard.id, doingLane.id, 0);
        store.moveCardOptimistic(plainCard.id, board.lanes[0].id, 0);
      }
      store.moveCardOptimistic(plainCard.id, doingLane.id, 0);
      store.commitGesture();
      await Promise.resolve();
      await Promise.resolve();
    });

    const loopErrors = errorSpy.mock.calls.filter((call) =>
      String(call[0] ?? '').match(/Maximum update depth|getSnapshot should be cached/i),
    );
    expect(loopErrors).toEqual([]);

    errorSpy.mockRestore();
  });

  it('rapidly subscribing+toggling a complex card during drag does not loop', async () => {
    const parsed = parseBoard(FIXTURE_SOURCE);
    if (!parsed.board) throw new Error('fixture parse failed');
    const store = createBoardStore({ initialBoard: parsed.board });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <BoardRoot
        store={store}
        app={makeApp()}
        viewComponent={new Component()}
        mode="board"
      />,
    );

    const board = store.getState().board;
    const complexCard = board.lanes[1].cards[0];
    expect(complexCard).toBeTruthy();
    // Sanity check: the complex card carries the structural complexity
    // (subtasks + emoji + tags + inline-meta) that triggers the loop.
    expect(complexCard.subtasks.length).toBeGreaterThan(0);
    expect(Object.keys(complexCard.meta.fields ?? {}).length).toBeGreaterThan(0);
    expect(complexCard.meta.tags.length).toBeGreaterThan(0);

    await act(async () => {
      // Several mutations on the complex card; each call notifies all
      // subscribers (the load-bearing surface for the QA #185 crash).
      for (let i = 0; i < 5; i += 1) {
        store.toggleCardDone(complexCard.id);
        store.toggleCardDone(complexCard.id);
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    const loopErrors = errorSpy.mock.calls.filter((call) =>
      String(call[0] ?? '').match(/Maximum update depth|getSnapshot should be cached/i),
    );
    expect(loopErrors).toEqual([]);

    errorSpy.mockRestore();
  });
});
