/**
 * SavedViewsContext — React context that exposes the plugin-owned
 * `SavedViewStore` to the board UI tree (Subnav picker, right-rail chips,
 * the apply-saved-view event handler in BoardRoot).
 *
 * The provider is wired by `KanbanView` so each leaf shares the same
 * singleton instance from `main.ts`. Components consume the store via
 * `useSavedViewStore()`; when no provider is present (Free tier mount,
 * embed contexts, isolated tests), the hook returns `null` and consumers
 * fall back to default/seed behavior.
 *
 * `useSavedViews()` subscribes to the store's notify channel so list
 * snapshots stay in sync after upserts/deletes — the same discipline
 * the templates modal uses for live updates.
 */
import * as React from 'react';
import type { SavedView } from '@/core/model';
import type { SavedViewStore } from '@/pro/savedViews/store';

const SavedViewsContext = React.createContext<SavedViewStore | null>(null);

export const SavedViewsProvider: React.FC<{
  store: SavedViewStore | null;
  children: React.ReactNode;
}> = ({ store, children }) => {
  return (
    <SavedViewsContext.Provider value={store}>{children}</SavedViewsContext.Provider>
  );
};

export function useSavedViewStore(): SavedViewStore | null {
  return React.useContext(SavedViewsContext);
}

/**
 * Returns the current list of saved views, re-rendering when the store
 * emits a change. Components rendering the picker should use this hook
 * (not `store.list()` directly) so a save/delete reflects without a
 * manual remount.
 */
export function useSavedViews(): SavedView[] {
  const store = useSavedViewStore();
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!store) return;
    return store.subscribe(() => setTick((t) => t + 1));
  }, [store]);
  // Touch `tick` so the linter sees the dep used; the actual data read
  // happens via `store.list()`.
  void tick;
  return store ? store.list() : [];
}
