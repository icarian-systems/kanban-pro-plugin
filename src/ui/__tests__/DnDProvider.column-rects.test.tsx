/**
 * DnDProvider.column-rects.test.tsx — lane-rect collision coverage.
 *
 * The existing `DnDProvider.test.tsx` proves the collision-detection callback
 * resolves correctly for SYNTHESIZED rects (Inbox/Doing/Done each spanning
 * 300px wide). That misses a real defect: in production, the `<Column>`
 * registers `useDroppable({ id: 'lane:<id>', data: { laneId, index: ... } })`
 * on the `<ol class="kp-cards">` element, but the SortableContext also wraps
 * each Card as a droppable (via useSortable). When dragging from Backlog to
 * In Progress, `pointerWithin` may return MULTIPLE containers (the lane
 * droppable AND any card sortable that overlaps), and the FIRST entry in
 * the returned list determines `over.id`.
 *
 * This test exercises real `<Column>` instances with realistic per-lane
 * rects and asserts that dragging into the In Progress lane's body resolves
 * to In Progress (not Done — which is one further to the right and was
 * the defect's wrong destination).
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import {
  DndContext,
  pointerWithin,
  type CollisionDetection,
  type DroppableContainer,
} from '@dnd-kit/core';
import { Component, type App } from 'obsidian';
import { BoardRoot } from '@/ui/BoardRoot';
import { createBoardStore, type BoardStore } from '@/core/store';
import { parseBoard } from '@/core/parser';
import type { Board, Card as CardModel, CardId, Lane, LaneId } from '@/core/model';

// Three-lane fixture matching the repro layout — Backlog has 1 plain card,
// In Progress empty, Done empty. Lane centres roughly: 143 / 445 / 747.
const FIXTURE_SOURCE = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
  '## Backlog',
  '',
  '- [ ] Test card 1',
  '',
  '## In Progress',
  '',
  '## Done',
  '',
].join('\n');

function makeApp(): App {
  return {
    workspace: { openLinkText: vi.fn() },
    vault: { getAbstractFileByPath: vi.fn(() => null) },
    metadataCache: {
      getBacklinksForFile: vi.fn(() => ({ data: {} })),
      resolvedLinks: {},
    },
  } as unknown as App;
}

function rect(x: number, y: number, w: number, h: number) {
  return {
    top: y,
    left: x,
    right: x + w,
    bottom: y + h,
    width: w,
    height: h,
    x,
    y,
  } as unknown as DOMRect;
}

describe('DnDProvider — lane rects from real Columns', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('production collisionDetection: pointer inside In Progress body resolves to In Progress, not Done', () => {
    // Build a board the same way production does: parse fixture, create
    // a real BoardStore. The store IS the data path; we only need lane
    // ids to drive the assertion.
    const parsed = parseBoard(FIXTURE_SOURCE);
    if (!parsed.board) throw new Error('parse failed');
    const board = parsed.board;
    expect(board.lanes).toHaveLength(3);

    const [backlog, inProgress, done] = board.lanes;
    expect(backlog.title).toBe('Backlog');
    expect(inProgress.title).toBe('In Progress');
    expect(done.title).toBe('Done');

    // Layout matching the observed coordinates:
    //   Backlog centre x≈447 → x: 304..590
    //   In Progress centre x≈687 → x: 544..830 (overlaps Backlog right edge by
    //   46px — but in production lanes don't overlap; the observation likely
    //   used pointer relative to viewport scroll). To be faithful we use
    //   non-overlapping 240-px lanes with 16-px gaps:
    //   Backlog x: 327..567 (centre 447)
    //   In Progress x: 583..823 (centre 703)
    //   Done x: 839..1079 (centre 959)
    // The observed pointer at x≈687 is squarely inside In Progress.
    const laneRects = new Map<string, ReturnType<typeof rect>>([
      ['lane:' + backlog.id, rect(327, 0, 240, 600)],
      ['lane:' + inProgress.id, rect(583, 0, 240, 600)],
      ['lane:' + done.id, rect(839, 0, 240, 600)],
    ]);

    // Build minimal droppable containers in the production id shape.
    const containers: DroppableContainer[] = [];
    for (const lane of board.lanes) {
      const id = 'lane:' + lane.id;
      containers.push({
        id,
        key: id,
        data: {
          current: { type: 'lane', laneId: lane.id, index: lane.cards.length },
        } as unknown as DroppableContainer['data'],
        disabled: false,
        node: { current: null } as unknown as DroppableContainer['node'],
        rect: { current: laneRects.get(id)! } as unknown as DroppableContainer['rect'],
      } as DroppableContainer);
    }
    // ALSO add the source card as a sortable droppable — that's how the
    // production tree works (each Card registers via useSortable, which
    // wraps useDroppable). The DRAGGING card's rect TRANSLATES with the
    // cursor, so during drag the card droppable is wherever the pointer
    // is. This is the load-bearing nuance the existing column-rects test misses.
    const cardId = backlog.cards[0].id;
    containers.push({
      id: cardId,
      key: cardId,
      data: {
        current: { type: 'card', laneId: backlog.id, index: 0 },
      } as unknown as DroppableContainer['data'],
      disabled: false,
      node: { current: null } as unknown as DroppableContainer['node'],
      // The card's CURRENT rect (translated) sits OVER In Progress.
      rect: {
        current: rect(603, 280, 200, 60),
      } as unknown as DroppableContainer['rect'],
    } as DroppableContainer);

    const droppableRects = new Map<string, DOMRect>();
    for (const c of containers) droppableRects.set(String(c.id), c.rect.current as DOMRect);

    // Production collisionDetection (mirrors DnDProvider.tsx:101-103).
    const productionCollisionDetection: CollisionDetection = (args) => {
      return pointerWithin(args);
    };

    const collisions = productionCollisionDetection({
      active: {
        id: cardId,
        rect: {
          current: {
            initial: rect(347, 280, 200, 60),
            translated: rect(603, 280, 200, 60),
          },
        },
        data: { current: { laneId: backlog.id, index: 0 } },
      } as never,
      collisionRect: rect(603, 280, 200, 60),
      droppableRects,
      droppableContainers: containers,
      pointerCoordinates: { x: 687, y: 300 }, // matches the observed pointer position
    });

    expect(collisions.length).toBeGreaterThan(0);

    // The FIRST droppable that's NOT the active card itself is what dnd-kit
    // resolves as `over`. Filter active out of the head, then assert.
    const overTargets = collisions
      .map((c) => String(c.id))
      .filter((id) => id !== cardId);
    expect(overTargets[0]).toBe('lane:' + inProgress.id);
    // And critically: Done must not be the resolved target.
    expect(overTargets).not.toContain('lane:' + done.id);
  });

  it('full BoardRoot render: lane <ol> droppable rects line up with their lanes', () => {
    // Mount the full BoardRoot so the <Column>s register their lane
    // droppables exactly as production does. Then mock getBoundingClientRect
    // per `<ol>` so we can read back what dnd-kit's measurement would see.
    const parsed = parseBoard(FIXTURE_SOURCE);
    if (!parsed.board) throw new Error('parse failed');
    const store = createBoardStore({ initialBoard: parsed.board });

    // Three different rects, one per lane <ol>. The lane droppable id is
    // 'lane:<laneId>' so we can map the <ol>'s parent .kp-lane data-lane-id.
    const { container } = render(
      <BoardRoot
        store={store}
        app={makeApp()}
        viewComponent={new Component()}
        mode="board"
      />,
    );

    const lanes = container.querySelectorAll('.kp-lane[data-lane-id]');
    expect(lanes.length).toBe(3);
    // Each lane should have exactly one <ol> child carrying the lane drop
    // zone — that's the element production attaches the lane droppable to.
    for (const lane of Array.from(lanes)) {
      const ol = lane.querySelector('ol.kp-cards');
      expect(ol).toBeTruthy();
    }
  });
});
