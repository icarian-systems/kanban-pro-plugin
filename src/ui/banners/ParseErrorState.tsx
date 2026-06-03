/**
 * ParseErrorState — full-pane fallback when the parser returns no Board.
 * (For partial errors with a board present, prefer `ReadOnlyBanner`.)
 */
import * as React from 'react';
import type { ParseError } from '@/core/model';

export interface ParseErrorStateProps {
  errors: ParseError[];
  onRetry?: () => void;
  onOpenAsText?: () => void;
}

export const ParseErrorState: React.FC<ParseErrorStateProps> = ({
  errors,
  onRetry,
  onOpenAsText,
}) => {
  return (
    <div className="parse-error-state" role="alert">
      <div className="parse-error-state__title">Could not read this board</div>
      <div className="parse-error-state__detail">
        The Markdown file looks malformed. Your data is safe — Obsidian still
        has the original file on disk.
      </div>
      <ul className="parse-error-state__list">
        {errors.slice(0, 5).map((err, i) => (
          <li key={i} className={`parse-error-state__item parse-error-state__item--${err.severity}`}>
            {err.message}
          </li>
        ))}
        {errors.length > 5 ? (
          <li className="parse-error-state__item">… and {errors.length - 5} more</li>
        ) : null}
      </ul>
      <div className="parse-error-state__actions">
        {onRetry ? (
          <button type="button" className="parse-error-state__action" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {onOpenAsText ? (
          <button type="button" className="parse-error-state__action" onClick={onOpenAsText}>
            Open as text
          </button>
        ) : null}
      </div>
    </div>
  );
};
