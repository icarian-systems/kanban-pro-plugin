/**
 * LaneMenu — small popover surfaced from a lane header's "..." button.
 *
 * Lives entirely client-side: no portal, no Obsidian-side Menu API (which
 * we'd otherwise reach for) because the popover needs to be unit-testable
 * outside the host. The visual treatment matches the rest of the kp-ui
 * chrome (soft border, accent focus ring) via inline class tokens defined
 * in `src/styles/lane.css`.
 *
 * Actions:
 *  - Rename       (delegates to the parent — Column flips into title-edit mode)
 *  - Move left    (store.moveLane(laneId, index - 1))
 *  - Move right   (store.moveLane(laneId, index + 1))
 *  - Delete       (store.deleteLane(laneId))
 *
 * Lifecycle hygiene:
 *  - listens for outside clicks + Escape on `document` (capture phase) so we
 *    intercept dismissal before any in-popover handler swallows the key
 *  - all listeners are torn down on unmount
 *
 * Pro features (colour / WIP limit) are intentionally not wired here. Per
 * delegation plan they belong to a later milestone; adding a stub now would
 * mean either a PRO chip on a dead button or quiet feature-flag rot.
 */
import * as React from 'react';
import { Notice } from 'obsidian';
import type { BoardStore } from '@/core/store';
import type { LaneId } from '@/core/model';

export interface LaneMenuProps {
  laneId: LaneId;
  store: BoardStore;
  /** Called when the user picks an action — close the popover. */
  onDismiss: () => void;
  /** Called when the user picks "Rename" — parent flips title-edit mode. */
  onRename: () => void;
}

export const LaneMenu: React.FC<LaneMenuProps> = ({ laneId, store, onDismiss, onRename }) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape close. Capture phase so we beat any in-tree
  // handler that might stop propagation (e.g. CM6 keymaps elsewhere on the
  // board, or other popovers further up the tree).
  React.useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      onDismiss();
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
    };
  }, [onDismiss]);

  // Focus the first action so keyboard users can navigate immediately.
  React.useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLButtonElement>('button');
    first?.focus();
  }, []);

  const laneIds = store.selectLaneIds();
  const index = laneIds.indexOf(laneId);
  const canMoveLeft = index > 0;
  const canMoveRight = index >= 0 && index < laneIds.length - 1;

  const moveLane = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= laneIds.length) return;
    store.moveLane?.(laneId, next);
    onDismiss();
  };

  const deleteLane = () => {
    const fn = (store as unknown as { deleteLane?: (id: LaneId) => void }).deleteLane;
    if (typeof fn === 'function') {
      fn.call(store, laneId);
    } else {
      new Notice('Delete lane is not yet available in this build.');
    }
    onDismiss();
  };

  return (
    <div
      ref={rootRef}
      className="kp-lane-menu"
      role="menu"
      aria-label="Lane actions"
      // Stop bubbling so the document-level pointerdown listener above doesn't
      // dismiss when the user clicks inside the menu.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="kp-lane-menu__item"
        onClick={() => { onRename(); onDismiss(); }}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        className="kp-lane-menu__item"
        onClick={() => moveLane(-1)}
        disabled={!canMoveLeft}
      >
        Move left
      </button>
      <button
        type="button"
        role="menuitem"
        className="kp-lane-menu__item"
        onClick={() => moveLane(1)}
        disabled={!canMoveRight}
      >
        Move right
      </button>
      <div className="kp-lane-menu__divider" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="kp-lane-menu__item kp-lane-menu__item--danger"
        onClick={deleteLane}
      >
        Delete lane
      </button>
    </div>
  );
};
