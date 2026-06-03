/**
 * Recurrence completion integration test.
 *
 * Verifies the store-level entitlement gating on the recurrence engine:
 * when `toggleCardDone` flips a recurring card to done, a successor
 * occurrence is spawned into the same lane — but only when
 * `getEntitlement('recurrence')` returns true (Pro). Free users get the
 * raw toggle with no successor.
 *
 * The store's wiring is in `src/core/store.ts` (toggleCardDone +
 * applyCompletion + getEntitlement option).
 */
import { describe, it, expect } from 'vitest';
import { createBoardStore } from '@/core/store';
import { parseBoard, serializeBoard } from '@/core/parser';
import type { Board, Card, Lane } from '@/core/model';

function makeRecurringCard(id: string): Card {
  return {
    id,
    text: 'Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO] @{2026-05-11}',
    done: false,
    hash: '',
    meta: {
      date: '2026-05-11',
      tags: [],
      fields: { rrule: 'FREQ=WEEKLY;BYDAY=MO' },
      emoji: {},
    },
    subtasks: [],
  };
}

function makeBoard(card: Card): Board {
  const lane: Lane = {
    id: 'lane-1',
    title: 'Todo',
    kind: 'normal',
    cards: [card],
    collapsed: false,
  };
  return {
    lanes: [lane],
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

describe('recurrence completion — store integration', () => {
  it('Pro: spawns the next occurrence into the same lane on done-toggle', () => {
    const card = makeRecurringCard('c-pro-1');
    const board = makeBoard(card);
    const store = createBoardStore({
      initialBoard: board,
      getEntitlement: () => true,
    });

    store.toggleCardDone('c-pro-1');

    const lane = store.getState().board.lanes[0];
    // (a) original card has done: true
    const original = lane.cards.find((c) => c.id === 'c-pro-1');
    expect(original).toBeDefined();
    expect(original!.done).toBe(true);

    // (b) lane now has 2 cards
    expect(lane.cards.length).toBe(2);

    // (c) the new card has done: false and meta.date is the next Monday
    //     (anchor 2026-05-11 is a Monday; FREQ=WEEKLY;BYDAY=MO -> 2026-05-18).
    const successor = lane.cards.find((c) => c.id !== 'c-pro-1');
    expect(successor).toBeDefined();
    expect(successor!.done).toBe(false);
    expect(successor!.meta.date).toBe('2026-05-18');
  });

  it('end-to-end: parse → toggleDone (Pro) → serialize preserves [rrule:: …]', () => {
    const src = [
      '---',
      'kanban-plugin: board',
      '---',
      '',
      '## Todo',
      '',
      '- [ ] Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO] @{2026-05-11}',
      '',
    ].join('\n');
    const { board } = parseBoard(src);
    expect(board).toBeTruthy();
    if (!board) throw new Error('parse failed');

    const store = createBoardStore({
      initialBoard: board,
      getEntitlement: () => true,
    });

    const originalId = store.getState().board.lanes[0].cards[0].id;
    store.toggleCardDone(originalId);

    const out = serializeBoard(store.getState().board);
    // Both original (done) and successor must carry the rrule field in
    // their serialized form. Neither path may strip [rrule:: …].
    expect(out).toContain('[rrule:: FREQ=WEEKLY;BYDAY=MO]');
    expect(out.match(/\[rrule:: FREQ=WEEKLY;BYDAY=MO\]/g)?.length).toBe(2);
    // Successor body has the next-Monday date.
    expect(out).toContain('@{2026-05-18}');
    // Done line for the original.
    expect(out).toMatch(/- \[x\] Weekly review \[rrule:: FREQ=WEEKLY;BYDAY=MO\]/);
  });

  it('DetailPanel write path: editing recurrence meta round-trips and then recurs', () => {
    // Start from a plain, non-recurring card.
    const src = [
      '---',
      'kanban-plugin: board',
      '---',
      '',
      '## Todo',
      '',
      '- [ ] Weekly review @{2026-05-11}',
      '',
    ].join('\n');
    const { board } = parseBoard(src);
    if (!board) throw new Error('parse failed');

    const store = createBoardStore({ initialBoard: board, getEntitlement: () => true });
    const id = store.getState().board.lanes[0].cards[0].id;

    // Simulate the DetailPanel recurrence input committing a natural-language
    // rule into `meta.fields.repeats` (no text rewrite — exactly what the
    // panel does via patchMeta → editCard({ meta })).
    const cur = store.selectCard(id)!;
    store.editCard(id, {
      meta: { ...cur.meta, fields: { ...cur.meta.fields, repeats: 'every monday' } },
    });

    // The serializer must persist the field into the card text so it survives
    // a reload (canonicalCard → setFieldsInText appends `[repeats:: …]`).
    const out = serializeBoard(store.getState().board);
    expect(out).toContain('[repeats:: every monday]');

    // Reload from disk and confirm completion now spawns a successor.
    const reloaded = parseBoard(out).board;
    if (!reloaded) throw new Error('reparse failed');
    const store2 = createBoardStore({ initialBoard: reloaded, getEntitlement: () => true });
    const id2 = store2.getState().board.lanes[0].cards[0].id;
    store2.toggleCardDone(id2);
    expect(store2.getState().board.lanes[0].cards.length).toBe(2);
  });

  it('Free: does NOT spawn a successor on done-toggle', () => {
    const card = makeRecurringCard('c-free-1');
    const board = makeBoard(card);
    const store = createBoardStore({
      initialBoard: board,
      getEntitlement: () => false,
    });

    store.toggleCardDone('c-free-1');

    const lane = store.getState().board.lanes[0];
    // (a) original card has done: true
    const original = lane.cards.find((c) => c.id === 'c-free-1');
    expect(original).toBeDefined();
    expect(original!.done).toBe(true);

    // (b) lane still has 1 card
    expect(lane.cards.length).toBe(1);
  });
});
