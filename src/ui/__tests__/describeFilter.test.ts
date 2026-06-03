/**
 * describeFilter — filter-chip label regression test.
 *
 * The toolbar Filter chip's label is "Filter · <description>". Before this
 * fix the description omitted `dueAfter` and `done`, which made the
 * pre-seeded "Overdue" / "Due this week" views collapse to "all" once
 * activeSavedViewName cleared — the user lost the visual cue that a
 * filter was set. These tests pin every dimension the filter engine
 * applies.
 *
 * The relative-day shorthand asserts on a date that's clearly within
 * the 60-day window so we don't depend on `new Date()` drift between
 * test runs.
 */
import { describe, it, expect } from 'vitest';
import { describeFilter } from '@/ui/BoardRoot';

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

describe('describeFilter — dimensions', () => {
  it('returns "all" for an empty filter and empty search', () => {
    expect(describeFilter({}, '')).toBe('all');
  });

  it('describes a single tag as `#tag`', () => {
    expect(describeFilter({ tags: ['bug'] }, '')).toBe('#bug');
  });

  it('describes a single assignee as `@name`', () => {
    expect(describeFilter({ assignees: ['jane'] }, '')).toBe('@jane');
  });

  it('describes `dueBefore` alone as `due < <iso>`', () => {
    expect(describeFilter({ dueBefore: '2099-01-01' }, '')).toBe('due < 2099-01-01');
  });

  it('describes `dueAfter` alone as `due > <iso>`', () => {
    expect(describeFilter({ dueAfter: '2026-01-01' }, '')).toBe('due > 2026-01-01');
  });

  it('collapses `dueAfter` + `dueBefore` to `due ≤ Nd` when the upper bound is within 60 days', () => {
    const after = todayPlus(-1);
    const before = todayPlus(8);
    // Upper bound = today + 8 days, so the relative shorthand renders as
    // `due ≤ 8d` (rounded from the upper-minus-today diff in days).
    const out = describeFilter({ dueAfter: after, dueBefore: before }, '');
    expect(out).toBe('due ≤ 8d');
  });

  it('falls back to absolute window when upper bound is beyond 60 days', () => {
    const out = describeFilter(
      { dueAfter: '2026-01-01', dueBefore: '2099-01-01' },
      '',
    );
    expect(out).toBe('due > 2026-01-01 · due < 2099-01-01');
  });

  it('describes `done: false` as `open` and `done: true` as `done`', () => {
    expect(describeFilter({ done: false }, '')).toBe('open');
    expect(describeFilter({ done: true }, '')).toBe('done');
  });

  it('combines multiple dimensions with " · " separator', () => {
    const out = describeFilter(
      { tags: ['bug'], assignees: ['jane'], done: false },
      '',
    );
    expect(out).toBe('#bug · @jane · open');
  });

  it('includes the search text when set', () => {
    const out = describeFilter({}, 'planning');
    expect(out).toBe('search:"planning"');
  });

  it('overdue-style filter (dueBefore + done:false) shows both dimensions', () => {
    // Mirrors the resolved filter for the pre-seeded "Overdue" default view.
    const out = describeFilter(
      { dueBefore: '2026-05-15', done: false },
      '',
    );
    expect(out).toBe('due < 2026-05-15 · open');
  });
});
