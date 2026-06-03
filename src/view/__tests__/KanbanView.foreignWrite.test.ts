/**
 * KanbanView.foreignWrite.test.ts — setViewData foreign-write coverage.
 *
 * The pre-fix `setViewData` path called `applyDiskSnapshot` synchronously
 * for every external write, then waited 50ms for `onVaultModify` to engage
 * read-only — by which time the board had already absorbed the foreign
 * bytes. The defect: the `<ReadOnlyBanner>` never appeared
 * because the in-memory board was already in sync with the disk state by
 * the time the banner path ran.
 *
 * The fix moves the foreign-write decision INSIDE `setViewData` itself
 * and routes the in-flight branch to `openRecoveryDiff` without applying
 * the disk snapshot. These tests pin that decision tree:
 *
 *   1. foreign + save in flight → engageReadOnly, NO applyDiskSnapshot
 *   2. foreign + no save in flight → engageReadOnly via openRecoveryDiff,
 *      NO applyDiskSnapshot (the prior code path silently absorbed the
 *      foreign write, which bypassed the `<ReadOnlyBanner>` UX and let the
 *      disk content stomp the user's view without warning).
 *
 * We don't go through `onLoadFile` here — the test exercises the
 * setViewData branch on an already-booted session. To get there we boot
 * the session manually via onLoadFile, then issue a second setViewData
 * with a fingerprint that does NOT match anything in the FIFO.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { App, TFile, Vault, MetadataCache, Workspace, WorkspaceLeaf } from 'obsidian';
import { KanbanView } from '@/view/KanbanView';

function makeApp(initialText: string): { app: App; vault: Vault } {
  const vault = new Vault();
  vault.read = vi.fn(async (_f: TFile) => initialText) as Vault['read'];
  vault.on = vi.fn(() => ({})) as unknown as Vault['on'];
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

// Minimal parser-friendly board source.
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
  '- [ ] FOREIGN WRITE',
  '',
].join('\n');

describe('KanbanView.setViewData — synchronous foreign-write detection', () => {
  let view: KanbanView | null = null;

  beforeEach(() => {
    view = null;
  });

  afterEach(async () => {
    try {
      await view?.onClose();
    } catch {
      // teardown errors are not the test subject
    }
    view = null;
  });

  async function bootView(file: TFile, app: App): Promise<KanbanView> {
    const leaf = new WorkspaceLeaf();
    const v = new KanbanView(leaf);
    (v as unknown as { app: App }).app = app;
    (v as unknown as { file: TFile | null }).file = file;
    await act(async () => {
      v.setViewData(BOARD_SRC, false);
      await v.onLoadFile(file);
    });
    return v;
  }

  it('engages read-only and does NOT applyDiskSnapshot when save is in flight', async () => {
    const file = makeFile('Board.md', 1_000);
    const { app } = makeApp(BOARD_SRC);
    view = await bootView(file, app);

    const store = view.getStore();
    expect(store).toBeTruthy();
    const beforeBoard = store!.getState().board;

    // Force the save queue into "in-flight" — the simplest way without
    // racing real timers is to monkey-patch the session's isInFlight
    // getter. We reach in via the typed `session` field through an unknown
    // cast; this is a unit test boundary so the access is appropriate.
    interface PrivateView {
      session: {
        saveQueue: { isInFlight: () => boolean };
      };
    }
    const session = (view as unknown as PrivateView).session;
    const isInFlightSpy = vi.spyOn(session.saveQueue, 'isInFlight').mockReturnValue(true);

    // Now drive setViewData with a foreign payload + a fresh mtime. The
    // FIFO holds no fingerprint matching FOREIGN_SRC (we never wrote it),
    // so `isForeign` returns true. Combined with the in-flight stub, the
    // The foreign-write path should engage read-only without touching the board.
    file.stat = { ctime: 0, mtime: 5_000, size: FOREIGN_SRC.length };
    await act(async () => {
      view!.setViewData(FOREIGN_SRC, false);
    });

    expect(isInFlightSpy).toHaveBeenCalled();
    // Banner engaged. `openRecoveryDiff` re-engages with a more specific
    // message ("Sync conflict detected…") so we don't pin the exact text
    // beyond "is in read-only mode and has surfaced an error" — the
    // important contract is that something blocking is shown.
    expect(store!.getState().readOnly).toBe(true);
    expect(store!.getState().errorMessage).toBeTruthy();
    // applyDiskSnapshot would have replaced the board ref with a parse of
    // FOREIGN_SRC, which has 2 cards under Backlog. We must still see the
    // pre-conflict board (1 card).
    const afterBoard = store!.getState().board;
    expect(afterBoard).toBe(beforeBoard);
  });

  it('engages read-only via openRecoveryDiff for a foreign write with no save in flight', async () => {
    // Previously this path applied the disk snapshot and kept the banner
    // OFF. That silently absorbed the foreign write, violating the
    // contract that the view enters read-only mode and the
    // `<ReadOnlyBanner>` renders. The corrected
    // behaviour: any foreign write that doesn't byte-match our in-memory
    // serialisation engages read-only, regardless of save-in-flight state.
    const file = makeFile('Board.md', 1_000);
    const { app } = makeApp(BOARD_SRC);
    view = await bootView(file, app);

    const store = view.getStore();
    expect(store).toBeTruthy();
    const beforeBoard = store!.getState().board;

    interface PrivateView {
      session: {
        saveQueue: { isInFlight: () => boolean };
      };
    }
    const session = (view as unknown as PrivateView).session;
    expect(session.saveQueue.isInFlight()).toBe(false);

    file.stat = { ctime: 0, mtime: 5_000, size: FOREIGN_SRC.length };
    await act(async () => {
      view!.setViewData(FOREIGN_SRC, false);
    });

    // Banner engaged via the recovery-diff path. Board MUST remain at the
    // pre-foreign snapshot — applyDiskSnapshot would have replaced
    // beforeBoard with a parse of FOREIGN_SRC (two cards under Backlog).
    expect(store!.getState().readOnly).toBe(true);
    expect(store!.getState().errorMessage).toBeTruthy();
    const afterBoard = store!.getState().board;
    expect(afterBoard).toBe(beforeBoard);
  });

  it('keeps banner OFF and short-circuits when a foreign write byte-matches the in-memory model', async () => {
    // False-positive guard: an idempotent echo (Sync re-writing the same
    // bytes the user already has in memory) must NOT trip the banner.
    // Routed through setViewData with the current `getViewData()` output,
    // the foreign-write path records the fingerprint and returns without
    // engaging read-only.
    const file = makeFile('Board.md', 1_000);
    const { app } = makeApp(BOARD_SRC);
    view = await bootView(file, app);

    const store = view.getStore();
    expect(store).toBeTruthy();
    const beforeBoard = store!.getState().board;

    file.stat = { ctime: 0, mtime: 5_000, size: 0 };
    const echoBytes = view!.getViewData();
    file.stat.size = echoBytes.length;
    await act(async () => {
      view!.setViewData(echoBytes, false);
    });

    expect(store!.getState().readOnly).toBe(false);
    // The store stays at the pre-call board ref because the early-return
    // skips applyDiskSnapshot (which would have called setBoard with a
    // fresh parse, swapping the ref even for byte-identical input).
    expect(store!.getState().board).toBe(beforeBoard);
  });

  it('does NOT engage read-only when setViewData replays our own write fingerprint', async () => {
    const file = makeFile('Board.md', 1_000);
    const { app } = makeApp(BOARD_SRC);
    view = await bootView(file, app);

    const store = view.getStore();
    expect(store).toBeTruthy();

    // Seed a self-write fingerprint identical to BOARD_SRC. setViewData
    // replaying BOARD_SRC with that fingerprint should be classified as
    // self → applyDiskSnapshot, banner off, in-flight branch untouched.
    interface PrivateView {
      session: {
        selfWrite: { recordSelfWrite: (text: string, mtime: number) => void };
        saveQueue: { isInFlight: () => boolean };
      };
    }
    const session = (view as unknown as PrivateView).session;
    session.selfWrite.recordSelfWrite(BOARD_SRC, 1_000);
    vi.spyOn(session.saveQueue, 'isInFlight').mockReturnValue(true);

    file.stat = { ctime: 0, mtime: 1_000, size: BOARD_SRC.length };
    await act(async () => {
      view!.setViewData(BOARD_SRC, false);
    });

    // Self-write replay: banner stays off even though isInFlight is true.
    expect(store!.getState().readOnly).toBe(false);
  });
});
