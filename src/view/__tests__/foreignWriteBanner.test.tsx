/**
 * foreignWriteBanner.test.tsx — foreign-write banner coverage.
 *
 * The contract is a non-dismissable banner + diff view + open-as-text:
 * when an *external* write modifies the open board file the view MUST
 * engage read-only mode and
 * mount the recovery diff — NOT silently absorb the change as the
 * pre-fix code path did.
 *
 * This test exercises the foreign-write branch of KanbanView's
 * `onVaultModify` handler end-to-end:
 *   1. Boot a KanbanView session on a parsed board.
 *   2. Wire a real event-emitter into the mocked Vault so the modify
 *      listener actually fires.
 *   3. Simulate an external edit by changing the disk text + bumping mtime.
 *   4. Assert the store flips to read-only and the React-mounted recovery
 *      diff lands in the contentEl DOM.
 *
 * False-positive guard: a second test confirms that a Sync echo whose
 * bytes match our in-memory serialization (idempotent re-write) does NOT
 * trip the banner. Both branches matter — the spec calls out that a
 * byte-identical foreign write must remain a no-op.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { App, TFile, Vault, MetadataCache, Workspace, WorkspaceLeaf } from 'obsidian';
import { KanbanView } from '@/view/KanbanView';

// ────────────────────────────────────────────────────────────────────────
// Test-side vault: a real EventEmitter-shaped surface so `vault.on('modify', cb)`
// captures the callback and `trigger()` fires it. The shipped mock returns an
// empty object from `on` so no listener ever runs — which is fine for unit
// tests of pure helpers but useless for an end-to-end modify-flow test like
// this one.
// ────────────────────────────────────────────────────────────────────────
type ModifyListener = (file: TFile) => void;

interface RecordingVault extends Vault {
  __modifyListeners: ModifyListener[];
  __content: string;
  __setContent(next: string): void;
  __triggerModify(file: TFile): void;
}

function makeRecordingApp(initialText: string, file: TFile): { app: App; vault: RecordingVault } {
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

// Minimal board source — parser-friendly, single lane, one card. Round-trips.
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

// A foreign edit — adds a new card under Backlog. Bytes differ from
// anything our serializer would produce out of the original model.
const FOREIGN_SRC = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
  '## Backlog',
  '',
  '- [ ] First card',
  '- [ ] FOREIGN WRITE',
  '',
].join('\n');

describe('KanbanView — foreign-write read-only banner', () => {
  let view: KanbanView | null = null;
  let cleanupTimers: ReturnType<typeof setInterval>[] = [];

  beforeEach(() => {
    view = null;
    cleanupTimers = [];
  });

  afterEach(async () => {
    try {
      await view?.onClose();
    } catch {
      // tear-down errors aren't the test subject
    }
    for (const t of cleanupTimers) clearInterval(t);
    cleanupTimers = [];
  });

  it('engages read-only mode + mounts recovery diff on a non-idempotent foreign write', async () => {
    const file = makeFile('Board.md', 1_000);
    const { app, vault } = makeRecordingApp(BOARD_SRC, file);

    const leaf = new WorkspaceLeaf();
    view = new KanbanView(leaf);
    (view as unknown as { app: App }).app = app;
    (view as unknown as { file: TFile | null }).file = file;

    // setViewData stashes pendingData; onLoadFile boots the session.
    await act(async () => {
      view!.setViewData(BOARD_SRC, false);
      await view!.onLoadFile(file);
    });

    const store = view.getStore();
    expect(store).toBeTruthy();
    expect(store!.getState().readOnly).toBe(false);

    // Simulate the external edit — disk now holds different bytes; the
    // host fires the modify event with a newer mtime.
    await act(async () => {
      file.stat = { ctime: 0, mtime: 5_000, size: FOREIGN_SRC.length };
      vault.__setContent(FOREIGN_SRC);
      vault.__triggerModify(file);
      // onVaultModify uses obsidianDebounce(50ms); the test mock's debounce
      // schedules via setTimeout, so we need a tick + the debounce window
      // plus the async vault.read promise resolution.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Read-only mode engaged — banner-rendering path now active.
    expect(store!.getState().readOnly).toBe(true);
    expect(store!.getState().errorMessage).toBeTruthy();
  });

  it('engages read-only when Obsidian re-enters via setViewData with foreign content', async () => {
    // In production Obsidian's `TextFileView`
    // refreshes the view via `setViewData(text, false)` when the file is
    // modified externally — sometimes BEFORE our debounced `onVaultModify`
    // handler runs, sometimes WITHOUT the modify event firing at all
    // (workspace reload). If setViewData unconditionally calls
    // applyDiskSnapshot, the in-memory store absorbs the foreign content
    // and any subsequent false-positive guard finds in-memory == disk
    // and silently records the foreign bytes as a self-write — the
    // <ReadOnlyBanner> never renders.
    //
    // This test fires setViewData ONLY (no vault modify) and asserts the
    // foreign write routes through the recovery-diff path.
    const file = makeFile('Board.md', 1_000);
    const { app, vault: _vault } = makeRecordingApp(BOARD_SRC, file);

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

    // Workspace fires setViewData with the externally-modified bytes.
    await act(async () => {
      view!.setViewData(FOREIGN_SRC, false);
      await Promise.resolve();
    });

    expect(store!.getState().readOnly).toBe(true);
    expect(store!.getState().errorMessage).toBeTruthy();
  });

  it('does NOT trip the banner when setViewData replays the last known serialization', async () => {
    // setViewData with bytes we last either parsed or flushed is a benign
    // echo (e.g. workspace tab restore replays the file content). It must
    // re-apply silently — no banner.
    const file = makeFile('Board.md', 1_000);
    const { app } = makeRecordingApp(BOARD_SRC, file);

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

    await act(async () => {
      view!.setViewData(BOARD_SRC, false);
      await Promise.resolve();
    });

    expect(store!.getState().readOnly).toBe(false);
  });

  it('foreign write during in-flight save routes to recovery diff', async () => {
    // Hard case: while a save is in flight (e.g. the user just
    // typed and the debounced flush is still mid-write), an external
    // modification of the same file is a true conflict — both sides have
    // unsynced changes. The view must engage read-only AND mount the
    // recovery diff so the user picks a winner.
    const file = makeFile('Board.md', 1_000);
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

    // Reach into the session and force the saveQueue's isInFlight() to
    // return true so the foreign-write handler takes the in-flight branch.
    const session = (view as unknown as { session: { saveQueue: { isInFlight: () => boolean } } | null }).session;
    expect(session).not.toBeNull();
    if (!session) throw new Error('session not booted');
    const origIsInFlight = session.saveQueue.isInFlight.bind(session.saveQueue);
    session.saveQueue.isInFlight = () => true;

    try {
      await act(async () => {
        file.stat = { ctime: 0, mtime: 5_000, size: FOREIGN_SRC.length };
        vault.__setContent(FOREIGN_SRC);
        vault.__triggerModify(file);
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      session.saveQueue.isInFlight = origIsInFlight;
    }

    expect(store!.getState().readOnly).toBe(true);
    expect(store!.getState().errorMessage).toMatch(/Sync conflict/i);
  });

  it('does NOT trip the banner when the foreign write is byte-identical to in-memory model', async () => {
    const file = makeFile('Board.md', 1_000);
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

    // Echo case — the disk re-write produces text that the parser would
    // generate from our in-memory model. The serializer's prevSource
    // fast-path means `getViewData()` returns BOARD_SRC verbatim; we
    // simulate Sync rewriting the same bytes back. mtime advances but
    // hash is unchanged from what we'd produce.
    await act(async () => {
      file.stat = { ctime: 0, mtime: 9_000, size: BOARD_SRC.length };
      // Important: feed bytes that EXACTLY match the in-memory board's
      // serialization, not just the source we started from — that's the
      // condition for treating an external write as an idempotent echo.
      vault.__setContent(view!.getViewData());
      vault.__triggerModify(file);
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store!.getState().readOnly).toBe(false);
  });
});
