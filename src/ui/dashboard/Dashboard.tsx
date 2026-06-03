/**
 * Dashboard — multi-board roll-up surface.
 *
 * Composition:
 *   ┌────────────────────────────────────────────┐
 *   │  OverviewPanel (KPI cards)                 │
 *   ├────────────────────────────────────────────┤
 *   │  FilterBar (text, due, status, sort, tags) │
 *   ├────────────────────────────────────────────┤
 *   │  <ul> of BoardCard items                   │
 *   └────────────────────────────────────────────┘
 *
 * Pro gating is handled by the DashboardView wrapper. This
 * component is only mounted when the user is Pro and the view is open,
 * so we don't gate internally.
 *
 * Data path:
 *   vaultIndex (props) → subscribe via onChange → re-list entries →
 *     executeQuery(entries, query) → render
 *
 * `executeQuery` is imported from `@/ui/contracts` today (a stub
 * implementation). When Integrations ships `@/pro/dashboard/executeQuery`,
 * the import switches to that module.
 */
import * as React from 'react';
import { App } from 'obsidian';

import { OverviewPanel } from './OverviewPanel';
import { FilterBar } from './FilterBar';
import { BoardCard } from './BoardCard';
import {
  executeQuery,
  type DashboardQuery,
  type VaultIndex,
  type VaultIndexEntry,
} from '@/ui/contracts';

export interface DashboardProps {
  app: App;
  vaultIndex: VaultIndex;
  /** Initial query — typically from view state. */
  initialQuery?: DashboardQuery;
  /** Fired when the user mutates the query, so the host can persist it. */
  onQueryChange?: (q: DashboardQuery) => void;
}

const DEFAULT_QUERY: DashboardQuery = {
  text: '',
  tags: [],
  due: 'all',
  status: 'all',
  sort: 'recent',
};

function useEntries(index: VaultIndex): VaultIndexEntry[] {
  const [snapshot, setSnapshot] = React.useState<VaultIndexEntry[]>(() => index.list());
  React.useEffect(() => {
    const off = index.onChange(() => setSnapshot(index.list()));
    // Pull once on mount in case the index updated between createState and
    // the effect attaching.
    setSnapshot(index.list());
    return off;
  }, [index]);
  return snapshot;
}

export const Dashboard: React.FC<DashboardProps> = ({
  app,
  vaultIndex,
  initialQuery,
  onQueryChange,
}) => {
  const entries = useEntries(vaultIndex);
  const [query, setQuery] = React.useState<DashboardQuery>(
    initialQuery ?? DEFAULT_QUERY,
  );

  const setQueryAndEmit = React.useCallback(
    (next: DashboardQuery) => {
      setQuery(next);
      onQueryChange?.(next);
    },
    [onQueryChange],
  );

  const filtered = React.useMemo(
    () => executeQuery(entries, query),
    [entries, query],
  );

  const availableTags = React.useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      for (const t of Object.keys(e.tags)) set.add(t.replace(/^#/, ''));
    }
    return Array.from(set).sort();
  }, [entries]);

  const openBoard = React.useCallback(
    (path: string) => {
      // openLinkText handles the "create-if-missing" semantics; safe for
      // dashboard entries because the index never reports stale paths
      // longer than its rebuild interval.
      void app.workspace.openLinkText(path, '', false);
    },
    [app],
  );

  return (
    <div className="kp-dashboard kp-root">
      <header className="kp-dashboard__head">
        <h1 className="kp-dashboard__title">Kanban Dashboard</h1>
        <button
          type="button"
          className="kp-dashboard__refresh"
          onClick={() => void vaultIndex.rebuild()}
          aria-label="Rebuild dashboard index"
        >
          Rebuild index
        </button>
      </header>

      <OverviewPanel entries={entries} />

      <FilterBar
        value={query}
        onChange={setQueryAndEmit}
        availableTags={availableTags}
      />

      {filtered.length === 0 ? (
        <div className="kp-dashboard__empty">
          {entries.length === 0
            ? 'No kanban boards detected in this vault. Create one from the ribbon to populate the dashboard.'
            : 'No boards match the current filters.'}
        </div>
      ) : (
        <ul className="kp-dashboard__list" role="list">
          {filtered.map((entry) => (
            <BoardCard key={entry.path} entry={entry} onOpen={openBoard} />
          ))}
        </ul>
      )}
    </div>
  );
};

export default Dashboard;
