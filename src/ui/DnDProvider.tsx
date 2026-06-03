/**
 * DnDProvider — wraps the board in a `<DndContext>` with the project-standard
 * sensors and routes pointer events into the store's gesture API.
 *
 * Sensor activation constraints (do not change without coordination):
 *   - PointerSensor:  { distance: 6 }
 *   - TouchSensor:    { delay: 200, tolerance: 8 }
 *
 * Collision detection strategy (fixes wrong-lane drops):
 *   We use `pointerWithin` **exclusively**. dnd-kit's default
 *   `rectIntersection` compares the *dragged element's* transformed rect to
 *   droppables, which means a horizontally dragged card crosses into the next
 *   lane's rect while the cursor is still over the previous lane.
 *
 *   A previous version added a `closestCenter` fallback for "pointer outside
 *   every droppable" (e.g. gutters between lanes, or empty lanes whose body
 *   was zero-height). That re-introduced wrong-lane drops on
 *   complex cards (subtasks + tags + emoji + ^card-id): during the
 *   virtualizer's reflow the dragged card's bounding rect briefly hops
 *   neighbours, and `closestCenter` resolved by *card centers* (not lane
 *   centers), so a card mid-flick toward Doing would briefly be closest to a
 *   card in Done and the fallback would commit it there.
 *
 *   Fix shape:
 *     1. Drop `closestCenter` entirely — `pointerWithin` only. A miss means
 *        no drop target this frame; the cursor will land on a droppable on
 *        the next pointer move.
 *     2. Widen empty-lane drop zones in `<Column>` so `pointerWithin` always
 *        resolves when the cursor is over the lane body (see Column.tsx).
 *     3. Switch measuring strategy to `BeforeDragging` (dnd-kit's
 *        recommendation for virtualized lists). With `Always` the virtualizer
 *        was driving droppable remeasurement mid-drag, which is the original
 *        source of the rect drift.
 *
 * Gesture contract with the store (`src/core/store.ts`):
 *   - `beginGesture()`               called on `onDragStart`
 *   - `moveCardOptimistic(...)`      called on each `onDragOver` where the
 *                                    drop target changes (lane or index)
 *   - `commitGesture()`              called on `onDragEnd`
 *   - `cancelGesture()`              called on `onDragCancel`
 *
 * The store is expected to coalesce optimistic moves into a single undo
 * snapshot on commit and to roll back on cancel.
 */
import * as React from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { BoardStore } from '@/core/store';
import type { CardId, LaneId } from '@/core/model';
import { licenseFSM } from '@/pro/license/state';

export interface DnDProviderProps {
  store: BoardStore;
  children: React.ReactNode;
  /** When true, render no DragOverlay (used in read-only embeds). */
  disabled?: boolean;
}

/**
 * Context value the children consume to decide whether to render the overlay
 * preview, and to disable click-to-edit while a drag is in flight.
 */
interface DnDState {
  activeCardId: CardId | null;
  isDragging: boolean;
}

const DnDStateContext = React.createContext<DnDState>({ activeCardId: null, isDragging: false });

export function useDnDState(): DnDState {
  return React.useContext(DnDStateContext);
}

export const DnDProvider: React.FC<DnDProviderProps> = ({ store, children, disabled }) => {
  const [activeCardId, setActiveCardId] = React.useState<CardId | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  // Cursor-anchored collision detection. See file-top comment for rationale.
  // `pointerWithin` returns droppables whose rects contain the pointer. We
  // intentionally do NOT fall back to `closestCenter`: that fallback was the
  // root cause of wrong-lane drops on complex cards during virtualizer
  // reflow, because it resolves by *card* center rather than lane center.
  // Empty lanes get a min-height drop zone in `<Column>` so the pointer can
  // always land inside the lane's `useDroppable` rect without a fallback.
  const collisionDetection = React.useCallback<CollisionDetection>((args) => {
    return pointerWithin(args);
  }, []);

  const onDragStart = React.useCallback(
    (e: DragStartEvent) => {
      const cardId = String(e.active.id) as CardId;
      setActiveCardId(cardId);
      store.beginGesture?.();
      // Hold the license FSM busy for the duration of the gesture so any
      // queued license transition (e.g. revalidate result) waits until the
      // drag settles. Paired with setBusy(false) in onDragEnd/onDragCancel.
      licenseFSM.setBusy(true);
      // Tell the rest of the UI (especially open InlineEditors) to commit
      // before we start moving things around.
      window.dispatchEvent(new CustomEvent('kanban-pro:dragstart', { detail: { cardId } }));
    },
    [store],
  );

  const lastTargetRef = React.useRef<{ laneId: LaneId | null; index: number } | null>(null);

  const onDragOver = React.useCallback(
    (e: DragOverEvent) => {
      const cardId = String(e.active.id) as CardId;
      const overId = e.over?.id;
      if (overId == null) return;

      // The `useSortable` setup is expected to encode the drop
      // target as either a card id (drop above that card) or a lane id (drop
      // at end of lane). We pass both through `data` on the sortable items.
      const overData = e.over?.data?.current as
        | { type?: 'card' | 'lane'; laneId?: LaneId; index?: number }
        | undefined;

      const targetLaneId = (overData?.laneId ?? null) as LaneId | null;
      const targetIndex = overData?.index ?? 0;

      const last = lastTargetRef.current;
      if (last && last.laneId === targetLaneId && last.index === targetIndex) return;
      lastTargetRef.current = { laneId: targetLaneId, index: targetIndex };

      if (targetLaneId != null) {
        store.moveCardOptimistic?.(cardId, targetLaneId, targetIndex);
      }
    },
    [store],
  );

  const onDragEnd = React.useCallback(
    (_e: DragEndEvent) => {
      lastTargetRef.current = null;
      setActiveCardId(null);
      store.commitGesture?.();
      licenseFSM.setBusy(false);
    },
    [store],
  );

  const onDragCancel = React.useCallback(() => {
    lastTargetRef.current = null;
    setActiveCardId(null);
    store.cancelGesture?.();
    licenseFSM.setBusy(false);
  }, [store]);

  // Measuring strategy — `BeforeDragging` is dnd-kit's recommendation for
  // virtualized lists (per their docs and #870 discussion). It measures
  // droppables ONCE when the drag starts and reuses those rects for the
  // entire gesture. The previous `Always` strategy let the virtualizer's
  // own measure pass redrive droppable rects mid-drag, which produced
  // off-by-one lane misses on complex cards where the virtualizer is more
  // likely to reflow (subtasks/tags/emoji shift card heights).
  const measuring = React.useMemo(
    () => ({
      droppable: {
        strategy: MeasuringStrategy.BeforeDragging,
      },
    }),
    [],
  );

  const stateValue = React.useMemo<DnDState>(
    () => ({ activeCardId, isDragging: activeCardId != null }),
    [activeCardId],
  );

  if (disabled) {
    // Still provide the state context so children can read it, but skip
    // dnd-kit entirely — saves listeners in read-only embed mode.
    return <DnDStateContext.Provider value={stateValue}>{children}</DnDStateContext.Provider>;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={measuring}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <DnDStateContext.Provider value={stateValue}>{children}</DnDStateContext.Provider>
      {/* DragOverlay is left empty on purpose — children render a card-shaped
          ghost via dnd-kit's sortable transform; an overlay clone is optional
          and can be added later without changing this surface. */}
      <DragOverlay dropAnimation={null} />
    </DndContext>
  );
};

export default DnDProvider;
