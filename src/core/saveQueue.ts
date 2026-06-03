/**
 * Debounced, coalescing save queue.
 *
 * ## Invariants
 *
 *  1. **Coalescing**: multiple `schedule(snapshot)` calls inside the
 *     debounce window collapse to a single `flush()` with the LATEST
 *     snapshot. We never serialize a stale snapshot.
 *
 *  2. **In-flight tracking**: if a flush is in progress and another
 *     `schedule()` arrives, we don't fire a second concurrent flush. We
 *     wait for the current one to settle, then start a new debounce timer
 *     for the queued snapshot.
 *
 *  3. **Never-silence invariant** (LOAD-BEARING).
 *     If a flush throws, we:
 *       - call `onError(err, lastSnapshot)`,
 *       - do NOT poison the queue,
 *       - DO continue to flush future `schedule()` calls.
 *     The incumbent's #1 failure mode (`StateManager.setState` skipping
 *     `requestSave` when `errors.length > 0`) is what this guards
 *     against. The save-queue caller is responsible for surfacing the
 *     error (toast + read-only banner); the queue itself never decides
 *     to stop writing.
 *
 *  4. **Cancellation**: `cancel()` drops the pending timer and the
 *     pending snapshot. Used at view teardown. It does NOT interrupt an
 *     in-flight flush — those are awaited by `flushNow()`.
 */

export interface SaveQueueOptions<S> {
  debounceMs?: number;
  flush: (snapshot: S) => Promise<void>;
  /**
   * Called when `flush()` throws. The queue keeps running; the caller
   * decides whether to surface a toast / engage read-only mode.
   */
  onError?: (err: unknown, snapshot: S) => void;
}

export interface SaveQueue<S> {
  schedule: (snapshot: S) => void;
  /** Flush any pending snapshot immediately. Resolves when the disk write
   *  settles. If nothing is pending, resolves immediately. */
  flushNow: () => Promise<void>;
  isInFlight: () => boolean;
  cancel: () => void;
}

export function createSaveQueue<S>(opts: SaveQueueOptions<S>): SaveQueue<S> {
  const debounceMs = opts.debounceMs ?? 600;
  const flush = opts.flush;
  const onError = opts.onError;

  let pending: { snapshot: S } | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  // If a schedule() lands while a flush is in flight, we stash the
  // newest snapshot here and re-arm the timer after the current flush
  // settles. This is the coalescing-during-flight path.
  let queuedDuringFlight: { snapshot: S } | null = null;

  const clearTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const doFlush = async (snapshot: S): Promise<void> => {
    try {
      await flush(snapshot);
    } catch (err) {
      // Never-silence invariant: surface the error but do NOT poison
      // the queue. Future schedule() calls must still produce flushes.
      try {
        onError?.(err, snapshot);
      } catch {
        // Even an onError callback throwing must not stop the queue.
      }
    }
  };

  const armTimer = () => {
    clearTimer();
    timerId = setTimeout(() => {
      timerId = null;
      void runFlush();
    }, debounceMs);
  };

  const runFlush = async (): Promise<void> => {
    if (inFlight) return; // already flushing; coalesce will re-arm
    if (!pending) return;
    const snapshot = pending.snapshot;
    pending = null;

    inFlight = doFlush(snapshot);
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }

    // If new work arrived during the flight, promote it into `pending`
    // and re-arm the debounce. This keeps coalescing semantics intact
    // even when writes back up.
    if (queuedDuringFlight) {
      pending = queuedDuringFlight;
      queuedDuringFlight = null;
      armTimer();
    }
  };

  return {
    schedule(snapshot: S): void {
      if (inFlight) {
        queuedDuringFlight = { snapshot };
        return;
      }
      pending = { snapshot };
      armTimer();
    },

    async flushNow(): Promise<void> {
      // Wait for any in-flight write first.
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // doFlush already routed the error through onError.
        }
      }
      // If there's a pending snapshot (timer or post-flight queued),
      // drain it now without waiting for the debounce.
      if (queuedDuringFlight && !pending) {
        pending = queuedDuringFlight;
        queuedDuringFlight = null;
      }
      if (pending) {
        clearTimer();
        await runFlush();
        // runFlush itself may queue another via post-flight promotion;
        // drain transitively (bounded — schedules during a flushNow are
        // rare; loop with a safety cap).
        let safety = 8;
        while ((pending || queuedDuringFlight) && safety-- > 0) {
          if (queuedDuringFlight && !pending) {
            pending = queuedDuringFlight;
            queuedDuringFlight = null;
          }
          if (pending) {
            clearTimer();
            await runFlush();
          }
        }
      }
    },

    isInFlight(): boolean {
      return inFlight !== null;
    },

    cancel(): void {
      clearTimer();
      pending = null;
      queuedDuringFlight = null;
    },
  };
}
