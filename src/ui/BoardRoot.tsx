/**
 * BoardRoot — UI entry point. Mounted by `KanbanView` inside the leaf's
 * `containerEl`.
 *
 * Composition:
 *   <MarkdownHostProvider>
 *     <DnDProvider>
 *       <div class="kp-shell">
 *         <main class="kp-root kp-board">
 *           <header class="kp-masthead">…</header>
 *           <nav class="kp-subnav">…</nav>
 *           <BoardView | TableRoot | ListRoot />
 *         </main>
 *         <RightRail />
 *       </div>
 *       <DetailPanel />   (overlay)
 *     </DnDProvider>
 *   </MarkdownHostProvider>
 *
 * --------------------------------------------------------------------------
 * SELECTOR DISCIPLINE (do not break — read this before touching anything):
 *
 *   This file (and every component under it) reads board state via the
 *   selectors exposed by `src/core/store.ts`:
 *       store.selectLaneIds()                : LaneId[]
 *       store.selectCardIds(laneId)          : CardId[]
 *       store.selectCard(cardId)             : Card | undefined
 *       store.selectLane(laneId)             : Lane | undefined
 *       store.selectBoardMeta()              : { title, cardCount, ... }
 *       store.selectMode()                   : ViewMode
 *
 *   Subscriptions go through `useSyncExternalStore` against
 *   `store.subscribe(listener) => unsubscribe`. We NEVER bind to
 *   `state.board` directly or pass object references through React state —
 *   that pattern caused the incumbent's whole-board re-render problem.
 * --------------------------------------------------------------------------
 *
 * STORE CONTRACT consumed (implemented in `src/core/store.ts`):
 *
 *   // selectors
 *   selectLaneIds(): LaneId[]
 *   selectCardIds(laneId): CardId[]
 *   selectCard(cardId): Card | undefined
 *   selectLane(laneId): Lane | undefined
 *   selectBoardMeta(): { title: string; cardCount: number; laneCount: number; editedAt?: string }
 *   selectMode(): ViewMode
 *   isReadOnly?(): boolean
 *
 *   // subscriptions
 *   subscribe(cb: () => void): () => void
 *
 *   // card actions (all optional from UI perspective — UI tolerates undefined)
 *   editCard(cardId, patch: Partial<Card>): void
 *   toggleCardDone(cardId): void
 *   addCard(laneId, text?: string): CardId
 *   deleteCard(cardId): void
 *   addLane(): LaneId
 *
 *   // subtask actions
 *   toggleSubtask(cardId, subtaskId): void
 *   editSubtask(cardId, subtaskId, text): void
 *   addSubtask(cardId, text): void
 *   deleteSubtask(cardId, subtaskId): void
 *
 *   // mode
 *   setMode(mode: ViewMode): void
 *
 *   // gesture API (DnDProvider drives this)
 *   beginGesture(): void
 *   moveCardOptimistic(cardId, toLaneId, toIndex): void
 *   commitGesture(): void
 *   cancelGesture(): void
 */
import * as React from 'react';
import { Notice, type App, type Component } from 'obsidian';
import { cardDue, type CardId, type ViewFilter, type ViewMode } from '@/core/model';
import type { BoardStore } from '@/core/store';
import { applyFilter } from '@/pro/savedViews/filter';
import type { SavedViewStore } from '@/pro/savedViews/store';
import { MarkdownHostProvider } from '@/ui/MarkdownHost';
import { DnDProvider } from '@/ui/DnDProvider';
import { BoardView } from '@/ui/BoardView';
import { TableRoot } from '@/ui/TableRoot';
import { ListRoot } from '@/ui/ListRoot';
import { DetailPanel } from '@/ui/DetailPanel';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useStoreSelector } from '@/ui/hooks/useStoreSelector';
import { Breadcrumb } from '@/ui/Breadcrumb';
import { FilterChip } from '@/ui/FilterChip';
import { FilterPopover } from '@/ui/FilterPopover';
import { SearchOverlay } from '@/ui/SearchOverlay';
import { RightRail } from '@/ui/RightRail';
import { SubnavPopover } from '@/ui/SubnavPopover';
import { SavedViewsProvider } from '@/ui/SavedViewsContext';
import { SavedViewsPicker } from '@/ui/SavedViewsPicker';
import { DEFAULT_SAVED_VIEW_DEFS, resolveDefaultSavedViewFilter } from '@/ui/savedViewsDefaults';
import { useProGate } from '@/pro/license/state';
import { KANBAN_PRO_PLUGIN_ID } from '@/shared/pluginMeta';
import { TrackingPanel } from '@/ui/TrackingPanel';

export interface BoardRootProps {
  store: BoardStore;
  /** Obsidian App. Provided by `KanbanView`. */
  app: App;
  /** Long-lived Component (the view) for MarkdownRenderer child registration. */
  viewComponent: Component;
  /** Initial / current view mode. */
  mode: ViewMode;
  readOnly?: boolean;
  /** When true (and readOnly is true), embeds permit DnD / inline edits. */
  allowEmbedEdit?: boolean;
  /** Banner content shown above the board (read-only / sync recovery / etc). */
  banner?: React.ReactNode;
  /** Path of the source markdown file, for link resolution in MarkdownReadView. */
  sourcePath?: string;
  /**
   * Saved Views store (Pro v1.0). Plugin-owned per `main.ts`. Optional so
   * embeds and isolated tests can mount without the full plugin wiring —
   * the picker simply renders an empty list and the right-rail chips
   * still apply their pre-seeded filters via the apply-saved-view event.
   */
  savedViewStore?: SavedViewStore | null;
}

function useMode(store: BoardStore, fallback: ViewMode): ViewMode {
  return useStoreSelector(store, React.useCallback(
    () => store.selectMode?.() ?? fallback,
    [store, fallback],
  ));
}

// Board meta is sub-selected as primitives below — selectBoardMeta() returns
// a fresh object on every call, so subscribing to it directly would defeat
// the granular-rerender discipline.
function useBoardTitle(store: BoardStore): string {
  return useStoreSelector(store, React.useCallback(
    () => store.selectBoardMeta?.().title ?? '',
    [store],
  ));
}
function useBoardCardCount(store: BoardStore): number {
  return useStoreSelector(store, React.useCallback(
    () => store.selectBoardMeta?.().cardCount ?? 0,
    [store],
  ));
}
function useBoardLaneCount(store: BoardStore): number {
  return useStoreSelector(store, React.useCallback(
    () => store.selectBoardMeta?.().laneCount ?? 0,
    [store],
  ));
}
function useBoardEditedAt(store: BoardStore): string | undefined {
  return useStoreSelector(store, React.useCallback(
    () => store.selectBoardMeta?.().editedAt,
    [store],
  ));
}

/**
 * Subscription helper: returns a primitive fingerprint of the board's
 * filter-relevant fields (text, tags, assignee, due date, done). The
 * selector contract permits primitives, so this is safe — we only
 * re-render when one of those values changes. We deliberately keep the
 * fingerprint cheap: a tagged string per card, joined.
 *
 * The component then re-derives the filter results in a `useMemo` keyed
 * off this fingerprint. This is the same pattern Table/List use when
 * they need a view over the whole board without subscribing to its ref.
 */
function useFilterFingerprint(store: BoardStore): string {
  return useStoreSelector(
    store,
    React.useCallback(() => {
      const board = store.getState?.().board;
      if (!board) return '';
      const parts: string[] = [];
      for (const lane of board.lanes) {
        for (const card of lane.cards) {
          // Short fields only; text-substring matching uses card.text
          // length as a proxy (any edit changes the length or content).
          // We append a hash-like join: id + length + tags + assignee + date + done.
          const assignee = card.meta.fields['assignee'] ?? card.meta.fields['who'] ?? '';
          parts.push(
            card.id
              + ':' + card.text.length
              + ':' + card.text
              + '|t=' + card.meta.tags.join(',')
              + '|a=' + assignee
              + '|d=' + (cardDue(card) ?? '')
              + '|r=' + (card.meta.fields['rrule'] ?? '')
              + '|x=' + (card.done ? '1' : '0'),
          );
        }
      }
      return parts.join(';');
    }, [store]),
  );
}

/**
 * Compute a friendly title-fallback from the file path when the in-memory
 * title is empty. Mirrors the discipline in `Breadcrumb.deriveSegments`:
 * basename minus extension; never the raw vault path.
 */
function basenameFromPath(sourcePath?: string): string {
  if (!sourcePath) return '';
  const parts = sourcePath.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1];
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/**
 * Masthead — breadcrumb, board title, card/lane counts, last-edited timestamp.
 * Class names follow the established naming convention so the stylesheet
 * (styles.css) applies cleanly.
 */
const Masthead: React.FC<{
  store: BoardStore;
  sourcePath?: string;
  /** When a filter is active, show the matching-card count instead of the total. */
  filterActive?: boolean;
  visibleCardCount?: number;
}> = ({
  store,
  sourcePath,
  filterActive,
  visibleCardCount,
}) => {
  const title = useBoardTitle(store);
  const cardCount = useBoardCardCount(store);
  const laneCount = useBoardLaneCount(store);
  const editedAt = useBoardEditedAt(store);
  // When filtering, the headline count reflects what's visible (e.g.
  // "2 of 15") so it doesn't contradict the narrowed board (#6).
  const shownCardCount = filterActive ? (visibleCardCount ?? cardCount) : cardCount;
  // `1 card · 1 lane` (singular/plural + middle-dot separator), no
  // concatenation against the previous span.
  const cardLabel = shownCardCount === 1 ? 'card' : 'cards';
  const laneLabel = laneCount === 1 ? 'lane' : 'lanes';
  const fallbackTitle = basenameFromPath(sourcePath);
  const displayTitle = title || fallbackTitle || 'Untitled board';
  return (
    <header className="kp-masthead">
      <div className="kp-masthead-left">
        <Breadcrumb sourcePath={sourcePath} fallbackLabel={displayTitle} />
        <h1 className="kp-board-title">{displayTitle}</h1>
      </div>
      <div className="kp-masthead-meta">
        <div className="kp-row">
          <span>
            <strong>{shownCardCount}</strong>
            {filterActive ? <> of {cardCount}</> : null} {cardLabel}
          </span>
          <span className="kp-dot" aria-hidden="true" />
          <span><strong>{laneCount}</strong> {laneLabel}</span>
          {editedAt ? (
            <>
              <span className="kp-dot" aria-hidden="true" />
              <span>Edited <strong>{editedAt}</strong></span>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
};

const ViewTab: React.FC<{
  mode: ViewMode | 'dashboard';
  current: ViewMode;
  onSelect: (m: ViewMode | 'dashboard') => void;
  label: string;
  count?: number;
  icon: React.ReactNode;
  /** When true, mark the tab as Pro-gated and append a `Pro` chip for free users. */
  pro?: boolean;
  proTier?: boolean;
}> = ({ mode, current, onSelect, label, count, icon, pro, proTier }) => {
  const isActive = mode === current;
  const showProChip = Boolean(pro && !proTier);
  // Pro-gated tab on Free tier shows a lock icon + PRO chip so the
  // gating is visible at a glance. The click opens the paywall leaf
  // instead of routing to Settings, so the disabled-feel was
  // misleading; we explicitly mark it as locked instead.
  const isProLocked = Boolean(pro && !proTier);
  const tooltip = isProLocked
    ? `${label} is a Pro feature — opens the upgrade preview`
    : undefined;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-label={
        count != null
          ? `${label} (${count})${isProLocked ? ' — Pro feature, locked' : ''}`
          : `${label}${isProLocked ? ' — Pro feature, locked' : ''}`
      }
      tabIndex={isActive ? 0 : -1}
      className={`kp-view-tab${isActive ? ' is-active' : ''}${pro ? ' is-pro' : ''}${isProLocked ? ' is-pro-locked' : ''}`}
      onClick={() => onSelect(mode)}
      title={tooltip}
    >
      {icon}
      {/* F8 — keep label and count as two distinct nodes with whitespace
          between them so the rendered text reads "Board 17", not "Board1". */}
      <span className="kp-view-tab__label">{label}</span>
      {count != null ? <span className="kp-ct" aria-hidden="true">{count}</span> : null}
      {isProLocked ? (
        <svg
          className="kp-view-tab__lock"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          aria-hidden="true"
        >
          <rect x="3" y="6.5" width="8" height="5" rx="0.8" />
          <path d="M5 6.5V4.5a2 2 0 014 0v2" />
        </svg>
      ) : null}
      {showProChip ? (
        <span className="kp-pro-chip" aria-label="Pro feature">Pro</span>
      ) : null}
    </button>
  );
};

const DASHBOARD_OPEN_EVENT = 'kanban-pro:open-dashboard';
const VIEWS_OPEN_EVENT = 'kanban-pro:open-views';
const SEARCH_OPEN_EVENT = 'kanban-pro:open-search';
const VIEWS_PICKER_EVENT = 'kanban-pro:open-views-picker';
// Obsidian namespaces commands as `<manifestId>:<commandId>`. The manifest
// id is `kanban-pro-boards` (NOT the view type `kanban-pro`); the old
// hard-coded `kanban-pro:…` prefix never resolved, so the toolbar button
// silently no-op'd. Derive the prefix from the shared constant.
const OPEN_DASHBOARD_COMMAND = `${KANBAN_PRO_PLUGIN_ID}:kanban-pro-open-dashboard`;

/**
 * Open the Dashboard. Free and Pro users both land in the same place (a
 * `DashboardView` tab) — the view handles the Free-tier paywall rendering,
 * so we no longer route the subnav tab to Settings.
 *
 * We try the command first (so a user-assigned hotkey path stays exercised),
 * but treat ONLY an explicit `true` as success — the private
 * `executeCommandById` returns `undefined` for an unknown id, which the old
 * `ok !== false` check mistook for success and swallowed. The window event
 * is the reliable path: `main.ts` listens for it and calls `openDashboard()`
 * directly.
 */
function openDashboardLeaf(app: App): void {
  type CommandsHost = { commands?: { executeCommandById?: (id: string) => boolean | undefined } };
  const commands = (app as unknown as CommandsHost).commands;
  const exec = commands?.executeCommandById;
  if (typeof exec === 'function') {
    const ok = exec.call(commands, OPEN_DASHBOARD_COMMAND);
    if (ok === true) return;
  }
  // Reliable fallback — main.ts owns the actual open via this event.
  window.dispatchEvent(new CustomEvent(DASHBOARD_OPEN_EVENT));
}

interface SubnavProps {
  store: BoardStore;
  current: ViewMode;
  app: App;
  filter: ViewFilter;
  onFilterChange: (next: ViewFilter) => void;
  searchText: string;
  onSearchChange: (next: string) => void;
  availableTags: readonly string[];
  availableAssignees: readonly string[];
  matchCount: number;
  filterDescription: string;
  filterActive: boolean;
  /** Whether the parent currently has anything filter-shaped to save. */
  currentFilterIsEmpty: boolean;
}

const Subnav: React.FC<SubnavProps> = ({
  store,
  current,
  app,
  filter,
  onFilterChange,
  searchText,
  onSearchChange,
  availableTags,
  availableAssignees,
  matchCount,
  filterDescription,
  filterActive,
  currentFilterIsEmpty,
}) => {
  const cardCount = useBoardCardCount(store);
  const gate = useProGate();
  const isPro = gate.tier === 'pro';

  // Views (Pro) keeps its existing stub for v1; Filter and Search
  // open functional UIs. Dashboard tab routes through the
  // Open Dashboard command so the subnav and command always
  // land in the same place.
  const [viewsOpen, setViewsOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  // Anchor refs so each popover's outside-click handler ignores clicks on
  // its own trigger (the trigger owns the open/close toggle). Without this
  // the trigger click and the capture-phase outside-mousedown race and the
  // popover gets stuck (P3 — "Views popover won't reopen").
  const viewsAnchorRef = React.useRef<HTMLDivElement | null>(null);
  const searchAnchorRef = React.useRef<HTMLDivElement | null>(null);

  const onSelect = React.useCallback(
    (m: ViewMode | 'dashboard') => {
      if (m === 'dashboard') {
        // open the Dashboard leaf (paywall on Free) instead of
        // sending the user to Settings. Free and Pro now match the
        // command-palette outcome.
        openDashboardLeaf(app);
        return;
      }
      store.setMode?.(m);
    },
    [store, app],
  );

  const onViewsClick = React.useCallback(() => {
    // Always emit the legacy event so any external listener can observe
    // it. Then branch on tier: Free users get a paywall feel (Notice +
    // Pro-settings dispatch); Pro users get the Saved Views picker popover.
    window.dispatchEvent(new CustomEvent(VIEWS_OPEN_EVENT));
    if (!isPro) {
      new Notice('Saved Views is a Pro feature.');
      window.dispatchEvent(
        new CustomEvent('kanban-pro:open-pro-settings', { detail: { feature: 'Saved Views' } }),
      );
      return;
    }
    window.dispatchEvent(new CustomEvent(VIEWS_PICKER_EVENT));
    setViewsOpen((v) => !v);
  }, [isPro]);

  const onSearchClick = React.useCallback(() => {
    window.dispatchEvent(new CustomEvent(SEARCH_OPEN_EVENT));
    setSearchOpen((v) => !v);
  }, []);

  const closeViews = React.useCallback(() => setViewsOpen(false), []);
  const closeSearch = React.useCallback(() => setSearchOpen(false), []);

  return (
    <nav className="kp-subnav" aria-label="View modes">
      <div className="kp-view-tabs" role="tablist" aria-label="Board view modes">
        <ViewTab
          mode="board"
          current={current}
          onSelect={onSelect}
          label="Board"
          count={cardCount}
          icon={
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4}>
              <rect x="2" y="3" width="2.5" height="8" rx="0.4" />
              <rect x="5.5" y="3" width="2.5" height="6" rx="0.4" />
              <rect x="9" y="3" width="2.5" height="4" rx="0.4" />
            </svg>
          }
        />
        <ViewTab
          mode="table"
          current={current}
          onSelect={onSelect}
          label="Table"
          icon={
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4}>
              <rect x="2" y="3" width="10" height="8" rx="0.6" />
              <path d="M2 6h10M2 9h10M6 6v5" />
            </svg>
          }
        />
        <ViewTab
          mode="list"
          current={current}
          onSelect={onSelect}
          label="List"
          icon={
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4}>
              <path d="M3 4h8M3 7h8M3 10h5" />
            </svg>
          }
        />
        <ViewTab
          mode="dashboard"
          current={current}
          onSelect={onSelect}
          label="Dashboard"
          pro
          proTier={isPro}
          icon={
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4}>
              <rect x="2" y="3" width="4" height="4" rx="0.4" />
              <rect x="8" y="3" width="4" height="4" rx="0.4" />
              <rect x="2" y="8" width="4" height="3" rx="0.4" />
              <rect x="8" y="8" width="4" height="3" rx="0.4" />
            </svg>
          }
        />
      </div>

      <div className="kp-subnav-divider" aria-hidden="true" />

      <FilterChip
        description={filterDescription}
        active={filterActive}
        renderBody={({ close }) => (
          <FilterPopover
            value={filter}
            onChange={onFilterChange}
            availableTags={availableTags}
            availableAssignees={availableAssignees}
            onClear={() => {
              onFilterChange({});
              close();
            }}
            onApply={close}
          />
        )}
      />

      <div className="kp-subnav-spacer" />

      <div className="kp-popover-anchor" ref={viewsAnchorRef}>
        <button
          type="button"
          className={`kp-control${viewsOpen ? ' is-open' : ''}${!isPro ? ' is-pro-locked' : ''}`}
          onClick={onViewsClick}
          aria-label="Open views"
          aria-expanded={viewsOpen}
          aria-haspopup="dialog"
          title={isPro ? 'Open saved views' : 'Saved Views is a Pro feature'}
        >
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
            <path d="M2 3v9l4-2.5 4 2.5V3z" />
          </svg>
          Views
          {!isPro ? (
            <span className="kp-pro-chip" aria-label="Pro feature">Pro</span>
          ) : null}
        </button>
        <SubnavPopover
          open={viewsOpen}
          onClose={closeViews}
          title="Saved Views"
          labelId="kp-views-popover-title"
          anchor="right"
          ignoreRef={viewsAnchorRef}
        >
          <SavedViewsPicker
            app={app}
            currentFilter={filter}
            currentFilterIsEmpty={currentFilterIsEmpty}
            onSaved={() => {
              new Notice('Saved view added.');
              // Keep the popover open so users see the new entry land
              // in the list — confirms the save without forcing them to
              // re-open the picker.
            }}
            onApplied={() => {
              // Close after apply so the board surface returns to focus.
              closeViews();
            }}
          />
        </SubnavPopover>
      </div>

      <div className="kp-popover-anchor" ref={searchAnchorRef}>
        <button
          type="button"
          className={`kp-control${searchOpen ? ' is-open' : ''}${searchText.trim() ? ' is-active' : ''}`}
          onClick={onSearchClick}
          aria-label="Open search"
          aria-expanded={searchOpen}
          aria-haspopup="dialog"
          title="Search cards"
        >
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
            <circle cx="6" cy="6" r="3.5" />
            <path d="M9 9l3 3" />
          </svg>
          Search
          {searchText.trim() ? (
            <span className="kp-search-count" aria-hidden="true">{matchCount}</span>
          ) : null}
        </button>
        <SubnavPopover
          open={searchOpen}
          onClose={closeSearch}
          title="Search cards"
          labelId="kp-search-popover-title"
          anchor="right"
          ignoreRef={searchAnchorRef}
        >
          <SearchOverlay
            value={searchText}
            onChange={onSearchChange}
            matchCount={matchCount}
            onClear={() => {
              onSearchChange('');
            }}
          />
        </SubnavPopover>
      </div>
    </nav>
  );
};

/**
 * Build a short, human-readable summary of the active filter for the
 * subnav chip. Examples: "all", "tag:bug", "2 tags · 1 assignee",
 * "due ≤ 7d", "open".
 * The summary intentionally stays under ~30 chars so the chip width
 * doesn't break the subnav layout.
 *
 * A previous version omitted `dueAfter` and
 * `done`, so the pre-seeded "Overdue" and "Due this week" views — both of
 * which set those dimensions — collapsed to a partial label that hid the
 * fact the filter was set. We now describe every dimension the filter
 * engine actually applies (see `applyFilter` in `src/pro/savedViews/filter.ts`),
 * and collapse a contiguous `dueAfter`+`dueBefore` window into a relative
 * `due ≤ Nd` shorthand when the upper bound is within 60 days of today
 * (otherwise we fall back to absolute dates).
 *
 * Exported for the regression test in
 * `src/ui/__tests__/describeFilter.test.ts`; not intended for general use.
 */
export function describeFilter(filter: ViewFilter, searchText: string): string {
  const parts: string[] = [];
  if (searchText.trim()) parts.push(`search:"${searchText.trim().slice(0, 12)}"`);
  if (filter.tags && filter.tags.length) {
    if (filter.tags.length === 1) parts.push(`#${filter.tags[0]}`);
    else parts.push(`${filter.tags.length} tags`);
  }
  if (filter.assignees && filter.assignees.length) {
    if (filter.assignees.length === 1) parts.push(`@${filter.assignees[0]}`);
    else parts.push(`${filter.assignees.length} assignees`);
  }
  const dueLabel = describeDueWindow(filter.dueAfter, filter.dueBefore);
  if (dueLabel) parts.push(dueLabel);
  if (typeof filter.done === 'boolean') {
    parts.push(filter.done ? 'done' : 'open');
  }
  if (parts.length === 0) return 'all';
  return parts.join(' · ');
}

/**
 * Format the `dueAfter` + `dueBefore` pair into a chip-friendly window.
 * Returns:
 *   - undefined if neither is set
 *   - `due > <after>` / `due < <before>` if only one side is set
 *   - `due ≤ Nd` if both are set and the upper bound is ≤60 days from today
 *     (the relative shorthand form)
 *   - `due > <after> · due < <before>` for explicit absolute windows
 */
function describeDueWindow(after?: string, before?: string): string | undefined {
  if (!after && !before) return undefined;
  if (after && !before) return `due > ${after}`;
  if (!after && before) return `due < ${before}`;
  // Both set: try the relative shorthand.
  const upper = parseIsoDate(before!);
  if (upper) {
    const today = startOfDay(new Date());
    const days = Math.round((upper.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    if (days > 0 && days <= 60) return `due ≤ ${days}d`;
  }
  return `due > ${after} · due < ${before}`;
}

function parseIsoDate(s: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isFilterEmpty(filter: ViewFilter, searchText: string): boolean {
  if (searchText.trim()) return false;
  if (filter.tags && filter.tags.length) return false;
  if (filter.assignees && filter.assignees.length) return false;
  if (filter.dueBefore) return false;
  if (filter.dueAfter) return false;
  if (typeof filter.done === 'boolean') return false;
  if (filter.text && filter.text.trim()) return false;
  return true;
}

/**
 * Hidden-cards CSS injector. Renders a `<style>` block that hides every
 * card NOT in the `visibleCardIds` set. We do it in CSS instead of
 * intercepting Column/Card rendering so we don't have to reach into
 * the Column/Card components (the selector contract there is fragile).
 *
 * The CSS uses `:not([data-card-id="…"])` for each visible ID. For 1000+
 * cards this would be expensive; in practice 99% of boards have < 200
 * cards so the selector cost is negligible. If we ever hit a board big
 * enough for this to matter, we can swap to inlining `display:none`
 * styles via a portal-injected rule per card-id instead.
 */
const HiddenCardsStyle: React.FC<{
  totalCardIds: readonly CardId[];
  visibleCardIds: ReadonlySet<CardId>;
  scopeId: string;
}> = ({ totalCardIds, visibleCardIds, scopeId }) => {
  if (visibleCardIds.size === totalCardIds.length) return null;
  // Build per-id `display:none` rules for hidden cards. Cheap and stable
  // (no `:not` chain explosion).
  const lines: string[] = [];
  for (const id of totalCardIds) {
    if (!visibleCardIds.has(id)) {
      const safe = id.replace(/"/g, '\\"');
      lines.push(`[data-kp-filter-scope="${scopeId}"] [data-card-id="${safe}"]{display:none !important;}`);
    }
  }
  const css = lines.join('\n');
  return <style data-kp-filter-style={scopeId}>{css}</style>;
};

export const BoardRoot: React.FC<BoardRootProps> = ({
  store,
  app,
  viewComponent,
  mode: initialMode,
  readOnly = false,
  allowEmbedEdit = false,
  banner,
  sourcePath,
  savedViewStore = null,
}) => {
  const mode = useMode(store, initialMode);
  const effectiveReadOnly = readOnly && !allowEmbedEdit;

  const [detailCardId, setDetailCardId] = React.useState<CardId | null>(null);
  const onOpenDetail = React.useCallback((id: CardId) => setDetailCardId(id), []);
  const onCloseDetail = React.useCallback(() => setDetailCardId(null), []);

  // Time-tracking history drawer (Pro). The card chip's long-press and the
  // right-rail "Details" button both dispatch `kanban-pro:open-tracking-panel`
  // — but nothing was listening, so the drawer never opened (P1). Own it here
  // as a sibling of DetailPanel; BoardRoot already sits inside the
  // TrackingProvider context, so <TrackingPanel> can reach the store.
  const [trackingCardId, setTrackingCardId] = React.useState<CardId | null>(null);
  const onCloseTracking = React.useCallback(() => setTrackingCardId(null), []);
  React.useEffect(() => {
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ cardId?: string }>).detail;
      if (detail?.cardId) setTrackingCardId(detail.cardId);
    };
    window.addEventListener('kanban-pro:open-tracking-panel', handler);
    return () => window.removeEventListener('kanban-pro:open-tracking-panel', handler);
  }, []);

  // Filter and Search state lives on BoardRoot so it survives view-mode
  // switches (Board ↔ Table ↔ List). The filter engine itself comes from
  // src/pro/savedViews/filter.ts (a Free feature). Embeds
  // don't get a filter — the subnav is only rendered on full leaves and
  // each embed has its own isolated BoardRoot anyway.
  const [filter, setFilter] = React.useState<ViewFilter>({});
  const [searchText, setSearchText] = React.useState('');
  /**
   * Name of the most-recently-applied saved view, displayed alongside
   * the filter chip's summary. Cleared when the user mutates the filter
   * directly (so the chip doesn't lie about which view is active after
   * a tag toggle inside a saved-view session). Also tracks the active
   * saved-view *id* so the rail can highlight the matching chip and
   * toggle-off on a second click.
   */
  const [activeSavedViewName, setActiveSavedViewName] = React.useState<string | null>(null);
  const [activeSavedViewId, setActiveSavedViewId] = React.useState<string | null>(null);

  // `kanban-pro:apply-saved-view` is dispatched by both the
  // SavedViewsPicker rows (user-saved) and the RightRail chips
  // (pre-seeded DEFAULT_VIEWS). The listener unifies both paths: look the
  // filter up by id (saved-view store first, defaults table second), then
  // commit it to BoardRoot's `filter` state. The hidden-cards CSS picks
  // it up on the next render because `visibleCardIds` is memoized off
  // `filter` + the board fingerprint.
  React.useEffect(() => {
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<{
        id?: string | null;
        filter?: ViewFilter;
        name?: string;
      }>).detail;
      // `id: null` (or missing detail entirely) clears the active saved
      // view — rail uses this to toggle off the active chip.
      if (!detail || detail.id === null) {
        setFilter({});
        setSearchText('');
        setActiveSavedViewName(null);
        setActiveSavedViewId(null);
        return;
      }
      let nextFilter: ViewFilter | undefined;
      let nextName: string | null = null;
      let nextId: string | null = null;
      // 1. Inline filter on the event itself wins (caller already
      //    resolved the predicate — usually the picker passing a
      //    SavedView object). This lets the picker remain
      //    SavedViewStore-aware without forcing BoardRoot to re-look-up.
      if (detail.filter && typeof detail.filter === 'object') {
        nextFilter = detail.filter;
        nextName = detail.name ?? null;
        nextId = detail.id ?? null;
      } else if (detail.id) {
        // 2. Look up by id against the SavedViewStore.
        const saved = savedViewStore?.get(detail.id);
        if (saved) {
          nextFilter = saved.filter;
          nextName = saved.name;
          nextId = detail.id;
        } else {
          // 3. Fall back to the pre-seeded DEFAULT_VIEWS table.
          const seed = DEFAULT_SAVED_VIEW_DEFS.find((d) => d.id === detail.id);
          if (seed) {
            nextFilter = resolveDefaultSavedViewFilter(seed);
            nextName = seed.label;
            nextId = seed.id;
          }
        }
      }
      if (!nextFilter) return;
      setFilter(nextFilter);
      // Saved views set their own text query rather than overlaying on
      // top of an in-flight search — clear `searchText` so the visible
      // count reflects only the saved-view's predicate.
      setSearchText('');
      setActiveSavedViewName(nextName);
      setActiveSavedViewId(nextId);
    };
    window.addEventListener('kanban-pro:apply-saved-view', handler);
    return () => {
      window.removeEventListener('kanban-pro:apply-saved-view', handler);
    };
  }, [savedViewStore]);

  // When the user mutates the filter directly (FilterPopover) or types in
  // the search box, the saved-view label is no longer accurate. Clear it
  // so the chip doesn't pretend the user is still inside that view.
  const handleFilterChange = React.useCallback((next: ViewFilter) => {
    setFilter(next);
    setActiveSavedViewName(null);
    setActiveSavedViewId(null);
  }, []);
  const handleSearchChange = React.useCallback((next: string) => {
    setSearchText(next);
    setActiveSavedViewName(null);
    setActiveSavedViewId(null);
  }, []);

  // A stable scope-id keeps multiple BoardRoot instances (embeds, future
  // multi-board layouts) from clobbering each other's hidden-card styles.
  const scopeId = React.useId();

  const fingerprint = useFilterFingerprint(store);

  const { availableTags, availableAssignees, visibleCardIds, totalCardIds, matchCount, savedViewCounts } =
    React.useMemo(() => {
      // Touch fingerprint so the memo invalidates when filter inputs change.
      void fingerprint;
      const board = store.getState().board;
      const tagSet = new Set<string>();
      const assigneeSet = new Set<string>();
      const total: CardId[] = [];
      for (const lane of board.lanes) {
        for (const card of lane.cards) {
          total.push(card.id);
          for (const t of card.meta.tags) tagSet.add(t);
          const a = card.meta.fields['assignee'] ?? card.meta.fields['who'];
          if (a) assigneeSet.add(a);
        }
      }
      const merged: ViewFilter = { ...filter };
      const search = searchText.trim();
      if (search) merged.text = search;
      const matches = applyFilter(board, isFilterEmpty(filter, searchText) ? undefined : merged);
      const visible = new Set<CardId>(matches.map((m) => m.card.id));
      // Placeholder cards (empty text) are excluded by `applyFilter` so they
      // never inflate saved-view counts before the user types anything. But
      // `HiddenCardsStyle` hides every card in `total` that isn't in this set
      // via `display:none` — so excluding placeholders here makes a brand-new
      // "+ Add card" card invisible the instant it's created (and, being
      // display:none, it can't take editor focus or fire its discard-on-blur,
      // so empty placeholders silently pile up — the lane count climbs while
      // the lane looks empty). They are transient edit targets with no content
      // to match a filter yet, so they must always render: add them back to
      // the visibility set (but NOT to `matchCount`, which stays content-only).
      for (const lane of board.lanes) {
        for (const card of lane.cards) {
          if (card.text.trim() === '') visible.add(card.id);
        }
      }
      // Compute one count per
      // pre-seeded saved view so the rail chips render real numbers. We
      // count zero for views whose resolver returns an empty filter — that
      // matches the user's expectation that "Assigned to me 0" / "Recurring 0"
      // is the honest answer when no card carries a corresponding field,
      // rather than collapsing to "match every card" via the
      // `applyFilter(board, undefined)` short-circuit.
      const viewCounts: Record<string, number> = {};
      for (const def of DEFAULT_SAVED_VIEW_DEFS) {
        const vf = resolveDefaultSavedViewFilter(def);
        const hasPredicate = Object.keys(vf).length > 0;
        viewCounts[def.id] = hasPredicate
          ? applyFilter(board, vf).length
          : 0;
      }
      return {
        availableTags: Array.from(tagSet).sort(),
        availableAssignees: Array.from(assigneeSet).sort(),
        visibleCardIds: visible,
        totalCardIds: total,
        // Content-only count for the masthead "X of Y" — placeholders are
        // added to `visible` for rendering but must not be counted as matches.
        matchCount: matches.length,
        savedViewCounts: viewCounts,
      };
    }, [fingerprint, store, filter, searchText]);

  const filterDescription = activeSavedViewName
    ? activeSavedViewName
    : describeFilter(filter, searchText);
  const filterActive = !isFilterEmpty(filter, searchText);
  const currentFilterIsEmpty = isFilterEmpty(filter, searchText);

  // When the board is rendered inside a markdown embed (readOnly=true,
  // allowEmbedEdit possibly true) we don't want the right rail to compete
  // for horizontal space in the host note. The rail is only shown for the
  // full KanbanView leaf surface.
  const showRail = !readOnly;

  return (
    <MarkdownHostProvider app={app} component={viewComponent}>
      <SavedViewsProvider store={savedViewStore}>
      <DnDProvider store={store} disabled={effectiveReadOnly}>
        <div
          className={`kp-shell${showRail ? '' : ' is-railless'}`}
          data-kp-filter-scope={scopeId}
        >
          <HiddenCardsStyle
            totalCardIds={totalCardIds}
            visibleCardIds={visibleCardIds}
            scopeId={scopeId}
          />
          <main className="kp-root kp-board">
            {banner}
            <Masthead
              store={store}
              sourcePath={sourcePath}
              filterActive={filterActive}
              visibleCardCount={matchCount}
            />
            <Subnav
              store={store}
              current={mode}
              app={app}
              filter={filter}
              onFilterChange={handleFilterChange}
              searchText={searchText}
              onSearchChange={handleSearchChange}
              availableTags={availableTags}
              availableAssignees={availableAssignees}
              matchCount={matchCount}
              filterDescription={filterDescription}
              filterActive={filterActive}
              currentFilterIsEmpty={currentFilterIsEmpty}
            />

            {/* F16 — each mode tree is wrapped in an ErrorBoundary so a throw
                inside one view doesn't blank the whole board. The boundary
                key is the mode so switching modes always remounts a fresh
                tree (no stale error state leaking between modes). */}
            {mode === 'board' ? (
              <ErrorBoundary key="board" label="Board view">
                <BoardView
                  store={store}
                  readOnly={effectiveReadOnly}
                  sourcePath={sourcePath}
                  onOpenDetail={onOpenDetail}
                  visibleCardIds={visibleCardIds}
                  filterActive={filterActive}
                />
              </ErrorBoundary>
            ) : mode === 'table' ? (
              <ErrorBoundary key="table" label="Table view">
                <TableRoot
                  store={store}
                  readOnly={effectiveReadOnly}
                  onOpenDetail={onOpenDetail}
                />
              </ErrorBoundary>
            ) : (
              <ErrorBoundary key="list" label="List view">
                <ListRoot
                  store={store}
                  readOnly={effectiveReadOnly}
                  onOpenDetail={onOpenDetail}
                />
              </ErrorBoundary>
            )}
          </main>

          {showRail ? (
            <RightRail
              app={app}
              sourcePath={sourcePath}
              savedViewCounts={savedViewCounts}
              activeSavedViewId={activeSavedViewId}
            />
          ) : null}
        </div>

        <DetailPanel
          cardId={detailCardId}
          store={store}
          onClose={onCloseDetail}
          readOnly={effectiveReadOnly}
        />

        <TrackingPanel cardId={trackingCardId} onClose={onCloseTracking} />
      </DnDProvider>
      </SavedViewsProvider>
    </MarkdownHostProvider>
  );
};
