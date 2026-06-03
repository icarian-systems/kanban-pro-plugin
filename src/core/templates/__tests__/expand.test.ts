/**
 * Template expansion tests — pure token substitution. The expand step is
 * deterministic given a clock; we pass a fixed `now` rather than mocking
 * Date globally.
 */
import { describe, it, expect, vi } from 'vitest';
import { expandTemplate, createTemplateStore, SEED_TEMPLATES } from '../index';
import type { BasicTemplate } from '../types';

const FIXED_NOW = new Date('2026-05-14T09:30:00');

describe('expandTemplate', () => {
  it('substitutes {{date}} and {{time}} using the supplied clock', () => {
    const t: BasicTemplate = {
      id: 't1',
      name: 'date+time',
      body: '{{date}} at {{time}}',
    };
    const out = expandTemplate(t, { now: FIXED_NOW });
    expect(out.text).toBe('2026-05-14 at 09:30');
    expect(out.cursorOffset).toBeUndefined();
  });

  it('extracts the first {{cursor}} offset and strips the token', () => {
    const t: BasicTemplate = {
      id: 't2',
      name: 'cursor',
      body: 'Bug: {{cursor}}\nDetails:',
    };
    const out = expandTemplate(t, { now: FIXED_NOW });
    expect(out.text).toBe('Bug: \nDetails:');
    expect(out.cursorOffset).toBe(5);
  });

  it('collapses repeated {{cursor}} tokens — only the first sticks', () => {
    const t: BasicTemplate = {
      id: 't3',
      name: 'cursor x2',
      body: 'a{{cursor}}b{{cursor}}c',
    };
    const out = expandTemplate(t, { now: FIXED_NOW });
    expect(out.text).toBe('abc');
    expect(out.cursorOffset).toBe(1);
  });

  it('forwards the meta seed verbatim', () => {
    const t: BasicTemplate = {
      id: 't4',
      name: 'meta',
      body: '',
      meta: { tags: ['x'], fields: { k: 'v' } },
    };
    const out = expandTemplate(t, { now: FIXED_NOW });
    expect(out.meta).toEqual({ tags: ['x'], fields: { k: 'v' } });
  });

  it('does not mutate the input template body', () => {
    const t: BasicTemplate = {
      id: 't5',
      name: 'pure',
      body: 'Today: {{date}}{{cursor}}',
    };
    const before = t.body;
    expandTemplate(t, { now: FIXED_NOW });
    expect(t.body).toBe(before);
  });
});

describe('createTemplateStore (seed behaviour)', () => {
  it('returns seed templates when no persisted data exists', async () => {
    // Minimal Plugin double — only needs loadData/saveData.
    const persisted: Record<string, unknown> = {};
    const plugin = {
      loadData: vi.fn(async () => Object.keys(persisted).length ? persisted : null),
      saveData: vi.fn(async (d: Record<string, unknown>) => {
        Object.assign(persisted, d);
      }),
    } as unknown as import('obsidian').Plugin;

    const store = createTemplateStore(plugin);
    // Hydration is fire-and-forget in the constructor; wait for it so the
    // first getAll() reflects seed templates rather than the synchronous
    // fallback.
    await new Promise((r) => setTimeout(r, 0));
    const all = store.getAll();
    expect(all.length).toBe(SEED_TEMPLATES.length);
    expect(all.map((t) => t.id)).toEqual(SEED_TEMPLATES.map((t) => t.id));
  });

  it('upsert persists and notifies subscribers', async () => {
    const persisted: Record<string, unknown> = {};
    const plugin = {
      loadData: vi.fn(async () => Object.keys(persisted).length ? persisted : null),
      saveData: vi.fn(async (d: Record<string, unknown>) => {
        Object.assign(persisted, d);
      }),
    } as unknown as import('obsidian').Plugin;

    const store = createTemplateStore(plugin);
    await new Promise((r) => setTimeout(r, 0));

    const cb = vi.fn();
    const off = store.onChange(cb);
    await store.upsert({ id: 'custom-1', name: 'Custom', body: 'hi' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(store.byId('custom-1')).toMatchObject({ name: 'Custom' });
    off();
  });

  it('remove is idempotent', async () => {
    const persisted: Record<string, unknown> = {};
    const plugin = {
      loadData: vi.fn(async () => Object.keys(persisted).length ? persisted : null),
      saveData: vi.fn(async (d: Record<string, unknown>) => {
        Object.assign(persisted, d);
      }),
    } as unknown as import('obsidian').Plugin;

    const store = createTemplateStore(plugin);
    await new Promise((r) => setTimeout(r, 0));

    const cb = vi.fn();
    store.onChange(cb);

    await store.remove('seed-bug-report');
    expect(store.byId('seed-bug-report')).toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);

    // Removing the same id again: no notify, no error.
    await store.remove('seed-bug-report');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
