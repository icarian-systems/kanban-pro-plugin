/**
 * Per-leaf Zustand store.
 *
 * A single store instance is created per KanbanView leaf (and per embed
 * instance). Stores are never shared between leaves — this preserves
 * subscription locality and prevents one board's updates from rerendering
 * an unrelated view.
 *
 * ## Selector contract (load-bearing)
 *
 * No component subscribes to `state.board` or any board-scope object
 * reference. The architectural reason: every move/edit produces a new
 * Board object (Immer), so a subscription to the board ref would re-render
 * every subscriber on every mutation — that is the failure mode the
 * incumbent suffers from.
 *
 * Selectors **must** return:
 *   - a primitive (string, number, boolean), OR
 *   - a stable ref (e.g. `state.board.lanes[i]` — fine if the lane is the
 *     object whose shape changed; immer preserves identity for untouched
 *     nodes), OR
 *   - an array of IDs (`string[]`) — but be aware these are NOT reference
 *     stable across mutations; use `shallow` equality with the hook.
 *
 * The selector helpers exported here all return stable refs or ID arrays;
 * prefer them to ad-hoc selectors.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { produce, type Draft } from 'immer';
import type {
  Board,
  Card,
  CardId,
  InlineMeta,
  Lane,
  LaneId,
  Subtask,
  SubtaskId,
  ViewMode,
} from '@/core/model';
import { applyCompletion } from '@/pro/recurrence';
import { parseInlineMeta } from '@/core/parser/inlineMeta';

export interface CardPatch {
  text?: string;
  done?: boolean;
  /** Replace the card's inline meta. Partial fields are merged shallowly. */
  meta?: Partial<InlineMeta> | InlineMeta;
}

export interface LanePatch {
  title?: string;
  collapsed?: boolean;
}

export interface BoardActions {
  /** Replace the entire board (e.g. after re-parsing from disk on setViewData). */
  setBoard: (board: Board) => void;
  moveCard: (cardId: CardId, fromLaneId: LaneId, toLaneId: LaneId, toIndex: number) => void;
  addCard: (laneId: LaneId, cardOrText?: Card | string, index?: number) => CardId;
  editCard: (cardId: CardId, patch: CardPatch) => void;
  deleteCard: (cardId: CardId) => void;
  moveLane: (laneId: LaneId, toIndex: number) => void;
  addLane: (laneOrTitle?: Lane | string, index?: number) => LaneId;
  editLane: (laneId: LaneId, patch: LanePatch) => void;
  deleteLane: (laneId: LaneId) => void;
  archiveCard: (cardId: CardId) => void;
  toggleCardDone: (cardId: CardId) => void;
  toggleSubtaskDone: (cardId: CardId, subtaskId: SubtaskId) => void;
  toggleSubtask: (cardId: CardId, subtaskId: SubtaskId) => void;
  editSubtask: (cardId: CardId, subtaskId: SubtaskId, text: string) => void;
  addSubtask: (cardId: CardId, text: string) => SubtaskId;
  deleteSubtask: (cardId: CardId, subtaskId: SubtaskId) => void;
  setMode: (mode: ViewMode) => void;
  /**
   * Clear board.hash AND every card.hash. Used by undo/redo paths so the
   * serializer's byte-identity short-circuit (`write.ts`) cannot return a
   * stale source for the restored snapshot, and so the in-memory model is
   * treated as authoritative on the next save.
   *
   * NOTE: this does NOT trigger onMutate — the caller (undo/redo) is
   * responsible for scheduling a save when appropriate.
   */
  invalidateAllHashes: () => void;
  /**
   * Increment `renderGeneration` so React subscribers that key off it
   * (BoardView columns, Card components) remount and re-evaluate. Used by
   * undo/redo to force the UI to reflect the restored snapshot even if
   * structural-equality compares would otherwise collapse the change.
   *
   * Does NOT trigger onMutate.
   */
  bumpRenderGeneration: () => void;
}

export interface GestureApi {
  /** Begin a drag gesture. Captures the pre-drag snapshot for undo. */
  beginGesture: () => void;
  /** Optimistic in-gesture move — does NOT schedule a save. */
  moveCardOptimistic: (cardId: CardId, toLaneId: LaneId, toIndex: number) => void;
  /** Commit the gesture — pushes undo entry and schedules a save. */
  commitGesture: () => void;
  /** Cancel the gesture — reverts to the pre-drag snapshot. No save, no undo entry. */
  cancelGesture: () => void;
}

export interface BoardState {
  board: Board;
  /** Transient mode override (Cmd/Ctrl+Shift+V cycle); when null, fall back to settings['default-view']. */
  modeOverride: ViewMode | null;
  /** Read-only mode is engaged when a save/serialize/parse error occurs.
   *  See: never-silence invariant. */
  readOnly: boolean;
  /** Last surfaced error message (toast text, banner body). */
  errorMessage: string | null;
  /**
   * Monotonic counter bumped by undo/redo (and any other history-restoring
   * path) so the UI can use it as part of a React key to force remount of
   * card trees. Plain mutations do NOT bump this — they rely on Immer's
   * stable-ref discipline + per-card subscriptions. Restoration paths,
   * however, swap the whole board reference at once and need a hard
   * re-evaluation to overcome structural-equality memoization in the
   * subscription helpers (see `useStoreSelector`).
   */
  renderGeneration: number;
  setReadOnly: (ro: boolean, errorMessage?: string | null) => void;
}

export type BoardStoreState = BoardState & BoardActions & GestureApi;

/**
 * Selector helpers attached to the store object itself, so UI components
 * can call `store.selectMode()` directly. The selector contract still
 * stands: each helper returns a primitive, a stable ref, or an ID array.
 *
 * `isReadOnly()` is intentionally a method (not a derived value) so the
 * UI can call it without subscribing to the whole state — combined with
 * `store.subscribe(cb)` (Zustand's built-in), this gives the UI a clean
 * `useSyncExternalStore` integration.
 */
export interface BoardStoreExtras {
  selectLaneIds: () => LaneId[];
  selectLane: (id: LaneId) => Lane | undefined;
  selectCardIds: (laneId: LaneId) => CardId[];
  selectCard: (id: CardId) => Card | undefined;
  selectMode: () => ViewMode;
  selectBoardMeta: () => { title: string; cardCount: number; laneCount: number; editedAt?: string };
  isReadOnly: () => boolean;
}

/**
 * The components Frontend ships call `store.editCard(...)` directly rather
 * than `store.getState().editCard(...)`. We expose the action surface as
 * top-level methods on the store object — they read the latest state on
 * each call, so they're stable across mutations and safe to capture in
 * closures.
 */
export type BoardStoreActionProxies = BoardActions & GestureApi & {
  setReadOnly: BoardState['setReadOnly'];
};

export type BoardStore =
  UseBoundStore<StoreApi<BoardStoreState>>
  & BoardStoreExtras
  & BoardStoreActionProxies;

export interface CreateBoardStoreOptions {
  initialBoard: Board;
  /**
   * Called after every successful mutation with the post-mutation board.
   * The KanbanView wires this to the save queue's `schedule()`. The store
   * NEVER calls onMutate when a mutation throws (so callers don't see
   * inconsistent state), and NEVER skips onMutate because of board errors
   * (the save queue's never-silence invariant lives downstream).
   */
  onMutate?: (board: Board) => void;
  /**
   * Called when a gesture commits with the PRE-gesture board snapshot
   * (or, for non-gesture mutations, the pre-mutation snapshot if the
   * caller threads it). KanbanView routes this to the undo stack so
   * each gesture produces exactly one undo entry.
   *
   * NOTE: only gesture commits invoke this callback in v1. Outside
   * gestures, callers (e.g. inline editors) push undo entries manually
   * around their batched edits.
   */
  onGestureCommit?: (preBoard: Board) => void;

  /**
   * Embeds get isolated stores. The flag is used only to tag the store
   * (helpful for devtools) and to gate certain UI features upstream.
   */
  isEmbed?: boolean;

  /**
   * Returns whether a given Pro entitlement is currently active. The
   * store calls this from `toggleCardDone` to decide whether to spawn
   * the next recurrence card (Pro-only). Defaults to a stub that
   * returns false, which keeps non-Pro flows (and tests that don't
   * thread a license FSM) recurrence-free.
   *
   * Wired in `main.ts` via `(key) => licenseFSM.hasEntitlement(key)`.
   */
  getEntitlement?: (key: string) => boolean;
}

/**
 * Apply an Immer recipe and (by default) call onMutate so the save queue
 * schedules a write. Pass `silent: true` for in-gesture optimistic moves
 * that must NOT trigger a save until the gesture commits.
 *
 * Hash invalidation: after a mutation, the board's content hash is cleared
 * so `serializeBoard`'s byte-identity fast-path (write.ts) cannot return
 * the unedited source. Parse populates `board.hash`; only mutations clear
 * it. The serializer recomputes a fresh identity from the model when it
 * emits — this is purely a "the cached identity is stale" signal.
 */
function applyMutation(
  set: (fn: (s: BoardStoreState) => Partial<BoardStoreState>) => void,
  get: () => BoardStoreState,
  onMutate: ((b: Board) => void) | undefined,
  recipe: (draft: Draft<Board>) => void,
  silent = false,
): void {
  const next = produce(get().board, (draft) => {
    recipe(draft);
    draft.hash = '';
  });
  // Zustand v5 replaces state with `undefined` when the setter callback
  // returns void, so we must return a partial. The default (non-replace)
  // setState shallow-merges this partial into the existing state.
  set(() => ({ board: next }));
  if (!silent && onMutate) onMutate(next);
}

let _idSeq = 0;
const nextId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(_idSeq++).toString(36)}`;

function makeCard(text: string): Card {
  // Seed `meta` from the card's text. The previous empty
  // initializer caused the serializer's per-token sync (setFieldsInText /
  // setTagsInText) to strip every inline-meta token the user had just typed
  // — losing `[rrule:: ...]` (the flagship Pro feature), `#tags`, dates, etc.
  // on the very next save. The parser is the single source of truth: any new
  // Card whose `text` contains inline-meta vocab gets that vocab reflected on
  // `meta` immediately, matching what `parseBoard` would have done.
  return {
    id: nextId('card'),
    text,
    done: false,
    hash: '',
    meta: parseInlineMeta(text).meta,
    subtasks: [],
  };
}

/**
 * "Has the caller given us a meaningfully-populated meta?" Used by addCard to
 * decide whether to re-seed an externally-built Card from its text.
 */
function isEmptyMeta(m: InlineMeta | undefined): boolean {
  if (!m) return true;
  if (m.date || m.time || m.blockId) return false;
  if ((m.tags ?? []).length > 0) return false;
  if (Object.keys(m.fields ?? {}).length > 0) return false;
  if (Object.keys(m.emoji ?? {}).length > 0) return false;
  return true;
}

/**
 * Merge a parsed-from-text meta with the model's existing meta using the
 * "model wins per-key, parsed-only keys preserved" rule (mirrors the
 * serializer's `canonicalCard` field/tag merge). Used by `editCard` when the
 * caller passes a new `text` without an explicit `meta` so the freshly
 * typed inline tokens don't get clobbered by stale model state.
 */
function mergeMetaFromText(modelMeta: InlineMeta, text: string): InlineMeta {
  const parsed = parseInlineMeta(text).meta;
  // Tags: union, model order first (preserves user-edited order), then any
  // parsed-only tags. Mirrors `canonicalCard`'s union semantics.
  const tags: string[] = [];
  for (const t of modelMeta.tags ?? []) if (!tags.includes(t)) tags.push(t);
  for (const t of parsed.tags ?? []) if (!tags.includes(t)) tags.push(t);
  // Fields: parsed-then-model so model overrides on conflict, parsed-only
  // keys (rrule etc.) survive.
  const fields: Record<string, string> = {
    ...(parsed.fields ?? {}),
    ...(modelMeta.fields ?? {}),
  };
  // Emoji: same merge rule as fields.
  const emoji: Record<string, string> = {
    ...(parsed.emoji ?? {}),
    ...(modelMeta.emoji ?? {}),
  };
  return {
    ...parsed,
    ...modelMeta,
    tags,
    fields,
    emoji,
  };
}

function makeLane(title: string): Lane {
  return {
    id: nextId('lane'),
    title,
    kind: 'normal',
    cards: [],
    collapsed: false,
  };
}

function makeSubtask(text: string): Subtask {
  return { id: nextId('subtask'), text, done: false };
}

interface GestureCheckpoint {
  preBoard: Board;
  /** Track whether the gesture has been "touched" (optimistic move applied).
   *  Used by commitGesture to no-op if the gesture had no effect. */
  touched: boolean;
}

export function createBoardStore(opts: CreateBoardStoreOptions): BoardStore {
  const { initialBoard, onMutate, onGestureCommit } = opts;
  const getEntitlement = opts.getEntitlement ?? ((_key: string) => false);
  // Gesture state lives in closure (not store state) — it's transient and
  // shouldn't trigger subscriber notifications.
  let gesture: GestureCheckpoint | null = null;

  const store = create<BoardStoreState>()((set, get) => ({
    board: initialBoard,
    modeOverride: null,
    readOnly: false,
    errorMessage: null,
    renderGeneration: 0,

    setReadOnly: (ro, errorMessage = null) => {
      set((s) => ({ ...s, readOnly: ro, errorMessage }));
    },

    invalidateAllHashes: () => {
      // Clear board.hash AND every card.hash via an Immer recipe. We do
      // NOT route through applyMutation — that would call onMutate and
      // schedule a save loop. Restoration paths (undo/redo) schedule
      // their own save explicitly with the new board.
      const next = produce(get().board, (draft) => {
        draft.hash = '';
        for (const lane of draft.lanes) {
          for (const card of lane.cards) {
            card.hash = '';
          }
        }
      });
      set((s) => ({ ...s, board: next }));
    },

    bumpRenderGeneration: () => {
      set((s) => ({ ...s, renderGeneration: s.renderGeneration + 1 }));
    },

    setBoard: (board) => {
      // setBoard is used when the disk source changes (setViewData on
      // external write). This is NOT a user mutation, so we don't call
      // onMutate — that would trigger a write-back loop.
      set((s) => ({ ...s, board }));
    },

    setMode: (mode) => {
      set((s) => ({ ...s, modeOverride: mode }));
    },

    moveCard: (cardId, fromLaneId, toLaneId, toIndex) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        const fromLane = draft.lanes.find((l) => l.id === fromLaneId);
        const toLane = draft.lanes.find((l) => l.id === toLaneId);
        if (!fromLane || !toLane) return;
        const idx = fromLane.cards.findIndex((c) => c.id === cardId);
        if (idx === -1) return;
        const [card] = fromLane.cards.splice(idx, 1);
        const clamped = Math.max(0, Math.min(toIndex, toLane.cards.length));
        toLane.cards.splice(clamped, 0, card);
      });
    },

    addCard: (laneId, cardOrText, index) => {
      let card: Card =
        typeof cardOrText === 'string' || cardOrText === undefined
          ? makeCard(typeof cardOrText === 'string' ? cardOrText : '')
          : cardOrText;
      // A caller that passes a pre-built Card without
      // seeded meta would re-introduce the strip-on-serialize bug `makeCard`
      // closed above. Detect the empty-meta shape and re-seed from text — the
      // bypass surface is small (TemplatesModal historically built Cards
      // directly) but cheap to defend against here.
      if (
        typeof cardOrText !== 'string' &&
        cardOrText !== undefined &&
        isEmptyMeta(card.meta) &&
        card.text
      ) {
        card = { ...card, meta: parseInlineMeta(card.text).meta };
      }
      applyMutation(set as never, get, onMutate, (draft) => {
        const lane = draft.lanes.find((l) => l.id === laneId);
        if (!lane) return;
        // Block ids must be unique vault-wide. If a card with this id already
        // exists anywhere on the board, treat addCard as a no-op.
        if (draft.lanes.some((l) => l.cards.some((c) => c.id === card.id))) return;
        const idx = index ?? lane.cards.length;
        lane.cards.splice(
          Math.max(0, Math.min(idx, lane.cards.length)),
          0,
          card as Draft<Card>,
        );
      });
      return card.id;
    },

    editCard: (cardId, patch) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        for (const lane of draft.lanes) {
          const card = lane.cards.find((c) => c.id === cardId);
          if (card) {
            if (patch.text !== undefined) card.text = patch.text;
            if (patch.done !== undefined) card.done = patch.done;
            if (patch.meta !== undefined) {
              // Shallow merge — callers pass partials.
              card.meta = {
                ...card.meta,
                ...(patch.meta as Partial<InlineMeta>),
                tags: (patch.meta as Partial<InlineMeta>).tags ?? card.meta.tags,
                fields: (patch.meta as Partial<InlineMeta>).fields ?? card.meta.fields,
                emoji: (patch.meta as Partial<InlineMeta>).emoji ?? card.meta.emoji,
              };
            } else if (patch.text !== undefined) {
              // The typical commit-on-blur path passes
              // `{ text }` only. Without re-parsing, freshly typed
              // `[rrule:: ...]`, `#tags`, `@{date}` etc. never reach
              // `card.meta` — the serializer's per-key sync then strips them.
              // Merge parsed-from-text meta with existing model meta using
              // "model wins per-key, parsed-only keys preserved" (same rule
              // the serializer uses in `canonicalCard`).
              card.meta = mergeMetaFromText(card.meta, patch.text);
            }
            return;
          }
        }
      });
    },

    deleteCard: (cardId) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        for (const lane of draft.lanes) {
          const idx = lane.cards.findIndex((c) => c.id === cardId);
          if (idx !== -1) {
            lane.cards.splice(idx, 1);
            return;
          }
        }
      });
    },

    moveLane: (laneId, toIndex) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        const idx = draft.lanes.findIndex((l) => l.id === laneId);
        if (idx === -1) return;
        const [lane] = draft.lanes.splice(idx, 1);
        const clamped = Math.max(0, Math.min(toIndex, draft.lanes.length));
        draft.lanes.splice(clamped, 0, lane);
      });
    },

    addLane: (laneOrTitle, index) => {
      const lane: Lane =
        typeof laneOrTitle === 'string' || laneOrTitle === undefined
          ? makeLane(typeof laneOrTitle === 'string' ? laneOrTitle : 'New lane')
          : laneOrTitle;
      applyMutation(set as never, get, onMutate, (draft) => {
        const idx = index ?? draft.lanes.length;
        draft.lanes.splice(
          Math.max(0, Math.min(idx, draft.lanes.length)),
          0,
          lane as Draft<Lane>,
        );
      });
      return lane.id;
    },

    editLane: (laneId, patch) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        const lane = draft.lanes.find((l) => l.id === laneId);
        if (!lane) return;
        if (patch.title !== undefined) lane.title = patch.title;
        if (patch.collapsed !== undefined) lane.collapsed = patch.collapsed;
      });
    },

    deleteLane: (laneId) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        const idx = draft.lanes.findIndex((l) => l.id === laneId);
        if (idx === -1) return;
        draft.lanes.splice(idx, 1);
      });
    },

    archiveCard: (cardId) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        let archive = draft.lanes.find((l) => l.kind === 'archive');
        if (!archive) {
          // Create an Archive lane if it doesn't exist. The parser is the
          // source of truth for archive serialization (`***` + `## Archive`);
          // here we just stage the move in-memory.
          archive = {
            id: nextId('lane-archive'),
            title: 'Archive',
            kind: 'archive',
            cards: [],
            collapsed: true,
          } as Draft<Lane>;
          draft.lanes.push(archive);
        }
        for (const lane of draft.lanes) {
          if (lane === archive) continue;
          const idx = lane.cards.findIndex((c) => c.id === cardId);
          if (idx !== -1) {
            const [card] = lane.cards.splice(idx, 1);
            archive.cards.push(card);
            return;
          }
        }
      });
    },

    toggleCardDone: (cardId) => {
      // Track which lane held the card and whether the flip landed on
      // `done = true` (the recurrence trigger). We only need scalars
      // here — pulling the full post-flip Card off `get().board` below
      // avoids holding any reference into the now-revoked Immer draft.
      let transitionedToDone = false;
      let homeLaneId: LaneId | null = null;
      applyMutation(set as never, get, onMutate, (draft) => {
        for (const lane of draft.lanes) {
          const card = lane.cards.find((c) => c.id === cardId);
          if (card) {
            card.done = !card.done;
            if (card.done) {
              transitionedToDone = true;
              homeLaneId = lane.id;
            }
            return;
          }
        }
      });

      // Recurrence spawn — Pro-gated. If the card just transitioned to
      // done AND the user has the recurrence entitlement, call into
      // `applyCompletion` to produce a fresh successor card and insert
      // it immediately after the completed card in the same lane.
      if (!transitionedToDone || !homeLaneId) return;
      if (!getEntitlement('recurrence')) return;
      // Re-read the now-committed card from the store (NOT the draft).
      const postBoard = get().board;
      let completedCard: Card | undefined;
      for (const lane of postBoard.lanes) {
        completedCard = lane.cards.find((c) => c.id === cardId);
        if (completedCard) break;
      }
      if (!completedCard) return;
      const next = applyCompletion(completedCard, new Date());
      if (!next) return;
      applyMutation(set as never, get, onMutate, (draft) => {
        const lane = draft.lanes.find((l) => l.id === homeLaneId);
        if (!lane) return;
        const idx = lane.cards.findIndex((c) => c.id === cardId);
        const insertAt = idx === -1 ? lane.cards.length : idx + 1;
        lane.cards.splice(insertAt, 0, next as Draft<Card>);
      });
    },

    toggleSubtaskDone: (cardId, subtaskId) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        for (const lane of draft.lanes) {
          const card = lane.cards.find((c) => c.id === cardId);
          if (!card) continue;
          const st = card.subtasks.find((s) => s.id === subtaskId);
          if (st) {
            st.done = !st.done;
            return;
          }
        }
      });
    },

    // Alias used by the UI.
    toggleSubtask: (cardId, subtaskId) => {
      // Routes through the same logic; declared separately so the UI
      // can call `store.toggleSubtask(...)` without naming the `Done`
      // suffix.
      applyMutation(set as never, get, onMutate, (draft) => {
        for (const lane of draft.lanes) {
          const card = lane.cards.find((c) => c.id === cardId);
          if (!card) continue;
          const st = card.subtasks.find((s) => s.id === subtaskId);
          if (st) {
            st.done = !st.done;
            return;
          }
        }
      });
    },

    editSubtask: (cardId, subtaskId, text) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        for (const lane of draft.lanes) {
          const card = lane.cards.find((c) => c.id === cardId);
          if (!card) continue;
          const st = card.subtasks.find((s) => s.id === subtaskId);
          if (st) {
            st.text = text;
            return;
          }
        }
      });
    },

    addSubtask: (cardId, text) => {
      const subtask = makeSubtask(text);
      applyMutation(set as never, get, onMutate, (draft) => {
        for (const lane of draft.lanes) {
          const card = lane.cards.find((c) => c.id === cardId);
          if (card) {
            card.subtasks.push(subtask);
            return;
          }
        }
      });
      return subtask.id;
    },

    deleteSubtask: (cardId, subtaskId) => {
      applyMutation(set as never, get, onMutate, (draft) => {
        for (const lane of draft.lanes) {
          const card = lane.cards.find((c) => c.id === cardId);
          if (!card) continue;
          const idx = card.subtasks.findIndex((s) => s.id === subtaskId);
          if (idx !== -1) {
            card.subtasks.splice(idx, 1);
            return;
          }
        }
      });
    },

    // ──────────────────────────────────────────────────────────────
    // Gesture API
    //
    // Architectural decision: drag persistence is gesture-scoped. We
    // emit optimistic moves during the drag (no save, no undo entry),
    // commit ONCE on `onDragEnd`, or revert on cancel.
    //
    // - beginGesture: snapshot pre-drag board for revert.
    // - moveCardOptimistic: apply the move silently (no onMutate).
    // - commitGesture: notify save queue + undo. Single entry per drag.
    // - cancelGesture: restore pre-drag snapshot. No save, no undo entry.
    // ──────────────────────────────────────────────────────────────

    beginGesture: () => {
      gesture = { preBoard: get().board, touched: false };
    },

    moveCardOptimistic: (cardId, toLaneId, toIndex) => {
      if (!gesture) {
        // No open gesture — fall back to a normal moveCard so the call
        // doesn't silently no-op if the UI forgets beginGesture.
        const board = get().board;
        for (const lane of board.lanes) {
          if (lane.cards.some((c) => c.id === cardId)) {
            (get() as BoardStoreState).moveCard(cardId, lane.id, toLaneId, toIndex);
            return;
          }
        }
        return;
      }
      gesture.touched = true;
      applyMutation(
        set as never,
        get,
        onMutate,
        (draft) => {
          for (const lane of draft.lanes) {
            const idx = lane.cards.findIndex((c) => c.id === cardId);
            if (idx === -1) continue;
            const [card] = lane.cards.splice(idx, 1);
            const toLane = draft.lanes.find((l) => l.id === toLaneId);
            if (!toLane) {
              // Restore — destination missing.
              lane.cards.splice(idx, 0, card);
              return;
            }
            const clamped = Math.max(0, Math.min(toIndex, toLane.cards.length));
            toLane.cards.splice(clamped, 0, card);
            return;
          }
        },
        /* silent */ true,
      );
    },

    commitGesture: () => {
      if (!gesture) return;
      const touched = gesture.touched;
      const preBoard = gesture.preBoard;
      gesture = null;
      if (touched) {
        // Single onMutate call at gesture end → save queue schedules
        // exactly one write for the whole drag.
        if (onMutate) onMutate(get().board);
        // Single undo entry — the pre-gesture snapshot.
        if (onGestureCommit) onGestureCommit(preBoard);
      }
    },

    cancelGesture: () => {
      if (!gesture) return;
      const pre = gesture.preBoard;
      gesture = null;
      set((s) => ({ ...s, board: pre }));
      // No onMutate — cancellation does not produce a save.
    },
  })) as UseBoundStore<StoreApi<BoardStoreState>>;

  // Attach selector methods to the store object. These exist alongside
  // Zustand's call-as-hook signature (store(selector, eq)). UI components
  // that prefer `useSyncExternalStore` against `store.subscribe` use
  // these — they read from `store.getState()` so they see the latest
  // snapshot without subscribing themselves.
  const extras: BoardStoreExtras = {
    selectLaneIds: () => store.getState().board.lanes.map((l) => l.id),
    selectLane: (id) => store.getState().board.lanes.find((l) => l.id === id),
    selectCardIds: (laneId) => {
      const lane = store.getState().board.lanes.find((l) => l.id === laneId);
      return lane ? lane.cards.map((c) => c.id) : [];
    },
    selectCard: (id) => {
      for (const lane of store.getState().board.lanes) {
        const card = lane.cards.find((c) => c.id === id);
        if (card) return card;
      }
      return undefined;
    },
    selectMode: () => {
      const s = store.getState();
      return s.modeOverride ?? (s.board.settings['default-view'] as ViewMode) ?? 'board';
    },
    selectBoardMeta: () => {
      const board = store.getState().board;
      // Exclude lanes with empty titles from the visible-lane counter.
      // The "+ Add lane" affordance flushes an untitled lane through addLane
      // before the user has typed a name; counting it in the masthead chip
      // produces a misleading "N+1 lanes" flash and a long-lived discrepancy
      // if the user abandons the gesture. Counting only titled lanes matches
      // what the user actually sees on the board.
      const laneCount = board.lanes.reduce(
        (n, l) => (l.title.trim().length > 0 ? n + 1 : n),
        0,
      );
      let cardCount = 0;
      for (const lane of board.lanes) cardCount += lane.cards.length;
      const title =
        (board.frontmatter['title'] as string | undefined) ?? '';
      return { title, cardCount, laneCount };
    },
    isReadOnly: () => store.getState().readOnly,
  };

  // Action proxies — `store.editCard(...)` etc. resolve to the latest state's
  // action at call time. This matches the Frontend contract (components
  // call store.actionName directly) without requiring callers to thread
  // `getState()` everywhere.
  const actionKeys = [
    'setBoard', 'setMode', 'setReadOnly',
    'moveCard', 'addCard', 'editCard', 'deleteCard',
    'moveLane', 'addLane', 'editLane', 'deleteLane',
    'archiveCard', 'toggleCardDone',
    'toggleSubtaskDone', 'toggleSubtask', 'editSubtask', 'addSubtask', 'deleteSubtask',
    'beginGesture', 'moveCardOptimistic', 'commitGesture', 'cancelGesture',
    'invalidateAllHashes', 'bumpRenderGeneration',
  ] as const;
  const actionProxies: Record<string, (...args: unknown[]) => unknown> = {};
  for (const key of actionKeys) {
    actionProxies[key] = (...args: unknown[]) => {
      const state = store.getState() as unknown as Record<string, (...a: unknown[]) => unknown>;
      return state[key](...args);
    };
  }

  return Object.assign(store, extras, actionProxies) as unknown as BoardStore;
}

// ────────────────────────────────────────────────────────────────────────
// Selector helpers
//
// These return stable refs or arrays of IDs. Use them in components rather
// than reaching into `state.board` directly — that subscription would
// re-render on every mutation.
// ────────────────────────────────────────────────────────────────────────

export const selectLaneIds = (s: BoardStoreState): LaneId[] =>
  s.board.lanes.map((l) => l.id);

export const selectLane =
  (id: LaneId) =>
  (s: BoardStoreState): Lane | undefined =>
    s.board.lanes.find((l) => l.id === id);

export const selectCardIds =
  (laneId: LaneId) =>
  (s: BoardStoreState): CardId[] => {
    const lane = s.board.lanes.find((l) => l.id === laneId);
    return lane ? lane.cards.map((c) => c.id) : [];
  };

export const selectCard =
  (id: CardId) =>
  (s: BoardStoreState): Card | undefined => {
    for (const lane of s.board.lanes) {
      const card = lane.cards.find((c) => c.id === id);
      if (card) return card;
    }
    return undefined;
  };

export const selectReadOnly = (s: BoardStoreState): boolean => s.readOnly;
export const selectErrorMessage = (s: BoardStoreState): string | null =>
  s.errorMessage;

/**
 * Use this when subscribing to an array of IDs — it wraps `useShallow` so
 * the component only re-renders when the array contents differ.
 */
export { useShallow as useShallowIdList };
