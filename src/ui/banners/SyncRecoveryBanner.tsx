/**
 * SyncRecoveryBanner — shown after Sync three-way merge detection. Two-way
 * choice: keep local, keep remote, or open the diff.
 */
import * as React from 'react';

export interface SyncRecoveryBannerProps {
  /** Number of cards affected by the divergence. */
  affectedCount?: number;
  onKeepLocal?: () => void;
  onKeepRemote?: () => void;
  onOpenDiff?: () => void;
}

export const SyncRecoveryBanner: React.FC<SyncRecoveryBannerProps> = ({
  affectedCount,
  onKeepLocal,
  onKeepRemote,
  onOpenDiff,
}) => {
  return (
    <div className="banner banner--sync" role="alert">
      <div className="banner__body">
        <div className="banner__title">Sync conflict detected</div>
        <div className="banner__detail">
          {affectedCount != null
            ? `${affectedCount} card${affectedCount === 1 ? '' : 's'} differ between this device and Sync.`
            : 'The on-disk file differs from the in-memory board.'}
        </div>
      </div>
      <div className="banner__actions">
        {onOpenDiff ? (
          <button type="button" className="banner__action" onClick={onOpenDiff}>
            Show diff
          </button>
        ) : null}
        {onKeepLocal ? (
          <button type="button" className="banner__action" onClick={onKeepLocal}>
            Keep local
          </button>
        ) : null}
        {onKeepRemote ? (
          <button type="button" className="banner__action" onClick={onKeepRemote}>
            Keep remote
          </button>
        ) : null}
      </div>
    </div>
  );
};
