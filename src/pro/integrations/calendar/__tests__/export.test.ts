import { describe, it, expect } from 'vitest';
import { exportICS } from '../index';
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

function countEvents(ics: string): number {
  return (ics.match(/BEGIN:VEVENT/g) ?? []).length;
}

describe('exportICS — resolves every due-date syntax (P2 regression)', () => {
  it('exports cards dated via meta.date, [due:: …], and 📅 — not just meta.date', () => {
    const b = board([
      lane('todo', [
        // canonical `@{YYYY-MM-DD}` → meta.date
        card({ id: 'a', text: 'Alpha', meta: { tags: [], fields: {}, emoji: {}, date: '2026-06-15' } }),
        // dataview `[due:: YYYY-MM-DD]` → meta.fields.due
        card({ id: 'b', text: 'Bravo', meta: { tags: [], fields: { due: '2026-06-16' }, emoji: {} } }),
        // Tasks `📅 YYYY-MM-DD` → meta.emoji.due
        card({ id: 'c', text: 'Charlie', meta: { tags: [], fields: {}, emoji: { due: '2026-06-17' } } }),
        // hand-authored Tasks glyph slot → meta.emoji['📅']
        card({ id: 'd', text: 'Delta', meta: { tags: [], fields: {}, emoji: { '📅': '2026-06-18' } } }),
        // undated → skipped
        card({ id: 'e', text: 'Echo', meta: { tags: [], fields: {}, emoji: {} } }),
      ]),
    ]);

    const ics = exportICS(b, { calendarName: 'Q2 Sprint' });

    // All four dated cards produce events; the undated one is skipped.
    expect(countEvents(ics)).toBe(4);
    expect(ics).toContain('kanban-a@kanban-pro.app');
    expect(ics).toContain('kanban-b@kanban-pro.app');
    expect(ics).toContain('kanban-c@kanban-pro.app');
    expect(ics).toContain('kanban-d@kanban-pro.app');
    expect(ics).not.toContain('kanban-e@kanban-pro.app');
  });

  it('returns an empty string when no card carries a due date', () => {
    const b = board([
      lane('todo', [
        card({ id: 'x', text: 'no date here', meta: { tags: [], fields: {}, emoji: {} } }),
      ]),
    ]);
    expect(exportICS(b)).toBe('');
  });
});
