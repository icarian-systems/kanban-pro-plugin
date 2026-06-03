/**
 * TableRoot — flat tabular view of every card on the board.
 *
 * Columns: title · lane · due · tags · assignee · status.
 * Sorting: click a header to sort; click again to invert. Sort state is local
 *   to this component (not persisted to the file).
 * Filtering: Pro feature — a "Saved Views" filter chip in the toolbar. Gated
 *   via `useProGate`; free tier sees a PaywallCard instead.
 * Inline edit: click a title cell to edit. Other cells defer to DetailPanel.
 */
import * as React from 'react';
import { useProGate } from '@/pro/license/state';
import type { BoardStore } from '@/core/store';
import type { Card as CardModel, CardId, LaneId } from '@/core/model';
import { InlineEditor } from '@/ui/InlineEditor';
import { PaywallCard } from '@/ui/PaywallCard';
import { EmptyState } from '@/ui/banners/EmptyState';
import { useStoreSelector } from '@/ui/hooks/useStoreSelector';
import { stripInlineMetaTokens } from '@/core/parser/inlineMeta';
import { cardDue } from '@/core/model';

export interface TableRootProps {
  store: BoardStore;
  readOnly?: boolean;
  onOpenDetail: (cardId: CardId) => void;
}

type SortKey = 'title' | 'lane' | 'due' | 'assignee' | 'status';
type SortDir = 'asc' | 'desc';

interface TableRow {
  cardId: CardId;
  laneId: LaneId;
  laneTitle: string;
  card: CardModel;
}

/**
 * Derive the flat table projection. We CANNOT pass a fresh-array selector to
 * `useSyncExternalStore` — its snapshot must be `Object.is`-stable when the
 * underlying store hasn't moved, otherwise React throws "The result of
 * getSnapshot should be cached to avoid an infinite loop." (this was
 * the crash that wiped the view when the user clicked Table.)
 *
 * Strategy: subscribe to a primitive fingerprint (lane-id list joined to
 * card-id lists, plus per-card hash). When the fingerprint flips, rebuild
 * the rows from inside a `useMemo`. Both calls go through the same store
 * snapshot so the rows match the fingerprint.
 */
function useRows(store: BoardStore): TableRow[] {
  const fingerprint = useStoreSelector(store, React.useCallback(() => {
    // Lane IDs + per-lane card IDs + per-card hashes. The hash captures every
    // user-visible field on the card (text, done, meta, subtasks). When any
    // of those move, the fingerprint changes; otherwise it's reused and
    // useSyncExternalStore's tearing detection stays happy.
    const parts: string[] = [];
    const laneIds = store.selectLaneIds();
    for (const laneId of laneIds) {
      parts.push('L:', laneId);
      const lane = store.selectLane(laneId);
      if (lane) parts.push('|', lane.title ?? '');
      const cardIds = store.selectCardIds(laneId);
      for (const cardId of cardIds) {
        const card = store.selectCard(cardId);
        parts.push('C:', cardId, '#', card?.hash ?? '');
      }
      parts.push(';');
    }
    return parts.join('\x1f');
  }, [store]));

  return React.useMemo(() => {
    const rows: TableRow[] = [];
    // Defensive: a board mid-mutation may return an undefined lane or card
    // — skip silently rather than blowing up the whole table view.
    const laneIds = store.selectLaneIds?.() ?? [];
    for (const laneId of laneIds) {
      const lane = store.selectLane?.(laneId);
      if (!lane) continue;
      const cardIds = store.selectCardIds?.(laneId) ?? [];
      for (const cardId of cardIds) {
        const card = store.selectCard?.(cardId);
        if (!card) continue;
        rows.push({ cardId, laneId, laneTitle: lane.title ?? '', card });
      }
    }
    return rows;
  }, [store, fingerprint]);
}

function sortRows(rows: TableRow[], key: SortKey, dir: SortDir): TableRow[] {
  const mult = dir === 'asc' ? 1 : -1;
  const get = (row: TableRow): string => {
    // Defensive: the card's text/meta may be missing or undefined on
    // partially-loaded rows. Returning '' keeps the sort stable.
    const text = row.card?.text ?? '';
    switch (key) {
      case 'title': return stripInlineMetaTokens(text.split('\n')[0] ?? '');
      case 'lane': return row.laneTitle ?? '';
      case 'due': return row.card ? (cardDue(row.card) ?? '') : '';
      case 'assignee': return row.card?.meta?.fields?.assignee ?? '';
      case 'status': return row.card?.done ? 'done' : 'open';
    }
  };
  return [...rows].sort((a, b) => {
    const av = get(a).toLowerCase();
    const bv = get(b).toLowerCase();
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

const HeaderCell: React.FC<{
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}> = ({ label, k, sortKey, sortDir, onSort }) => {
  const isSorted = sortKey === k;
  return (
    <th
      className={`is-sortable${isSorted ? (sortDir === 'asc' ? ' is-sorted-asc' : ' is-sorted-desc') : ''}`}
      onClick={() => onSort(k)}
      aria-sort={isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(k);
        }
      }}
    >
      {label}
      <span className="kp-sort-ind" aria-hidden="true">{isSorted ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>
    </th>
  );
};

export const TableRoot: React.FC<TableRootProps> = ({ store, readOnly, onOpenDetail }) => {
  const rows = useRows(store);
  const [sortKey, setSortKey] = React.useState<SortKey>('lane');
  const [sortDir, setSortDir] = React.useState<SortDir>('asc');
  const [editingId, setEditingId] = React.useState<CardId | null>(null);
  const [showFilterPaywall, setShowFilterPaywall] = React.useState(false);
  const gate = useProGate();

  const onSort = React.useCallback(
    (k: SortKey) => {
      if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSortKey(k);
        setSortDir('asc');
      }
    },
    [sortKey],
  );

  const sorted = React.useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  if (rows.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="kp-table-root">
      <div className="kp-table-toolbar">
        {gate.tier === 'pro' ? (
          <button type="button" className="kp-control" aria-label="Saved views">
            Saved views
          </button>
        ) : (
          <button
            type="button"
            className="kp-control"
            onClick={() => setShowFilterPaywall((v) => !v)}
            aria-label="Saved views (Pro feature)"
          >
            Saved views <span className="kp-pro-chip">Pro</span>
          </button>
        )}
      </div>

      {showFilterPaywall && gate.tier !== 'pro' ? (
        <PaywallCard
          feature="Saved Views"
          description="Save filter combinations as named views, share them via obsidian:// links, and pin frequently-used ones to the rail."
          compact
        />
      ) : null}

      <table className="kp-table">
        <thead>
          <tr>
            <HeaderCell label="Title" k="title" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <HeaderCell label="Lane" k="lane" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <HeaderCell label="Due" k="due" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <th>Tags</th>
            <HeaderCell label="Assignee" k="assignee" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <HeaderCell label="Status" k="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            // Hardening: guard every dereference. A row whose card was
            // unmounted between fingerprint compute and render must not throw.
            const card = row.card;
            if (!card) return null;
            // strip recognized inline-meta tokens from the rendered
            // title; chips below already surface the same info.
            const title = stripInlineMetaTokens(
              (card.text ?? '').split('\n')[0] ?? '',
            );
            const tags = card.meta?.tags ?? [];
            return (
              <tr
                key={row.cardId}
                // emit the data-card-id so BoardRoot's CSS-injected
                // filter (HiddenCardsStyle) hides rows whose card isn't in
                // the current visibleIds set. The selector targets any
                // descendant with this attribute, so the row vanishes from
                // Table view in lock-step with Board view.
                data-card-id={row.cardId}
                className={card.done ? 'is-done' : undefined}
                onDoubleClick={() => onOpenDetail(row.cardId)}
              >
                <td>
                  {editingId === row.cardId ? (
                    <InlineEditor
                      cardId={row.cardId}
                      initialValue={card.text}
                      singleLine
                      autoFocus
                      onCommit={(next) => {
                        store.editCard?.(row.cardId, { text: next });
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="kp-table-cell-title"
                      onClick={() => !readOnly && setEditingId(row.cardId)}
                      aria-label={`Edit ${title || 'card'}`}
                    >
                      {title || (
                        <span className="kp-table-cell-title--empty">Untitled</span>
                      )}
                    </button>
                  )}
                </td>
                <td><span className="kp-table-cell-lane">{row.laneTitle ?? ''}</span></td>
                <td>{cardDue(card) ?? ''}</td>
                <td>
                  <span className="kp-table-cell-meta">
                    {tags.map((tag) => (
                      <span key={tag} className="kp-tag">{tag.replace(/^#/, '')}</span>
                    ))}
                  </span>
                </td>
                <td>{card.meta?.fields?.assignee ?? ''}</td>
                <td>
                  <button
                    type="button"
                    className={`kp-status-toggle${card.done ? ' is-done' : ''}`}
                    aria-pressed={card.done}
                    aria-label={card.done ? 'Mark not done' : 'Mark done'}
                    disabled={readOnly}
                    onClick={(e) => {
                      // Don't bubble to the row's dbl-click / future row
                      // handlers — the toggle is its own affordance.
                      e.stopPropagation();
                      if (readOnly) return;
                      store.toggleCardDone?.(row.cardId);
                    }}
                    onDoubleClick={(e) => {
                      // Prevent the row's onDoubleClick from opening the
                      // detail panel when the user double-clicks the
                      // toggle.
                      e.stopPropagation();
                    }}
                  >
                    {card.done ? 'Done' : 'Open'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
