/**
 * TrackingPanel — slide-in drawer that lists timer history for a card.
 *
 * Mounts as a sibling to DetailPanel (the host renders one OR the other
 * via state). Backdrop click and Esc close. Same z-index family as
 * DetailPanel so it overlays the board uniformly.
 *
 * Optional "Add manual entry" form is shown only when the TrackingStore
 * exposes `addManual`. Tracking is Pro-only; the panel never renders for
 * free users (the chip handles that).
 */
import * as React from 'react';
import { useTrackingStore } from '@/ui/CardTrackingChip';
import { formatDuration, type TimerEntry } from '@/ui/contracts';

export interface TrackingPanelProps {
  cardId: string | null;
  onClose: () => void;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function entryDuration(e: TimerEntry, now = Date.now()): number {
  const start = Date.parse(e.startedAt);
  if (!Number.isFinite(start)) return 0;
  const end = e.endedAt ? Date.parse(e.endedAt) : now;
  return Math.max(0, end - start);
}

export const TrackingPanel: React.FC<TrackingPanelProps> = ({ cardId, onClose }) => {
  const store = useTrackingStore();

  // Subscribe to store ticks so the panel rerenders on start/stop/manual.
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!store) return;
    return store.onChange(() => setTick((t) => t + 1));
  }, [store]);
  void tick;

  React.useEffect(() => {
    if (!cardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cardId, onClose]);

  // Manual entry form state.
  const [manualStart, setManualStart] = React.useState('');
  const [manualEnd, setManualEnd] = React.useState('');
  const [manualNote, setManualNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  if (!cardId || !store) return null;

  const history = store.history(cardId);
  const current = store.current(cardId);
  const total = store.totalMs(cardId);

  const onBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const submitManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store.addManual) return;
    const startMs = Date.parse(manualStart);
    const endMs = Date.parse(manualEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
    setSubmitting(true);
    try {
      await store.addManual(cardId, startMs, endMs, manualNote || undefined);
      setManualStart('');
      setManualEnd('');
      setManualNote('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="kp-tracking-overlay"
      role="presentation"
      onMouseDown={onBackdrop}
    >
      <aside
        className="kp-tracking-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Time tracking"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="kp-tracking-panel__head">
          <div>
            <h2 className="kp-tracking-panel__title">Time tracking</h2>
            <p className="kp-tracking-panel__total">
              Total: <strong>{formatDuration(total)}</strong>
              {current ? <span className="kp-tracking-panel__running">· running</span> : null}
            </p>
          </div>
          <button
            type="button"
            className="kp-tracking-panel__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="kp-tracking-panel__body">
          <div className="kp-tracking-panel__actions">
            {current ? (
              <button
                type="button"
                className="kp-tracking-panel__primary kp-tracking-panel__primary--stop"
                onClick={() => void store.stop(cardId)}
              >
                Stop timer
              </button>
            ) : (
              <button
                type="button"
                className="kp-tracking-panel__primary"
                onClick={() => void store.start(cardId)}
              >
                Start timer
              </button>
            )}
          </div>

          <section className="kp-tracking-panel__section">
            <h3 className="kp-tracking-panel__h">History</h3>
            {history.length === 0 && !current ? (
              <p className="kp-tracking-panel__empty">No entries yet.</p>
            ) : (
              <table className="kp-tracking-panel__table">
                <thead>
                  <tr>
                    <th>Start</th>
                    <th>End</th>
                    <th>Duration</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {current ? (
                    <tr className="is-running">
                      <td>{fmtTime(current.startedAt)}</td>
                      <td>—</td>
                      <td>{formatDuration(entryDuration(current))}</td>
                      <td>{current.note ?? <em>running…</em>}</td>
                    </tr>
                  ) : null}
                  {history.map((e) => (
                    <tr key={e.id}>
                      <td>{fmtTime(e.startedAt)}</td>
                      <td>{fmtTime(e.endedAt)}</td>
                      <td>{formatDuration(entryDuration(e))}</td>
                      <td>{e.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {store.addManual ? (
            <section className="kp-tracking-panel__section">
              <h3 className="kp-tracking-panel__h">Add manual entry</h3>
              <form className="kp-tracking-panel__form" onSubmit={submitManual}>
                <label>
                  <span>Start</span>
                  <input
                    type="datetime-local"
                    value={manualStart}
                    onChange={(e) => setManualStart(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>End</span>
                  <input
                    type="datetime-local"
                    value={manualEnd}
                    onChange={(e) => setManualEnd(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Note</span>
                  <input
                    type="text"
                    value={manualNote}
                    placeholder="Optional"
                    onChange={(e) => setManualNote(e.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="kp-tracking-panel__primary"
                  disabled={submitting}
                >
                  {submitting ? 'Adding…' : 'Add entry'}
                </button>
              </form>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
};
