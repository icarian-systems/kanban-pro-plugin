import { describe, it, expect, vi } from 'vitest';
import { createTrackingStore } from '../store';
import { formatDuration } from '../format';
import { TRACKING_STORAGE_KEY } from '../types';

/** Tiny stand-in for `Plugin` that only exposes loadData/saveData. */
function makeHost(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initial };
  return {
    loadData: vi.fn(async () => ({ ...data })),
    saveData: vi.fn(async (d: Record<string, unknown>) => {
      data = { ...d };
    }),
    snapshot: () => data,
  };
}

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe('createTrackingStore — start/stop lifecycle', () => {
  it('start returns a new in-flight entry and stop closes it', async () => {
    const host = makeHost();
    const clock = makeClock();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin, {
      now: clock.now,
      newId: () => 'fixed-id',
    });

    const started = await store.start('card-1', 'kick off');
    expect(started.endedAt).toBeUndefined();
    expect(started.note).toBe('kick off');
    expect(store.current('card-1')).toEqual(started);

    clock.advance(60_000);
    const stopped = await store.stop('card-1');
    expect(stopped?.endedAt).toBeDefined();
    expect(store.current('card-1')).toBeUndefined();
    // 60s elapsed
    expect(store.totalMs('card-1')).toBe(60_000);
  });

  it('getActive returns the running entry across cards, undefined when idle', async () => {
    const host = makeHost();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin);

    expect(store.getActive()).toBeUndefined();
    const started = await store.start('card-7');
    // No cardId scope needed — the right-rail panel relies on this.
    expect(store.getActive()?.id).toBe(started.id);
    expect(store.getActive()?.cardId).toBe('card-7');
    await store.stop('card-7');
    expect(store.getActive()).toBeUndefined();
  });

  it('start while running is idempotent on cardId', async () => {
    const host = makeHost();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin);

    const first = await store.start('card-1');
    const second = await store.start('card-1');
    expect(second.id).toBe(first.id);
    expect(store.history('card-1')).toHaveLength(1);
  });

  it('start while running rotates the note when one is provided', async () => {
    const host = makeHost();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin);

    const first = await store.start('card-1', 'a');
    const second = await store.start('card-1', 'b');
    expect(second.id).toBe(first.id);
    expect(second.note).toBe('b');
  });

  it('stop on a card with no running timer returns undefined', async () => {
    const host = makeHost();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin);
    expect(await store.stop('card-1')).toBeUndefined();
  });
});

describe('createTrackingStore — wall-clock totals', () => {
  it('totalMs sums closed entries plus current in-flight', async () => {
    const host = makeHost();
    const clock = makeClock();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin, {
      now: clock.now,
    });

    await store.start('c1');
    clock.advance(30_000);
    await store.stop('c1');
    expect(store.totalMs('c1')).toBe(30_000);

    await store.start('c1');
    clock.advance(15_000);
    // not stopped — totalMs includes in-flight slice
    expect(store.totalMs('c1')).toBe(45_000);

    clock.advance(15_000);
    expect(store.totalMs('c1')).toBe(60_000);
  });

  it('totalMs is computed on demand — never accumulates via interval', async () => {
    // No fake timers needed. Just prove that advancing the clock without
    // calling any store API changes the reported total — that's the
    // definition of wall-clock-diff.
    const host = makeHost();
    const clock = makeClock();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin, {
      now: clock.now,
    });
    await store.start('c1');
    const t0 = store.totalMs('c1');
    clock.advance(5_000);
    const t1 = store.totalMs('c1');
    expect(t1 - t0).toBe(5_000);
  });
});

describe('createTrackingStore — persistence', () => {
  it('persists entries through loadData/saveData', async () => {
    const host = makeHost();
    const clock = makeClock();
    const store1 = createTrackingStore(host as unknown as import('obsidian').Plugin, {
      now: clock.now,
      newId: () => 'persisted-id',
    });

    await store1.start('c1', 'work');
    clock.advance(10_000);
    await store1.stop('c1');

    const persisted = host.snapshot();
    expect(persisted[TRACKING_STORAGE_KEY]).toBeDefined();
    const entries = (persisted[TRACKING_STORAGE_KEY] as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(1);

    // Spin up a second store backed by the same host — entries should rehydrate.
    const store2 = createTrackingStore(host as unknown as import('obsidian').Plugin, {
      now: clock.now,
    });
    // Force load via any read op.
    await store2.start('c2');
    expect(store2.totalMs('c1')).toBe(10_000);
  });

  it('coexists with other plugin-data keys (does not clobber them)', async () => {
    const host = makeHost({ savedViews: [{ id: 'sv1' }] });
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin);
    await store.start('c1');
    expect(host.snapshot().savedViews).toEqual([{ id: 'sv1' }]);
    expect(host.snapshot()[TRACKING_STORAGE_KEY]).toBeDefined();
  });

  it('tolerates malformed persisted state', async () => {
    const host = makeHost({
      [TRACKING_STORAGE_KEY]: {
        entries: [
          'not-an-entry',
          { id: 'ok', cardId: 'c', startedAt: '2026-01-01T00:00:00Z' },
        ],
      },
    });
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin);
    // Trigger lazy load via any async API.
    await store.stop('other');
    expect(store.history('c')).toHaveLength(1);
  });
});

describe('createTrackingStore — onChange', () => {
  it('fires on start and stop', async () => {
    const host = makeHost();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin);
    const cb = vi.fn();
    store.onChange(cb);
    await store.start('c1');
    expect(cb).toHaveBeenCalledTimes(1);
    await store.stop('c1');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('returns an unsubscribe fn', async () => {
    const host = makeHost();
    const store = createTrackingStore(host as unknown as import('obsidian').Plugin);
    const cb = vi.fn();
    const off = store.onChange(cb);
    off();
    await store.start('c1');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('formatDuration', () => {
  it('formats sub-second as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(999)).toBe('0s');
  });
  it('formats seconds', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });
  it('formats minutes (with seconds if < 5 min)', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(75_000)).toBe('1m 15s');
    expect(formatDuration(4 * 60_000 + 30_000)).toBe('4m 30s');
  });
  it('formats minutes without seconds when >= 5 min', () => {
    expect(formatDuration(7 * 60_000 + 12_000)).toBe('7m');
  });
  it('formats hours', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(83 * 60_000)).toBe('1h 23m');
  });
  it('formats days', () => {
    expect(formatDuration(24 * 3_600_000)).toBe('1d');
    expect(formatDuration(25 * 3_600_000)).toBe('1d 1h');
  });
  it('clamps invalid/negative input', () => {
    expect(formatDuration(-10)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});
