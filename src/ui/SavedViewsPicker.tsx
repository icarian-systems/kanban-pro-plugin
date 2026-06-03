/**
 * SavedViewsPicker — body content for the Views popover in the board
 * subnav. Renders the list of user-saved views from `SavedViewStore`,
 * plus a "Save current filter as…" affordance that opens a name-input
 * modal.
 *
 * Each row applies the saved view's filter when clicked (via the
 * `kanban-pro:apply-saved-view` window event — same channel the
 * right-rail chips use, so the BoardRoot listener handles both paths
 * uniformly). A hover-revealed "Delete" affordance lets the user prune
 * stale views.
 */
import * as React from 'react';
import type { App } from 'obsidian';
import { useSavedViews, useSavedViewStore } from '@/ui/SavedViewsContext';
import { SaveViewModal } from '@/ui/SaveViewModal';
import type { SavedView, ViewFilter } from '@/core/model';

export interface SavedViewsPickerProps {
  app: App;
  /** Current filter snapshot — used as the payload for `Save current filter as…`. */
  currentFilter: ViewFilter;
  /** Whether the current filter has anything to save (non-empty). */
  currentFilterIsEmpty: boolean;
  /** Called after a save completes, so the parent can show a success affordance / close itself. */
  onSaved?: (view: SavedView) => void;
  /** Called when the user picks a saved view to apply. The window event still fires for free; this is a side channel for the parent to close the popover. */
  onApplied?: (view: SavedView) => void;
}

const SAVED_VIEW_EVENT = 'kanban-pro:apply-saved-view';

export const SavedViewsPicker: React.FC<SavedViewsPickerProps> = ({
  app,
  currentFilter,
  currentFilterIsEmpty,
  onSaved,
  onApplied,
}) => {
  const store = useSavedViewStore();
  const views = useSavedViews();

  const onApply = React.useCallback(
    (view: SavedView) => {
      window.dispatchEvent(
        new CustomEvent(SAVED_VIEW_EVENT, {
          detail: { id: view.id, filter: view.filter, name: view.name },
        }),
      );
      onApplied?.(view);
    },
    [onApplied],
  );

  const onDelete = React.useCallback(
    (view: SavedView, ev: React.MouseEvent) => {
      // Don't let the row click fire when the delete icon is tapped.
      ev.stopPropagation();
      if (!store) return;
      void store.delete(view.id);
    },
    [store],
  );

  const onSaveCurrent = React.useCallback(() => {
    if (!store) return;
    new SaveViewModal(app, {
      onSubmit: async (name) => {
        const saved = await store.save({ name, filter: currentFilter });
        onSaved?.(saved);
      },
    }).open();
  }, [app, store, currentFilter, onSaved]);

  return (
    <div className="kp-views-picker">
      {views.length === 0 ? (
        <p className="kp-popover-msg">
          No saved views yet. Build a filter, then save it for one-click reuse.
        </p>
      ) : (
        <ul className="kp-views-picker__list" role="list">
          {views.map((view) => (
            <li key={view.id} className="kp-views-picker__row">
              <button
                type="button"
                className="kp-views-picker__apply"
                onClick={() => onApply(view)}
                aria-label={`Apply saved view: ${view.name}`}
              >
                <span className="kp-views-picker__name">{view.name}</span>
                <span className="kp-views-picker__hint">{describeFilter(view.filter)}</span>
              </button>
              <button
                type="button"
                className="kp-views-picker__delete"
                onClick={(ev) => onDelete(view, ev)}
                aria-label={`Delete saved view: ${view.name}`}
                title="Delete"
              >
                {/* small trash glyph */}
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.4}
                  aria-hidden="true"
                >
                  <path d="M3 4h8M5.5 4V2.5h3V4M4 4l.5 7.5h5L10 4" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="kp-popover-actions">
        <button
          type="button"
          className="kp-control is-primary"
          onClick={onSaveCurrent}
          disabled={!store || currentFilterIsEmpty}
          title={
            currentFilterIsEmpty
              ? 'Set a filter first to save it as a view'
              : 'Save current filter as a named view'
          }
        >
          Save current filter as…
        </button>
      </div>
    </div>
  );
};

/**
 * Compact summary for the row hint. Mirrors `BoardRoot.describeFilter`
 * but stays standalone so this component has no hidden dependency on the
 * parent.
 */
function describeFilter(filter: ViewFilter): string {
  const parts: string[] = [];
  if (filter.text) parts.push(`"${filter.text.slice(0, 12)}"`);
  if (filter.tags && filter.tags.length) {
    parts.push(filter.tags.length === 1 ? `#${filter.tags[0]}` : `${filter.tags.length} tags`);
  }
  if (filter.assignees && filter.assignees.length) {
    parts.push(filter.assignees.length === 1 ? `@${filter.assignees[0]}` : `${filter.assignees.length} assignees`);
  }
  if (filter.dueBefore) parts.push(`due<${filter.dueBefore}`);
  if (filter.dueAfter) parts.push(`due>${filter.dueAfter}`);
  if (typeof filter.done === 'boolean') parts.push(filter.done ? 'done' : 'open');
  return parts.join(' · ') || 'all';
}
