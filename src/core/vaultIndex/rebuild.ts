/**
 * Pure summarization helpers — given a Board, produce a VaultIndexEntry.
 * Isolated so the rebuild loop and the incremental-update path share one
 * implementation, and so tests can exercise it without an Obsidian shim.
 */
import { cardDue, type Board } from '@/core/model';
import type { VaultIndexEntry } from './types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Today at local midnight, returned as ms since epoch. We compare against
 * card due dates parsed as YYYY-MM-DD; both sides are local-time, no TZ
 * gymnastics required.
 */
export function todayLocalMs(now: Date = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime();
}

/**
 * Parse a YYYY-MM-DD inline-meta date string. Returns NaN on malformed
 * input so the caller can `Number.isFinite()` check it.
 */
export function parseInlineDate(s: string | undefined): number {
  if (!s) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(dy)) {
    return NaN;
  }
  return new Date(y, mo - 1, dy).getTime();
}

/**
 * Summarize a board for the dashboard cache. Title falls back to the
 * file basename (caller's responsibility — we don't see the path here).
 */
export function summarizeBoard(
  board: Board,
  path: string,
  modifiedAt: number,
  now: Date = new Date(),
): VaultIndexEntry {
  const today = todayLocalMs(now);
  const in7d = today + 7 * MS_PER_DAY;

  let totalCards = 0;
  let overdue = 0;
  let dueWithin7d = 0;
  const laneCounts: Record<string, number> = {};
  const tags: Record<string, number> = {};

  for (const lane of board.lanes) {
    laneCounts[lane.title] = (laneCounts[lane.title] ?? 0) + lane.cards.length;
    for (const card of lane.cards) {
      totalCards++;
      if (!card.done) {
        // Normalize across @{date}, emoji 📅, and [due::] field syntaxes so
        // Dashboard counters match what the Card chip renders.
        const due = parseInlineDate(cardDue(card));
        if (Number.isFinite(due)) {
          if (due < today) overdue++;
          else if (due <= in7d) dueWithin7d++;
        }
      }
      for (const tag of card.meta.tags) {
        tags[tag] = (tags[tag] ?? 0) + 1;
      }
    }
  }

  // Title comes from frontmatter['title'] if present, else the file basename.
  const fmTitle =
    typeof board.frontmatter['title'] === 'string'
      ? (board.frontmatter['title'] as string)
      : undefined;
  const basename = path.replace(/^.*\//, '').replace(/\.md$/i, '');
  const title = fmTitle && fmTitle.length > 0 ? fmTitle : basename;

  return {
    path,
    title,
    laneCounts,
    totalCards,
    overdue,
    dueWithin7d,
    tags,
    modifiedAt,
  };
}
