/**
 * Lifecycle hygiene helper.
 *
 * Obsidian plugin review rejects plugins that leak listeners or DOM nodes.
 * This helper collects
 * disposers in order and runs them in reverse on teardown — like a
 * scoped DEFER stack.
 *
 * Prefer wiring disposers through `Component.register(...)` /
 * `Plugin.register*()` when you can; this helper is for the cases where
 * you need to dispose React roots, Zustand stores, and save-queue
 * timers from inside non-Component code.
 *
 * Usage:
 *
 *   const cleanup = createCleanupChecklist('KanbanView');
 *   cleanup.add('react root', () => root.unmount());
 *   cleanup.add('store', () => store.destroy());
 *   cleanup.add('save queue', () => saveQueue.cancel());
 *   // …on teardown:
 *   await cleanup.runAll();
 */
import { log } from '@/shared/log';

export type Disposer = () => void | Promise<void>;

export interface CleanupChecklist {
  add: (label: string, dispose: Disposer) => void;
  runAll: () => Promise<void>;
  size: () => number;
}

export function createCleanupChecklist(scope: string): CleanupChecklist {
  const entries: { label: string; dispose: Disposer }[] = [];

  return {
    add(label, dispose) {
      entries.push({ label, dispose });
    },

    async runAll(): Promise<void> {
      // LIFO so that resources are torn down in the reverse of construction.
      while (entries.length > 0) {
        const entry = entries.pop()!;
        try {
          await entry.dispose();
        } catch (err) {
          log.warn(`[cleanup ${scope}] ${entry.label} failed:`, err);
        }
      }
    },

    size() {
      return entries.length;
    },
  };
}
