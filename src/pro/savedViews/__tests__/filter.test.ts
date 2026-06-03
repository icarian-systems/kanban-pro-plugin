import { describe, it, expect } from 'vitest';
import {
  applyFilter,
  encodeFilter,
  decodeFilter,
  filterCards,
  materializeSavedView,
  localTodayIso,
} from '../filter';
import { SavedViewStore, memoryBackend } from '../store';
import type { Board, Card, Lane } from '@/core/model';

function card(p: Partial<Card>): Card {
  return {
    id: p.id ?? 'c',
    text: p.text ?? '',
    done: p.done ?? false,
    hash: '',
    meta: p.meta ?? { tags: [], fields: {}, emoji: {} },
    subtasks: p.subtasks ?? [],
  };
}

function lane(id: string, cards: Card[]): Lane {
  return { id, title: id, kind: 'normal', cards, collapsed: false };
}

function board(lanes: Lane[]): Board {
  return {
    lanes,
    frontmatter: {},
    settings: {},
    fileTrivia: { bom: false, newline: '\n', trailingNewline: true, originalSource: '' },
    hash: '',
  };
}

describe('applyFilter', () => {
  const b = board([
    lane('todo', [
      card({ id: 'a', text: 'fix bug', meta: { tags: ['bug'], fields: { assignee: 'AJ' }, emoji: {} } }),
      card({ id: 'b', text: 'write docs', meta: { tags: ['docs'], fields: { assignee: 'MC' }, emoji: {}, date: '2026-06-01' } }),
    ]),
    lane('done', [
      card({ id: 'c', done: true, text: 'shipped', meta: { tags: ['ops'], fields: {}, emoji: {} } }),
    ]),
  ]);

  it('matches by text', () => {
    expect(applyFilter(b, { text: 'doc' })).toHaveLength(1);
  });

  it('matches by tag intersection', () => {
    expect(applyFilter(b, { tags: ['bug'] })).toHaveLength(1);
    expect(applyFilter(b, { tags: ['bug', 'docs'] })).toHaveLength(0);
  });

  it('matches by assignee', () => {
    expect(applyFilter(b, { assignees: ['AJ'] })).toHaveLength(1);
  });

  it('matches by due-before', () => {
    expect(applyFilter(b, { dueBefore: '2026-07-01' })).toHaveLength(1);
    expect(applyFilter(b, { dueBefore: '2026-05-01' })).toHaveLength(0);
  });

  it('matches by done', () => {
    expect(applyFilter(b, { done: true })).toHaveLength(1);
    expect(applyFilter(b, { done: false })).toHaveLength(2);
  });

  it('matches everything for empty filter', () => {
    expect(applyFilter(b, {})).toHaveLength(3);
    expect(applyFilter(b, undefined)).toHaveLength(3);
  });
});

describe('filterCards — unified predicate + counts', () => {
  const today = '2026-05-17';
  const ctx = { today, currentUser: 'AJ' };

  function b(cards: Card[]): Board {
    return board([lane('todo', cards)]);
  }

  it('excludes empty placeholder cards from counts AND visibility', () => {
    const placeholder = card({ id: 'p', text: '   ', meta: { tags: [], fields: {}, emoji: {} } });
    const real = card({ id: 'r', text: 'real card', meta: { tags: [], fields: {}, emoji: {} } });
    const res = filterCards(b([placeholder, real]), undefined, ctx);
    expect(res.total).toBe(1);
    expect(res.visibleIds.has('p')).toBe(false);
    expect(res.visibleIds.has('r')).toBe(true);
    expect(res.counts['assigned-to-me']).toBe(0);
    expect(res.counts['recurring']).toBe(0);
  });

  it('assigned-to-me matches only cards whose assignee equals currentUser', () => {
    const a = card({ id: 'a', text: 'mine', meta: { tags: [], fields: { assignee: 'AJ' }, emoji: {} } });
    const b1 = card({ id: 'b', text: 'theirs', meta: { tags: [], fields: { assignee: 'MC' }, emoji: {} } });
    const c1 = card({ id: 'c', text: 'unassigned', meta: { tags: [], fields: {}, emoji: {} } });
    const res = filterCards(b([a, b1, c1]), undefined, ctx);
    expect(res.counts['assigned-to-me']).toBe(1);
  });

  it('assigned-to-me with no currentUser configured matches zero cards (not all)', () => {
    const a = card({ id: 'a', text: 'a', meta: { tags: [], fields: { assignee: 'AJ' }, emoji: {} } });
    const res = filterCards(b([a]), undefined, { today, currentUser: null });
    expect(res.counts['assigned-to-me']).toBe(0);
  });

  it('recurring matches only cards whose meta.fields.rrule is non-empty', () => {
    const a = card({ id: 'a', text: 'recurring', meta: { tags: [], fields: { rrule: 'FREQ=WEEKLY' }, emoji: {} } });
    const b1 = card({ id: 'b', text: 'one-off', meta: { tags: [], fields: {}, emoji: {} } });
    const c1 = card({ id: 'c', text: 'blank rrule', meta: { tags: [], fields: { rrule: '   ' }, emoji: {} } });
    const res = filterCards(b([a, b1, c1]), undefined, ctx);
    expect(res.counts['recurring']).toBe(1);
  });

  it('due-this-week matches cards whose date falls inside [today, today+7d) and not done', () => {
    const inWindow = card({ id: 'a', text: 'in', meta: { tags: [], fields: {}, emoji: {}, date: '2026-05-20' } });
    const past = card({ id: 'b', text: 'past', meta: { tags: [], fields: {}, emoji: {}, date: '2026-05-10' } });
    const future = card({ id: 'c', text: 'future', meta: { tags: [], fields: {}, emoji: {}, date: '2026-06-01' } });
    const inWindowDone = card({ id: 'd', done: true, text: 'in-done', meta: { tags: [], fields: {}, emoji: {}, date: '2026-05-20' } });
    const res = filterCards(b([inWindow, past, future, inWindowDone]), undefined, ctx);
    expect(res.counts['due-this-week']).toBe(1);
  });

  it('overdue counts cards with due strictly before today and not done', () => {
    const overdue = card({ id: 'a', text: 'overdue', meta: { tags: [], fields: {}, emoji: {}, date: '2026-05-10' } });
    const overdueDone = card({ id: 'b', done: true, text: 'done-overdue', meta: { tags: [], fields: {}, emoji: {}, date: '2026-05-10' } });
    const dueToday = card({ id: 'c', text: 'today', meta: { tags: [], fields: {}, emoji: {}, date: today } });
    const res = filterCards(b([overdue, overdueDone, dueToday]), undefined, ctx);
    expect(res.counts.overdue).toBe(1);
  });

  it('visibleIds honors explicit ViewFilter (tag)', () => {
    const tagged = card({ id: 'a', text: 'bug', meta: { tags: ['bug'], fields: {}, emoji: {} } });
    const untagged = card({ id: 'b', text: 'plain', meta: { tags: [], fields: {}, emoji: {} } });
    const res = filterCards(b([tagged, untagged]), { tags: ['bug'] }, ctx);
    expect(Array.from(res.visibleIds)).toEqual(['a']);
  });

  it('overdue counts emoji-style 📅 dates via meta.emoji.due (normalization)', () => {
    const emojiOverdue = card({
      id: 'a',
      text: 'fix bug 📅 2026-05-10',
      meta: { tags: [], fields: {}, emoji: { due: '2026-05-10' } },
    });
    const explicitOverdue = card({
      id: 'b',
      text: 'fix doc',
      meta: { tags: [], fields: {}, emoji: {}, date: '2026-05-10' },
    });
    const res = filterCards(b([emojiOverdue, explicitOverdue]), undefined, ctx);
    expect(res.counts.overdue).toBe(2);
  });

  it('overdue counts field-style [due:: …] dates via meta.fields.due', () => {
    const fieldOverdue = card({
      id: 'a',
      text: 'fix bug [due:: 2026-05-10]',
      meta: { tags: [], fields: { due: '2026-05-10' }, emoji: {} },
    });
    const res = filterCards(b([fieldOverdue]), undefined, ctx);
    expect(res.counts.overdue).toBe(1);
  });

  it('hasRrule:false matches only cards WITHOUT an rrule field', () => {
    const recurring = card({ id: 'a', text: 'r', meta: { tags: [], fields: { rrule: 'FREQ=WEEKLY' }, emoji: {} } });
    const plain = card({ id: 'b', text: 'p', meta: { tags: [], fields: {}, emoji: {} } });
    const res = filterCards(b([recurring, plain]), { hasRrule: false }, ctx);
    expect(Array.from(res.visibleIds)).toEqual(['b']);
  });
});

describe('filterCards — performance sanity', () => {
  const ctx = { today: '2026-05-17', currentUser: 'AJ' };

  function buildLargeBoard(n: number): Board {
    const cards: Card[] = [];
    for (let i = 0; i < n; i++) {
      cards.push(
        card({
          id: `c${i}`,
          text: `Card ${i} with #tag${i % 7} body content`,
          done: i % 5 === 0,
          meta: {
            tags: [`tag${i % 7}`],
            fields: i % 11 === 0 ? { rrule: 'FREQ=DAILY' } : {},
            emoji: i % 13 === 0 ? { due: '2026-05-10' } : {},
            date: i % 17 === 0 ? '2026-05-20' : undefined,
          },
        }),
      );
    }
    return board([lane('todo', cards)]);
  }

  it('runs filterCards on a 200-card board in under 50ms', () => {
    const big = buildLargeBoard(200);
    const t0 = performance.now();
    const res = filterCards(big, { tags: ['tag3'] }, ctx);
    const elapsed = performance.now() - t0;
    expect(res.visibleIds.size).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });

  it('produces stable counts across 10 invocations on a 200-card board', () => {
    const big = buildLargeBoard(200);
    let last: number | null = null;
    for (let i = 0; i < 10; i++) {
      const res = filterCards(big, undefined, ctx);
      const n = res.counts.recurring;
      if (last !== null) expect(n).toBe(last);
      last = n;
    }
  });
});

describe('materializeSavedView', () => {
  const ctx = { today: '2026-05-17', currentUser: 'AJ' };

  it('returns null for assigned-to-me when no user is set', () => {
    expect(materializeSavedView('assigned-to-me', { today: ctx.today, currentUser: null })).toBeNull();
  });

  it('returns a 7-day window centred at today for due-this-week', () => {
    const f = materializeSavedView('due-this-week', ctx);
    expect(f).toEqual({ dueAfter: '2026-05-16', dueBefore: '2026-05-24', done: false });
  });

  it('returns hasRrule:true for recurring', () => {
    expect(materializeSavedView('recurring', ctx)).toEqual({ hasRrule: true });
  });
});

describe('localTodayIso', () => {
  it('formats YYYY-MM-DD in local time', () => {
    expect(localTodayIso(new Date(2026, 4, 17, 12, 0, 0))).toBe('2026-05-17');
  });
});

describe('encode/decode filter', () => {
  it('round-trips', () => {
    const f = { text: 'foo', tags: ['a', 'b'], done: false };
    const encoded = encodeFilter(f);
    const decoded = decodeFilter(encoded);
    expect(decoded).toEqual(f);
  });

  it('returns null on garbage', () => {
    expect(decodeFilter('!!!')).toBeNull();
  });
});

describe('SavedViewStore', () => {
  it('persists and retrieves views', async () => {
    const store = new SavedViewStore(memoryBackend());
    await store.load();
    const v = await store.save({ name: 'Due this week', filter: { dueBefore: '2026-05-21' } });
    expect(v.id).toBeDefined();
    expect(store.list()).toHaveLength(1);
    await store.delete(v.id);
    expect(store.list()).toHaveLength(0);
  });
});
