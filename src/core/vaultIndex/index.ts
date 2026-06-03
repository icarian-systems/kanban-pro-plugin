/**
 * Vault Index implementation.
 *
 * Lifecycle:
 *   1. `createVaultIndex(plugin)` constructs an empty index, loads any
 *      cached entries from disk, and registers vault listeners.
 *   2. The first `rebuild()` call (typically issued by main.ts on plugin
 *      load, or by the dashboard's "refresh" button) scans the entire vault.
 *   3. Vault `modify` / `delete` / `rename` events trigger incremental
 *      updates of the affected path only — never a full rescan.
 *
 * Persistence path: `.obsidian/plugins/kanban-pro/index.json`, written via
 * the plugin's data adapter (`plugin.app.vault.adapter.write`). We
 * deliberately do NOT use `plugin.saveData()` for the index because that
 * file is reserved for settings — the index is a cache, mixing them would
 * bloat the settings round-trip.
 */
import type { Plugin, TAbstractFile, TFile, TFolder, EventRef } from 'obsidian';
import { parseBoard } from '@/core/parser';
import { log } from '@/shared/log';
import { summarizeBoard } from './rebuild';
import type { VaultIndex, VaultIndexEntry } from './types';

const INDEX_PATH = '.obsidian/plugins/kanban-pro/index.json';
const KANBAN_FRONTMATTER_KEY = 'kanban-plugin';
const KANBAN_FRONTMATTER_VALUE = 'board';

/** Shape the adapter exposes — both desktop and mobile implement these. */
interface DataAdapterLike {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir?(path: string): Promise<void>;
}

interface VaultLike {
  adapter: DataAdapterLike;
  getMarkdownFiles?: () => TFile[];
  cachedRead?: (file: TFile) => Promise<string>;
  read: (file: TFile) => Promise<string>;
  on: (
    name: 'modify' | 'delete' | 'rename',
    cb: (file: TAbstractFile, oldPath?: string) => void,
  ) => EventRef;
}

interface MetadataCacheLike {
  getFileCache: (
    file: TFile,
  ) => { frontmatter?: Record<string, unknown> } | null;
}

interface InternalEntries {
  byPath: Map<string, VaultIndexEntry>;
}

function isTFile(x: unknown): x is TFile {
  // TFile has `extension`; TFolder doesn't. We don't import the class to
  // keep this module testable without obsidian's runtime.
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { path?: unknown }).path === 'string' &&
    (x as { extension?: unknown }).extension !== undefined
  );
}

function isKanbanFile(
  metadataCache: MetadataCacheLike,
  file: TFile,
): boolean {
  if (file.extension !== 'md') return false;
  const cache = metadataCache.getFileCache(file);
  const fm = cache?.frontmatter as Record<string, unknown> | undefined;
  return fm?.[KANBAN_FRONTMATTER_KEY] === KANBAN_FRONTMATTER_VALUE;
}

async function ensureIndexDir(adapter: DataAdapterLike): Promise<void> {
  const dir = INDEX_PATH.slice(0, INDEX_PATH.lastIndexOf('/'));
  try {
    if (adapter.mkdir) await adapter.mkdir(dir);
  } catch {
    // mkdir frequently errors when the dir already exists — fine.
  }
}

async function readPersistedIndex(
  adapter: DataAdapterLike,
): Promise<VaultIndexEntry[]> {
  try {
    const exists = await adapter.exists(INDEX_PATH);
    if (!exists) return [];
    const raw = await adapter.read(INDEX_PATH);
    const parsed = JSON.parse(raw) as { entries?: VaultIndexEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    log.warn('vaultIndex: failed to read persisted index, starting fresh', err);
    return [];
  }
}

async function writePersistedIndex(
  adapter: DataAdapterLike,
  entries: VaultIndexEntry[],
): Promise<void> {
  try {
    await ensureIndexDir(adapter);
    await adapter.write(
      INDEX_PATH,
      JSON.stringify({ version: 1, entries }, null, 2),
    );
  } catch (err) {
    log.warn('vaultIndex: failed to persist index', err);
  }
}

/**
 * Build a single VaultIndexEntry for a given file. Returns null when the
 * file isn't a kanban board (or parsing fails — we don't crash the dash
 * for one broken board).
 */
async function buildEntry(
  vault: VaultLike,
  metadataCache: MetadataCacheLike,
  file: TFile,
): Promise<VaultIndexEntry | null> {
  if (!isKanbanFile(metadataCache, file)) return null;
  try {
    const text = vault.cachedRead
      ? await vault.cachedRead(file)
      : await vault.read(file);
    const { board } = parseBoard(text);
    if (!board) return null;
    return summarizeBoard(board, file.path, file.stat?.mtime ?? Date.now());
  } catch (err) {
    log.warn(`vaultIndex: failed to summarize ${file.path}`, err);
    return null;
  }
}

export function createVaultIndex(plugin: Plugin): VaultIndex {
  const vault = plugin.app.vault as unknown as VaultLike;
  const metadataCache = plugin.app
    .metadataCache as unknown as MetadataCacheLike;
  const adapter = vault.adapter;

  const data: InternalEntries = { byPath: new Map() };
  const listeners = new Set<() => void>();
  let hydrated = false;

  const notify = (): void => {
    for (const l of listeners) l();
  };

  const persist = (): void => {
    void writePersistedIndex(adapter, Array.from(data.byPath.values()));
  };

  const hydrateFromDisk = async (): Promise<void> => {
    if (hydrated) return;
    hydrated = true;
    const entries = await readPersistedIndex(adapter);
    for (const e of entries) {
      data.byPath.set(e.path, e);
    }
    if (entries.length > 0) notify();
  };

  // Vault listeners — incremental updates only.
  const handleModify = (file: TAbstractFile): void => {
    if (!isTFile(file)) return;
    void (async () => {
      const entry = await buildEntry(vault, metadataCache, file);
      if (entry) {
        data.byPath.set(entry.path, entry);
      } else {
        // No-longer-a-board (frontmatter removed) — drop it.
        data.byPath.delete(file.path);
      }
      persist();
      notify();
    })();
  };

  const handleDelete = (file: TAbstractFile): void => {
    if (!isTFile(file)) return;
    if (!data.byPath.has(file.path)) return;
    data.byPath.delete(file.path);
    persist();
    notify();
  };

  const handleRename = (file: TAbstractFile, oldPath?: string): void => {
    if (!isTFile(file)) return;
    if (oldPath && data.byPath.has(oldPath)) {
      const prev = data.byPath.get(oldPath);
      data.byPath.delete(oldPath);
      if (prev) {
        // We rewrite the path but rely on the next modify to recompute the
        // summary. The dashboard sees the renamed entry immediately.
        data.byPath.set(file.path, { ...prev, path: file.path });
      }
      persist();
      notify();
    }
    // Also trigger a fresh summarization to pick up any newly-kanban file.
    handleModify(file);
  };

  const modifyRef = vault.on('modify', handleModify);
  const deleteRef = vault.on('delete', handleDelete);
  const renameRef = vault.on('rename', handleRename);
  plugin.registerEvent(modifyRef);
  plugin.registerEvent(deleteRef);
  plugin.registerEvent(renameRef);

  // Kick off hydration from disk so the dashboard has data immediately
  // even before the first rebuild.
  void hydrateFromDisk();

  const rebuild = async (): Promise<void> => {
    await hydrateFromDisk(); // ensure we're not racing the disk load.
    const files = vault.getMarkdownFiles ? vault.getMarkdownFiles() : [];
    const next = new Map<string, VaultIndexEntry>();
    for (const file of files) {
      const entry = await buildEntry(vault, metadataCache, file);
      if (entry) next.set(entry.path, entry);
    }
    data.byPath = next;
    persist();
    notify();
  };

  return {
    rebuild,
    list(): VaultIndexEntry[] {
      return Array.from(data.byPath.values());
    },
    get(path: string): VaultIndexEntry | undefined {
      return data.byPath.get(path);
    },
    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

// Re-export types for ergonomic consumer imports.
export type { VaultIndex, VaultIndexEntry } from './types';
export { summarizeBoard, parseInlineDate, todayLocalMs } from './rebuild';
