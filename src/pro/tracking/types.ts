/**
 * Time-tracking types.
 *
 * Durations are *never* stored. Each TimerEntry records only the wall-clock
 * boundaries (startedAt / endedAt) as ISO strings. Live elapsed is computed
 * on demand from `Date.now()`. This avoids mobile timer drift: accumulating
 * via setInterval breaks across iOS background suspension.
 */

import type { CardId } from '@/core/model';

export interface TimerEntry {
  id: string;
  cardId: CardId;
  /** ISO timestamp when the timer was started. */
  startedAt: string;
  /** ISO timestamp when the timer was stopped. Absent → still running. */
  endedAt?: string;
  /** Optional note attached at start (or rotated by re-calling start). */
  note?: string;
}

export interface TrackingState {
  entries: TimerEntry[];
}

export interface TrackingStore {
  start(cardId: CardId, note?: string): Promise<TimerEntry>;
  stop(cardId: CardId): Promise<TimerEntry | undefined>;
  current(cardId: CardId): TimerEntry | undefined;
  /** Any single running timer across all cards (the right-rail "Active Timer"
   *  panel needs this — it has no cardId to scope `current()` by). Returns the
   *  earliest-started in-flight entry, or undefined when nothing is running. */
  getActive(): TimerEntry | undefined;
  /** Total ms across all closed entries plus current in-flight, if any. */
  totalMs(cardId: CardId): number;
  history(cardId: CardId): TimerEntry[];
  onChange(cb: () => void): () => void;
  /** Optional manual-entry creation. Unimplemented in v1 (the TrackingPanel
   *  hides its manual-entry form when this is absent). Reserved for 1.x. */
  addManual?(cardId: CardId, startedAtMs: number, endedAtMs: number, note?: string): Promise<void> | void;
}

export const TRACKING_STORAGE_KEY = 'tracking';
