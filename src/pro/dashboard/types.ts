/**
 * Dashboard query types.
 *
 * Operates over `VaultIndexEntry` rows produced by `@/core/vaultIndex` (Tech
 * Lead owns the indexer). The query engine is pure (filter + sort + limit)
 * so it can be reused in tests, dashboards, and a future Bases-backed
 * implementation.
 *
 * Re-declares the shape of VaultIndexEntry structurally; once the core
 * barrel ships, type imports from `@/core/vaultIndex` resolve to the
 * canonical definition and these align by shape.
 */

export interface VaultIndexEntryShape {
  path: string;
  title: string;
  laneCounts: Record<string, number>;
  totalCards: number;
  overdue: number;
  dueWithin7d: number;
  tags: Record<string, number>;
  modifiedAt: number;
}

export interface DashboardQuery {
  /** OR-semantics within the array: an entry matches if it has any tag in this list. */
  tags?: string[];
  /** ISO date; entries with modifiedAt strictly before this date pass. */
  dueBefore?: string;
  /** ISO date; entries with modifiedAt strictly after this date pass. */
  dueAfter?: string;
  /**
   *   'overdue'  → entry.overdue > 0
   *   'dueSoon'  → entry.dueWithin7d > 0
   *   'active'   → entry.totalCards > 0
   *   'all'      → no status filter
   */
  status?: 'overdue' | 'dueSoon' | 'active' | 'all';
  sortBy?: 'modifiedAt' | 'overdue' | 'title';
  /** Clamped to >= 0; 0 means "no entries". */
  limit?: number;
}

export interface BasesAdapter {
  /** True when the Bases plugin is detected and we can route a query through it. */
  available(): boolean;
  /**
   * Run a Bases query (or its kanban-projected equivalent) and return the
   * resulting rows. When `available()` is false, returns `[]`.
   *
   * The actual Bases query DSL is opaque to this layer — callers either pass
   * a Bases-native spec or a kanban-shaped one and the adapter does the
   * translation. v1 is a stub that defers until the Bases public API
   * stabilises.
   */
  query(spec: unknown): VaultIndexEntryShape[];
}
