/**
 * addCardSurvivesSelfWrite.test.tsx — regression for the "+ Add card" card
 * appearing and then vanishing.
 *
 * The visibility fix (BoardRoot HiddenCardsStyle) made the freshly-created
 * empty placeholder render with its inline editor open. But it then vanished
 * ~600ms later: an empty placeholder card serializes to NOTHING, so when the
 * debounced save flushed and Obsidian re-fired `setViewData(diskText)` with
 * the plugin's own bytes, the self-write branch ran `applyDiskSnapshot` →
 * `parseBoard` (0 cards) → `setBoard`, deleting the card out from under the
 * user's open editor.
 *
 * The fix: `setViewData`'s self-write branch treats a byte-identical echo as a
 * no-op (mirroring `onVaultModify`), leaving the in-memory board — including
 * the transient placeholder — untouched.
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

function makeRecordingApp(initialText: string): { app: App; vault: RecordingVault } {
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

describe('KanbanView — "+ Add card" placeholder survives our own save echo', () => {
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

  it('a freshly-added empty card is not wiped by the setViewData self-write echo', async () => {
    const file = makeFile('Untitled Board.md', 1_000);
    const { app, vault } = makeRecordingApp(BOARD_SRC);

    const leaf = new WorkspaceLeaf();
    view = new KanbanView(leaf);
    (view as unknown as { app: App }).app = app;
    (view as unknown as { file: TFile | null }).file = file;

    await act(async () => {
      view!.setViewData(BOARD_SRC, false);
      await view!.onLoadFile(file);
    });

    const store = view.getStore()!;
    expect(store).toBeTruthy();
    const laneId = store.selectLaneIds()[0];
    const before = store.selectCardIds(laneId).length;

    // Simulate clicking "+ Add card": an empty placeholder card.
    let newId = '';
    act(() => {
      newId = store.addCard!(laneId);
    });
    expect(store.selectCardIds(laneId)).toContain(newId);
    expect(store.selectCardIds(laneId).length).toBe(before + 1);

    // Let the debounced save (600ms) actually FLUSH. The flush serializes the
    // board and calls `recordSelfWrite(text)`, so the bytes are registered in
    // the self-write FIFO — which is what makes the subsequent setViewData a
    // genuine `!foreign` self-write (the branch the bug lives in). Without
    // this the echo is caught by the unrelated foreign-write byte-identical
    // guard and the regression is masked.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
    });

    // Now Obsidian re-fires setViewData with the plugin's own written bytes
    // (the empty card serialized to nothing). This is OUR OWN write.
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

    // The placeholder must STILL be in the store — not deleted by a reparse
    // of our own serialization.
    expect(store.selectCardIds(laneId)).toContain(newId);
    expect(store.getState().readOnly).toBe(false);
  });
});
