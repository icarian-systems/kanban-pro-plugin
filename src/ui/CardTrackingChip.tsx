/**
 * CardTrackingChip — inline timer control on a Card's meta row.
 *
 * Renders three states:
 *   1. Free user → small lock icon + "Pro" tag; click → paywall event.
 *   2. Pro user, no time logged + no running timer → "Start" affordance.
 *   3. Pro user, time logged or running → formatDuration(total) + play/stop.
 *
 * The chip subscribes to `trackingStore.onChange` and re-renders. It
 * doesn't poll: while a timer is running, we use the WALL-CLOCK delta
 * (`Date.now() - entry.startedAt`) recomputed on each render. To keep
 * the display fresh, the chip ticks once per minute via a debounced
 * setTimeout — at minute-level resolution we never need to setInterval
 * (the architecture's mobile-drift mitigation: "wall-clock-diff, no
 * setInterval accumulation").
 *
 * The TrackingStore is provided via React context so the chip doesn't
 * need to know how main.ts wires it up — KanbanView (or its parent)
 * wraps the board tree in <TrackingProvider store={…}>.
 */
import * as React from 'react';
import { useEntitlement } from '@/pro/license/state';
import { useLongPress } from '@/ui/hooks/useLongPress';
import {
  formatDuration,
  type TrackingStore,
} from '@/ui/contracts';

const TrackingContext = React.createContext<TrackingStore | null>(null);

export const TrackingProvider: React.FC<{
  store: TrackingStore | null;
  children: React.ReactNode;
}> = ({ store, children }) => {
  return (
    <TrackingContext.Provider value={store}>{children}</TrackingContext.Provider>
  );
};

export function useTrackingStore(): TrackingStore | null {
  return React.useContext(TrackingContext);
}

/**
 * Subscribe to the store; returns an opaque tick that increments on each
 * change. Components use it as a hook-dep to re-derive their projection.
 */
function useTrackingTick(store: TrackingStore | null): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!store) return;
    return store.onChange(() => setTick((t) => t + 1));
  }, [store]);
  return tick;
}

/** Tick every minute while `enabled` so a running timer's label stays fresh. */
function useMinuteTick(enabled: boolean): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const schedule = () => {
      // Align to the next minute boundary so we don't drift.
      const now = Date.now();
      const next = 60_000 - (now % 60_000);
      const id = window.setTimeout(() => {
        if (cancelled) return;
        setTick((t) => t + 1);
        schedule();
      }, Math.max(1_000, next));
      return () => window.clearTimeout(id);
    };
    const cleanup = schedule();
    return () => { cancelled = true; cleanup(); };
  }, [enabled]);
  return tick;
}

const PlayIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
    <path d="M4 2.5v9l8-4.5z" />
  </svg>
);

const StopIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
    <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
  </svg>
);

const LockIcon: React.FC = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    <rect x="3" y="6.5" width="8" height="6" rx="1" />
    <path d="M5 6.5V4.5a2 2 0 0 1 4 0V6.5" />
  </svg>
);

export interface CardTrackingChipProps {
  cardId: string;
  /**
   * Optional callback invoked on long-press. When omitted, the chip
   * dispatches a `kanban-pro:open-tracking-panel` window event so the host
   * (KanbanView) can decide whether to mount TrackingPanel without Card
   * needing to know about timer state.
   */
  onOpenPanel?: (cardId: string) => void;
  /**
   * When true, render the lock+"Pro" affordance for free-tier users
   * even if the card has no tracking data. Default is false: free users
   * with no tracking entry on the card see nothing, so stock cards aren't
   * spammed with a "Pro" badge.
   */
  freeTierAffordance?: boolean;
}

export const TRACKING_PANEL_EVENT = 'kanban-pro:open-tracking-panel';

export const CardTrackingChip: React.FC<CardTrackingChipProps> = ({
  cardId,
  onOpenPanel,
  freeTierAffordance = false,
}) => {
  const store = useTrackingStore();
  const isPro = useEntitlement('tracking');

  // Re-render on store mutations.
  const _storeTick = useTrackingTick(store);
  // Tick when a timer is running so the label tracks wall-clock minutes.
  const isRunning = Boolean(store?.current(cardId));
  const _minuteTick = useMinuteTick(isRunning);
  // Reference the ticks so eslint-no-unused-vars stays happy and React's
  // reactivity is unambiguous.
  void _storeTick;
  void _minuteTick;

  const totalMs = store?.totalMs(cardId) ?? 0;
  const hasTime = totalMs > 0;

  const longPress = useLongPress({
    onLongPress: () => {
      if (onOpenPanel) onOpenPanel(cardId);
      else {
        window.dispatchEvent(
          new CustomEvent(TRACKING_PANEL_EVENT, { detail: { cardId } }),
        );
      }
    },
  });

  if (!isPro) {
    // Free-tier: only surface the chip when explicitly requested.
    // Without this gate, every stock card on a fresh board ended up with
    // a stray "Pro" badge despite having no tracking data attached.
    if (!freeTierAffordance) return null;
    const onClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent('kanban-pro:open-pro-settings', {
          detail: { feature: 'Time tracking' },
        }),
      );
    };
    return (
      <button
        type="button"
        className="kp-tracking-chip kp-tracking-chip--locked"
        onClick={onClick}
        title="Time tracking is a Kanban Pro feature"
        aria-label="Time tracking (Pro)"
      >
        <LockIcon />
        <span className="kp-tracking-chip__label">Pro</span>
      </button>
    );
  }

  if (!store) {
    // Pro entitlement but no store wired (e.g. early boot) — render nothing.
    return null;
  }

  const onToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) void store.stop(cardId);
    else void store.start(cardId);
  };

  // Compose the long-press handlers so the chip opens the panel on hold
  // without conflicting with the dnd-kit drag handlers on the parent card.
  const composedPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    longPress.onPointerDown(e);
  };

  return (
    <button
      type="button"
      className={`kp-tracking-chip${isRunning ? ' is-running' : ''}${
        hasTime && !isRunning ? ' has-time' : ''
      }`}
      onClick={onToggle}
      onPointerDown={composedPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onContextMenu={longPress.onContextMenu}
      aria-label={isRunning ? 'Stop timer' : 'Start timer'}
      title={isRunning ? 'Click to stop · long-press for details' : 'Click to start · long-press for details'}
    >
      <span className="kp-tracking-chip__icon">
        {isRunning ? <StopIcon /> : <PlayIcon />}
      </span>
      <span className="kp-tracking-chip__label">
        {hasTime || isRunning ? formatDuration(totalMs) : 'Track'}
      </span>
      {isRunning ? <span className="kp-tracking-chip__pulse" aria-hidden="true" /> : null}
    </button>
  );
};
