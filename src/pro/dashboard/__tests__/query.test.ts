import { describe, it, expect } from 'vitest';
import { executeQuery } from '../query';
import { createBasesAdapter } from '../basesAdapter';
import type { VaultIndexEntryShape } from '../types';

function entry(overrides: Partial<VaultIndexEntryShape> = {}): VaultIndexEntryShape {
  return {
    path: overrides.path ?? 'Board.md',
    title: overrides.title ?? 'Board',
    laneCounts: overrides.laneCounts ?? {},
    totalCards: overrides.totalCards ?? 0,
    overdue: overrides.overdue ?? 0,
    dueWithin7d: overrides.dueWithin7d ?? 0,
    tags: overrides.tags ?? {},
    modifiedAt: overrides.modifiedAt ?? 0,
  };
}

const sample: VaultIndexEntryShape[] = [
  entry({
    path: 'Alpha.md',
    title: 'Alpha',
    tags: { ops: 5, urgent: 1 },
    totalCards: 10,
    overdue: 3,
    dueWithin7d: 2,
    modifiedAt: 100,
  }),
  entry({
    path: 'Bravo.md',
    title: 'Bravo',
    tags: { 'side-project': 2 },
    totalCards: 5,
    overdue: 0,
    dueWithin7d: 4,
    modifiedAt: 200,
  }),
  entry({
    path: 'Charlie.md',
    title: 'Charlie',
    tags: { ops: 1 },
    totalCards: 0,
    overdue: 0,
    dueWithin7d: 0,
    modifiedAt: 50,
  }),
  entry({
    path: 'Delta.md',
    title: 'Delta',
    tags: { '#urgent': 1 },
    totalCards: 8,
    overdue: 1,
    dueWithin7d: 0,
    modifiedAt: 300,
  }),
];

describe('executeQuery — tag filter', () => {
  it('returns entries with any tag in the list (OR-semantics)', () => {
    const out = executeQuery(sample, { tags: ['ops'] }).map((e) => e.path);
    expect(out).toEqual(expect.arrayContaining(['Alpha.md', 'Charlie.md']));
    expect(out).not.toContain('Bravo.md');
  });

  it('normalises tag keys (strips leading #, lowercases)', () => {
    const out = executeQuery(sample, { tags: ['Urgent'] }).map((e) => e.path);
    expect(out.sort()).toEqual(['Alpha.md', 'Delta.md']);
  });
});

describe('executeQuery — status filter', () => {
  it('overdue keeps only entries with overdue > 0', () => {
    const out = executeQuery(sample, { status: 'overdue' }).map((e) => e.path);
    expect(out.sort()).toEqual(['Alpha.md', 'Delta.md']);
  });

  it('dueSoon keeps only entries with dueWithin7d > 0', () => {
    const out = executeQuery(sample, { status: 'dueSoon' }).map((e) => e.path);
    expect(out.sort()).toEqual(['Alpha.md', 'Bravo.md']);
  });

  it('active keeps entries with cards', () => {
    const out = executeQuery(sample, { status: 'active' }).map((e) => e.path);
    expect(out).not.toContain('Charlie.md');
  });

  it('all is equivalent to no status filter', () => {
    const a = executeQuery(sample, { status: 'all' }).length;
    const b = executeQuery(sample, {}).length;
    expect(a).toBe(b);
  });
});

describe('executeQuery — date brackets', () => {
  it('dueBefore filters by modifiedAt strictly less than cutoff', () => {
    const cutoff = new Date(150).toISOString();
    const out = executeQuery(sample, { dueBefore: cutoff }).map((e) => e.path);
    expect(out.sort()).toEqual(['Alpha.md', 'Charlie.md']);
  });

  it('dueAfter filters by modifiedAt strictly greater than cutoff', () => {
    const cutoff = new Date(150).toISOString();
    const out = executeQuery(sample, { dueAfter: cutoff }).map((e) => e.path);
    expect(out.sort()).toEqual(['Bravo.md', 'Delta.md']);
  });

  it('combines AND-style across filters', () => {
    const out = executeQuery(sample, {
      tags: ['ops'],
      status: 'overdue',
    }).map((e) => e.path);
    expect(out).toEqual(['Alpha.md']);
  });
});

describe('executeQuery — sorting', () => {
  it('sorts by modifiedAt descending by default', () => {
    const out = executeQuery(sample, {}).map((e) => e.path);
    expect(out).toEqual(['Delta.md', 'Bravo.md', 'Alpha.md', 'Charlie.md']);
  });

  it('sorts by overdue descending', () => {
    const out = executeQuery(sample, { sortBy: 'overdue' })
      .map((e) => `${e.path}:${e.overdue}`);
    expect(out[0]).toBe('Alpha.md:3');
    expect(out[1]).toBe('Delta.md:1');
  });

  it('sorts by title alphabetically', () => {
    const out = executeQuery(sample, { sortBy: 'title' }).map((e) => e.title);
    expect(out).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('does not mutate the input array', () => {
    const input = sample.slice();
    const originalOrder = input.map((e) => e.path);
    executeQuery(input, { sortBy: 'title' });
    expect(input.map((e) => e.path)).toEqual(originalOrder);
  });
});

describe('executeQuery — limit', () => {
  it('clamps to a non-negative integer', () => {
    expect(executeQuery(sample, { limit: 2 })).toHaveLength(2);
    expect(executeQuery(sample, { limit: 0 })).toHaveLength(0);
    expect(executeQuery(sample, { limit: -3 })).toHaveLength(0);
    expect(executeQuery(sample, { limit: 99 })).toHaveLength(4);
  });

  it('limit applies after sort', () => {
    const out = executeQuery(sample, { sortBy: 'modifiedAt', limit: 2 }).map((e) => e.path);
    expect(out).toEqual(['Delta.md', 'Bravo.md']);
  });
});

describe('createBasesAdapter', () => {
  it('reports unavailable when Bases is not loaded', () => {
    const app = {} as unknown as import('obsidian').App;
    const adapter = createBasesAdapter(app);
    expect(adapter.available()).toBe(false);
    expect(adapter.query({})).toEqual([]);
  });

  it('reports available when Bases is in app.plugins.plugins', () => {
    const app = {
      plugins: { plugins: { bases: {} } },
    } as unknown as import('obsidian').App;
    const adapter = createBasesAdapter(app);
    expect(adapter.available()).toBe(true);
  });

  it('reports available when Bases is enabled as an internal plugin', () => {
    const app = {
      internalPlugins: { plugins: { bases: { enabled: true } } },
    } as unknown as import('obsidian').App;
    const adapter = createBasesAdapter(app);
    expect(adapter.available()).toBe(true);
  });

  it('query() is a stub that returns [] even when available (v1)', () => {
    const app = {
      plugins: { plugins: { bases: {} } },
    } as unknown as import('obsidian').App;
    const adapter = createBasesAdapter(app);
    expect(adapter.query({ any: 'spec' })).toEqual([]);
  });
});
