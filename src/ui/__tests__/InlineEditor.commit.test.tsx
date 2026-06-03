/**
 * Commit-on-blur path lock-in.
 *
 * The canonical commit path is `InlineEditor` (blur) → host's `onCommit`
 * → `store.editCard?.(cardId, { text: next })`. That `{ text: next }`
 * payload has historically lost inline-meta vocab because `editCard`'s
 * meta-only-undefined branch never re-parsed the new text. The store fix
 * (editCard re-merge) closes that hole — this test guards it.
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

import { InlineEditor } from '@/ui/InlineEditor';
import { createBoardStore } from '@/core/store';
import { parseBoard } from '@/core/parser';

afterEach(cleanup);

function makeStoreWithOneCard() {
  const src = '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] starter\n';
  const { board } = parseBoard(src);
  if (!board) throw new Error('parse failed');
  const store = createBoardStore({ initialBoard: board });
  const cardId = board.lanes[0].cards[0].id;
  return { store, cardId };
}

describe('InlineEditor commit-on-blur seeds card.meta', () => {
  it('typing inline-meta vocab and blurring populates meta.fields.rrule and meta.tags', async () => {
    const { store, cardId } = makeStoreWithOneCard();
    const editSpy = vi.spyOn(store, 'editCard');

    const { container } = render(
      <InlineEditor
        cardId={cardId}
        initialValue="starter"
        onCommit={(next) => {
          store.editCard(cardId, { text: next });
        }}
      />,
    );

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    const typed = 'Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO] #urgent';
    await act(async () => {
      textarea.value = typed;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    // editCard was called once with text-only payload.
    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(editSpy.mock.calls[0][1]).toEqual({ text: typed });

    // Resolved card carries the inline meta from text.
    const resolved = store.selectCard(cardId);
    expect(resolved).toBeTruthy();
    expect(resolved?.text).toBe(typed);
    expect(resolved?.meta.fields.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(resolved?.meta.tags).toContain('urgent');
  });

  it('blur without inline-meta vocab leaves meta unchanged', async () => {
    const { store, cardId } = makeStoreWithOneCard();
    const initial = store.selectCard(cardId)?.meta;
    const { container } = render(
      <InlineEditor
        cardId={cardId}
        initialValue="starter"
        onCommit={(next) => {
          store.editCard(cardId, { text: next });
        }}
      />,
    );
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      textarea.value = 'Now plain prose, no meta';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    const resolved = store.selectCard(cardId);
    expect(resolved?.text).toBe('Now plain prose, no meta');
    expect(resolved?.meta.tags).toEqual(initial?.tags ?? []);
    expect(resolved?.meta.fields).toEqual(initial?.fields ?? {});
  });
});
