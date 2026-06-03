/**
 * foreignWriteBannerSetViewData.test.tsx — setViewData foreign-write coverage.
 *
 * The existing `foreignWriteBanner.test.tsx` proves the `vault.on('modify')`
 * code path engages read-only when a foreign write differs from the
 * in-memory model. That misses the production trigger surface: Obsidian's
 * `TextFileView` ALSO calls `setViewData(diskText, false)` synchronously
 * when the host detects the file changed on disk — that's how the view
 * stays in sync with the file the user is editing in another pane.
 *
 * The defect: an external write to
 * `Untitled Board.md` (a new card line appended under `## Backlog`) was
 * silently absorbed into the view. The new card appeared, but no
 * `<ReadOnlyBanner>` rendered. Root cause: the `setViewData` path's
 * "Legitimate external edit. No conflict — apply as the new truth."
 * branch calls `applyDiskSnapshot(data)` without engaging read-only, and
 * `applyDiskSnapshot` actively CLEARS read-only if it was set. Even if the
 * debounced `onVaultModify` later tries to open the recovery diff, the
 * subsequent byte-identical guard ("we already serialise to the same
 * bytes") short-circuits — because applyDiskSnapshot already pushed the
 * disk content into the store.
 *
 * This test simulates Obsidian's full disk-modify behaviour:
 *   1. Boot a KanbanView session on a parsed board.
 *   2. Simulate the external write by changing disk + firing both the
 *      modify event AND the `setViewData` call the host runs on disk
 *      modifications.
 *   3. Assert the store is in read-only state AND the banner-engage path
 *      ran (i.e. errorMessage is populated).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { App, TFile, Vault, MetadataCache, Workspace, WorkspaceLeaf } from 'obsidian';
import { KanbanView } from '@/view/KanbanView';

type ModifyListener = (file: TFile) => void;

interface RecordingVault extends Vault {
  __modifyListeners: ModifyListener[];
  __content: string;
  __setContent(next: string): void;
  __triggerModify(file: TFile): void;
}

function makeRecordingApp(initialText: string, _file: TFile): { app: App; vault: RecordingVault } {
  const vault = new Vault() as RecordingVault;
  vault.__modifyListeners = [];
  vault.__content = initialText;
  vault.__setContent = (next: string): void => {
    vault.__content = next;
  };
  vault.__triggerModify = (f: TFile): void => {
    for (const cb of vault.__modifyListeners) cb(f);
  };
  vault.on = vi.fn(
    (name: string, cb: (...args: unknown[]) => void): unknown => {
      if (name === 'modify') vault.__modifyListeners.push(cb as ModifyListener);
      return { _name: name };
    },
  ) as unknown as Vault['on'];
  vault.read = vi.fn(async (_f: TFile): Promise<string> => vault.__content) as Vault['read'];

  const app = new App();
  (app as unknown as { vault: Vault }).vault = vault;
  (app as unknown as { workspace: Workspace }).workspace = new Workspace();
  (app as unknown as { metadataCache: MetadataCache }).metadataCache = new MetadataCache();
  return { app, vault };
}

function makeFile(path: string, mtime: number): TFile {
  const f = new TFile();
  f.path = path;
  f.name = path.split('/').pop() ?? path;
  f.basename = f.name.replace(/\.md$/, '');
  f.extension = 'md';
  f.stat = { ctime: 0, mtime, size: 0 };
  return f;
}

const BOARD_SRC = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
  '## Backlog',
  '',
  '- [ ] First card',
  '',
].join('\n');

const FOREIGN_SRC = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
  '## Backlog',
  '',
  '- [ ] First card',
  '- [ ] FOREIGN WRITE — simulating Sync conflict',
  '',
].join('\n');

describe('KanbanView — banner engages on setViewData foreign write', () => {
  let view: KanbanView | null = null;

  beforeEach(() => {
    view = null;
  });

  afterEach(async () => {
    try {
      await view?.onClose();
    } catch {
      // tear-down errors aren't the test subject
    }
  });

  it('engages read-only mode when Obsidian calls setViewData with foreign bytes', async () => {
    const file = makeFile('Untitled Board.md', 1_000);
    const { app, vault } = makeRecordingApp(BOARD_SRC, file);

    const leaf = new WorkspaceLeaf();
    view = new KanbanView(leaf);
    (view as unknown as { app: App }).app = app;
    (view as unknown as { file: TFile | null }).file = file;

    await act(async () => {
      view!.setViewData(BOARD_SRC, false);
      await view!.onLoadFile(file);
    });

    const store = view.getStore();
    expect(store).toBeTruthy();
    expect(store!.getState().readOnly).toBe(false);

    // Simulate Obsidian's behaviour for a foreign write to the open file:
    //   1. The disk bytes change + mtime advances.
    //   2. The vault.modify event fires.
    //   3. The host pushes the new bytes through setViewData(diskText, false)
    //      — this is the load-bearing path the existing regression test
    //      misses. The pre-fix code routes this through applyDiskSnapshot
    //      directly, silently absorbing the foreign edit without engaging
    //      the banner.
    await act(async () => {
      file.stat = { ctime: 0, mtime: 5_000, size: FOREIGN_SRC.length };
      vault.__setContent(FOREIGN_SRC);
      view!.setViewData(FOREIGN_SRC, false);
      vault.__triggerModify(file);
      // onVaultModify uses obsidianDebounce(50ms).
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Banner-engage path: readOnly true + an error message that the banner
    // surfaces. The defect is that BOTH end up false/null because
    // applyDiskSnapshot ran first and cleared any pending read-only state.
    expect(store!.getState().readOnly).toBe(true);
    expect(store!.getState().errorMessage).toBeTruthy();
  });

  it('does NOT engage the banner when setViewData echoes our own write (self-write FIFO match)', async () => {
    const file = makeFile('Untitled Board.md', 1_000);
    const { app, vault } = makeRecordingApp(BOARD_SRC, file);

    const leaf = new WorkspaceLeaf();
    view = new KanbanView(leaf);
    (view as unknown as { app: App }).app = app;
    (view as unknown as { file: TFile | null }).file = file;

    await act(async () => {
      view!.setViewData(BOARD_SRC, false);
      await view!.onLoadFile(file);
    });

    const store = view.getStore();
    expect(store).toBeTruthy();

    // The byte-identical-to-in-memory case must still be a silent no-op
    // (false-positive guard from the existing test, but exercised through
    // the setViewData path now).
    await act(async () => {
      const echoBytes = view!.getViewData();
      file.stat = { ctime: 0, mtime: 9_000, size: echoBytes.length };
      vault.__setContent(echoBytes);
      view!.setViewData(echoBytes, false);
      vault.__triggerModify(file);
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store!.getState().readOnly).toBe(false);
  });
});
