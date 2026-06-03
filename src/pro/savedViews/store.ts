/**
 * Saved Views (Pro). JSON-backed named filters.
 *
 * Persisted via the plugin's loadData/saveData — we don't touch the
 * .obsidian folder directly. The constructor takes load/save callbacks
 * so this module is host-agnostic for tests.
 */

import type { Plugin } from 'obsidian';
import type { SavedView, ViewFilter } from '@/core/model';

export interface SavedViewBackend {
  load: () => Promise<SavedView[]>;
  save: (views: SavedView[]) => Promise<void>;
}

export class SavedViewStore {
  private views: SavedView[] = [];
  private loaded = false;
  private listeners = new Set<() => void>();

  constructor(private backend: SavedViewBackend) {}

  async load(): Promise<SavedView[]> {
    if (!this.loaded) {
      this.views = await this.backend.load();
      this.loaded = true;
    }
    return this.views;
  }

  list(): SavedView[] {
    return this.views.slice();
  }

  get(id: string): SavedView | undefined {
    return this.views.find((v) => v.id === id);
  }

  async save(view: Omit<SavedView, 'id' | 'createdAt'> & { id?: string }): Promise<SavedView> {
    const now = new Date().toISOString();
    const id = view.id ?? `sv-${Date.now().toString(36)}`;
    const existing = this.views.find((v) => v.id === id);
    const next: SavedView = {
      id,
      name: view.name,
      filter: view.filter,
      createdAt: existing?.createdAt ?? now,
    };
    if (existing) {
      this.views = this.views.map((v) => (v.id === id ? next : v));
    } else {
      this.views = [...this.views, next];
    }
    await this.backend.save(this.views);
    this.notify();
    return next;
  }

  async delete(id: string): Promise<void> {
    this.views = this.views.filter((v) => v.id !== id);
    await this.backend.save(this.views);
    this.notify();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

/** Create an in-memory backend (tests). */
export function memoryBackend(initial: SavedView[] = []): SavedViewBackend {
  let state = initial.slice();
  return {
    async load() {
      return state.slice();
    },
    async save(next) {
      state = next.slice();
    },
  };
}

/** Create a plugin-data backend. */
export function pluginDataBackend(
  load: () => Promise<Record<string, unknown>>,
  save: (data: Record<string, unknown>) => Promise<void>,
  key = 'savedViews',
): SavedViewBackend {
  return {
    async load() {
      const data = await load();
      const raw = data[key];
      return Array.isArray(raw) ? (raw as SavedView[]) : [];
    },
    async save(views) {
      const data = await load();
      data[key] = views;
      await save(data);
    },
  };
}

/**
 * Factory mirroring `createTemplateStore` — wires the SavedViewStore to
 * the plugin's loadData/saveData with a dedicated `savedViews` sub-key so
 * we don't stomp on other top-level fields (settings, templates, …).
 *
 * The returned store is hydrated eagerly (the awaitable load() resolves
 * the in-memory list); callers that need a synchronous list before the
 * promise resolves get [] from `list()` until then.
 */
export function createSavedViewStore(plugin: Plugin): SavedViewStore {
  const backend = pluginDataBackend(
    async () => {
      const data = (await plugin.loadData()) as Record<string, unknown> | null;
      return data ?? {};
    },
    async (data) => {
      await plugin.saveData(data);
    },
  );
  const store = new SavedViewStore(backend);
  // Kick off hydration; callers awaiting `load()` upstream will receive
  // the same in-memory list because `load()` is idempotent.
  void store.load();
  return store;
}

export type { ViewFilter };
