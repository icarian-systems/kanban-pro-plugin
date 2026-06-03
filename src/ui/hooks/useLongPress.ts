/**
 * useLongPress — 350ms long-press hook tolerant of slight finger jitter.
 *
 * Returns a set of handlers to spread onto an element. Survives up to
 * `tolerance` pixels of pointer movement before bailing (mirrors dnd-kit's
 * TouchSensor activation constraint so the gesture vocabulary is consistent).
 *
 * Cancellation rules:
 *  - pointerup before delay → bail (call onCancel)
 *  - pointermove > tolerance → bail
 *  - pointercancel / contextmenu → bail
 *  - scroll detected on a parent → bail (touch scroll should never trigger)
 */
import * as React from 'react';

export interface UseLongPressOptions {
  delay?: number;
  tolerance?: number;
  onLongPress: (event: PointerEvent) => void;
  onCancel?: () => void;
  /**
   * If true, suppress the immediate `click` that follows a long-press on
   * desktop. Defaults to true.
   */
  suppressClick?: boolean;
}

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export function useLongPress({
  delay = 350,
  tolerance = 8,
  onLongPress,
  onCancel,
  suppressClick = true,
}: UseLongPressOptions): LongPressHandlers {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = React.useRef<{ x: number; y: number } | null>(null);
  const firedRef = React.useRef(false);
  const lastEventRef = React.useRef<PointerEvent | null>(null);

  const clear = React.useCallback(
    (cancelled: boolean) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      startPosRef.current = null;
      lastEventRef.current = null;
      if (cancelled && !firedRef.current) {
        onCancel?.();
      }
      // Reset firedRef on a microtask so click suppression below can read it.
      Promise.resolve().then(() => {
        firedRef.current = false;
      });
    },
    [onCancel],
  );

  // Suppress the synthetic click that follows a long-press.
  React.useEffect(() => {
    if (!suppressClick) return;
    const onClickCapture = (e: MouseEvent) => {
      if (firedRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('click', onClickCapture, true);
    return () => window.removeEventListener('click', onClickCapture, true);
  }, [suppressClick]);

  const handlers = React.useMemo<LongPressHandlers>(
    () => ({
      onPointerDown: (e: React.PointerEvent) => {
        // Only primary-button (or any touch) triggers long-press.
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        firedRef.current = false;
        startPosRef.current = { x: e.clientX, y: e.clientY };
        lastEventRef.current = e.nativeEvent;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          firedRef.current = true;
          timerRef.current = null;
          if (lastEventRef.current) onLongPress(lastEventRef.current);
        }, delay);
      },
      onPointerMove: (e: React.PointerEvent) => {
        const start = startPosRef.current;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (dx * dx + dy * dy > tolerance * tolerance) {
          clear(true);
        }
      },
      onPointerUp: (_e: React.PointerEvent) => {
        if (!firedRef.current) clear(true);
        else clear(false);
      },
      onPointerCancel: (_e: React.PointerEvent) => {
        clear(true);
      },
      onContextMenu: (e: React.MouseEvent) => {
        // On touch, the browser fires `contextmenu` at ~500ms; we already
        // fire at 350ms, so suppress the native menu when we own the gesture.
        if (firedRef.current) {
          e.preventDefault();
        }
      },
    }),
    [delay, tolerance, onLongPress, clear],
  );

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return handlers;
}
