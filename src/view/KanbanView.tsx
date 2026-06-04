/**
 * KanbanView — the per-file editor view.
 *
 * Architectural points (do not regress):
 *
 *  - **Base class is `TextFileView`**, NOT `ItemView`. `getViewData()` /
 *    `setViewData()` are how Obsidian persists the file; we serialize the
 *    in-memory board through the parser. This is the v1 fix for #4
 *    (embeds need a parsed model that the post-processor can also use).
 *
 *  - **Per-leaf store**: each KanbanView instance owns its own Zustand
 *    store. No sharing.
 *
 *  - **Self-write detection**: when the vault emits a `modify` event for
 *    our file, we compare mtime + content hash to the last snapshot we
 *    saved. If they match, it's our own write — ignore. Otherwise it's
 *    an external write (Sync, another editor, the user editing the file
 *    in another app) and we re-parse via setViewData.
 *
 *  - **Save errors → read-only**: parse and serialize errors do NOT
 *    silence saves. They engage read-only mode with a banner. The save
 *    queue itself never skips writes because of prior errors — that's
 *    its never-silence invariant.
 *
 *  - **View-mode switching**: Board / Table / List. Per-file persistence
 *    via `settings['default-view']`. `Cmd/Ctrl+Shift+V` cycles transiently
 *    (does not write back to the file).
 */
import {
  TextFileView,
  TFile,
  WorkspaceLeaf,
  type EventRef,
  debounce as obsidianDebounce,
} from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import * as React from 'react';

import type { Board, ViewMode } from '@/core/model';
import { parseBoard, serializeBoard } from '@/core/parser';
import { BoardRoot } from '@/ui/BoardRoot';
import type { SavedViewStore } from '@/pro/savedViews/store';
import { TrackingProvider } from '@/ui/CardTrackingChip';
import type { TrackingStore } from '@/ui/contracts';
import {
  createBoardStore,
  type BoardStore,
} from '@/core/store';
import { createSaveQueue, type SaveQueue } from '@/core/saveQueue';
import { createUndoStack, type UndoStack } from '@/core/undo';
import { hashString } from '@/shared/hash';
import { KANBAN_PRO_PLUGIN_ID } from '@/shared/pluginMeta';
import { licenseFSM } from '@/pro/license/state';
import { log } from '@/shared/log';
import { createCleanupChecklist, type CleanupChecklist } from './cleanupChecklist';
import { ReadOnlyBanner } from './readOnlyBanner';
import { mountRecoveryDiff } from './recoveryDiff';

export const KANBAN_VIEW_TYPE = 'kanban-pro';

interface SelfWriteFingerprint {
  contentHash: string;
  mtime: number;
}

/**
 * Self-write detector contract. Exposed so tests can exercise the
 * mtime + content-hash discriminator without spinning up a full view.
 *
 * ── INVARIANTS ──
 *
 *  1. **FIFO of N fingerprints** (N = 5). Obsidian Sync can coalesce or
 *     reorder multiple in-flight writes; comparing against ONLY the most
 *     recent self-write produces false-positive "foreign" classifications
 *     when our own debounced flushes interleave. The FIFO matches any
 *     write we made in the last few hundred ms.
 *
 *  2. **Match-by-content-hash or mtime-window**. The hash compare is the
 *     load-bearing check (Sync occasionally rewrites the file with
 *     identical bytes but a fresh mtime). The mtime window (1500ms)
 *     handles the inverse: the host can normalise trivia (CRLF→LF) on
 *     the way to disk, producing a hash mismatch that we still authored.
 *
 *  3. **No expiry**. The FIFO is purely size-bounded. Entries fall off
 *     the back when we exceed N — never on a wall-clock deadline. This
 *     matters during a long inline-edit session where the user pauses
 *     for minutes between mutations: the last self-write fingerprint is
 *     still valid, because the file mtime hasn't moved.
 *
 *  4. **isForeign with `null` last** returns true. First disk read goes
 *     through the parse path normally — we don't want to silently accept
 *     a stale snapshot as our own.
 */
const SELF_WRITE_FIFO_DEPTH = 5;
const SELF_WRITE_MTIME_WINDOW_MS = 1500;

export interface SelfWriteDetector {
  recordSelfWrite(text: string, mtime: number): void;
  isForeign(text: string, mtime: number): boolean;
}

export function makeSelfWriteDetector(): SelfWriteDetector {
  // FIFO of recent self-write fingerprints. Newest at the end. We bound by
  // count, not time — see invariant #3 above.
  const fifo: SelfWriteFingerprint[] = [];
  return {
    recordSelfWrite(text, mtime) {
      fifo.push({ contentHash: hashString(text), mtime });
      while (fifo.length > SELF_WRITE_FIFO_DEPTH) fifo.shift();
    },
    isForeign(text, mtime) {
      if (fifo.length === 0) return true;
      const hash = hashString(text);
      for (const entry of fifo) {
        if (entry.contentHash === hash) return false;
        if (Math.abs(entry.mtime - mtime) <= SELF_WRITE_MTIME_WINDOW_MS) {
          return false;
        }
      }
      return true;
    },
  };
}

interface KanbanViewSession {
  store: BoardStore;
  saveQueue: SaveQueue<Board>;
  undoStack: UndoStack;
  cleanup: CleanupChecklist;
  reactRoot: Root;
  /**
   * FIFO of recent self-write fingerprints. See makeSelfWriteDetector.
   */
  selfWrite: SelfWriteDetector;
  modifyEventRef: EventRef | null;
  /** Disposes any open recovery-diff React tree. */
  recoveryDispose: (() => void) | null;
  /**
   * The remote text currently shown in the recovery diff (if any). Used to
   * collapse back-to-back `openRecoveryDiff` calls — production fires both
   * `setViewData` and `onVaultModify` for the same external write, and
   * the cheap re-mount would otherwise flicker the modal.
   */
  recoveryRemote: string | null;
  /**
   * The exact bytes we last either (a) parsed from disk into the store, or
   * (b) flushed via the save queue. Used to detect foreign writes that
   * arrive via `setViewData` before our debounced vault-modify handler can
   * compare them against the pre-snapshot state. Without this, the
   * false-positive guard misclassifies external writes as silent echoes
   * because `applyDiskSnapshot` has already pulled the foreign content
   * into the in-memory store by the time the modify handler runs.
   */
  lastKnownSerialized: string | null;
}

export class KanbanView extends TextFileView {
  private session: KanbanViewSession | null = null;
  // Cached during setViewData → onLoadFile race. setViewData may run before
  // onLoadFile when Obsidian restores a workspace; we stash the text and
  // boot the session lazily once we have the file.
  private pendingData: string | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return KANBAN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'Kanban';
  }

  /**
   * Public accessor for the per-leaf Zustand store. Returns null when the
   * session hasn't booted (no file loaded yet) — callers must handle.
   */
  getStore(): BoardStore | null {
    return this.session?.store ?? null;
  }

  getIcon(): string {
    return 'kanban-square';
  }

  // ──────────────────────────────────────────────────────────────────
  // TextFileView contract: getViewData / setViewData / clear
  // ──────────────────────────────────────────────────────────────────

  getViewData(): string {
    // Serialize the current in-memory board back to Markdown. If the
    // session hasn't booted yet (no file loaded), echo the raw text.
    if (!this.session) return this.data;
    try {
      const text = serializeBoard(this.session.store.getState().board);
      return text;
    } catch (err) {
      this.engageReadOnly(`Serialize failed: ${String(err)}`);
      // Return whatever we last had on disk to avoid an empty write.
      return this.data;
    }
  }

  setViewData(data: string, _clear: boolean): void {
    this.data = data;

    if (!this.session) {
      // Defer — onLoadFile hasn't fired yet. We'll boot from pendingData.
      this.pendingData = data;
      return;
    }

    // Foreign-write detection MUST be synchronous on the setViewData
    // path. The pre-fix code dropped straight into `applyDiskSnapshot(data)`
    // here and waited for `onVaultModify`'s 50ms debounce to engage the
    // banner — but `applyDiskSnapshot` already replaced the in-memory board
    // by the time the debounce fired, so the banner never appeared.
    // We classify the write up-front using the self-write FIFO
    // and route the in-flight branch through the recovery diff instead.
    //
    // mtime: TextFileView.setViewData doesn't pass an mtime, but `this.file`
    // is set by Obsidian before setViewData is invoked on the open file
    // path. We read `file.stat.mtime` if available; fall back to `Date.now()`
    // so a missing stat doesn't poison the FIFO comparison (matches the
    // recordSelfWrite fallback in the save flush below).
    const stat = this.file?.stat;
    const mtime = stat?.mtime ?? Date.now();
    const foreign = this.session.selfWrite.isForeign(data, mtime);

    if (!foreign) {
      // Our own write echoing back through the host. The in-memory board is
      // already the source of truth for these exact bytes — we serialized
      // them from it moments ago in the save flush. Re-parsing our own
      // serialization and calling setBoard() is not just needless churn: it
      // silently drops transient in-memory-only state. A freshly-created
      // empty placeholder card (from "+ Add card") serializes to nothing, so
      // the reparse yields a board WITHOUT it and setBoard() deletes it out
      // from under the user's open inline editor — the card appears, then
      // vanishes ~600ms later when the debounced save round-trips. (This is
      // exactly what `onVaultModify`'s own self-write branch already avoids:
      // it records the echo and returns without reparsing.)
      //
      // So when our in-memory serialization matches the written bytes, treat
      // this as a no-op echo and leave the store untouched (preserving the
      // live placeholder + focus). Only fall back to a full resync if they
      // somehow diverged (defensive — shouldn't happen for a clean echo).
      try {
        if (serializeBoard(this.session.store.getState().board) === data) {
          this.session.selfWrite.recordSelfWrite(data, mtime);
          return;
        }
      } catch {
        // Serializer threw — fall through and resync from disk defensively.
      }
      this.applyDiskSnapshot(data);
      return;
    }

    if (this.session.saveQueue.isInFlight()) {
      // True conflict: foreign edit landed while our save was mid-flight.
      // Do NOT apply to the store (would overwrite the user's unsynced
      // edits silently). Engage read-only and open the recovery diff so
      // the user can pick a winner. `openRecoveryDiff` reads our local
      // serialization for the side-by-side display.
      this.engageReadOnly('External edit during save');
      this.openRecoveryDiff(data);
      return;
    }

    // A foreign write whose serialization
    // happens to match our in-memory model byte-for-byte is an idempotent
    // echo (e.g. Sync round-tripping through its CRDT). Treat it as a
    // self-write so the user sees no banner — but record the fingerprint
    // so subsequent identical echoes don't re-trigger the check.
    try {
      const inMemorySerialized = serializeBoard(
        this.session.store.getState().board,
      );
      if (inMemorySerialized === data) {
        this.session.selfWrite.recordSelfWrite(data, mtime);
        // Nothing changed semantically — leave the store as-is so we
        // don't churn a render cycle for a no-op.
        return;
      }
    } catch {
      // Serializer failed — fall through to the banner-engage path.
    }

    // DO NOT silently absorb a foreign
    // write. Pre-fix code dropped straight into `applyDiskSnapshot(data)`
    // here, which both wrote the foreign content into the store AND
    // cleared any banner state via the post-apply `setReadOnly(false, …)`
    // guard. The contract requires the
    // `<ReadOnlyBanner>` with Retry / Open as text / Report — the user
    // must see the foreign edit and decide whether to absorb it.
    this.openRecoveryDiff(data);
  }

  clear(): void {
    this.data = '';
    if (this.session) {
      this.applyDiskSnapshot('');
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Lifecycle: load / unload
  // ──────────────────────────────────────────────────────────────────

  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    const text = this.pendingData ?? this.data ?? '';
    this.pendingData = null;
    this.bootSession(file, text);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    await this.teardownSession();
    await super.onUnloadFile(file);
  }

  async onClose(): Promise<void> {
    await this.teardownSession();
    await super.onClose();
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal: boot / teardown a session
  // ──────────────────────────────────────────────────────────────────

  private bootSession(file: TFile, sourceText: string): void {
    if (this.session) {
      // Re-parse into the existing store — keeps the React tree mounted.
      this.applyDiskSnapshot(sourceText);
      return;
    }

    const cleanup = createCleanupChecklist(`KanbanView(${file.path})`);

    // Parse the initial disk snapshot.
    const parsed = parseBoard(sourceText);
    if (!parsed.board) {
      // Boot with an empty placeholder board so the view can mount; the
      // banner explains why edits are blocked.
      const placeholder = emptyBoard(sourceText);
      const session = this.assembleSession(placeholder, cleanup);
      // Track the broken bytes so a later setViewData carrying
      // the same broken text classifies as an echo via routeIncomingData
      // rather than layering a recovery-diff overlay on top of the
      // parse-error banner.
      session.lastKnownSerialized = sourceText;
      this.session = session;
      this.mountReact(session, file);
      this.engageReadOnly(
        parsed.errors.map((e) => e.message).join('; ') || 'Parse failed',
      );
      this.registerVaultListeners(file);
      return;
    }

    const session = this.assembleSession(parsed.board, cleanup);
    session.lastKnownSerialized = sourceText;
    this.session = session;
    this.mountReact(session, file);
    this.registerVaultListeners(file);
  }

  private assembleSession(
    initialBoard: Board,
    cleanup: CleanupChecklist,
  ): KanbanViewSession {
    const undoStack = createUndoStack({ capacity: 50 });

    const saveQueue = createSaveQueue<Board>({
      debounceMs: 600,
      flush: async (snapshot) => {
        // Hold the license FSM busy for the flight so queued license
        // transitions (revalidate result, grace boundary) don't commit
        // mid-write. Paired release in `finally`.
        licenseFSM.setBusy(true);
        try {
          // Serialize and write through the TextFileView's requestSave path.
          // We update `data` and call `requestSave()` so Obsidian's own
          // save machinery does the actual modify(). The TextFileView base
          // routes requestSave → save() → vault.modify(file, getViewData()).
          const text = serializeBoard(snapshot);
          this.data = text;
          // Record the fingerprint BEFORE the write so the modify event
          // handler can recognize our own write. mtime is filled in from
          // the file stat at flush time; the modify-event mtime will be
          // close-but-not-equal — the FIFO + mtime window absorbs the
          // drift (see SELF_WRITE_MTIME_WINDOW_MS).
          if (this.session) {
            this.session.selfWrite.recordSelfWrite(
              text,
              this.file?.stat.mtime ?? Date.now(),
            );
            // Track the last-known serialized state so a subsequent
            // setViewData carrying this exact text classifies as an
            // echo rather than a foreign write.
            this.session.lastKnownSerialized = text;
          }
          // requestSave is debounced internally by Obsidian; we already
          // debounced upstream. Calling it here is the canonical way to
          // hand off to the host's save pipeline.
          this.requestSave();
        } finally {
          licenseFSM.setBusy(false);
        }
      },
      onError: (err) => {
        log.error('save queue flush failed', err);
        this.engageReadOnly(`Save failed: ${String(err)}`);
      },
    });

    const store = createBoardStore({
      initialBoard,
      onMutate: (board) => {
        // Every mutation schedules a save. The store does not gate this
        // on errors — that is the never-silence invariant. The read-only
        // mode UI prevents mutations at the input layer; if a mutation
        // does land in read-only state, we still schedule it (the user
        // chose Retry).
        saveQueue.schedule(board);
      },
      onGestureCommit: (preBoard) => {
        // One undo entry per drag gesture. The pre-board snapshot is
        // what the user sees after undo.
        undoStack.commitGesture(preBoard);
      },
      // Pro entitlement reader — used by `toggleCardDone` to gate the
      // recurrence-successor spawn. We thread the license FSM here so
      // the store stays decoupled from the license module's lifecycle.
      getEntitlement: (key) => licenseFSM.hasEntitlement(key),
    });

    cleanup.add('save-queue', () => saveQueue.cancel());
    cleanup.add('undo-stack', () => undoStack.clear());
    // Zustand v5 stores don't need explicit destroy, but we clear
    // subscribers so any straggling React effect can't fire after unmount.
    cleanup.add('store-subscribers', () => {
      // No-op marker — kept for symmetry; selectors release naturally
      // when their React components unmount.
    });

    return {
      store,
      saveQueue,
      undoStack,
      cleanup,
      reactRoot: null as unknown as Root, // filled by mountReact
      selfWrite: makeSelfWriteDetector(),
      modifyEventRef: null,
      recoveryDispose: null,
      recoveryRemote: null,
      lastKnownSerialized: null,
    };
  }

  private mountReact(session: KanbanViewSession, _file: TFile): void {
    // Clear contentEl, mount a single root, render BoardRoot.
    this.contentEl.empty?.();
    while (this.contentEl.firstChild) this.contentEl.removeChild(this.contentEl.firstChild);
    const mountPoint = this.contentEl.createDiv?.('kanban-pro-mount') ?? (() => {
      const d = document.createElement('div');
      d.className = 'kanban-pro-mount';
      this.contentEl.appendChild(d);
      return d;
    })();

    const root = createRoot(mountPoint);
    session.reactRoot = root;
    session.cleanup.add('react-root', () => root.unmount());

    this.renderTree();
  }

  private renderTree(): void {
    if (!this.session) return;
    const session = this.session;
    const mode = this.resolveMode();

    // Banner is wired here — it's a peer of BoardRoot in the same tree.
    // We don't subscribe to the store at this level (would re-render the
    // whole BoardRoot on every mutation). Instead we render a thin
    // wrapper that subscribes only to readOnly + errorMessage.
    //
    // SavedViewStore lookup: plugin-owned per `main.ts`. We probe through
    // `app.plugins.plugins[KANBAN_PRO_PLUGIN_ID]` so this file doesn't import
    // the plugin class (which would invert the module graph). When the lookup
    // fails (tests that mount KanbanView in isolation), BoardRoot
    // tolerates `savedViewStore = null` and falls back to the
    // "no saved views yet" empty state — the right-rail chips still work
    // because they carry their own filter predicates.
    const savedViewStore = pluginSavedViewStore(this.app);
    const trackingStore = pluginTrackingStore(this.app);
    session.reactRoot.render(
      <ViewShell
        store={session.store}
        app={this.app}
        viewComponent={this}
        sourcePath={this.file?.path}
        mode={mode}
        savedViewStore={savedViewStore}
        trackingStore={trackingStore}
        onRetry={() => this.retryAfterError()}
        onOpenAsText={() => this.openAsText()}
        onReport={() => this.reportError()}
        onShowDiff={() => this.showRecoveryDiff()}
      />,
    );
  }

  private resolveMode(): ViewMode {
    if (!this.session) return 'board';
    // store.selectMode() returns modeOverride ?? settings['default-view'] ?? 'board'
    return this.session.store.selectMode();
  }

  /** Public — invoked from the command palette / hotkey. Cycles transiently. */
  cycleViewMode(): void {
    if (!this.session) return;
    const order: ViewMode[] = ['board', 'table', 'list'];
    const current = this.resolveMode();
    const next = order[(order.indexOf(current) + 1) % order.length];
    // Set the transient override in the store so React subscribers
    // (BoardRoot's useMode) re-render. This does NOT write to the
    // persisted `default-view` setting.
    this.session.store.getState().setMode(next);
  }

  /**
   * Pop the most recent gesture snapshot and restore the board.
   *
   * Wired into a `Cmd/Ctrl+Z` command in main.ts. Returns true if a
   * snapshot was consumed so the caller (command-palette checkCallback)
   * can no-op the hotkey when the stack is empty — that lets Obsidian's
   * native Cmd+Z fall through to whatever's underneath, instead of
   * silently swallowing the keystroke.
   *
   * The restore goes through `setBoard` which does NOT call onMutate
   * (avoid an immediate save loop). We do schedule a save explicitly so
   * the on-disk board reflects the undone state.
   */
  undo(): boolean {
    if (!this.session) return false;
    const current = this.session.store.getState().board;
    const prev = this.session.undoStack.undo(current);
    if (!prev) return false;
    this.session.store.getState().setBoard(prev);
    // Clear card hashes so the serializer's byte-identity short-
    // circuit at `write.ts` doesn't emit the post-mutation source for
    // the restored (pre-mutation) board. Bump renderGeneration so any
    // React subtree keyed off it remounts and re-reads the restored
    // model — `useStoreSelector`'s structural-equality cache would
    // otherwise mask card field swaps that look "the same shape".
    this.session.store.getState().invalidateAllHashes();
    this.session.store.getState().bumpRenderGeneration();
    this.session.saveQueue.schedule(this.session.store.getState().board);
    return true;
  }

  /**
   * Pop the most recent redo entry and re-apply it.
   *
   * Wired into `Cmd/Ctrl+Shift+Z` (and `Cmd/Ctrl+Y` on Windows) in
   * main.ts — "redo not implemented". The underlying stack
   * already supports redo (`createUndoStack` keeps a future stack);
   * undo() pushes the current state onto it and a fresh gesture commit
   * clears it. We just had to expose the hatch.
   */
  redo(): boolean {
    if (!this.session) return false;
    const current = this.session.store.getState().board;
    const next = this.session.undoStack.redo(current);
    if (!next) return false;
    this.session.store.getState().setBoard(next);
    // Same hash-invalidation + render-bump as `undo()`. Redo has
    // the same stale-UI defect as undo:
    // the byte-identity short-circuit + structural-equality memoization
    // can mask the board swap if both ends of the redo edge happen to
    // look "shaped the same" to the subscription layer.
    this.session.store.getState().invalidateAllHashes();
    this.session.store.getState().bumpRenderGeneration();
    this.session.saveQueue.schedule(this.session.store.getState().board);
    return true;
  }

  /** True if an undo entry is available — used by the command checkCallback. */
  canUndo(): boolean {
    return this.session?.undoStack.canUndo() ?? false;
  }

  /** True if a redo entry is available — used by the command checkCallback. */
  canRedo(): boolean {
    return this.session?.undoStack.canRedo() ?? false;
  }

  /**
   * Push a board snapshot onto the undo stack as a single gesture entry.
   * Used by `canonicalizeActiveBoard` so the user can `Cmd+Z` to revert
   * the canonicalize pass (a structural change must be
   * reversible via Cmd+Z).
   */
  pushUndoSnapshot(snapshot: Board): void {
    if (!this.session) return;
    this.session.undoStack.commitGesture(snapshot);
  }

  // ──────────────────────────────────────────────────────────────────
  // Vault event handling — self-write detection
  // ──────────────────────────────────────────────────────────────────

  private registerVaultListeners(file: TFile): void {
    if (!this.session) return;
    const ref = this.app.vault.on('modify', (modified) => {
      if (!(modified instanceof TFile)) return;
      if (modified.path !== file.path) return;
      this.onVaultModify(modified);
    });
    this.session.modifyEventRef = ref;
    this.registerEvent(ref);
  }

  private onVaultModify = obsidianDebounce(
    (file: TFile) => {
      if (!this.session) return;

      // Self-write check: read current text, hash it, look for a match
      // in the FIFO. Match → ignore. Miss → either re-parse (safe case)
      // or open the recovery diff (a save was in flight).
      void this.app.vault.read(file).then((text) => {
        if (!this.session) return;
        const foreign = this.session.selfWrite.isForeign(text, file.stat.mtime);
        if (!foreign) {
          // Our own write — record the observed mtime so subsequent
          // comparisons stay tight.
          this.session.selfWrite.recordSelfWrite(text, file.stat.mtime);
          return;
        }

        // Foreign write. If a save is in flight, we have a TRUE conflict
        // — the user's edits and the disk state both have unsynced
        // changes. Engage read-only + open recovery diff.
        if (this.session.saveQueue.isInFlight()) {
          this.openRecoveryDiff(text);
          return;
        }

        // False-positive guard: an idempotent Sync echo (the host
        // re-writes a file the user never touched in another app, e.g.
        // Obsidian Sync round-tripping the same bytes through its CRDT)
        // can fail the self-write FIFO check because the content hash
        // doesn't match any of OUR recent flushes — yet the disk bytes
        // are semantically identical to what we already have in memory.
        // Compare against the serialized in-memory board: if equal, this
        // is a no-op echo and we treat it as a silent self-write.
        // Record the fingerprint so subsequent identical echoes don't
        // re-trigger the check.
        try {
          const inMemorySerialized = serializeBoard(
            this.session.store.getState().board,
          );
          if (inMemorySerialized === text) {
            this.session.selfWrite.recordSelfWrite(text, file.stat.mtime);
            return;
          }
        } catch {
          // Serializer failed — fall through to the foreign-write banner;
          // engageReadOnly already surfaces serialize errors elsewhere.
        }

        // Foreign write that differs from our in-memory model. We use a
        // non-dismissable banner + diff view + open-as-text, and we MUST
        // NOT silently absorb the change — that bypasses the in-flight
        // gesture safety the spec designs around and means the user has
        // no chance to inspect/keep their local edits before the foreign
        // version lands. Engage read-only and open the recovery diff with
        // the three actions (Apply local / Apply remote / Open as text).
        this.openRecoveryDiff(text);
      });
    },
    50,
  ) as unknown as (file: TFile) => void;

  // ──────────────────────────────────────────────────────────────────
  // Disk → store path
  // ──────────────────────────────────────────────────────────────────

  private applyDiskSnapshot(text: string): void {
    if (!this.session) return;
    const parsed = parseBoard(text);
    if (!parsed.board) {
      this.engageReadOnly(
        parsed.errors.map((e) => e.message).join('; ') || 'Parse failed',
      );
      // Even on a parse error, the bytes we just *tried* to absorb are
      // the canonical disk state — track them so a follow-up setViewData
      // carrying the same broken text classifies as an echo rather than
      // layering a recovery-diff overlay on top of the parse-error
      // banner.
      this.session.lastKnownSerialized = text;
      return;
    }
    // setBoard does NOT trigger onMutate → save queue (would loop).
    this.session.store.getState().setBoard(parsed.board);
    // The applied bytes are now what we'd consider canonical for the
    // file. A subsequent setViewData carrying these bytes (e.g. when the
    // user picks "Apply remote" in the recovery diff and the host
    // re-fires setViewData with the same text) classifies as an echo.
    this.session.lastKnownSerialized = text;
    // Also record the bytes in the self-write FIFO so the debounced
    // onVaultModify handler that fires for the SAME bytes a few ms
    // later doesn't classify them as a foreign write. Without this the
    // recovery-diff "Apply remote" path can re-open itself on a
    // serializer that doesn't byte-exact round-trip.
    this.session.selfWrite.recordSelfWrite(
      text,
      this.file?.stat.mtime ?? Date.now(),
    );
    // Clear read-only if a re-parse succeeded (e.g. user fixed file in text editor).
    if (this.session.store.getState().readOnly) {
      this.session.store.getState().setReadOnly(false, null);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Error → read-only handling
  // ──────────────────────────────────────────────────────────────────

  private engageReadOnly(message: string): void {
    if (!this.session) return;
    this.session.store.getState().setReadOnly(true, message);
    log.warn('engaged read-only mode:', message);
    // Re-render so the banner appears immediately.
    this.renderTree();
  }

  private retryAfterError(): void {
    if (!this.session) return;
    this.session.store.getState().setReadOnly(false, null);
    // Re-queue the current snapshot — the save queue's never-silence
    // invariant means future schedules still flush.
    this.session.saveQueue.schedule(this.session.store.getState().board);
    this.renderTree();
  }

  private openAsText(): void {
    if (!this.file) return;
    // Reopen the file in the default Markdown view.
    void this.app.workspace.getLeaf('split').openFile(this.file, {
      state: { mode: 'source' },
    } as unknown as Parameters<WorkspaceLeaf['openFile']>[1]);
  }

  private reportError(): void {
    if (!this.session) return;
    const payload = {
      file: this.file?.path,
      message: this.session.store.getState().errorMessage,
      board: this.session.store.getState().board,
    };
    const text = JSON.stringify(payload, null, 2);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    log.info('report payload copied to clipboard');
  }

  // ──────────────────────────────────────────────────────────────────
  // Recovery diff — opened on detected sync conflicts.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Open the recovery diff view. Engages read-only and surfaces a banner
   * so the in-memory board can't drift further until the user picks an
   * outcome. Idempotent — re-invoking while a diff is open replaces the
   * existing modal with the latest disk snapshot.
   */
  private openRecoveryDiff(remoteText: string): void {
    if (!this.session) return;

    // Collapse back-to-back calls with the same remote text. In production
    // both setViewData and onVaultModify can fire for a single external
    // write; without this guard the modal would dispose+remount and the
    // user would see a flicker.
    if (
      this.session.recoveryDispose !== null &&
      this.session.recoveryRemote === remoteText
    ) {
      return;
    }

    this.engageReadOnly(
      'Sync conflict detected — pick a version to keep.',
    );

    // Replace any in-flight diff with the fresh snapshot.
    this.session.recoveryDispose?.();
    this.session.recoveryDispose = null;
    this.session.recoveryRemote = remoteText;

    const localBoard = this.session.store.getState().board;
    const localText = (() => {
      try {
        return serializeBoard(localBoard);
      } catch {
        return this.data;
      }
    })();

    const mounted = mountRecoveryDiff(this.contentEl, {
      local: localText,
      remote: remoteText,
      onApplyLocal: () => {
        if (!this.session) return;
        this.session.recoveryDispose = null;
        this.session.recoveryRemote = null;
        // Force a fresh write of the in-memory board.
        this.session.saveQueue.schedule(this.session.store.getState().board);
        this.session.store.getState().setReadOnly(false, null);
        this.renderTree();
      },
      onApplyRemote: () => {
        if (!this.session) return;
        this.session.recoveryDispose = null;
        this.session.recoveryRemote = null;
        this.data = remoteText;
        this.applyDiskSnapshot(remoteText);
      },
      onOpenAsText: () => {
        if (!this.session) return;
        this.session.recoveryDispose = null;
        this.session.recoveryRemote = null;
        this.openAsText();
      },
      onCancel: () => {
        if (!this.session) return;
        this.session.recoveryDispose = null;
        this.session.recoveryRemote = null;
        // Keep the read-only banner up; user can still hit Retry to
        // re-attempt the save.
        this.renderTree();
      },
    });

    this.session.recoveryDispose = mounted.dispose;
    this.session.cleanup.add('recovery-diff', () => mounted.dispose());
  }

  /** Public — invoked from the read-only banner's "Show diff" button. */
  showRecoveryDiff(): void {
    if (!this.file) return;
    void this.app.vault.read(this.file).then((text) => {
      this.openRecoveryDiff(text);
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Teardown
  // ──────────────────────────────────────────────────────────────────

  private async teardownSession(): Promise<void> {
    if (!this.session) return;
    const session = this.session;
    this.session = null;
    // Flush pending save so we don't lose the last keystroke on close.
    try {
      await session.saveQueue.flushNow();
    } catch {
      // doFlush already routed the error; we still must continue teardown.
    }
    await session.cleanup.runAll();
  }
}

// ────────────────────────────────────────────────────────────────────────
// ViewShell — thin subscription wrapper around BoardRoot and the banner.
// Subscribes only to `readOnly` and `errorMessage` (primitives), so it
// does NOT re-render on every board mutation.
// ────────────────────────────────────────────────────────────────────────

interface ViewShellProps {
  store: BoardStore;
  app: import('obsidian').App;
  viewComponent: import('obsidian').Component;
  sourcePath: string | undefined;
  mode: ViewMode;
  savedViewStore: SavedViewStore | null;
  trackingStore: TrackingStore | null;
  onRetry: () => void;
  onOpenAsText: () => void;
  onReport: () => void;
  onShowDiff: () => void;
}

const ViewShell: React.FC<ViewShellProps> = ({
  store,
  app,
  viewComponent,
  sourcePath,
  mode,
  savedViewStore,
  trackingStore,
  onRetry,
  onOpenAsText,
  onReport,
  onShowDiff,
}) => {
  const readOnly = store((s) => s.readOnly);
  const errorMessage = store((s) => s.errorMessage);
  const banner = readOnly ? (
    <ReadOnlyBanner
      message={errorMessage ?? 'An error occurred.'}
      onRetry={onRetry}
      onOpenAsText={onOpenAsText}
      onReport={onReport}
      onShowDiff={onShowDiff}
    />
  ) : null;
  // Time tracking (Pro) is read through React context by CardTrackingChip /
  // the right-rail timer section. Provide the plugin-owned store here so the
  // whole board subtree can reach it; `null` (tests / pre-boot) degrades to
  // the chip rendering nothing for Pro users, the same as before.
  return (
    <TrackingProvider store={trackingStore}>
      <BoardRoot
        store={store}
        app={app}
        viewComponent={viewComponent}
        sourcePath={sourcePath}
        mode={mode}
        savedViewStore={savedViewStore}
        banner={banner}
      />
    </TrackingProvider>
  );
};

/**
 * Look up the plugin-owned `SavedViewStore` via the app's plugin
 * registry. `app.plugins` is part of Obsidian's informal/untyped surface;
 * we probe defensively so tests (which don't register the plugin) and
 * hosts that locked the private API down still mount the board cleanly.
 */
function pluginSavedViewStore(
  app: import('obsidian').App,
): SavedViewStore | null {
  type PluginsHost = {
    plugins?: {
      plugins?: Record<string, { savedViews?: SavedViewStore | null } | undefined>;
    };
  };
  const reg = (app as unknown as PluginsHost).plugins?.plugins;
  const plugin = reg?.[KANBAN_PRO_PLUGIN_ID];
  return plugin?.savedViews ?? null;
}

/**
 * Look up the plugin-owned `TrackingStore` (Pro time tracking) via the app's
 * plugin registry — same defensive probe as `pluginSavedViewStore`. Returns
 * `null` when the plugin isn't registered (isolated-mount tests) so the
 * board still renders; the tracking chips then no-op for Pro users.
 */
function pluginTrackingStore(
  app: import('obsidian').App,
): TrackingStore | null {
  type PluginsHost = {
    plugins?: {
      plugins?: Record<string, { tracking?: TrackingStore | null } | undefined>;
    };
  };
  const reg = (app as unknown as PluginsHost).plugins?.plugins;
  const plugin = reg?.[KANBAN_PRO_PLUGIN_ID];
  return plugin?.tracking ?? null;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function emptyBoard(originalSource: string): Board {
  // A minimal placeholder used when parse fails on initial load. The user
  // sees the read-only banner; the store has something to render.
  return {
    lanes: [],
    frontmatter: { 'kanban-plugin': 'board' },
    settings: {},
    fileTrivia: {
      bom: false,
      newline: originalSource.includes('\r\n') ? '\r\n' : '\n',
      trailingNewline: originalSource.endsWith('\n'),
      originalSource,
    },
    hash: hashString(originalSource),
  };
}
