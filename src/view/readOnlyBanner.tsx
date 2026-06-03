/**
 * Non-dismissable banner shown when the board enters read-only mode.
 *
 * The board enters read-only mode when a save or parse error occurs. This
 * is the user-visible half of the never-silence invariant — we surface the
 * problem instead of swallowing it and losing edits.
 *
 * Three actions:
 *   - Retry: clears read-only and re-queues the most recent snapshot.
 *   - Open as text: opens the file in a plain Markdown view so the user
 *     can hand-recover.
 *   - Report: dumps board JSON + error to clipboard for issue filing.
 */
import * as React from 'react';

export interface ReadOnlyBannerProps {
  message: string;
  onRetry: () => void;
  onOpenAsText: () => void;
  onReport: () => void;
  /** Optional — shown only when set (i.e. when the trigger was a sync conflict
   *  rather than a parse error, so a diff exists to render). */
  onShowDiff?: () => void;
}

export const ReadOnlyBanner: React.FC<ReadOnlyBannerProps> = ({
  message,
  onRetry,
  onOpenAsText,
  onReport,
  onShowDiff,
}) => {
  return (
    <div className="kanban-pro-readonly-banner" role="alert" aria-live="polite">
      <div className="kanban-pro-readonly-banner__body">
        <strong>Board is read-only.</strong>
        <span className="kanban-pro-readonly-banner__message">{message}</span>
      </div>
      <div className="kanban-pro-readonly-banner__actions">
        {onShowDiff ? (
          <button type="button" onClick={onShowDiff}>Show diff</button>
        ) : null}
        <button type="button" onClick={onRetry}>Retry</button>
        <button type="button" onClick={onOpenAsText}>Open as text</button>
        <button type="button" onClick={onReport}>Report</button>
      </div>
    </div>
  );
};
