/**
 * Lane/card duplication on disk during ordinary editing.
 *
 * Reproduces a regression where adding a card to `## In Progress` via the
 * `+ Add card` affordance and committing the title on blur persisted the
 * new card BUT ALSO duplicated the unrelated `## Backlog` lane and its
 * existing card on disk. The in-memory model showed one lane; the bytes on
 * disk showed two. The same save-queue / serializer layer also governs the
 * settings-block and blank-line-trivia preservation guarantees, and the
 * root cause is shared: patchEmit was reusing source bytes across a region
 * that the model no longer matched.
 *
 * Root cause confirmed in `write.ts`: `gapAfter` blindly trusted the slice
 * from `prev[lane.position.end .. nextRegionStart]` as inter-region
 * trivia, but `lane.position.end` can drift behind the actual logical
 * end of the lane's bytes when:
 *   - the disk source carries stray `- [ ]` empty-card content the parser
 *     dropped on a prior round-trip, or
 *   - a moveLane reorders lanes whose positions still point at their
 *     original source offsets, or
 *   - any future-codepath that mutates structure without re-parsing.
 *
 * Either way, replaying non-trivia bytes back into the disk stream
 * duplicates whatever structural content (a `## ` heading, a card line,
 * a `%% kanban:settings` block) sat inside that window. The fix in
 * `write.ts` rejects non-trivia gap content and falls back to a canonical
 * blank-line separator. Tests below pin the repair.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseBoard, serializeBoard } from '../index';
import { createBoardStore } from '@/core/store';

/**
 * Fresh-board fixture — what `Create new board` emits: three lanes, one
 * card already in Backlog. The card sits in Backlog so that adding a NEW
 * card in In Progress exercises the cross-lane gap-replay path that
 * triggered the duplication.
 */
const FRESH_BOARD =
  '---\n' +
  'kanban-plugin: board\n' +
  '---\n' +
  '\n' +
  '## Backlog\n' +
  '\n' +
  '- [ ] Test card 1\n' +
  '\n' +
  '## In Progress\n' +
  '\n' +
  '## Done\n' +
  '\n' +
  '%% kanban:settings\n' +
  '```\n' +
  '{\n' +
  '  "kanban-plugin": "board"\n' +
  '}\n' +
  '```\n' +
  '%%\n';

describe('no lane/card duplication on disk during ordinary editing', () => {
  it('adding a card to In Progress does not duplicate the Backlog lane on disk', () => {
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');

    const store = createBoardStore({ initialBoard: board });
    const inProgressId = store.getState().board.lanes[1].id;
    expect(store.getState().board.lanes[1].title).toBe('In Progress');

    // Mirror the UI commit-on-blur path: addCard with the typed text.
    store.addCard(inProgressId, 'New card');

    const out = serializeBoard(store.getState().board);

    // Exactly ONE `## Backlog` heading on disk.
    expect((out.match(/^## Backlog$/gm) ?? []).length).toBe(1);
    // The new card landed with its text.
    expect(out).toContain('- [ ] New card');
    // The Test card 1 row is also exactly one — no duplication anywhere.
    expect((out.match(/^- \[ \] Test card 1$/gm) ?? []).length).toBe(1);

    // Re-parse: lane count + card count match the model.
    const reparsed = parseBoard(out).board!;
    expect(reparsed.lanes.length).toBe(3);
    expect(reparsed.lanes[0].title).toBe('Backlog');
    expect(reparsed.lanes[0].cards.length).toBe(1);
    expect(reparsed.lanes[1].title).toBe('In Progress');
    expect(reparsed.lanes[1].cards.length).toBe(1);
    expect(reparsed.lanes[1].cards[0].text).toBe('New card');
    expect(reparsed.lanes[2].title).toBe('Done');
    expect(reparsed.lanes[2].cards.length).toBe(0);
  });

  it('adding a card to Done (last lane) does not duplicate any preceding lane', () => {
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');
    const store = createBoardStore({ initialBoard: board });
    const doneId = store.getState().board.lanes[2].id;
    store.addCard(doneId, 'Done card');

    const out = serializeBoard(store.getState().board);

    expect((out.match(/^## Backlog$/gm) ?? []).length).toBe(1);
    expect((out.match(/^## In Progress$/gm) ?? []).length).toBe(1);
    expect((out.match(/^## Done$/gm) ?? []).length).toBe(1);

    const reparsed = parseBoard(out).board!;
    expect(reparsed.lanes.length).toBe(3);
    expect(reparsed.lanes.map((l) => l.cards.length)).toEqual([1, 0, 1]);
  });

  it('two-step add then edit (empty card persisted first, text on next save) does not corrupt disk', () => {
    // Adjacent near-miss: the first persisted state had `- [ ]` (empty
    // text), the title was filled in on the next save
    // cycle. We exercise that exact two-step flow: addCard with empty
    // text, serialize once, then editCard to set the text, serialize
    // again — neither save should duplicate any lane.
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');
    const store = createBoardStore({ initialBoard: board });
    const inProgressId = store.getState().board.lanes[1].id;

    const newId = store.addCard(inProgressId, '');
    const first = serializeBoard(store.getState().board);
    expect((first.match(/^## Backlog$/gm) ?? []).length).toBe(1);

    store.editCard(newId, { text: 'Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO]' });
    const second = serializeBoard(store.getState().board);

    expect((second.match(/^## Backlog$/gm) ?? []).length).toBe(1);
    expect((second.match(/^- \[ \] Test card 1$/gm) ?? []).length).toBe(1);
    expect(second).toContain('[rrule:: FREQ=WEEKLY;BYDAY=MO]');

    const reparsed = parseBoard(second).board!;
    expect(reparsed.lanes.length).toBe(3);
    expect(reparsed.lanes[0].cards.length).toBe(1);
    expect(reparsed.lanes[1].cards.length).toBe(1);
  });

  it('mid-flight setBoard echo followed by another mutation does not duplicate Backlog', () => {
    // Full disk round-trip:
    //   1. user adds an empty card to In Progress (commit-on-blur typed an empty body)
    //   2. saveQueue flushes serialized text to disk
    //   3. Obsidian's modify event runs setViewData → applyDiskSnapshot →
    //      setBoard(parsed) — `fileTrivia.originalSource` is replaced by the
    //      newly serialized bytes; lane positions are recomputed from the
    //      re-parse.
    //   4. user types the title; editCard fires; saveQueue flushes again.
    //
    // The pre-fix patchEmit logic would, on step 4's emit, reuse the wrong
    // slice from the (now re-parsed) prev source and replay the Backlog
    // lane bytes a second time.
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');
    const store = createBoardStore({ initialBoard: board });
    const inProgressId = store.getState().board.lanes[1].id;

    store.addCard(inProgressId, '');
    const firstSave = serializeBoard(store.getState().board);
    expect((firstSave.match(/^## Backlog$/gm) ?? []).length).toBe(1);

    // Simulate the disk → setBoard echo (host re-parsed the just-saved bytes).
    const reparsed = parseBoard(firstSave).board!;
    store.setBoard(reparsed);

    // Add the real card via the same code path the InlineEditor would have
    // taken once the re-parsed board dropped the empty list item.
    const newInProgress = store.getState().board.lanes.find(
      (l) => l.title === 'In Progress',
    )!;
    store.addCard(newInProgress.id, 'New card');

    const secondSave = serializeBoard(store.getState().board);
    expect((secondSave.match(/^## Backlog$/gm) ?? []).length).toBe(1);
    expect((secondSave.match(/^- \[ \] Test card 1$/gm) ?? []).length).toBe(1);
    expect(secondSave).toContain('- [ ] New card');

    const reparsed2 = parseBoard(secondSave).board!;
    expect(reparsed2.lanes.length).toBe(3);
    expect(reparsed2.lanes[0].cards.length).toBe(1);
    expect(reparsed2.lanes[1].cards.length).toBe(1);
  });

  it('serializing a source with a stray empty list item in In Progress does not duplicate Backlog', () => {
    // Disk shape AFTER an "empty-card" save echo's re-parse drops the empty
    // list item. The parser sees In Progress as 0 cards but its position
    // span includes the stray `- [ ]` bytes. The pre-fix gapAfter could
    // pull those bytes into the inter-lane gap and replay them into a
    // canonical lane render, producing duplication.
    const SRC_WITH_STRAY_EMPTY_CARD =
      '---\n' +
      'kanban-plugin: board\n' +
      '---\n' +
      '\n' +
      '## Backlog\n' +
      '\n' +
      '- [ ] Test card 1\n' +
      '\n' +
      '## In Progress\n' +
      '\n' +
      '- [ ] \n' +
      '\n' +
      '## Done\n' +
      '\n' +
      '%% kanban:settings\n' +
      '```\n' +
      '{\n' +
      '  "kanban-plugin": "board"\n' +
      '}\n' +
      '```\n' +
      '%%\n';
    const { board } = parseBoard(SRC_WITH_STRAY_EMPTY_CARD);
    if (!board) throw new Error('parse failed');
    const store = createBoardStore({ initialBoard: board });
    const inProgressId = store.getState().board.lanes[1].id;
    store.addCard(inProgressId, 'Weekly review');
    const out = serializeBoard(store.getState().board);

    expect((out.match(/^## Backlog$/gm) ?? []).length).toBe(1);
    expect((out.match(/^## In Progress$/gm) ?? []).length).toBe(1);
    expect((out.match(/^## Done$/gm) ?? []).length).toBe(1);
    expect((out.match(/^- \[ \] Test card 1$/gm) ?? []).length).toBe(1);
    expect(out).toContain('- [ ] Weekly review');

    const reparsed = parseBoard(out).board!;
    expect(reparsed.lanes.length).toBe(3);
  });

  it('moveLane reordering does not duplicate lanes via stale-position gap reuse', () => {
    // Structural hypothesis: patchEmit was iterating lanes by
    // source-position rather than model-order, so when a card is added to a
    // lane that's later in the model than its source-position, the prior
    // lane gets re-emitted from its source bytes (creating a duplicate).
    // moveLane is the cleanest exerciser: it makes
    // lane.position-vs-model-index drift maximally.
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');
    const store = createBoardStore({ initialBoard: board });
    const backlogId = store.getState().board.lanes[0].id;
    store.moveLane(backlogId, 2); // Backlog → end

    const out = serializeBoard(store.getState().board);
    expect((out.match(/^## Backlog$/gm) ?? []).length).toBe(1);
    expect((out.match(/^## In Progress$/gm) ?? []).length).toBe(1);
    expect((out.match(/^## Done$/gm) ?? []).length).toBe(1);
    expect((out.match(/^- \[ \] Test card 1$/gm) ?? []).length).toBe(1);
  });

  it('full recurrence flow (addCard → toggle done → spawn) does not duplicate Backlog', () => {
    // The recurrence sequence:
    //   1. addCard(InProgress, 'Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO]')
    //   2. toggleCardDone — mutates the card to done, then synchronously
    //      spawns a successor card in the same lane via the recurrence engine.
    //   3. serialize.
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');
    const store = createBoardStore({
      initialBoard: board,
      getEntitlement: () => true,
    });
    const inProgressId = store.getState().board.lanes[1].id;
    const newId = store.addCard(
      inProgressId,
      'Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO]',
    );
    store.toggleCardDone(newId);

    const out = serializeBoard(store.getState().board);
    expect((out.match(/^## Backlog$/gm) ?? []).length).toBe(1);
    expect((out.match(/^- \[ \] Test card 1$/gm) ?? []).length).toBe(1);
    expect((out.match(/^## In Progress$/gm) ?? []).length).toBe(1);
    expect((out.match(/^## Done$/gm) ?? []).length).toBe(1);
  });

  it('adding a card preserves the settings block', () => {
    // The duplication bug shares a root cause with the settings-block-drop
    // bug. Make sure the settings block isn't dropped on the add-card path.
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');
    const store = createBoardStore({ initialBoard: board });
    const inProgressId = store.getState().board.lanes[1].id;
    store.addCard(inProgressId, 'New card');

    const out = serializeBoard(store.getState().board);
    expect(out).toContain('%% kanban:settings');
    expect(out).toContain('"kanban-plugin": "board"');
  });
});

/**
 * Migration fixture drag round-trip — settings + blank-line envelope.
 *
 * Copies `fixtures/migration-before.md` byte-for-byte into the vault,
 * opens it in KanbanView, and drags one card. The failure shape this pins:
 *
 *   - the `%% kanban:settings` block (carrying `lane-width: 272` and
 *     `show-checkboxes: true`) disappearing from disk after the first save.
 *   - every inter-section blank line (after frontmatter, between lanes,
 *     around the archive break) being collapsed.
 *
 * Both symptoms are write-side artefacts of the same gap-after regression
 * that produced the lane-duplication bug — the gap-after slice for the lane
 * *preceding* the settings block straddled the entire settings block
 * (because the parser doesn't expose it as a "region start" with the
 * legacy form), so the writer dropped it as "structural content" on the
 * unsafe path or, on the previous code, replayed it duplicated.
 *
 * This file pins the exact production sequence against the real on-disk
 * fixture: `parseBoard → createBoardStore({ onMutate: save }) →
 * beginGesture → moveCardOptimistic → commitGesture → serialize`. The
 * save bytes must:
 *
 *   1. preserve the settings block,
 *   2. preserve the inter-section blank lines,
 *   3. round-trip back to a parse with identical settings + lane shape.
 */
const FIXTURE_PATH = path.resolve(__dirname, './fixtures/migration-before.md');
const MIGRATION_BEFORE = fs.readFileSync(FIXTURE_PATH, 'utf8');

describe('migration fixture drag round-trip preserves envelope', () => {
  it('one drag via the gesture API keeps the settings block on disk', () => {
    const { board } = parseBoard(MIGRATION_BEFORE);
    if (!board) throw new Error('parse failed');

    // Mirror KanbanView's session wiring: store has an `onMutate` that
    // serializes via the single-arg API (so `prevSource` comes from
    // `board.fileTrivia.originalSource`). This is the exact production
    // path the save queue takes.
    let saved: string | null = null;
    const store = createBoardStore({
      initialBoard: board,
      onMutate: (b) => {
        saved = serializeBoard(b);
      },
    });

    const state = store.getState();
    const doingId = state.board.lanes.find((l) => l.title === 'Doing')!.id;
    const inboxCardId = state.board.lanes.find((l) => l.title === 'Inbox')!
      .cards[0].id;

    state.beginGesture();
    state.moveCardOptimistic(inboxCardId, doingId, 0);
    state.commitGesture();

    expect(saved).not.toBeNull();
    // Settings sentinel + JSON body must survive.
    expect(saved!).toContain('%% kanban:settings');
    expect(saved!).toContain('"kanban-plugin":"board"');
    expect(saved!).toContain('"lane-width":272');
    expect(saved!).toContain('"show-checkboxes":true');

    // Re-parse the saved bytes and confirm the settings landed in the model.
    const re = parseBoard(saved!).board!;
    expect(re.settings['kanban-plugin']).toBe('board');
    expect(re.settings['lane-width']).toBe(272);
    expect(re.settings['show-checkboxes']).toBe(true);
  });

  it('one drag preserves the inter-section blank-line trivia', () => {
    const { board } = parseBoard(MIGRATION_BEFORE);
    if (!board) throw new Error('parse failed');
    let saved: string | null = null;
    const store = createBoardStore({
      initialBoard: board,
      onMutate: (b) => {
        saved = serializeBoard(b);
      },
    });
    const state = store.getState();
    const doingId = state.board.lanes.find((l) => l.title === 'Doing')!.id;
    const inboxCardId = state.board.lanes.find((l) => l.title === 'Inbox')!
      .cards[0].id;

    state.beginGesture();
    state.moveCardOptimistic(inboxCardId, doingId, 0);
    state.commitGesture();

    expect(saved).not.toBeNull();
    // Blank line between `---` and first lane heading.
    expect(saved!).toMatch(/---\n\n## Inbox/);
    // Blank line between each lane heading and the next.
    expect(saved!).not.toMatch(/\n## Inbox\n## /);
    expect(saved!).not.toMatch(/\n## Doing\n## /);
    expect(saved!).not.toMatch(/\n## Done\n## /);
    // Blank line before the archive break.
    expect(saved!).toMatch(/\n\n\*\*\*\n/);
    // Blank line before the settings sentinel.
    expect(saved!).toMatch(/\n\n%% kanban:settings/);
  });

  it('multi-onDragOver gesture (hover through every lane before commit) preserves envelope', () => {
    // Production DnDProvider fires `moveCardOptimistic` on every
    // `onDragOver` whose target differs from the last. A real drag may
    // hover through several lanes/indexes before the user releases —
    // the gesture API must absorb that stream cleanly and commit ONE
    // save with intact envelope.
    const { board } = parseBoard(MIGRATION_BEFORE);
    if (!board) throw new Error('parse failed');
    let saved: string | null = null;
    let saveCount = 0;
    const store = createBoardStore({
      initialBoard: board,
      onMutate: (b) => {
        saved = serializeBoard(b);
        saveCount += 1;
      },
    });
    const state = store.getState();
    const inboxId = state.board.lanes.find((l) => l.title === 'Inbox')!.id;
    const doingId = state.board.lanes.find((l) => l.title === 'Doing')!.id;
    const doneId = state.board.lanes.find((l) => l.title === 'Done')!.id;
    const archiveId = state.board.lanes.find((l) => l.title === 'Archive')!.id;
    const cardId = state.board.lanes.find((l) => l.title === 'Inbox')!
      .cards[0].id;

    state.beginGesture();
    state.moveCardOptimistic(cardId, inboxId, 1);
    state.moveCardOptimistic(cardId, doingId, 0);
    state.moveCardOptimistic(cardId, doingId, 2);
    state.moveCardOptimistic(cardId, doneId, 0);
    state.moveCardOptimistic(cardId, archiveId, 0);
    state.moveCardOptimistic(cardId, doingId, 1);
    state.commitGesture();

    // Single save at gesture end — optimistic moves are silent.
    expect(saveCount).toBe(1);
    expect(saved).not.toBeNull();
    expect(saved!).toContain('%% kanban:settings');
    expect(saved!).toContain('"lane-width":272');
    expect(saved!).toMatch(/---\n\n## Inbox/);

    const re = parseBoard(saved!).board!;
    expect(re.lanes.length).toBe(4);
    expect(re.lanes.map((l) => l.title)).toEqual([
      'Inbox',
      'Doing',
      'Done',
      'Archive',
    ]);
    expect(re.settings['lane-width']).toBe(272);
  });

  it('drag → write → disk-echo re-parse → second drag (full pipeline) preserves envelope', () => {
    // Simulates the FULL prod loop: save → Obsidian modify event →
    // applyDiskSnapshot → setBoard(reparsed) → user drags again. The
    // second save's `prevSource` is the bytes we just wrote, not the
    // original. Any envelope drift in the first save compounds in the
    // second.
    const { board } = parseBoard(MIGRATION_BEFORE);
    if (!board) throw new Error('parse failed');

    let lastSave = '';
    const store = createBoardStore({
      initialBoard: board,
      onMutate: (b) => {
        lastSave = serializeBoard(b);
      },
    });

    // Drag #1: move Inbox card 0 to Doing top.
    {
      const state = store.getState();
      const doingId = state.board.lanes.find((l) => l.title === 'Doing')!.id;
      const cardId = state.board.lanes.find((l) => l.title === 'Inbox')!
        .cards[0].id;
      state.beginGesture();
      state.moveCardOptimistic(cardId, doingId, 0);
      state.commitGesture();
    }
    expect(lastSave).toContain('%% kanban:settings');

    // Disk-echo: reparse what we just wrote and setBoard.
    const echo1 = parseBoard(lastSave).board!;
    store.getState().setBoard(echo1);

    // Drag #2: move the same (now-in-Doing) card back to Inbox top.
    {
      const state = store.getState();
      const inboxId = state.board.lanes.find((l) => l.title === 'Inbox')!.id;
      const cardId = state.board.lanes.find((l) => l.title === 'Doing')!
        .cards[0].id;
      state.beginGesture();
      state.moveCardOptimistic(cardId, inboxId, 0);
      state.commitGesture();
    }
    expect(lastSave).toContain('%% kanban:settings');
    expect(lastSave).toContain('"lane-width":272');
    expect(lastSave).toMatch(/---\n\n## Inbox/);

    const re = parseBoard(lastSave).board!;
    expect(re.settings['lane-width']).toBe(272);
    expect(re.settings['show-checkboxes']).toBe(true);
    expect(re.lanes.length).toBe(4);
  });
});
