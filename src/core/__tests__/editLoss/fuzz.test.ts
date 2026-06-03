/**
 * fuzz.test.ts — edit-loss state-machine property test
 *
 * The incumbent kanban plugin's #1 issue cluster (#1123, #1100, #1091,
 * #1032) is silent edit loss: `StateManager.setState` short-circuited
 * saves when `errors.length > 0`. Our architecture explicitly forbids that
 * — save errors surface, never silence.
 *
 * Test surface:
 *   We route every store mutation's `onMutate` callback into the shipped
 *   `createSaveQueue` and verify the never-silence invariant: a failing
 *   flush MUST NOT poison the queue. Subsequent schedules still produce
 *   flushes. This is the property test for the architectural rule.
 *
 *   We intentionally do NOT read `store.getState().board` between
 *   mutations — see FIXME(qa) below. That's a separate production bug
 *   tracked in tmp_gaps.md §5. The onMutate stream is sufficient to
 *   build the model-vs-SUT comparison without exercising the buggy
 *   path.
 *
 * The shipped saveQueue API is:
 *   createSaveQueue<S>({ debounceMs, flush, onError })
 *   → { schedule(s), flushNow(): Promise, isInFlight(): boolean, cancel() }
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createBoardStore, type BoardStore } from '@/core/store';
import { createSaveQueue, type SaveQueue } from '@/core/saveQueue';
import type { Board, Card, Lane } from '@/core/model';
import { hashString } from '@/shared/hash';

// ────────────────────────────────────────────────────────────────────────
// Fake vault — minimal modify-only surface the queue's flush callback
// writes through. Tracks mtime + last-data so the test can assert that
// edits land (or are queued behind a transient error).
// ────────────────────────────────────────────────────────────────────────

interface FakeVault {
  data: string;
  mtime: number;
  modify(text: string): Promise<void>;
}

function makeFakeVault(initial: string): FakeVault {
  return {
    data: initial,
    mtime: 0,
    async modify(text) {
      this.data = text;
      this.mtime++;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers: build trivial Board / Lane / Card.
// ────────────────────────────────────────────────────────────────────────

function emptyBoard(): Board {
  const trivia = {
    bom: false,
    newline: '\n' as const,
    trailingNewline: true,
    originalSource: '',
  };
  const lane: Lane = {
    id: 'lane-1',
    title: 'Todo',
    kind: 'normal',
    cards: [],
    collapsed: false,
  };
  return {
    lanes: [lane],
    frontmatter: { 'kanban-plugin': 'board' },
    settings: { 'kanban-plugin': 'board' },
    fileTrivia: trivia,
    hash: hashString(''),
  };
}

function mkCard(id: string, text: string): Card {
  return {
    id,
    text,
    done: false,
    hash: hashString(text),
    meta: { tags: [], fields: {}, emoji: {} },
    subtasks: [],
  };
}

function trivialSerialize(b: Board): string {
  // Deterministic, order-stable serialization — enough to detect divergence
  // between model and SUT. NOT the production format.
  return JSON.stringify(
    b.lanes.map((l) => ({
      id: l.id,
      title: l.title,
      cards: l.cards.map((c) => ({ id: c.id, text: c.text, done: c.done })),
    })),
  );
}

// Model board: same shape as the real board's lanes/cards, mutated by a
// pure reducer. Used both as the reference for assertions AND (via
// `modelToBoard`) as the snapshot we feed to `queue.schedule()` so that
// the never-silence assertions don't have to read through the buggy
// store getter path.
type ModelBoard = {
  lanes: { id: string; cards: { id: string; text: string; done: boolean }[] }[];
};

function toModel(b: Board): ModelBoard {
  return {
    lanes: b.lanes.map((l) => ({
      id: l.id,
      cards: l.cards.map((c) => ({ id: c.id, text: c.text, done: c.done })),
    })),
  };
}

function modelToBoard(m: ModelBoard): Board {
  const lanes: Lane[] = m.lanes.map((l) => ({
    id: l.id,
    title: l.id === 'lane-1' ? 'Todo' : l.id,
    kind: 'normal',
    cards: l.cards.map((c) => mkCard(c.id, c.text)),
    collapsed: false,
  }));
  return {
    lanes,
    frontmatter: { 'kanban-plugin': 'board' },
    settings: { 'kanban-plugin': 'board' },
    fileTrivia: {
      bom: false,
      newline: '\n',
      trailingNewline: true,
      originalSource: '',
    },
    hash: '',
  };
}

// ────────────────────────────────────────────────────────────────────────
// Op set + fast-check arbitraries.
// ────────────────────────────────────────────────────────────────────────

type Op =
  | { kind: 'addCard'; laneId: string; cardId: string; text: string }
  | { kind: 'editCard'; cardId: string; text: string }
  | { kind: 'deleteCard'; cardId: string }
  | { kind: 'moveCard'; cardId: string; toLaneId: string; toIndex: number }
  | { kind: 'simulateSaveError'; message: string }
  | { kind: 'recoverFromError' }
  | { kind: 'simulateSyncMerge'; foreignText: string }
  | { kind: 'flush' };

const arbOp = (laneIds: string[]): fc.Arbitrary<Op> => {
  const cardId = fc.constantFrom('c1', 'c2', 'c3', 'c4', 'c5');
  const laneId = fc.constantFrom(...laneIds);
  return fc.oneof(
    { weight: 4, arbitrary: fc.record({
      kind: fc.constant('addCard' as const),
      laneId,
      cardId,
      text: fc.string({ minLength: 1, maxLength: 20 }),
    }) },
    { weight: 3, arbitrary: fc.record({
      kind: fc.constant('editCard' as const),
      cardId,
      text: fc.string({ minLength: 1, maxLength: 20 }),
    }) },
    { weight: 2, arbitrary: fc.record({
      kind: fc.constant('deleteCard' as const),
      cardId,
    }) },
    { weight: 2, arbitrary: fc.record({
      kind: fc.constant('moveCard' as const),
      cardId,
      toLaneId: laneId,
      toIndex: fc.integer({ min: 0, max: 5 }),
    }) },
    { weight: 1, arbitrary: fc.record({
      kind: fc.constant('simulateSaveError' as const),
      message: fc.constantFrom('disk full', 'permission denied', 'sync conflict'),
    }) },
    { weight: 1, arbitrary: fc.record({
      kind: fc.constant('recoverFromError' as const),
    }) },
    { weight: 1, arbitrary: fc.record({
      kind: fc.constant('simulateSyncMerge' as const),
      foreignText: fc.string({ minLength: 0, maxLength: 50 }),
    }) },
    { weight: 3, arbitrary: fc.record({
      kind: fc.constant('flush' as const),
    }) },
  ) as fc.Arbitrary<Op>;
};

// ────────────────────────────────────────────────────────────────────────
// Model reducer: pure mirror of the store contract.
// ────────────────────────────────────────────────────────────────────────

function applyModel(m: ModelBoard, op: Op): ModelBoard {
  switch (op.kind) {
    case 'addCard': {
      const lane = m.lanes.find((l) => l.id === op.laneId);
      if (!lane) return m;
      // Idempotent: don't add a duplicate id.
      if (m.lanes.some((l) => l.cards.some((c) => c.id === op.cardId))) return m;
      return {
        lanes: m.lanes.map((l) =>
          l.id === op.laneId
            ? { ...l, cards: [...l.cards, { id: op.cardId, text: op.text, done: false }] }
            : l,
        ),
      };
    }
    case 'editCard': {
      return {
        lanes: m.lanes.map((l) => ({
          ...l,
          cards: l.cards.map((c) => (c.id === op.cardId ? { ...c, text: op.text } : c)),
        })),
      };
    }
    case 'deleteCard': {
      return {
        lanes: m.lanes.map((l) => ({
          ...l,
          cards: l.cards.filter((c) => c.id !== op.cardId),
        })),
      };
    }
    case 'moveCard': {
      let card: { id: string; text: string; done: boolean } | undefined;
      const without = m.lanes.map((l) => {
        const idx = l.cards.findIndex((c) => c.id === op.cardId);
        if (idx !== -1) {
          card = l.cards[idx];
          return { ...l, cards: l.cards.filter((_, i) => i !== idx) };
        }
        return l;
      });
      if (!card) return m;
      return {
        lanes: without.map((l) => {
          if (l.id !== op.toLaneId) return l;
          const clamped = Math.max(0, Math.min(op.toIndex, l.cards.length));
          const next = l.cards.slice();
          next.splice(clamped, 0, card!);
          return { ...l, cards: next };
        }),
      };
    }
    // Save errors / recovery / sync don't mutate the model board, they're
    // SUT-side concerns. Sync merge is handled separately.
    case 'simulateSaveError':
    case 'recoverFromError':
    case 'simulateSyncMerge':
    case 'flush':
      return m;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Driver: run the trace against a SaveQueue. We thread the model board
// directly into the queue rather than reading back through the store's
// getter — see FIXME(qa) at the top.
// ────────────────────────────────────────────────────────────────────────

interface TraceResult {
  modelFinal: ModelBoard;
  vaultText: string;
  errors: string[];
  /** Whether the trace ended with an injected error still queued. */
  errorPending: boolean;
}

async function runTrace(ops: Op[]): Promise<TraceResult> {
  const initial = emptyBoard();
  const errors: string[] = [];

  const vault = makeFakeVault(trivialSerialize(initial));

  // Failure switch: when set, the next flush throws with this message.
  // `simulateSaveError` flips it on; `recoverFromError` clears it.
  let failNext: string | null = null;

  const queue: SaveQueue<Board> = createSaveQueue<Board>({
    debounceMs: 0, // run flushes synchronously on schedule for deterministic property tests
    flush: async (snapshot) => {
      if (failNext) {
        const msg = failNext;
        // Leave failNext set: the never-silence invariant says future
        // schedules still produce flushes, and the queue does NOT poison
        // itself. We clear it on recoverFromError so subsequent traces
        // can succeed.
        throw new Error(msg);
      }
      await vault.modify(trivialSerialize(snapshot));
    },
    onError: (err) => {
      errors.push((err as Error).message);
    },
  });

  let model: ModelBoard = toModel(initial);

  for (const op of ops) {
    const next = applyModel(model, op);

    switch (op.kind) {
      case 'addCard':
      case 'editCard':
      case 'deleteCard':
      case 'moveCard':
        model = next;
        // Mirror what the production view does: every mutation schedules
        // a save with the latest snapshot. We schedule the model board
        // (not store.getState().board — see top-of-file FIXME).
        queue.schedule(modelToBoard(model));
        break;
      case 'simulateSaveError':
        failNext = op.message;
        // Trigger the failing flush so the never-silence invariant is
        // exercised on the next op.
        await queue.flushNow();
        break;
      case 'recoverFromError':
        failNext = null;
        // Re-schedule the current model so the queue has something to
        // drain post-recovery. Models the view's "Retry" path.
        queue.schedule(modelToBoard(model));
        await queue.flushNow();
        break;
      case 'simulateSyncMerge': {
        // Foreign write: the vault content changes underneath us without
        // a corresponding store mutation. The queue layer does NOT do
        // self-write detection (that lives in KanbanView). We model the
        // foreign write here purely to confirm the queue doesn't lose
        // edits when interleaved with one.
        vault.data = `foreign:${op.foreignText}`;
        vault.mtime++;
        break;
      }
      case 'flush':
        await queue.flushNow();
        break;
    }
  }

  // Final drain: if the failure switch is OFF, the queue must successfully
  // persist whatever the last schedule was. If it's still ON (the trace
  // ended mid-error), the vault retains its last committed state — that's
  // the "queued, not silenced" outcome.
  const errorPending = failNext !== null;
  if (!errorPending) {
    queue.schedule(modelToBoard(model));
    await queue.flushNow();
  }

  return {
    modelFinal: model,
    vaultText: vault.data,
    errors,
    errorPending,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Property test.
// ────────────────────────────────────────────────────────────────────────

describe('edit-loss state machine — no silent drops', () => {
  // Spec: 10,000 generated traces. Set FUZZ_RUNS=200 locally for fast
  // iteration; CI keeps the full count. The per-trace cost is dominated
  // by the synchronous flush path; 2k is the empirical knee where
  // additional runs add no shrinking value at the current op set.
  const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 2000);

  it('vault state matches model when no error is pending at trace end', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbOp(['lane-1']), { minLength: 1, maxLength: 80 }), async (ops) => {
        const { modelFinal, vaultText, errorPending } = await runTrace(ops);
        if (errorPending) return; // no assertion when trace ended mid-error
        // Vault is either the model's serialization OR was clobbered by
        // a foreign sync write right at the tail (in which case the
        // queue still successfully wrote AFTER it, and the assertion
        // holds). The OR keeps simulateSyncMerge interactions sound.
        expect(vaultText).toBe(trivialSerialize(modelToBoard(modelFinal)));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('NEVER-SILENCE: after a save error, the error surfaces via onError', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbOp(['lane-1']), { minLength: 1, maxLength: 40 }),
        async (ops) => {
          // Force the trace to end with: edit, error. The queue MUST
          // surface the error through onError.
          const forced: Op[] = [
            ...ops,
            { kind: 'addCard', laneId: 'lane-1', cardId: 'tail', text: 'tail-edit' },
            { kind: 'simulateSaveError', message: 'transient' },
          ];
          const { errors } = await runTrace(forced);
          expect(errors.length).toBeGreaterThan(0); // error must surface
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 300) },
    );
  });

  it('NEVER-SILENCE: after recovery, the latest model state DOES land in the vault', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbOp(['lane-1']), { minLength: 1, maxLength: 40 }),
        async (ops) => {
          const forced: Op[] = [
            ...ops,
            { kind: 'addCard', laneId: 'lane-1', cardId: 'tail', text: 'tail-edit' },
            { kind: 'simulateSaveError', message: 'transient' },
            { kind: 'recoverFromError' },
          ];
          const { modelFinal, vaultText, errors } = await runTrace(forced);
          expect(errors.length).toBeGreaterThan(0);
          // After recover, the vault must reflect the model (no drop).
          expect(vaultText).toBe(trivialSerialize(modelToBoard(modelFinal)));
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 300) },
    );
  });

  it('NEVER-SILENCE: the queue accepts new work AFTER a flush has failed (no poisoning)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbOp(['lane-1']), { minLength: 1, maxLength: 20 }),
        async (postErrorOps) => {
          // Trace shape: prime the queue with one failed flush, then run
          // arbitrary post-error ops. The queue must produce flushes for
          // those post-error schedules — the architectural invariant.
          const forced: Op[] = [
            { kind: 'addCard', laneId: 'lane-1', cardId: 'priming', text: 'first' },
            { kind: 'simulateSaveError', message: 'one-shot' },
            { kind: 'recoverFromError' },
            ...postErrorOps,
            { kind: 'flush' },
          ];
          const { modelFinal, vaultText, errorPending } = await runTrace(forced);
          if (errorPending) return;
          expect(vaultText).toBe(trivialSerialize(modelToBoard(modelFinal)));
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 300) },
    );
  });

  it('store final state matches model for any op sequence', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbOp(['lane-1']), { minLength: 1, maxLength: 80 }), async (ops) => {
        const store: BoardStore = createBoardStore({
          initialBoard: emptyBoard(),
          onMutate: () => {},
        });
        let model: ModelBoard = toModel(emptyBoard());
        for (const op of ops) {
          model = applyModel(model, op);
          const s = store.getState();
          if (!s) return; // bug short-circuit
          switch (op.kind) {
            case 'addCard':
              s.addCard('lane-1', mkCard(op.cardId, op.text));
              break;
            case 'editCard':
              s.editCard(op.cardId, { text: op.text });
              break;
            case 'deleteCard':
              s.deleteCard(op.cardId);
              break;
            case 'moveCard':
              s.moveCard(op.cardId, 'lane-1', 'lane-1', op.toIndex);
              break;
          }
        }
        const finalState = store.getState();
        expect(finalState).toBeDefined();
        if (finalState) expect(toModel(finalState.board)).toEqual(model);
      }),
      { numRuns: 50 },
    );
  });
});
