/**
 * Time-tracking store.
 *
 * Persisted shape under plugin.saveData/loadData key `tracking`:
 *   { entries: TimerEntry[] }
 *
 * Invariants:
 *   - At most one in-flight entry per cardId at any time.
 *   - Closed entries are immutable.
 *   - `totalMs` is computed on demand from wall-clock diffs — no setInterval
 *     accumulation. This is the *only* correct way to handle iOS background
 *     suspension (Architecture risk row: "Mobile timer drift / suspend").
 */

import type { CardId } from '@/core/model';
import { log } from '@/shared/log';
import {
  type TimerEntry,
  type TrackingState,
  type TrackingStore,
  TRACKING_STORAGE_KEY,
} from './types';

/** Minimal contract we need from the host plugin — keeps this unit testable. */
interface DataHost {
  loadData(): Promise<Record<string, unknown> | null | undefined>;
  saveData(data: Record<string, unknown>): Promise<void>;
}

interface InternalOpts {
  /** Override Date.now for deterministic tests. */
  now?: () => number;
  /** Override id generation for deterministic tests. */
  newId?: () => string;
}

export function createTrackingStore(
  plugin: import('obsidian').Plugin | DataHost,
  opts: InternalOpts = {},
): TrackingStore {
  const host = plugin as unknown as DataHost;
  const now = opts.now ?? (() => Date.now());
  const newId =
    opts.newId ??
    (() => `te-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  let state: TrackingState = { entries: [] };
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const raw = (await host.loadData()) ?? {};
          const tracked = (raw as Record<string, unknown>)[TRACKING_STORAGE_KEY];
          if (tracked && typeof tracked === 'object') {
            const arr = (tracked as { entries?: unknown }).entries;
            if (Array.isArray(arr)) {
              state = { entries: arr.filter(isTimerEntry) };
            }
          }
        } catch (e) {
          log.warn('tracking: load failed', e);
        } finally {
          loaded = true;
        }
      })();
    }
    await loadPromise;
  }

  async function persist(): Promise<void> {
    try {
      const raw = ((await host.loadData()) ?? {}) as Record<string, unknown>;
      raw[TRACKING_STORAGE_KEY] = state;
      await host.saveData(raw);
    } catch (e) {
      log.warn('tracking: save failed', e);
    }
  }

  function notify(): void {
    for (const l of listeners) {
      try {
        l();
      } catch (e) {
        log.warn('tracking listener threw', e);
      }
    }
  }

  function findCurrent(cardId: CardId): TimerEntry | undefined {
    return state.entries.find((e) => e.cardId === cardId && !e.endedAt);
  }

  async function start(cardId: CardId, note?: string): Promise<TimerEntry> {
    await ensureLoaded();
    const existing = findCurrent(cardId);
    if (existing) {
      if (note !== undefined && note !== existing.note) {
        existing.note = note;
        await persist();
        notify();
      }
      return existing;
    }
    const entry: TimerEntry = {
      id: newId(),
      cardId,
      startedAt: new Date(now()).toISOString(),
      note,
    };
    state = { entries: [...state.entries, entry] };
    await persist();
    notify();
    return entry;
  }

  async function stop(cardId: CardId): Promise<TimerEntry | undefined> {
    await ensureLoaded();
    const current = findCurrent(cardId);
    if (!current) return undefined;
    const endedAt = new Date(now()).toISOString();
    const closed: TimerEntry = { ...current, endedAt };
    state = {
      entries: state.entries.map((e) => (e.id === current.id ? closed : e)),
    };
    await persist();
    notify();
    return closed;
  }

  function current(cardId: CardId): TimerEntry | undefined {
    return findCurrent(cardId);
  }

  function getActive(): TimerEntry | undefined {
    // Any in-flight entry (no endedAt). At most one per card; across cards we
    // surface the first the right-rail panel can show + stop.
    return state.entries.find((e) => !e.endedAt);
  }

  function totalMs(cardId: CardId): number {
    let total = 0;
    const cutoff = now();
    for (const e of state.entries) {
      if (e.cardId !== cardId) continue;
      const startMs = Date.parse(e.startedAt);
      if (!Number.isFinite(startMs)) continue;
      const endMs = e.endedAt ? Date.parse(e.endedAt) : cutoff;
      if (!Number.isFinite(endMs)) continue;
      if (endMs > startMs) total += endMs - startMs;
    }
    return total;
  }

  function history(cardId: CardId): TimerEntry[] {
    return state.entries.filter((e) => e.cardId === cardId);
  }

  function onChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  return { start, stop, current, getActive, totalMs, history, onChange };
}

function isTimerEntry(v: unknown): v is TimerEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.cardId === 'string' &&
    typeof e.startedAt === 'string' &&
    (e.endedAt === undefined || typeof e.endedAt === 'string') &&
    (e.note === undefined || typeof e.note === 'string')
  );
}
