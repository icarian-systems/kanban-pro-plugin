/**
 * Pure query engine for vault-index rows.
 *
 * Semantics:
 *   - AND across filter dimensions (tags, dueBefore, dueAfter, status).
 *   - OR within `tags` — an entry matches if at least one of its tag keys is
 *     in the requested list. Tag keys are normalised by lower-casing and
 *     stripping any leading "#".
 *   - dueBefore/dueAfter compare against `modifiedAt` (the only timestamp we
 *     index per board). This is documented behavior: per-board "due" rolls
 *     up via the `overdue` / `dueWithin7d` counters, while time bracketing
 *     uses modification time.
 *   - Sort is stable and ascending for `title`, descending for `overdue`
 *     and `modifiedAt` (most-recent / most-pressing first).
 *   - `limit` is clamped to >= 0. `undefined` means "all results".
 */

import type { DashboardQuery, VaultIndexEntryShape } from './types';

export function executeQuery<E extends VaultIndexEntryShape>(
  entries: E[],
  q: DashboardQuery,
): E[] {
  const filtered = entries.filter((e) => passes(e, q));
  const sorted = sortEntries(filtered, q.sortBy);
  if (q.limit === undefined) return sorted;
  const lim = Math.max(0, Math.floor(q.limit));
  return sorted.slice(0, lim);
}

function passes(entry: VaultIndexEntryShape, q: DashboardQuery): boolean {
  if (q.tags && q.tags.length > 0) {
    const wanted = new Set(q.tags.map(normaliseTag));
    const has = Object.keys(entry.tags ?? {}).map(normaliseTag);
    if (!has.some((t) => wanted.has(t))) return false;
  }
  if (q.dueBefore !== undefined) {
    const cutoff = Date.parse(q.dueBefore);
    if (Number.isFinite(cutoff) && !(entry.modifiedAt < cutoff)) return false;
  }
  if (q.dueAfter !== undefined) {
    const cutoff = Date.parse(q.dueAfter);
    if (Number.isFinite(cutoff) && !(entry.modifiedAt > cutoff)) return false;
  }
  switch (q.status) {
    case 'overdue':
      if (!(entry.overdue > 0)) return false;
      break;
    case 'dueSoon':
      if (!(entry.dueWithin7d > 0)) return false;
      break;
    case 'active':
      if (!(entry.totalCards > 0)) return false;
      break;
    case 'all':
    case undefined:
      break;
  }
  return true;
}

function sortEntries<E extends VaultIndexEntryShape>(
  entries: E[],
  sortBy: DashboardQuery['sortBy'],
): E[] {
  // Always return a fresh array; never mutate the caller's input.
  const copy = entries.slice();
  switch (sortBy) {
    case 'title':
      copy.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'overdue':
      copy.sort((a, b) => b.overdue - a.overdue);
      break;
    case 'modifiedAt':
    case undefined:
      copy.sort((a, b) => b.modifiedAt - a.modifiedAt);
      break;
  }
  return copy;
}

function normaliseTag(t: string): string {
  return t.trim().replace(/^#+/, '').toLowerCase();
}
