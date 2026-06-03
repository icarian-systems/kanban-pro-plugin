/**
 * Calendar export (.ics). Works offline — purely formats a string from
 * the in-memory board. CalDAV push lands in 1.1.
 */

import ics from 'ics';
import type { Board, Card, Lane } from '@/core/model';

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
      if (!card.meta.date) {
        if (opts.skipUndated !== false) continue;
      }
      const event = cardToEvent(card, lane);
      if (event) events.push(event);
    }
  }
  const { error, value } = ics.createEvents(events, {
    calName: opts.calendarName ?? (board.frontmatter['title'] as string) ?? 'Kanban',
  });
  if (error) throw error;
  return value ?? '';
}

function cardToEvent(card: Card, lane: Lane): ics.EventAttributes | null {
  if (!card.meta.date) return null;
  const [y, m, d] = card.meta.date.split('-').map((n) => parseInt(n, 10));
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
