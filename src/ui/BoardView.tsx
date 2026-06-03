/**
 * BoardView — the kanban (lanes-and-cards) view.
 *
 * Layout (matches `docs/mockup.html`):
 *   <main class="board">
 *     <header class="masthead">…</header>
 *     <nav class="subnav">…</nav>
 *     <section class="lanes">
 *       <Column /> × n
 *     </section>
 *   </main>
 *
 * `BoardRoot` owns the masthead + subnav rendering — `BoardView` is only
 * responsible for the lanes grid.
 */
import * as React from 'react';
import type { BoardStore } from '@/core/store';
import type { CardId, LaneId } from '@/core/model';
import { Column } from '@/ui/Column';
import { EmptyState } from '@/ui/banners/EmptyState';
import { useStoreIdList } from '@/ui/hooks/useStoreSelector';

export interface BoardViewProps {
  store: BoardStore;
  readOnly?: boolean;
  sourcePath?: string;
  onOpenDetail: (cardId: CardId) => void;
}

function useLaneIds(store: BoardStore): readonly LaneId[] {
  return useStoreIdList(store, React.useCallback(() => store.selectLaneIds(), [store]));
}

export const BoardView: React.FC<BoardViewProps> = ({
  store,
  readOnly,
  sourcePath,
  onOpenDetail,
}) => {
  const laneIds = useLaneIds(store);

  const onAddLane = React.useCallback(() => {
    const newLaneId = store.addLane?.();
    // after creating the lane, broadcast its id so the matching
    // <Column> can switch its title into inline-edit mode on the next render
    // (same pattern as the focus-new-card flow). Defer to next tick to give the
    // new column a chance to mount and register its listener.
    if (newLaneId) {
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('kanban-pro:focus-new-lane', { detail: { laneId: newLaneId } }),
        );
      }, 0);
    }
  }, [store]);

  if (laneIds.length === 0) {
    return <EmptyState onAddLane={readOnly ? undefined : onAddLane} />;
  }

  return (
    // The lanes wrapper is a horizontal flex row with horizontal
    // scroll. Each `.kp-lane` declares its own fixed width + `flex-shrink:0`
    // (see lane.css), so adding lanes never collapses neighbours.
    <section className="kp-board-scroll">
      <div className="kp-lanes" role="list" aria-label="Lanes">
        {laneIds.map((laneId) => (
          <Column
            key={laneId}
            laneId={laneId}
            store={store}
            readOnly={readOnly}
            sourcePath={sourcePath}
            onOpenDetail={onOpenDetail}
          />
        ))}
        {!readOnly ? (
          <button
            type="button"
            className="kp-add-lane"
            onClick={onAddLane}
            aria-label="Add lane"
            title="Add lane"
          >
            <span className="kp-add-lane__icon" aria-hidden="true">+</span>
            <span className="kp-add-lane__label">Add lane</span>
          </button>
        ) : null}
      </div>
    </section>
  );
};
