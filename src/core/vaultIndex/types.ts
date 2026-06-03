/**
 * Vault Index — rebuildable cache of every Kanban board in the vault.
 *
 * Architecture:
 *   - Treated as a cache, NOT a source of truth. A corrupted or stale
 *     index just triggers a rebuild — no user data lives here.
 *   - Persisted as JSON next to the plugin's data file.
 *   - Updated incrementally on vault `modify` / `delete` / `rename`.
 *   - The Dashboard view (Pro) is the primary consumer.
 */

/**
 * One row per board file. The rollup numbers are pre-computed at index
 * time so the dashboard doesn't re-parse on every render.
 */
export interface VaultIndexEntry {
  path: string;
  title: string;
  /** lane title → card count. Lane IDs aren't stable across re-parses; titles are. */
  laneCounts: Record<string, number>;
  totalCards: number;
  /** Cards with a `due` date strictly before today. */
  overdue: number;
  /** Cards with a `due` date within the next 7d (inclusive of today). */
  dueWithin7d: number;
  /** tag → card count (across all lanes). */
  tags: Record<string, number>;
  modifiedAt: number;
}

export interface VaultIndex {
  /** Full scan — every `.md` file with `kanban-plugin: board` frontmatter. */
  rebuild(): Promise<void>;
  list(): VaultIndexEntry[];
  get(path: string): VaultIndexEntry | undefined;
  /** Subscribe to in-memory changes (rebuild + incremental updates). */
  onChange(cb: () => void): () => void;
}
