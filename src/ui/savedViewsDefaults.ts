/**
 * Pre-seeded Saved Views surfaced as right-rail chips.
 *
 * Each entry is a stable id + display label + an _id-keyed_ predicate
 * resolver. The resolver is called at apply-time (not module load) so
 * date-relative filters like "Due this week" honour the current day,
 * not the bundle build date.
 *
 * The resolver returns a `ViewFilter`; the BoardRoot listener uses it
 * exactly the same way it uses a user-saved view's `filter`.
 */
import type { ViewFilter } from '@/core/model';

export interface DefaultSavedViewDef {
  id: string;
  label: string;
}

export const DEFAULT_SAVED_VIEW_DEFS: readonly DefaultSavedViewDef[] = [
  { id: 'due-this-week', label: 'Due this week' },
  { id: 'assigned-to-me', label: 'Assigned to me' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'recurring', label: 'Recurring' },
];

/** Format a Date as `YYYY-MM-DD` in the local timezone. */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Resolve the id of a pre-seeded view to a concrete `ViewFilter`.
 *
 * Mapping (each chosen to match what the chip's label promises):
 *
 *   - `due-this-week`  → `dueAfter = yesterday`, `dueBefore = +8 days`,
 *                        so cards with `meta.date` strictly within the
 *                        next 7 days (today through +7) match.
 *   - `overdue`        → `dueBefore = today`, `done = false`. Cards
 *                        with a date in the past that aren't done.
 *   - `assigned-to-me` → no canonical "me" identity in 1.0; we leave
 *                        the filter empty so the chip is non-destructive
 *                        until a future Pro pane lets the user set their
 *                        own assignee tag. BoardRoot renders the chip's
 *                        count as `0` while the predicate is empty, which
 *                        is the honest answer when no identity is set.
 *   - `recurring`      → `hasRrule: true` — match cards whose
 *                        `meta.fields.rrule` is a non-empty string. This
 *                        first-class predicate fixes a "Recurring N" count
 *                        inflation bug where the chip overcounted cards.
 */
export function resolveDefaultSavedViewFilter(
  def: DefaultSavedViewDef,
): ViewFilter {
  switch (def.id) {
    case 'due-this-week': {
      const today = new Date();
      // `dueAfter` is strict (card.date > value), so subtract one day so
      // today's date qualifies; `dueBefore` is strict (card.date < value),
      // so add one day past the 7-day window for inclusive coverage.
      const lower = isoDate(addDays(today, -1));
      const upper = isoDate(addDays(today, 8));
      return { dueAfter: lower, dueBefore: upper, done: false };
    }
    case 'overdue': {
      const today = new Date();
      return { dueBefore: isoDate(today), done: false };
    }
    case 'recurring':
      return { hasRrule: true };
    case 'assigned-to-me':
    default:
      return {};
  }
}
