/**
 * BoardRoot.add-card-visible.test.tsx — regression for the "blank board:
 * clicking + Add card shows no visible card" bug.
 *
 * Root cause (not the focus race the prior two commits chased): the
 * board-level `HiddenCardsStyle` hides every card in `totalCardIds` that is
 * absent from `visibleCardIds`. `visibleCardIds` came from `applyFilter`,
 * which excludes EMPTY placeholder cards — even when no filter is active. So
 * the instant "+ Add card" created an empty placeholder, the board injected
 * `[data-card-id="…"]{display:none !important}` for it. The card existed in
 * the DOM and bumped the lane count, but was invisible; being display:none it
 * couldn't take editor focus or fire its discard-on-blur, so empty cards piled
 * up while the lane looked empty (lane chip "9", body empty).
 *
 * These tests mount the REAL BoardRoot so `HiddenCardsStyle` is in the loop.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, fireEvent, cleanup } from '@testing-library/react';
import { Component, type App } from 'obsidian';
import { BoardRoot } from '@/ui/BoardRoot';
import { createBoardStore } from '@/core/store';
import { parseBoard } from '@/core/parser';

const FIXTURE_SOURCE = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
  '## Backlog',
  '',
  '- [ ] An existing card ^card-keep',
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

/**
 * Collect the card ids the injected filter `<style>` blocks hide via
 * `display:none`. Empty for a board with no active filter.
 */
function hiddenCardIds(): string[] {
  const ids: string[] = [];
  for (const styleEl of Array.from(document.querySelectorAll('style[data-kp-filter-style]'))) {
    const css = styleEl.textContent ?? '';
    const re = /\[data-card-id="([^"]+)"\]\{display:none/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) ids.push(m[1]);
  }
  return ids;
}

describe('BoardRoot — "+ Add card" creates a VISIBLE card', () => {
  afterEach(() => cleanup());

  it('a newly added empty placeholder is not hidden by the filter CSS', () => {
    const parsed = parseBoard(FIXTURE_SOURCE);
    if (!parsed.board) throw new Error('fixture parse failed');
    const store = createBoardStore({ initialBoard: parsed.board });
    const laneId = store.selectLaneIds()[0];

    render(
      <BoardRoot
        store={store}
        app={makeApp()}
        viewComponent={new Component()}
        mode="board"
      />,
    );

    // No filter is active → nothing should be hidden to start.
    expect(hiddenCardIds()).toEqual([]);

    // Create an empty placeholder the way "+ Add card" does.
    let newId = '';
    act(() => {
      newId = store.addCard!(laneId);
    });

    // The new (empty) card must NOT be in the hidden set...
    expect(hiddenCardIds()).not.toContain(newId);
    // ...and must render in the DOM.
    expect(document.querySelector(`[data-card-id="${newId}"]`)).not.toBeNull();
    // The pre-existing committed card stays visible too.
    expect(hiddenCardIds()).toEqual([]);
  });

  it('clicking the "+ Add card" button surfaces a card in edit mode', () => {
    const parsed = parseBoard(FIXTURE_SOURCE);
    if (!parsed.board) throw new Error('fixture parse failed');
    const store = createBoardStore({ initialBoard: parsed.board });

    render(
      <BoardRoot
        store={store}
        app={makeApp()}
        viewComponent={new Component()}
        mode="board"
      />,
    );

    const addBtn = document.querySelector<HTMLButtonElement>('button.kp-add-card');
    expect(addBtn).not.toBeNull();

    act(() => {
      fireEvent.click(addBtn!);
    });

    // The created card is visible (not hidden) and its inline editor is open.
    expect(hiddenCardIds()).toEqual([]);
    expect(document.querySelector('.inline-editor')).not.toBeNull();
  });
});
