/**
 * Calendar export (.ics). Works offline — purely formats a string from
 * the in-memory board. CalDAV push lands in 1.1.
 */

import ics from 'ics';
import { cardDue, type Board, type Card, type Lane } from '@/core/model';

export interface ExportOptions {
  /** Calendar name used in PRODID / X-WR-CALNAME. Defaults to the board title or "Kanban". */
  calendarName?: string;
  /** Skip cards without a due date. Default true — calendars want dated entries. */
  skipUndated?: boolean;
}

export function exportICS(board: Board, opts: ExportOptions = {}): string {
  const events: ics.EventAttributes[] = [];
  for (const lane of board.lanes) {
    for (const card of lane.cards) {
      // Resolve the due date across ALL inline-meta syntaxes (`@{YYYY-MM-DD}`,
      // `[due:: …]`, `📅 …`) via the shared `cardDue` helper — NOT just the
      // canonical `meta.date` slot. The previous `card.meta.date`-only check
      // skipped every card whose date was authored as a dataview field or
      // Tasks emoji, so boards full of `[due:: …]` cards exported an empty
      // calendar and the command looked like it did nothing (P2).
      const due = cardDue(card);
      if (!due && opts.skipUndated !== false) continue;
      const event = cardToEvent(card, lane, due);
      if (event) events.push(event);
    }
  }
  // Guard the empty case explicitly: `ics.createEvents([])` produces a
  // header-only (or error) result that's useless to write. Callers treat an
  // empty string as "no dated cards" and surface a clear notice instead of
  // writing a junk file.
  if (events.length === 0) return '';
  const { error, value } = ics.createEvents(events, {
    calName: opts.calendarName ?? (board.frontmatter['title'] as string) ?? 'Kanban',
  });
  if (error) throw error;
  return value ?? '';
}

function cardToEvent(card: Card, lane: Lane, due: string | undefined): ics.EventAttributes | null {
  if (!due) return null;
  const [y, m, d] = due.slice(0, 10).split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  const title = card.text.split('\n')[0].slice(0, 200);
  const time = card.meta.time?.split(':').map((n) => parseInt(n, 10));
  const start: ics.DateArray = time && time.length === 2
    ? [y, m, d, time[0], time[1]]
    : [y, m, d];
  return {
    title,
    start,
    duration: { hours: 1 },
    description: card.text,
    categories: [lane.title, ...card.meta.tags],
    uid: `kanban-${card.id}@kanban-pro.app`,
    status: card.done ? 'CONFIRMED' : 'TENTATIVE',
  };
}
