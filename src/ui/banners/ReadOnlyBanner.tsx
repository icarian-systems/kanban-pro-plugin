/**
 * ReadOnlyBanner — shown when the board enters fail/read-only mode (parse
 * error, sync corruption, save failure). Non-dismissable by design: the user
 * has to take an action.
 *
 * Actions:
 *   - Retry: re-parse the file. Wired via `onRetry`.
 *   - Open as text: open the underlying `.md` file in the standard editor.
 *   - Report: copy diagnostics to clipboard so the user can paste into an issue.
 */
import * as React from 'react';

export interface ReadOnlyBannerProps {
  /** Short message describing why the board is read-only. */
  reason: string;
  /** Optional secondary detail (e.g. parser error message). */
  detail?: string;
  onRetry?: () => void;
  onOpenAsText?: () => void;
  onReport?: () => void;
}

export const ReadOnlyBanner: React.FC<ReadOnlyBannerProps> = ({
  reason,
  detail,
  onRetry,
  onOpenAsText,
  onReport,
}) => {
  return (
    <div className="banner banner--readonly" role="alert">
      <div className="banner__body">
        <div className="banner__title">Read-only — {reason}</div>
        {detail ? <div className="banner__detail">{detail}</div> : null}
      </div>
      <div className="banner__actions">
        {onRetry ? (
          <button type="button" className="banner__action" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {onOpenAsText ? (
          <button type="button" className="banner__action" onClick={onOpenAsText}>
            Open as text
          </button>
        ) : null}
        {onReport ? (
          <button type="button" className="banner__action" onClick={onReport}>
            Report
          </button>
        ) : null}
      </div>
    </div>
  );
};
