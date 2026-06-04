/**
 * Column — one lane in the board. Virtualized via `@tanstack/react-virtual`
 * so 1000+ cards in a single lane stay smooth.
 *
 * Subscriptions:
 *   - laneIds / card ids come from selectors (arrays of strings only)
 *   - per-card state lives in <Card>, which subscribes via store.selectCard()
 */
import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import type { BoardStore } from '@/core/store';
import type { CardId, LaneId } from '@/core/model';
import { Card } from '@/ui/Card';
import { useDnDState } from '@/ui/DnDProvider';
import { useStoreIdList, useStoreSelector } from '@/ui/hooks/useStoreSelector';
import { LaneMenu } from '@/ui/LaneMenu';

export interface ColumnProps {
  laneId: LaneId;
  store: BoardStore;
  readOnly?: boolean;
  sourcePath?: string;
  onOpenDetail: (cardId: CardId) => void;
  /** Cards passing the active filter — used to show a filtered lane count. */
  visibleCardIds?: ReadonlySet<CardId>;
  /** Whether a filter/search is currently narrowing the board. */
  filterActive?: boolean;
}

/**
 * Estimated row height (px). Real heights are measured after first paint via
 * the virtualizer's `measureElement`; this number only needs to be a sensible
 * starting point so the initial scroll layout doesn't jitter.
 */
const ESTIMATED_CARD_HEIGHT = 96;

/**
 * Virtualization threshold. Below this card count, render every card eagerly
 * — virtualization overhead isn't worth it and animation easing reads
 * cleaner without windowing.
 */
const VIRTUALIZE_THRESHOLD = 30;

function useLaneTitle(store: BoardStore, laneId: LaneId): string {
  return useStoreSelector(store, React.useCallback(
    () => store.selectLane(laneId)?.title ?? '',
    [store, laneId],
  ));
}
function useLaneCollapsed(store: BoardStore, laneId: LaneId): boolean {
  return useStoreSelector(store, React.useCallback(
    () => Boolean(store.selectLane(laneId)?.collapsed),
    [store, laneId],
  ));
}
function useLaneKind(store: BoardStore, laneId: LaneId): string {
  return useStoreSelector(store, React.useCallback(
    () => store.selectLane(laneId)?.kind ?? 'normal',
    [store, laneId],
  ));
}

function useCardIds(store: BoardStore, laneId: LaneId): readonly CardId[] {
  return useStoreIdList(store, React.useCallback(
    () => store.selectCardIds(laneId),
    [store, laneId],
  ));
}

/**
 * Subscribe to the store's `renderGeneration` counter. Bumped by undo/redo
 * paths so the card render keys flip and React remounts each Card.
 * Plain mutations leave this untouched — the per-card subscription is
 * sufficient for ordinary edits.
 */
function useRenderGeneration(store: BoardStore): number {
  return useStoreSelector(store, React.useCallback(
    () => store.getState().renderGeneration,
    [store],
  ));
}

export const Column: React.FC<ColumnProps> = ({
  laneId,
  store,
  readOnly,
  sourcePath,
  onOpenDetail,
  visibleCardIds,
  filterActive,
}) => {
  const title = useLaneTitle(store, laneId);
  const collapsed = useLaneCollapsed(store, laneId);
  const kind = useLaneKind(store, laneId);
  const cardIds = useCardIds(store, laneId);
  const renderGeneration = useRenderGeneration(store);
  const { isDragging } = useDnDState();

  // Lane count shown in the header chip. When a filter is active, count only
  // the cards in this lane that pass it (the rest are hidden by the
  // filter CSS) — so the chip agrees with what's on screen rather than
  // showing the unfiltered total above a single visible card (#6).
  const displayCount =
    filterActive && visibleCardIds
      ? cardIds.reduce((n, id) => (visibleCardIds.has(id) ? n + 1 : n), 0)
      : cardIds.length;

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = cardIds.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    // When we're below the virtualization threshold we still create the
    // virtualizer (rules of hooks) but pass 0 so it does no work; the
    // non-virtualized branch below renders directly from `cardIds`.
    count: shouldVirtualize ? cardIds.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    overscan: 8,
  });

  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `lane:${laneId}`,
    data: { type: 'lane', laneId, index: cardIds.length },
  });

  // track the most-recently-added placeholder card so that, if the user
  // clicks `+ Add card` and then clicks away without typing, we can delete
  // the orphaned "Untitled" placeholder instead of leaving it stranded on
  // the board. The set is small (typically one entry at a time) and is
  // cleared when the card receives any real edit or the user explicitly
  // cancels.
  const pendingPlaceholdersRef = React.useRef<Set<string>>(new Set());

  const onAddCard = React.useCallback(() => {
    if (readOnly) return;
    const newId = store.addCard?.(laneId);
    // after creating the placeholder card, broadcast its id so the
    // matching <Card> can switch itself into editing mode on the next render.
    // Using a window event keeps Card.tsx independent of Column's local
    // state and avoids prop-drilling a "focus-this-id" flag through every
    // card. Card.tsx owns the listener (and its cleanup).
    if (newId) {
      pendingPlaceholdersRef.current.add(newId);
      // Defer to next tick — gives the store an opportunity to commit and
      // the new <Card> a chance to mount before we ask it to enter editing.
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('kanban-pro:focus-new-card', { detail: { cardId: newId } }),
        );
      }, 0);
    }
  }, [laneId, readOnly, store]);

  // InlineEditor broadcasts this event when its blur/cancel path sees
  // both an empty initial value AND an empty current value (i.e. user
  // clicked `+ Add card`, typed nothing, then clicked away or pressed
  // Escape). If the cardId matches a pending placeholder this lane just
  // added, we delete it. Cards that already had text never enter this code
  // path because the event isn't dispatched for them.
  React.useEffect(() => {
    if (readOnly) return;
    const onDiscard = (e: Event) => {
      const detail = (e as CustomEvent<{ cardId?: string }>).detail;
      const cardId = detail?.cardId;
      if (!cardId) return;
      if (!pendingPlaceholdersRef.current.has(cardId)) return;
      pendingPlaceholdersRef.current.delete(cardId);
      store.deleteCard?.(cardId);
    };
    // Any successful commit clears the placeholder tracking so a later
    // discard signal (which shouldn't happen, but defensively) can't delete
    // a card the user actually populated.
    const onCommitted = (e: Event) => {
      const detail = (e as CustomEvent<{ cardId?: string }>).detail;
      const cardId = detail?.cardId;
      if (cardId) pendingPlaceholdersRef.current.delete(cardId);
    };
    window.addEventListener('kanban-pro:discard-empty-card', onDiscard);
    window.addEventListener('kanban-pro:card-committed', onCommitted);
    return () => {
      window.removeEventListener('kanban-pro:discard-empty-card', onDiscard);
      window.removeEventListener('kanban-pro:card-committed', onCommitted);
    };
  }, [readOnly, store]);

  // L3 — local state for inline lane-title editing. Opens on (a) the
  // `kanban-pro:focus-new-lane` event when this lane is the just-added one,
  // (b) double-click on the lane title, or (c) the "Rename" entry in the
  // lane menu.
  const [editingTitle, setEditingTitle] = React.useState(false);
  const titleInputRef = React.useRef<HTMLInputElement | null>(null);
  // Escape pressed inside the rename input flips this flag so the
  // ensuing blur (from setEditingTitle(false) unmounting the input) doesn't
  // commit the typed-but-cancelled value. Without it, Escape "looks like it
  // cancels" because the input vanishes, but the value still lands in the
  // store via the blur fired during unmount.
  const titleCancelledRef = React.useRef(false);
  // Tracks whether this lane is a freshly-added placeholder (i.e.
  // entered edit mode via `kanban-pro:focus-new-lane` rather than rename).
  // Used to delete the lane on Escape / empty-blur so the user can abort
  // the "+ Add lane" gesture without leaving an "Untitled" lane behind.
  // Mirrors the pendingPlaceholdersRef pattern used for cards.
  const isNewLanePlaceholderRef = React.useRef(false);

  React.useEffect(() => {
    const onFocusNewLane = (e: Event) => {
      const detail = (e as CustomEvent<{ laneId?: string }>).detail;
      if (detail?.laneId === laneId) {
        titleCancelledRef.current = false;
        isNewLanePlaceholderRef.current = true;
        setEditingTitle(true);
      }
    };
    window.addEventListener('kanban-pro:focus-new-lane', onFocusNewLane);
    return () => window.removeEventListener('kanban-pro:focus-new-lane', onFocusNewLane);
  }, [laneId]);

  // Focus + select the title input when entering edit mode.
  React.useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      const el = titleInputRef.current;
      // requestAnimationFrame so the input is laid out before we focus.
      requestAnimationFrame(() => {
        el.focus();
        el.select();
      });
    }
  }, [editingTitle]);

  const commitTitle = React.useCallback(
    (next: string) => {
      // if Escape just fired we're tearing down the input on purpose;
      // skip the commit so cancel-on-Escape semantics hold.
      if (titleCancelledRef.current) {
        titleCancelledRef.current = false;
        const wasNewLane = isNewLanePlaceholderRef.current;
        isNewLanePlaceholderRef.current = false;
        setEditingTitle(false);
        // Escape on a freshly-added placeholder deletes the lane so
        // the user can abandon "+ Add lane" without leaving an Untitled
        // lane behind. Existing lanes (rename flow) are untouched.
        if (wasNewLane) {
          store.deleteLane?.(laneId);
        }
        return;
      }
      const trimmed = next.trim();
      const wasNewLane = isNewLanePlaceholderRef.current;
      isNewLanePlaceholderRef.current = false;
      setEditingTitle(false);
      // Empty blur on a placeholder deletes the lane (same UX as
      // Escape). The existing-lane case (`trimmed === title`) is unchanged.
      if (!trimmed) {
        if (wasNewLane) store.deleteLane?.(laneId);
        return;
      }
      if (trimmed === title) return;
      store.editLane?.(laneId, { title: trimmed });
    },
    [laneId, store, title],
  );

  // Escape/Enter are routed through native capture-phase listeners on
  // the input AND on window. JSX onKeyDown is bubble-phase delegated through
  // React's synthetic-event system; Obsidian installs capture-phase keydown
  // listeners on its workspace host that can stopPropagation before our
  // synthetic handler ever fires. Binding natively at the input (so the
  // event reaches us when it lands on the target) AND at window capture
  // (so a stray ancestor consumer can't preempt us) gives the user the
  // documented Escape-cancel semantics regardless of what the host does
  // with the keystroke afterward. Both branches route through
  // `commitTitle` so the placeholder-deletion + cancel-ref logic runs
  // deterministically (the JSX onKeyDown handler runs the same code on
  // the bubble path for jsdom-only test environments where window-capture
  // delivery is unreliable).
  React.useEffect(() => {
    if (!editingTitle) return;
    const el = titleInputRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        titleCancelledRef.current = true;
        commitTitle(el.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        titleCancelledRef.current = false;
        commitTitle(el.value);
      }
    };
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      if (document.activeElement !== el) return;
      onKey(e);
    };
    el.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('keydown', onWindowKey, { capture: true });
    return () => {
      el.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keydown', onWindowKey, { capture: true });
    };
  }, [editingTitle, commitTitle]);

  // lane "..." popover state. The button toggles the menu; the menu
  // itself owns outside-click/Escape dismissal so we don't have to
  // duplicate that logic here.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const closeMenu = React.useCallback(() => setMenuOpen(false), []);

  // Header is `title + count badge` on the same row. The previous
  // implementation rendered the lane-count on its own line and surfaced two
  // placeholder-shaped action buttons. The action buttons stay (hover-only,
  // CSS-driven), but their visual rest state is now opacity:0 so they read
  // as "lane chrome" not unfinished controls.
  const laneClass = `kp-lane${kind === 'complete' ? ' is-shipped' : ''}${kind === 'archive' ? ' is-archive' : ''}${
    collapsed ? ' is-collapsed' : ''
  }${isOver ? ' is-drop-target' : ''}`;

  // the article previously carried a verbose `aria-label`
  // ("Backlog: 1 card") that several themes/OSes surfaced as a hover
  // tooltip near the lane footer. Two problems with that:
  //   1. Browser/OS-level tooltips cache their text while the cursor
  //      stays hovered, so dragging a card out and undoing it left the
  //      stale "0 cards" hint visible for several seconds.
  //   2. The label duplicated the visible lane title (in <h2>) plus
  //      the count chip — pure noise on hover.
  // Drop the aria-label entirely. The <h2> title is already the
  // accessible name for the article (computed text content), and the count
  // chip has its own aria-label. Nothing about a11y regresses; the hover
  // noise disappears.

  return (
    <article
      className={laneClass}
      data-lane-id={laneId}
      role="listitem"
    >
      <header className="kp-lane-head">
        {editingTitle ? (
          // L3 — minimal inline lane-title input. Commits on Enter/blur,
          // reverts on Escape. Styled inline to inherit the .kp-lane-title
          // typography so the visual handoff between read and edit modes
          // doesn't shift layout.
          <input
            ref={titleInputRef}
            type="text"
            className="kp-lane-title"
            // Inline styles keep this isolated to Column.tsx without
            // editing lane.css (owned elsewhere). We inherit the heading
            // typography but flatten the input chrome so the visual
            // handoff between read/edit modes doesn't shift layout.
            style={{
              background: 'transparent',
              border: '1px solid var(--kp-accent-border)',
              borderRadius: 'var(--kp-radius-sm)',
              padding: '0 var(--kp-space-1)',
              margin: '0 calc(-1 * var(--kp-space-1))',
              outline: 'none',
              font: 'inherit',
              color: 'inherit',
              width: '100%',
              minWidth: 0,
            }}
            defaultValue={title}
            aria-label="Lane name"
            // Primary keystroke handler. The native window-capture
            // listener installed via `useEffect` further down is a
            // defence-in-depth backstop for the case where Obsidian's
            // workspace-level capture listener preempts React's synthetic
            // delegation. Both paths route through
            // `commitTitle` so the placeholder-deletion + cancel-ref logic
            // runs deterministically in either branch.
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                titleCancelledRef.current = false;
                commitTitle((e.currentTarget as HTMLInputElement).value);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                // Escape on the lane-rename
                // input MUST be stopped here so Obsidian's window-level
                // Escape handler doesn't also fire (the prior bug surfaced
                // as "Escape exits fullscreen instead of cancelling the
                // lane edit"). preventDefault alone is not enough — the
                // event still bubbles up to the host listener; stopProp is
                // load-bearing.
                e.stopPropagation();
                // mark cancelled so the unmount-triggered blur below
                // skips committing the typed-but-discarded value.
                titleCancelledRef.current = true;
                // Route through commitTitle so the placeholder-deletion
                // path runs deterministically even when the host doesn't
                // synthesise a blur on input unmount (jsdom in tests).
                commitTitle((e.currentTarget as HTMLInputElement).value);
              }
            }}
            onBlur={(e) => commitTitle(e.currentTarget.value)}
          />
        ) : (
          <h2
            className="kp-lane-title"
            onDoubleClick={() => {
              if (readOnly) return;
              setEditingTitle(true);
            }}
          >
            {title}
          </h2>
        )}
        <span
          className="kp-lane-count"
          aria-label={
            filterActive
              ? `${displayCount} of ${cardIds.length} cards match`
              : `${cardIds.length} cards`
          }
        >{displayCount}</span>
        <div className="kp-spacer" />
        <div className="kp-lane-actions">
          <button
            type="button"
            className="kp-ic"
            aria-label={`Add card to ${title || 'lane'}`}
            onClick={onAddCard}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
              <path d="M7 3v8M3 7h8" />
            </svg>
          </button>
          <div className="kp-lane-menu__anchor">
            <button
              type="button"
              className="kp-ic"
              aria-label={`${title || 'Lane'} menu`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <circle cx="3" cy="7" r="1" />
                <circle cx="7" cy="7" r="1" />
                <circle cx="11" cy="7" r="1" />
              </svg>
            </button>
            {menuOpen ? (
              <LaneMenu
                laneId={laneId}
                store={store}
                onDismiss={closeMenu}
                onRename={() => {
                  titleCancelledRef.current = false;
                  setEditingTitle(true);
                }}
              />
            ) : null}
          </div>
        </div>
      </header>

      <SortableContext items={cardIds as string[]} strategy={verticalListSortingStrategy}>
        {shouldVirtualize ? (
          <div
            ref={(el) => {
              scrollRef.current = el;
              setDroppableRef(el);
            }}
            className="kp-lane-scroll"
            style={{ maxHeight: '70vh', overflowY: 'auto', position: 'relative' }}
          >
            <ol
              className="kp-cards"
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtual) => {
                const cardId = cardIds[virtual.index];
                return (
                  <div
                    key={`${renderGeneration}:${cardId}`}
                    data-index={virtual.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtual.start}px)`,
                    }}
                  >
                    <Card
                      cardId={cardId}
                      laneId={laneId}
                      index={virtual.index}
                      store={store}
                      readOnly={readOnly}
                      sourcePath={sourcePath}
                      onOpenDetail={onOpenDetail}
                    />
                  </div>
                );
              })}
            </ol>
          </div>
        ) : (
          <ol ref={setDroppableRef} className={`kp-cards${cardIds.length === 0 ? ' is-empty' : ''}${isOver ? ' is-droppable-active' : ''}`}>
            {cardIds.map((cardId, index) => (
              <Card
                key={`${renderGeneration}:${cardId}`}
                cardId={cardId}
                laneId={laneId}
                index={index}
                store={store}
                readOnly={readOnly}
                sourcePath={sourcePath}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </ol>
        )}
      </SortableContext>

      {!readOnly ? (
        <button
          type="button"
          className="kp-add-card"
          onClick={onAddCard}
          aria-label={`Add card to ${title || 'lane'}`}
        >
          + Add card
        </button>
      ) : null}

      {/* Keep dragging state observable in the DOM for animation/disable hooks. */}
      {isDragging ? <span data-lane-dragging hidden /> : null}
    </article>
  );
};
