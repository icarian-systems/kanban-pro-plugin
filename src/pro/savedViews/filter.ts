/**
 * Filter engine over a Board model. Free feature — used by Table/List
 * views for ad-hoc filtering. Saved Views (Pro) layer naming + persistence
 * on top.
 *
 * Single source of truth: callers (BoardRoot, TableRoot, ListRoot,
 * Dashboard, RightRail counts) consume `filterCards` so the user always
 * sees consistent visibility and counts across every surface. The
 * historical `applyFilter` wrapper remains for the existing call sites that
 * only need matching cards back.
 */

import {
  cardDue,
  type Board,
  type Card,
  type CardId,
  type Lane,
  type ViewFilter,
} from '@/core/model';

export interface FilterMatch {
  card: Card;
  lane: Lane;
}

/** Built-in saved views surfaced in the right rail. */
export type SavedViewKey =
  | 'due-this-week'
  | 'overdue'
  | 'assigned-to-me'
  | 'recurring';

export const SAVED_VIEW_KEYS: readonly SavedViewKey[] = [
  'due-this-week',
  'assigned-to-me',
  'overdue',
  'recurring',
];

/**
 * Context the predicate engine needs to evaluate built-in saved views.
 *
 *  - `today` is the local-date midnight ISO (YYYY-MM-DD) the user
 *    perceives, so `due-this-week` and `overdue` agree with what's
 *    rendered on date chips.
 *  - `currentUser` is the user's vault identity from settings; when null
 *    the `assigned-to-me` saved view legitimately matches zero cards
 *    rather than collapsing to "match anything".
 */
export interface FilterContext {
  today: string;
  currentUser: string | null;
}

/**
 * Materialize a saved-view key into a concrete ViewFilter. Returns null
 * when the context cannot fulfil the view (e.g. `assigned-to-me` with no
 * configured user) — in that case the view matches zero cards rather
 * than every card.
 */
export function materializeSavedView(
  key: SavedViewKey,
  ctx: FilterContext,
): ViewFilter | null {
  switch (key) {
    case 'due-this-week': {
      const start = addDays(ctx.today, -1);
      const end = addDays(ctx.today, 7);
      return { dueAfter: start, dueBefore: end, done: false };
    }
    case 'overdue':
      return { dueBefore: ctx.today, done: false };
    case 'assigned-to-me':
      if (!ctx.currentUser) return null;
      return { assignees: [ctx.currentUser] };
    case 'recurring':
      return { hasRrule: true };
  }
}

export interface FilterResult {
  visibleIds: Set<CardId>;
  counts: Record<SavedViewKey, number>;
  /** Total cards considered (excludes empty placeholders). */
  total: number;
}

/**
 * Run the user filter and pre-compute counts for every built-in saved
 * view. The pure function the caller batches into a memo; the keyed-by-
 * board+filter memoization at the call site (BoardRoot etc.) keeps the
 * cost negligible for boards up to several hundred cards.
 *
 * Placeholder cards (`text.trim() === ''`) are excluded from both the
 * visibility set and the counts — the user hasn't committed any content
 * yet, so they shouldn't show up in "Assigned to me 1" before the title
 * is even typed.
 */
export function filterCards(
  board: Board,
  filter: ViewFilter | undefined,
  ctx: FilterContext,
): FilterResult {
  const visibleIds = new Set<CardId>();
  const counts: Record<SavedViewKey, number> = {
    'due-this-week': 0,
    overdue: 0,
    'assigned-to-me': 0,
    recurring: 0,
  };
  const materialized: Record<SavedViewKey, ViewFilter | null> = {
    'due-this-week': materializeSavedView('due-this-week', ctx),
    overdue: materializeSavedView('overdue', ctx),
    'assigned-to-me': materializeSavedView('assigned-to-me', ctx),
    recurring: materializeSavedView('recurring', ctx),
  };
  let total = 0;
  for (const lane of board.lanes) {
    for (const card of lane.cards) {
      if (isPlaceholder(card)) continue;
      total++;
      if (matches(card, filter)) visibleIds.add(card.id);
      for (const key of SAVED_VIEW_KEYS) {
        const spec = materialized[key];
        if (spec !== null && matches(card, spec)) counts[key]++;
      }
    }
  }
  return { visibleIds, counts, total };
}

/**
 * Back-compat wrapper used by existing call sites that only need the
 * matched cards (no counts). New code should prefer `filterCards`.
 */
export function applyFilter(
  board: Board,
  filter: ViewFilter | undefined,
): FilterMatch[] {
  const out: FilterMatch[] = [];
  for (const lane of board.lanes) {
    for (const card of lane.cards) {
      if (isPlaceholder(card)) continue;
      if (matches(card, filter)) out.push({ card, lane });
    }
  }
  return out;
}

/**
 * `true` when the card has neither title nor body. Used to keep newly-
 * created placeholder cards out of saved-view counts until the user
 * commits content.
 */
function isPlaceholder(card: Card): boolean {
  return card.text.trim() === '';
}

function matches(card: Card, f: ViewFilter | undefined): boolean {
  if (!f) return true;
  if (f.text) {
    const needle = f.text.toLowerCase();
    if (!card.text.toLowerCase().includes(needle)) return false;
  }
  if (f.tags && f.tags.length) {
    const have = new Set(card.meta.tags);
    if (!f.tags.every((t) => have.has(t))) return false;
  }
  if (f.assignees && f.assignees.length) {
    const assignee = card.meta.fields['assignee'] ?? card.meta.fields['who'];
    if (!assignee) return false;
    if (!f.assignees.includes(assignee)) return false;
  }
  if (f.dueBefore) {
    const due = cardDue(card);
    if (!due) return false;
    if (due >= f.dueBefore) return false;
  }
  if (f.dueAfter) {
    const due = cardDue(card);
    if (!due) return false;
    if (due <= f.dueAfter) return false;
  }
  if (typeof f.done === 'boolean') {
    if (card.done !== f.done) return false;
  }
  if (typeof f.hasRrule === 'boolean') {
    const rrule = card.meta.fields['rrule'];
    const has = typeof rrule === 'string' && rrule.trim().length > 0;
    if (has !== f.hasRrule) return false;
  }
  return true;
}

/**
 * Add `days` calendar days to an ISO date `YYYY-MM-DD`. Negative values
 * subtract. Operates in UTC to avoid timezone-DST drift; the input is a
 * local-date midnight so the arithmetic is day-precise either way.
 */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The user's local-date midnight ISO. Caller passes this into
 * `FilterContext.today` so saved-view predicates use a stable value
 * during a render pass.
 */
export function localTodayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Stable string fingerprint of a filter, used by saved-view share URLs. */
export function encodeFilter(f: ViewFilter): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(f))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeFilter(s: string): ViewFilter | null {
  try {
    const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    return JSON.parse(decodeURIComponent(escape(atob(b64)))) as ViewFilter;
  } catch {
    return null;
  }
}
