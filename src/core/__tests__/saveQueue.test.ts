/**
 * Save queue tests.
 *
 * Focus: the never-silence invariant. The incumbent plugin's #1 failure
 * mode is silent edit loss — `StateManager.setState` skips saves when
 * `errors.length > 0`. Our queue must NEVER stop writing because a prior
 * write failed. These tests are the spec for that property.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSaveQueue } from '../saveQueue';

describe('createSaveQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces multiple schedules into a single flush', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const q = createSaveQueue<number>({ debounceMs: 100, flush });
    q.schedule(1);
    q.schedule(2);
    q.schedule(3);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(3); // latest snapshot wins
  });

  it('flushNow drains immediately without waiting for the debounce', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const q = createSaveQueue<string>({ debounceMs: 1000, flush });
    q.schedule('a');
    const p = q.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('a');
  });

  it('cancel drops pending work without flushing', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const q = createSaveQueue<string>({ debounceMs: 100, flush });
    q.schedule('x');
    q.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(flush).not.toHaveBeenCalled();
  });

  it('isInFlight reflects active flush state', async () => {
    let resolveInner: (() => void) | null = null;
    const flush = vi.fn().mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveInner = res;
        }),
    );
    const q = createSaveQueue<number>({ debounceMs: 50, flush });
    q.schedule(1);
    expect(q.isInFlight()).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    // Now the flush promise is pending — isInFlight should be true.
    expect(q.isInFlight()).toBe(true);
    resolveInner!();
    await Promise.resolve();
    await Promise.resolve();
    expect(q.isInFlight()).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────
  // NEVER-SILENCE INVARIANT — the load-bearing tests.
  // ──────────────────────────────────────────────────────────────────

  it('NEVER-SILENCE: after a flush throws, the next schedule still produces a flush', async () => {
    const flush = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const q = createSaveQueue<number>({ debounceMs: 100, flush, onError });

    // First schedule → flush throws.
    q.schedule(1);
    await vi.advanceTimersByTimeAsync(100);
    // Allow the rejection to propagate through the queue's try/catch.
    await Promise.resolve();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('boom');

    // Critical: queue is NOT poisoned. The next schedule must still flush.
    q.schedule(2);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith(2);
  });

  it('NEVER-SILENCE: many consecutive failures do not stop future writes', async () => {
    const flush = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const q = createSaveQueue<number>({ debounceMs: 50, flush, onError });

    for (let i = 1; i <= 3; i++) {
      q.schedule(i);
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(onError).toHaveBeenCalledTimes(3);

    // After three failures, schedule a fourth — must flush.
    q.schedule(4);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(4);
    expect(flush).toHaveBeenLastCalledWith(4);
  });

  it('NEVER-SILENCE: an onError that itself throws does not stop future writes', async () => {
    const flush = vi
      .fn()
      .mockRejectedValueOnce(new Error('flush-fail'))
      .mockResolvedValue(undefined);
    const onError = vi.fn().mockImplementation(() => {
      throw new Error('handler-fail');
    });
    const q = createSaveQueue<number>({ debounceMs: 30, flush, onError });

    q.schedule(1);
    await vi.advanceTimersByTimeAsync(30);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);

    // Even though onError threw, the queue must still accept new work.
    q.schedule(2);
    await vi.advanceTimersByTimeAsync(30);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith(2);
  });

  it('NEVER-SILENCE: schedules arriving during an in-flight flush are not dropped', async () => {
    let resolveFirst: (() => void) | null = null;
    const flush = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValue(undefined);
    const q = createSaveQueue<number>({ debounceMs: 10, flush });

    q.schedule(1);
    await vi.advanceTimersByTimeAsync(10);
    // First flush is in flight.
    expect(q.isInFlight()).toBe(true);

    // Schedule arriving during the flight.
    q.schedule(2);
    q.schedule(3);
    // Still only one flush so far.
    expect(flush).toHaveBeenCalledTimes(1);

    // Settle the first flush.
    resolveFirst!();
    await Promise.resolve();
    await Promise.resolve();
    // The queued-during-flight snapshot should now be re-armed.
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith(3); // coalesced to latest
  });

  it('NEVER-SILENCE: schedules arriving during a FAILING in-flight flush are not dropped', async () => {
    let rejectFirst: ((err: unknown) => void) | null = null;
    const flush = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_res, rej) => {
            rejectFirst = rej;
          }),
      )
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const q = createSaveQueue<number>({ debounceMs: 10, flush, onError });

    q.schedule(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(q.isInFlight()).toBe(true);

    // New work arrives while the first flush is in flight and about to fail.
    q.schedule(2);

    // First flush fails.
    rejectFirst!(new Error('mid-flight-fail'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);

    // The post-flight queued snapshot must still be flushed.
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith(2);
  });
});
