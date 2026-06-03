/**
 * KanbanView.undo.test.tsx — undo/redo coverage.
 *
 * Regression: after `Cmd+Z` the board's model rolled back but the UI
 * continued to show the post-mutation state. The cause was (a) the
 * serializer's byte-identity short-circuit reading
 * stale `card.hash` values and (b) `useStoreSelector`'s structural-equality
 * cache treating the restored card slice as "the same" because its top-
 * level shape was unchanged.
 *
 * The fix layers two defenses:
 *   1. `invalidateAllHashes` clears every `card.hash` and `board.hash` on
 *      the restored snapshot so the serializer must emit fresh bytes.
 *   2. `bumpRenderGeneration` increments a counter that the BoardView
 *      threads into each Card's React key, forcing a remount.
 *
 * These tests pin the contract for both undo AND redo (redo had the same
 * defect).
 *
 * We mount KanbanView through its real lifecycle so the BoardRoot React
 * tree is live — that's the only way to test the rendered output, not just
 * the store state.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { App, TFile, Vault, MetadataCache, Workspace, WorkspaceLeaf } from 'obsidian';
import { KanbanView } from '@/view/KanbanView';

function makeApp(initialText: string): App {
  const vault = new Vault();
  vault.read = vi.fn(async (_f: TFile) => initialText) as Vault['read'];
  vault.on = vi.fn(() => ({})) as unknown as Vault['on'];
  const app = new App();
  (app as unknown as { vault: Vault }).vault = vault;
  (app as unknown as { workspace: Workspace }).workspace = new Workspace();
  (app as unknown as { metadataCache: MetadataCache }).metadataCache = new MetadataCache();
  return app;
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

// Two-lane board so we can move a card between them and assert lane membership.
const BOARD_SRC = [
  '---',
  'kanban-plugin: board',
  '---',
  '',
  '## Inbox',
  '',
  '- [ ] Alpha',
  '',
  '## Done',
  '',
].join('\n');

describe('KanbanView — undo/redo invalidate render generation', () => {
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

  async function bootView(): Promise<KanbanView> {
    const file = makeFile('Board.md', 1_000);
    const app = makeApp(BOARD_SRC);
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

  function findCardByText(view: KanbanView, text: string): { laneId: string; cardId: string } | null {
    const store = view.getStore();
    if (!store) return null;
    const board = store.getState().board;
    for (const lane of board.lanes) {
      const card = lane.cards.find((c) => c.text.includes(text));
      if (card) return { laneId: lane.id, cardId: card.id };
    }
    return null;
  }

  it('undo restores the pre-mutation model and bumps renderGeneration', async () => {
    view = await bootView();
    const store = view.getStore();
    expect(store).toBeTruthy();

    const initialGen = store!.getState().renderGeneration;
    const target = findCardByText(view, 'Alpha');
    expect(target).toBeTruthy();
    const inbox = store!.getState().board.lanes.find((l) => l.title === 'Inbox');
    const done = store!.getState().board.lanes.find((l) => l.title === 'Done');
    expect(inbox).toBeTruthy();
    expect(done).toBeTruthy();

    // Snapshot pre-mutation card placement.
    const preInboxCardCount = inbox!.cards.length;
    const preDoneCardCount = done!.cards.length;
    expect(preInboxCardCount).toBe(1);
    expect(preDoneCardCount).toBe(0);

    // Mutate inside a committed gesture so the undo stack picks it up.
    // The store's `commitGesture` pushes the PRE-gesture board onto the
    // undo stack — matching how the real drag pipeline works.
    await act(async () => {
      store!.beginGesture();
      store!.moveCardOptimistic(target!.cardId, done!.id, 0);
      store!.commitGesture();
    });

    // Post-mutation: Alpha is in Done.
    const postInbox = store!.getState().board.lanes.find((l) => l.title === 'Inbox');
    const postDone = store!.getState().board.lanes.find((l) => l.title === 'Done');
    expect(postInbox!.cards.length).toBe(0);
    expect(postDone!.cards.length).toBe(1);
    expect(postDone!.cards[0].text).toContain('Alpha');

    // Undo.
    let undid = false;
    await act(async () => {
      undid = view!.undo();
    });
    expect(undid).toBe(true);

    // Pre-mutation state restored — Alpha back in Inbox.
    const restoredInbox = store!.getState().board.lanes.find((l) => l.title === 'Inbox');
    const restoredDone = store!.getState().board.lanes.find((l) => l.title === 'Done');
    expect(restoredInbox!.cards.length).toBe(preInboxCardCount);
    expect(restoredDone!.cards.length).toBe(preDoneCardCount);
    expect(restoredInbox!.cards[0].text).toContain('Alpha');

    // renderGeneration bumped so React subtrees keyed off it remount.
    expect(store!.getState().renderGeneration).toBeGreaterThan(initialGen);

    // Card hashes cleared so the serializer's byte-identity short-circuit
    // can't return stale source for the restored board.
    for (const lane of store!.getState().board.lanes) {
      for (const card of lane.cards) {
        expect(card.hash).toBe('');
      }
    }
    expect(store!.getState().board.hash).toBe('');
  });

  it('redo re-applies the future entry and bumps renderGeneration', async () => {
    view = await bootView();
    const store = view.getStore();
    expect(store).toBeTruthy();

    const target = findCardByText(view, 'Alpha');
    expect(target).toBeTruthy();
    const inbox = store!.getState().board.lanes.find((l) => l.title === 'Inbox')!;
    const done = store!.getState().board.lanes.find((l) => l.title === 'Done')!;

    // Mutate → undo → set up the redo stack.
    await act(async () => {
      store!.beginGesture();
      store!.moveCardOptimistic(target!.cardId, done.id, 0);
      store!.commitGesture();
    });
    await act(async () => {
      view!.undo();
    });

    // After undo the card is back in Inbox.
    expect(
      store!.getState().board.lanes.find((l) => l.title === 'Inbox')!.cards.length,
    ).toBe(1);

    const genAfterUndo = store!.getState().renderGeneration;

    // Redo — the move re-applies, Alpha lands back in Done.
    let redid = false;
    await act(async () => {
      redid = view!.redo();
    });
    expect(redid).toBe(true);

    const postInbox = store!.getState().board.lanes.find((l) => l.title === 'Inbox')!;
    const postDone = store!.getState().board.lanes.find((l) => l.title === 'Done')!;
    expect(postInbox.cards.length).toBe(0);
    expect(postDone.cards.length).toBe(1);
    expect(postDone.cards[0].text).toContain('Alpha');

    // renderGeneration bumped again on redo. Redo had the same defect as
    // undo — both must invalidate.
    expect(store!.getState().renderGeneration).toBeGreaterThan(genAfterUndo);

    // Card hashes cleared on the post-redo board too.
    for (const lane of store!.getState().board.lanes) {
      for (const card of lane.cards) {
        expect(card.hash).toBe('');
      }
    }
    expect(store!.getState().board.hash).toBe('');
  });

  it('undo with empty stack returns false and does NOT bump renderGeneration', async () => {
    view = await bootView();
    const store = view.getStore();
    expect(store).toBeTruthy();
    const initialGen = store!.getState().renderGeneration;
    const result = view.undo();
    expect(result).toBe(false);
    expect(store!.getState().renderGeneration).toBe(initialGen);
  });
});
