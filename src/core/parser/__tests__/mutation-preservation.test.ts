/**
 * Mutation-preservation regression tests.
 *
 * The parser/serializer must preserve the settings block, unknown inline
 * fields, and blank-line trivia across mutations. Each test below pins one
 * of those guarantees so the same break cannot regress.
 */
import { describe, it, expect } from 'vitest';
import { produce } from 'immer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseBoard, serializeBoard, findSentinels, renderSettingsBlock } from '../index';
import { createBoardStore } from '@/core/store';
import type { Board } from '@/core/model';

const NL = '\n';

/* -------------------------------------------------------------- */
/* settings block dropped on save                                 */
/* -------------------------------------------------------------- */

describe('settings block survives mutation + serialize', () => {
  // A board with frontmatter, normal + complete + archive lanes, and a
  // settings block at the trailing edge with both known and unknown
  // keys (mgmeyers-style `show-checkboxes`). The settings block uses the
  // *current* single-comment form which is what `mgmeyers/obsidian-kanban`
  // v1.4+ writes — the parser regex was previously anchored to the legacy
  // `%% kanban:settings %%` form and silently dropped the block.
  const SRC_NEW_FORM =
    '---\n' +
    'kanban-plugin: board\n' +
    '---\n' +
    '\n' +
    '## Inbox\n' +
    '\n' +
    '- [ ] Take out the trash\n' +
    '\n' +
    '## Done\n' +
    '\n' +
    '- [x] Wrote tests\n' +
    '\n' +
    '%% kanban:settings\n' +
    '```\n' +
    '{\n' +
    '  "kanban-plugin": "board",\n' +
    '  "lane-width": 272,\n' +
    '  "show-checkboxes": true\n' +
    '}\n' +
    '```\n' +
    '%%\n';

  const SRC_LEGACY_FORM =
    '---\n' +
    'kanban-plugin: board\n' +
    '---\n' +
    '\n' +
    '## Inbox\n' +
    '\n' +
    '- [ ] Take out the trash\n' +
    '\n' +
    '%% kanban:settings %%\n' +
    '```\n' +
    '{\n' +
    '  "kanban-plugin": "board",\n' +
    '  "lane-width": 272\n' +
    '}\n' +
    '```\n' +
    '%%\n';

  it('settings sentinel matches the single-comment form', () => {
    const s = findSentinels(SRC_NEW_FORM);
    expect(s.settings).not.toBeNull();
    expect(s.settings?.json).toContain('show-checkboxes');
  });

  it('settings sentinel still matches the legacy %% kanban:settings %% form', () => {
    const s = findSentinels(SRC_LEGACY_FORM);
    expect(s.settings).not.toBeNull();
    expect(s.settings?.json).toContain('lane-width');
  });

  it('parseBoard surfaces every settings key from both forms', () => {
    const a = parseBoard(SRC_NEW_FORM).board!;
    expect(a.settings['lane-width']).toBe(272);
    expect(a.settings['show-checkboxes']).toBe(true);

    const b = parseBoard(SRC_LEGACY_FORM).board!;
    expect(b.settings['lane-width']).toBe(272);
  });

  it('mutating a card via immer then serializing keeps the settings block (new form)', () => {
    const { board } = parseBoard(SRC_NEW_FORM);
    if (!board) throw new Error('parse failed');

    // Emulate a store mutation: drag a card to another lane, hash invalidated.
    const mutated = produce(board, (draft) => {
      draft.lanes[0].cards[0].text = 'Take out the trash AND the recycling';
      draft.lanes[0].cards[0].hash = '';
      draft.hash = '';
    });

    const out = serializeBoard(mutated, SRC_NEW_FORM);
    expect(out).toContain('%% kanban:settings');
    expect(out).toContain('"lane-width": 272');
    expect(out).toContain('"show-checkboxes": true');

    // Round-trip the mutated source: the settings parse-back must equal
    // the model settings byte-for-byte semantically.
    const reparsed = parseBoard(out).board!;
    expect(reparsed.settings['lane-width']).toBe(272);
    expect(reparsed.settings['show-checkboxes']).toBe(true);
    expect(reparsed.settings['kanban-plugin']).toBe('board');
  });

  it('mutating a card against the legacy block migrates it to canonical form', () => {
    // The legacy `%% kanban:settings %%` inline-closer form leaves the
    // fenced JSON visible in source mode. The first mutation
    // re-renders the settings block via `renderSettingsBlock` (modern form),
    // canonicalising the file. The settings values themselves must survive
    // unchanged.
    const { board } = parseBoard(SRC_LEGACY_FORM);
    if (!board) throw new Error('parse failed');
    const mutated = produce(board, (draft) => {
      draft.lanes[0].cards[0].text = 'Take out the trash AND the recycling';
      draft.lanes[0].cards[0].hash = '';
      draft.hash = '';
    });
    const out = serializeBoard(mutated, SRC_LEGACY_FORM);
    // Canonical opening (no inline closer on the same line).
    expect(out).toContain('%% kanban:settings\n```\n');
    expect(out).not.toContain('%% kanban:settings %%');
    expect(out).toContain('"lane-width": 272');
    // Round-trip parse to confirm the settings survived.
    expect(parseBoard(out).board?.settings['lane-width']).toBe(272);
  });
});

/* -------------------------------------------------------------- */
/* `[rrule:: ...]` and other unknown inline fields preserved      */
/* -------------------------------------------------------------- */

describe('unknown [k:: v] inline fields survive write-back', () => {
  // The store's `makeCard` builds a fresh Card with empty `meta.fields`
  // even when the card text was typed with `[rrule:: ...]`. The first
  // save (checkbox toggle, lane drag, anything that invalidates hash)
  // forces `canonicalCard` which used to strip every field token whose
  // key wasn't already in the model. This regression test simulates that
  // exact path: a freshly-typed card with empty meta, mutated, serialized.
  function freshCardBoard(cardText: string): Board {
    const src =
      '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] placeholder\n';
    const { board } = parseBoard(src);
    if (!board) throw new Error('parse failed');
    return produce(board, (draft) => {
      draft.lanes[0].cards.push({
        id: 'fresh-1',
        text: cardText,
        done: false,
        hash: '',
        meta: { tags: [], fields: {}, emoji: {} },
        subtasks: [],
      });
      draft.hash = '';
    });
  }

  it('preserves [rrule:: ...] when the card is mutated with empty model meta', () => {
    const board = freshCardBoard('Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO]');
    const out = serializeBoard(board);
    expect(out).toContain('[rrule:: FREQ=WEEKLY;BYDAY=MO]');
    expect(out).toContain('Weekly review');
  });

  it('preserves [priority:: high] and other Dataview fields under the same path', () => {
    const board = freshCardBoard('Ship it [priority:: high] [estimate:: 2h] [custom-key:: xyz]');
    const out = serializeBoard(board);
    expect(out).toContain('[priority:: high]');
    expect(out).toContain('[estimate:: 2h]');
    expect(out).toContain('[custom-key:: xyz]');
  });

  it('still applies a DetailPanel-style assignee set (existing semantic unbroken)', () => {
    // This is the existing semantic that must survive the new merge logic:
    // model has assignee set, text doesn't — assignee must be appended.
    const src =
      '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] Write outline\n';
    const { board } = parseBoard(src);
    if (!board) throw new Error('parse failed');
    const mutated = produce(board, (draft) => {
      draft.lanes[0].cards[0].meta.fields = { assignee: 'alex' };
      draft.lanes[0].cards[0].hash = '';
      draft.hash = '';
    });
    const out = serializeBoard(mutated, src);
    expect(out).toContain('[assignee:: alex]');
  });

  it('rrule + assignee coexist when one is set by the model and the other only in text', () => {
    const src =
      '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] Weekly review [rrule:: FREQ=WEEKLY;BYDAY=MO]\n';
    const { board } = parseBoard(src);
    if (!board) throw new Error('parse failed');
    // The store would populate meta.fields = { rrule: '...' } from parseBoard
    // already, so this case represents *additional* model-only edits.
    const mutated = produce(board, (draft) => {
      const c = draft.lanes[0].cards[0];
      c.meta.fields = { ...c.meta.fields, assignee: 'alex' };
      c.hash = '';
      draft.hash = '';
    });
    const out = serializeBoard(mutated, src);
    expect(out).toContain('[rrule:: FREQ=WEEKLY;BYDAY=MO]');
    expect(out).toContain('[assignee:: alex]');
  });
});

/* -------------------------------------------------------------- */
/* inter-section blank-line trivia preserved                      */
/* -------------------------------------------------------------- */

describe('inter-section blank-line trivia preserved across mutation', () => {
  it('keeps irregular blank-line spacing through a mutate-then-serialize cycle', () => {
    // Two blank lines between frontmatter and first lane, one blank line
    // between the modified lane's last card and the next lane, three blank
    // lines before the settings block.
    const src =
      '---\n' +
      'kanban-plugin: board\n' +
      '---\n' +
      '\n' +
      '\n' +
      '## Inbox\n' +
      '\n' +
      '- [ ] Card A\n' +
      '\n' +
      '## Doing\n' +
      '\n' +
      '- [ ] Card B\n' +
      '\n' +
      '\n' +
      '\n' +
      '%% kanban:settings\n' +
      '```\n' +
      '{\n' +
      '  "kanban-plugin": "board"\n' +
      '}\n' +
      '```\n' +
      '%%\n';
    const { board } = parseBoard(src);
    if (!board) throw new Error('parse failed');
    const mutated = produce(board, (draft) => {
      draft.lanes[0].cards[0].text = 'Card A — edited';
      draft.lanes[0].cards[0].hash = '';
      draft.hash = '';
    });
    const out = serializeBoard(mutated, src);

    // Two blank lines between frontmatter and first lane.
    expect(out).toContain('---' + NL + NL + NL + '## Inbox');
    // Blank line between the modified lane's last card and the next lane.
    expect(out).toContain('Card A — edited' + NL + NL + '## Doing');
    // Three blank lines before the settings block.
    expect(out).toContain('Card B' + NL + NL + NL + NL + '%% kanban:settings');
  });

  it('preserves blank line between frontmatter and first lane across mutation', () => {
    const src =
      '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] A\n';
    const { board } = parseBoard(src);
    if (!board) throw new Error('parse failed');
    const mutated = produce(board, (draft) => {
      draft.lanes[0].cards[0].text = 'A edited';
      draft.lanes[0].cards[0].hash = '';
      draft.hash = '';
    });
    const out = serializeBoard(mutated, src);
    expect(out).toContain('---\n\n## To Do');
  });
});

/* -------------------------------------------------------------- */
/* renderSettingsBlock uses single-comment form                   */
/* -------------------------------------------------------------- */

describe('renderSettingsBlock cosmetic: single-comment form', () => {
  it('emits an opening %% on its own line (no inline closer)', () => {
    const out = renderSettingsBlock({ 'kanban-plugin': 'board', 'lane-width': 272 });
    const lines = out.split('\n');
    // Opening line must be exactly `%% kanban:settings` — no inline `%%`.
    expect(lines[0]).toBe('%% kanban:settings');
    // Closing line is the single `%%` at the end.
    expect(lines[lines.length - 2]).toBe('%%');
    // The JSON body sits inside a fenced block so Obsidian still pretty-
    // prints it in source mode.
    expect(out).toContain('```');
    expect(out).toContain('"lane-width": 272');
  });

  it('re-parses to exactly the input settings (round-trip)', () => {
    const settings = {
      'kanban-plugin': 'board',
      'lane-width': 272,
      'show-checkboxes': true,
      'custom-forward-key': 'preserved',
    };
    const block = renderSettingsBlock(settings);
    // Wrap the block in a minimal board so `parseBoard` will find it.
    const src =
      '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] A\n\n' + block;
    const reparsed = parseBoard(src).board;
    expect(reparsed).not.toBeNull();
    expect(reparsed?.settings['lane-width']).toBe(272);
    expect(reparsed?.settings['show-checkboxes']).toBe(true);
    expect(reparsed?.settings['custom-forward-key']).toBe('preserved');
  });
});

/* -------------------------------------------------------------- */
/* drag-card via the real store against the migration fixture     */
/*                                                                 */
/* Reproduces the "settings block dropped on save" failure using  */
/* the real store + gesture API (the drag path).                  */
/* -------------------------------------------------------------- */

describe('drag-card against the migration fixture preserves settings byte-for-byte', () => {
  const fixturePath = path.resolve(
    __dirname,
    './fixtures/migration-before.md',
  );

  it('preserves settings block + parses settings deep-equal to original (raw moveCard)', () => {
    const src = fs.readFileSync(fixturePath, 'utf-8');
    const parseResult = parseBoard(src);
    const initialBoard = parseResult.board;
    expect(initialBoard).not.toBeNull();
    if (!initialBoard) return;

    const originalSettings = { ...initialBoard.settings };
    expect(Object.keys(originalSettings).length).toBeGreaterThan(0);

    // Real store, real moveCard — the drag path.
    const store = createBoardStore({ initialBoard });
    const fromLaneId = initialBoard.lanes[0].id; // Inbox
    const toLaneId = initialBoard.lanes[1].id; // Doing
    const cardId = initialBoard.lanes[0].cards[0].id;

    store.moveCard(cardId, fromLaneId, toLaneId, 0);

    const mutated = store.getState().board;
    const out = serializeBoard(mutated, src);

    expect(out).toContain('%% kanban:settings');
    expect(out).toContain('"lane-width":272');
    expect(out).toContain('"show-checkboxes":true');

    const reparsed = parseBoard(out).board;
    expect(reparsed).not.toBeNull();
    expect(reparsed?.settings).toEqual(originalSettings);
  });

  it('synthetic legacy inline-closer form migrates to canonical on mutation', () => {
    // Read the format flag on the sentinel directly.
    const legacySrc =
      '---\nkanban-plugin: board\n---\n\n' +
      '## To Do\n\n- [ ] A\n\n' +
      '%% kanban:settings %%\n```\n{\n  "kanban-plugin": "board",\n  "lane-width": 272\n}\n```\n%%\n';
    const sentinels = findSentinels(legacySrc);
    expect(sentinels.settings?.format).toBe('legacy-inline-closer');

    const { board } = parseBoard(legacySrc);
    if (!board) throw new Error('parse failed');
    const mutated = produce(board, (draft) => {
      draft.lanes[0].cards[0].text = 'A edited';
      draft.lanes[0].cards[0].hash = '';
      draft.hash = '';
    });
    const out = serializeBoard(mutated, legacySrc);
    expect(out).toContain('%% kanban:settings\n');
    expect(out).not.toContain('%% kanban:settings %%');
    expect(parseBoard(out).board?.settings['lane-width']).toBe(272);
  });

  it('modern form still byte-reuses the original settings block', () => {
    const modernSrc =
      '---\nkanban-plugin: board\n---\n\n' +
      '## To Do\n\n- [ ] A\n\n' +
      '%% kanban:settings\n```\n{\n  "kanban-plugin": "board",\n  "lane-width": 272\n}\n```\n%%\n';
    const sentinels = findSentinels(modernSrc);
    expect(sentinels.settings?.format).toBe('modern');

    const { board } = parseBoard(modernSrc);
    if (!board) throw new Error('parse failed');
    const mutated = produce(board, (draft) => {
      draft.lanes[0].cards[0].text = 'A edited';
      draft.lanes[0].cards[0].hash = '';
      draft.hash = '';
    });
    const out = serializeBoard(mutated, modernSrc);
    // Raw block reused.
    expect(out).toContain('%% kanban:settings\n```\n{\n  "kanban-plugin": "board",\n  "lane-width": 272\n}\n```\n%%\n');
  });

  it('preserves settings block via the gesture path (beginGesture → moveCardOptimistic → commitGesture)', () => {
    const src = fs.readFileSync(fixturePath, 'utf-8');
    const parseResult = parseBoard(src);
    const initialBoard = parseResult.board;
    expect(initialBoard).not.toBeNull();
    if (!initialBoard) return;

    const originalSettings = { ...initialBoard.settings };

    const store = createBoardStore({ initialBoard });
    const toLaneId = initialBoard.lanes[1].id; // Doing
    const cardId = initialBoard.lanes[0].cards[0].id;

    store.beginGesture();
    store.moveCardOptimistic(cardId, toLaneId, 0);
    store.commitGesture();

    const mutated = store.getState().board;
    const out = serializeBoard(mutated, src);

    expect(out).toContain('%% kanban:settings');
    const reparsed = parseBoard(out).board;
    expect(reparsed?.settings).toEqual(originalSettings);
  });
});

/* -------------------------------------------------------------- */
/* fresh-board blank-line trivia preserved on add-lane            */
/*                                                                 */
/* A freshly created board emits one blank line between each lane */
/* heading (matching `createNewBoard` in main.ts and what users   */
/* see on disk after "Create new board"). After adding a new lane */
/* and committing, the file would collapse to NO blank line after */
/* frontmatter and TWO blank lines between every other lane. The  */
/* serializer was duplicating the `renderLane` trailing           */
/* newline-pair with the `gapAfter` inter-lane gap, because       */
/* `renderLane` unconditionally emits a blank line after the      */
/* `## Title` heading even when the lane has no cards — and an     */
/* empty lane's mdast position.end lands right after the heading, */
/* so the gap then re-emits the original blank line *on top of*   */
/* the one renderLane just wrote.                                 */
/* -------------------------------------------------------------- */

describe('fresh-board blank-line trivia preserved on add-lane', () => {
  // Mirrors the on-disk output of `main.createNewBoard` (src/main.ts:614-625)
  // verbatim. The settings block is rendered via `renderSettingsBlock` so we
  // hand-write the expected canonical form.
  const FRESH_BOARD =
    '---\n' +
    'kanban-plugin: board\n' +
    '---\n' +
    '\n' +
    '## Backlog\n' +
    '\n' +
    '## In Progress\n' +
    '\n' +
    '## Done\n' +
    '\n' +
    renderSettingsBlock({ 'kanban-plugin': 'board' });

  it('round-trips byte-identical when nothing changes', () => {
    // Sanity: identity round-trip works because `serializeBoard` short-
    // circuits on hash match. This isolates the bug to the mutation path
    // tested below.
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');
    const out = serializeBoard(board, FRESH_BOARD);
    expect(out).toBe(FRESH_BOARD);
  });

  it('keeps one blank line between every lane heading after adding a new lane', () => {
    const { board } = parseBoard(FRESH_BOARD);
    if (!board) throw new Error('parse failed');

    // Mutate via the real store so the new lane gets the same shape the
    // UI would produce (no `position`, empty cards array, etc.).
    const store = createBoardStore({ initialBoard: board });
    store.addLane();
    const mutated = store.getState().board;

    const out = serializeBoard(mutated, FRESH_BOARD);

    // The blank line between `---` and `## Backlog` must survive — that's
    // the trivia gap mdast reports for the frontmatter region.
    expect(out).toContain('---' + NL + NL + '## Backlog');

    // Between any two lane headings the serializer must NOT double the
    // separation to two blank lines. Verified by an explicit substring
    // check — `\n\n\n` between two `## ` lines would indicate the bug.
    expect(out).not.toMatch(/## Backlog\n\n\n## In Progress/);
    expect(out).not.toMatch(/## In Progress\n\n\n## Done/);

    // Positive assertion: exactly one blank line between headings.
    expect(out).toContain('## Backlog' + NL + NL + '## In Progress');
    expect(out).toContain('## In Progress' + NL + NL + '## Done');

    // The newly-added lane is appended after `## Done` (it has no source
    // bytes so its layout is fully canonical); the canonical form must
    // also use a single blank line.
    expect(out).toMatch(/## Done\n\n## /);
  });
});
