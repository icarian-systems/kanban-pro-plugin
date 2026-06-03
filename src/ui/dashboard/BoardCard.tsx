/**
 * BoardCard — one tile in the dashboard list. Click opens the board.
 *
 * The component is tightly scoped to a single VaultIndexEntry — it does no
 * I/O of its own. The parent supplies an `onOpen` callback (typically
 * `(path) => app.workspace.openLinkText(path, '', false)`).
 */
import * as React from 'react';
import type { VaultIndexEntry } from '@/ui/contracts';

export interface BoardCardProps {
  entry: VaultIndexEntry;
  onOpen: (path: string) => void;
}

function formatRelativeMtime(mtime: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - mtime);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export const BoardCard: React.FC<BoardCardProps> = ({ entry, onOpen }) => {
  const totalLaneSlots = Object.entries(entry.laneCounts);
  const tags = Object.keys(entry.tags);
  const open = () => onOpen(entry.path);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };

  return (
    <li
      className="kp-board-card"
      tabIndex={0}
      role="button"
      aria-label={`Open ${entry.title}`}
      onClick={open}
      onKeyDown={onKeyDown}
    >
      <header className="kp-board-card__head">
        <h3 className="kp-board-card__title">{entry.title}</h3>
        <span className="kp-board-card__mtime" title={new Date(entry.modifiedAt).toLocaleString()}>
          {formatRelativeMtime(entry.modifiedAt)}
        </span>
      </header>

      <div className="kp-board-card__stats">
        <span className="kp-board-card__stat">
          <strong>{entry.totalCards}</strong> cards
        </span>
        {entry.overdue > 0 ? (
          <span className="kp-board-card__stat kp-board-card__stat--alert">
            <strong>{entry.overdue}</strong> overdue
          </span>
        ) : null}
        {entry.dueWithin7d > 0 ? (
          <span className="kp-board-card__stat kp-board-card__stat--warn">
            <strong>{entry.dueWithin7d}</strong> due soon
          </span>
        ) : null}
      </div>

      {totalLaneSlots.length > 0 ? (
        <div className="kp-board-card__lanes">
          {totalLaneSlots.map(([title, count]) => (
            <span key={title} className="kp-board-card__lane">
              <span className="kp-board-card__lane-title">{title}</span>
              <span className="kp-board-card__lane-count">{count}</span>
            </span>
          ))}
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="kp-board-card__tags">
          {tags.slice(0, 6).map((tag) => (
            <span key={tag} className="kp-board-card__tag">
              {tag.startsWith('#') ? tag : `#${tag}`}
            </span>
          ))}
          {tags.length > 6 ? (
            <span className="kp-board-card__tag kp-board-card__tag--more">
              +{tags.length - 6}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="kp-board-card__path" title={entry.path}>{entry.path}</div>
    </li>
  );
};
