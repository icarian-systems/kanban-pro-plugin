/**
 * Column.add-card.test.tsx — integration coverage for the "+ Add card" UX.
 *
 * Reproduces the "blank board: clicking + shows no visual card change" bug.
 * Unlike Card.test.tsx (which passes `autoFocusOnMount` to <Card> directly),
 * this mounts the REAL store + DnD wiring and clicks the actual "+ Add card"
 * button, so the Column→Card hand-off (the `pendingFocusRef` timing) is
 * exercised end-to-end the way production drives it.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { Column } from '@/ui/Column';
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

function Harness({ board }: { board: Board }): React.ReactElement {
  const storeRef = React.useRef(createBoardStore({ initialBoard: board }));
  return (
    <DnDProvider store={storeRef.current}>
      <Column
        laneId={'lane-a'}
        store={storeRef.current}
        onOpenDetail={() => {}}
      />
    </DnDProvider>
  );
}

describe('Column — "+ Add card" on an empty lane', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
  });

  it('clicking "+ Add card" mounts a card whose inline editor is open', () => {
    const board = makeBoard([lane('lane-a', 'Backlog')]);
    render(<Harness board={board} />);

    // Sanity: the empty lane starts with no cards.
    expect(document.querySelector('.kp-card')).toBeNull();

    const addBtn = document.querySelector<HTMLButtonElement>('button.kp-add-card');
    expect(addBtn).not.toBeNull();

    act(() => {
      fireEvent.click(addBtn!);
    });

    // A card element must appear...
    expect(document.querySelector('.kp-card')).not.toBeNull();
    // ...and it must be in edit mode (the inline editor is mounted), not a
    // blank/invisible placeholder.
    expect(document.querySelector('.inline-editor')).not.toBeNull();
  });
});
