/**
 * Cross-module contracts for UI consumption.
 *
 * UI components import the types the core and Pro modules own from
 * this file so that:
 *   1. Component code touches a single, stable type surface.
 *   2. If the upstream module isn't shipped at typecheck time, we degrade
 *      to a structural TODO stub here — the UI keeps compiling and the
 *      real types kick in transparently when the upstream module lands
 *      (the local TODO interfaces here are removed and the re-export
 *      from the upstream module replaces them).
 *
 * These may be extended by *shipping* the real types in the canonical
 * module — when that happens, delete the local fallback `interface`s here
 * and switch to `export type * from '@/...'`.
 *
 * Currently: templates is shipped; tracking/dashboard/vaultIndex are TODO
 * stubs. We import templates from its real module and keep local stubs for
 * the rest.
 */

import type { VaultIndexEntry } from '@/core/vaultIndex';

/* ---------------------------------------------------------------------------
 * Templates — real types live in src/core/templates/index.ts.
 * ------------------------------------------------------------------------- */
export type {
  BasicTemplate,
  ExpandedTemplate,
  ExpandContext,
  TemplateStore,
} from '@/core/templates';

/* ---------------------------------------------------------------------------
 * Vault index — real types live in src/core/vaultIndex.
 * Re-exported here so UI components import from a single surface.
 * ------------------------------------------------------------------------- */
export type { VaultIndex, VaultIndexEntry } from '@/core/vaultIndex';

/* ---------------------------------------------------------------------------
 * Dashboard query — the shipped query model the Dashboard UI (FilterBar +
 * Dashboard.tsx) is built against. It operates on the canonical
 * VaultIndexEntry shape. (Note: src/pro/dashboard/query.ts implements a
 * *different*, lower-level query model — dueBefore/dueAfter/limit — that no
 * UI consumes today; this is the one wired into the dashboard.)
 * ------------------------------------------------------------------------- */
export interface DashboardQuery {
  /** Free-text title fragment. */
  text?: string;
  /** Match boards containing ANY of these tags (#prefixed or bare). */
  tags?: string[];
  /** Due-window selector. */
  due?: 'all' | 'overdue' | 'soon' | 'none';
  /** Lane status selector — boards with at least one lane named like this. */
  status?: 'all' | 'active' | 'shipped';
  /** Sort key. */
  sort?: 'recent' | 'title' | 'overdue';
}

/** The dashboard's query engine: tag-any, due-window, status, and sort over
 *  canonical vault-index rows. This is the shipped implementation consumed by
 *  Dashboard.tsx — not a stub. */
export function executeQuery(
  entries: VaultIndexEntry[],
  q: DashboardQuery,
): VaultIndexEntry[] {
  const text = (q.text ?? '').trim().toLowerCase();
  const tags = (q.tags ?? []).map((t) => t.replace(/^#/, '').toLowerCase()).filter(Boolean);
  const due = q.due ?? 'all';
  const status = q.status ?? 'all';

  const filtered = entries.filter((e) => {
    if (text && !e.title.toLowerCase().includes(text)) return false;
    if (tags.length > 0) {
      const entryTagKeys = Object.keys(e.tags).map((t) => t.replace(/^#/, '').toLowerCase());
      if (!tags.some((t) => entryTagKeys.includes(t))) return false;
    }
    if (due === 'overdue' && e.overdue === 0) return false;
    if (due === 'soon' && e.dueWithin7d === 0) return false;
    if (due === 'none' && (e.overdue > 0 || e.dueWithin7d > 0)) return false;
    if (status === 'active') {
      const total = Object.values(e.laneCounts).reduce((a, b) => a + b, 0);
      if (total === 0) return false;
    }
    return true;
  });

  const sort = q.sort ?? 'recent';
  if (sort === 'recent') {
    filtered.sort((a, b) => b.modifiedAt - a.modifiedAt);
  } else if (sort === 'title') {
    filtered.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sort === 'overdue') {
    filtered.sort((a, b) => b.overdue - a.overdue);
  }
  return filtered;
}

/* ---------------------------------------------------------------------------
 * Time tracking — real types live in src/pro/tracking/types (shipped). Timer
 * boundaries are ISO strings (never durations) so they survive iOS background
 * suspension, avoiding mobile timer drift across suspend. Re-exported
 * here so UI components import from a single surface.
 * ------------------------------------------------------------------------- */
export type { TimerEntry, TrackingStore } from '@/pro/tracking/types';

/**
 * Inline duration formatter (UI helper — lives here, not in the store module,
 * because it's a presentation concern).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
