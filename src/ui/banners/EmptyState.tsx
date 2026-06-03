/**
 * EmptyState — shown when a board has zero lanes (fresh file).
 */
import * as React from 'react';

export interface EmptyStateProps {
  onAddLane?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ onAddLane }) => {
  return (
    <div className="kp-board-empty" role="status">
      <h3>An empty board</h3>
      <p>
        Add a lane to get started. Lanes map 1:1 to level-2 headings in the
        underlying Markdown file.
      </p>
      {onAddLane ? (
        <button
          type="button"
          className="kp-add-lane"
          onClick={onAddLane}
          aria-label="Add lane"
        >
          + Add lane
        </button>
      ) : null}
    </div>
  );
};
